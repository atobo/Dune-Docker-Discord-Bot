# Dune Server Discord Bot

A Discord bot designed to connect a Discord server with a self-hosted **Dune: Awakening** game server (running on Ubuntu via Docker/Dune Docker Console).

## Features

1. **Server Status (`/status`)**: Live check of the server status and database connectivity.
2. **Player List (`/players`)**: Lists online players with name, level, and faction directly from the PostgreSQL database.
3. **Admin Commands**: Dedicated `/giveitem`, `/kick`, `/teleport`, and `/announce` commands to manage the game securely.
4. **Automated Messages (`/automessage`)**: Schedule recurring broadcasts to the in-game global chat.
5. **Care Packages (`/carepackage`)**: List and grant RedBlink configured care packages to players.
6. **Restart Services (`/restart`)**: Restarts individual Dune server service containers directly from Discord.
7. **Two-Way Chat Relay**: Relays messages written in a specific Discord channel straight to the game server as announcements.
8. **Real-time Event Alerts**: Automatically tails the server logs to announce player joins, departures, and sandstorms to Discord in real-time.
9. **Android App Companion**: A beautiful Material Design Android app to monitor the server, view online players, trigger an emergency "Panic" restart, and track live players on dynamic high-res interactive maps for Deep Desert and Hagga Basin.
10. **RedBlink Addon Integration**: Fully containerized and seamlessly integrates with RedBlink's Community Addon tab for web-based configuration.

---

## Prerequisites

