# Dune Discord Bot & Android App Feature Ideas

*Updated after reviewing the [Red-Blink Dune Docker Console](https://github.com/Red-Blink/dune-awakening-selfhost-docker) capabilities!*

Since the Red-Blink web console already handles the heavy lifting (Backups, Map Management, Logs, full Database browsing, etc.), our Discord bot and Android app should focus on **quick remote actions** and **community integrations** that complement the web UI rather than duplicating it.

---

## 🪐 Discord Bot Feature Ideas

### 1. 🎁 Care Package Commands (Integration) ✅ [COMPLETED]
* **Description:** Expose RedBlink's "Care Packages" feature to Discord.
* **Commands:** `/carepackage list` and `/carepackage grant <player> <kit>`
* **Use Case:** Admins can quickly drop starter kits or event rewards to players while chatting with them in Discord without opening the full web panel.

### 2. 🛡️ Quick Moderation Tools ✅ [COMPLETED]
* **Description:** Direct moderation actions hooked into the existing RedBlink systems.
* **Commands:** `/kick <player> [reason]`, `/teleport <player> <x> <y> <z>`
* **Use Case:** Swift response to rule-breakers or stuck players reported via Discord tickets.

### 3. 📢 Automated Server Broadcasts ✅ [COMPLETED]
* **Description:** A system that periodically sends server tips or Discord invite links to the in-game global chat using our existing RabbitMQ setup.
* **Command:** `/automessage add <interval> <message>`

### 4. 🧩 Convert Bot into an Official RedBlink "Addon" ✅ [COMPLETED]
* **Description:** Use the [Red-Blink Addon Template](https://github.com/Red-Blink/dune-docker-addon-template) to package our Node.js Discord bot.
* **Use Case:** This would allow the bot to be installed, enabled, and configured directly from the RedBlink Web UI's "Community Addons" tab!

---

## 📱 Dune Android App Feature Ideas

### 1. 👥 Live Player Map & Status ✅ [COMPLETED]
* **Description:** Since RedBlink tracks online activity and map markers, we could pull this data into a native Android Google Map view.
* **Use Case:** See exactly where players are clustering on your phone.

### 2. ⚡ "Panic" Server Controls ✅ [COMPLETED]
* **Description:** Simple, big buttons on the Android app to quickly Stop, Start, or Restart the Autoscaler/Servers if things go wrong while you are away from your PC.

### 3. 📈 Live Memory / Autoscaler Widget ✅ [COMPLETED]
* **Description:** Since Dune map servers require intense RAM management, add a widget to the Android app showing current Memory Balancer status and RAM usage.
* **Use Case:** Keep an eye on server health and see if the autoscaler is spinning up too many dynamic maps.
