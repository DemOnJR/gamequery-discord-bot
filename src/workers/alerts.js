'use strict';

const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const db = require('../lib/db');
const store = require('../lib/store');
const servers = require('../lib/servers');
const embeds = require('../lib/embeds');
const games = require('../lib/games');

/*
  Alerts fire on a TRANSITION, never on a state.

  last_state holds what the alert saw on its previous pass. An offline alert
  fires when the state goes online -> offline, not on every pass while the
  server is down, which is why a dead server does not produce a message every
  two minutes for a week. The first pass after an alert is created records the
  state without firing, so adding an alert to an already-offline server does
  not immediately ping the room about something the room already knows.
*/

const DROP_AFTER_FAILURES = 5;

function mapFingerprint(map) {
  return crypto.createHash('sha1').update(String(map)).digest('hex').slice(0, 16);
}

function currentState(alert, snapshot) {
  if (!snapshot) {
    return 'unknown';
  }

  switch (alert.alert_type) {
    case 'offline':
    case 'online':
      return snapshot.online ? 'up' : 'down';

    case 'players_above':
      if (!snapshot.online || snapshot.players === null) {
        return 'unknown';
      }
      return snapshot.players > Number(alert.threshold) ? 'above' : 'below';

    case 'players_below':
      if (!snapshot.online || snapshot.players === null) {
        return 'unknown';
      }
      return snapshot.players < Number(alert.threshold) ? 'below' : 'above';

    case 'full':
      if (!snapshot.online || snapshot.players === null || !snapshot.maxPlayers) {
        return 'unknown';
      }
      return snapshot.players >= snapshot.maxPlayers ? 'full' : 'space';

    case 'map_change':
      /*
        last_state is VARCHAR(32) and Postgres ERRORS rather than truncates on
        overflow, so a long map name ("cs_assault_winter_extended_v3_final")
        would throw on every alert tick forever. A short hash of the map is
        stored instead: the comparison only needs to detect "different from
        last time", never to reproduce the name.
      */
      return snapshot.online && snapshot.map ? `map:${mapFingerprint(snapshot.map)}` : 'unknown';

    default:
      return 'unknown';
  }
}

function shouldFire(alert, previous, next) {
  if (previous === null || previous === undefined || previous === 'unknown' || next === 'unknown') {
    return false;
  }

  if (previous === next) {
    return false;
  }

  switch (alert.alert_type) {
    case 'offline':
      return previous === 'up' && next === 'down';
    case 'online':
      return previous === 'down' && next === 'up';
    case 'players_above':
      return next === 'above';
    case 'players_below':
      return next === 'below';
    case 'full':
      return next === 'full';
    case 'map_change':
      return next.startsWith('map:');
    default:
      return false;
  }
}

function inCooldown(alert) {
  if (!alert.last_fired_at || !alert.cooldown_minutes) {
    return false;
  }

  const ageMinutes = (Date.now() - new Date(alert.last_fired_at).getTime()) / 60000;
  return ageMinutes < Number(alert.cooldown_minutes);
}

