const amqp = require('amqplib');

const BUILTIN_COMMAND_AUTH_TOKEN = 'Nu6VmPWUMvdPMeB7qErr';
const RABBITMQ_URL = 'amqp://dune:dune@192.168.1.33:31982';
const EXCHANGE = 'heartbeats';
const ROUTING_KEY = 'notifications';

async function sendPayload(fields) {
  const outer = {
    Version: 2,
    AuthToken: BUILTIN_COMMAND_AUTH_TOKEN,
    MessageContent: JSON.stringify(fields)
  };

  const payloadString = JSON.stringify(outer);
  console.log(`[Test] Sending payload: ${JSON.stringify(fields)}`);

  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  const buffer = Buffer.from(payloadString, 'utf8');

  channel.publish(EXCHANGE, ROUTING_KEY, buffer, {
    contentType: 'application/json',
    deliveryMode: 2
  });

  await channel.close();
  await connection.close();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Starting chat variant test suite...');

  // Variant 1: BroadcastType 'Chat' with duration 0 (what we tried)
  await sendPayload({
    ServerCommand: 'ServiceBroadcast',
    BroadcastType: 'Chat',
    BroadcastPayload: {
      BroadcastDuration: 0,
      LocalizedText: [{ Key: 'en', Title: '', Body: 'V1: ServiceBroadcast Chat dur=0' }]
    }
  });
  await sleep(4000);

  // Variant 2: BroadcastType 'Chat' with duration 10
  await sendPayload({
    ServerCommand: 'ServiceBroadcast',
    BroadcastType: 'Chat',
    BroadcastPayload: {
      BroadcastDuration: 10,
      LocalizedText: [{ Key: 'en', Title: '', Body: 'V2: ServiceBroadcast Chat dur=10' }]
    }
  });
  await sleep(4000);

  // Variant 3: BroadcastType 'System' with duration 10
  await sendPayload({
    ServerCommand: 'ServiceBroadcast',
    BroadcastType: 'System',
    BroadcastPayload: {
      BroadcastDuration: 10,
      LocalizedText: [{ Key: 'en', Title: '', Body: 'V3: ServiceBroadcast System dur=10' }]
    }
  });
  await sleep(4000);

  // Variant 4: BroadcastType 'Notification'
  await sendPayload({
    ServerCommand: 'ServiceBroadcast',
    BroadcastType: 'Notification',
    BroadcastPayload: {
      BroadcastDuration: 10,
      LocalizedText: [{ Key: 'en', Title: '', Body: 'V4: ServiceBroadcast Notification dur=10' }]
    }
  });
  await sleep(4000);

  // Variant 5: ServerCommand 'ServiceChat'
  await sendPayload({
    ServerCommand: 'ServiceChat',
    Message: 'V5: ServiceChat direct message'
  });
  await sleep(4000);

  // Variant 6: ServerCommand 'ChatMessage'
  await sendPayload({
    ServerCommand: 'ChatMessage',
    Message: 'V6: ChatMessage direct'
  });
  await sleep(4000);

  // Variant 7: Command 'say' via standard Command fields
  await sendPayload({
    Command: 'say',
    Args: 'V7: Command say message',
    Timestamp: Date.now(),
    Token: ''
  });
  await sleep(4000);

  // Variant 8: Command 'broadcast' via standard Command fields
  await sendPayload({
    Command: 'broadcast',
    Args: 'V8: Command broadcast message',
    Timestamp: Date.now(),
    Token: ''
  });
  await sleep(4000);

  console.log('All test variants sent.');
}

run().catch(console.error);
