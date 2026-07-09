require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration is now loaded from the database during bot startup.
// We also keep a fallback to read from the legacy /app/addon-data/config.json if it exists.
const addonConfigPath = '/app/addon-data/config.json';
if (fs.existsSync(addonConfigPath)) {
  try {
    const addonConfig = JSON.parse(fs.readFileSync(addonConfigPath, 'utf8'));
    Object.assign(process.env, addonConfig);
    console.log('[Init] Loaded legacy configuration from RedBlink Addon storage (config.json).');
  } catch (err) {
    console.error('[Init] Failed to parse legacy addon config:', err.message);
  }
}

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, MessageFlags } = require('discord.js');
const database = require('./database');
const rabbitmq = require('./rabbitmq');
const automessages = require('./automessages');
const LogWatcher = require('./logWatcher');
const itemsList = require('./items.json');
const { exec } = require('child_process');
const http = require('http');

// Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Target channel for relays and alerts
// Configuration is dynamic, so we use process.env.CHANNEL_ID directly when needed

// Log Watcher instance
let logWatcher = null;

client.once('ready', async () => {
  console.log(`[Discord] Bot is online as ${client.user.tag}!`);
  
  // Set custom rich presence activity
  client.user.setActivity('Arrakis', { type: ActivityType.Watching });

  // Test Database Connection
  const dbConnected = await database.testConnection();
  if (dbConnected) {
    // Start schema discovery
    await database.discoverSchema();
  }

  // Init automessages
  automessages.init();

  // Test RabbitMQ Connection
  if (process.env.USE_CLI_FALLBACK !== 'true') {
    await rabbitmq.testAmqpConnection();
  } else {
    console.log('[AMQP] Running in CLI fallback mode, skipping connection check.');
    await rabbitmq.initCliFallback();
  }

  // Initialize Log Watcher if log source is provided
  if (process.env.LOG_CONTAINER_NAME || process.env.LOG_FILE_PATH) {
    await setupLogWatcher();
  } else {
    console.warn('[LogWatcher] Neither LOG_CONTAINER_NAME nor LOG_FILE_PATH is defined in .env. Log tailing disabled.');
  }
});

// Set up Log Watcher and configure event handlers
async function setupLogWatcher() {
  const logSource = process.env.LOG_CONTAINER_NAME || process.env.LOG_FILE_PATH;
  const isDocker = !!process.env.LOG_CONTAINER_NAME;

  // Retrieve player account-to-character mapping from the database
  const characterMap = await database.getFuncomToCharacterMap();

  logWatcher = new LogWatcher(logSource, {
    isDocker,
    interval: 1500,
    characterMap,
    onChat: (player, message, channel) => {
      const channelStr = channel ? `[${channel}] ` : '';
      console.log(`[Relay] Game Chat: ${channelStr}<${player}> ${message}`);
      relayToDiscord(`${channelStr}<**${player}**> ${message}`, '#E67E22'); // Warm orange for game chat
    },
    onJoin: (player) => {
      console.log(`[Relay] Player Join: ${player}`);
      const embed = new EmbedBuilder()
        .setColor('#2ECC71') // Vibrant Green
        .setDescription(`📥 **${player}** has joined the server.`);
      sendEmbedToChannel(embed);
    },
    onLeave: (player) => {
      console.log(`[Relay] Player Leave: ${player}`);
      const embed = new EmbedBuilder()
        .setColor('#E74C3C') // Vibrant Red
        .setDescription(`📤 **${player}** has left the server.`);
      sendEmbedToChannel(embed);
    },
    onLine: (line) => {
      // General logs forwarding can go here if needed
      if (line.startsWith('⚠️')) {
        relayToDiscord(line, '#F1C40F'); // Yellow alert
      }
    }
  });

  logWatcher.start();
}

// Utility to send simple text message to channel
async function relayToDiscord(content, colorHex = '#3498DB') {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      let cleanContent = content || '';
      if (cleanContent.length > 4000) {
        cleanContent = cleanContent.substring(0, 3997) + '...';
      }
      const embed = new EmbedBuilder()
        .setColor(colorHex)
        .setDescription(cleanContent);
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('[Discord] Failed to relay message:', error.message);
  }
}

// Utility to send Embed to channel
async function sendEmbedToChannel(embed) {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('[Discord] Failed to send embed:', error.message);
  }
}

