# Dune Server Discord Bot

A Discord bot designed to connect a Discord server with a self-hosted **Dune: Awakening** game server (running on Ubuntu via Docker/Dune Docker Console).

## Features

1. **Server Status (`/status`)**: Live check of the server status and database connectivity.
2. **Player List (`/players`)**: Lists online players with name, level, and faction directly from the PostgreSQL database (using dynamic table mapping).
3. **Send Commands (`/cmd <command>`)**: Sends administrative console commands (such as `announce`, `kick`, `kill`, `giveitem`) to the game server via RabbitMQ or docker-exec CLI. Restricted to Discord Administrators.
4. **Two-Way Chat Relay**: Relays messages written in a specific Discord channel straight to the game server as announcements.
5. **Real-time Event Alerts**: Automatically tails the server logs to announce player joins, departures, and sandstorms to Discord in real-time.

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

### 1. Install Dependencies
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

### Sending Announcements (`/cmd announce`)
The `/cmd` slash command accepts a single `command` string parameter. For the `announce` command, the bot supports the following syntax options:

#### 1. Basic Announcement (Default Title & Duration)
Broadcasts a message with the default title **"Admin Broadcast"** and displays it on-screen for **30 seconds**.
```text
/cmd command: announce Your message goes here
```
*Example:* `/cmd command: announce Welcome to the server!`

#### 2. Custom Title & Duration
Customize the title and display duration by separating the arguments using pipe (`|`) characters:
```text
/cmd command: announce <Title> | <Message> | [Duration in seconds]
```
* **Custom Title & Default Duration:**
  ```text
  /cmd command: announce Server Warning | A sandstorm is approaching!
  ```
* **Custom Title & Custom Duration:**
  ```text
  /cmd command: announce PvP Event | The Arena is now open! | 60
  ```

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

### General Admin Commands (`/cmd <command_name> <arguments>`)
All server commands other than `announce` are treated as generic administrative console commands. The bot parses your input at the **first space** to separate the command name from its arguments, and forwards them directly to the Dune server.

> [!CAUTION]
> **Manual `/cmd giveitem` is disabled**: Trying to run `giveitem` via the generic `/cmd` interface will be blocked by the bot, as standard console dispatching for item giving does not work. You must use the dedicated `/giveitem` command instead.

#### Other Examples (Kick, Kill, etc.)
* **Kick a player:**
  ```text
  /cmd command: kick JohnDoe
  ```
* **Kill a player:**
  ```text
  /cmd command: kill JohnDoe
  ```
