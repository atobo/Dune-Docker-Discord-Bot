const { exec } = require('child_process');

async function sendViaCli(exchange, routingKey, base64Payload, contentType = "application/json", useMsgId = false, type = undefined, sender = undefined, appId = undefined) {
  let msgIdLine = "";
  if (useMsgId) {
    msgIdLine = `MsgId = list_to_binary("web-discord-bot-" ++ integer_to_list(erlang:system_time(millisecond))),`;
  }
  
  let pTuple = `P = {list_to_atom("P_basic"), <<"${contentType}">>, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined},`;
  if (useMsgId && sender && appId && type) {
    pTuple = `P = {list_to_atom("P_basic"), <<"${contentType}">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"${type}">>, base64:decode(<<"${sender}">>), <<"${appId}">>, undefined},`;
  }

  const erlangScript = `
Outer = base64:decode(<<"${base64Payload}">>),
XName = rabbit_misc:r(<<"/">>, exchange, <<"${exchange}">>),
X = rabbit_exchange:lookup_or_die(XName),
${msgIdLine}
${pTuple}
Content = rabbit_basic:build_content(P, Outer),
{ok, Msg} = rabbit_basic:message(XName, <<"${routingKey}">>, Content),
Result = rabbit_queue_type:publish_at_most_once(X, Msg),
io:format("publish=~p exchange=${exchange} routing=${routingKey}~n", [Result]).
`.trim().replace(/\n/g, ' ');

  const containerName = 'dune-rmq-game';
  const cliCommand = `docker exec -i ${containerName} rabbitmqctl eval '${erlangScript}'`;
  
  return new Promise((resolve, reject) => {
    exec(cliCommand, (error, stdout) => {
      if (error) {
        return resolve(error.message);
      }
      resolve(stdout.trim());
    });
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Starting massive brute-force chat variant test suite...');

  let testCounter = 1;

  // TEST SUITE A: Heartbeats (Orchestrator)
  console.log('\n--- SUITE A: Orchestrator Heartbeats ---');
  const authTokens = ['Nu6VmPWUMvdPMeB7qErr', 'TFF-Dune-Admin-Token-777', 'test'];
  const broadcastTypes = ['Chat', 'System'];
  
  for (const token of authTokens) {
    for (const bType of broadcastTypes) {
      const payload = {
        Version: 2,
        AuthToken: token,
        MessageContent: JSON.stringify({
          ServerCommand: 'ServiceBroadcast',
          BroadcastType: bType,
          BroadcastPayload: {
            BroadcastDuration: 10,
            LocalizedText: [{ Key: 'en', Title: '', Body: `TEST ${testCounter}: Heartbeats ServiceBroadcast ${bType} Token=${token}` }]
          }
        })
      };
      
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const res = await sendViaCli('heartbeats', 'notifications', payloadB64, "application/json");
      console.log(`Test ${testCounter}: Heartbeats ServiceBroadcast ${bType} Token=${token} -> ${res}`);
      testCounter++;
      await sleep(1000);
    }
    
    const payloadChat = {
      Version: 2,
      AuthToken: token,
      MessageContent: JSON.stringify({
        ServerCommand: 'ServiceChat',
        Message: `TEST ${testCounter}: Heartbeats ServiceChat Token=${token}`
      })
    };
    const payloadChatB64 = Buffer.from(JSON.stringify(payloadChat)).toString('base64');
    const resChat = await sendViaCli('heartbeats', 'notifications', payloadChatB64, "application/json");
    console.log(`Test ${testCounter}: Heartbeats ServiceChat Token=${token} -> ${resChat}`);
    testCounter++;
    await sleep(1000);
  }

  // TEST SUITE B: chat.map Direct Injection
  console.log('\n--- SUITE B: Direct chat.map Injection ---');
  const mapRoutingKeys = [
    'Survival_1.0', 'Survival_1', 'Survival_1.1',
    'Overmap.0', 'Overmap', 'HaggaBasin.0', 'SietchAbbir.0'
  ];
  const contentTypes = ['Content', 'application/json'];
  
  for (const route of mapRoutingKeys) {
    for (const cType of contentTypes) {
      const inner = {
        m_bUseSpoofedUserName: false,
        m_FuncomIdFrom: 'Server#0001',
        m_SpoofedUserNameFrom: { m_TableId: "", m_Key: "", m_UnlocalizedName: "" },
        m_Message: { m_TableId: "", m_Key: "", m_UnlocalizedName: `TEST ${testCounter}: chat.map route=${route} cType=${cType}` },
        m_ChannelType: "Global"
      };
      const outer = { content: JSON.stringify(inner), Type: "TextChat" };
      const outerB64 = Buffer.from(JSON.stringify(outer)).toString('base64');
      const senderB64 = Buffer.from('A5C0DE5E12A00001').toString('base64');
      
      const res = await sendViaCli('chat.map', route, outerB64, cType, true, "text_chat", senderB64, "fls_backend");
      console.log(`Test ${testCounter}: chat.map route=${route} cType=${cType} -> ${res}`);
      testCounter++;
      await sleep(1000);
    }
  }

  console.log('\nAll test variants sent! Check the game chat to see which TEST numbers appeared!');
}

run().catch(console.error);
