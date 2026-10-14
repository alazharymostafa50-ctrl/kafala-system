'use strict';
const db = require('../db');

// حقول لا تُسجَّل أبدًا في سجل التدقيق
const SECRET = new Set(['password_hash', 'password', 'totp_secret', 'new_password', 'current_password', '_csrf']);
// حقول حساسة تُخفى جزئيًا في السجل
const MASK = new Set(['national_id', 'iban']);

function clean(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET.has(k)) continue;
    if (MASK.has(k) && v) { const s = String(v); out[k] = '•••' + s.slice(-4); continue; }
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * تسجيل عملية في سجل التدقيق.
 * @param {object} ctx { user, ip } أو req
 */
async function log(ctx, action, entity, entityId, { before, after, reason } = {}, client = db) {
  const user = ctx?.user || ctx?.session?.user || null;
  const ip = ctx?.ip || null;
  await client.query(
    `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, before_data, after_data, reason, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user?.id || null, user?.username || 'system', action, entity, entityId == null ? null : String(entityId),
      before ? JSON.stringify(clean(before)) : null, after ? JSON.stringify(clean(after)) : null, reason || null, ip]);
}

/** إرجاع الحقول التي تغيرت فقط */
function diff(before, after) {
  const b = {}; const a = {};
  for (const k of Object.keys(after)) {
    const bv = before?.[k] ?? null; const av = after[k] ?? null;
    if (String(bv) !== String(av)) { b[k] = bv; a[k] = av; }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

module.exports = { log, diff, clean };
