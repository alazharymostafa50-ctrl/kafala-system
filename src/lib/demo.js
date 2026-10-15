'use strict';
/**
 * بيانات تجريبية (وهمية بالكامل) داخل النظام الحقيقي لتجربة كل الشاشات،
 * مع حذفها كلها بضغطة زرار لاحقًا دون المساس بالبيانات الحقيقية.
 * كل السجلات الأساسية عليها علامة is_demo، والأسماء مكتوب بجانبها «(تجريبي)».
 */
const db = require('../db');
const U = require('./util');
const finance = require('./finance');
const donations = require('./donations');
const ent = require('./entitlements');
const audit = require('./audit');

const TAG = ' (تجريبي)';
const FAMS = [
  { g: 'فاطمة محمد عبد الله', fam: 'أسرة محمد عبد الله', support: 'kafala', calc: 'family_fixed', amount: 600, aid: 0, kids: [['أحمد محمد عبد الله', 'male', 9], ['مريم محمد عبد الله', 'female', 6]] },
  { g: 'سعاد علي إبراهيم', fam: 'أسرة علي إبراهيم', support: 'both', calc: 'per_member', amount: 0, aid: 250, aidNote: 'إيجار', kids: [['يوسف علي إبراهيم', 'male', 12], ['نور علي إبراهيم', 'female', 8], ['عمر علي إبراهيم', 'male', 4]] },
  { g: 'هدى السيد عطية', fam: 'أسرة السيد عطية', support: 'aid', calc: 'family_fixed', amount: 0, aid: 400, aidNote: 'علاج', kids: [] },
  { g: 'زينب حسن منصور', fam: 'أسرة حسن منصور', support: 'kafala', calc: 'per_member', amount: 0, aid: 0, kids: [['خالد حسن منصور', 'male', 15], ['سلمى حسن منصور', 'female', 11]] },
  { g: 'آمنة عبد الرحمن فرج', fam: 'أسرة عبد الرحمن فرج', support: 'both', calc: 'family_fixed', amount: 700, aid: 200, aidNote: 'دراسة', kids: [['كريم عبد الرحمن فرج', 'male', 17]] },
  { g: 'رقية مصطفى النجار', fam: 'أسرة مصطفى النجار', support: 'aid', calc: 'family_fixed', amount: 0, aid: 300, aidNote: 'مساعدة شهرية', kids: [] },
  { g: 'بسمة كمال سليمان', fam: 'أسرة كمال سليمان', support: 'kafala', calc: 'mixed', amount: 300, aid: 0, kids: [['جنى كمال سليمان', 'female', 7], ['زياد كمال سليمان', 'male', 3]] },
  { g: 'إيمان رمضان البدري', fam: 'أسرة رمضان البدري', support: 'both', calc: 'family_fixed', amount: 500, aid: 150, aidNote: 'كهرباء ومياه', kids: [['ملك رمضان البدري', 'female', 10]] },
];
const SPONSORS = [['الحاج عبد الحميد الشافعي', 1000], ['أ. منى الحسيني', 600], ['د. طارق عثمان', 800]];

async function status() {
  const r = await db.one(`SELECT (SELECT count(*) FROM families WHERE is_demo)::int AS families, (SELECT count(*) FROM sponsors WHERE is_demo)::int AS sponsors,
    (SELECT count(*) FROM donations WHERE is_demo)::int AS donations, (SELECT count(*) FROM expenses WHERE is_demo)::int AS expenses,
    (SELECT count(*) FROM poor_cases WHERE is_demo)::int AS poor`);
  return { ...r, exists: r.families + r.sponsors + r.donations + r.expenses + r.poor > 0 };
}

