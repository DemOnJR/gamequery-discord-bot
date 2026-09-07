'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

/*
  Applies the SQL files in migrations/ at boot, in filename order, once each.

  A self-hoster should not have to run a separate migrate step before the bot
  works: they set DATABASE_URL and start it. Each file runs inside its own
  transaction, so a failure leaves the database on the last good migration
  rather than half-applied, and the bot refuses to start rather than running
  against a schema it cannot trust.
*/

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gq_bot_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER
    )
  `);
}

function listFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function appliedNames() {
  const rows = await db.rows('SELECT name FROM gq_bot_migrations');
  return new Set(rows.map((row) => row.name));
}

async function run() {
  await ensureTable();

  const files = listFiles();
  const applied = await appliedNames();
  const pending = files.filter((name) => !applied.has(name));

  if (pending.length === 0) {
    console.log(`[migrate] schema up to date (${files.length} migrations)`);
    return { applied: 0, total: files.length };
  }

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const client = await db.pool.connect();
    const startedAt = Date.now();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO gq_bot_migrations (name, duration_ms) VALUES ($1, $2)',
        [name, Date.now() - startedAt]
      );
      await client.query('COMMIT');
      console.log(`[migrate] applied ${name} in ${Date.now() - startedAt}ms`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${name} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }

  return { applied: pending.length, total: files.length };
}

module.exports = { run, listFiles };
