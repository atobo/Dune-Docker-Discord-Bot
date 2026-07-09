# Dune Server Chat Relay Implementation Guide

This document serves as a historical reference for how the two-way chat relay (Discord -> Game and Game -> Discord) was implemented. It details the various approaches we attempted, why they failed, and the final working solutions that successfully bypassed the game server's internal limitations.

## Part 1: Discord -> Game (Map Chat)

**The Goal:** Send a message from Discord to the game server such that all online players see it in their in-game Map Chat.

### What We Tried (And Why It Failed)

1. **Publishing to `chat.map` via HTTP/AMQP**
   * **Approach:** We crafted the exact JSON payload the game expects (`Type: "TextChat"`, `m_ChannelType: "Map"`) and published it to the `chat.map` exchange using the region routing key (e.g., `Survival_1.0` or `HaggaBasin.0`).
   * **Result:** RabbitMQ returned `publish=ok`, but the message never appeared in-game.
   * **Why it failed:** RedBlink explained that `publish=ok` simply means RabbitMQ accepted the message. The `chat.map` exchange has no persistent queues. If the game server drops the bindings or doesn't actively route them, the messages evaporate into the void.

2. **RabbitMQ Erlang Injection (`rabbitmqctl eval`)**
   * **Approach:** We tried to replicate the RedBlink Console's internal C# method of executing raw Erlang scripts inside the container to inject the message directly.
   * **Result:** Failed due to Erlang node name mismatches (`rabbit@localhost` vs `rabbit@dune-rmq-game`), security cookie constraints, and overall environment complexity.

3. **Database Spoofing for Synthetic Persona**
   * **Approach:** We thought the game was rejecting the message because the sender (`Server#4242` or `Discord`) didn't exist in the database. We UPSERTED a synthetic character into the DB and set `last_avatar_activity` to Epoch 0 and `online_status` to Offline to mimic an official system message.
   * **Result:** Still silently dropped by the `chat.map` exchange.

### What Finally Worked: Direct Queue Injection
Instead of relying on the unreliable `chat.map` exchange, we decided to bypass it entirely and deliver the message directly to the players' game clients.

1. **Queue Discovery:** We use `rabbitmqctl list_queues` to find all actively bound player queues (they are formatted as `FLS_<ID>_queue`).
2. **Direct Routing:** We publish the JSON payload to the default AMQP exchange (`""`) using the player's specific queue name as the routing key.
3. **The Trick:** Even though we deliver the message directly to a player (like a whisper), we set `m_ChannelType: "Map"` inside the JSON payload. The Unreal Engine game client blindly trusts this JSON property and renders the message in the Map Chat tab instead of the Whisper tab!

**Code Reference:** `src/rabbitmq.js` (`fetchActivePlayerQueues` and `sendDirectChatToQueues`)

---

## Part 2: Game -> Discord (Log Parsing)

**The Goal:** Capture Map Chat and Proximity Chat from the game server and relay it to a specific Discord channel.

### What We Tried (And Why It Failed)

1. **Tailing the Game Server Logs (`dune-server-survival-1`)**
   * **Approach:** The bot was originally configured to tail the main Unreal Engine server logs and look for `Chat:` or `LogChat:` entries.
   * **Result:** Game chat either didn't appear in the main server logs, or the regex parser completely missed it.
   * **The Culprit:** The Redblink Console Addon configuration (stored in `/app/addon-data/config.json`) was aggressively overriding the bot's `.env` file and forcing `LOG_CONTAINER_NAME=dune-server-survival-1`.

2. **Parsing `received message from`**
   * **Approach:** We attempted to parse logs looking for `received message from <ID>`.
   * **Result:** Failed. The text router does not format its logs this way.

### What Finally Worked: Forcing the Text Router
RedBlink's architecture specifically offloads chat routing to the `dune-text-router` container, so we must tail that container instead.

1. **Forcing the Container:** We modified `src/index.js` to completely ignore the RedBlink Addon config's `LOG_CONTAINER_NAME` and hardcoded it to forcefully use `dune-text-router`. This prevents accidental user configuration errors from breaking the relay.
2. **Correct Regex Parsing:** We analyzed the raw output of `dune-text-router` and discovered the exact log format for outgoing map chat.
   * **The Regex:** `/Redirected message from (\S+) to (\S+) using routing key [^:]+: (.+)$/`
   * **The Parsing:** We extract the JSON from the end of the log line, parse `m_FuncomIdFrom` to get the sender's name, and `m_UnlocalizedMessage` to get the content.

**Code Reference:** `src/logWatcher.js` (`line.match(/Redirected message from.../)`) and `src/index.js` (Addon config override).

---

## Summary of Critical Discoveries
* `chat.map` is a black hole. Always fetch `FLS_<ID>_queue` and use direct queue delivery for custom messages.
* `m_ChannelType` dictates how the game client renders the message, regardless of how it was delivered.
* `dune-server-survival-1` logs are useless for chat tracking. Always tail `dune-text-router`.
* RedBlink Addon configs overwrite local `.env` variables, so critical infrastructure targets (like container names) must be hardcoded in the bot's JS logic to prevent user misconfiguration.
