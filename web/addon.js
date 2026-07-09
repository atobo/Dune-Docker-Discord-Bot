(function () {
  const form = document.getElementById("config-form");
  const tokenInput = document.getElementById("discord-token");
  const clientIdInput = document.getElementById("client-id");
  const guildIdInput = document.getElementById("guild-id");
  const rabbitmqUrlInput = document.getElementById("rabbitmq-url");
  const saveBtn = document.getElementById("save-btn");
  const statusMsg = document.getElementById("status-message");
  const setupGuideCard = document.getElementById("setup-guide-card");
  const showGuideBtn = document.getElementById("show-guide-btn");
  const hideGuideBtn = document.getElementById("hide-guide-btn");

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

      if (config) {
        tokenInput.value = config.DISCORD_TOKEN || "";
        clientIdInput.value = config.CLIENT_ID || "";
        guildIdInput.value = config.GUILD_ID || "";
        rabbitmqUrlInput.value = config.RABBITMQ_URL || "amqp://guest:guest@rabbitmq:5672";
        
        if (!config.DISCORD_TOKEN) {
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
      DISCORD_TOKEN: tokenInput.value.trim(),
      CLIENT_ID: clientIdInput.value.trim(),
      GUILD_ID: guildIdInput.value.trim(),
      RABBITMQ_URL: rabbitmqUrlInput.value.trim(),
    };

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
