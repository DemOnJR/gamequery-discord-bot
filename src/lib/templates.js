'use strict';

const games = require('./games');

/*
  Channel-name templates. Discord caps a channel name at 100 characters and
  rate-limits renames hard (two per ten minutes per channel), so the renderer
  is deliberately cheap and the caller compares the rendered string against the
  last one before spending a rename.
*/
const TOKENS = [
  ['{players}', 'players online right now'],
  ['{maxplayers}', 'server slots'],
  ['{name}', 'hostname reported by the server'],
  ['{map}', 'current map'],
  ['{status}', 'Online / Offline / Stale'],
  ['{dot}', 'a coloured status dot'],
  ['{game}', 'game name'],
  ['{address}', 'ip:port'],
  ['{servers_online}', 'how many tracked servers are up (totals only)'],
  ['{servers_total}', 'how many servers are tracked (totals only)'],
];

const DEFAULT_SERVER_TEMPLATE = '{dot} {players}/{maxplayers} online';
const DEFAULT_TOTAL_TEMPLATE = 'Players: {players}';

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

/*
  A single-server counter. When the server is unreachable the player count
  renders as "--" rather than 0: a channel reading "0/32 online" tells members
  the server is empty, which is a different and more damaging claim than "we
  cannot reach it".
*/
function renderServerTemplate(template, snapshot, tracked) {
  const players = snapshot && snapshot.online && snapshot.players !== null
    ? String(snapshot.players)
    : '--';
  const maxPlayers = snapshot && snapshot.maxPlayers ? String(snapshot.maxPlayers) : '?';

  const values = {
    '{players}': players,
    '{maxplayers}': maxPlayers,
    '{name}': (snapshot && snapshot.name) || (tracked && tracked.label) || (tracked && tracked.address) || '',
    '{map}': (snapshot && snapshot.map) || 'unknown',
    '{status}': statusWord(snapshot),
    '{dot}': statusDot(snapshot),
    '{game}': games.gameName((snapshot && snapshot.game) || (tracked && tracked.game)),
    '{address}': (tracked && tracked.address) || (snapshot && snapshot.address) || '',
    '{servers_online}': snapshot && snapshot.online ? '1' : '0',
    '{servers_total}': '1',
  };

  return apply(template || DEFAULT_SERVER_TEMPLATE, values);
}

/*
  An aggregate counter across every server the guild tracks. Offline servers
  contribute nothing to the total rather than dragging it toward zero.
*/
function renderTotalTemplate(template, snapshots, trackedRows) {
  let players = 0;
  let maxPlayers = 0;
  let onlineCount = 0;

  trackedRows.forEach((row) => {
    const snapshot = snapshots.get(row.address);

    if (snapshot && snapshot.online) {
      onlineCount += 1;
      players += snapshot.players || 0;
      maxPlayers += snapshot.maxPlayers || 0;
    }
  });

  const values = {
    '{players}': String(players),
    '{maxplayers}': maxPlayers > 0 ? String(maxPlayers) : '?',
    '{name}': 'All servers',
    '{map}': 'various',
    '{status}': onlineCount > 0 ? 'Online' : 'Offline',
    '{dot}': onlineCount > 0 ? '🟢' : '🔴',
    '{game}': 'All',
    '{address}': '',
    '{servers_online}': String(onlineCount),
    '{servers_total}': String(trackedRows.length),
  };

  return apply(template || DEFAULT_TOTAL_TEMPLATE, values);
}

function apply(template, values) {
  let output = String(template);

  Object.entries(values).forEach(([token, value]) => {
    output = output.split(token).join(value);
  });

  // Discord rejects an empty name and silently mangles leading/trailing space.
  output = output.replace(/\s+/g, ' ').trim().slice(0, 100);

  return output === '' ? 'Players' : output;
}

function validateTemplate(template) {
  const value = String(template || '').trim();

  if (value.length === 0) {
    return { ok: false, reason: 'The template cannot be empty.' };
  }

  if (value.length > 90) {
    return { ok: false, reason: 'Keep the template under 90 characters; Discord caps a channel name at 100.' };
  }

  const known = new Set(TOKENS.map(([token]) => token));
  const used = value.match(/\{[a-z_]+\}/g) || [];
  const unknown = used.filter((token) => !known.has(token));

  if (unknown.length > 0) {
    return { ok: false, reason: `Unknown placeholder ${unknown.join(', ')}. Supported: ${Array.from(known).join(', ')}` };
  }

  if (used.length === 0) {
    return { ok: false, reason: 'A template with no placeholder would never change. Add at least one, such as `{players}`.' };
  }

  return { ok: true, template: value };
}

function tokenHelp() {
  return TOKENS.map(([token, description]) => `\`${token}\` ${description}`).join('\n');
}

module.exports = {
  TOKENS,
  DEFAULT_SERVER_TEMPLATE,
  DEFAULT_TOTAL_TEMPLATE,
  renderServerTemplate,
  renderTotalTemplate,
  validateTemplate,
  tokenHelp,
};
