const amqp = require('amqplib');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BUILTIN_COMMAND_AUTH_TOKEN = 'Nu6VmPWUMvdPMeB7qErr';

function getAuthToken() {
  if (process.env.DUNE_COMMAND_AUTH_TOKEN) {
    return process.env.DUNE_COMMAND_AUTH_TOKEN;
  }
  const repoRoot = process.env.DUNE_REPO_ROOT || '/root/dune-awakening-selfhost-docker';
  const tokenFile = path.resolve(repoRoot, 'runtime/secrets/command-auth-token.txt');
  try {
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    }
  } catch (err) {
    console.warn(`[AMQP] Warning: Failed to read token file: ${err.message}`);
  }
  return BUILTIN_COMMAND_AUTH_TOKEN;
}

let cachedOnlineFlsData = null;
let lastOnlineFetch = 0;

/**
 * Fetches the FLS Hex ID and Funcom ID of any currently ONLINE player from Postgres.
 * The Game server strictly requires the AMQP user_id to belong to a player who is currently
 * active on the map, otherwise the Map Chat packet is silently dropped.
 * Since we spoof the display name, it doesn't matter which online player we use.
 */
async function getOnlineFlsData() {
  const cacheTtlMs = 30 * 1000; // 30 seconds (keep short so we don't use disconnected players)
  if (cachedOnlineFlsData && (Date.now() - lastOnlineFetch < cacheTtlMs)) {
    return cachedOnlineFlsData;
  }

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 15432,
    user: process.env.DB_USER || 'dune',
    password: process.env.DB_PASSWORD || 'dune',
    database: process.env.DB_NAME || 'dune',
  });

  try {
    await client.connect();
    // Look for any character currently marked as Online
    const res = await client.query(`
      SELECT ac."user", convert_from(e.encrypted_funcom_id, 'UTF8') as funcom_id 
      FROM dune.accounts ac 
      JOIN dune.encrypted_accounts e ON e.id = ac.id 
      JOIN dune.player_state ps ON ps.account_id = ac.id
      WHERE ps.online_status = 'Online' 
      LIMIT 1
    `);
    
    if (res.rows.length > 0) {
      cachedOnlineFlsData = { flsId: res.rows[0].user, funcomId: res.rows[0].funcom_id };
      lastOnlineFetch = Date.now();
      console.log(`[PG] Successfully resolved an online player for chat routing: ${cachedOnlineFlsData.funcomId}`);
    } else {
      throw new Error('No players are currently online. Map Chat requires at least one active player to route the message.');
    }
    return cachedOnlineFlsData;
  } catch (err) {
    console.error('[PG] Error fetching FLS ID:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Sends a command to the Dune server.
 * Supports two modes:
 * 1. Direct AMQP (RabbitMQ) publishing (Recommended)
 * 2. CLI/Docker execution fallback (evaluating via rabbitmqctl eval)
 */
async function sendServerCommand(commandName, commandArgs = '') {
  const useCliFallback = process.env.USE_CLI_FALLBACK === 'true';

  let fields;
  
  if (commandName === 'announce') {
    // Parse title, message, and duration from commandArgs (e.g. Title | Message | Duration)
    let title = 'Admin Broadcast';
    let message = commandArgs;
    let duration = 30;
    
    if (commandArgs.includes('|')) {
      const parts = commandArgs.split('|').map(p => p.trim());
      if (parts.length >= 2) {
        title = parts[0];
        message = parts[1];
        if (parts.length >= 3) {
          const parsedDur = parseInt(parts[2]);
          if (!isNaN(parsedDur)) duration = parsedDur;
        }
      }
    }
    
    fields = {
      ServerCommand: 'ServiceBroadcast',
      BroadcastType: 'Generic',
      BroadcastPayload: {
        BroadcastDuration: duration,
        LocalizedText: ['en', 'en-US'].map(key => ({
          Key: key,
          Title: title,
          Body: message
        }))
      }
    };
  } else if (commandName === 'chat') {
    // We defer building the payload until we get the valid FuncomId
    const message = commandArgs;
    const mapName = 'HaggaBasin';
    const dimension = 0;
    // Due to aggressive server-side validation on chat.map (dropping offline/spoofed senders),
    // we route Discord chat through ServiceBroadcast so it is guaranteed to display in-game.
    console.log(`[Command] Routing chat message as ServiceBroadcast: "${message}"`);
    
    fields = {
      ServerCommand: 'ServiceBroadcast',
      BroadcastType: 'Generic',
      Text: `[Discord Bot]: ${message}`,
      TimeSecs: 10,
      ColorR: 230,
      ColorG: 126,
      ColorB: 34
    };

    // Update command name so it goes to orchestrator instead of CLI fallback
    commandName = 'ServiceBroadcast';
    useCliFallback = false;
  } else {
    fields = {
      Command: commandName,
      Args: commandArgs,
      Timestamp: Date.now(),
      Token: ''
    };
  }

  // Wrap inside the Version 2 envelope expected by the Dune game server orchestrator
  outer = {
    Version: 2,
    AuthToken: getAuthToken(),
    MessageContent: JSON.stringify(fields)
  };

  payloadString = JSON.stringify(outer);
  console.log(`[Command] Sending command: "${commandName}" with args: "${commandArgs}"`);

  if (useCliFallback) {
    return sendViaCli(payloadString);
  } else {
    return sendViaAmqp(payloadString);
  }
}

/**
 * Mode 1: Send via Direct AMQP Connection
 */
async function sendViaAmqp(payloadString, overrideExchange, overrideRoutingKey, overrideOptions) {
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://localhost:31982';
  const exchange = overrideExchange || process.env.RABBITMQ_EXCHANGE || 'heartbeats';
  const routingKey = overrideRoutingKey || process.env.RABBITMQ_ROUTING_KEY || 'notifications';

  let connection;
  try {
    connection = await amqp.connect(rabbitUrl);
    const channel = await connection.createChannel();

    const buffer = Buffer.from(payloadString, 'utf8');

    console.log(`[AMQP] Publishing to exchange: "${exchange}", routingKey: "${routingKey}"`);
    const options = overrideOptions || {
      contentType: 'application/json',
      deliveryMode: 2 // Persistent
    };
    
    const published = channel.publish(exchange, routingKey, buffer, options);

    await channel.close();
    return published;
  } catch (error) {
    console.error('[AMQP] Failed to publish message directly to RabbitMQ:', error.message);
    throw error;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {}
    }
  }
}

/**
 * Initialize CLI Fallback Mode
 * Kept as a dummy hook for compatibility since connectionless eval bypasses auth setup
 */
function initCliFallback() {
  console.log('[AMQP] CLI fallback mode initialized (using connectionless direct publish).');
  return Promise.resolve();
}

/**
 * Mode 2: Send via CLI/Docker fallback using rabbitmqctl eval
 */
function sendViaCli(payloadString) {
  return new Promise((resolve, reject) => {
    // Base64 encode the envelope
    const base64Payload = Buffer.from(payloadString, 'utf8').toString('base64');
    
    const containerName = process.env.RABBITMQ_CONTAINER_NAME || 'dune-rmq-game';
    
    // Connectionless, system-level direct publish via rabbit_queue_type:publish_at_most_once
    const erlangScript = `
Outer = base64:decode(<<"${base64Payload}">>),
XName = rabbit_misc:r(<<"/">>, exchange, <<"heartbeats">>),
X = rabbit_exchange:lookup_or_die(XName),
MsgId = list_to_binary("web-discord-bot-" ++ integer_to_list(erlang:system_time(millisecond))),
P = {list_to_atom("P_basic"), <<"application/json">>, undefined, undefined, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined},
Content = rabbit_basic:build_content(P, Outer),
{ok, Msg} = rabbit_basic:message(XName, <<"notifications">>, Content),
Result = rabbit_queue_type:publish_at_most_once(X, Msg),
io:format("publish=~p exchange=heartbeats routing=notifications~n", [Result]).
`.trim().replace(/\n/g, ' ');

    const defaultTemplate = `docker exec -i ${containerName} rabbitmqctl eval '${erlangScript}'`;
    
    const cliCommand = process.env.CLI_COMMAND_TEMPLATE 
      ? process.env.CLI_COMMAND_TEMPLATE.replace('${base64Payload}', base64Payload)
      : defaultTemplate;

    console.log(`[CLI] Executing fallback command...`);
    
    exec(cliCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`[CLI] Error executing command: ${error.message}`);
        return reject(error);
      }
      if (stderr) {
        console.warn(`[CLI] Command stderr: ${stderr}`);
      }
      console.log(`[CLI] Success: ${stdout.trim()}`);
      if (!/publish=ok/.test(stdout)) {
        return reject(new Error(`RabbitMQ publish did not report publish=ok. Output: ${stdout}`));
      }
      resolve(stdout.trim());
    });
  });
}

async function testAmqpConnection() {
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://localhost:31982';
  try {
    const connection = await amqp.connect(rabbitUrl);
    await connection.close();
    console.log('[AMQP] RabbitMQ connection successful');
    return true;
  } catch (error) {
    console.error('[AMQP] RabbitMQ connection failed:', error.message);
    return false;
  }
}

module.exports = {
  sendServerCommand,
  testAmqpConnection,
  initCliFallback
};
