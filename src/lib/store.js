'use strict';

const db = require('./db');

// Tracked servers -----------------------------------------------------------

async function listTracked(guildId) {
  return db.rows(
    `SELECT id, guild_id, server_id, game, address, label, added_by_discord_user_id, created_at
     FROM discord_tracked_servers
     WHERE guild_id = $1
     ORDER BY created_at, id`,
    [String(guildId)]
  );
}

async function countTracked(guildId) {
  const row = await db.one(
    'SELECT COUNT(*)::int AS total FROM discord_tracked_servers WHERE guild_id = $1',
    [String(guildId)]
  );

  return row ? row.total : 0;
}

async function getTracked(guildId, idOrAddress) {
  const value = String(idOrAddress || '').trim();

  if (/^\d+$/.test(value)) {
    const byId = await db.one(
      'SELECT * FROM discord_tracked_servers WHERE guild_id = $1 AND id = $2',
      [String(guildId), Number(value)]
    );

    if (byId) {
      return byId;
    }
  }

  return db.one(
    `SELECT * FROM discord_tracked_servers
     WHERE guild_id = $1 AND (address = $2 OR lower(label) = lower($2))
     LIMIT 1`,
    [String(guildId), value]
  );
}

async function addTracked({ guildId, serverId, game, address, label, addedBy }) {
  return db.one(
    `INSERT INTO discord_tracked_servers (guild_id, server_id, game, address, label, added_by_discord_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id, address) DO UPDATE
       SET game = EXCLUDED.game,
           server_id = EXCLUDED.server_id,
           label = COALESCE(EXCLUDED.label, discord_tracked_servers.label)
     RETURNING *`,
    [String(guildId), serverId, String(game), String(address), label || null, addedBy ? String(addedBy) : null]
  );
}

async function removeTracked(guildId, trackedId) {
  const result = await db.query(
    'DELETE FROM discord_tracked_servers WHERE guild_id = $1 AND id = $2',
    [String(guildId), Number(trackedId)]
  );

  return (result.rowCount || 0) > 0;
}

async function setLabel(guildId, trackedId, label) {
  await db.query(
    'UPDATE discord_tracked_servers SET label = $3 WHERE guild_id = $1 AND id = $2',
    [String(guildId), Number(trackedId), label || null]
  );
}

// Counter channels ----------------------------------------------------------

async function listCounters(guildId) {
  return db.rows(
    `SELECT c.*, t.address, t.game, t.label
     FROM discord_counter_channels c
     LEFT JOIN discord_tracked_servers t ON t.id = c.tracked_server_id
     WHERE c.guild_id = $1
     ORDER BY c.created_at, c.id`,
    [String(guildId)]
  );
}

async function countCounters(guildId) {
  const row = await db.one(
    'SELECT COUNT(*)::int AS total FROM discord_counter_channels WHERE guild_id = $1',
    [String(guildId)]
  );

  return row ? row.total : 0;
}

async function addCounter({ guildId, channelId, channelKind, trackedServerId, template }) {
  return db.one(
    `INSERT INTO discord_counter_channels (guild_id, channel_id, channel_kind, tracked_server_id, name_template)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id) DO UPDATE
       SET tracked_server_id = EXCLUDED.tracked_server_id,
           name_template = EXCLUDED.name_template,
           channel_kind = EXCLUDED.channel_kind,
           fail_streak = 0
     -- channel_id is unique across the whole table because Discord ids are
     -- globally unique. Discord will not resolve another guild's channel into
     -- this interaction, but if that ever changed, an unguarded upsert would
     -- rewrite the other guild's counter to point at this guild's server.
     WHERE discord_counter_channels.guild_id = EXCLUDED.guild_id
     RETURNING *`,
    [String(guildId), String(channelId), String(channelKind), trackedServerId || null, String(template)]
  );
}

async function removeCounter(guildId, channelId) {
  const result = await db.query(
    'DELETE FROM discord_counter_channels WHERE guild_id = $1 AND channel_id = $2',
    [String(guildId), String(channelId)]
  );

  return (result.rowCount || 0) > 0;
}

async function touchCounter(id, renderedName) {
  await db.query(
    `UPDATE discord_counter_channels
     SET last_rendered_name = $2, last_updated_at = NOW(), fail_streak = 0
     WHERE id = $1`,
    [Number(id), String(renderedName).slice(0, 120)]
  );
}

