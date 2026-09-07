'use strict';

const { createClient } = require('redis');
const config = require('../config');

const client = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
  password: config.redis.password,
  database: config.redis.database,
});

let ready = false;

client.on('error', (error) => {
  // Redis holds the live server payloads. Losing it degrades the bot to
  // "last known values from Postgres" rather than taking it down, so this is
  // logged and swallowed instead of thrown.
  console.error('[redis] error:', error.message);
});

client.on('ready', () => {
  ready = true;
});

client.on('end', () => {
  ready = false;
});

async function connect() {
  if (!client.isOpen) {
    await client.connect();
  }
  ready = true;
}

function isReady() {
  return ready && client.isOpen;
}

/*
  Reads the same keys the v1 API serves. A miss is normal for a server that has
  never been probed successfully; callers fall back to the servers table.
*/
async function getServerPayloads(addresses) {
  const result = new Map();
  const unique = Array.from(new Set(addresses)).filter(Boolean);

  if (unique.length === 0 || !isReady()) {
    return result;
  }

  try {
    const keys = unique.map((address) => `${config.redis.keyPrefix}${address}`);
    const values = await client.mGet(keys);

    values.forEach((value, index) => {
      if (!value) {
        return;
      }

      try {
        result.set(unique[index], JSON.parse(value));
      } catch {
        // A corrupt cache entry is treated as a miss.
      }
    });
  } catch (error) {
    console.error('[redis] mGet failed:', error.message);
  }

  return result;
}

module.exports = { client, connect, isReady, getServerPayloads };
