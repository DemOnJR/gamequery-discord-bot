'use strict';

const db = require('./db');
const config = require('../config');

const RANGES = {
  '24h': { hours: 24, source: 'samples', label: 'Last 24 hours', bucketMinutes: 5 },
  '7d': { hours: 24 * 7, source: 'samples', label: 'Last 7 days', bucketMinutes: 30 },
  '30d': { hours: 24 * 30, source: 'hourly', label: 'Last 30 days', bucketMinutes: 60 },
  '90d': { hours: 24 * 90, source: 'hourly', label: 'Last 90 days', bucketMinutes: 360 },
};

function getRange(key) {
  return RANGES[key] || null;
}

function listRanges() {
  return Object.keys(RANGES);
}

/*
  Writes one five-minute bucket per server and folds it into the hourly rollup
  in the same statement. The bucket key is floor(now / 5min), so two sampler
  ticks inside one bucket update the row rather than duplicating it and the
  primary key does the de-duplication for free.
*/
async function recordSamples(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 0;
  }

  const serverIds = [];
  const players = [];
  const maxPlayers = [];
  const online = [];

  entries.forEach((entry) => {
    if (!entry || !Number.isFinite(Number(entry.serverId))) {
      return;
    }

    serverIds.push(Number(entry.serverId));
    players.push(Number.isFinite(Number(entry.players)) ? Math.max(0, Math.round(Number(entry.players))) : 0);
    maxPlayers.push(Number.isFinite(Number(entry.maxPlayers)) ? Math.max(0, Math.round(Number(entry.maxPlayers))) : null);
    online.push(Boolean(entry.online));
  });

  if (serverIds.length === 0) {
    return 0;
  }

  const bucketMinutes = Math.max(1, config.intervals.samplerMinutes);

  await db.query(
    `WITH input AS (
       SELECT *
       FROM UNNEST($1::bigint[], $2::int[], $3::int[], $4::boolean[])
         AS t(server_id, players, max_players, online)
     ),
     bucketed AS (
       SELECT server_id,
              to_timestamp(floor(extract(epoch FROM NOW()) / ($5 * 60)) * ($5 * 60)) AS bucket_at,
              players,
              max_players,
              online
       FROM input
     ),
     ins AS (
       INSERT INTO server_player_samples (server_id, bucket_at, players, max_players, online)
       SELECT server_id, bucket_at, players, max_players, online FROM bucketed
       ON CONFLICT (server_id, bucket_at) DO UPDATE
         SET players = EXCLUDED.players,
             max_players = COALESCE(EXCLUDED.max_players, server_player_samples.max_players),
             online = EXCLUDED.online
       RETURNING server_id, bucket_at
     )
     SELECT count(*) FROM ins`,
    [serverIds, players, maxPlayers, online, bucketMinutes]
  );

  await rollupHours(serverIds);

  return serverIds.length;
}

/*
  Recomputes the current and previous hour from the five-minute samples. Doing
  it as a recompute rather than an increment means a restart mid-hour, a
  duplicate tick or a backfill can never double-count.
*/
async function rollupHours(serverIds) {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    return;
  }

  await db.query(
    `INSERT INTO server_player_hourly
       (server_id, bucket_hour, players_avg, players_peak, players_min, max_players, samples, online_samples)
     SELECT s.server_id,
            date_trunc('hour', s.bucket_at) AS bucket_hour,
            ROUND(AVG(s.players) FILTER (WHERE s.online), 2) AS players_avg,
            COALESCE(MAX(s.players) FILTER (WHERE s.online), 0) AS players_peak,
            COALESCE(MIN(s.players) FILTER (WHERE s.online), 0) AS players_min,
            MAX(s.max_players) AS max_players,
            COUNT(*)::int AS samples,
            COUNT(*) FILTER (WHERE s.online)::int AS online_samples
     FROM server_player_samples s
     WHERE s.server_id = ANY($1::bigint[])
       AND s.bucket_at >= date_trunc('hour', NOW() - INTERVAL '1 hour')
     GROUP BY s.server_id, date_trunc('hour', s.bucket_at)
     ON CONFLICT (server_id, bucket_hour) DO UPDATE
       SET players_avg = COALESCE(EXCLUDED.players_avg, 0),
           players_peak = EXCLUDED.players_peak,
           players_min = EXCLUDED.players_min,
           max_players = COALESCE(EXCLUDED.max_players, server_player_hourly.max_players),
           samples = EXCLUDED.samples,
           online_samples = EXCLUDED.online_samples`,
    [serverIds]
  );
}

