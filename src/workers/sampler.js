'use strict';

const store = require('../lib/store');
const servers = require('../lib/servers');
const history = require('../lib/history');
const config = require('../config');

/*
  Records one player-count sample for every server any live guild tracks. It
  reads the cache the worker fleet already fills rather than querying anything
  itself, so a hundred guilds tracking the same popular server cost one Redis
  read, not a hundred UDP packets.
*/
async function tick() {
  const tracked = await store.allActiveTrackedServers();

  if (tracked.length === 0) {
    return { sampled: 0 };
  }

  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));

  const entries = tracked
    .map((row) => {
      const snapshot = snapshots.get(row.address);

      if (!snapshot) {
        return null;
      }

      return {
        serverId: Number(row.server_id),
        players: snapshot.online && snapshot.players !== null ? snapshot.players : 0,
        maxPlayers: snapshot.maxPlayers,
        online: Boolean(snapshot.online),
      };
    })
    .filter(Boolean);

  const sampled = await history.recordSamples(entries);

  if (config.debug) {
    console.log(`[sampler] recorded ${sampled} samples across ${tracked.length} tracked servers`);
  }

  return { sampled };
}

module.exports = { tick };