// Handler for Discord Slash Commands
client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const { commandName } = interaction;
    if (commandName === 'giveitem') {
      const focusedOption = interaction.options.getFocused(true);
      const searchVal = focusedOption.value.toLowerCase();

      if (focusedOption.name === 'player') {
        try {
          const onlinePlayers = await database.getOnlinePlayers();
          const allPlayers = await database.getAllPlayers();

          const onlineSet = new Set(onlinePlayers.map(p => p.name.toLowerCase()));
          const choices = [];

          // 1. Add online players matching search query
          onlinePlayers.forEach(p => {
            if (p.name.toLowerCase().includes(searchVal)) {
              choices.push({ name: `🟢 ${p.name}`, value: p.name });
            }
          });

          // 2. Add offline players matching search query
          allPlayers.forEach(p => {
            if (!onlineSet.has(p.name.toLowerCase()) && p.name.toLowerCase().includes(searchVal)) {
              choices.push({ name: `🔴 ${p.name}`, value: p.name });
            }
          });

          await interaction.respond(choices.slice(0, 25));
        } catch (err) {
          console.error('[Autocomplete] Error suggesting players:', err);
          await interaction.respond([]);
        }
      } 
      
      else if (focusedOption.name === 'item') {
        try {
          const matches = itemsList
            .filter(item => 
              item.name.toLowerCase().includes(searchVal) || 
              item.id.toLowerCase().includes(searchVal)
            )
            .map(item => ({
              name: `${item.name} (${item.id})`,
              value: item.id
            }))
            .slice(0, 25);

          await interaction.respond(matches);
        } catch (err) {
          console.error('[Autocomplete] Error suggesting items:', err);
          await interaction.respond([]);
        }
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await interaction.deferReply();
      const dbStatus = await database.testConnection();
      
      const embed = new EmbedBuilder()
        .setTitle('🪐 Dune Server Status')
        .setColor('#E67E22') // Dune orange
        .setTimestamp()
        .setFooter({ text: 'Dune Docker Bot' });

      try {
        const bgStatus = await getBattlegroupStatus();
        if (bgStatus.success && bgStatus.output) {
          const parsed = parseStatusOutput(bgStatus.output);
          
          if (parsed.info) {
            // Set custom title if available
            if (parsed.info.title) {
              embed.setTitle(`🪐 ${parsed.info.title}`);
            }
            
            const overallLower = parsed.info.overall.toLowerCase();
            const statusEmoji = (overallLower === 'ready' || overallLower === 'running' || overallLower === 'online') ? '🟢' : '🔴';
            
            embed.addFields(
              { name: 'Server State', value: `${statusEmoji} ${parsed.info.overall}`, inline: true },
              { name: 'Database Connection', value: dbStatus ? '🟢 Connected' : '🔴 Disconnected', inline: true },
              { name: 'Population', value: parsed.info.population || '0/60', inline: true }
            );
            
            // Infrastructure Details
            const dbEmoji = parsed.info.postgres.startsWith('Up') ? '🟢' : '🔴';
            const gwEmoji = parsed.info.gateway.startsWith('Up') ? '🟢' : '🔴';
            const dirEmoji = parsed.info.director.startsWith('Up') ? '🟢' : '🔴';
            
            embed.addFields(
              { name: 'Postgres DB', value: `${dbEmoji} ${parsed.info.postgres}`, inline: true },
              { name: 'Gateway', value: `${gwEmoji} ${parsed.info.gateway}`, inline: true },
              { name: 'Director', value: `${dirEmoji} ${parsed.info.director}`, inline: true }
            );
          } else {
            console.warn('[Status] parseStatusOutput parsed no info. Raw output was:', JSON.stringify(bgStatus.output));
            embed.addFields(
              { name: 'Server State', value: '🟢 Online', inline: true },
              { name: 'Database Connection', value: dbStatus ? '🟢 Connected' : '🔴 Disconnected', inline: true }
            );
          }
          
          if (parsed.servers && parsed.servers.length > 0) {
            let serverList = '';
            parsed.servers.forEach(srv => {
              const isReady = srv.state.toLowerCase() === 'ready';
              const stateEmoji = isReady ? '🟢' : '🟡';
              const mapName = srv.map.replace('_', ' ');
              serverList += `${stateEmoji} **${mapName}**: ${srv.state} (${srv.uptime})\n`;
            });
            embed.addFields({ name: 'Game Servers', value: serverList });
          } else {
            embed.addFields({ name: 'Game Servers', value: '⚠️ No active game server instances found.' });
          }
        } else {
          console.warn('[Status] getBattlegroupStatus failed or returned empty output. Error:', bgStatus.error, 'Output:', JSON.stringify(bgStatus.output));
          embed.addFields(
            { name: 'Server State', value: '🟢 Online', inline: true },
            { name: 'Database Connection', value: dbStatus ? '🟢 Connected' : '🔴 Disconnected', inline: true }
          );
        }
      } catch (err) {
        console.error('[Status] Unexpected error getting detailed status:', err);
        embed.addFields(
          { name: 'Server State', value: '🟢 Online', inline: true },
          { name: 'Database Connection', value: dbStatus ? '🟢 Connected' : '🔴 Disconnected', inline: true }
        );
      }

      await interaction.editReply({ embeds: [embed] });
    }
    
    else if (commandName === 'carepackage') {
      await interaction.deferReply();
      const subcommand = interaction.options.getSubcommand();
      
      if (subcommand === 'list') {
        try {
          const response = await fetch('http://localhost:8088/api/care-package/config');
          const data = await response.json();
          const kits = data.kits || [];
          
          const embed = new EmbedBuilder()
            .setTitle('🎁 Available Care Packages')
            .setColor('#2ECC71')
            .setTimestamp();
            
          if (kits.length === 0) {
            embed.setDescription('No Care Packages found.');
          } else {
            kits.forEach(kit => {
              const itemsList = (kit.items || []).map(i => `${i.quantity}x ${i.itemId}`).join(', ') || 'No items';
              embed.addFields({ name: `${kit.name} (\`${kit.id}\`)`, value: itemsList });
            });
          }
          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error('[CarePackage] Error fetching kits:', error.message);
          await interaction.editReply('❌ Failed to retrieve Care Packages from RedBlink API.');
        }
      }
      
      else if (subcommand === 'grant') {
        const playerName = interaction.options.getString('player');
        const kitId = interaction.options.getString('kit');
        
        try {
          const response = await fetch(`http://localhost:8088/api/care-package/grant/${encodeURIComponent(playerName)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: "GRANT CARE PACKAGE", kitId })
          });
          
          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP error ${response.status}`);
          }
          
          await interaction.editReply(`✅ Successfully dispatched Care Package \`${kitId}\` to **${playerName}**!`);
        } catch (error) {
          console.error(`[CarePackage] Error granting kit ${kitId} to ${playerName}:`, error.message);
          await interaction.editReply(`❌ Failed to grant Care Package: ${error.message}`);
        }
      }
    }
    
    else if (commandName === 'players') {
      await interaction.deferReply();
      const players = await database.getOnlinePlayers();
      
      const embed = new EmbedBuilder()
        .setTitle('👥 Online Players')
        .setColor('#3498DB')
        .setTimestamp();

      if (players.length === 0) {
        embed.setDescription('No players are currently online.');
      } else {
        const playerList = players.map(p => `• **${p.name}** (Lvl: ${p.level}) - *${p.faction}*`).join('\n');
        embed.setDescription(playerList);
      }

      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'cmd') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const commandString = interaction.options.getString('command');

      // Parse the command and arguments
      // e.g. announce "hello" -> command: announce, args: "hello"
      const firstSpace = commandString.indexOf(' ');
      const cmd = firstSpace !== -1 ? commandString.substring(0, firstSpace) : commandString;
      const args = firstSpace !== -1 ? commandString.substring(firstSpace + 1) : '';

      if (cmd.toLowerCase() === 'giveitem') {
        await interaction.editReply({ 
          content: `❌ Direct console commands for \`giveitem\` do not work on Dune: Awakening servers. Please use the dedicated slash command \`/giveitem\` instead, which updates the player's inventory directly in the database.` 
        });
        return;
      }

       try {
        await rabbitmq.sendServerCommand(cmd, args);
        await interaction.editReply({ content: `✅ Command \`${cmd}\` successfully dispatched to Dune server.` });
      } catch (error) {
        let responseContent = `❌ Failed to dispatch command: ${error.message}`;
        if (responseContent.length > 2000) {
          responseContent = responseContent.substring(0, 1997) + '...';
        }
        await interaction.editReply({ content: responseContent });
      }
    }

    else if (commandName === 'giveitem') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const player = interaction.options.getString('player');
      const item = interaction.options.getString('item');
      const quantity = interaction.options.getInteger('quantity') || 1;

      try {
        // 1. Perform online player check
        const onlinePlayers = await database.getOnlinePlayers();
        const isOnline = onlinePlayers.some(p => p.name.toLowerCase() === player.toLowerCase());

        if (isOnline) {
          await interaction.editReply({
            content: `❌ Player **${player}** is currently online. To prevent character data desync/corruption, the player must log out of the game before you can give them items.`
          });
          return;
        }

        // 2. Perform direct database modification
        await database.giveItemToPlayer(player, item, quantity);

        // Get friendly item name
        const itemObj = itemsList.find(i => i.id.toLowerCase() === item.toLowerCase());
        const itemDisplayName = itemObj ? itemObj.name : item;

        await interaction.editReply({ 
          content: `✅ Successfully added **${quantity}x ${itemDisplayName}** directly to **${player}**'s inventory in the database. The items will appear in their bag when they log back in.` 
        });
      } catch (error) {
        let responseContent = `❌ Failed to give item: ${error.message}`;
        if (responseContent.length > 2000) {
          responseContent = responseContent.substring(0, 1997) + '...';
        }
        await interaction.editReply({ content: responseContent });
      }
    }

    else if (commandName === 'kick') {
      await interaction.deferReply();
      const player = interaction.options.getString('player');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      try {
        await rabbitmq.sendServerCommand('kick', [player, reason]);
        await interaction.editReply({ content: `✅ Kicked **${player}** for: ${reason}` });
      } catch (error) {
        await interaction.editReply({ content: `❌ Failed to kick player: ${error.message}` });
      }
    }

    else if (commandName === 'teleport') {
      await interaction.deferReply();
      const player = interaction.options.getString('player');
      const x = interaction.options.getNumber('x');
      const y = interaction.options.getNumber('y');
      const z = interaction.options.getNumber('z');
      try {
        await rabbitmq.sendServerCommand('teleport', [player, x, y, z]);
        await interaction.editReply({ content: `✅ Teleported **${player}** to coordinates (${x}, ${y}, ${z}).` });
      } catch (error) {
        await interaction.editReply({ content: `❌ Failed to teleport player: ${error.message}` });
      }
    }

    else if (commandName === 'announce') {
      await interaction.deferReply();
      const message = interaction.options.getString('message');
      try {
        await rabbitmq.sendServerCommand('announce', [message]);
        await interaction.editReply({ content: `✅ Sent global announcement: "${message}"` });
      } catch (error) {
        await interaction.editReply({ content: `❌ Failed to send announcement: ${error.message}` });
      }
    }

    else if (commandName === 'automessage') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        const interval = interaction.options.getInteger('interval');
        const message = interaction.options.getString('message');
        const msg = automessages.addMessage(interval, message);
        await interaction.reply({ content: `✅ Added automessage ID **${msg.id}** to broadcast every **${interval}** minutes: "${message}"` });
      } else if (subcommand === 'list') {
        const msgs = automessages.getMessages();
        if (msgs.length === 0) {
          await interaction.reply({ content: 'No active automessages.' });
        } else {
          const listStr = msgs.map(m => `**ID ${m.id}** [${m.interval} min]: ${m.text}`).join('\n');
          await interaction.reply({ content: `**Active Automessages:**\n${listStr}` });
        }
      } else if (subcommand === 'remove') {
        const id = interaction.options.getString('id');
        const success = automessages.removeMessage(id);
        if (success) {
          await interaction.reply({ content: `✅ Removed automessage ID **${id}**` });
        } else {
          await interaction.reply({ content: `❌ Automessage ID **${id}** not found.` });
        }
      }
    }

    else if (commandName === 'restart') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const service = interaction.options.getString('service');

      try {
        const restartResult = await executeDuneRestart(service);
        if (restartResult.success) {
          await interaction.editReply({
            content: `✅ Successfully requested restart for service **${service}** on the Dune server.\n\`\`\`\n${restartResult.output.trim()}\n\`\`\``
          });
        } else {
          const errorDetails = restartResult.output.trim() || restartResult.error;
          
          // Check if output looks like a successful Docker container restart (hex ID or dune container name)
          const isDockerRestartOutput = /^[0-9a-f]{64}$/m.test(errorDetails) || 
                                        errorDetails.toLowerCase().includes('dune-') || 
                                        errorDetails.toLowerCase().includes(service.toLowerCase());
          
          if (isDockerRestartOutput) {
            await interaction.editReply({
              content: `⚠️ Requested restart for service **${service}** on the Dune server. The container has restarted successfully, but the script exited with status checks still pending/warming up:\n\`\`\`\n${errorDetails}\n\`\`\``
            });
          } else {
            await interaction.editReply({
              content: `❌ Failed to restart service **${service}**:\n\`\`\`\n${errorDetails}\n\`\`\``
            });
          }
        }
      } catch (error) {
        console.error(`[Restart] Error restarting service ${service}:`, error);
        await interaction.editReply({
          content: `❌ Unexpected error trying to restart service **${service}**: ${error.message}`
        });
      }
    }

    else if (commandName === 'update') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const subcommand = interaction.options.getSubcommand();

      try {
        const updateResult = await executeDuneUpdate(subcommand);
        if (updateResult.success) {
          await interaction.editReply({
            content: `✅ Successfully completed update command (**${subcommand}**):\n\`\`\`\n${updateResult.output.trim()}\n\`\`\``
          });
        } else {
          await interaction.editReply({
            content: `❌ Failed during update command (**${subcommand}**):\n\`\`\`\n${updateResult.error || updateResult.output.trim()}\n\`\`\``
          });
        }
      } catch (error) {
        console.error(`[Update] Error running update action ${subcommand}:`, error);
        await interaction.editReply({
          content: `❌ Unexpected error trying to run update action **${subcommand}**: ${error.message}`
        });
      }
    }
  } catch (error) {
    console.error('[Discord] Error handling command:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'There was an error executing this command.' });
    } else {
      await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
    }
  }
});

