'use strict';
// المصادقة الثنائية TOTP (RFC 6238) دون اعتماديات خارجية
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
function verify(secret, token, window = 1, now = Date.now()) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const c = Math.floor(now / 30000);
  for (let i = -window; i <= window; i++) {
    const a = Buffer.from(hotp(secret, c + i)); const b = Buffer.from(String(token));
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
function otpauthUrl(secret, account, issuer) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
module.exports = { generateSecret, verify, hotp, otpauthUrl };
