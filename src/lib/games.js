'use strict';

const fs = require('fs');
const config = require('../config');

let catalog = [];
let byId = new Map();

// A short list that covers most of what Discord communities actually run, used
// to order autocomplete so the common answer is the first one offered.
const POPULAR = [
  'counterstrike16',
  'counterstrike2',
  'csgo',
  'css',
  'rust',
  'minecraft',
  'garrysmod',
  'teamfortress2',
  'ase',
  'asa',
  'dayz',
  'valheim',
  'l4d2',
  'squad',
  'unturned',
  'sdtd',
  'projectzomboid',
  'palworld',
  'conanexiles',
  'insurgencysandstorm',
];

function load() {
  try {
    const raw = fs.readFileSync(config.gamesJsonPath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('games.json is not an array');
    }

    catalog = parsed
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => ({ id: String(entry.id), name: String(entry.name || entry.id) }));

    byId = new Map(catalog.map((entry) => [entry.id.toLowerCase(), entry]));
    console.log(`[games] loaded ${catalog.length} games from ${config.gamesJsonPath}`);
  } catch (error) {
    console.error(`[games] failed to load ${config.gamesJsonPath}:`, error.message);
    catalog = [];
    byId = new Map();
  }

  return catalog;
}

function isValidGame(gameId) {
  return byId.has(String(gameId || '').toLowerCase());
}

function getGame(gameId) {
  return byId.get(String(gameId || '').toLowerCase()) || null;
}

function gameName(gameId) {
  const game = getGame(gameId);
  return game ? game.name : String(gameId || 'Unknown');
}

function search(term, limit = 25) {
  const needle = String(term || '').trim().toLowerCase();

  if (!needle) {
    const popular = POPULAR.map((id) => byId.get(id)).filter(Boolean);
    const rest = catalog.filter((entry) => !POPULAR.includes(entry.id));
    return popular.concat(rest).slice(0, limit);
  }

  const startsWith = [];
  const contains = [];

  catalog.forEach((entry) => {
    const id = entry.id.toLowerCase();
    const name = entry.name.toLowerCase();

    if (id.startsWith(needle) || name.startsWith(needle)) {
      startsWith.push(entry);
    } else if (id.includes(needle) || name.includes(needle)) {
      contains.push(entry);
    }
  });

  return startsWith.concat(contains).slice(0, limit);
}

function count() {
  return catalog.length;
}

function all() {
  return catalog.slice();
}

/*
  Replaces the bundled catalogue with the live one from the API. The bundled
  copy is a snapshot taken at build time; a self-hosted bot running an old image
  would otherwise reject a game the API had since added.
*/
function replace(entries) {
  const next = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => ({ id: String(entry.id), name: String(entry.name || entry.id) }));

  if (next.length === 0) {
    return catalog.length;
  }

  catalog = next;
  byId = new Map(catalog.map((entry) => [entry.id.toLowerCase(), entry]));
  return catalog.length;
}

module.exports = { load, isValidGame, getGame, gameName, search, count, all, replace };
