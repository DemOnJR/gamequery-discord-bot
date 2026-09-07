'use strict';

const { Pool } = require('pg');
const config = require('../config');

/*
  DATABASE_URL wins when it is set, which is what a self-hoster provides and
  what every managed Postgres hands you. The discrete DB_* variables are the
  shape the hosted deployment already supplies, so both work rather than one
  environment having to translate into the other's format.
*/
const poolConfig = config.db.connectionString
  ? { connectionString: config.db.connectionString }
  : {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  };

if (config.db.ssl) {
  // Managed providers terminate TLS with a certificate the container has no
  // root for; the connection is still encrypted.
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool({
  ...poolConfig,
  max: config.db.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  console.error('[db] idle client error:', error.message);
});

function query(text, params) {
  return pool.query(text, params);
}

async function rows(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function one(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

module.exports = { pool, query, rows, one };
