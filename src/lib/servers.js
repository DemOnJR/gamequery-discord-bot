'use strict';

const db = require('./db');
const source = require('./source');
const games = require('./games');
const config = require('../config');

const IP_PORT = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

/*
  The API only accepts dotted-quad IP:port, so a hostname typed into Discord
  would be silently dropped rather than probed. Rejecting it here, with the
  reason, beats accepting a server that will never come online.
*/
function validateAddress(value) {
  const address = normalizeAddress(value);

  if (!address) {
    return { ok: false, reason: 'Enter an address as `ip:port`, for example `203.0.113.10:27015`.' };
  }

  if (!IP_PORT.test(address)) {
    return {
      ok: false,
      reason: 'That address is not in `ip:port` form. Use the numeric IP and the **query** port, not a domain name.',
    };
  }

  const [ip, portRaw] = address.split(':');
  const octets = ip.split('.').map((part) => Number(part));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return { ok: false, reason: 'That IP address has an octet outside 0-255.' };
  }

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: 'That port is outside 1-65535.' };
  }

  return { ok: true, address };
}

/*
  The bot's own server registry.

  History is keyed on gq_servers.id rather than on a guild, so two Discord
  servers watching the same address share one history and it survives an
  untrack. It is the bot's own table rather than the platform's `servers`
  table, which is what lets a self-hosted copy work against its own database.
*/
async function ensureTracked(gameId, address) {
  const game = String(gameId);
  const normalized = normalizeAddress(address);

  await db.query(
    `INSERT INTO gq_servers (game, address)
     VALUES ($1, $2)
     ON CONFLICT (game, address) DO NOTHING`,
    [game, normalized]
  );

  const row = await db.one(
    'SELECT id FROM gq_servers WHERE game = $1 AND address = $2',
    [game, normalized]
  );

  // Registers the address with the query fleet so it starts being probed. In
  // api mode this is POST /v1/post/fetch, which auto-registers; in direct mode
  // it is an insert into the platform's servers table.
  await source.fetchRaw([{ game, address: normalized }]).catch((error) => {
    console.error(`[servers] could not register ${normalized}: ${error.message}`);
  });

  return row ? Number(row.id) : null;
}