// Two-way chat relay: Send Discord messages back to the Game Server
client.on('messageCreate', async (message) => {
  // Ignore bots and webhooks
  if (message.author.bot || message.webhookId) return;

  // Only relay messages sent in the configured channel
  if (message.channelId !== process.env.CHANNEL_ID) return;

  try {
    const authorName = message.member ? message.member.displayName : message.author.username;
    // Direct chat message format
    const chatMessage = `[Discord] ${authorName}: ${message.cleanContent}`;
    
    await rabbitmq.sendServerCommand('chat', chatMessage);
    console.log(`[Relay] Discord -> Game (Global): [${authorName}]: ${message.cleanContent}`);
  } catch (error) {
    console.error('[Relay] Failed to relay message to game:', error.message);
  }
});

// Function to read request body
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Function to send JSON response
function sendJsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Initialize HTTP API Server
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Token Validation
  const clientToken = req.headers['x-api-token'];
  const serverToken = process.env.API_AUTH_TOKEN;
  if (!serverToken || clientToken !== serverToken) {
    sendJsonResponse(res, 401, { success: false, error: 'Unauthorized: Invalid or missing X-API-Token header' });
    return;
  }

  const url = req.url;
  const method = req.method;

  try {
    if (url === '/api/status' && method === 'GET') {
      const dbStatus = await database.testConnection();
      const bgStatus = await getBattlegroupStatus();
      const memoryStats = await getDockerMemoryStats();
      let parsed = null;
      if (bgStatus.success && bgStatus.output) {
        parsed = parseStatusOutput(bgStatus.output);
        if (parsed) {
          parsed.memory = memoryStats;
        }
      }
      sendJsonResponse(res, 200, {
        success: true,
        dbConnected: dbStatus,
        status: parsed
      });
    } 
    
    else if (url === '/api/players' && method === 'GET') {
      const players = await database.getOnlinePlayers();
      sendJsonResponse(res, 200, {
        success: true,
        players
      });
    } 
    
    else if (url === '/api/panic' && method === 'POST') {
      try {
        const cmdPath = process.env.BATTLEGROUP_CMD_PATH || '/usr/local/bin/dune';
        exec(`${cmdPath} restart all 2>&1`, { timeout: 60000 }, (error, stdout, stderr) => {
          const output = (stdout || '') + (stderr || '');
          if (error) {
            sendJsonResponse(res, 500, { success: false, error: error.message, output });
          } else {
            sendJsonResponse(res, 200, { success: true, output });
          }
        });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    } 
    
    else if (url === '/api/restart' && method === 'POST') {
      const body = await readRequestBody(req);
      const service = body.service;
      if (!service) {
        sendJsonResponse(res, 400, { success: false, error: 'Missing service name in request body' });
        return;
      }
      
      const restartResult = await executeDuneRestart(service);
      const errorDetails = restartResult.output.trim() || restartResult.error || '';
      const isDockerRestartOutput = /^[0-9a-f]{64}$/m.test(errorDetails) || 
                                    errorDetails.toLowerCase().includes('dune-') || 
                                    errorDetails.toLowerCase().includes(service.toLowerCase());
                                    
      sendJsonResponse(res, 200, {
        success: restartResult.success || isDockerRestartOutput,
        output: restartResult.output,
        error: restartResult.error,
        isDockerRestartOutput
      });
    } 
    
    else if (url === '/api/update' && method === 'POST') {
      const body = await readRequestBody(req);
      const action = body.action; // 'check' or 'install'
      if (!action || (action !== 'check' && action !== 'install')) {
        sendJsonResponse(res, 400, { success: false, error: 'Invalid or missing action in request body' });
        return;
      }
      
      const updateResult = await executeDuneUpdate(action);
      sendJsonResponse(res, 200, {
        success: updateResult.success,
        output: updateResult.output,
        error: updateResult.error
      });
    } 
    
    else {
      sendJsonResponse(res, 404, { success: false, error: 'Endpoint not found' });
    }
  } catch (error) {
    console.error('[API] Server Error:', error);
    sendJsonResponse(res, 500, { success: false, error: error.message });
  }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('[System] Shutting down bot...');
  if (logWatcher) logWatcher.stop();
  server.close(() => {
    console.log('[API] Server stopped.');
  });
  client.destroy();
  process.exit(0);
});

