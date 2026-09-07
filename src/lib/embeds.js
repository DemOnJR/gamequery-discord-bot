'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const games = require('./games');

const COLORS = {
  online: 0x22c55e,
  offline: 0xef4444,
  stale: 0xf59e0b,
  neutral: 0x3b82f6,
  flat: 0x1f2328,
};

function statusColor(snapshot) {
  if (!snapshot || !snapshot.known) {
    return COLORS.flat;
  }

  if (snapshot.online) {
    return COLORS.online;
  }

  return snapshot.stale ? COLORS.stale : COLORS.offline;
}

function statusWord(snapshot) {
  if (!snapshot || !snapshot.known) {
    return 'Unknown';
  }

  if (snapshot.online) {
    return 'Online';
  }

  return snapshot.stale ? 'Stale' : 'Offline';
}

function statusDot(snapshot) {
  if (!snapshot || !snapshot.known) {
    return '⚫';
  }

  if (snapshot.online) {
    return '🟢';
  }

  return snapshot.stale ? '🟡' : '🔴';
}

function playersText(snapshot) {
  if (!snapshot || snapshot.players === null || snapshot.players === undefined) {
    return '--';
  }

  if (snapshot.maxPlayers) {
    return `${snapshot.players} / ${snapshot.maxPlayers}`;
  }

  return String(snapshot.players);
}