function parseUpdatedAt(value) {
  if (!value) {
    return null;
  }

  // The payload stamps "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const isoish = String(value).trim().replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : `${isoish}Z`;
  const parsed = new Date(withZone);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

/*
  Normalises one raw payload into the shape the rest of the bot uses.

  `online` means "we have a fresh successful query", not "the row says online".
  A payload that stopped updating an hour ago is reported as stale, so a counter
  channel never freezes on an old number while claiming to be live.
*/
function buildSnapshot(address, payload, game) {
  const snapshot = {
    address,
    game: game || null,
    name: null,
    map: null,
    players: null,
    maxPlayers: null,
    bots: null,
    ping: null,
    connect: address,
    version: null,
    passworded: null,
    playerNames: [],
    updatedAt: null,
    online: false,
    stale: false,
    known: Boolean(payload),
    lastOnlineAt: null,
    lastProbeAt: null,
    errorName: null,
  };

  if (!payload || typeof payload !== 'object') {
    return snapshot;
  }

  // directSource attaches this when Redis has no payload but the platform row
  // still knows something. The API never sends it.
  const platform = payload._platform;
  if (platform) {
    snapshot.lastProbeAt = platform.lastProbeAt ? new Date(platform.lastProbeAt) : null;
    snapshot.lastOnlineAt = platform.lastOnlineAt ? new Date(platform.lastOnlineAt) : null;
    snapshot.errorName = platform.errorName || null;
  }

  const updatedAt = parseUpdatedAt(payload.updated);
  const ageSeconds = updatedAt ? (Date.now() - updatedAt.getTime()) / 1000 : Infinity;
  const fresh = ageSeconds <= config.maxServerAgeSeconds;

  snapshot.updatedAt = updatedAt;
  snapshot.name = payload.name || null;
  snapshot.map = payload.map || null;
  snapshot.maxPlayers = toInt(payload.maxplayers);
  snapshot.version = payload.version || null;
  snapshot.passworded = typeof payload.password === 'boolean' ? payload.password : null;
  snapshot.connect = payload.connect || address;
  snapshot.bots = Array.isArray(payload.bots)
    ? payload.bots.length
    : toInt(payload.raw && payload.raw.numbots);

  const numplayers = toInt(payload.numplayers);
  if (numplayers !== null) {
    snapshot.players = numplayers;
  }

  const ping = toInt(payload.ping);
  if (ping !== null) {
    snapshot.ping = ping;
  }

  const rawPlayers = Array.isArray(payload.players) && payload.players.length > 0
    ? payload.players
    : (payload.raw && Array.isArray(payload.raw.players) ? payload.raw.players : []);

  snapshot.playerNames = rawPlayers
    .map((player) => {
      if (typeof player === 'string') {
        return { name: player.trim(), score: 0, time: 0 };
      }

      if (!player || typeof player !== 'object') {
        return null;
      }

      const src = player.raw && typeof player.raw === 'object' ? player.raw : player;

      return {
        name: String(player.name || '').trim(),
        score: toInt(src.score) ?? 0,
        time: toInt(src.time) ?? 0,
      };
    })
    .filter((player) => player && player.name !== '');

  // A payload with no timestamp and no name has never been answered.
  snapshot.known = Boolean(updatedAt || payload.name || platform);
  snapshot.online = fresh;
  snapshot.stale = Boolean(updatedAt) && !fresh;

  return snapshot;
}

/*
  Live state for a set of tracked rows. Accepts either {game, address} objects
  or bare addresses, since some callers only have the address to hand.
*/
async function getSnapshots(items) {
  const entries = [];
  const seen = new Set();

  (items || []).forEach((item) => {
    const address = normalizeAddress(typeof item === 'string' ? item : item.address);
    if (!address || seen.has(address)) {
      return;
    }
    seen.add(address);
    entries.push({ address, game: typeof item === 'string' ? null : item.game });
  });

  const result = new Map();

  if (entries.length === 0) {
    return result;
  }

  // An address with no game cannot be sent to the API, so its game is looked up
  // from the registry the bot already maintains.
  const unknown = entries.filter((entry) => !entry.game).map((entry) => entry.address);

  if (unknown.length > 0) {
    const rows = await db.rows(
      'SELECT game, address FROM gq_servers WHERE address = ANY($1::varchar(255)[])',
      [unknown]
    );
    const gameByAddress = new Map(rows.map((row) => [row.address, row.game]));
    entries.forEach((entry) => {
      if (!entry.game) {
        entry.game = gameByAddress.get(entry.address) || null;
      }
    });
  }

  const resolvable = entries.filter((entry) => entry.game);

  let raw = {};
  try {
    raw = await source.fetchRaw(resolvable);
  } catch (error) {
    // A source outage degrades to "unknown", never to a wrong number.
    console.error(`[servers] source fetch failed: ${error.message}`);
  }

  entries.forEach((entry) => {
    result.set(entry.address, buildSnapshot(entry.address, raw[entry.address], entry.game));
  });

  await rememberLastSeen(entries, result).catch(() => {});

  return result;
}

/*
  Keeps a denormalised copy of the last known name and map on gq_servers, so a
  server that is currently unreachable can still be labelled in a list rather
  than shown as a bare ip:port.
*/
async function rememberLastSeen(entries, snapshots) {
  const rows = entries
    .map((entry) => ({ entry, snapshot: snapshots.get(entry.address) }))
    .filter(({ entry, snapshot }) => entry.game && snapshot && snapshot.online);

  if (rows.length === 0) {
    return;
  }

  await db.query(
    `UPDATE gq_servers g
     SET last_hostname = v.hostname,
         last_map = v.map,
         last_players = v.players,
         last_max_players = v.max_players,
         last_online_at = NOW(),
         last_seen_at = NOW()
     FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::int[], $6::int[])
       AS v(game, address, hostname, map, players, max_players)
     WHERE g.game = v.game AND g.address = v.address`,
    [
      rows.map(({ entry }) => entry.game),
      rows.map(({ entry }) => entry.address),
      rows.map(({ snapshot }) => (snapshot.name || '').slice(0, 255)),
      rows.map(({ snapshot }) => (snapshot.map || '').slice(0, 160)),
      rows.map(({ snapshot }) => snapshot.players ?? 0),
      rows.map(({ snapshot }) => snapshot.maxPlayers ?? null),
    ]
  );
}

async function getSnapshot(address, game = null) {
  const map = await getSnapshots([{ address, game }]);
  return map.get(normalizeAddress(address)) || null;
}

function describeGame(gameId) {
  return games.gameName(gameId);
}

module.exports = {
  IP_PORT,
  normalizeAddress,
  validateAddress,
  ensureTracked,
  getSnapshots,
  getSnapshot,
  describeGame,
  buildSnapshot,
};
