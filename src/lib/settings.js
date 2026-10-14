'use strict';
const db = require('../db');

let cache = null;
let cacheAt = 0;

async function all() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await db.many('SELECT key, value FROM system_settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}
async function get(key) { return (await all())[key] || {}; }
async function set(key, value, userId, client = db) {
  await client.query(
    `INSERT INTO system_settings(key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), userId]);
  cache = null;
}
function invalidate() { cache = null; }

module.exports = { all, get, set, invalidate };