/*
  A newly tracked server would otherwise show an empty graph for its first day.

  On the hosted instance the platform's distributed_probe_attempts already holds
  roughly three days of real probes for every server the fleet touches, so a
  one-off backfill makes /graph useful from the first minute rather than
  tomorrow. A self-hosted bot has no such table and simply starts its history at
  the first sample, which is why the table is looked up rather than assumed.

  De-duplicated by the sample primary key, so running it twice is harmless.
*/
async function backfillFromProbeAttempts(serverId, address, days = 3) {
  if (!Number.isFinite(Number(serverId)) || !address) {
    return 0;
  }

  const platform = await db.one(
    "SELECT to_regclass('public.distributed_probe_attempts') IS NOT NULL AS attempts,"
    + " to_regclass('public.servers') IS NOT NULL AS servers"
  );

  if (!platform || !platform.attempts || !platform.servers) {
    return 0;
  }

  const bucketMinutes = Math.max(1, config.intervals.samplerMinutes);

  /*
    Joined on the ADDRESS, not on an id. server_id here is the bot's own
    gq_servers id, which has nothing to do with the platform's servers.id, and
    matching the two numerically would silently backfill one server's history
    onto another.
  */
  const result = await db.query(
    `WITH probes AS (
       SELECT to_timestamp(
                floor(extract(epoch FROM p.created_at) / ($3 * 60)) * ($3 * 60)
              ) AS bucket_at,
              p.player_count,
              p.success
       FROM distributed_probe_attempts p
       JOIN servers s ON s.id = p.server_id
       WHERE s.server = $4
         AND p.created_at >= NOW() - ($2 || ' days')::interval
     ),
     folded AS (
       SELECT bucket_at,
              COALESCE(ROUND(AVG(player_count) FILTER (WHERE success))::int, 0) AS players,
              bool_or(success) AS online
       FROM probes
       GROUP BY bucket_at
     )
     INSERT INTO server_player_samples (server_id, bucket_at, players, max_players, online)
     SELECT $1, bucket_at, players, NULL, online
     FROM folded
     ON CONFLICT (server_id, bucket_at) DO NOTHING`,
    [Number(serverId), String(Math.max(1, Math.min(30, days))), bucketMinutes, String(address)]
  );

  const inserted = result.rowCount || 0;

  if (inserted > 0) {
    await rollupAll(Number(serverId));
  }

  return inserted;
}

// Recomputes every hourly bucket for one server, used after a backfill drops a
// few days of samples in at once.
async function rollupAll(serverId) {
  await db.query(
    `INSERT INTO server_player_hourly
       (server_id, bucket_hour, players_avg, players_peak, players_min, max_players, samples, online_samples)
     SELECT s.server_id,
            date_trunc('hour', s.bucket_at),
            COALESCE(ROUND(AVG(s.players) FILTER (WHERE s.online), 2), 0),
            COALESCE(MAX(s.players) FILTER (WHERE s.online), 0),
            COALESCE(MIN(s.players) FILTER (WHERE s.online), 0),
            MAX(s.max_players),
            COUNT(*)::int,
            COUNT(*) FILTER (WHERE s.online)::int
     FROM server_player_samples s
     WHERE s.server_id = $1
     GROUP BY s.server_id, date_trunc('hour', s.bucket_at)
     ON CONFLICT (server_id, bucket_hour) DO NOTHING`,
    [Number(serverId)]
  );
}

/*
  Returns evenly spaced points for a chart. Gaps are returned as null players
  rather than zero: a server nobody could reach did not have zero players, and
  drawing it as zero invents a crash that never happened.
*/
async function getSeries(serverId, rangeKey) {
  const range = getRange(rangeKey);

  if (!range || !Number.isFinite(Number(serverId))) {
    return { points: [], range: null };
  }

  const bucketSeconds = range.bucketMinutes * 60;
  let points;

  if (range.source === 'samples') {
    points = await db.rows(
      `SELECT to_timestamp(floor(extract(epoch FROM bucket_at) / $3) * $3) AS at,
              ROUND(AVG(players) FILTER (WHERE online))::int AS players,
              MAX(max_players) AS max_players,
              bool_or(online) AS online
       FROM server_player_samples
       WHERE server_id = $1
         AND bucket_at >= NOW() - ($2 || ' hours')::interval
       GROUP BY 1
       ORDER BY 1`,
      [Number(serverId), String(range.hours), bucketSeconds]
    );
  } else {
    points = await db.rows(
      `SELECT to_timestamp(floor(extract(epoch FROM bucket_hour) / $3) * $3) AS at,
              ROUND(AVG(players_avg) FILTER (WHERE online_samples > 0))::int AS players,
              MAX(max_players) AS max_players,
              bool_or(online_samples > 0) AS online
       FROM server_player_hourly
       WHERE server_id = $1
         AND bucket_hour >= NOW() - ($2 || ' hours')::interval
       GROUP BY 1
       ORDER BY 1`,
      [Number(serverId), String(range.hours), bucketSeconds]
    );
  }

  return {
    range,
    points: points.map((row) => ({
      at: new Date(row.at),
      players: row.online && row.players !== null ? Number(row.players) : null,
      maxPlayers: row.max_players === null ? null : Number(row.max_players),
      online: Boolean(row.online),
    })),
  };
}

