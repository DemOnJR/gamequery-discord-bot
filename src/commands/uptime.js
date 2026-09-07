'use strict';

const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const servers = require('../lib/servers');
const history = require('../lib/history');
const chart = require('../lib/chart');
const embeds = require('../lib/embeds');
const games = require('../lib/games');

/*
  Availability, which is a different product from the player graph.

  A community wants to know when people are online; a hosting provider or a
  server owner wants to know whether the box answered, and for how much of the
  window it did not. Both come from the same samples, so this costs nothing
  extra to collect, but they answer different questions and deserve separate
  commands rather than one chart trying to do both.
*/

const RANGE_CHOICES = [
  { name: 'Last 24 hours', value: '24h' },
  { name: 'Last 7 days (Pro)', value: '7d' },
  { name: 'Last 30 days (Pro)', value: '30d' },
  { name: 'Last 90 days (Pro)', value: '90d' },
];

const data = new SlashCommandBuilder()
  .setName('uptime')
  .setDescription('Availability over time for a tracked server')
  .addStringOption((option) => option
    .setName('server')
    .setDescription('Tracked server')
    .setRequired(true)
    .setAutocomplete(true))
  .addStringOption((option) => option
    .setName('range')
    .setDescription('How far back to measure')
    .addChoices(...RANGE_CHOICES));

async function autocomplete(interaction) {
  await shared.trackedAutocomplete(interaction);
}

/*
  Groups consecutive down buckets into incidents. "Four outages totalling 20
  minutes" is a fact somebody can act on; "94.65% uptime" on its own is not,
  because it hides whether that was one long outage or constant flapping.
*/
function findIncidents(points) {
  const incidents = [];
  let current = null;

  points.forEach((point) => {
    const down = point.uptime !== null && point.uptime !== undefined && point.uptime < 50;

    if (down) {
      if (current) {
        current.end = point.at;
        current.buckets += 1;
      } else {
        current = { start: point.at, end: point.at, buckets: 1 };
      }
      return;
    }

    if (current) {
      incidents.push(current);
      current = null;
    }
  });

  if (current) {
    incidents.push(current);
  }

  return incidents;
}

function formatDuration(minutes) {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }

  const hours = minutes / 60;

  if (hours < 24) {
    return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  }

  return `${(hours / 24).toFixed(1)}d`;
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const value = interaction.options.getString('server', true);
  const requestedRange = interaction.options.getString('range') || '24h';

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);

  if (!plan.limits.graphRanges.includes(requestedRange)) {
    const range = history.getRange(requestedRange);
    await shared.denyWithUpsell(
      interaction,
      `The ${range ? range.label.toLowerCase() : requestedRange} uptime report is a Pro range. `
      + 'The Free plan measures the last 24 hours.',
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked || !tracked.server_id) {
    await interaction.editReply('No tracked server matched that. Add one with `/track add`.');
    return;
  }

  const [series, snapshot] = await Promise.all([
    history.getUptimeSeries(tracked.server_id, requestedRange),
    servers.getSnapshot(tracked.address, tracked.game),
  ]);

  const range = history.getRange(requestedRange);
  const measured = series.points.filter((point) => point.uptime !== null);
  const overall = measured.length > 0
    ? measured.reduce((sum, point) => sum + point.uptime, 0) / measured.length
    : null;

  const incidents = findIncidents(series.points);
  const bucketMinutes = range ? range.bucketMinutes : 5;
  const downMinutes = incidents.reduce((sum, incident) => sum + incident.buckets * bucketMinutes, 0);

  const title = tracked.label || (snapshot && snapshot.name) || tracked.address;
  const fileName = `uptime-${requestedRange}.png`;

  const png = chart.renderUptimeChart(series.points, {
    title,
    subtitle: `${games.gameName(tracked.game)} · ${tracked.address}`,
    rangeKey: requestedRange,
    rangeLabel: range ? range.label : requestedRange,
    footer: incidents.length > 0
      ? `${incidents.length} incident${incidents.length === 1 ? '' : 's'}, ${formatDuration(downMinutes)} down`
      : 'no incidents',
  });

  const embed = new EmbedBuilder()
    .setColor(overall === null
      ? embeds.COLORS.flat
      : (overall >= 99 ? embeds.COLORS.online : (overall >= 90 ? embeds.COLORS.stale : embeds.COLORS.offline)))
    .setTitle(`${embeds.statusDot(snapshot)} ${embeds.safeValue(title, 200)}`.slice(0, 250))
    .setImage(`attachment://${fileName}`)
    .setFooter({ text: shared.planFooter(plan) });

  if (overall === null) {
    embed.setDescription('Not enough checks recorded yet. Availability builds up as the bot samples the server.');
  } else {
    embed.setDescription(`**${overall.toFixed(2)}%** of checks answered over ${range ? range.label.toLowerCase() : requestedRange}.`);
    embed.addFields(
      { name: 'Availability', value: `${overall.toFixed(2)}%`, inline: true },
      { name: 'Incidents', value: String(incidents.length), inline: true },
      { name: 'Time down', value: incidents.length > 0 ? formatDuration(downMinutes) : 'none', inline: true }
    );
  }

  if (incidents.length > 0) {
    const lines = incidents.slice(-5).reverse().map((incident) => {
      const minutes = incident.buckets * bucketMinutes;
      return `<t:${Math.floor(incident.start.getTime() / 1000)}:f> for ${formatDuration(minutes)}`;
    });

    embed.addFields({
      name: incidents.length > 5 ? 'Most recent 5 incidents' : 'Incidents',
      value: lines.join('\n').slice(0, 1024),
    });
  }

  await interaction.editReply({
    embeds: [embed],
    files: [new AttachmentBuilder(png, { name: fileName })],
  });
}

module.exports = { data, execute, autocomplete, findIncidents, formatDuration };