async function seed(user, req) {
  if ((await status()).exists) throw new U.UserError('البيانات التجريبية موجودة بالفعل. احذفها أولًا إذا أردت إنشاءها من جديد.');
  const today = U.todayISO(); const period = today.slice(0, 7);
  const famIds = [];
  await db.tx(async (c) => {
    for (const [i, f] of FAMS.entries()) {
      const row = await c.one(`INSERT INTO families (family_name, opened_on, status, city, address, calc_method, monthly_amount, aid_amount, aid_note, support_type, is_demo, created_by)
        VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,TRUE,$10) RETURNING id`,
        [f.fam + TAG, U.addMonths(today, -6), 'طنط الجزيرة', 'شارع تجريبي ' + (i + 1), f.calc, f.amount, f.aid, f.aidNote || null, f.support, user.id]);
      famIds.push(row.id);
      await c.query(`INSERT INTO guardians (family_id, full_name, relation, phone, payout_method) VALUES ($1,$2,'الأم',$3,'cash')`,
        [row.id, f.g + TAG, '0100' + String(9000000 + i * 111).padStart(7, '0')]);
      for (const [name, gender, age] of f.kids) {
        const m = await c.one(`INSERT INTO family_members (family_id, full_name, birth_date, gender, relation, is_orphan, study_status, eligibility_status, monthly_amount, sponsorship_start, created_by)
          VALUES ($1,$2,$3,$4,$5,TRUE,'طالب مدرسة','eligible',$6,$7,$8) RETURNING id`,
          [row.id, name + TAG, U.addDays(today, -age * 365 - 40), gender, gender === 'male' ? 'ابن' : 'ابنة', f.calc === 'family_fixed' ? 0 : 250, U.addMonths(today, -6), user.id]);
        await c.query(`INSERT INTO eligibility_decisions (member_id, new_status, reason, kind, age_at_decision, decided_by) VALUES ($1,'eligible','بيانات تجريبية','initial',$2,$3)`, [m.id, age, user.id]);
      }
    }
    // الكفلاء وربطهم بالأسر
    for (const [i, [name, pledge]] of SPONSORS.entries()) {
      const sp = await c.one(`INSERT INTO sponsors (full_name, phone, monthly_pledge, start_date, status, payment_method, is_demo, created_by) VALUES ($1,$2,$3,$4,'active','تحويل شهري',TRUE,$5) RETURNING id`,
        [name + TAG, '0111' + String(8000000 + i * 222).padStart(7, '0'), pledge, U.addMonths(today, -6), user.id]);
      await c.query(`INSERT INTO family_sponsorships (sponsor_id, family_id, monthly_amount, start_date, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [sp.id, famIds[i * 2], pledge, U.addMonths(today, -6), user.id]);
    }
    // رصيد افتتاحي وتبرعات ومصروف
    for (const [fund, amt] of [['orphans', '15000.00'], ['general', '5000.00']]) {
      const lid = await finance.post(c, { date: today, fund, direction: 'in', amount: amt, source_type: 'opening', description: 'رصيد افتتاحي' + TAG, user });
      await c.query(`INSERT INTO financial_adjustments (adj_date, period, fund_code, direction, amount, kind, reason, ledger_id, created_by, is_demo) VALUES ($1,$2,$3,'in',$4,'opening',$5,$6,$7,TRUE)`,
        [today, period, fund, amt, 'رصيد افتتاحي' + TAG, lid, user.id]);
    }
    const sps = await c.many('SELECT id, full_name, monthly_pledge FROM sponsors WHERE is_demo ORDER BY id');
    const ids = [];
    for (const sp of sps) ids.push((await donations.create(c, { type_code: 'sponsor', sponsor_id: sp.id, donor_name: sp.full_name, amount: sp.monthly_pledge, donation_date: today, payment_method: 'bank_transfer', period }, user, null, { collectNow: true })).id);
    ids.push((await donations.create(c, { type_code: 'general', donor_name: 'فاعل خير' + TAG, amount: '1500', donation_date: today, payment_method: 'cash', period }, user, null, { collectNow: true })).id);
    ids.push((await donations.create(c, { type_code: 'orphans', donor_name: 'متبرع لكفالة الأيتام' + TAG, amount: '2500', donation_date: today, payment_method: 'cash', period }, user, null, { collectNow: true })).id);
    await c.query('UPDATE donations SET is_demo=TRUE WHERE id = ANY($1)', [ids]);
    const e = await c.one(`INSERT INTO expenses (expense_date, category_code, fund_code, description, amount, payee, period, status, created_by, approved_by, approved_at, is_demo)
      VALUES ($1,'operational','general',$2,'750',$3,$4,'approved',$5,$5,now(),TRUE) RETURNING *`, [today, 'كهرباء ومياه المقر' + TAG, 'شركة الكهرباء', period, user.id]);
    await finance.post(c, { date: today, fund: 'general', direction: 'out', amount: e.amount, source_type: 'expense', source_id: e.id, description: `مصروف ${e.expense_no}`, user });
    await c.query(`UPDATE expenses SET status='paid', paid_by=$2, paid_at=now() WHERE id=$1`, [e.id, user.id]);
  });
  // كشف الشهر للأسر التجريبية + صرف لبعضها (كامل وجزئي) لتظهر جميع الحالات
  await db.tx(async (c) => {
    const run = await c.one('SELECT * FROM monthly_runs WHERE period=$1', [period]);
    if (run && run.status === 'closed') return;
    await ent.generate(c, period, user, { mode: run ? 'add_missing' : 'new', familyIds: famIds });
    const rows = await c.many(`SELECT id, amount_due FROM monthly_entitlements WHERE period=$1 AND family_id = ANY($2) ORDER BY id`, [period, famIds]);
    for (const [k, r] of rows.entries()) {
      if (k % 3 === 2) continue; // لم يستلم بعد
      const amt = k % 3 === 1 ? U.fromCents(Math.floor(U.toCents(r.amount_due) / 2)) : r.amount_due;
      await ent.disburse(c, r.id, { amount: amt, date: today, method: 'cash', fund: 'orphans', idempotency_key: `demo-${r.id}`, reference: 'تجريبي' }, user);
    }
  });
  // قسم الفقراء والمساكين
  await db.tx(async (c) => {
    const P = [['نعيمة عبد الفتاح', 'widow', 'east', 'cash', 300], ['محمود السيد خليل', 'sick', 'west', 'both', 250], ['الحاجة فوزية علي', 'elderly', 'north', 'in_kind', 0],
      ['سامي عبد العزيز', 'unemployed', 'south', 'cash', 200], ['أم هاشم إبراهيم', 'divorced', 'east', 'in_kind', 0], ['عادل رمضان حسن', 'disabled', 'west', 'both', 350]];
    const ids = [];
    for (const [i, [n, reason, area, give, amt]] of P.entries()) {
      ids.push((await c.one(`INSERT INTO poor_cases (full_name, national_id, phone, reason, area, give_type, monthly_amount, family_size, is_demo, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9) RETURNING id`, [n + TAG, '2' + String(70000000000000 + i * 1111111).slice(0, 13), '0122' + String(7000000 + i * 333).padStart(7, '0'), reason, area, give, amt, 2 + i, user.id])).id);
    }
    await c.query(`INSERT INTO poor_donations (donor_name, kind, amount, donation_date, is_demo, created_by) VALUES ($1,'zakat',3000,$2,TRUE,$3), ($4,'sadaqa',1200,$2,TRUE,$3)`,
      ['متبرع بالزكاة' + TAG, today, user.id, 'فاعل خير' + TAG]);
    await c.query(`INSERT INTO poor_payments (case_id, period, amount, pay_date, created_by) SELECT id, $1, monthly_amount, $2, $3 FROM poor_cases WHERE id = ANY($4) AND give_type='cash'`, [period, today, user.id, ids]);
    const g = await c.one(`INSERT INTO poor_distributions (title, items, dist_date, created_by) VALUES ($1,'أرز، سكر، زيت، مكرونة، شاي',$2,$3) RETURNING id`, ['شنطة رمضان' + TAG, today, user.id]);
    await c.query(`INSERT INTO poor_distribution_items (distribution_id, case_id, quantity, received_at)
      SELECT $1, id, 'شنطة واحدة', CASE WHEN area='east' THEN now() END FROM poor_cases WHERE id = ANY($2) AND give_type IN ('in_kind','both')`, [g.id, ids]);
  });
  await audit.log(req || { user }, 'demo_seeded', 'system', '', { after: { families: famIds.length } });
  return { families: famIds.length };
}

async function purge(user, req) {
  const st = await status();
  if (!st.exists) throw new U.UserError('مفيش بيانات تجريبية لحذفها.');
  const out = await db.tx(async (c) => {
    await c.query("SET LOCAL kafala.demo_purge = 'on'");
    const D = (await c.many('SELECT id, file_no FROM families WHERE is_demo'));
    const fam = D.map((r) => r.id); const fileNos = new Set(D.map((r) => r.file_no));
    const spon = (await c.many('SELECT id FROM sponsors WHERE is_demo')).map((r) => r.id);
    const mem = (await c.many('SELECT id FROM family_members_all WHERE family_id = ANY($1)', [fam])).map((r) => r.id);
    const ents = await c.many('SELECT id, period FROM monthly_entitlements WHERE family_id = ANY($1)', [fam]);
    const entIds = ents.map((r) => r.id);
    const disb = (await c.many('SELECT id FROM disbursements WHERE entitlement_id = ANY($1) OR family_id = ANY($2)', [entIds, fam])).map((r) => r.id);
    const don = await c.many('SELECT id, period FROM donations WHERE is_demo OR sponsor_id = ANY($1) OR family_id = ANY($2)', [spon, fam]);
    const donIds = don.map((r) => r.id);
    const exp = await c.many('SELECT id, period FROM expenses WHERE is_demo');
    const expIds = exp.map((r) => r.id);
    const adj = await c.many('SELECT id, ledger_id, period FROM financial_adjustments WHERE is_demo');
    const periods = new Set([...ents, ...don, ...exp, ...adj].map((r) => String(r.period).trim()));

    const led = await c.many(`SELECT id FROM ledger_entries WHERE family_id = ANY($1)
        OR (source_type IN ('disbursement','disbursement_reversal') AND source_id = ANY($2))
        OR (source_type IN ('donation','donation_reversal') AND source_id = ANY($3))
        OR (source_type IN ('expense','expense_reversal') AND source_id = ANY($4))
        OR id = ANY($5)`, [fam, disb, donIds, expIds, adj.map((a) => a.ledger_id).filter(Boolean)]);
    const ledIds = led.map((r) => r.id);
    await c.query('DELETE FROM financial_adjustments WHERE is_demo');
    await c.query('DELETE FROM ledger_entries WHERE reverses_id = ANY($1)', [ledIds]);
    await c.query('DELETE FROM ledger_entries WHERE id = ANY($1)', [ledIds]);
    await c.query('DELETE FROM disbursements WHERE id = ANY($1)', [disb]);
    await c.query('DELETE FROM monthly_entitlements WHERE id = ANY($1)', [entIds]);
    await c.query('DELETE FROM donations WHERE id = ANY($1)', [donIds]);
    await c.query('DELETE FROM sponsor_contributions WHERE sponsor_id = ANY($1)', [spon]);
    await c.query('DELETE FROM family_sponsorships WHERE sponsor_id = ANY($1) OR family_id = ANY($2)', [spon, fam]);
    await c.query('DELETE FROM expense_approvals WHERE expense_id = ANY($1)', [expIds]);
    await c.query('DELETE FROM expenses WHERE id = ANY($1)', [expIds]);
    await c.query('DELETE FROM notifications WHERE family_id = ANY($1) OR member_id = ANY($2)', [fam, mem]);
    await c.query('DELETE FROM eligibility_reviews WHERE member_id = ANY($1)', [mem]);
    await c.query('DELETE FROM eligibility_decisions WHERE member_id = ANY($1)', [mem]);
    const docs = await c.many('SELECT id, stored_name FROM documents WHERE family_id = ANY($1) OR member_id = ANY($2)', [fam, mem]);
    await c.query('UPDATE documents SET replaces_id=NULL WHERE replaces_id = ANY($1)', [docs.map((d) => d.id)]);
    await c.query('DELETE FROM documents WHERE id = ANY($1)', [docs.map((d) => d.id)]);
    await c.query('DELETE FROM family_members_all WHERE id = ANY($1)', [mem]);
    await c.query('DELETE FROM guardians WHERE family_id = ANY($1)', [fam]);
    await c.query('DELETE FROM families WHERE id = ANY($1)', [fam]);
    await c.query('DELETE FROM sponsors WHERE id = ANY($1)', [spon]);
    // الكشوف الشهرية الفارغة بعد الحذف، والنسخ المحفوظة والتقارير اللي فيها أرقام تجريبية (تُنشأ من جديد تلقائيًا)
    await c.query('DELETE FROM monthly_runs r WHERE NOT EXISTS (SELECT 1 FROM monthly_entitlements e WHERE e.run_id=r.id)');
    const sts = await c.many('SELECT id, data FROM monthly_statements');
    const stDel = sts.filter((s) => (s.data.rows || []).some((r) => fileNos.has(r.file_no))).map((s) => s.id);
    await c.query('DELETE FROM monthly_statements WHERE id = ANY($1)', [stDel]);
    const reps = await c.many('SELECT id, pdf_file, approved_pdf_file FROM monthly_reports WHERE period = ANY($1)', [[...periods]]);
    const keys = reps.flatMap((r) => [r.pdf_file, r.approved_pdf_file]).filter(Boolean);
    await c.query('DELETE FROM monthly_reports WHERE id = ANY($1)', [reps.map((r) => r.id)]);
    if (keys.length) await c.query('DELETE FROM stored_files WHERE key = ANY($1)', [keys]);
    // قسم الفقراء والمساكين
    const pc = (await c.many('SELECT id FROM poor_cases WHERE is_demo')).map((r) => r.id);
    await c.query('DELETE FROM poor_distribution_items WHERE case_id = ANY($1)', [pc]);
    await c.query(`DELETE FROM poor_distributions d WHERE d.title LIKE '%(تجريبي)%' AND NOT EXISTS (SELECT 1 FROM poor_distribution_items i WHERE i.distribution_id=d.id)`);
    await c.query('DELETE FROM poor_payments WHERE case_id = ANY($1)', [pc]);
    await c.query('DELETE FROM poor_cases WHERE id = ANY($1)', [pc]);
    await c.query('DELETE FROM poor_donations WHERE is_demo');
    await audit.log(req || { user }, 'demo_purged', 'system', '', { after: { families: fam.length, sponsors: spon.length, donations: donIds.length, expenses: expIds.length, ledger: ledIds.length, reports: reps.length } }, c);
    return { families: fam.length };
  });
  return out;
}

module.exports = { seed, purge, status };
