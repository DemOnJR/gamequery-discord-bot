'use strict';

/*
  Registers the slash commands without starting the bot. The bot also does this
  on boot; this script exists so a command signature can be pushed (or a
  guild-scoped test copy installed, which propagates instantly rather than in
  up to an hour) without a redeploy.

  Usage:
    node src/registerCommands.js            register globally
    node src/registerCommands.js <guildId>  register to one guild, for testing
*/

const { REST, Routes } = require('discord.js');
const config = require('./config');
const commands = require('./commands');

async function main() {
  if (!config.token || !config.clientId) {
    console.error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must both be set.');
    process.exit(1);
  }

  const guildId = process.argv[2];
  const payload = commands.toJSON();
  const rest = new REST({ version: '10' }).setToken(config.token);

  const route = guildId
    ? Routes.applicationGuildCommands(config.clientId, guildId)
    : Routes.applicationCommands(config.clientId);

  const result = await rest.put(route, { body: payload });

  console.log(`Registered ${result.length} commands ${guildId ? `to guild ${guildId}` : 'globally'}:`);
  result.forEach((command) => console.log(` /${command.name}`));
}

main().catch((error) => {
  console.error('Registration failed:', error.message);
  process.exit(1);
});
