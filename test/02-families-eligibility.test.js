'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, login, db } = require('./helpers');
const F = require('./fixtures');
const U = require('../src/lib/util');
const elig = require('../src/lib/eligibility');

let mgr; let social;
before(async () => { await resetDb(); mgr = await login('manager'); social = await login('social'); });
after(() => db.pool.end());

test('حساب العمر بدقة بما فيها 29 فبراير', () => {
  assert.equal(U.ageOn('2008-10-15', '2026-10-14'), 17);
  assert.equal(U.ageOn('2008-10-14', '2026-10-14'), 18);
  assert.equal(U.ageOn('2008-02-29', '2026-02-28'), 17);
  assert.equal(U.ageOn('2008-02-29', '2026-03-01'), 18);
  assert.equal(U.dateAtAge('2008-02-29', 18), '2026-02-28');
});

test('إضافة أسرة وتعديلها والبحث عنها وأرشفتها دون حذف السجلات', async () => {
  const id = await F.family(mgr, { family_name: 'أسرة البحث', g_phone: '0109998887' });
  const f = await db.one('SELECT * FROM families WHERE id=$1', [id]);
  assert.match(f.file_no, /^F-\d+$/);
  const s1 = await mgr.get('/families?q=0109998887'); assert.match(s1.text, /أسرة البحث/);
  const s2 = await mgr.get('/families?q=' + encodeURIComponent(f.file_no)); assert.match(s2.text, /أسرة البحث/);
  const e = await mgr.post(`/families/${id}`, { family_name: 'أسرة البحث المعدلة', g_full_name: 'ولي', g_phone: '0109998887', calc_method: 'family_fixed', monthly_amount: '800' });
  assert.equal(e.status, 302);
  assert.equal((await db.one('SELECT monthly_amount FROM families WHERE id=$1', [id])).monthly_amount, '800.00');
  const a = await mgr.post(`/families/${id}/status`, { status: 'archived', reason: 'انتقال الأسرة' });
  assert.equal(a.status, 302);
  assert.equal((await db.one('SELECT status FROM families WHERE id=$1', [id])).status, 'archived');
  const log = await db.one(`SELECT count(*)::int AS n FROM audit_logs WHERE entity='family' AND entity_id=$1`, [String(id)]);
  assert.ok(log.n >= 3);
});

test('لا يُطلب البريد الإلكتروني في أي نموذج', async () => {
  for (const u of ['/families/new', '/sponsors/new']) {
    const r = await mgr.get(u);
    assert.doesNotMatch(r.text, /type="email"|البريد الإلكتروني/);
  }
});

test('إضافة أفراد دون حد وتسجيل القرار الابتدائي؛ الباحث الاجتماعي يُنشئ «قيد المراجعة»', async () => {
  const fid = await F.family(mgr);
  for (let i = 0; i < 6; i++) await F.member(mgr, fid);
  const n = await db.one('SELECT count(*)::int AS n FROM family_members WHERE family_id=$1', [fid]);
  assert.equal(n.n, 6);
  const m = await F.member(social, fid, { eligibility_status: 'eligible' });
  assert.equal(m.eligibility_status, 'under_review', 'الباحث لا يعتمد الاستحقاق');
  const d = await db.one('SELECT kind FROM eligibility_decisions WHERE member_id=$1', [m.id]);
  assert.equal(d.kind, 'initial');
});

test('البيانات الحساسة مخفية عمن لا يملك صلاحيتها', async () => {
  const fid = await F.family(mgr, { g_national_id: '29901011234567', g_iban: 'EG380019000500000000263180002' });
  const cashier = await login('cashier');
  const r = await cashier.get(`/families/${fid}`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /29901011234567|EG380019000500000000263180002/);
  assert.match(r.text, /4567/);
  const m = await mgr.get(`/families/${fid}`);
  assert.match(m.text, /29901011234567/);
});