function escapeMarkdown(value) {
  return String(value || '').replace(/([*_`~|\\>])/g, '\\$1');
}

/*
  Everything a game server reports about itself is attacker-controlled: the
  hostname, the map, the connect string and the player names are whatever the
  server operator put there, and anyone can point /server at a server they run.

  Discord rejects the entire message if one embed field exceeds 1024
  characters, so an uncapped field is not cosmetic: one hostile server would
  make the command fail for everyone who queries it. Cap, escape, then cap
  again, because escaping grows the string.
*/
function safeValue(value, maxLength = 200) {
  const raw = String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  return escapeMarkdown(raw).slice(0, 1024);
}

// Inside a code span only the backtick needs handling; escaping the rest would
// show the backslashes literally to the reader.
function safeCode(value, maxLength = 120) {
  const raw = String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001F\u007F`]/g, '')
    .trim()
    .slice(0, maxLength);

  return raw || 'unknown';
}

function relativeTime(date) {
  if (!date) {
    return 'never';
  }

  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

/*
  A single server, the shape used both by /server status and by the live
  self-updating message. Everything shown is a fact the payload actually
  carries; a field the game's protocol does not report is omitted rather than
  filled with a plausible-looking dash.
*/
function serverEmbed(snapshot, options = {}) {
  const title = snapshot.name ? safeValue(snapshot.name, 200) : safeCode(snapshot.address, 64);
  const embed = new EmbedBuilder()
    .setColor(statusColor(snapshot))
    .setTitle(`${statusDot(snapshot)} ${title}`.slice(0, 250))
    .addFields(
      { name: 'Players', value: playersText(snapshot), inline: true },
      { name: 'Status', value: statusWord(snapshot), inline: true },
      { name: 'Game', value: games.gameName(snapshot.game || options.game), inline: true }
    );

  if (snapshot.map) {
    embed.addFields({ name: 'Map', value: safeValue(snapshot.map, 100), inline: true });
  }

  if (snapshot.ping !== null && snapshot.ping !== undefined) {
    embed.addFields({ name: 'Query time', value: `${snapshot.ping} ms`, inline: true });
  }

  if (snapshot.bots) {
    embed.addFields({ name: 'Bots', value: String(snapshot.bots), inline: true });
  }

  embed.addFields({ name: 'Connect', value: `\`${safeCode(snapshot.connect || snapshot.address, 100)}\``, inline: false });

  const notes = [];

  if (snapshot.passworded === true) {
    notes.push('Password protected.');
  }

  if (!snapshot.online) {
    if (snapshot.stale) {
      notes.push(`Last successful query ${relativeTime(snapshot.updatedAt || snapshot.lastOnlineAt)}.`);
    } else if (snapshot.lastOnlineAt) {
      notes.push(`Last seen online ${relativeTime(snapshot.lastOnlineAt)}.`);
    } else if (!snapshot.known) {
      notes.push('This address has not been probed yet. First results usually arrive within a few minutes.');
    } else {
      notes.push('No successful query on record yet.');
    }

    if (snapshot.errorName) {
      notes.push(`Last error: \`${safeCode(snapshot.errorName, 60)}\`.`);
    }
  }

  if (options.note) {
    notes.push(options.note);
  }

  if (notes.length > 0) {
    embed.setDescription(notes.join(' '));
  }

  const stamp = snapshot.updatedAt || snapshot.lastProbeAt || new Date();
  embed.setFooter({ text: options.footer || `${snapshot.address} - gamequery.dev` });
  embed.setTimestamp(stamp);

  return embed;
}

/*
  Every tracked server in one message. Sorted by players descending so the
  active server is the first thing read, which is what a member scanning the
  channel is looking for.
*/
function serverListEmbed(trackedRows, snapshots, options = {}) {
  const entries = trackedRows.map((row) => ({
    row,
    snapshot: snapshots.get(row.address) || null,
  }));

  entries.sort((a, b) => {
    const aOnline = a.snapshot && a.snapshot.online ? 1 : 0;
    const bOnline = b.snapshot && b.snapshot.online ? 1 : 0;

    if (aOnline !== bOnline) {
      return bOnline - aOnline;
    }

    const aPlayers = a.snapshot && a.snapshot.players !== null ? a.snapshot.players : -1;
    const bPlayers = b.snapshot && b.snapshot.players !== null ? b.snapshot.players : -1;
    return bPlayers - aPlayers;
  });

  let totalPlayers = 0;
  let onlineCount = 0;

  const lines = entries.map(({ row, snapshot }) => {
    if (snapshot && snapshot.online) {
      onlineCount += 1;
      totalPlayers += snapshot.players || 0;
    }

    const label = row.label || (snapshot && snapshot.name) || row.address;
    return `${statusDot(snapshot)} **${safeValue(label, 60)}**\n`
      + ` ${playersText(snapshot)} players · ${snapshot && snapshot.map ? safeValue(snapshot.map, 40) : 'no map reported'}\n`
      + ` \`${safeCode(row.address, 64)}\``;
  });

  const embed = new EmbedBuilder()
    .setColor(onlineCount > 0 ? COLORS.online : COLORS.flat)
    .setTitle(options.title || 'Game servers')
    .setDescription(lines.length > 0 ? lines.join('\n\n').slice(0, 4000) : 'No servers tracked yet. Add one with `/track add`.')
    .setFooter({ text: `${totalPlayers} players online across ${onlineCount}/${entries.length} servers - gamequery.dev` })
    .setTimestamp(new Date());

  return embed;
}

function upsellEmbed(reason, plan) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle('This one is on Pro')
    .setDescription(reason)
    .addFields({
      name: 'What Pro adds',
      value: [
        `**${config.plans.PRO.trackedServers} tracked servers** instead of ${config.plans.FREE.trackedServers}`,
        `**${config.plans.PRO.refreshMinutes}-minute refresh** instead of ${config.plans.FREE.refreshMinutes}`,
        `**${config.plans.PRO.counterChannels} counter channels** instead of ${config.plans.FREE.counterChannels}`,
        '**7d / 30d / 90d graphs**, multi-server comparison and peak-hour profiles',
        '**Alerts** on offline, back-online, full and player thresholds',
        '**Live player lists** and **CSV export**',
      ].join('\n'),
    });

  const upgradeUrl = config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`;
  embed.addFields({
    name: 'Get it',
    value: `Start the **7-day free trial** at ${upgradeUrl}, then run \`/pro claim\` here.`,
  });

  if (plan) {
    embed.setFooter({ text: `This server is on the ${plan.limits.name} plan.` });
  }

  return embed;
}

module.exports = {
  COLORS,
  safeValue,
  safeCode,
  statusColor,
  statusWord,
  statusDot,
  playersText,
  escapeMarkdown,
  relativeTime,
  serverEmbed,
  serverListEmbed,
  upsellEmbed,
};