async function failCounter(id) {
  const row = await db.one(
    'UPDATE discord_counter_channels SET fail_streak = fail_streak + 1 WHERE id = $1 RETURNING fail_streak',
    [Number(id)]
  );

  return row ? row.fail_streak : 0;
}

async function dropCounter(id) {
  await db.query('DELETE FROM discord_counter_channels WHERE id = $1', [Number(id)]);
}

// Live messages -------------------------------------------------------------

async function listStatusMessages(guildId) {
  return db.rows(
    `SELECT m.*, t.address, t.game, t.label
     FROM discord_status_messages m
     LEFT JOIN discord_tracked_servers t ON t.id = m.tracked_server_id
     WHERE m.guild_id = $1
     ORDER BY m.created_at, m.id`,
    [String(guildId)]
  );
}

async function countStatusMessages(guildId) {
  const row = await db.one(
    'SELECT COUNT(*)::int AS total FROM discord_status_messages WHERE guild_id = $1',
    [String(guildId)]
  );

  return row ? row.total : 0;
}

async function addStatusMessage({ guildId, channelId, messageId, trackedServerId, mode, graphRange }) {
  return db.one(
    `INSERT INTO discord_status_messages (guild_id, channel_id, message_id, tracked_server_id, mode, graph_range, last_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (message_id) DO UPDATE
       SET mode = EXCLUDED.mode,
           graph_range = EXCLUDED.graph_range,
           fail_streak = 0
     WHERE discord_status_messages.guild_id = EXCLUDED.guild_id
     RETURNING *`,
    [String(guildId), String(channelId), String(messageId), trackedServerId || null, String(mode), graphRange || null]
  );
}

async function removeStatusMessage(guildId, messageId) {
  const result = await db.query(
    'DELETE FROM discord_status_messages WHERE guild_id = $1 AND message_id = $2',
    [String(guildId), String(messageId)]
  );

  return (result.rowCount || 0) > 0;
}

async function touchStatusMessage(id) {
  await db.query(
    'UPDATE discord_status_messages SET last_updated_at = NOW(), fail_streak = 0 WHERE id = $1',
    [Number(id)]
  );
}

async function failStatusMessage(id) {
  const row = await db.one(
    'UPDATE discord_status_messages SET fail_streak = fail_streak + 1 WHERE id = $1 RETURNING fail_streak',
    [Number(id)]
  );

  return row ? row.fail_streak : 0;
}

async function dropStatusMessage(id) {
  await db.query('DELETE FROM discord_status_messages WHERE id = $1', [Number(id)]);
}

// Alerts --------------------------------------------------------------------

async function listAlerts(guildId) {
  return db.rows(
    `SELECT a.*, t.address, t.game, t.label
     FROM discord_alerts a
     JOIN discord_tracked_servers t ON t.id = a.tracked_server_id
     WHERE a.guild_id = $1
     ORDER BY a.created_at, a.id`,
    [String(guildId)]
  );
}

async function countAlerts(guildId) {
  const row = await db.one(
    'SELECT COUNT(*)::int AS total FROM discord_alerts WHERE guild_id = $1',
    [String(guildId)]
  );

  return row ? row.total : 0;
}

async function addAlert({ guildId, trackedServerId, channelId, alertType, threshold, mentionRoleId, cooldownMinutes }) {
  /*
    The SELECT ... WHERE is the point: it inserts only if the tracked server is
    one this guild owns. The command layer already resolves servers per guild,
    but an alert that pings a channel about another guild's server is exactly
    the bug worth making structurally impossible rather than merely unreachable.
  */
  return db.one(
    `INSERT INTO discord_alerts
       (guild_id, tracked_server_id, channel_id, alert_type, threshold, mention_role_id, cooldown_minutes)
     SELECT $1, t.id, $3, $4, $5, $6, $7
     FROM discord_tracked_servers t
     WHERE t.id = $2 AND t.guild_id = $1
     RETURNING *`,
    [
      String(guildId),
      Number(trackedServerId),
      String(channelId),
      String(alertType),
      threshold === null || threshold === undefined ? null : Number(threshold),
      mentionRoleId ? String(mentionRoleId) : null,
      Number.isFinite(Number(cooldownMinutes)) ? Number(cooldownMinutes) : 15,
    ]
  );
}

async function removeAlert(guildId, alertId) {
  const result = await db.query(
    'DELETE FROM discord_alerts WHERE guild_id = $1 AND id = $2',
    [String(guildId), Number(alertId)]
  );

  return (result.rowCount || 0) > 0;
}