async function startBot() {
  console.log('[Init] Connecting to database to fetch configuration...');
  try {
    const res = await database.pool.query("SELECT config_value FROM dune.discord_bot_config WHERE config_key = $1", ["main"]);
    if (res.rows.length > 0 && res.rows[0].config_value) {
      const dbConfig = typeof res.rows[0].config_value === 'string' ? JSON.parse(res.rows[0].config_value) : res.rows[0].config_value;
      Object.assign(process.env, dbConfig);
      console.log('[Init] Successfully loaded configuration from Postgres Database.');
    } else {
      console.warn('[Init] No configuration found in database. Using environment variables.');
    }
  } catch (err) {
    console.warn('[Init] Database configuration table not found or unavailable. Using environment variables. Error:', err.message);
  }

  if (!process.env.DISCORD_TOKEN) {
    console.error('[Init] ERROR: No DISCORD_TOKEN provided. The bot cannot start! Please configure the addon in the Dune Console.');
    return;
  }

  const API_PORT = process.env.API_PORT || 3005;
  server.listen(API_PORT, () => {
    console.log(`[API] Server is listening on port ${API_PORT}`);
  });

  client.login(process.env.DISCORD_TOKEN);
}

startBot();

/**
 * Executes the battlegroup status command inside the VM host.
 */
