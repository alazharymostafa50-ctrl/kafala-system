'use strict';
/**
 * رفع الملفات بأمان: فحص المحتوى الفعلي (Magic bytes)، أسماء عشوائية،
 * والتخزين داخل قاعدة البيانات (جدول stored_files) — لا توجد ملفات على قرص عام.
 */
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const U = require('./util');

const SIGS = [
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: '.webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];

function memoryUpload(maxMb = 4) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 30 } });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** حفظ ملف خام بمفتاح محدد (داخل المعاملة إن مُرِّرت) */
async function putFile(c, key, buffer, mime) {
  await c.query('INSERT INTO stored_files (key, mime_type, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5)',
    [key, mime, buffer.length, sha256(buffer), buffer]);
  return { key, sha256: sha256(buffer) };
}

/** استبدال ملف (للشعار فقط؛ ملفات التقارير محمية من الاستبدال) */
async function replaceFile(c, key, buffer, mime) {
  await c.query(`INSERT INTO stored_files (key, mime_type, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (key) DO UPDATE SET mime_type=EXCLUDED.mime_type, size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256, data=EXCLUDED.data, created_at=now()`,
  [key, mime, buffer.length, sha256(buffer), buffer]);
}

async function getFile(key, c = db) {
  return c.one('SELECT key, mime_type, size_bytes, sha256, data FROM stored_files WHERE key=$1', [key]);
}

/** التحقق من نوع المستند من محتواه وحفظه */
async function storeDocument(c, file) {
  if (!file || !file.buffer || !file.size) throw new U.UserError('لم يتم اختيار ملف');
  const sig = SIGS.find((s) => s.test(file.buffer));
  if (!sig) throw new U.UserError('نوع الملف غير مسموح. المسموح: PDF أو JPG أو PNG أو WEBP (تم فحص محتوى الملف فعليًا)');
  if (sig.mime === 'application/pdf' && /\/JavaScript|\/JS\s|\/Launch|\/EmbeddedFile/.test(file.buffer.toString('latin1'))) {
    throw new U.UserError('ملف PDF يحتوي على عناصر نشطة غير مسموح بها');
  }
  const stored = 'documents/' + crypto.randomUUID() + sig.ext;
  await putFile(c, stored, file.buffer, sig.mime);
  const original = String(file.originalname || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200);
  return { stored_name: stored, mime_type: sig.mime, size_bytes: file.size, sha256: sha256(file.buffer), original_name: original };
}

module.exports = { memoryUpload, storeDocument, putFile, replaceFile, getFile, sha256, SIGS };