1. **Node.js** (v16.9.0 or higher) installed on the hosting server.
2. A **Discord Bot** created on the [Discord Developer Portal](https://discord.com/developers/applications):
   - Under **Bot**, enable the following **Privileged Gateway Intents**:
     - *Presence Intent*
     - *Server Members Intent*
     - *Message Content Intent*
   - Invite the bot to your Discord server using the OAuth2 URL generator (select `bot` scope and `applications.commands` scope, and give it appropriate channel permissions).

---

## Configuration

1. Copy the `.env.example` file to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and configure your credentials:
   - **DISCORD_TOKEN**: Your Discord Bot Token.
   - **CLIENT_ID**: The Application/Client ID of your bot.
   - **GUILD_ID**: (Optional) Your Discord Server ID (speeds up slash command registration for development).
   - **CHANNEL_ID**: The Discord channel ID where log events and chat relay should occur.
   - **PostgreSQL Settings (`DB_*`)**: Port, host, user, password, and database of your Dune game container (default port is typically `15432` in Dune Docker setups).
   - **RabbitMQ Setting (`RABBITMQ_URL`)**: Connection string to the game's message broker (typically on port `31982`).
   - **LOG_CONTAINER_NAME**: The Docker container name of your Dune game server. 
     > [!TIP]
     > To find your container names on the Ubuntu host, run:
     > ```bash
     > docker ps
     > ```
     > Look for the container that runs the game instances (e.g. named `dune-orchestrator` or a name containing `dune-server` / `dune-sietch`). Enter the container name here if you want to stream logs directly from Docker (Recommended).
   - **LOG_FILE_PATH**: The host path to the server log file (e.g. `DuneSandbox.log` or `Dune.log`) if you prefer tailing a file instead of the container directly.
     > [!TIP]
     > To find where your logs are on the host filesystem under the RedBlink setup, you can search for them using:
     > ```bash
     > find / -name "*Dune*.log" 2>/dev/null
     > # Or inside your dune-awakening-selfhost-docker folder:
     > find . -name "*.log"
     > ```
     > Typically, the logs are written to the mapped persistence path under `Saved/Logs/DuneSandbox.log`.

---

## Deployment and Setup

### 1. Install via RedBlink Console (Recommended Addon Method)
You can now run this bot effortlessly via the RedBlink Docker Addon system:
1. Navigate to the **Community Addons** tab in your RedBlink web console.
2. Search for the **Discord Bot Integration** addon and install it.
3. Once installed, use the web interface to configure your `DISCORD_TOKEN`, `CLIENT_ID`, and `RABBITMQ_URL`.
4. Launch the bot using the included `docker-compose.yml` to automatically read the web configuration!
   ```bash
   docker-compose up -d
   ```

### Alternative: Install Locally (Node.js)
```bash
npm install
```

### 2. Register Slash Commands
Run the command registration script. This sends your slash commands to Discord's API:
```bash
npm run register
```

### 3. Run the Bot
Start the bot directly:
```bash
npm start
```

---

## Running 24/7 on Ubuntu (systemd)

To make sure the bot runs continuously in the background and restarts automatically on crash or system reboot, configure it as a `systemd` service:

1. Create a service file:
   ```bash
   sudo nano /etc/systemd/system/dune-bot.service
   ```
2. Paste the following configuration (adjusting paths and user):
   ```ini
   [Unit]
   Description=Dune Server Discord Bot
   After=network.target

   [Service]
   Type=simple
   User=dune
   WorkingDirectory=/opt/dune-discord-bot
   ExecStart=/usr/bin/node src/index.js
   Restart=on-failure
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```
3. Reload systemd, enable, and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable dune-bot
   sudo systemctl start dune-bot
   ```
4. Check status and logs:
   ```bash
   sudo systemctl status dune-bot
   journalctl -u dune-bot -n 50 -f
   ```

---

## Command Dispatcher Modes

If your bot cannot connect to RabbitMQ directly via AMQP (e.g. due to networking or credential issues), you can enable **CLI Fallback Mode**:

1. In `.env`, set:
   ```env
   USE_CLI_FALLBACK=true
   RABBITMQ_CONTAINER_NAME=dune-rabbitmq
   ```
2. This configures the bot to execute local docker commands via:
   `docker exec -i dune-rabbitmq rabbitmqctl eval "..."`
   to publish the command envelopes. Ensure the user running the Node.js process has permissions to run `docker` commands (i.e. is in the `docker` user group).

---

## How to Use the Bot

Once the bot is running, administrators can dispatch commands directly to the Dune server via Discord.

### Quick Moderation & Announcements
The bot provides dedicated slash commands for common server management tasks:

* **`/kick <player> [reason]`**: Instantly disconnects a player from the server.
* **`/teleport <player> <x> <y> <z>`**: Moves a player to specific coordinates on the map.
* **`/announce <message>`**: Broadcasts a global message to all players on the server.

### Care Packages (`/carepackage`)
Integrates directly with the RedBlink API to grant preset item bundles.

* **`/carepackage list`**: Lists all configured care packages available on the RedBlink backend.
* **`/carepackage grant <player> <kit>`**: Grants a specific care package to a player.

### Automated Server Broadcasts (`/automessage`)
You can schedule recurring messages (like server rules or Discord links) to broadcast in-game automatically.

* **`/automessage add <interval> <message>`**: Adds a new repeating message. Interval is in minutes.
* **`/automessage list`**: Lists all active automessages and their IDs.
* **`/automessage remove <id>`**: Cancels an active automessage.

### Giving Items (`/giveitem`) - Recommended
Because *Dune: Awakening* servers do not have a native `giveitem` console command, the bot gives items by writing them **directly into the player's inventory table in the PostgreSQL database**.

> [!WARNING]
> Directly modifying the database carries a risk of character data desync or corruption if the player is currently online. To prevent this, the bot implements the following rules:
> 1. **Online Safety Lock**: The bot automatically checks if the player is currently online. If they are, the command is blocked and you are prompted to have the player log out first.
> 2. **Offline Injection**: Once the player logs out, running the command will insert the item directly into their database bag inventory. The items will appear in their bag the next time they log back in.

It features interactive **autocomplete** to assist you:
* **`player`**: Suggests online players first (indicated with `🟢`), then offline players from the database (indicated with `🔴`).
* **`item`**: Suggests from a curated list of game item IDs as you type.
* **`quantity`**: (Optional) The amount of the item to give (defaults to `1`).

```text
/giveitem player: <Select Player> item: <Select Item> [quantity: 50]
```

### Restarting Server Services (`/restart`)

The `/restart` command allows Discord Administrators to restart individual Dune server service containers without needing SSH access. It executes `dune restart <service>` on the host server.

> [!NOTE]
> This command requires `BATTLEGROUP_CMD_PATH` to be set in your `.env` (defaults to `/usr/local/bin/dune`). The bot process must have permission to execute this binary.

#### Available Services

| Choice in Discord | Service Name | Description |
|---|---|---|
| Postgres Database | `postgres` | The PostgreSQL database container |
| RabbitMQ Admin | `rmq-admin` | The RabbitMQ admin interface |
| RabbitMQ Game | `rmq-game` | The RabbitMQ game message broker |
| Text Router | `text-router` | The text routing service |
| Director | `director` | The Dune director service |
| Gateway | `gateway` | The Dune server gateway |
| Survival Server | `survival` | The main survival game server |
| Overmap Server | `overmap` | The overmap game server |

```text
/restart service: <Select Service>
```

*Example:* `/restart service: Gateway`

The bot responds **privately** (visible only to you) with the output of the restart command. A successful restart will show the container ID or a confirmation message. If the container is warming up or the process exits before all status checks complete, the bot will display a `⚠️` warning instead of an error — this is normal for fast-restarting containers.

> [!WARNING]
> Restarting the **Survival Server** or **Gateway** will disconnect all currently online players. It is strongly recommended to announce the restart to players first using:
> ```text
> /cmd command: announce Server Restart | The server will restart in 2 minutes — please log out!
> ```

---

### Checking & Installing Game Server Updates (`/update`)

The `/update` command allows Discord Administrators to check for and install game server updates directly from Discord, without needing SSH access. It uses the `dune` CLI tool on the host server.

> [!NOTE]
> This command requires `BATTLEGROUP_CMD_PATH` to be set in your `.env` (defaults to `/usr/local/bin/dune`). The bot process must have permission to execute this binary.

#### `/update check`
Queries the game server for available updates and reports back the current version and whether a newer version is available. This is a **read-only** operation and is safe to run at any time.

```text
/update check
```

The bot will respond (privately, visible only to you) with the raw output of `dune update check`, showing the current installed version and any available update. This typically completes within **30 seconds**.

#### `/update install`
Downloads and installs the latest available game server update. The bot runs `dune update --yes` (auto-confirming the install prompt) and waits up to **5 minutes** for the process to complete.

```text
/update install
```

> [!WARNING]
> Running `/update install` will update and likely **restart the game server**, disconnecting all currently online players. It is strongly recommended to:
> 1. Use `/update check` first to confirm an update is actually available.
> 2. Announce to players that a restart is imminent before installing (e.g. using `/cmd announce Server update in 5 minutes — please log out!`).

---

## Access Control

All sensitive commands are restricted to members with the **Administrator** permission in your Discord server. This is enforced at the Discord API level — the commands will not even appear in the slash command menu for non-administrator users.

| Command | Restricted | Default Visibility |
|---|---|---|
| `/status` | No | Everyone |
| `/players` | No | Everyone |
| `/cmd` | ✅ Yes | Administrators only |
| `/giveitem` | ✅ Yes | Administrators only |
| `/restart` | ✅ Yes | Administrators only |
| `/update check` | ✅ Yes | Administrators only |
| `/update install` | ✅ Yes | Administrators only |
| `/carepackage` | ✅ Yes | Administrators only |

### Configuring Per-Command Role Access in Discord

Discord lets you override which roles (or individual members) can use each slash command, entirely through the Discord UI — no code changes required.

#### Steps

1. Open your Discord server and go to **Server Settings** (cog icon next to the server name).
2. In the left sidebar, click **Integrations**.
3. Find your bot in the list and click **Manage**.
4. You will see a list of all registered slash commands. Click on a command (e.g. `/restart`) to open its permission settings.
5. Under **Roles & Members**, click **Add roles or members**.
6. Search for and select the role you want to grant access to (e.g. `server-mod`, `server-admin`).
7. Make sure the toggle next to the role is set to ✅ **Allow**.
8. Click **Save**.

Repeat for each command you want to share with additional roles.

> [!IMPORTANT]
> This UI overrides the bot's default visibility, but it does **not** bypass the `Administrator` permission requirement coded into the bot. If a command is set to `Administrator only` in code, the role override in Discord's UI will still let those members **see** the command, and Discord will grant them access to **run** it — this is by design. Discord's integration permissions act as the final authority once you configure them here.

> [!TIP]
> You can also **restrict** commands that are currently public (like `/status` or `/players`) to specific roles only using the same UI — just add the roles you want to allow and toggle off the `@everyone` default.

#### Suggested Role Mapping

Here is a recommended starting point for a typical two-tier moderation setup:

| Command | `server-admin` | `server-mod` |
|---|---|---|
| `/status` | ✅ (already public) | ✅ (already public) |
| `/players` | ✅ (already public) | ✅ (already public) |
| `/cmd announce` | ✅ Allow | ✅ Allow |
| `/cmd kick` / `/cmd kill` | ✅ Allow | ✅ Allow |
| `/restart` | ✅ Allow | ✅ Allow |
| `/giveitem` | ✅ Allow | ❌ Deny |
| `/update check` | ✅ Allow | ✅ Allow |
| `/update install` | ✅ Allow | ❌ Deny |

> [!NOTE]
> Discord's integration UI applies permissions at the **command level**, not the subcommand level. This means you cannot grant `/update check` without also technically granting `/update install` through the same UI toggle. If you need subcommand-level restrictions, those would need to be enforced in the bot code itself.

---

### General Admin Commands (`/cmd <command_name> <arguments>`)
All server commands not covered by dedicated slash commands are treated as generic administrative console commands. The bot parses your input at the **first space** to separate the command name from its arguments, and forwards them directly to the Dune server via RabbitMQ.

> [!CAUTION]
> **Manual `/cmd giveitem` is disabled**: Trying to run `giveitem` via the generic `/cmd` interface will be blocked by the bot, as standard console dispatching for item giving does not work. You must use the dedicated `/giveitem` command instead.

---

## 📱 Dune Server Manager (Android App)

In addition to the Discord Bot, this project includes a companion Android application (`dune-android-app`) built with Kotlin and Jetpack Compose.

The app provides a mobile-friendly dashboard linking directly to the Node.js API:
- **Live Status & Population:** Real-time checking of the database and Docker containers via `docker stats`.
- **Player List:** See exactly who is online, their level, and their faction.
- **Server Controls:** Trigger service restarts or game updates directly from your phone.
- **Emergency Panic:** A dedicated `🚨 PANIC RESTART ALL` button to forcefully restart all server containers when you are away from your PC and need to resolve a critical freeze or issue.
- **Player Maps:** High-resolution interactive maps covering both Deep Desert and Hagga Basin with live player location markers.