function getBattlegroupStatus() {
  return new Promise((resolve) => {
    exec('docker ps -a --format "{{.Names}}|{{.State}}|{{.Status}}"', { timeout: 10000 }, async (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: error.message, output: stdout || stderr });
        return;
      }

      let syntheticOutput = `=== DUNE STATUS ===\nOverall: READY\nTitle: Dune Server\nPopulation: 0/60\n\n=== CONTAINERS ===\n`;
      let gameservers = `\n=== GAME SERVERS ===\n`;
      
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      let foundAny = false;

      for (const line of lines) {
        const [name, state, status] = line.split('|');
        if (!name) continue;
        
        let friendlyStatus = status.startsWith('Up') ? status : (state || 'Offline');
        
        if (name === 'dune-postgres') {
          syntheticOutput += `dune-postgres ${friendlyStatus}\n`;
          foundAny = true;
        } else if (name === 'dune-server-gateway') {
          syntheticOutput += `dune-server-gateway ${friendlyStatus}\n`;
          foundAny = true;
        } else if (name === 'dune-director') {
          syntheticOutput += `dune-director ${friendlyStatus}\n`;
          foundAny = true;
        } else if (name.startsWith('dune-server-') && name !== 'dune-server-gateway') {
          // It's a game server (e.g. dune-server-survival-1)
          let mapName = name.replace('dune-server-', '');
          // Map to format: Survival_1 READY Up 5 minutes
          let stateLabel = status.startsWith('Up') ? 'READY' : 'STOPPED';
          gameservers += `${mapName} ${stateLabel} ${friendlyStatus}\n`;
          foundAny = true;
        }
      }

      if (!foundAny) {
        resolve({ success: false, error: 'No Dune containers found', output: stdout });
        return;
      }

      syntheticOutput += gameservers;
      resolve({ success: true, output: syntheticOutput });
    });
  });
}

