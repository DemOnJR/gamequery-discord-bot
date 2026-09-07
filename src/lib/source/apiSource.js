'use strict';

const config = require('../../config');

/*
  Talks to the public gamequery.dev API.

  This is the path every self-hosted copy of the bot takes, and the reason the
  bot requires a gamequery.dev API key: without one there is nothing to query.
  The key is not decoration and is not optional; the bot refuses to boot without
  a working one (see verify() and src/index.js).

  Two behaviours of the API shape the code here:

    - POST /v1/post/fetch AUTO-REGISTERS any address it has not seen. That is
      also how a newly tracked server enters the probe fleet, so ensureTracked()
      is a fetch rather than a separate call.
    - It takes up to 1000 servers per request. Batching therefore matters: a
      guild tracking 25 servers costs ONE request, not 25. On the FREE package's
      1440 requests/day, a five-minute sampler uses 288 of them regardless of
      how many servers are tracked.
*/

const SERVERS_PER_REQUEST = 1000;

function baseUrl() {
  return String(config.api.baseUrl || '').replace(/\/+$/, '');
}

function headers() {
  return {
    'x-api-token': config.api.token,
    'x-api-token-type': config.api.type,
    'x-api-token-email': config.api.email,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': `gamequery-discord-bot/${config.version}`,
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function request(path, options = {}) {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.api.timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      /*
        A wrong host is the classic failure here. gamequery.dev serves the SPA
        for any unmatched path, so pointing the bot at the website instead of
        api.gamequery.dev returns HTML with a 200 and the parse fails far from
        the cause. Saying so explicitly saves the next person an hour.
      */
      throw new Error(
        `${path} returned ${response.status} with a non-JSON body. `
        + `Check GAMEQUERY_API_URL is the API host (${config.api.baseUrl}), not the website.`
      );
    }

    if (!response.ok) {
      const message = payload && payload.message ? payload.message : `HTTP ${response.status}`;
      const error = new Error(`${path}: ${message}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/*
  Confirms the credentials actually work before the bot claims to be running.
  A key that is missing, revoked, of the wrong package type, or attached to a
  different email fails identically from the user's side (nothing updates), so
  the boot check reports which of those it is.
*/
async function verify() {
  if (!config.api.token || !config.api.email || !config.api.type) {
    return {
      ok: false,
      reason:
        'GAMEQUERY_API_TOKEN, GAMEQUERY_API_EMAIL and GAMEQUERY_API_TYPE must all be set. '
        + 'Create a key at https://gamequery.dev/dashboard/keys.',
    };
  }

  try {
    const payload = await request('/v1/post/fetch', {
      method: 'POST',
      body: JSON.stringify({ servers: [{ game_id: 'counterstrike16', servers: ['127.0.0.1:27015'] }] }),
    });

    return { ok: true, detail: payload && payload._meta ? 'api reachable' : 'api reachable' };
  } catch (error) {
    if (error.status === 401) {
      return {
        ok: false,
        reason:
          `The API rejected the credentials: ${error.message}. `
          + 'GAMEQUERY_API_TYPE must be exactly FREE or PRO and must match the key, '
          + 'and GAMEQUERY_API_EMAIL must be the account the key belongs to.',
      };
    }

    if (error.status === 403) {
      return {
        ok: false,
        reason:
          `The API refused this origin: ${error.message}. `
          + 'The key has an IP or domain whitelist set; clear it or add this host.',
      };
    }

    return { ok: false, reason: `Could not reach the API: ${error.message}` };
  }
}

async function listGames() {
  const payload = await request('/v1/get/games', { method: 'GET' });
  return Array.isArray(payload) ? payload : [];
}

/*
  Fetches live state for a set of addresses. Entries are grouped by game because
  that is the request shape the API takes, and split into batches of 1000.
*/
async function fetchRaw(entries) {
  const byGame = new Map();

  entries.forEach(({ game, address }) => {
    if (!byGame.has(game)) {
      byGame.set(game, new Set());
    }
    byGame.get(game).add(address);
  });

  const groups = Array.from(byGame.entries()).map(([game, addresses]) => ({
    game_id: game,
    servers: Array.from(addresses),
  }));

  // Flatten to a server budget rather than a group budget: one game with 1500
  // servers must still be split, and fifty games with ten each must not be.
  const batches = [];
  let current = [];
  let currentCount = 0;

  groups.forEach((group) => {
    chunk(group.servers, SERVERS_PER_REQUEST).forEach((servers) => {
      if (currentCount + servers.length > SERVERS_PER_REQUEST && current.length > 0) {
        batches.push(current);
        current = [];
        currentCount = 0;
      }

      current.push({ game_id: group.game_id, servers });
      currentCount += servers.length;
    });
  });

  if (current.length > 0) {
    batches.push(current);
  }

  const merged = {};

  for (const servers of batches) {
    const payload = await request('/v1/post/fetch', {
      method: 'POST',
      body: JSON.stringify({ servers }),
    });

    Object.entries(payload || {}).forEach(([key, value]) => {
      if (key !== '_meta') {
        merged[key] = value;
      }
    });
  }

  return merged;
}

module.exports = { verify, listGames, fetchRaw, SERVERS_PER_REQUEST, request };
