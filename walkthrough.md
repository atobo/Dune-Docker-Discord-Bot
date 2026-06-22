# Walkthrough - 2-Way Discord and In-Game Chat Relay

We have completed the implementation of the 2-way chat relay between the Discord channel and the *Dune: Awakening* in-game chat!

## Changes Made

### 1. In-Game to Discord Relay
In [logWatcher.js](file:///c:/Users/atobo/Desktop/discord%20bot/src/logWatcher.js):
- Added the new regex pattern `chatNew` to match the exact in-game chat log format:
  `LogChat: Display: [<Channel>]: [<PlayerName>]: <Message>`
- Updated `parseLine(line)` to try matching the `chatNew` format first. When it matches, it parses the channel name (e.g., `Proximity` or `Global`) and player name, forwarding both along with the message to the callback.
- Kept the old legacy `Chat: <Player>: <Message>` pattern as a fallback.

In [index.js](file:///c:/Users/atobo/Desktop/discord%20bot/src/index.js):
- Updated the `onChat` callback handler within `setupLogWatcher()` to receive the channel name.
- Formatted the Discord embeds to display the channel name, e.g. `[Global] <**Nalita**> hello hagga basin chat`.

### 2. Discord to In-Game Relay
In [index.js](file:///c:/Users/atobo/Desktop/discord%20bot/src/index.js):
- Updated the Discord `messageCreate` event handler to relay messages using the `chat` server command instead of `announce`.
- Formatted messages to target the `Global` chat channel in-game: ``Global ${authorName} | ${message.cleanContent}``.

## Validation Results

We wrote a validation script [verify_parsing.js](file:///C:/Users/atobo/.gemini/antigravity-ide/brain/2473f4ce-2a15-4cc1-b485-acd11b40f9ba/scratch/verify_parsing.js) and executed it locally with the following results:
```text
Testing LogWatcher parsing of different formats...
Test 1 (Proximity): {
  player: 'Nalita',
  message: 'hello proximity chat',
  channel: 'Proximity'
}
✅ Test 1 Passed!
Test 2 (Global): {
  player: 'Nalita',
  message: 'hello hagga basin chat',
  channel: 'Global'
}
✅ Test 2 Passed!
Test 3 (Legacy): { player: 'JohnDoe', message: 'Hello there!', channel: undefined }
✅ Test 3 Passed!
```
All parsing tests succeeded!

### 3. Docker Container Log Tailing Fix & Real-time text-router Integration
During live testing on the remote VM, we resolved two critical issues:
- **In-game to Discord:** We discovered that standard chat logs are not written to the game server's log file (`DuneSandbox_PIDX-1.log`). Instead, they are routed and logged in real-time by the central `dune-text-router` container's stdout.
  - *Resolution:* Updated `logWatcher.js` to tail the `dune-text-router` logs directly using `docker logs -f --tail 0` and parse the raw JSON chat logs, cleanly mapping player IDs and channels to Discord embeds.
- **Discord to In-game:** We found that the game server rejected `ServiceBroadcast` commands with `"BroadcastType": "Global"`.
  - *Resolution:* Intercepted the `chat` command in `rabbitmq.js` to build a direct `TextChat` AMQP payload and publish it directly to the `chat.map` exchange with routing key `HaggaBasin.0` via the connectionless Erlang execution mechanism.

Both directions of the chat relay are now fully functional and verified working!