/**
 * Parses raw text output from the `dune status` command.
 */
function parseStatusOutput(output) {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  const result = {
    info: {
      overall: '',
      title: '',
      population: '',
      postgres: 'Offline',
      gateway: 'Offline',
      director: 'Offline'
    },
    servers: []
  };

  let currentSection = '';

  for (const line of lines) {
    // Detect sections
    if (line.startsWith('===')) {
      currentSection = line.replace(/===/g, '').trim().toLowerCase();
      continue;
    }

    // Parse Dune status section
    if (currentSection === 'dune status') {
      if (line.startsWith('Overall:')) {
        result.info.overall = line.replace('Overall:', '').trim();
      } else if (line.startsWith('Title:')) {
        result.info.title = line.replace('Title:', '').trim();
      } else if (line.startsWith('Population:')) {
        result.info.population = line.replace('Population:', '').trim();
      }
    }

    // Parse Containers section
    else if (currentSection === 'containers') {
      if (line.startsWith('SERVICE') || line.startsWith('------')) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const service = parts[0].trim();
        const status = parts.slice(1).join(' ').trim();
        if (service === 'dune-postgres') {
          result.info.postgres = status;
        } else if (service === 'dune-server-gateway') {
          result.info.gateway = status;
        } else if (service === 'dune-director') {
          result.info.director = status;
        }
      }
    }

    // Parse Game servers section
    else if (currentSection === 'game servers') {
      if (line.startsWith('MAP') || line.startsWith('------') || line.toLowerCase().startsWith('note:')) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const map = parts[0].trim();
        const state = parts[1].trim();
        const uptime = parts.slice(2).join(' ').trim();
        result.servers.push({ map, state, uptime });
      }
    }
  }

  // Ensure overall status was parsed, if not return null for info
  if (!result.info.overall) {
    result.info = null;
  }

  return result;
}