test('بلوغ الذكر 18 دون إثبات جامعي → بانتظار إثبات الدراسة (قرار تلقائي موثق)', async () => {
  const fid = await F.family(mgr);
  const boy = await F.member(mgr, fid, { birth_date: U.addDays(U.dateAtAge(U.todayISO(), -18), -1), gender: 'male' });
  const soon = await F.member(mgr, fid, { birth_date: U.addDays(U.dateAtAge(U.todayISO(), -18), 20), gender: 'male' });
  await elig.runEngine();
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [boy.id])).eligibility_status, 'awaiting_study_proof');
  const d = await db.one(`SELECT * FROM eligibility_decisions WHERE member_id=$1 AND kind='automatic'`, [boy.id]);
  assert.match(d.reason, /بلغ 18/);
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [soon.id])).eligibility_status, 'eligible');
  const n = await db.one(`SELECT severity FROM notifications WHERE dedupe_key=$1`, [`male-soon:${soon.id}:18`]);
  assert.equal(n.severity, 'warning', 'تنبيه خلال شهر');
  const page = await mgr.get('/eligibility');
  assert.match(page.text, new RegExp(boy.full_name));
});

test('اعتماد إثبات جامعي ساري يعيد الاستحقاق، وانتهاؤه يطلب التحديث', async () => {
  const fid = await F.family(mgr);
  const boy = await F.member(mgr, fid, { birth_date: U.addDays(U.dateAtAge(U.todayISO(), -19), 0), gender: 'male' });
  await elig.runEngine();
  const exp = U.addDays(U.todayISO(), 20);
  await mgr.upload(`/families/${fid}/documents`, { doc_type: 'university_proof', member_id: String(boy.id), expiry_date: exp }, { buffer: F.PDF, name: 'proof.pdf' });
  const doc = await db.one(`SELECT id, status FROM documents WHERE member_id=$1 AND doc_type='university_proof'`, [boy.id]);
  assert.equal(doc.status, 'pending');
  await mgr.post(`/documents/${doc.id}/review`, { action: 'approve' });
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [boy.id])).eligibility_status, 'eligible_university');
  // تنبيه قرب الانتهاء
  await elig.runEngine();
  assert.ok(await db.one(`SELECT 1 FROM notifications WHERE dedupe_key=$1 AND resolved_at IS NULL`, [`proof-exp:${doc.id}`]));
  // محاكاة مرور الوقت بعد انتهاء الإثبات
  await elig.runEngine({ today: U.addDays(exp, 1) });
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [boy.id])).eligibility_status, 'awaiting_study_proof');
});

