'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const store = require('./store');
const servers = require('./servers');
const history = require('./history');
const chart = require('./chart');
const embeds = require('./embeds');
const games = require('./games');

/*
  Builds the scheduled summary. Shared by /report preview and the worker, so
  what a customer previews is exactly what gets posted.
*/

const WINDOWS = {
  daily: { hours: 24, label: 'Last 24 hours', range: '24h' },
  weekly: { hours: 24 * 7, label: 'Last 7 days', range: '7d' },
};

function trendText(change) {
  if (change === null || change === undefined) {
    // No previous window to compare against. Saying "new" is honest; saying
    // "+100%" would be a fabricated improvement.
    return 'no prior window';
  }

  if (Math.abs(change) < 1) {
    return 'flat';
  }

  return `${change > 0 ? '+' : ''}${change.toFixed(0)}% vs previous`;
}

function uptimeText(value) {
  return value === null || value === undefined ? '--' : `${value.toFixed(1)}%`;
}

async function build(guild, cadence = 'daily') {
  const window = WINDOWS[cadence] || WINDOWS.daily;
  const tracked = await store.listTracked(guild.id);

  if (tracked.length === 0) {
    return null;
  }

  const serverIds = tracked.map((row) => row.server_id).filter(Boolean);

  const [snapshots, stats, trend] = await Promise.all([
    servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address }))),
    history.getBatchStats(serverIds, window.hours),
    history.getTrend(serverIds, window.hours),
  ]);

  // Busiest first: a digest is read top-down and the interesting server should
  // not be third.
  const ranked = tracked
    .map((row) => ({
      row,
      snapshot: snapshots.get(row.address),
      stat: row.server_id ? stats.get(Number(row.server_id)) : null,
    }))
    .sort((a, b) => {
      const aPeak = a.stat ? a.stat.peakPlayers : -1;
      const bPeak = b.stat ? b.stat.peakPlayers : -1;
      return bPeak - aPeak;
    });

  const lines = ranked.slice(0, 15).map(({ row, snapshot, stat }, index) => {
    const label = embeds.safeValue(row.label || (snapshot && snapshot.name) || row.address, 40);
    const peak = stat ? stat.peakPlayers : '--';
    const avg = stat ? stat.avgPlayers.toFixed(1) : '--';
    const up = stat ? uptimeText(stat.uptimePercent) : '--';

    return `\`${String(index + 1).padStart(2, ' ')}\` ${embeds.statusDot(snapshot)} **${label}**\n`
      + ` peak ${peak} · avg ${avg} · up ${up}`;
  });

  const online = ranked.filter(({ snapshot }) => snapshot && snapshot.online).length;
  const playersNow = ranked.reduce(
    (sum, { snapshot }) => sum + (snapshot && snapshot.online ? (snapshot.players || 0) : 0),
    0
  );

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle(`${guild.name} · ${cadence} report`.slice(0, 250))
    .setDescription(lines.join('\n\n').slice(0, 3500))
    .addFields(
      {
        name: 'Average players',
        value: `${trend.current.toFixed(1)} (${trendText(trend.changePercent)})`,
        inline: true,
      },
      { name: 'Peak', value: String(trend.peak), inline: true },
      { name: 'Availability', value: uptimeText(trend.uptimePercent), inline: true },
      {
        name: 'Right now',
        value: `${playersNow} players across ${online}/${tracked.length} servers`,
        inline: false,
      }
    )
    .setFooter({ text: `${window.label} · gamequery.dev` })
    .setTimestamp(new Date());

  const files = [];

  /*
    One chart, of the busiest server. A digest with fifteen images is not a
    digest, and the top server is the one whose shape actually gets looked at.
  */
  const top = ranked.find((entry) => entry.row.server_id && entry.stat && entry.stat.samples > 0);

  if (top) {
    const series = await history.getSeries(top.row.server_id, window.range);

    if (series.points.length > 1) {
      const png = chart.renderPlayerChart(
        [{ label: top.row.label || top.row.address, points: series.points }],
        {
          title: top.row.label || (top.snapshot && top.snapshot.name) || top.row.address,
          subtitle: `${games.gameName(top.row.game)} · ${top.row.address}`,
          rangeKey: window.range,
          rangeLabel: window.label,
          capacity: top.snapshot ? top.snapshot.maxPlayers : null,
          footer: `Busiest tracked server this ${cadence === 'weekly' ? 'week' : 'day'}`,
        }
      );

      files.push(new AttachmentBuilder(png, { name: 'report.png' }));
      embed.setImage('attachment://report.png');
    }
  }

  return { embed, files };
}

module.exports = { build, WINDOWS, trendText };
