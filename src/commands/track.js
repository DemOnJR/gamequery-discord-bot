'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const shared = require('./shared');
const servers = require('../lib/servers');
const store = require('../lib/store');
const history = require('../lib/history');
const embeds = require('../lib/embeds');
const games = require('../lib/games');

const data = new SlashCommandBuilder()
  .setName('track')
  .setDescription('Choose which game servers this Discord follows')
  .addSubcommand((sub) => sub
    .setName('add')
    .setDescription('Start tracking a server')
    .addStringOption((option) => option
      .setName('game')
      .setDescription('Game the server runs')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('address')
      .setDescription('Server address as ip:port (query port)')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('label')
      .setDescription('Short name to use in channels and graphs')
      .setMaxLength(60)))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Stop tracking a server')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true)))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('Show every server this Discord tracks'))
  .addSubcommand((sub) => sub
    .setName('label')
    .setDescription('Rename a tracked server')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('label')
      .setDescription('New short name')
      .setRequired(true)
      .setMaxLength(60)));

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'game') {
    await shared.gameAutocomplete(interaction);
    return;
  }

  await shared.trackedAutocomplete(interaction);
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    await handleList(interaction);
    return;
  }

  if (!(await shared.requireManager(interaction))) {
    return;
  }

  if (sub === 'add') {
    await handleAdd(interaction);
  } else if (sub === 'remove') {
    await handleRemove(interaction);
  } else if (sub === 'label') {
    await handleLabel(interaction);
  }
}

async function handleAdd(interaction) {
  const gameId = interaction.options.getString('game', true);
  const rawAddress = interaction.options.getString('address', true);
  const label = interaction.options.getString('label');

  if (!games.isValidGame(gameId)) {
    await interaction.reply({
      content: `\`${gameId}\` is not a supported game id. Run \`/games\` to search the ${games.count()} supported games.`,
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

  const plan = await shared.getPlan(interaction);
  const existing = await store.getTracked(interaction.guildId, validation.address);
  const current = await store.countTracked(interaction.guildId);

  if (!existing && current >= plan.limits.trackedServers) {
    await shared.denyWithUpsell(
      interaction,
      `This server tracks ${current} of ${plan.limits.trackedServers} servers allowed on the ${plan.limits.name} plan.`,
      plan
    );
    return;
  }

  const serverId = await servers.ensureTracked(gameId, validation.address);

  const tracked = await store.addTracked({
    guildId: interaction.guildId,
    serverId,
    game: gameId,
    address: validation.address,
    label,
    addedBy: interaction.user.id,
  });

  // Three days of real probes usually already exist for a server the fleet has
  // seen, which makes /graph useful immediately rather than tomorrow.
  const backfilled = serverId ? await history.backfillFromProbeAttempts(serverId, validation.address).catch(() => 0) : 0;
  const snapshot = await servers.getSnapshot(validation.address, gameId);

  const embed = embeds.serverEmbed(snapshot, { game: gameId });
  embed.setAuthor({ name: existing ? 'Updated' : 'Now tracking' });

  const lines = [
    `Refreshing every **${plan.limits.refreshMinutes} min** on the ${plan.limits.name} plan.`,
    backfilled > 0
      ? `Recovered **${backfilled}** existing history points, so \`/graph\` works right now.`
      : 'Player history starts building from this minute.',
    `Next: \`/counter create\` for a live channel, or \`/live status\` for a self-updating message.`,
  ];

  embed.setDescription([embed.data.description, lines.join('\n')].filter(Boolean).join('\n\n'));
  embed.setFooter({ text: `${current + (existing ? 0 : 1)}/${plan.limits.trackedServers} servers tracked - id ${tracked.id}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction) {
  const value = interaction.options.getString('server', true);
  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked) {
    await interaction.reply({
      content: 'No tracked server matched that. Run `/track list` to see what this Discord follows.',
      flags: shared.EPHEMERAL,
    });
    return;
  }

  await store.removeTracked(interaction.guildId, tracked.id);

  await interaction.reply({
    content: `Stopped tracking **${tracked.label || tracked.address}**. Counters, live messages and alerts pointing at it were removed too. Its player history is kept, so re-adding it brings the graph back.`,
    flags: shared.EPHEMERAL,
  });
}

async function handleLabel(interaction) {
  const value = interaction.options.getString('server', true);
  const label = interaction.options.getString('label', true);
  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked) {
    await interaction.reply({ content: 'No tracked server matched that.', flags: shared.EPHEMERAL });
    return;
  }

  await store.setLabel(interaction.guildId, tracked.id, label);

  await interaction.reply({
    content: `\`${tracked.address}\` is now **${label}**.`,
    flags: shared.EPHEMERAL,
  });
}

async function handleList(interaction) {
  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);
  const tracked = await store.listTracked(interaction.guildId);

  if (tracked.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(embeds.COLORS.flat)
      .setTitle('No servers tracked yet')
      .setDescription('Add one with `/track add game:<game> address:<ip:port>`, then everything else in the bot points at it.')
      .setFooter({ text: shared.planFooter(plan) });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));
  const embed = embeds.serverListEmbed(tracked, snapshots, { title: 'Tracked servers' });

  embed.addFields({
    name: 'Plan',
    value: `${tracked.length}/${plan.limits.trackedServers} servers · refresh every ${plan.limits.refreshMinutes} min · ${plan.limits.name}`,
  });

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute, autocomplete };
