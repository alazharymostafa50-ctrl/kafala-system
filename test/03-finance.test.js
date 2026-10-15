'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, login, db, idFrom } = require('./helpers');
const F = require('./fixtures');
const U = require('../src/lib/util');
const finance = require('../src/lib/finance');
const stats = require('../src/lib/stats');

let mgr; let acc; let acc2; let cashier;
const P = U.currentPeriod();
const bal = async (fund) => U.fromCents(await finance.fundBalanceCents(db, fund));

before(async () => { await resetDb(); mgr = await login('manager'); acc = await login('accountant'); acc2 = await login('accountant2'); cashier = await login('cashier'); });
after(() => db.pool.end());

test('كفيل واحد لأكثر من أسرة، وأكثر من كفيل لأسرة واحدة', async () => {
  const f1 = await F.family(mgr); const f2 = await F.family(mgr);
  const s1 = idFrom(await acc.post('/sponsors', { full_name: 'كفيل أول', phone: '0111111111', monthly_pledge: '0' }));
  const s2 = idFrom(await acc.post('/sponsors', { full_name: 'كفيل ثان', phone: '0111111112', monthly_pledge: '0' }));
  await acc.post(`/sponsors/${s1}/links`, { family_id: String(f1), monthly_amount: '300', start_date: U.todayISO() });
  await acc.post(`/sponsors/${s1}/links`, { family_id: String(f2), monthly_amount: '200', start_date: U.todayISO() });
  await acc.post(`/sponsors/${s2}/links`, { family_id: String(f1), monthly_amount: '400', start_date: U.todayISO() });
  const dup = await acc.post(`/sponsors/${s1}/links`, { family_id: String(f1), monthly_amount: '1', start_date: U.todayISO() });
  assert.equal(dup.status, 302);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM family_sponsorships WHERE sponsor_id=$1`, [s1])).n, 2, 'لا ارتباط نشط مكرر');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM family_sponsorships WHERE family_id=$1`, [f1])).n, 2);
  const page = await acc.get(`/sponsors/${s1}`);
  assert.doesNotMatch(page.text, /national_id|IBAN/);
});

test('التعهد ليس تحصيلًا؛ التحصيل يُحتسب مرة واحدة ضمن التبرعات', async () => {
  const s1 = (await db.one(`SELECT id FROM sponsors WHERE phone='0111111111'`)).id;
  await acc.post('/sponsors/pledges/generate', { period: P });
  const pl = await db.one(`SELECT * FROM sponsor_contributions WHERE sponsor_id=$1 AND period=$2`, [s1, P]);
  assert.equal(pl.pledged_amount, '500.00');
  assert.equal(await bal('orphans'), '0.00', 'التعهد لا يدخل الرصيد');
  const don0 = await stats.donationBreakdown(db, P);
  assert.equal(don0.total, 0);
  await acc.post(`/sponsors/${s1}/collect`, { period: P, amount: '300', donation_date: U.todayISO(), payment_method: 'bank_transfer', reference: 'TRX-1', donor_name: 'كفيل أول' });
  await acc.post(`/sponsors/${s1}/collect`, { period: P, amount: '200', donation_date: U.todayISO(), payment_method: 'bank_transfer', reference: 'TRX-2', donor_name: 'كفيل أول' });
  const page = await acc.get(`/sponsors/pledges?period=${P}`);
  assert.match(page.text, /سدد بالكامل/);
  await F.donation(acc, { type_code: 'general', amount: '1000' });
  const d = await stats.donationBreakdown(db, P);
  assert.equal(d.total, 150000); assert.equal(d.sponsor, 50000); assert.equal(d.general, 100000);
  assert.equal(d.sponsor + d.general + d.restricted, d.total, 'الأجزاء تساوي الإجمالي دون ازدواج');
  assert.equal(await bal('orphans'), '500.00');
});

