(function () {
  const form = document.getElementById("config-form");
  const tokenInput = document.getElementById("discord-token");
  const clientIdInput = document.getElementById("client-id");
  const guildIdInput = document.getElementById("guild-id");
  const rabbitmqUrlInput = document.getElementById("rabbitmq-url");
  const channelIdInput = document.getElementById("channel-id");
  
  // Playtime Rewards controls
  const playtimeIntervalInput = document.getElementById("playtime-interval");
  const playtimeIntervalVal = document.getElementById("playtime-interval-val");
  const playtimeDistanceInput = document.getElementById("playtime-distance");
  const playtimeDistanceVal = document.getElementById("playtime-distance-val");
  const playtimeXpInput = document.getElementById("playtime-xp");
  const playtimeXpVal = document.getElementById("playtime-xp-val");

  const saveBtn = document.getElementById("save-btn");
  const statusMsg = document.getElementById("status-message");
  const setupGuideCard = document.getElementById("setup-guide-card");
  const showGuideBtn = document.getElementById("show-guide-btn");
  const hideGuideBtn = document.getElementById("hide-guide-btn");

  // Sync slider label values on drag
  playtimeIntervalInput.addEventListener("input", (e) => { playtimeIntervalVal.textContent = e.target.value; });
  playtimeDistanceInput.addEventListener("input", (e) => { playtimeDistanceVal.textContent = e.target.value; });
  playtimeXpInput.addEventListener("input", (e) => { playtimeXpVal.textContent = e.target.value; });

  showGuideBtn.addEventListener("click", () => {
    setupGuideCard.style.display = "block";
    showGuideBtn.style.display = "none";
  });
  
  hideGuideBtn.addEventListener("click", () => {
    setupGuideCard.style.display = "none";
    showGuideBtn.style.display = "inline-block";
  });

  function showMessage(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.className = isError ? "error" : "success";
    setTimeout(() => { statusMsg.textContent = ""; }, 5000);
  }

  const placeholderToken = "••••••••••••";
  let tokenConfigured = false;

  async function loadConfig() {
    try {
      if (window.parent === window) {
        console.warn("Running outside of Dune Console. Using mock config.");
        return;
      }
      // Read config from the database
      let config = null;
      try {
        const result = await window.DuneAddon.request("database.query", {
          query: "SELECT config_value FROM dune.discord_bot_config WHERE config_key = 'main'"
        });
        
        if (result && result.length > 0 && result[0].config_value) {
          config = typeof result[0].config_value === 'string' 
            ? JSON.parse(result[0].config_value) 
            : result[0].config_value;
        }
      } catch (dbErr) {
        console.warn("Could not read config from database (table might not exist yet).");
      }

      // Check token status from backend
      try {
        const res = await fetch(`http://${window.location.hostname}:3005/api/config`);
        const data = await res.json();
        if (data && data.success && data.configured) {
          tokenConfigured = true;
        }
      } catch (err) {
        console.warn("Failed to contact bot backend to check token status. Assuming not configured.", err);
      }

      if (config || tokenConfigured) {
        tokenInput.value = tokenConfigured ? placeholderToken : "";
        clientIdInput.value = (config && config.CLIENT_ID) || "";
        guildIdInput.value = (config && config.GUILD_ID) || "";
        rabbitmqUrlInput.value = (config && config.RABBITMQ_URL) || "amqp://guest:guest@rabbitmq:5672";
        channelIdInput.value = (config && config.CHANNEL_ID) || "";
        
        // Load playtime values
        playtimeIntervalInput.value = (config && config.PLAYTIME_INTERVAL) !== undefined ? config.PLAYTIME_INTERVAL : 60;
        playtimeIntervalVal.textContent = playtimeIntervalInput.value;
        playtimeDistanceInput.value = (config && config.PLAYTIME_DISTANCE) !== undefined ? config.PLAYTIME_DISTANCE : 10;
        playtimeDistanceVal.textContent = playtimeDistanceInput.value;
        playtimeXpInput.value = (config && config.PLAYTIME_XP) !== undefined ? config.PLAYTIME_XP : 1;
        playtimeXpVal.textContent = playtimeXpInput.value;

        if (!tokenConfigured) {
          setupGuideCard.style.display = "block";
        } else {
          showGuideBtn.style.display = "inline-block";
        }
      } else {
        setupGuideCard.style.display = "block";
      }
    } catch (err) {
      console.error("Failed to load config:", err);
    }
  }

  async function saveConfig(e) {
    e.preventDefault();
    saveBtn.disabled = true;
    
    const newConfig = {
      CLIENT_ID: clientIdInput.value.trim(),
      GUILD_ID: guildIdInput.value.trim(),
      RABBITMQ_URL: rabbitmqUrlInput.value.trim(),
      CHANNEL_ID: channelIdInput.value.trim(),
      PLAYTIME_INTERVAL: parseInt(playtimeIntervalInput.value) || 60,
      PLAYTIME_DISTANCE: parseFloat(playtimeDistanceInput.value) !== NaN ? parseFloat(playtimeDistanceInput.value) : 10,
      PLAYTIME_XP: parseInt(playtimeXpInput.value) !== NaN ? parseInt(playtimeXpInput.value) : 1
    };

    const tokenValue = tokenInput.value.trim();
    const shouldSaveToken = tokenValue && tokenValue !== placeholderToken;

    try {
      if (window.parent === window) {
        console.warn("Running outside of Dune Console. Mock save successful.");
        showMessage("Configuration saved (mock).");
      } else {
        // Ensure table exists
        await window.DuneAddon.request("database.execute", {
          query: `
            CREATE TABLE IF NOT EXISTS dune.discord_bot_config (
              config_key VARCHAR(255) PRIMARY KEY,
              config_value JSONB
            )
          `
        });

        // Upsert the configuration
        const configStr = JSON.stringify(newConfig).replace(/'/g, "''");
        await window.DuneAddon.request("database.execute", {
          query: `
            INSERT INTO dune.discord_bot_config (config_key, config_value)
            VALUES ('main', '${configStr}'::jsonb)
            ON CONFLICT (config_key) DO UPDATE SET config_value = '${configStr}'::jsonb
          `
        });

        // Save token to backend if it was modified
        if (shouldSaveToken) {
          const res = await fetch(`http://${window.location.hostname}:3005/api/config`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token: tokenValue })
          });
          const data = await res.json();
          if (!data || !data.success) {
            throw new Error(data.error || "Failed to save Discord Bot Token to host storage.");
          }
          tokenConfigured = true;
          tokenInput.value = placeholderToken;
        }

        showMessage("Configuration saved successfully.");
      }
    } catch (err) {
      showMessage(err.message || "Failed to save configuration.", true);
    } finally {
      saveBtn.disabled = false;
    }
  }

  form.addEventListener("submit", saveConfig);
  loadConfig();
})();
