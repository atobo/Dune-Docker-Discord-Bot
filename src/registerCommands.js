require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Try loading addon-data config
const addonConfigPath = '/app/addon-data/config.json';
if (fs.existsSync(addonConfigPath)) {
  try {
    const addonConfig = JSON.parse(fs.readFileSync(addonConfigPath, 'utf8'));
    Object.assign(process.env, addonConfig);
    console.log('[Init] Loaded configuration from RedBlink Addon storage.');
  } catch (err) {
    console.error('[Init] Failed to parse addon config:', err.message);
  }
}

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Get the current status of the self-hosted Dune server'),

  new SlashCommandBuilder()
    .setName('players')
    .setDescription('List all online players currently on the Dune server'),

  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Send an administrative command to the Dune server')
    .addStringOption(option =>
      option.setName('command')
        .setDescription('The command to run (e.g. announce "Hello", kick player)')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restrict to Admins

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a player from the server')
    .addStringOption(option =>
      option.setName('player')
        .setDescription('The name of the player to kick')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Optional reason for kicking')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('teleport')
    .setDescription('Teleport a player to specific coordinates')
    .addStringOption(option =>
      option.setName('player')
        .setDescription('The player to teleport')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addNumberOption(option =>
      option.setName('x')
        .setDescription('X coordinate')
        .setRequired(true)
    )
    .addNumberOption(option =>
      option.setName('y')
        .setDescription('Y coordinate')
        .setRequired(true)
    )
    .addNumberOption(option =>
      option.setName('z')
        .setDescription('Z coordinate')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Send a global announcement to the game server')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to announce')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Send a chat message to the game server map chat')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The chat message to send')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('automessage')
    .setDescription('Manage automated server broadcasts')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a new automessage')
        .addIntegerOption(option =>
          option.setName('interval')
            .setDescription('Interval in minutes')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption(option =>
          option.setName('message')
            .setDescription('The message to broadcast')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all active automessages')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove an automessage by ID')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('The ID of the automessage to remove')
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('giveitem')
    .setDescription('Give an item to a player on the server')
    .addStringOption(option =>
      option.setName('player')
        .setDescription('The player to receive the item')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('item')
        .setDescription('The item ID to give')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option.setName('quantity')
        .setDescription('The quantity to give (defaults to 1)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restrict to Admins

  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart a Dune server service container')
    .addStringOption(option =>
      option.setName('service')
        .setDescription('The service to restart')
        .setRequired(true)
        .addChoices(
          { name: 'Postgres Database', value: 'postgres' },
          { name: 'RabbitMQ Admin', value: 'rmq-admin' },
          { name: 'RabbitMQ Game', value: 'rmq-game' },
          { name: 'Text Router', value: 'text-router' },
          { name: 'Director', value: 'director' },
          { name: 'Gateway', value: 'gateway' },
          { name: 'Survival Server', value: 'survival' },
          { name: 'Overmap Server', value: 'overmap' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restrict to Admins

  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Check or install game server updates')
    .addSubcommand(subcommand =>
      subcommand
        .setName('check')
        .setDescription('Check if a game server update is available')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('install')
        .setDescription('Download and install the latest game update')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Restrict to Admins

  new SlashCommandBuilder()
    .setName('carepackage')
    .setDescription('Manage RedBlink Care Packages')
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all available Care Packages configured in RedBlink')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('grant')
        .setDescription('Grant a specific Care Package to a player')
        .addStringOption(option =>
          option.setName('player')
            .setDescription('The name of the player to receive the care package')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption(option =>
          option.setName('kit')
            .setDescription('The ID of the care package kit to grant')
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    if (process.env.GUILD_ID) {
      // Register for specific guild (instant update, recommended for testing/dev)
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands },
      );
      console.log(`Successfully reloaded (/) commands for guild ${process.env.GUILD_ID}.`);
    } else {
      // Register globally (takes up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log('Successfully reloaded (/) commands globally.');
    }
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();
