const amqp = require('amqplib');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    const senderFuncomId = 'Server#0001';
    const message = commandArgs;
    const mapName = 'HaggaBasin';
    const dimension = 0;
    const crypto = require('crypto');
    const msgId = crypto.randomUUID ? crypto.randomUUID() : 'chat-' + Date.now();
    
    const date = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timestamp = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}-${pad(date.getUTCHours())}.${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`;
    
    const inner = {
      m_Id: msgId,
      m_ChannelType: "Map",
      m_bUseSpoofedUserName: false,
      m_SpoofedUserNameFrom: {
        m_TableId: "",
        m_Key: "",
        m_UnlocalizedName: ""
      },
      m_FuncomIdFrom: senderFuncomId,
      m_UserNameTo: "",
      m_Message: {
        m_UnlocalizedMessage: message,
        m_LocalizedMessage: {
          m_TableId: "",
          m_Key: "",
          m_FormatArgs: []
        }
      },
      m_Timestamp: timestamp,
      m_OriginLocation: { X: 0, Y: 0, Z: 0 },
      m_HasSeenMessage: false
    };

    const outer = {
      content: JSON.stringify(inner),
      Type: "TextChat"
    };

    const payloadString = JSON.stringify(outer);
    const routingKey = `${mapName}.${dimension}`;
    const exchange = 'chat.map';
    
    console.log(`[Command] Sending direct chat message: "${message}" to exchange: ${exchange}`);
    if (useCliFallback) {
      // Restore CLI fallback for chat.map with proper headers!
      const outerB64 = Buffer.from(payloadString, 'utf8').toString('base64');
      const routingB64 = Buffer.from(routingKey, 'utf8').toString('base64');
      const exchangeB64 = Buffer.from(exchange, 'utf8').toString('base64');
      const senderFuncomIdB64 = Buffer.from('A5C0DE5E12A00001', 'utf8').toString('base64'); // Using hex FLS id

      const erlangScript = `
Outer = base64:decode(<<"${outerB64}">>),
Routing = base64:decode(<<"${routingB64}">>),
Sender = base64:decode(<<"${senderFuncomIdB64}">>),
Exchange = base64:decode(<<"${exchangeB64}">>),
XName = rabbit_misc:r(<<"/">>, exchange, Exchange),
X = rabbit_exchange:lookup_or_die(XName),
MsgId = list_to_binary("web-discord-bot-chat-" ++ integer_to_list(erlang:system_time(millisecond))),
P = {list_to_atom("P_basic"), <<"application/json">>, undefined, undefined, 2, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"fls_backend">>, undefined},
Content = rabbit_basic:build_content(P, Outer),
{ok, Msg} = rabbit_basic:message(XName, Routing, Content),
Result = rabbit_queue_type:publish_at_most_once(X, Msg),
io:format("publish=~p exchange=chat.map routing=~s~n", [Result, Routing]).
`.trim().replace(/\n/g, ' ');

      const containerName = process.env.RABBITMQ_CONTAINER_NAME || 'dune-rmq-game';
      const cliCommand = `docker exec -i ${containerName} rabbitmqctl eval '${erlangScript}'`;
      
      console.log(`[CLI] Executing chat.map fallback command...`);
      return new Promise((resolve, reject) => {
        exec(cliCommand, (error, stdout, stderr) => {
          if (error) {
            console.error(`[CLI] Direct chat error: ${error.message}`);
            return reject(error);
          }
          console.log(`[CLI] Direct chat success: ${stdout.trim()}`);
          if (!/publish=ok/.test(stdout)) {
            return reject(new Error(`RabbitMQ chat publish did not report publish=ok. Output: ${stdout}`));
          }
          resolve(stdout.trim());
        });
      });
    } else {
    fields = {
      Command: commandName,
      Args: commandArgs,
      Timestamp: Date.now(),
      Token: ''
    };
  }

  // Wrap inside the Version 2 envelope expected by the Dune game server orchestrator
  const outer = {
    Version: 2,
    AuthToken: getAuthToken(),
    MessageContent: JSON.stringify(fields)
  };

  const payloadString = JSON.stringify(outer);
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