/**
 * Executes the dune restart command for a specific service.
 */
function executeDuneRestart(service) {
  return new Promise((resolve) => {
    const cmdPath = process.env.BATTLEGROUP_CMD_PATH || '/usr/local/bin/dune';
    exec(`${cmdPath} restart ${service} 2>&1`, { timeout: 30000 }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (error) {
        resolve({ success: false, error: error.message, output });
      } else {
        resolve({ success: true, output });
      }
    });
  });
}

/**
 * Executes the dune update command.
 */
function executeDuneUpdate(action) {
  return new Promise((resolve) => {
    const cmdPath = process.env.BATTLEGROUP_CMD_PATH || '/usr/local/bin/dune';
    const subCmd = action === 'install' ? '--yes' : 'check';
    
    // Set a long timeout (5 minutes) for installing updates, 30s for checks
    const timeoutMs = action === 'install' ? 300000 : 30000;
    
    exec(`${cmdPath} update ${subCmd} 2>&1`, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (error) {
        resolve({ success: false, error: error.message, output });
      } else {
        resolve({ success: true, output });
      }
    });
  });
}

/**
 * Retrieves memory usage for Dune Docker containers.
 */
function getDockerMemoryStats() {
  return new Promise((resolve) => {
    exec(`docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}"`, { timeout: 10000 }, (error, stdout) => {
      const memory = {};
      if (error) {
        console.error('[MemoryStats] Failed to fetch docker stats:', error.message);
        resolve(memory);
        return;
      }
      
      const lines = stdout.split('\n');
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const mem = parts[1].split('/')[0].trim(); // Get current usage, drop the limit
          if (name.includes('dune')) {
            memory[name] = mem;
          }
        }
      }
      resolve(memory);
    });
  });
}
