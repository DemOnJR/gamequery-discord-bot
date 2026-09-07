'use strict';

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const servers = require('../lib/servers');
const embeds = require('../lib/embeds');
const history = require('../lib/history');
const chart = require('../lib/chart');
const games = require('../lib/games');

const data = new SlashCommandBuilder()
  .setName('live')
  .setDescription('Post a message that keeps updating itself')
  .addSubcommand((sub) => sub
    .setName('status')
    .setDescription('A live card for one tracked server')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post it (defaults to here)')))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('A live board of every tracked server')
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post it (defaults to here)')))
  .addSubcommand((sub) => sub
    .setName('graph')
    .setDescription('A player graph that redraws itself')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('range')
      .setDescription('How far back to plot')
      .addChoices(
        { name: 'Last 24 hours', value: '24h' },
        { name: 'Last 7 days (Pro)', value: '7d' },
        { name: 'Last 30 days (Pro)', value: '30d' },
        { name: 'Last 90 days (Pro)', value: '90d' }
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post it (defaults to here)')))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Stop updating a live message')
    .addStringOption((option) => option
      .setName('message_id')
      .setDescription('Id of the message to stop updating')
      .setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('show')
    .setDescription('List the live messages in this Discord'));

async function autocomplete(interaction) {
  await shared.trackedAutocomplete(interaction);
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'show') {
    await handleShow(interaction);
    return;
  }

  if (!(await shared.requireManager(interaction))) {
    return;
  }

  if (sub === 'status') {
    await handleStatus(interaction);
  } else if (sub === 'list') {
    await handleList(interaction);
  } else if (sub === 'graph') {
    await handleGraph(interaction);
  } else if (sub === 'remove') {
    await handleRemove(interaction);
  }
}

function targetChannel(interaction) {
  return interaction.options.getChannel('channel') || interaction.channel;
}

function canPostIn(interaction, channel) {
  const me = interaction.guild.members.me;

  if (!me || !channel || typeof channel.permissionsFor !== 'function') {
    return false;
  }

  const permissions = channel.permissionsFor(me);

  return Boolean(permissions
    && permissions.has(PermissionFlagsBits.ViewChannel)
    && permissions.has(PermissionFlagsBits.SendMessages)
    && permissions.has(PermissionFlagsBits.EmbedLinks));
}

async function checkSlot(interaction, plan) {
  const current = await store.countStatusMessages(interaction.guildId);

  if (current >= plan.limits.statusMessages) {
    await shared.denyWithUpsell(
      interaction,
      `This Discord already has ${current} of the ${plan.limits.statusMessages} live messages allowed on the ${plan.limits.name} plan.`,
      plan
    );
    return false;
  }

  return true;
}

async function handleStatus(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!(await checkSlot(interaction, plan))) {
    return;
  }

  const tracked = await shared.resolveTracked(interaction, interaction.options.getString('server', true));

  if (!tracked) {
    await interaction.editReply('No tracked server matched that. Add one with `/track add`.');
    return;
  }

  const channel = targetChannel(interaction);

  if (!canPostIn(interaction, channel)) {
    await interaction.editReply(`I need View Channel, Send Messages and Embed Links in ${channel}.`);
    return;
  }

  const snapshot = await servers.getSnapshot(tracked.address, tracked.game);
  const embed = embeds.serverEmbed(snapshot, { game: tracked.game });
  embed.setFooter({ text: `Updates every ${plan.limits.refreshMinutes} min - gamequery.dev` });

  const message = await channel.send({ embeds: [embed] });

  await store.addStatusMessage({
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: message.id,
    trackedServerId: tracked.id,
    mode: 'status',
  });

  await interaction.editReply(
    `Posted a live card in ${channel}. It rewrites itself every **${plan.limits.refreshMinutes} min**`
    + `${plan.isPro ? '' : ', or every 2 min on Pro'}. Stop it with \`/live remove message_id:${message.id}\`.`
  );
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!(await checkSlot(interaction, plan))) {
    return;
  }

  const tracked = await store.listTracked(interaction.guildId);

  if (tracked.length === 0) {
    await interaction.editReply('Track a server first with `/track add`.');
    return;
  }

  const channel = targetChannel(interaction);

  if (!canPostIn(interaction, channel)) {
    await interaction.editReply(`I need View Channel, Send Messages and Embed Links in ${channel}.`);
    return;
  }

  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));
  const embed = embeds.serverListEmbed(tracked, snapshots, {
    title: `${interaction.guild.name} servers`,
  });

  const message = await channel.send({ embeds: [embed] });

  await store.addStatusMessage({
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: message.id,
    trackedServerId: null,
    mode: 'list',
  });

  await interaction.editReply(
    `Posted a live board in ${channel}, covering every server this Discord tracks. `
    + `Stop it with \`/live remove message_id:${message.id}\`.`
  );
}