async function getStats(serverId, rangeKey) {
  const range = getRange(rangeKey);

  if (!range || !Number.isFinite(Number(serverId))) {
    return null;
  }

  const row = await db.one(
    `SELECT COALESCE(ROUND(AVG(players) FILTER (WHERE online), 1), 0)::float AS avg_players,
            COALESCE(MAX(players) FILTER (WHERE online), 0)::int AS peak_players,
            COUNT(*)::int AS samples,
            COUNT(*) FILTER (WHERE online)::int AS online_samples,
            MAX(bucket_at) AS newest,
            MIN(bucket_at) AS oldest
     FROM server_player_samples
     WHERE server_id = $1
       AND bucket_at >= NOW() - ($2 || ' hours')::interval`,
    [Number(serverId), String(range.hours)]
  );

  if (!row || row.samples === 0) {
    return null;
  }

  return {
    avgPlayers: Number(row.avg_players),
    peakPlayers: Number(row.peak_players),
    samples: Number(row.samples),
    onlineSamples: Number(row.online_samples),
    uptimePercent: row.samples > 0 ? (row.online_samples / row.samples) * 100 : 0,
    newest: row.newest ? new Date(row.newest) : null,
    oldest: row.oldest ? new Date(row.oldest) : null,
  };
}

/*
  Peak hour of the day, averaged over the range. This is the number a community
  manager actually wants: "when do I schedule the event".
*/
async function getHourOfDayProfile(serverId, days = 14) {
  const rows = await db.rows(
    `SELECT extract(hour FROM bucket_hour AT TIME ZONE 'UTC')::int AS hour,
            COALESCE(ROUND(AVG(players_avg) FILTER (WHERE online_samples > 0), 1), 0)::float AS avg_players,
            COALESCE(MAX(players_peak), 0)::int AS peak_players
     FROM server_player_hourly
     WHERE server_id = $1
       AND bucket_hour >= NOW() - ($2 || ' days')::interval
     GROUP BY 1
     ORDER BY 1`,
    [Number(serverId), String(Math.max(1, Math.min(90, days)))]
  );

  return rows.map((row) => ({
    hour: Number(row.hour),
    avgPlayers: Number(row.avg_players),
    peakPlayers: Number(row.peak_players),
  }));
}

/*
  Availability over time, as a percentage of checks that answered per bucket.

  This is a different question from the player graph and deserves its own
  series: a hosting provider selling uptime cares whether the box answered, not
  how busy it was. A bucket with no samples at all returns null rather than 0,
  because "we did not look" is not "it was down" and colouring it red would
  invent an outage.
*/
async function getUptimeSeries(serverId, rangeKey) {
  const range = getRange(rangeKey);

  if (!range || !Number.isFinite(Number(serverId))) {
    return { points: [], range: null };
  }

  const bucketSeconds = range.bucketMinutes * 60;
  let rows;

  if (range.source === 'samples') {
    rows = await db.rows(
      `SELECT to_timestamp(floor(extract(epoch FROM bucket_at) / $3) * $3) AS at,
              COUNT(*)::int AS samples,
              COUNT(*) FILTER (WHERE online)::int AS online_samples
       FROM server_player_samples
       WHERE server_id = $1
         AND bucket_at >= NOW() - ($2 || ' hours')::interval
       GROUP BY 1
       ORDER BY 1`,
      [Number(serverId), String(range.hours), bucketSeconds]
    );
  } else {
    rows = await db.rows(
      `SELECT to_timestamp(floor(extract(epoch FROM bucket_hour) / $3) * $3) AS at,
              SUM(samples)::int AS samples,
              SUM(online_samples)::int AS online_samples
       FROM server_player_hourly
       WHERE server_id = $1
         AND bucket_hour >= NOW() - ($2 || ' hours')::interval
       GROUP BY 1
       ORDER BY 1`,
      [Number(serverId), String(range.hours), bucketSeconds]
    );
  }

  return {
    range,
    points: rows.map((row) => ({
      at: new Date(row.at),
      samples: Number(row.samples),
      onlineSamples: Number(row.online_samples),
      uptime: Number(row.samples) > 0
        ? (Number(row.online_samples) / Number(row.samples)) * 100
        : null,
    })),
  };
}

