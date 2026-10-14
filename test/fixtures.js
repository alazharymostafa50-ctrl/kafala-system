'use strict';
// مولدات بيانات اختبار اصطناعية
const { idFrom, db } = require('./helpers');
const U = require('../src/lib/util');

let phoneSeq = 1000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function family(c, over = {}) {
  const r = await c.post('/families', {
    family_name: 'أسرة اختبار ' + phoneSeq, g_full_name: 'ولي أمر اختبار', g_phone: '0100' + String(phoneSeq++).padStart(7, '0'),
    calc_method: 'per_member', monthly_amount: '0', status: 'active', ...over,
  });
  if (r.status !== 302 || !/\/families\/\d+$/.test(r.headers.location)) throw new Error('فشل إنشاء الأسرة: ' + r.headers.location);
  return idFrom(r);
}

async function member(c, familyId, over = {}) {
  await c.post(`/families/${familyId}/members`, {
    full_name: 'مستفيد ' + Math.random().toString(36).slice(2, 7), birth_date: U.addDays(U.todayISO(), -10 * 365), gender: 'male', relation: 'ابن',
    is_orphan: '1', monthly_amount: '500', eligibility_status: 'eligible', ...over,
  });
  return db.one('SELECT * FROM family_members WHERE family_id=$1 ORDER BY id DESC LIMIT 1', [familyId]);
}

async function donation(c, over = {}) {
  const r = await c.post('/donations', { type_code: 'orphans', donor_name: 'متبرع', amount: '10000', donation_date: U.todayISO(), payment_method: 'cash', collect_now: '1', ...over });
  return idFrom(r);
}

module.exports = { family, member, donation, PNG, PDF };