test('منع احتساب التبرع مرتين: المرجع المكرر والتحصيل المكرر', async () => {
  const id = await F.donation(acc, { type_code: 'orphans', amount: '5000', reference: 'REF-777', payment_method: 'bank_transfer', collect_now: '' });
  const before = await bal('orphans');
  await acc.post(`/donations/${id}/collect`, { date: U.todayISO() });
  await acc.post(`/donations/${id}/collect`, { date: U.todayISO() });
  assert.equal(await bal('orphans'), U.fromCents(U.toCents(before) + 500000));
  const n = await db.one(`SELECT count(*)::int AS n FROM ledger_entries WHERE source_type='donation' AND source_id=$1`, [id]);
  assert.equal(n.n, 1);
  const r = await acc.post('/donations', { type_code: 'general', donor_name: 'x', amount: '10', donation_date: U.todayISO(), payment_method: 'bank_transfer', reference: 'REF-777', collect_now: '1' });
  assert.equal(r.status, 302);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM donations WHERE reference='REF-777'`)).n, 1);
});

test('تبرع مخصص لأسرة يُحجز لها ولا يُصرف لغيرها', async () => {
  const fam = await F.family(mgr);
  await F.donation(acc, { type_code: 'family', family_id: String(fam), amount: '700' });
  const res = await finance.designatedReserves(db);
  assert.equal(res.get(fam), 70000);
  const forOther = await finance.availableCents(db, 'orphans', 999999);
  const forFam = await finance.availableCents(db, 'orphans', fam);
  assert.equal(forFam - forOther, 70000);
});

test('عكس التبرع بقيد موثق دون حذف الأصل', async () => {
  const id = await F.donation(acc, { type_code: 'general', amount: '50' });
  const b = await bal('general');
  await acc.post(`/donations/${id}/reverse`, { reason: 'خطأ إدخال' });
  assert.equal(await bal('general'), U.fromCents(U.toCents(b) - 5000));
  const rows = await db.many(`SELECT source_type FROM ledger_entries WHERE source_id=$1 AND source_type LIKE 'donation%' ORDER BY id`, [id]);
  assert.deepEqual(rows.map((r) => r.source_type), ['donation', 'donation_reversal']);
  await assert.rejects(db.query('DELETE FROM donations WHERE id=$1', [id]), /لا يمكن حذف/);
  await assert.rejects(db.query('UPDATE ledger_entries SET amount=1'), /غير قابل للتعديل/);
});

test('المصروف: فصل الاعتماد عن الدفع، ومنع اعتماد المنشئ لنفسه، ومنع استخدام الأموال المقيدة', async () => {
  const bad = await acc.post('/expenses', { expense_date: U.todayISO(), category_code: 'operational', fund_code: 'orphans', description: 'إيجار', amount: '100', submit: '1' });
  assert.equal(bad.status, 302);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM expenses`)).n, 0, 'المقيد لا يُصرف على التشغيل');
  const id = idFrom(await acc.post('/expenses', { expense_date: U.todayISO(), category_code: 'operational', fund_code: 'general', description: 'إيجار المقر', amount: '400', submit: '1' }));
  // المحاسب لا يملك الاعتماد، والمدير الذي لم ينشئه يعتمد
  assert.equal((await acc.post(`/expenses/${id}/action`, { action: 'approve' })).status, 403);
  await mgr.post(`/expenses/${id}/action`, { action: 'approve' });
  let e = await db.one('SELECT * FROM expenses WHERE id=$1', [id]);
  assert.equal(e.status, 'approved');
  const b = await bal('general');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM ledger_entries WHERE source_type='expense'`)).n, 0, 'الاعتماد ليس دفعًا');
  await acc.post(`/expenses/${id}/action`, { action: 'pay', paid_date: U.todayISO() });
  e = await db.one('SELECT * FROM expenses WHERE id=$1', [id]);
  assert.equal(e.status, 'paid');
  assert.equal(await bal('general'), U.fromCents(U.toCents(b) - 40000));
  // المدير ينشئ مصروفًا ولا يستطيع اعتماده بنفسه
  const id2 = idFrom(await mgr.post('/expenses', { expense_date: U.todayISO(), category_code: 'administrative', fund_code: 'general', description: 'أدوات', amount: '10', submit: '1' }));
  await mgr.post(`/expenses/${id2}/action`, { action: 'approve' });
  assert.equal((await db.one('SELECT status FROM expenses WHERE id=$1', [id2])).status, 'pending_approval');
  // دفع يتجاوز الرصيد
  const id3 = idFrom(await acc.post('/expenses', { expense_date: U.todayISO(), category_code: 'other', fund_code: 'general', description: 'كبير', amount: '99999999', submit: '1' }));
  await mgr.post(`/expenses/${id3}/action`, { action: 'approve' });
  await acc.post(`/expenses/${id3}/action`, { action: 'pay', paid_date: U.todayISO() });
  assert.equal((await db.one('SELECT status FROM expenses WHERE id=$1', [id3])).status, 'approved', 'لا يُدفع ما يتجاوز الرصيد');
});

test('كشف الاستحقاقات: احتساب الطرق الثلاث ومنع الكشف المكرر', async () => {
  await F.donation(acc, { type_code: 'orphans', amount: '50000' });
  const fixed = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '900' });
  await F.member(mgr, fixed); await F.member(mgr, fixed);
  const per = await F.family(mgr, { calc_method: 'per_member' });
  await F.member(mgr, per, { monthly_amount: '300' }); await F.member(mgr, per, { monthly_amount: '250' });
  const ineligible = await F.member(mgr, per, { monthly_amount: '1000' });
  await mgr.post(`/members/${ineligible.id}/decision`, { new_status: 'ineligible', reason: 'اختبار' });
  const mixed = await F.family(mgr, { calc_method: 'mixed', monthly_amount: '200' });
  await F.member(mgr, mixed, { monthly_amount: '150' });
  const suspended = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '500' });
  await mgr.post(`/families/${suspended}/status`, { status: 'suspended', reason: 'تحقق' });

  const r = await mgr.post('/entitlements/generate', { period: P });
  assert.equal(r.headers.location, `/entitlements/${P}`);
  const ent = async (fid) => db.one('SELECT * FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [fid, P]);
  assert.equal((await ent(fixed)).amount_due, '900.00');
  assert.equal((await ent(per)).amount_due, '550.00');
  assert.equal((await ent(per)).eligible_count, 2);
  assert.equal((await ent(mixed)).amount_due, '350.00');
  assert.equal(await ent(suspended), null, 'الأسرة الموقوفة لا تُدرج');
  const count = (await db.one('SELECT count(*)::int AS n FROM monthly_entitlements WHERE period=$1', [P])).n;
  await mgr.post('/entitlements/generate', { period: P });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM monthly_entitlements WHERE period=$1', [P])).n, count, 'لا كشف مكرر');
});

test('إعادة حساب الكفالة عند تغير الاستحقاق تسري على الشهر الجديد فقط', async () => {
  const per = (await db.one(`SELECT f.id FROM families f JOIN monthly_entitlements e ON e.family_id=f.id WHERE f.calc_method='per_member' AND e.amount_due='550.00'`)).id;
  const m = await db.one(`SELECT id FROM family_members WHERE family_id=$1 AND monthly_amount='300.00'`, [per]);
  await mgr.post(`/members/${m.id}/decision`, { new_status: 'suspended', reason: 'تغير الحالة' });
  assert.equal((await db.one('SELECT amount_due FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [per, P])).amount_due, '550.00', 'الشهر الحالي لا يتغير بصمت');
  const next = U.addMonths(P + '-01', 1).slice(0, 7);
  await mgr.post('/entitlements/generate', { period: next });
  assert.equal((await db.one('SELECT amount_due FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [per, next])).amount_due, '250.00');
  // الكفالة الثابتة لا تُخفض تلقائيًا بل تُعلّم للمراجعة
  const fixed = (await db.one(`SELECT f.id FROM families f WHERE f.calc_method='family_fixed' AND f.monthly_amount='900.00'`)).id;
  const fm = await db.one('SELECT id FROM family_members WHERE family_id=$1 LIMIT 1', [fixed]);
  await mgr.post(`/members/${fm.id}/decision`, { new_status: 'ended', reason: 'انتهاء' });
  const after2 = U.addMonths(P + '-01', 2).slice(0, 7);
  await mgr.post('/entitlements/generate', { period: after2 });
  const e = await db.one('SELECT * FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [fixed, after2]);
  assert.equal(e.amount_due, '900.00'); assert.equal(e.needs_review, true);
});

test('الصرف الجزئي وإكمال المتبقي ومنع تجاوز المستحق وتحديث الأرصدة', async () => {
  const e = await db.one(`SELECT * FROM monthly_entitlements WHERE period=$1 AND amount_due='900.00'`, [P]);
  const b0 = U.toCents(await bal('orphans'));
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '400', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'k-1' });
  let x = await db.one('SELECT * FROM monthly_entitlements WHERE id=$1', [e.id]);
  assert.equal(x.amount_paid, '400.00'); assert.equal(x.status, 'partial');
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '600', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'k-2' });
  x = await db.one('SELECT * FROM monthly_entitlements WHERE id=$1', [e.id]);
  assert.equal(x.amount_paid, '400.00', 'لا يتجاوز المتبقي');
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '500', date: U.todayISO(), method: 'bank_transfer', fund: 'orphans', idempotency_key: 'k-3', reference: 'BT-55' });
  x = await db.one('SELECT * FROM monthly_entitlements WHERE id=$1', [e.id]);
  assert.equal(x.amount_paid, '900.00'); assert.equal(x.status, 'paid');
  assert.equal(U.toCents(await bal('orphans')), b0 - 90000);
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '1', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'k-4' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM disbursements WHERE entitlement_id=$1', [e.id])).n, 2, 'منع تكرار الصرف الكامل');
  await assert.rejects(db.query(`UPDATE monthly_entitlements SET amount_paid=amount_due+1 WHERE id=$1`, [e.id]), /check/i);
});

test('منع التكرار بسبب النقر المزدوج وإعادة الإرسال والطلبات المتزامنة', async () => {
  const e = await db.one(`SELECT * FROM monthly_entitlements WHERE period=$1 AND amount_due='350.00'`, [P]);
  const body = { amount: '350', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'same-key' };
  await Promise.all([cashier.post(`/entitlements/item/${e.id}/disburse`, body), cashier.post(`/entitlements/item/${e.id}/disburse`, body)]);
  await cashier.post(`/entitlements/item/${e.id}/disburse`, body);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM disbursements WHERE entitlement_id=$1', [e.id])).n, 1);
  const e2 = await db.one(`SELECT * FROM monthly_entitlements WHERE period=$1 AND amount_due='550.00'`, [P]);
  await Promise.all([1, 2, 3].map((i) => cashier.post(`/entitlements/item/${e2.id}/disburse`, { amount: '550', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'c-' + i })));
  const sum = await db.one(`SELECT COALESCE(SUM(amount),0)::text AS s, count(*)::int AS n FROM disbursements WHERE entitlement_id=$1 AND status='paid'`, [e2.id]);
  assert.equal(sum.n, 1); assert.equal(sum.s, '550.00');
});

test('لا يُصرف ما يتجاوز الرصيد المتاح في الصندوق المعني', async () => {
  const fam = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '9999999' });
  await F.member(mgr, fam);
  await mgr.post('/entitlements/generate', { period: P, mode: 'add_missing' });
  const e = await db.one('SELECT id FROM monthly_entitlements WHERE family_id=$1', [fam]);
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '9999999', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'big' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM disbursements WHERE entitlement_id=$1', [e.id])).n, 0);
  assert.ok(U.toCents(await bal('orphans')) >= 0);
});

test('عكس الصرف بقيد موثق يعيد المتبقي والرصيد', async () => {
  const d = await db.one(`SELECT * FROM disbursements WHERE reference='BT-55'`);
  const b = U.toCents(await bal('orphans'));
  await mgr.post(`/disbursements/${d.id}/reverse`, { reason: 'تحويل مرتجع' });
  assert.equal((await db.one('SELECT status FROM disbursements WHERE id=$1', [d.id])).status, 'reversed');
  assert.equal(U.toCents(await bal('orphans')), b + 50000);
  const e = await db.one('SELECT amount_paid, status FROM monthly_entitlements WHERE id=$1', [d.entitlement_id]);
  assert.equal(e.amount_paid, '400.00'); assert.equal(e.status, 'partial');
});

test('اعتماد الصرف عند تفعيله: لا قيد مالي قبل الاعتماد، ولا يعتمد المنشئ لنفسه', async () => {
  const s = await db.one(`SELECT value FROM system_settings WHERE key='finance'`);
  await db.query(`UPDATE system_settings SET value=$1 WHERE key='finance'`, [JSON.stringify({ ...s.value, disbursement_requires_approval: true })]);
  require('../src/lib/settings').invalidate();
  const fam = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '120' });
  await F.member(mgr, fam);
  await mgr.post('/entitlements/generate', { period: P, mode: 'add_missing' });
  const e = await db.one(`SELECT * FROM monthly_entitlements WHERE period=$1 AND family_id=$2`, [P, fam]);
  const admin = await login('admin');
  await admin.post(`/entitlements/item/${e.id}/disburse`, { amount: e.amount_due, date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'appr-1' });
  const d = await db.one('SELECT * FROM disbursements WHERE idempotency_key=$1', ['appr-1']);
  assert.equal(d.status, 'pending_approval');
  assert.equal((await db.one('SELECT status FROM monthly_entitlements WHERE id=$1', [e.id])).status, 'pending_approval');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM ledger_entries WHERE source_type='disbursement' AND source_id=$1`, [d.id])).n, 0);
  await admin.post(`/disbursements/${d.id}/approve`, {});
  assert.equal((await db.one('SELECT status FROM disbursements WHERE id=$1', [d.id])).status, 'pending_approval', 'فصل المهام');
  await mgr.post(`/disbursements/${d.id}/approve`, {});
  assert.equal((await db.one('SELECT status FROM disbursements WHERE id=$1', [d.id])).status, 'paid');
  assert.equal((await db.one('SELECT status FROM monthly_entitlements WHERE id=$1', [e.id])).status, 'paid');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM ledger_entries WHERE source_type='disbursement' AND source_id=$1`, [d.id])).n, 1);
  await db.query(`UPDATE system_settings SET value=$1 WHERE key='finance'`, [JSON.stringify(s.value)]);
  require('../src/lib/settings').invalidate();
});

test('الإجماليات متطابقة بين السجل المالي واللوحة', async () => {
  const sum = await finance.periodSummary(db, P);
  const led = await db.one(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS v FROM ledger_entries`);
  assert.equal(sum.totals.closing, U.toCents(led.v));
  const t = await stats.entitlementTotals(db, P);
  const paidLedger = await db.one(`SELECT COALESCE(SUM(CASE WHEN l.source_type='disbursement' THEN l.amount ELSE -l.amount END),0)::text AS v
    FROM ledger_entries l JOIN disbursements d ON d.id=l.source_id WHERE l.source_type IN ('disbursement','disbursement_reversal') AND d.period=$1`, [P]);
  assert.equal(t.paid, U.toCents(paidLedger.v), 'المصروف في الكشف = قيود الصرف');
  const dash = await (await login('admin')).get(`/?period=${P}`);
  assert.match(dash.text, new RegExp(U.fmtMoney(U.fromCents(t.paid)).replace('.', '\\.')));
});