/*
  One row per server for a leaderboard or a report. Done as a single grouped
  query rather than a stats call per server: a guild with 25 tracked servers
  would otherwise issue 25 round trips to render one embed.
*/
async function getBatchStats(serverIds, hours = 24) {
  const ids = (serverIds || []).map(Number).filter(Number.isFinite);

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db.rows(
    `SELECT server_id,
            COALESCE(ROUND(AVG(players) FILTER (WHERE online), 1), 0)::float AS avg_players,
            COALESCE(MAX(players) FILTER (WHERE online), 0)::int AS peak_players,
            COUNT(*)::int AS samples,
            COUNT(*) FILTER (WHERE online)::int AS online_samples,
            MAX(max_players) AS max_players
     FROM server_player_samples
     WHERE server_id = ANY($1::bigint[])
       AND bucket_at >= NOW() - ($2 || ' hours')::interval
     GROUP BY server_id`,
    [ids, String(Math.max(1, hours))]
  );

  const out = new Map();

  rows.forEach((row) => {
    const samples = Number(row.samples);
    out.set(Number(row.server_id), {
      avgPlayers: Number(row.avg_players),
      peakPlayers: Number(row.peak_players),
      samples,
      onlineSamples: Number(row.online_samples),
      uptimePercent: samples > 0 ? (Number(row.online_samples) / samples) * 100 : null,
      maxPlayers: row.max_players === null ? null : Number(row.max_players),
    });
  });

  return out;
}

/*
  Compares a window against the one immediately before it, which is what makes
  a scheduled report worth reading: "average 14, up 12% on last week" says
  something that "average 14" does not.
*/
async function getTrend(serverIds, hours = 24) {
  const ids = (serverIds || []).map(Number).filter(Number.isFinite);

  if (ids.length === 0) {
    return { current: null, previous: null, changePercent: null, peak: 0 };
  }

  const row = await db.one(
    `SELECT
       COALESCE(ROUND(AVG(players) FILTER (
         WHERE online AND bucket_at >= NOW() - ($2 || ' hours')::interval
       ), 2), 0)::float AS current_avg,
       COALESCE(ROUND(AVG(players) FILTER (
         WHERE online
           AND bucket_at < NOW() - ($2 || ' hours')::interval
           AND bucket_at >= NOW() - (($2::numeric * 2) || ' hours')::interval
       ), 2), 0)::float AS previous_avg,
       COALESCE(MAX(players) FILTER (
         WHERE online AND bucket_at >= NOW() - ($2 || ' hours')::interval
       ), 0)::int AS peak,
       COUNT(*) FILTER (WHERE bucket_at >= NOW() - ($2 || ' hours')::interval)::int AS samples,
       COUNT(*) FILTER (
         WHERE online AND bucket_at >= NOW() - ($2 || ' hours')::interval
       )::int AS online_samples
     FROM server_player_samples
     WHERE server_id = ANY($1::bigint[])
       AND bucket_at >= NOW() - (($2::numeric * 2) || ' hours')::interval`,
    [ids, String(Math.max(1, hours))]
  );

  if (!row) {
    return { current: null, previous: null, changePercent: null, peak: 0 };
  }

  const current = Number(row.current_avg);
  const previous = Number(row.previous_avg);

  return {
    current,
    previous,
    // No previous window means no comparison, not a 100% rise.
    changePercent: previous > 0 ? ((current - previous) / previous) * 100 : null,
    peak: Number(row.peak),
    samples: Number(row.samples),
    uptimePercent: Number(row.samples) > 0
      ? (Number(row.online_samples) / Number(row.samples)) * 100
      : null,
  };
}

async function exportCsv(serverId, rangeKey) {
  const { points, range } = await getSeries(serverId, rangeKey);

  if (!range) {
    return null;
  }

  const lines = ['timestamp_utc,players,max_players,online'];
  points.forEach((point) => {
    lines.push([
      point.at.toISOString(),
      point.players === null ? '' : point.players,
      point.maxPlayers === null ? '' : point.maxPlayers,
      point.online ? '1' : '0',
    ].join(','));
  });

  return lines.join('\n');
}

async function prune() {
  const sampleResult = await db.query(
    `DELETE FROM server_player_samples WHERE bucket_at < NOW() - ($1 || ' days')::interval`,
    [String(config.retention.sampleDays)]
  );

  const hourlyResult = await db.query(
    `DELETE FROM server_player_hourly WHERE bucket_hour < NOW() - ($1 || ' days')::interval`,
    [String(config.retention.hourlyDays)]
  );

  const codeResult = await db.query(
    'DELETE FROM discord_link_codes WHERE expires_at < NOW() - INTERVAL \'1 day\''
  );

  return {
    samples: sampleResult.rowCount || 0,
    hourly: hourlyResult.rowCount || 0,
    linkCodes: codeResult.rowCount || 0,
  };
}

module.exports = {
  RANGES,
  getUptimeSeries,
  getBatchStats,
  getTrend,
  getRange,
  listRanges,
  recordSamples,
  rollupHours,
  backfillFromProbeAttempts,
  getSeries,
  getStats,
  getHourOfDayProfile,
  exportCsv,
  prune,
};
