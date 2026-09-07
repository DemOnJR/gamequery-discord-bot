'use strict';

const db = require('../db');
const redisClient = require('../redisClient');
const games = require('../games');

/*
  Reads the platform's own Redis and Postgres directly.

  This only works INSIDE the gamequery.dev cluster and is not something a
  self-hosted copy can use: it needs the credentials for our Redis and our
  `servers` table. It exists because the hosted instance can skip the HTTP hop
  and the API quota entirely, reading the same payloads the API would have
  returned.

  Anyone running this bot themselves wants apiSource. GAMEQUERY_SOURCE defaults
  to `api` for exactly that reason; `direct` has to be asked for.
*/

function available() {
  return Boolean(process.env.REDIS_HOST && process.env.DB_HOST);
}

async function verify() {
  if (!available()) {
    return {
      ok: false,
      reason:
        'GAMEQUERY_SOURCE=direct needs REDIS_HOST and DB_HOST for the gamequery platform. '
        + 'If you are self-hosting, use GAMEQUERY_SOURCE=api instead.',
    };
  }

  try {
    await db.query('SELECT 1 FROM servers LIMIT 1');
  } catch (error) {
    return { ok: false, reason: `platform servers table unreachable: ${error.message}` };
  }

  if (!redisClient.isReady()) {
    return { ok: false, reason: 'platform Redis is not connected' };
  }

  return { ok: true, detail: 'platform redis + postgres' };
}

async function listGames() {
  // The catalogue ships in the image; there is no reason to fetch it.
  return games.all();
}

/*
  Registers the address in the platform's servers table, which is what makes the
  distributed worker fleet start probing it. Mirrors POST /v1/post/fetch, which
  is how the API path achieves the same thing.
*/
async function registerAddresses(entries) {
  if (entries.length === 0) {
    return;
  }

  const gameIds = entries.map((entry) => entry.game);
  const addresses = entries.map((entry) => entry.address);
  const unique = Array.from(new Set(addresses));

  await db.query(
    'DELETE FROM servers WHERE game = $1 AND server = ANY($2::varchar(255)[])',
    ['0', unique]
  );

  await db.query(
    `INSERT INTO servers (game, server)
     SELECT DISTINCT game, server
     FROM UNNEST($1::varchar(128)[], $2::varchar(255)[]) AS rows(game, server)
     ON CONFLICT (game, server) DO NOTHING`,
    [gameIds, addresses]
  );
}

/*
  Returns raw payloads keyed by address, in the same shape the API returns, so
  callers cannot tell the two sources apart.
*/
async function fetchRaw(entries) {
  await registerAddresses(entries);

  const addresses = Array.from(new Set(entries.map((entry) => entry.address)));
  const payloads = await redisClient.getServerPayloads(addresses);
  const result = {};

  payloads.forEach((value, address) => {
    result[address] = value;
  });

  /*
    Redis holds no payload for a server that has never answered. The platform's
    servers table still knows its status and last hostname, so a minimal payload
    is synthesised rather than reporting the address as entirely unknown.
  */
  const missing = addresses.filter((address) => !result[address]);

  if (missing.length > 0) {
    const rows = await db.rows(
      `SELECT server, server_status, last_hostname, last_player_count,
              last_query_latency_ms, last_probe_at, last_online_at, last_error_name
       FROM servers
       WHERE server = ANY($1::varchar(255)[]) AND game <> '0'`,
      [missing]
    );

    rows.forEach((row) => {
      result[row.server] = {
        name: row.last_hostname || null,
        numplayers: row.last_player_count,
        ping: row.last_query_latency_ms,
        connect: row.server,
        _platform: {
          status: row.server_status,
          lastProbeAt: row.last_probe_at,
          lastOnlineAt: row.last_online_at,
          errorName: row.last_error_name,
        },
      };
    });
  }

  return result;
}

module.exports = { verify, listGames, fetchRaw, available };
