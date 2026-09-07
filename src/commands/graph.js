'use strict';

const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const servers = require('../lib/servers');
const history = require('../lib/history');
const chart = require('../lib/chart');
const embeds = require('../lib/embeds');
const games = require('../lib/games');

const RANGE_CHOICES = [
  { name: 'Last 24 hours', value: '24h' },
  { name: 'Last 7 days (Pro)', value: '7d' },
  { name: 'Last 30 days (Pro)', value: '30d' },
  { name: 'Last 90 days (Pro)', value: '90d' },
];

const data = new SlashCommandBuilder()
  .setName('graph')
  .setDescription('Plot player counts over time')
  .addSubcommand((sub) => sub
    .setName('players')
    .setDescription('Player count over time for one tracked server')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('range')
      .setDescription('How far back to plot')
      .addChoices(...RANGE_CHOICES)))
  .addSubcommand((sub) => sub
    .setName('compare')
    .setDescription('Plot several tracked servers on one chart (Pro)')
    .addStringOption((option) => option
      .setName('range')
      .setDescription('How far back to plot')
      .addChoices(...RANGE_CHOICES)))
  .addSubcommand((sub) => sub
    .setName('peak')
    .setDescription('Average players by hour of day, so you know when to schedule (Pro)')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addIntegerOption((option) => option
      .setName('days')
      .setDescription('How many days to average over (default 14)')
      .setMinValue(2)
      .setMaxValue(90)));

async function autocomplete(interaction) {
  await shared.trackedAutocomplete(interaction);
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'players') {
    await handlePlayers(interaction);
  } else if (sub === 'compare') {
    await handleCompare(interaction);
  } else if (sub === 'peak') {
    await handlePeak(interaction);
  }
}

function rangeLabel(rangeKey) {
  const range = history.getRange(rangeKey);
  return range ? range.label : rangeKey;
}

async function handlePlayers(interaction) {
  const value = interaction.options.getString('server', true);
  const requestedRange = interaction.options.getString('range') || '24h';

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);

  if (!plan.limits.graphRanges.includes(requestedRange)) {
    await shared.denyWithUpsell(
      interaction,
      `The **${rangeLabel(requestedRange)}** graph is a Pro range. The Free plan plots the last 24 hours.`,
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked) {
    await interaction.editReply('No tracked server matched that. Add one with `/track add`.');
    return;
  }

  if (!tracked.server_id) {
    await interaction.editReply('That server has not been registered with the query fleet yet. Re-add it with `/track add`.');
    return;
  }

  const [series, stats, snapshot] = await Promise.all([
    history.getSeries(tracked.server_id, requestedRange),
    history.getStats(tracked.server_id, requestedRange),
    servers.getSnapshot(tracked.address, tracked.game),
  ]);

  const title = tracked.label || (snapshot && snapshot.name) || tracked.address;

  const png = chart.renderPlayerChart(
    [{ label: title, points: series.points }],
    {
      title,
      subtitle: `${games.gameName(tracked.game)} · ${tracked.address}`,
      rangeKey: requestedRange,
      rangeLabel: rangeLabel(requestedRange),
      capacity: snapshot ? snapshot.maxPlayers : null,
      footer: stats
        ? `Average ${stats.avgPlayers.toFixed(1)} · peak ${stats.peakPlayers} · reachable ${stats.uptimePercent.toFixed(1)}% of checks`
        : 'History is still building.',
    }
  );

  const attachment = new AttachmentBuilder(png, { name: `players-${requestedRange}.png` });
  const embed = new EmbedBuilder()
    .setColor(embeds.statusColor(snapshot))
    .setTitle(`${embeds.statusDot(snapshot)} ${title}`.slice(0, 250))
    .setDescription(`**${embeds.playersText(snapshot)}** players right now · ${rangeLabel(requestedRange)}`)
    .setImage(`attachment://players-${requestedRange}.png`)
    .setFooter({ text: shared.planFooter(plan) });

  if (stats) {
    embed.addFields(
      { name: 'Average', value: stats.avgPlayers.toFixed(1), inline: true },
      { name: 'Peak', value: String(stats.peakPlayers), inline: true },
      { name: 'Reachable', value: `${stats.uptimePercent.toFixed(1)}%`, inline: true }
    );
  }

  if (!plan.isPro) {
    embed.addFields({
      name: 'Pro',
      value: 'Adds 7d, 30d and 90d ranges, multi-server comparison and peak-hour profiles.',
    });
  }

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}

async function handleCompare(interaction) {
  const requestedRange = interaction.options.getString('range') || '24h';

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);

  if (!plan.isPro) {
    await shared.denyWithUpsell(
      interaction,
      'Putting several servers on one chart is a Pro feature.',
      plan
    );
    return;
  }

  if (!plan.limits.graphRanges.includes(requestedRange)) {
    await shared.denyWithUpsell(interaction, `The ${rangeLabel(requestedRange)} range is not available on this plan.`, plan);
    return;
  }

  const tracked = (await store.listTracked(interaction.guildId))
    .filter((row) => row.server_id)
    .slice(0, plan.limits.compareServers);

  if (tracked.length < 2) {
    await interaction.editReply('Track at least two servers before comparing them.');
    return;
  }

  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));

  const seriesList = await Promise.all(
    tracked.map(async (row) => {
      const series = await history.getSeries(row.server_id, requestedRange);
      const snapshot = snapshots.get(row.address);
      return {
        label: row.label || (snapshot && snapshot.name) || row.address,
        points: series.points,
      };
    })
  );

  const png = chart.renderPlayerChart(seriesList, {
    title: `${tracked.length} servers compared`,
    subtitle: interaction.guild ? interaction.guild.name : '',
    rangeKey: requestedRange,
    rangeLabel: rangeLabel(requestedRange),
  });

  const attachment = new AttachmentBuilder(png, { name: `compare-${requestedRange}.png` });
  const embed = embeds.serverListEmbed(tracked, snapshots, { title: 'Compared' })
    .setImage(`attachment://compare-${requestedRange}.png`);

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}

async function handlePeak(interaction) {
  const value = interaction.options.getString('server', true);
  const days = interaction.options.getInteger('days') || 14;

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);

  if (!plan.isPro) {
    await shared.denyWithUpsell(
      interaction,
      'The peak-hour profile is a Pro feature. It answers "what time should we schedule the event" from your own server history.',
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked || !tracked.server_id) {
    await interaction.editReply('No tracked server matched that.');
    return;
  }

  const profile = await history.getHourOfDayProfile(tracked.server_id, days);
  const title = tracked.label || tracked.address;

  const png = chart.renderHourProfile(profile, {
    title: `${title} - players by hour`,
    subtitle: `${games.gameName(tracked.game)} · ${tracked.address}`,
    rangeLabel: `Averaged over ${days} days, UTC`,
  });

  const attachment = new AttachmentBuilder(png, { name: 'peak-hours.png' });
  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle(`${title} - busiest hours`)
    .setImage('attachment://peak-hours.png')
    .setFooter({ text: 'Pro · gamequery.dev' });

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}

module.exports = { data, execute, autocomplete };
