require('dotenv').config();
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Restrict to Admins
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