test('الأنثى لا تُوقف كفالتها لبلوغ 18، والزواج يتطلب قرارًا موثقًا', async () => {
  const fid = await F.family(mgr);
  const girl = await F.member(mgr, fid, { birth_date: U.addDays(U.dateAtAge(U.todayISO(), -19), 0), gender: 'female', relation: 'ابنة' });
  await elig.runEngine();
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [girl.id])).eligibility_status, 'eligible');
  await social.post(`/members/${girl.id}/marriage`, { marriage_date: U.todayISO() });
  const after = await db.one('SELECT eligibility_status, marital_status FROM family_members WHERE id=$1', [girl.id]);
  assert.equal(after.marital_status, 'married');
  assert.equal(after.eligibility_status, 'eligible', 'لا إيقاف دون قرار');
  const rev = await db.one(`SELECT id FROM eligibility_reviews WHERE member_id=$1 AND status='open'`, [girl.id]);
  // الباحث لا يملك اتخاذ القرار
  assert.equal((await social.post(`/members/${girl.id}/decision`, { new_status: 'ended', reason: 'زواج' })).status, 403);
  const r = await mgr.post(`/members/${girl.id}/decision`, { new_status: 'ended', reason: 'اعتماد الزواج', review_id: String(rev.id) });
  assert.equal(r.status, 302);
  const dec = await db.one(`SELECT d.*, u.username FROM eligibility_decisions d JOIN users u ON u.id=d.decided_by WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [girl.id]);
  assert.equal(dec.new_status, 'ended'); assert.equal(dec.username, 'manager'); assert.equal(dec.reason, 'اعتماد الزواج');
  assert.equal((await db.one('SELECT status FROM eligibility_reviews WHERE id=$1', [rev.id])).status, 'resolved');
});

test('قرار بدون سبب يُرفض، وسجل القرارات غير قابل للتعديل', async () => {
  const fid = await F.family(mgr);
  const m = await F.member(mgr, fid);
  await mgr.post(`/members/${m.id}/decision`, { new_status: 'suspended', reason: '' });
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [m.id])).eligibility_status, 'eligible');
  await assert.rejects(db.query('UPDATE eligibility_decisions SET reason=$1', ['x']), /غير قابل للتعديل/);
});

test('توقف أحد الأفراد لا يوقف بقية الأفراد', async () => {
  const fid = await F.family(mgr);
  const a = await F.member(mgr, fid); const b = await F.member(mgr, fid);
  await mgr.post(`/members/${a.id}/decision`, { new_status: 'suspended', reason: 'تحقق' });
  assert.equal((await db.one('SELECT eligibility_status FROM family_members WHERE id=$1', [b.id])).eligibility_status, 'eligible');
});

test('الأسماء مرتبة أبجديًا (مع توحيد الهمزات) في قائمة الأسر والكشوف', async () => {
  const { login, db } = require('./helpers');
  const F = require('./fixtures');
  const mgr = await login('manager');
  const order = ['إبراهيم سعد ترتيب', 'أحمد علي ترتيب', 'آمنة حسن ترتيب', 'بسمة فؤاد ترتيب', 'زينب عادل ترتيب', 'محمد كمال ترتيب'];
  for (const n of ['محمد كمال ترتيب', 'زينب عادل ترتيب', 'أحمد علي ترتيب', 'بسمة فؤاد ترتيب', 'إبراهيم سعد ترتيب', 'آمنة حسن ترتيب']) {
    await F.family(mgr, { g_full_name: n });
  }
  const r = await mgr.get('/families?q=' + encodeURIComponent('ترتيب'));
  const pos = order.map((n) => r.text.indexOf(n));
  assert.ok(pos.every((p) => p > 0), 'كل الأسماء ظاهرة');
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'الترتيب أبجدي');
  const k = await db.one(`SELECT ar_key('أحمد') = ar_key('احمد') AS same`);
  assert.equal(k.same, true);
});

test('الحذف بتأكيد وسلة المحذوفات والاسترجاع (أسرة، فرد، كفيل)', async () => {
  const { login, db } = require('./helpers');
  const F = require('./fixtures');
  const mgr = await login('manager');
  const fam = await F.family(mgr, { g_full_name: 'ولي للحذف تجربة' });
  const m = await F.member(mgr, fam, { full_name: 'فرد للحذف تجربة' });
  let show = await mgr.get(`/families/${fam}`);
  assert.match(show.text, /data-confirm="هل أنت متأكد من حذف/);
  // حذف فرد
  await mgr.post(`/members/${m.id}/delete`);
  show = await mgr.get(`/families/${fam}`);
  assert.ok(!show.text.includes(`id="m${m.id}"`), 'صف الفرد اختفى');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM family_members WHERE id=$1', [m.id])).n, 0);
  // حذف الأسرة
  const before = (await db.one('SELECT status FROM families WHERE id=$1', [fam])).status;
  await mgr.post(`/families/${fam}/delete`);
  await mgr.get('/'); // استهلاك رسالة التنبيه
  let list = await mgr.get('/families?status=all&q=' + encodeURIComponent('ولي للحذف'));
  assert.doesNotMatch(list.text, /ولي للحذف تجربة/);
  const trash = await mgr.get('/trash');
  assert.match(trash.text, /ولي للحذف تجربة/); assert.match(trash.text, /فرد للحذف تجربة/);
  // الاسترجاع
  await mgr.post(`/families/${fam}/restore`);
  await mgr.post(`/members/${m.id}/restore`);
  assert.equal((await db.one('SELECT status, deleted_at FROM families WHERE id=$1', [fam])).status, before);
  list = await mgr.get('/families?q=' + encodeURIComponent('ولي للحذف'));
  assert.match(list.text, /ولي للحذف تجربة/);
  assert.ok((await mgr.get(`/families/${fam}`)).text.includes(`id="m${m.id}"`), 'الفرد رجع');
  // الباحث الاجتماعي لا يحذف
  const social = await login('social');
  assert.equal((await social.post(`/families/${fam}/delete`)).status, 403);
});
