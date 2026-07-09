const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

class LogWatcher {
  constructor(logSource, options = {}) {
    this.logSource = logSource;
    this.isDocker = options.isDocker || false;
    this.interval = options.interval || 1000;
    this.onLineCallback = options.onLine || (() => {});
    this.onChatCallback = options.onChat || (() => {});
    this.onJoinCallback = options.onJoin || (() => {});
    this.onLeaveCallback = options.onLeave || (() => {});

    this.lastSize = 0;
    this.timer = null;
    this.process = null;
    this.isWatching = false;
    this.playerMap = new Map(); // Map PlayerId -> Character Name
    this.characterMap = options.characterMap || new Map(); // Map clean FLS username -> Character Name

    // Common patterns in Unreal Engine / Dune: Awakening logs
    this.patterns = {
      // Adjust these regexes based on exact server output formats
      chat: /Chat:\s+([^:]+):\s+(.+)/i,
      chatNew: /LogChat:\s+Display:\s+\[([^\]]+)\]:\s+\[([^\]]+)\]:\s+(.+)/i,
      travelEnd: /LogTravelEvent:.*Stage:"End".*PlayerId:"([A-F0-9]+)".*Reason:"([^"]*)"/i,
      sandstorm: /Sandstorm\s+(Started|Stopped|Approaching)/i
    };
  }

  start() {
    if (this.isWatching) return;
    
    this.isWatching = true;

    // Pre-populate player map from logs history
    this.prePopulatePlayerMap();

    if (this.isDocker) {
      console.log(`[LogWatcher] Started watching Docker container logs for: ${this.logSource}`);
      this.startDockerTail();
    } else {
      console.log(`[LogWatcher] Started watching log file: ${this.logSource}`);
      this.startFileTail();
    }
  }

  startDockerTail() {
    try {
      if (this.logSource === 'dune-text-router') {
        console.log(`[LogWatcher] Spawning tail for text router: docker logs -f --tail 0 dune-text-router`);
        this.process = spawn('docker', ['logs', '-f', '--tail', '0', 'dune-text-router']);
      } else {
        const logFilePathInsideContainer = process.env.LOG_FILE_PATH_IN_CONTAINER || '/home/dune/server/survival-1/Saved/Logs/DuneSandbox.log';
        console.log(`[LogWatcher] Spawning tail inside container: docker exec -i ${this.logSource} tail -f -n 0 ${logFilePathInsideContainer}`);
        this.process = spawn('docker', ['exec', '-i', this.logSource, 'tail', '-f', '-n', '0', logFilePathInsideContainer]);
      }

      const handleData = (data) => {
        const lines = data.toString().split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.parseLine(line);
          }
        }
      };

      this.process.stdout.on('data', handleData);
      this.process.stderr.on('data', handleData); // Docker logs stderr can contain stdout logs too

      this.process.on('close', (code) => {
        console.log(`[LogWatcher] Docker logs process exited with code ${code}`);
        this.process = null;
        // Auto-reconnect if we are still active
        if (this.isWatching) {
          console.log('[LogWatcher] Reconnecting to Docker container logs in 5s...');
          setTimeout(() => {
            if (this.isWatching) this.startDockerTail();
          }, 5000);
        }
      });

      this.process.on('error', (err) => {
        console.error('[LogWatcher] Failed to start Docker logs process:', err.message);
      });
    } catch (err) {
      console.error('[LogWatcher] Error spawning docker logs:', err.message);
    }
  }

  startFileTail() {
    if (!fs.existsSync(this.logSource)) {
      console.warn(`[LogWatcher] Log file not found at: ${this.logSource}. Will check again periodically.`);
    }

    try {
      if (fs.existsSync(this.logSource)) {
        const stats = fs.statSync(this.logSource);
        this.lastSize = stats.size; // Start reading from the end of the file
      }
    } catch (err) {
      console.error('[LogWatcher] Error reading initial file stats:', err.message);
    }

    this.timer = setInterval(() => this.checkFile(), this.interval);
  }

  stop() {
    if (!this.isWatching) return;
    this.isWatching = false;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[LogWatcher] Stopped watching logs.');
  }

  checkFile() {
    if (!fs.existsSync(this.logSource)) return;

    try {
      const stats = fs.statSync(this.logSource);
      
      if (stats.size > this.lastSize) {
        this.readNewLines(stats.size);
      } else if (stats.size < this.lastSize) {
        // File was rotated or truncated
        console.log('[LogWatcher] Log file was truncated/rotated. Resetting pointer.');
        this.lastSize = stats.size;
      }
    } catch (err) {
      console.error('[LogWatcher] Error checking log file:', err.message);
    }
  }

  readNewLines(currentSize) {
    const stream = fs.createReadStream(this.logSource, {
      start: this.lastSize,
      end: currentSize - 1,
      encoding: 'utf8'
    });

    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk;
    });

    stream.on('end', () => {
      this.lastSize = currentSize;
      const lines = buffer.split(/\r?\n/);
      
      // If the last element is empty (because of trailing newline), remove it
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      for (const line of lines) {
        if (line.trim()) {
          this.parseLine(line);
        }
      }
    });

    stream.on('error', (err) => {
      console.error('[LogWatcher] Stream error:', err.message);
    });
  }

  parseLine(line) {
    // Fire generic line callback
    this.onLineCallback(line);

    // Check dune-text-router logs
    if (line.includes('Redirected message from')) {
      const match = line.match(/Redirected message from (\S+) to (\S+) using routing key [^:]+: (.+)$/);
      if (match) {
        const [, flsId, destination, jsonStr] = match;
        try {
          const outer = JSON.parse(jsonStr);
          if (outer.Type === 'TextChat') {
            const inner = JSON.parse(outer.content || outer.Content);
            const funcomId = inner.m_FuncomIdFrom;
            const message = inner.m_Message?.m_UnlocalizedMessage;
            const channelType = inner.m_ChannelType;
            
            if (funcomId && funcomId !== 'Server#0001' && !message.startsWith('[Discord]')) {
              const cleanName = funcomId.split('#')[0].toLowerCase();
              const characterName = this.characterMap.get(cleanName) || funcomId.split('#')[0];
              
              let channel = channelType;
              if (channelType === 'Map') channel = 'Global';
              
              this.onChatCallback(characterName, message, channel);
            }
          }
        } catch (e) {
          // Not JSON or parse error, ignore
        }
      }
      return;
    }

    // Extract PlayerId mapping on Login request or Join request
    const tokenMatch = line.match(/EncryptionToken=([A-F0-9]+)/i);
    const nameMatch = line.match(/[?&]Name=([^?&\s]+)/i);
    if (tokenMatch && nameMatch) {
      const tokenId = tokenMatch[1];
      let name = nameMatch[1];
      try {
        name = decodeURIComponent(name);
      } catch (e) {}
      const cleanName = name.split('#')[0].toLowerCase();
      const characterName = this.characterMap.get(cleanName) || name.split('#')[0];
      this.playerMap.set(tokenId, characterName);
      console.log(`[LogWatcher] Mapped PlayerId ${tokenId} to CharacterName ${characterName} (from Name: ${name})`);
    }

    // Check Chat (New format first)
    const chatNewMatch = line.match(this.patterns.chatNew);
    if (chatNewMatch) {
      const [, channel, player, message] = chatNewMatch;
      this.onChatCallback(player.trim(), message.trim(), channel.trim());
      return;
    }

    // Check Chat (Old format fallback)
    const chatMatch = line.match(this.patterns.chat);
    if (chatMatch) {
      const [, player, message] = chatMatch;
      this.onChatCallback(player.trim(), message.trim());
      return;
    }

    // Check Travel End (both Login success and Logout/Disconnect)
    const travelMatch = line.match(this.patterns.travelEnd);
    if (travelMatch) {
      const [, playerId, reason] = travelMatch;
      const player = this.playerMap.get(playerId) || `Player (${playerId})`;
      if (reason === '') {
        console.log(`[LogWatcher] Player logged in: ${player}`);
        this.onJoinCallback(player);
      } else {
        console.log(`[LogWatcher] Player disconnected: ${player} (Reason: ${reason})`);
        this.onLeaveCallback(player);
        this.playerMap.delete(playerId);
      }
      return;
    }
    
    // Check Sandstorm
    const stormMatch = line.match(this.patterns.sandstorm);
    if (stormMatch) {
      const [, status] = stormMatch;
      this.onLineCallback(`⚠️ Sandstorm alert: ${status}`);
    }
  }

  prePopulatePlayerMap() {
    // Try to pre-populate from the log file on the filesystem first, as it contains much more history
    const repoRoot = process.env.DUNE_REPO_ROOT || '/root/dune-awakening-selfhost-docker';
    const defaultLogFile = path.resolve(repoRoot, 'runtime/game/survival-1/Saved/Logs/DuneSandbox_PIDX-1.log');
    const logFilePath = process.env.LOG_FILE_PATH || defaultLogFile;

    if (fs.existsSync(logFilePath)) {
      try {
        console.log(`[LogWatcher] Pre-populating player map from log file: ${logFilePath}`);
        const fd = fs.openSync(logFilePath, 'r');
        const stats = fs.fstatSync(fd);
        const size = stats.size;
        const bufferSize = Math.min(size, 10 * 1024 * 1024); // Read last 10MB
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, size - bufferSize);
        fs.closeSync(fd);
        const logContent = buffer.toString('utf8');
        this.parseHistoryLogs(logContent);
        if (this.playerMap.size > 0) {
          console.log(`[LogWatcher] Successfully populated player map from log file. Skipping Docker logs fallback.`);
          return;
        }
      } catch (err) {
        console.error(`[LogWatcher] Error pre-populating player map from file: ${err.message}`);
      }
    }

    // Fallback to Docker logs if filesystem file is not accessible or empty
    if (this.isDocker) {
      const containerName = this.logSource;
      const cmd = `docker logs --tail 50000 ${containerName}`;
      console.log(`[LogWatcher] Pre-populating player map from Docker logs fallback: "${cmd}"`);
      exec(cmd, { maxBuffer: 25 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[LogWatcher] Error fetching Docker logs for pre-population: ${error.message}`);
          return;
        }
        const logContent = (stdout || '') + (stderr || '');
        console.log(`[LogWatcher] Pre-population Docker logs fetched. Size: ${logContent.length} bytes.`);
        this.parseHistoryLogs(logContent);
      });
    }
  }

  parseHistoryLogs(content) {
    const lines = content.split(/\r?\n/);
    let count = 0;
    for (const line of lines) {
      const tokenMatch = line.match(/EncryptionToken=([A-F0-9]+)/i);
      const nameMatch = line.match(/[?&]Name=([^?&\s]+)/i);
      if (tokenMatch && nameMatch) {
        const tokenId = tokenMatch[1];
        let name = nameMatch[1];
        try {
          name = decodeURIComponent(name);
        } catch (e) {}
        const cleanName = name.split('#')[0].toLowerCase();
        const characterName = this.characterMap.get(cleanName) || name.split('#')[0];
        this.playerMap.set(tokenId, characterName);
        count++;
      }
    }
    console.log(`[LogWatcher] Pre-populated ${this.playerMap.size} player mappings (parsed ${count} entries) from log history.`);
  }
}

module.exports = LogWatcher;
