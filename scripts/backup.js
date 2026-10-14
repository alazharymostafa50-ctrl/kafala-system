'use strict';
/**
 * نسخة احتياطية مشفرة: قاعدة البيانات (pg_dump) + المستندات والتقارير المحفوظة والشعار.
 * التشفير: AES-256-GCM بمفتاح مشتق (scrypt) من BACKUP_KEY. احتفظ بالمفتاح خارج الخادم.
 * الاستخدام: npm run backup  [-- --out /path/to/dir]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAGIC = Buffer.from('KAFBAK01');

function encryptFile(src, dest, pass) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(fs.readFileSync(src)), cipher.final()]);
  fs.writeFileSync(dest, Buffer.concat([MAGIC, salt, iv, enc, cipher.getAuthTag()]), { mode: 0o600 });
}

function backup({ outDir } = {}) {
  const pass = process.env.BACKUP_KEY;
  if (!pass || pass.length < 16) throw new Error('BACKUP_KEY مطلوب (16 حرفًا على الأقل)');
  const storage = path.resolve(process.env.STORAGE_DIR || 'storage');
  outDir = path.resolve(outDir || path.join(storage, 'backups'));
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kafbak-'));
  try {
    execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(tmp, 'db.dump'), process.env.DATABASE_URL], { stdio: ['ignore', 'ignore', 'pipe'] });
    const parts = ['db.dump'];
    for (const d of ['documents', 'reports', 'branding']) {
      if (fs.existsSync(path.join(storage, d))) { fs.cpSync(path.join(storage, d), path.join(tmp, 'files', d), { recursive: true }); }
    }
    if (fs.existsSync(path.join(tmp, 'files'))) parts.push('files');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ created_at: new Date().toISOString(), format: 1, parts }));
    parts.push('manifest.json');
    execFileSync('tar', ['-czf', path.join(tmp, 'bundle.tgz'), '-C', tmp, ...parts]);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const dest = path.join(outDir, `kafala-${stamp}.kbak`);
    encryptFile(path.join(tmp, 'bundle.tgz'), dest, pass);
    return dest;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  try { const f = backup({ outDir: i > 0 ? process.argv[i + 1] : undefined }); console.log('✓ تم إنشاء النسخة الاحتياطية المشفرة:', f); }
  catch (e) { console.error('✗ فشل النسخ الاحتياطي:', e.stderr ? e.stderr.toString() : e.message); process.exit(1); }
}
module.exports = { backup, MAGIC };
