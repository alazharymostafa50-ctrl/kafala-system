'use strict';
/**
 * استعادة نسخة احتياطية مشفرة.
 * الاستخدام: npm run restore -- <ملف.kbak> --yes [--target-db postgres://...] [--storage ./storage]
 * تحذير: يستبدل محتوى قاعدة البيانات الهدف والملفات المخزنة.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MAGIC } = require('./backup');

function decrypt(file, pass) {
  const buf = fs.readFileSync(file);
  if (!buf.slice(0, 8).equals(MAGIC)) throw new Error('الملف ليس نسخة احتياطية صالحة لهذا النظام');
  const salt = buf.slice(8, 24); const iv = buf.slice(24, 36); const tag = buf.slice(buf.length - 16); const data = buf.slice(36, buf.length - 16);
  const key = crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(data), d.final()]); } catch (_) { throw new Error('فشل فك التشفير: المفتاح غير صحيح أو الملف تالف'); }
}

function restore(file, { targetDb = process.env.DATABASE_URL, storage = process.env.STORAGE_DIR || 'storage' } = {}) {
  const pass = process.env.BACKUP_KEY;
  if (!pass) throw new Error('BACKUP_KEY مطلوب');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kafres-'));
  try {
    fs.writeFileSync(path.join(tmp, 'bundle.tgz'), decrypt(file, pass));
    execFileSync('tar', ['-xzf', path.join(tmp, 'bundle.tgz'), '-C', tmp, '--no-same-owner']);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    execFileSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--dbname', targetDb, path.join(tmp, 'db.dump')], { stdio: ['ignore', 'ignore', 'pipe'] });
    const st = path.resolve(storage);
    if (fs.existsSync(path.join(tmp, 'files'))) {
      for (const d of fs.readdirSync(path.join(tmp, 'files'))) {
        if (!['documents', 'reports', 'branding'].includes(d)) continue;
        fs.rmSync(path.join(st, d), { recursive: true, force: true });
        fs.cpSync(path.join(tmp, 'files', d), path.join(st, d), { recursive: true });
      }
    }
    return manifest;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => a.endsWith('.kbak'));
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (!file || !args.includes('--yes')) {
    console.error('الاستخدام: npm run restore -- <ملف.kbak> --yes [--target-db URL] [--storage DIR]\nتحذير: ستُستبدل البيانات الحالية في القاعدة الهدف.');
    process.exit(1);
  }
  try { const m = restore(file, { targetDb: opt('--target-db'), storage: opt('--storage') }); console.log('✓ تمت الاستعادة من نسخة', m.created_at); }
  catch (e) { console.error('✗ فشلت الاستعادة:', e.stderr ? e.stderr.toString() : e.message); process.exit(1); }
}
module.exports = { restore, decrypt };
