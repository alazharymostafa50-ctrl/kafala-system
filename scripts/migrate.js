'use strict';
// تطبيق ترحيلات قاعدة البيانات بالترتيب، مرة واحدة لكل ملف
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate({ quiet = false } = {}) {
  const client = await pool.connect();
  try {
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      // كل ترحيل في معاملة مع قفل يمنع تطبيقه مرتين عند تشغيل عدة نسخ معًا (مثل الاستضافة السحابية)
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('kafala-migrate'))");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
        if (done.rowCount) { await client.query('COMMIT'); continue; }
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        if (!quiet) console.log('✓ تم تطبيق', f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`فشل الترحيل ${f}: ${e.message}`);
      }
    }
    if (!quiet) console.log('قاعدة البيانات محدّثة.');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { migrate };
