const { exec } = require('child_process');
const crypto = require('crypto');

// Configuration
const mapName = process.argv[2] || 'Abbir';
const dimension = 0;
const message = process.argv[3] || 'Testing map chat directly';
const containerName = 'dune-rmq-game';

// Redblink's synthetic persona
const senderFuncomId = "Server#4242";
const senderHexFlsId = "5E121CE000000001";

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
  },
  {
    name: "2. Exact Whisper Match (UUID + Uppercase Content)",
    msgId: `web-map-chat-${crypto.randomUUID()}`,
    type: "ECourierMessageType::TextChat",
    outerContentKey: "Content",
    text: `[Upper] ${message}`
  }
];

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
P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"fls_backend">>, undefined},
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
      setTimeout(resolve, 2000); // Wait 2s between tests
    });
  });
}

async function main() {
  console.log(`Sending to Map: ${mapName}`);
  for (const test of tests) {
    await runTest(test);
  }
  console.log("\nAll tests finished! Check your game screen to see which one appeared.");
}

main();