test('الكفالة والإعانة منفصلتان، وكشف التوقيع والإيصالات والصرف السريع', async () => {
  const fam = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '600', aid_amount: '250', aid_note: 'إيجار' });
  await F.member(mgr, fam, { full_name: 'يتيم الإيصال' });
  await mgr.post('/entitlements/generate', { period: P, mode: 'add_missing' });
  const e = await db.one('SELECT * FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [fam, P]);
  assert.equal(e.kafala_amount, '600.00'); assert.equal(e.aid_amount, '250.00'); assert.equal(e.amount_due, '850.00');
  await assert.rejects(db.query('UPDATE monthly_entitlements SET aid_amount=1 WHERE id=$1', [e.id]), /ent_parts_sum/);
  const sheet = await mgr.get(`/entitlements/${P}/sheet`);
  assert.equal(sheet.status, 200);
  assert.match(sheet.text, /كشف التوقيع بالاستلام/); assert.match(sheet.text, /التوقيع بالاستلام/); assert.match(sheet.text, /850\.00/);
  const rc = await mgr.get(`/entitlements/item/${e.id}/receipt`);
  assert.match(rc.text, /إيصال استلام كفالة وإعانة/); assert.match(rc.text, /ثمانمائة وخمسون/); assert.match(rc.text, /يتيم الإيصال/); assert.match(rc.text, /إيجار/);
  const cc = await mgr.get(`/entitlements/${P}/receipts-compact`);
  assert.equal(cc.status, 200);
  assert.match(cc.text, /كشف استلام الكفالة والإعانة/); assert.match(cc.text, /المشهرة برقم 1248 لسنة 2008 م/);
  assert.match(cc.text, /التوقيع/); assert.match(cc.text, /رقم التليفون/); assert.match(cc.text, /850\.00/);
  // يُحفظ الكشف تلقائيًا مرة واحدة، ولا تتكرر النسخة إن لم تتغير البيانات
  await mgr.get(`/entitlements/${P}/receipts-compact?per=15`);
  const saved = await db.many('SELECT * FROM monthly_statements WHERE period=$1', [P]);
  assert.equal(saved.length, 1); assert.equal(saved[0].version, 1);
  await assert.rejects(db.query('DELETE FROM monthly_statements WHERE id=$1', [saved[0].id]), /غير قابل/);
  const arch = await mgr.get('/statements'); assert.equal(arch.status, 200); assert.match(arch.text, /أرشيف كشوف الاستلام/);
  assert.equal((await mgr.get(`/statements/${saved[0].id}`)).status, 200);
  const social = await login('social');
  assert.equal((await social.get(`/entitlements/${P}/sheet`)).status, 403);
  assert.equal((await social.get(`/entitlements/${P}/receipts-compact`)).status, 403);
  await cashier.post(`/entitlements/item/${e.id}/quick`, { idempotency_key: 'quick-1' });
  await cashier.post(`/entitlements/item/${e.id}/quick`, { idempotency_key: 'quick-1' });
  const after = await db.one('SELECT amount_paid, status FROM monthly_entitlements WHERE id=$1', [e.id]);
  assert.equal(after.amount_paid, '850.00'); assert.equal(after.status, 'paid');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM disbursements WHERE entitlement_id=$1', [e.id])).n, 1);
  await mgr.post(`/entitlements/item/${e.id}/amend`, { kafala_amount: '600', aid_amount: '400', reason: 'زيادة الإعانة' });
  const am = await db.one('SELECT amount_due, aid_amount, status FROM monthly_entitlements WHERE id=$1', [e.id]);
  assert.equal(am.amount_due, '1000.00'); assert.equal(am.aid_amount, '400.00'); assert.equal(am.status, 'partial');
  await mgr.get(`/entitlements/${P}/receipts-compact`);
  const v = await db.many('SELECT version FROM monthly_statements WHERE period=$1 ORDER BY version', [P]);
  assert.equal(v.length, 2);
});
