'use strict';

const config = require('../../config');
const apiSource = require('./apiSource');
const directSource = require('./directSource');

/*
  Picks where live server data comes from.

  `api`    the public gamequery.dev API. The default, and the only mode a
           self-hosted copy can use. Needs a gamequery.dev API key.
  `direct` the platform's own Redis and Postgres. Only works inside our
           cluster; skips the HTTP hop and the API quota.

  A gamequery.dev API key is required in BOTH modes. The bot is a client of the
  gamequery.dev service, not a standalone program that happens to speak game
  protocols, and nothing here queries a game server on its own.
*/

function selected() {
  return config.source === 'direct' ? directSource : apiSource;
}

function name() {
  return config.source === 'direct' ? 'direct' : 'api';
}

async function verify() {
  return selected().verify();
}

async function listGames() {
  return selected().listGames();
}

async function fetchRaw(entries) {
  const cleaned = (entries || [])
    .filter((entry) => entry && entry.game && entry.address)
    .map((entry) => ({ game: String(entry.game), address: String(entry.address) }));

  if (cleaned.length === 0) {
    return {};
  }

  return selected().fetchRaw(cleaned);
}

module.exports = { selected, name, verify, listGames, fetchRaw };
