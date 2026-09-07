'use strict';

const { SlashCommandBuilder } = require('discord.js');
const shared = require('./shared');
const servers = require('../lib/servers');
const store = require('../lib/store');
const history = require('../lib/history');
const embeds = require('../lib/embeds');
const games = require('../lib/games');

const data = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Query a game server and show who is on it right now')
  .addStringOption((option) => option
    .setName('game')
    .setDescription('Game the server runs')
    .setRequired(true)
    .setAutocomplete(true))
  .addStringOption((option) => option
    .setName('address')
    .setDescription('Server address as ip:port (query port)')
    .setRequired(true));

async function autocomplete(interaction) {
  await shared.gameAutocomplete(interaction);
}

async function execute(interaction) {
  const gameId = interaction.options.getString('game', true);
  const rawAddress = interaction.options.getString('address', true);

  if (!games.isValidGame(gameId)) {
    await interaction.reply({
      content: `\`${gameId}\` is not a supported game id. Use the autocomplete, or run \`/games\` to search the ${games.count()} supported games.`,
      flags: shared.EPHEMERAL,
    });
    return;
  }

  const validation = servers.validateAddress(rawAddress);
  if (!validation.ok) {
    await interaction.reply({ content: validation.reason, flags: shared.EPHEMERAL });
    return;
  }

  await interaction.deferReply();

  const { address } = validation;
  const snapshot = await servers.getSnapshot(address, gameId);
  let note = null;

  /*
    An address nobody has asked about before has no cached payload. Registering
    it here is the whole point of the command being free: the fleet starts
    probing it, and the next /server call has real data.
  */
  if (!snapshot || !snapshot.known) {
    const serverId = await servers.ensureTracked(gameId, address);

    if (serverId) {
      await history.backfillFromProbeAttempts(serverId, address).catch(() => 0);
    }

    note = 'This server was not being watched yet, so it has just been queued. Run the command again in a minute or two.';
  }

  const fresh = snapshot && snapshot.known ? snapshot : await servers.getSnapshot(address, gameId);
  fresh.game = fresh.game || gameId;

  const embed = embeds.serverEmbed(fresh, { game: gameId, note });

  if (interaction.inGuild()) {
    const tracked = await store.getTracked(interaction.guildId, address);
    embed.setFooter({
      text: tracked
        ? `Tracked in this server - /graph ${tracked.label || tracked.address}`
        : `${address} - track it with /track add to unlock graphs and counters`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute, autocomplete };
