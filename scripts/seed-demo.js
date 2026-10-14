'use strict';
/**
 * بيانات تجريبية اصطناعية بالكامل (أسماء مولدة، أرقام وهمية) لأغراض التدريب والاختبار فقط.
 * يرفض العمل في بيئة الإنتاج. الاستخدام: npm run seed:demo -- --families 40
 */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { migrate } = require('./migrate');
const U = require('../src/lib/util');
const donations = require('../src/lib/donations');
const ent = require('../src/lib/entitlements');
const elig = require('../src/lib/eligibility');
const finance = require('../src/lib/finance');

if (process.env.NODE_ENV === 'production') { console.error('✗ لا يُسمح بالبيانات التجريبية في بيئة الإنتاج'); process.exit(1); }

const FIRST_M = ['أحمد', 'محمد', 'يوسف', 'عمر', 'خالد', 'إبراهيم', 'حسن', 'علي', 'مصطفى', 'عبدالله', 'كريم', 'زياد'];
const FIRST_F = ['فاطمة', 'مريم', 'سارة', 'نور', 'آمنة', 'خديجة', 'هبة', 'رقية', 'زينب', 'ملك', 'جنى', 'سلمى'];
const LAST = ['السيد', 'عبدالرحمن', 'الشافعي', 'منصور', 'البدري', 'سليمان', 'عثمان', 'رمضان', 'الحسيني', 'عطية', 'النجار', 'فرج'];
const CITIES = ['طنطا', 'طنط الجزيرة', 'قويسنا', 'بنها', 'شبين الكوم'];
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const n = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

