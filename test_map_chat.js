const { exec } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

// Configuration
const mapName = process.argv[2] || 'Abbir';
const dimension = 0;
const message = process.argv[3] || 'Testing map chat directly';
const containerName = 'dune-rmq-game';

// Redblink's synthetic persona
const senderFuncomId = "Server#4242";
const senderHexFlsId = "5E121CE000000001";
const accountId = "9000002";

// Timestamps
const date = new Date();
const pad = (n) => String(n).padStart(2, "0");
const timestamp = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}-${pad(date.getUTCHours())}.${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`;

const tests = [
  {
    name: "1. Exact RedBlink Match (UUID + Lowercase content)",
    msgId: `web-map-chat-${crypto.randomUUID()}`,
    type: "TextChat",
    outerContentKey: "content",
    text: `[Exact] ${message}`
  }
];

async function ensurePersona(client) {
  console.log("Upserting Server#4242 persona into database...");
  await client.query(`
    INSERT INTO dune.accounts (id, "user", funcom_id, display_name, name)
    VALUES ($1, $2, $3, 'Server', 'Server')
    ON CONFLICT (id) DO UPDATE SET "user" = $2, funcom_id = $3
  `, [accountId, senderHexFlsId, senderFuncomId]);

  await client.query(`
    INSERT INTO dune.player_state (account_id, character_name, online_status)
    VALUES ($1, 'Server', 'Offline'::dune.playerconnectionstatus)
    ON CONFLICT (account_id) DO UPDATE SET online_status = 'Offline'::dune.playerconnectionstatus
  `, [accountId]);

  try {
    // Attempt encrypted table updates as well if they exist
    await client.query(`
      INSERT INTO dune.encrypted_player_state (account_id, last_avatar_activity, online_status)
      VALUES ($1, to_timestamp(0), 'Offline'::dune.playerconnectionstatus)
      ON CONFLICT (account_id) DO UPDATE SET last_avatar_activity = to_timestamp(0), online_status = 'Offline'::dune.playerconnectionstatus
    `, [accountId]);
  } catch (e) {
    // Ignore errors for encrypted tables
  }
  
  // Wait a moment for game server to sync the DB change
  await new Promise(r => setTimeout(r, 1000));
}

async function runTest(testDef) {
  console.log(`\n=== Running Test: ${testDef.name} ===`);
  const inner = {
    m_Id: testDef.msgId,
    m_ChannelType: "Map",
    m_bUseSpoofedUserName: false,
    m_SpoofedUserNameFrom: { m_TableId: "", m_Key: "", m_UnlocalizedName: "" },
    m_FuncomIdFrom: senderFuncomId,
    m_UserNameTo: "",
    m_Message: {
      m_UnlocalizedMessage: testDef.text,
      m_LocalizedMessage: { m_TableId: "", m_Key: "", m_FormatArgs: [] }
    },
    m_Timestamp: timestamp,
    m_OriginLocation: { X: 0, Y: 0, Z: 0 },
    m_HasSeenMessage: false
  };

  const outerPayload = { Type: testDef.type };
  outerPayload[testDef.outerContentKey] = JSON.stringify(inner);
  
  const routingKey = `${mapName}.${dimension}`;
  const exchange = 'chat.map';
  
  const outerB64 = Buffer.from(JSON.stringify(outerPayload), 'utf8').toString('base64');
  const routingB64 = Buffer.from(routingKey, 'utf8').toString('base64');
  const exchangeB64 = Buffer.from(exchange, 'utf8').toString('base64');
  const senderIdB64 = Buffer.from(senderHexFlsId, 'utf8').toString('base64');

  const erlangScript = `
Outer = base64:decode(<<"${outerB64}">>),
Routing = base64:decode(<<"${routingB64}">>),
Sender = base64:decode(<<"${senderIdB64}">>),
Exchange = base64:decode(<<"${exchangeB64}">>),
XName = rabbit_misc:r(<<"/">>, exchange, Exchange),
X = rabbit_exchange:lookup_or_die(XName),
MsgId = list_to_binary("${testDef.msgId}"),
P = {list_to_atom("P_basic"), <<"content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"fls_backend">>, undefined},
Content = rabbit_basic:build_content(P, Outer),
{ok, Msg} = rabbit_basic:message(XName, Routing, Content),
Result = rabbit_queue_type:publish_at_most_once(X, Msg),
io:format("publish=~p exchange=chat.map routing=~s~n", [Result, Routing]).
`.trim().replace(/\n/g, ' ');

  const cliCommand = `docker exec -i ${containerName} rabbitmqctl eval '${erlangScript}'`;
  
  return new Promise((resolve) => {
    exec(cliCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.log(`Success: ${stdout.trim()}`);
      }
      setTimeout(resolve, 2000); // Wait 2s
    });
  });
}

async function main() {
  const client = new Client({
    user: process.env.DB_USER || 'dune',
    password: process.env.DB_PASSWORD || 'dune',
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 15432,
    database: process.env.DB_NAME || 'dune'
  });
  try {
    await client.connect();
    await ensurePersona(client);
  } catch (e) {
    console.log("DB setup failed, proceeding anyway:", e.message);
  } finally {
    await client.end();
  }

  console.log(`Sending to Map: ${mapName}`);
  for (const test of tests) {
    await runTest(test);
  }
  console.log("\nAll tests finished! Check your game screen to see which one appeared.");
}

main();