function buildEmbed(alert, snapshot) {
  const name = embeds.safeValue(alert.label || (snapshot && snapshot.name) || alert.address, 120);
  const embed = new EmbedBuilder()
    .setTimestamp(new Date())
    .setFooter({ text: `${alert.address} - gamequery.dev` });

  switch (alert.alert_type) {
    case 'offline':
      embed.setColor(embeds.COLORS.offline)
        .setTitle(`🔴 ${name} went offline`)
        .setDescription('The query fleet can no longer reach this server.');
      break;

    case 'online':
      embed.setColor(embeds.COLORS.online)
        .setTitle(`🟢 ${name} is back online`)
        .setDescription(`Answering again with **${embeds.playersText(snapshot)}** players.`);
      break;

    case 'players_above':
      embed.setColor(embeds.COLORS.online)
        .setTitle(`📈 ${name} passed ${alert.threshold} players`)
        .setDescription(`Now **${embeds.playersText(snapshot)}** on ${snapshot && snapshot.map ? `\`${embeds.safeCode(snapshot.map, 60)}\`` : 'the current map'}.`);
      break;

    case 'players_below':
      embed.setColor(embeds.COLORS.stale)
        .setTitle(`📉 ${name} dropped below ${alert.threshold} players`)
        .setDescription(`Now **${embeds.playersText(snapshot)}**.`);
      break;

    case 'full':
      embed.setColor(embeds.COLORS.stale)
        .setTitle(`🔥 ${name} is full`)
        .setDescription(`**${embeds.playersText(snapshot)}** with no free slots.`);
      break;

    case 'map_change':
      embed.setColor(embeds.COLORS.neutral)
        .setTitle(`🗺 ${name} changed map`)
        .setDescription(`Now on \`${embeds.safeCode(snapshot && snapshot.map, 60)}\` with **${embeds.playersText(snapshot)}** players.`);
      break;

    default:
      embed.setColor(embeds.COLORS.neutral).setTitle(name);
  }

  if (snapshot) {
    embed.addFields({ name: 'Connect', value: `\`${embeds.safeCode(snapshot.connect || alert.address, 100)}\``, inline: true });
    embed.addFields({ name: 'Game', value: games.gameName(alert.game), inline: true });
  }

  return embed;
}

/*
  Only guilds on Pro have alerts at all, so the query joins on pro_active
  rather than filtering in JavaScript: a lapsed subscription stops the pings
  without needing anything deleted.
*/
async function loadActiveAlerts() {
  return db.rows(
    `SELECT a.*, t.address, t.game, t.label
     FROM discord_alerts a
     JOIN discord_tracked_servers t ON t.id = a.tracked_server_id
     JOIN discord_guilds g ON g.guild_id = a.guild_id
     WHERE a.is_active = TRUE
       AND g.left_at IS NULL
       AND g.pro_active = TRUE
     ORDER BY a.guild_id, a.id`
  );
}

async function tick(client) {
  const alerts = await loadActiveAlerts();

  if (alerts.length === 0) {
    return { evaluated: 0, fired: 0 };
  }

  const snapshots = await servers.getSnapshots(alerts.map((row) => ({ game: row.game, address: row.address })));
  let fired = 0;

  for (const alert of alerts) {
    const snapshot = snapshots.get(alert.address);
    const next = currentState(alert, snapshot);
    const previous = alert.last_state;

    if (!shouldFire(alert, previous, next)) {
      if (next !== previous) {
        await store.setAlertState(alert.id, next, false);
      }
      continue;
    }

    if (inCooldown(alert)) {
      // The state is still recorded so the next genuine transition is seen,
      // but the message is suppressed.
      await store.setAlertState(alert.id, next, false);
      continue;
    }

    const guild = client.guilds.cache.get(alert.guild_id)
      || await client.guilds.fetch(alert.guild_id).catch(() => null);

    if (!guild) {
      await store.setAlertState(alert.id, next, false);
      continue;
    }

    const channel = guild.channels.cache.get(alert.channel_id)
      || await guild.channels.fetch(alert.channel_id).catch(() => null);

    if (!channel || typeof channel.send !== 'function') {
      await store.deactivateAlert(alert.id);
      console.log(`[alerts] deactivated alert ${alert.id}: channel ${alert.channel_id} unusable`);
      continue;
    }

    try {
      await channel.send({
        content: alert.mention_role_id ? `<@&${alert.mention_role_id}>` : undefined,
        embeds: [buildEmbed(alert, snapshot)],
        allowedMentions: alert.mention_role_id ? { roles: [alert.mention_role_id] } : { parse: [] },
      });

      await store.setAlertState(alert.id, next, true);
      fired += 1;
    } catch (error) {
      console.error(`[alerts] send failed for alert ${alert.id}: ${error.message}`);
      await store.setAlertState(alert.id, next, false);
    }
  }

  return { evaluated: alerts.length, fired };
}

module.exports = { tick, currentState, shouldFire, DROP_AFTER_FAILURES };
