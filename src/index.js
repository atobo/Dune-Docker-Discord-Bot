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
    // FORCE dune-text-router regardless of what the user accidentally put in the Addon UI
    process.env.LOG_CONTAINER_NAME = 'dune-text-router';
    console.log('[Init] Loaded configuration from RedBlink Addon storage.');
  } catch (err) {
    console.error('[Init] Failed to parse addon config:', err.message);
  }
} else {
  // If no addon config exists, also forcefully ensure we use text router
  process.env.LOG_CONTAINER_NAME = 'dune-text-router';
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

// Queue to batch loot changes until population is 0
let lootQueue = [];

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

    else if (commandName === 'chat') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const message = interaction.options.getString('message');
      const authorName = interaction.member ? interaction.member.displayName : interaction.user.username;
      const formattedMessage = `[Discord] ${authorName}: ${message}`;
      try {
        await rabbitmq.sendServerCommand('chat', formattedMessage);
        await interaction.editReply({ content: `✅ Sent message to game server: "${formattedMessage}"` });
      } catch (error) {
        await interaction.editReply({ content: `❌ Failed to send chat message: ${error.message}` });
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

  // Debug DB Commands
  if (message.content.startsWith('!dbcheck')) {
    try {
      const res = await database.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'dune' ORDER BY table_name");
      const tables = res.rows.map(r => r.table_name).join(', ');
      await message.reply(`**Tables in 'dune' schema:**\n${tables || 'None found'}`);
    } catch (err) {
      await message.reply(`❌ Database check failed: ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith('!dbquery ')) {
    const query = message.content.substring(9);
    try {
      const res = await database.pool.query(query);
      const rowsStr = JSON.stringify(res.rows, null, 2);
      const output = rowsStr.length > 1900 ? rowsStr.substring(0, 1900) + '...' : rowsStr;
      await message.reply(`**Result:**\n\`\`\`json\n${output}\n\`\`\``);
    } catch (err) {
      await message.reply(`❌ Query failed: ${err.message}`);
    }
    return;
  }

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

  const url = req.url;
  const method = req.method;

  // Bypass API token check ONLY for saving/checking addon config
  if (url === '/api/config') {
    if (method === 'GET') {
      const hasToken = !!(process.env.DISCORD_TOKEN || (fs.existsSync(addonConfigPath) && JSON.parse(fs.readFileSync(addonConfigPath, 'utf8')).DISCORD_TOKEN));
      sendJsonResponse(res, 200, { success: true, configured: hasToken });
      return;
    }
    if (method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const { token } = body;
        if (!token) {
          sendJsonResponse(res, 400, { success: false, error: 'Missing token in request body' });
          return;
        }

        // Read existing config.json to preserve other properties if any
        let currentConfig = {};
        if (fs.existsSync(addonConfigPath)) {
          try {
            currentConfig = JSON.parse(fs.readFileSync(addonConfigPath, 'utf8'));
          } catch (e) {}
        }
        currentConfig.DISCORD_TOKEN = token;
        
        // Write back
        const configDir = path.dirname(addonConfigPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(addonConfigPath, JSON.stringify(currentConfig, null, 2), 'utf8');
        process.env.DISCORD_TOKEN = token;

        console.log('[API] Saved new DISCORD_TOKEN to local configuration storage.');

        // Attempt login if client not logged in
        if (!client.user) {
          console.log('[Discord] Attempting login with newly saved token...');
          client.login(token).catch(err => {
            console.error('[Discord] Login failed:', err.message);
          });
        }

        sendJsonResponse(res, 200, { success: true, message: 'Token saved successfully.' });
        return;
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
        return;
      }
    }
  }

  // API Token Validation
  const clientToken = req.headers['x-api-token'];
  const serverToken = process.env.API_AUTH_TOKEN;
  const isDebugUrl = url.startsWith('/api/debug/');
  if (!isDebugUrl && (!serverToken || clientToken !== serverToken)) {
    sendJsonResponse(res, 401, { success: false, error: 'Unauthorized: Invalid or missing X-API-Token header' });
    return;
  }

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
    
    else if (url === '/api/characters' && method === 'GET') {
      const characters = await database.getAllCharactersWithPawnIds();
      sendJsonResponse(res, 200, {
        success: true,
        characters
      });
    }

    else if (url === '/api/blueprint/grant' && method === 'POST') {
      const body = await readRequestBody(req);
      const { characterName, blueprint, itemType, customName } = body;

      if (!characterName || !blueprint) {
        sendJsonResponse(res, 400, { success: false, error: 'Missing characterName or blueprint in request body' });
        return;
      }

      // Check online status to prevent desync
      const onlinePlayers = await database.getOnlinePlayers();
      const isOnline = onlinePlayers.some(p => p.name.toLowerCase() === characterName.toLowerCase());
      if (isOnline) {
        sendJsonResponse(res, 400, {
          success: false,
          error: `Player ${characterName} is currently online. They must log out before blueprints/backups can be injected.`
        });
        return;
      }

      const result = await database.grantBlueprintToPlayer(characterName, blueprint, itemType, customName);
      sendJsonResponse(res, 200, {
        success: true,
        ...result
      });
    }

    else if (url === '/api/blueprint/construct' && method === 'POST') {
      const body = await readRequestBody(req);
      const { characterName, blueprint, offsetX, offsetY, offsetZ } = body;

      if (!characterName || !blueprint) {
        sendJsonResponse(res, 400, { success: false, error: 'Missing characterName or blueprint in request body' });
        return;
      }

      // Check online status
      const onlinePlayers = await database.getOnlinePlayers();
      const isOnline = onlinePlayers.some(p => p.name.toLowerCase() === characterName.toLowerCase());
      if (isOnline) {
        sendJsonResponse(res, 400, {
          success: false,
          error: `Player ${characterName} is currently online. They must log out before structural pieces can be constructed in-world.`
        });
        return;
      }

      const result = await database.constructBlueprintAtPlayer(characterName, blueprint, parseFloat(offsetX) || 0, parseFloat(offsetY) || 0, parseFloat(offsetZ) || 0);
      sendJsonResponse(res, 200, {
        success: true,
        ...result
      });
    }
    else if (url === '/api/buildings' && method === 'GET') {
      try {
        const buildings = await database.getBuildings();
        sendJsonResponse(res, 200, { success: true, buildings });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url.startsWith('/api/buildings/') && method === 'DELETE') {
      try {
        const parts = url.split('/');
        const buildingIdStr = parts[parts.length - 1];
        const buildingId = parseInt(buildingIdStr);
        if (isNaN(buildingId)) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid building ID' });
          return;
        }

        const result = await database.deleteBuilding(buildingId);
        sendJsonResponse(res, 200, { success: true, ...result });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }
    else if (url.startsWith('/api/buildings/') && url.endsWith('/shift-height') && method === 'POST') {
      try {
        const parts = url.split('/');
        const buildingId = parseInt(parts[3]);
        if (isNaN(buildingId)) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid building ID' });
          return;
        }

        const body = await readRequestBody(req);
        const zDelta = parseFloat(body.zDelta);
        if (isNaN(zDelta)) {
          sendJsonResponse(res, 400, { success: false, error: 'Missing or invalid zDelta value' });
          return;
        }

        const result = await database.shiftBuildingHeight(buildingId, zDelta);
        sendJsonResponse(res, 200, { success: true, ...result });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/loot/containers' && method === 'GET') {
      try {
        const containers = await database.getLootContainers();
        sendJsonResponse(res, 200, { success: true, containers });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url.startsWith('/api/loot/containers/') && method === 'GET') {
      try {
        const parts = url.split('/');
        const containerId = parseInt(parts[4]);
        if (isNaN(containerId)) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid container ID' });
          return;
        }
        const items = await database.getContainerItems(containerId);
        sendJsonResponse(res, 200, { success: true, items });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/loot/items/update' && method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const { itemId, stackSize, templateId } = body;
        if (!itemId || !templateId || isNaN(parseInt(stackSize))) {
          sendJsonResponse(res, 400, { success: false, error: 'Missing required parameters' });
          return;
        }
        
        lootQueue.push({
          type: 'update',
          params: { itemId: parseInt(itemId), stackSize: parseInt(stackSize), templateId },
          description: `Update item #${itemId} to ${stackSize}x ${templateId.split('.').pop()}`
        });
        
        sendJsonResponse(res, 200, { success: true, queued: true });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/loot/items/add' && method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const { inventoryId, templateId, stackSize, positionIndex } = body;
        if (!inventoryId || !templateId || isNaN(parseInt(stackSize)) || isNaN(parseInt(positionIndex))) {
          sendJsonResponse(res, 400, { success: false, error: 'Missing required parameters' });
          return;
        }
        
        lootQueue.push({
          type: 'add',
          params: { inventoryId: parseInt(inventoryId), templateId, stackSize: parseInt(stackSize), positionIndex: parseInt(positionIndex) },
          description: `Add ${stackSize}x ${templateId.split('.').pop()} to container`
        });
        
        sendJsonResponse(res, 200, { success: true, queued: true });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url.startsWith('/api/loot/items/') && method === 'DELETE') {
      try {
        const parts = url.split('/');
        const itemId = parseInt(parts[4]);
        if (isNaN(itemId)) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid item ID' });
          return;
        }
        
        lootQueue.push({
          type: 'delete',
          params: { itemId },
          description: `Delete item #${itemId}`
        });
        
        sendJsonResponse(res, 200, { success: true, queued: true });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/loot/queue' && method === 'GET') {
      sendJsonResponse(res, 200, { success: true, queue: lootQueue });
    }

    else if (url === '/api/loot/queue/clear' && method === 'POST') {
      lootQueue = [];
      sendJsonResponse(res, 200, { success: true, message: 'Queue cleared.' });
    }

    else if (url === '/api/loot/queue/apply' && method === 'POST') {
      try {
        if (lootQueue.length === 0) {
          console.log('[LootQueue] Force-apply called with empty queue. Triggering survival restart directly...');
          const restartResult = await executeDuneRestart('survival');
          sendJsonResponse(res, 200, { success: true, message: 'Survival server restarted.', restartResult });
          return;
        }

        console.log(`[LootQueue] Force-applying ${lootQueue.length} queued loot edits...`);
        for (const action of lootQueue) {
          try {
            if (action.type === 'add') {
              await database.addLootItem(action.params.inventoryId, action.params.templateId, action.params.stackSize, action.params.positionIndex);
            } else if (action.type === 'update') {
              await database.updateLootItem(action.params.itemId, action.params.stackSize, action.params.templateId);
            } else if (action.type === 'delete') {
              await database.deleteLootItem(action.params.itemId);
            }
          } catch (err) {
            console.error(`[LootQueue] Failed to execute queued action:`, action, err.message);
          }
        }

        lootQueue = [];
        console.log('[LootQueue] Force batch writes completed. Restarting Survival...');
        const restartResult = await executeDuneRestart('survival');
        sendJsonResponse(res, 200, { success: true, message: 'Queue applied and survival server restarted.', restartResult });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/loot/templates' && method === 'GET') {
      try {
        const templates = await database.getItemTemplates();
        sendJsonResponse(res, 200, { success: true, templates });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/airdrop/multipliers' && method === 'GET') {
      try {
        const resDb = await database.pool.query("SELECT config_value FROM dune.discord_bot_config WHERE config_key = 'airdrop_multipliers'");
        const multipliers = resDb.rows.length > 0 && resDb.rows[0].config_value ? resDb.rows[0].config_value : { testing_stations: 1, shipwrecks: 1, daily_allowance: 1 };
        sendJsonResponse(res, 200, { success: true, multipliers });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/airdrop/multipliers' && method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const testing_stations = parseInt(body.testing_stations);
        const shipwrecks = parseInt(body.shipwrecks);
        const daily_allowance = parseInt(body.daily_allowance);
        
        if (isNaN(testing_stations) || testing_stations < 1 || isNaN(shipwrecks) || shipwrecks < 1 || isNaN(daily_allowance) || daily_allowance < 1) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid multipliers values' });
          return;
        }

        const multipliers = { testing_stations, shipwrecks, daily_allowance };
        await database.pool.query(
          "INSERT INTO dune.discord_bot_config (config_key, config_value) VALUES ('airdrop_multipliers', $1::jsonb) ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value",
          [JSON.stringify(multipliers)]
        );

        console.log('[AirdropMultiplier] Saved airdrop scaling multipliers:', multipliers);
        sendJsonResponse(res, 200, { success: true, multipliers });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/airdrop/pending' && method === 'GET') {
      try {
        const resDb = await database.pool.query(`
          SELECT bpd.id, bpd.account_id, COALESCE(ps.character_name, 'Unknown') as character_name, bpd.template_id, bpd.stack_size, bpd.created_at
          FROM dune.bot_pending_deliveries bpd
          LEFT JOIN dune.player_state ps ON bpd.account_id = ps.account_id
          WHERE bpd.is_applied = false
          ORDER BY bpd.created_at DESC
        `);
        sendJsonResponse(res, 200, { success: true, pending: resDb.rows });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/settings/gameplay' && method === 'GET') {
      try {
        const { exec } = require('child_process');
        exec("docker exec redblink-dune-docker-console python3 /repo/runtime/scripts/usersettings.py map-values Survival_1", (error, stdout, stderr) => {
          if (error) {
            console.error('[Settings] Failed to fetch settings:', error.message, stderr);
            sendJsonResponse(res, 500, { success: false, error: 'Failed to fetch settings from server' });
            return;
          }
          
          const lines = (stdout || '').split('\n');
          let xp_multiplier = 1.0;
          let harvest_multiplier = 1.0;
          
          for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
              const key = parts[0].trim();
              const val = parseFloat(parts[1].trim());
              if (key === 'global_xp_multiplier') {
                xp_multiplier = isNaN(val) ? 1.0 : val;
              } else if (key === 'global_harvest_amount_multiplier') {
                harvest_multiplier = isNaN(val) ? 1.0 : val;
              }
            }
          }
          
          sendJsonResponse(res, 200, { success: true, xp_multiplier, harvest_multiplier });
        });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url === '/api/settings/gameplay' && method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const xp = parseFloat(body.xp_multiplier);
        const harvest = parseFloat(body.harvest_multiplier);
        
        if (isNaN(xp) || xp < 0.1 || isNaN(harvest) || harvest < 0.1) {
          sendJsonResponse(res, 400, { success: false, error: 'Invalid settings values' });
          return;
        }
        
        const { exec } = require('child_process');
        const setXpCmd = `docker exec redblink-dune-docker-console python3 /repo/runtime/scripts/usersettings.py map-set Survival_1 global_xp_multiplier ${xp}`;
        const setHarvestCmd = `docker exec redblink-dune-docker-console python3 /repo/runtime/scripts/usersettings.py map-set Survival_1 global_harvest_amount_multiplier ${harvest}`;
        const materializeCmd = `docker exec redblink-dune-docker-console python3 /repo/runtime/scripts/usersettings.py materialize-current`;
        
        exec(`${setXpCmd} && ${setHarvestCmd} && ${materializeCmd}`, (error, stdout, stderr) => {
          if (error) {
            console.error('[Settings] Failed to save gameplay settings:', error.message, stderr);
            sendJsonResponse(res, 500, { success: false, error: 'Failed to apply settings on server' });
            return;
          }
          sendJsonResponse(res, 200, { success: true, xp_multiplier: xp, harvest_multiplier: harvest });
        });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
    }

    else if (url.startsWith('/api/debug/db-check') && method === 'GET') {
      try {
        const actorsCount = await database.pool.query("SELECT COUNT(*) FROM dune.actors");
        const buildingsCount = await database.pool.query("SELECT COUNT(*) FROM dune.buildings");
        const instancesCount = await database.pool.query("SELECT COUNT(*) FROM dune.building_instances");
        const distinctClasses = await database.pool.query("SELECT class, COUNT(*) as count FROM dune.actors GROUP BY class ORDER BY count DESC LIMIT 15");
        const buildingActors = await database.pool.query("SELECT a.id, a.class, a.transform::text FROM dune.buildings b JOIN dune.actors a ON b.id = a.id LIMIT 10");
        const actorStateCheck = await database.pool.query("SELECT * FROM dune.actor_state LIMIT 10");
        const instancesSample = await database.pool.query("SELECT transform FROM dune.building_instances WHERE building_id = 144 LIMIT 5");

        sendJsonResponse(res, 200, {
          success: true,
          actorsCount: parseInt(actorsCount.rows[0].count),
          buildingsCount: parseInt(buildingsCount.rows[0].count),
          instancesCount: parseInt(instancesCount.rows[0].count),
          distinctClasses: distinctClasses.rows,
          buildingActors: buildingActors.rows,
          actorStateCheck: actorStateCheck.rows,
          instancesSample: instancesSample.rows
        });
      } catch (err) {
        sendJsonResponse(res, 500, { success: false, error: err.message });
      }
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

  // Revert Loot Multiplier DB Trigger & Set up Airdrop Config
  try {
    // 0. Drop old trigger and function to restore database state
    await database.pool.query(`
      DROP TRIGGER IF EXISTS trg_multiply_loot ON dune.items;
      DROP FUNCTION IF EXISTS dune.multiply_loot_stack_size();
    `);
    console.log('[Init] Removed legacy Loot Multiplier database trigger and function.');

    // 1. Ensure the discord_bot_config table exists
    await database.pool.query(`
      CREATE TABLE IF NOT EXISTS dune.discord_bot_config (
        config_key text PRIMARY KEY,
        config_value jsonb
      )
    `);

    // 2. Initialize airdrop multiplier config key if not exists
    await database.pool.query(`
      INSERT INTO dune.discord_bot_config (config_key, config_value) 
      VALUES ('airdrop_multiplier', '{"multiplier": 1}'::jsonb) 
      ON CONFLICT (config_key) DO NOTHING
    `);

    // 3. Create the pending deliveries queue table
    await database.pool.query(`
      CREATE TABLE IF NOT EXISTS dune.bot_pending_deliveries (
        id SERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL,
        template_id TEXT NOT NULL,
        stack_size INT NOT NULL,
        is_applied BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Init] Verified and successfully initialized Airdrop Delivery database tables.');
  } catch (err) {
    console.error('[Init] Failed to initialize database setup:', err.message);
  }

  const API_PORT = process.env.API_PORT || 3005;
  server.listen(API_PORT, () => {
    console.log(`[API] Server is listening on port ${API_PORT}`);
  });

  // Track players' previous maps to detect zone changes
  const playerMapCache = {};

  // Background interval check for map transitions and offline queue processing
  setInterval(async () => {
    try {
      // 1. Fetch active players, their maps, and online status
      const res = await database.pool.query(`
        SELECT ps.account_id, ps.player_pawn_id, act.map, ps.online_status::text as status
        FROM dune.player_state ps
        JOIN dune.actors act ON ps.player_pawn_id = act.id
        WHERE ps.player_pawn_id IS NOT NULL
      `);

      for (const row of res.rows) {
        const accountId = row.account_id;
        const currentMap = row.map;
        const isOnline = row.status === 'Online';
        const prev = playerMapCache[accountId];

        // Store/Update cache
        playerMapCache[accountId] = { map: currentMap, online: isOnline };

        if (prev) {
          // Detect transition: player was in a dungeon map, now they are in the overworld map
          const wasInDungeon = prev.map && prev.map.startsWith('CB_');
          const nowInOverworld = currentMap && !currentMap.startsWith('CB_');

          if (wasInDungeon && nowInOverworld) {
            console.log(`[Airdrop] Detected map transition for Account ${accountId}: ${prev.map} -> ${currentMap}`);
            await checkAndQueueDungeonReward(accountId, prev.map, row.player_pawn_id);
          }
        }

        // 2. If player is transitioning or offline, check and inject pending deliveries
        if (!isOnline || (prev && prev.map !== currentMap)) {
          await processPendingDeliveries(accountId, row.player_pawn_id);
        }
      }
    } catch (error) {
      console.error('[Airdrop] Error running transition check:', error.message);
    }
  }, 10000);

  // Helper: Verify dungeon completion tag and queue reward crates
  async function checkAndQueueDungeonReward(accountId, dungeonMap, pawnId) {
    const dungeonConfig = {
      'CB_Ecolab_Bronze_Green_152': {
        name: 'Testing Station 152 (Ecolab)',
        level: 15,
        tag: 'BigMoments.SpiceVision.Complete', // Sourced from game completed tags
        lootTable: [
          { template: 'ChemicalReagent_T1', qty: 10 },
          { template: 'StandardAmmo', qty: 30 },
          { template: 'IronOre', qty: 25 }
        ],
        category: 'testing_stations'
      }
    };

    let config = dungeonConfig[dungeonMap];
    if (!config) {
      // Generic fallback for other dynamic zones
      config = {
        name: `Testing Station ${dungeonMap}`,
        level: 20,
        tag: `Dungeon.${dungeonMap.split('_')[1] || 'Generic'}.Complete`,
        lootTable: [
          { template: 'Sulfur', qty: 15 },
          { template: 'CopperOre', qty: 20 },
          { template: 'BasicAmmo', qty: 25 }
        ],
        category: 'testing_stations'
      };
    }

    try {
      // 1. Check if completion tag exists in player_tags
      const tagRes = await database.pool.query(
        "SELECT 1 FROM dune.player_tags WHERE account_id = $1 AND tag = $2",
        [accountId, config.tag]
      );
      if (tagRes.rows.length === 0) {
        console.log(`[Airdrop] Completion tag ${config.tag} not found for Account ${accountId}. Skipping reward.`);
        return;
      }

      // 2. Anti-spam: check if they claimed this dungeon's reward in the last 15 minutes
      const claimRes = await database.pool.query(`
        SELECT 1 FROM dune.bot_pending_deliveries 
        WHERE account_id = $1 AND template_id = $2 AND created_at > NOW() - INTERVAL '15 minutes'
      `, [accountId, config.lootTable[0].template]);
      if (claimRes.rows.length > 0) {
        console.log(`[Airdrop] Account ${accountId} already rewarded for ${config.name} recently. Cooldown active.`);
        return;
      }

      // 3. Fetch current multipliers
      const multRes = await database.pool.query("SELECT config_value FROM dune.discord_bot_config WHERE config_key = 'airdrop_multipliers'");
      const multipliers = multRes.rows.length > 0 && multRes.rows[0].config_value ? multRes.rows[0].config_value : { testing_stations: 1, shipwrecks: 1, daily_allowance: 1 };
      const multiplier = parseInt(multipliers[config.category]) || 1;

      // 4. Fetch player level from FLevelComponent
      const xpRes = await database.pool.query(`
        SELECT COALESCE((fe.components->'FLevelComponent'->1->>'TotalXPEarned')::bigint, 0) as xp
        FROM dune.player_state ps
        LEFT JOIN dune.actor_fgl_entities afe ON afe.actor_id = ps.player_pawn_id AND afe.slot_name = 'DuneCharacter'
        LEFT JOIN dune.fgl_entities fe ON fe.entity_id = afe.entity_id
        WHERE ps.account_id = $1
        LIMIT 1
      `, [accountId]);
      const xp = xpRes.rows.length > 0 ? parseInt(xpRes.rows[0].xp) || 0 : 0;
      const playerLevel = Math.min(60, Math.floor(Math.sqrt(xp / 100)) + 1 || 1);

      // 5. Level-gap penalty calculation
      const levelGap = playerLevel - config.level;
      let penalty = 1.0;
      if (levelGap > 20) {
        penalty = 0.0;
      } else if (levelGap > 10) {
        penalty = 0.2;
      }

      if (penalty > 0) {
        for (const item of config.lootTable) {
          const finalQty = Math.max(1, Math.round(item.qty * multiplier * penalty));
          await database.pool.query(`
            INSERT INTO dune.bot_pending_deliveries (account_id, template_id, stack_size, is_applied)
            VALUES ($1, $2, $3, false)
          `, [accountId, item.template, finalQty]);
        }
        console.log(`[Airdrop] Queued rewards for Account ${accountId} - Dungeon: ${config.name} (Multiplier: ${multiplier}x, Level Penalty: ${penalty}x)`);
      } else {
        console.log(`[Airdrop] Player level (${playerLevel}) too high for dungeon level (${config.level}). Level-gap penalty reduced reward to 0.`);
      }
    } catch (err) {
      console.error(`[Airdrop] Failed to calculate/queue reward for Account ${accountId}:`, err.message);
    }
  }

  // Helper: Deliver pending items into player's database inventory
  async function processPendingDeliveries(accountId, pawnId) {
    try {
      const invRes = await database.pool.query(
        "SELECT id FROM dune.inventories WHERE actor_id = $1 LIMIT 1",
        [pawnId]
      );
      if (invRes.rows.length === 0) return;

      const inventoryId = invRes.rows[0].id;

      // Retrieve pending deliveries
      const pending = await database.pool.query(
        "SELECT id, template_id, stack_size FROM dune.bot_pending_deliveries WHERE account_id = $1 AND is_applied = false",
        [accountId]
      );
      if (pending.rows.length === 0) return;

      console.log(`[Airdrop] Injecting ${pending.rows.length} pending items to player ${pawnId} inventory ${inventoryId}...`);

      for (const item of pending.rows) {
        // Insert item safely using slot positioning
        await database.pool.query(`
          INSERT INTO dune.items (inventory_id, template_id, stack_size, position_index, is_new, acquisition_time, stats, quality_level)
          VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position_index) + 1, 0) FROM dune.items WHERE inventory_id = $1), true, 0, '{}'::jsonb, 0)
        `, [inventoryId, item.template_id, item.stack_size]);
        
        // Mark delivery as completed
        await database.pool.query(
          "UPDATE dune.bot_pending_deliveries SET is_applied = true WHERE id = $1",
          [item.id]
        );
      }
      console.log(`[Airdrop] Delivered all pending items successfully.`);
    } catch (err) {
      console.error(`[Airdrop] Failed to process pending deliveries for Account ${accountId}:`, err.message);
    }
  }

  if (!process.env.DISCORD_TOKEN) {
    console.warn('[Init] WARNING: No DISCORD_TOKEN provided. The bot is running in configuration-only mode. Please set the token via the Dune Console addon UI.');
  } else {
    client.login(process.env.DISCORD_TOKEN).catch(err => {
      console.error('[Init] Failed to log in to Discord:', err.message);
    });
  }
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