async function setAlertState(id, state, fired) {
  await db.query(
    `UPDATE discord_alerts
     SET last_state = $2,
         last_fired_at = CASE WHEN $3 THEN NOW() ELSE last_fired_at END
     WHERE id = $1`,
    [Number(id), state === null ? null : String(state), Boolean(fired)]
  );
}

async function deactivateAlert(id) {
  await db.query('UPDATE discord_alerts SET is_active = FALSE WHERE id = $1', [Number(id)]);
}

// Scheduled reports ---------------------------------------------------------

async function listReports(guildId) {
  return db.rows(
    'SELECT * FROM discord_reports WHERE guild_id = $1 ORDER BY created_at, id',
    [String(guildId)]
  );
}

async function addReport({ guildId, channelId, cadence, hourUtc, mentionRoleId }) {
  return db.one(
    `INSERT INTO discord_reports (guild_id, channel_id, cadence, hour_utc, mention_role_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      String(guildId),
      String(channelId),
      String(cadence),
      Number.isFinite(Number(hourUtc)) ? Number(hourUtc) : 9,
      mentionRoleId ? String(mentionRoleId) : null,
    ]
  );
}

async function removeReport(guildId, reportId) {
  const result = await db.query(
    'DELETE FROM discord_reports WHERE guild_id = $1 AND id = $2',
    [String(guildId), Number(reportId)]
  );

  return (result.rowCount || 0) > 0;
}

async function markReportSent(id) {
  await db.query('UPDATE discord_reports SET last_sent_at = NOW() WHERE id = $1', [Number(id)]);
}

/*
  Reports that are due right now.

  Due means: the hour matches, and it has not already gone out for this period.
  Comparing against last_sent_at rather than tracking a schedule means a restart,
  a slow tick or a clock skew cannot produce two copies of the same digest, and
  a bot that was down at 09:00 still sends the daily report when it comes back
  within the hour rather than skipping the day silently.
*/
async function dueReports() {
  return db.rows(
    `SELECT r.*
     FROM discord_reports r
     JOIN discord_guilds g ON g.guild_id = r.guild_id
     WHERE r.is_active = TRUE
       AND g.left_at IS NULL
       AND g.pro_active = TRUE
       AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int = r.hour_utc
       AND (
         r.last_sent_at IS NULL
         OR (r.cadence = 'daily' AND r.last_sent_at < date_trunc('day', NOW()))
         OR (r.cadence = 'weekly' AND r.last_sent_at < date_trunc('week', NOW()))
       )
       AND (r.cadence <> 'weekly' OR EXTRACT(ISODOW FROM NOW() AT TIME ZONE 'UTC')::int = 1)
     ORDER BY r.guild_id, r.id`
  );
}

// Cross-guild reads used by the background workers --------------------------

async function allActiveTrackedServers() {
  return db.rows(
    `SELECT DISTINCT t.server_id, t.address, t.game
     FROM discord_tracked_servers t
     JOIN discord_guilds g ON g.guild_id = t.guild_id
     WHERE g.left_at IS NULL AND t.server_id IS NOT NULL`
  );
}

async function guildsWithWork() {
  return db.rows(
    `SELECT g.guild_id, g.pro_active
     FROM discord_guilds g
     WHERE g.left_at IS NULL
       AND (
         EXISTS (SELECT 1 FROM discord_counter_channels c WHERE c.guild_id = g.guild_id)
         OR EXISTS (SELECT 1 FROM discord_status_messages m WHERE m.guild_id = g.guild_id)
         OR EXISTS (SELECT 1 FROM discord_alerts a WHERE a.guild_id = g.guild_id AND a.is_active = TRUE)
       )
     ORDER BY g.pro_active DESC, g.guild_id`
  );
}

module.exports = {
  listReports,
  addReport,
  removeReport,
  markReportSent,
  dueReports,
  listTracked,
  countTracked,
  getTracked,
  addTracked,
  removeTracked,
  setLabel,
  listCounters,
  countCounters,
  addCounter,
  removeCounter,
  touchCounter,
  failCounter,
  dropCounter,
  listStatusMessages,
  countStatusMessages,
  addStatusMessage,
  removeStatusMessage,
  touchStatusMessage,
  failStatusMessage,
  dropStatusMessage,
  listAlerts,
  countAlerts,
  addAlert,
  removeAlert,
  setAlertState,
  deactivateAlert,
  allActiveTrackedServers,
  guildsWithWork,
};