(async () => {
  await migrate({ quiet: true });
  const arg = process.argv.indexOf('--families');
  const N = arg > 0 ? Number(process.argv[arg + 1]) : 30;
  const today = U.todayISO();

  // مستخدمو تجربة لكل دور (كلمة المرور موحدة للتجربة فقط)
  const pw = await bcrypt.hash('Demo12345pass', 12);
  const demoUsers = [['manager1', 'مدير الكفالات (تجريبي)', 'manager'], ['social1', 'باحث اجتماعي (تجريبي)', 'social_worker'], ['accountant1', 'محاسب (تجريبي)', 'accountant'], ['cashier1', 'أمين صندوق (تجريبي)', 'cashier'], ['auditor1', 'مراجع (تجريبي)', 'auditor']];
  for (const [u, name, role] of demoUsers) {
    const r = await db.one(`INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`, [u, name, pw]);
    await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2 ON CONFLICT DO NOTHING`, [r.id, role]);
  }
  const acc = await db.one(`SELECT id, username FROM users WHERE username='accountant1'`);
  const mgr = await db.one(`SELECT id, username FROM users WHERE username='manager1'`);
  const cashier = await db.one(`SELECT id, username FROM users WHERE username='cashier1'`);

  await db.tx(async (c) => {
    // رصيد افتتاحي
    const has = await c.one(`SELECT 1 FROM financial_adjustments WHERE kind='opening'`);
    if (!has) {
      const start = U.addMonths(today, -3).slice(0, 8) + '01';
      for (const [fund, amt] of [['general', '25000.00'], ['orphans', '60000.00']]) {
        const lid = await finance.post(c, { date: start, fund, direction: 'in', amount: amt, source_type: 'opening', description: 'رصيد افتتاحي (تجريبي)', user: acc });
        await c.query(`INSERT INTO financial_adjustments (adj_date, period, fund_code, direction, amount, kind, reason, ledger_id, created_by) VALUES ($1,$2,$3,'in',$4,'opening','رصيد افتتاحي تجريبي',$5,$6)`, [start, start.slice(0, 7), fund, amt, lid, acc.id]);
      }
    }
    const famIds = [];
    for (let i = 0; i < N; i++) {
      const last = pick(LAST);
      const method = pick(['family_fixed', 'per_member', 'per_member', 'mixed']);
      const f = await c.one(`INSERT INTO families (family_name, opened_on, status, city, district, address, calc_method, monthly_amount, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [`أسرة ${pick(FIRST_M)} ${last}`, U.addMonths(today, -n(4, 30)), i % 13 === 5 ? 'suspended' : i % 11 === 3 ? 'under_review' : 'active', pick(CITIES), 'حي ' + n(1, 9),
          'شارع تجريبي ' + n(1, 99), method, method === 'per_member' ? '0' : String(n(4, 10) * 100) + '.00', mgr.id]);
      famIds.push(f.id);
      await c.query(`INSERT INTO guardians (family_id, full_name, relation, phone, payout_method) VALUES ($1,$2,'الأم',$3,$4)`,
        [f.id, `${pick(FIRST_F)} ${pick(FIRST_M)} ${pick(FIRST_M)} ${last}`, '010' + String(10000000 + i * 7919).slice(0, 8), pick(['cash', 'bank_transfer', 'wallet'])]);
      const kids = n(1, 4);
      for (let k = 0; k < kids; k++) {
        const male = rnd() < 0.5;
        // أعمار متنوعة تشمل حالات حول سن 18
        const special = i % 6 === 0 && k === 0;
        const birth = special ? U.addDays(U.addMonths(today, -18 * 12 + n(-2, 2)), n(-20, 20)) : U.addDays(today, -n(3, 17) * 365 - n(0, 300));
        const st = rnd() < 0.9 ? 'eligible' : 'under_review';
        const m = await c.one(`INSERT INTO family_members (family_id, full_name, birth_date, gender, relation, study_status, eligibility_status, monthly_amount, sponsorship_start, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [f.id, `${male || special ? pick(FIRST_M) : pick(FIRST_F)} ${pick(FIRST_M)} ${pick(FIRST_M)} ${last}`, birth, male || special ? 'male' : 'female', male || special ? 'ابن' : 'ابنة',
            U.ageOn(birth) >= 18 ? 'طالب جامعي' : 'طالب مدرسة', st, String(n(2, 5) * 100) + '.00', U.addMonths(today, -n(1, 20)), mgr.id]);
        await c.query(`INSERT INTO eligibility_decisions (member_id, new_status, reason, kind, age_at_decision, decided_by) VALUES ($1,$2,'بيانات تجريبية','initial',$3,$4)`, [m.id, st, U.ageOn(birth), mgr.id]);
      }
    }
    // الكفلاء والربط
    for (let s = 0; s < Math.ceil(N * 0.7); s++) {
      const sp = await c.one(`INSERT INTO sponsors (full_name, phone, monthly_pledge, start_date, status, payment_method, created_by) VALUES ($1,$2,$3,$4,$5,'تحويل شهري',$6) RETURNING id`,
        [`${pick(FIRST_M)} ${pick(FIRST_M)} ${pick(LAST)}`, '011' + String(20000000 + s * 4931).slice(0, 8), '0', U.addMonths(today, -n(3, 24)), s % 9 === 4 ? 'stopped' : 'active', acc.id]);
      const links = n(1, 2); let total = 0;
      for (let l = 0; l < links; l++) {
        const fid = famIds[(s * 2 + l) % famIds.length];
        const amt = n(3, 8) * 100; total += amt;
        await c.query(`INSERT INTO family_sponsorships (sponsor_id, family_id, monthly_amount, start_date, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [sp.id, fid, amt, U.addMonths(today, -n(2, 12)), acc.id]);
      }
      await c.query('UPDATE sponsors SET monthly_pledge=$2 WHERE id=$1', [sp.id, total]);
    }
  });

  // تبرعات ومساهمات وكشوف للأشهر الثلاثة الماضية والحالي
  for (let back = 2; back >= 0; back--) {
    const period = U.addMonths(today, -back).slice(0, 7);
    const date = back === 0 ? today : U.periodStart(period).slice(0, 8) + '10';
    await db.tx(async (c) => {
      const sps = await c.many(`SELECT id, full_name, monthly_pledge FROM sponsors WHERE status='active'`);
      for (const sp of sps) {
        if (rnd() < 0.8) await donations.create(c, { type_code: 'sponsor', sponsor_id: sp.id, donor_name: sp.full_name, amount: rnd() < 0.85 ? sp.monthly_pledge : U.fromCents(U.toCents(sp.monthly_pledge) / 2), donation_date: date, payment_method: 'bank_transfer', period }, acc, null, { collectNow: true });
      }
      for (let d = 0; d < 6; d++) {
        await donations.create(c, { type_code: pick(['general', 'orphans', 'general']), donor_name: 'فاعل خير ' + n(1, 99), amount: String(n(5, 50) * 100), donation_date: date, payment_method: pick(['cash', 'bank_transfer']), period }, acc, null, { collectNow: d < 5 });
      }
      const e = await c.one(`INSERT INTO expenses (expense_date, category_code, fund_code, description, amount, payee, period, status, created_by, approved_by, approved_at) VALUES ($1,'operational','general','إيجار ومرافق المقر (تجريبي)',$2,'مالك المقر',$3,'approved',$4,$5,now()) RETURNING *`, [date, String(n(15, 30) * 100), period, acc.id, mgr.id]);
      await finance.post(c, { date, fund: 'general', direction: 'out', amount: e.amount, source_type: 'expense', source_id: e.id, description: `مصروف ${e.expense_no}`, user: acc });
      await c.query(`UPDATE expenses SET status='paid', paid_by=$2, paid_at=now() WHERE id=$1`, [e.id, acc.id]);
    });
    await elig.runEngine({ today: date });
    await db.tx(async (c) => {
      const exists = await c.one('SELECT 1 FROM monthly_runs WHERE period=$1', [period]);
      if (!exists) await ent.generate(c, period, mgr);
      const rows = await c.many(`SELECT id, amount_due, amount_paid FROM monthly_entitlements WHERE period=$1 ORDER BY id`, [period]);
      let k = 0;
      for (const r of rows) {
        k++;
        const remaining = U.toCents(r.amount_due) - U.toCents(r.amount_paid);
        if (remaining <= 0) continue;
        if (back === 0 && k % 3 === 0) continue; // لم يستلم بعد
        const amt = back === 0 && k % 4 === 0 ? U.fromCents(Math.floor(remaining / 2)) : U.fromCents(remaining);
        await ent.disburse(c, r.id, { amount: amt, date, method: 'cash', fund: 'orphans', idempotency_key: `seed-${period}-${r.id}-${amt}`, reference: 'S-' + r.id }, cashier);
      }
    });
  }
  await elig.runEngine();
  console.log(`✓ تم إنشاء بيانات تجريبية: ${N} أسرة. مستخدمو التجربة: manager1 / social1 / accountant1 / cashier1 / auditor1 — كلمة المرور: Demo12345pass`);
  await db.pool.end();
})().catch(async (e) => { console.error(e); await db.pool.end(); process.exit(1); });