/*
  A graph message is redrawn on every refresh, which means re-uploading the PNG
  and clearing the previous attachment. buildGraphMessage is shared with the
  refresher so the message posted here and the message written five minutes
  later are produced by exactly one piece of code.
*/
async function buildGraphMessage(tracked, snapshot, rangeKey, plan) {
  const [series, stats] = await Promise.all([
    history.getSeries(tracked.server_id, rangeKey),
    history.getStats(tracked.server_id, rangeKey),
  ]);

  const range = history.getRange(rangeKey);
  const title = tracked.label || (snapshot && snapshot.name) || tracked.address;
  const fileName = `players-${rangeKey}.png`;

  const png = chart.renderPlayerChart(
    [{ label: title, points: series.points }],
    {
      title,
      subtitle: `${games.gameName(tracked.game)} \u00b7 ${tracked.address}`,
      rangeKey,
      rangeLabel: range ? range.label : rangeKey,
      capacity: snapshot ? snapshot.maxPlayers : null,
      footer: stats
        ? `Average ${stats.avgPlayers.toFixed(1)} \u00b7 peak ${stats.peakPlayers} \u00b7 reachable ${stats.uptimePercent.toFixed(1)}% of checks`
        : 'History is still building.',
    }
  );

  const embed = new EmbedBuilder()
    .setColor(embeds.statusColor(snapshot))
    .setTitle(`${embeds.statusDot(snapshot)} ${title}`.slice(0, 250))
    .setDescription(`**${embeds.playersText(snapshot)}** players right now \u00b7 ${range ? range.label : rangeKey}`)
    .setImage(`attachment://${fileName}`)
    .setFooter({ text: `Redraws every ${plan.limits.refreshMinutes} min - gamequery.dev` })
    .setTimestamp(new Date());

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(png, { name: fileName })],
    // Without this the old image stays attached and the embed keeps pointing
    // at the first upload, so the picture never actually changes.
    attachments: [],
  };
}

async function handleGraph(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!(await checkSlot(interaction, plan))) {
    return;
  }

  const rangeKey = interaction.options.getString('range') || '24h';

  if (!plan.limits.graphRanges.includes(rangeKey)) {
    const range = history.getRange(rangeKey);
    await shared.denyWithUpsell(
      interaction,
      `The ${range ? range.label.toLowerCase() : rangeKey} range is a Pro range. The Free plan plots the last 24 hours.`,
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, interaction.options.getString('server', true));

  if (!tracked) {
    await interaction.editReply('No tracked server matched that. Add one with `/track add`.');
    return;
  }

  if (!tracked.server_id) {
    await interaction.editReply('That server is not registered with the query fleet yet. Re-add it with `/track add`.');
    return;
  }

  const channel = targetChannel(interaction);

  if (!canPostIn(interaction, channel)) {
    await interaction.editReply(`I need View Channel, Send Messages and Embed Links in ${channel}.`);
    return;
  }

  const me = interaction.guild.members.me;
  const permissions = channel.permissionsFor(me);

  if (!permissions || !permissions.has(PermissionFlagsBits.AttachFiles)) {
    await interaction.editReply(`I need the Attach Files permission in ${channel} to post a graph.`);
    return;
  }

  const snapshot = await servers.getSnapshot(tracked.address, tracked.game);
  const payload = await buildGraphMessage(tracked, snapshot, rangeKey, plan);
  const message = await channel.send(payload);

  await store.addStatusMessage({
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: message.id,
    trackedServerId: tracked.id,
    mode: 'graph',
    graphRange: rangeKey,
  });

  await interaction.editReply(
    `Posted a self-redrawing graph in ${channel}. It redraws every **${plan.limits.refreshMinutes} min**`
    + `${plan.isPro ? '' : ', or every 2 min on Pro'}. Stop it with \`/live remove message_id:${message.id}\`.`
  );
}

async function handleRemove(interaction) {
  const messageId = interaction.options.getString('message_id', true).trim();
  const removed = await store.removeStatusMessage(interaction.guildId, messageId);

  await interaction.reply({
    content: removed
      ? 'Stopped updating that message. It stays in the channel showing its last values; delete it yourself if you want it gone.'
      : 'No live message with that id in this Discord. Run `/live show` to see the ids.',
    flags: shared.EPHEMERAL,
  });
}

async function handleShow(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);
  const messages = await store.listStatusMessages(interaction.guildId);

  if (messages.length === 0) {
    await interaction.editReply('No live messages yet. Create one with `/live status` or `/live list`.');
    return;
  }

  const lines = messages.map((row) => {
    const scope = row.tracked_server_id ? (row.label || row.address) : 'all tracked servers';
    const last = row.last_updated_at ? embeds.relativeTime(new Date(row.last_updated_at)) : 'not yet';
    return `<#${row.channel_id}> · ${row.mode} · ${scope}\n \`${row.message_id}\` · updated ${last}`;
  });

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('Live messages')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: `${messages.length}/${plan.limits.statusMessages} used - ${plan.limits.name}` });

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute, autocomplete, buildGraphMessage };
