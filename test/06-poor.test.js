'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, login, db, idFrom } = require('./helpers');
const U = require('../src/lib/util');

before(resetDb);

test('قسم الفقراء: اختيار القسم بعد الدخول، والشريط الجانبي الخاص', async () => {
  const admin = await login('admin');
  assert.equal(admin.res.headers.location, '/choose');
  const ch = await admin.get('/choose');
  assert.match(ch.text, /الفقراء والمساكين/); assert.match(ch.text, /كفالة الأيتام/);
  const home = await admin.get('/poor');
  assert.equal(home.status, 200); assert.match(home.text, /sec-poor/); assert.match(home.text, /الانتقال إلى كفالة الأيتام/);
});

test('قسم الفقراء: الحالات والتحقق من الرقم القومي ومنع التكرار', async () => {
  const mgr = await login('manager');
  const bad = await mgr.post('/poor/cases', { full_name: 'حالة خطأ', national_id: '123', reason: 'widow', area: 'east', give_type: 'cash', monthly_amount: '200' });
  assert.notEqual(bad.headers.location || '', '/poor/cases/1');
  const r = await mgr.post('/poor/cases', { full_name: 'زينب محمود فقير', national_id: '29001011234567', phone: '01011112222', reason: 'widow', area: 'east', give_type: 'cash', monthly_amount: '300' });
  const id = idFrom(r); assert.ok(id);
  const dup = await mgr.post('/poor/cases', { full_name: 'تكرار', national_id: '29001011234567', reason: 'sick', area: 'west', give_type: 'in_kind' });
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM poor_cases WHERE national_id='29001011234567'`)).n, 1);
  await mgr.post('/poor/cases', { full_name: 'أحمد عيني فقير', reason: 'elderly', area: 'north', give_type: 'in_kind' });
  await mgr.post('/poor/cases', { full_name: 'سعد الاثنين فقير', reason: 'other', reason_note: 'إصابة عمل', area: 'south', give_type: 'both', monthly_amount: '150' });
  const list = await mgr.get('/poor/cases');
  assert.ok(list.text.indexOf('أحمد عيني فقير') < list.text.indexOf('زينب محمود فقير'), 'ترتيب أبجدي');
  const kafala = await mgr.get('/families');
  assert.doesNotMatch(kafala.text, /زينب محمود فقير/, 'منفصل عن الأيتام');
});

test('قسم الفقراء: الصندوق المستقل والإعانة النقدية الشهرية والكشف', async () => {
  const mgr = await login('manager');
  const period = U.currentPeriod();
  const c = await db.one(`SELECT id FROM poor_cases WHERE full_name='زينب محمود فقير'`);
  // بدون رصيد: يرفض
  await mgr.post(`/poor/monthly/${period}/pay/${c.id}`);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM poor_payments')).n, 0);
  const ledgerBefore = (await db.one('SELECT count(*)::int AS n FROM ledger_entries')).n;
  await mgr.post('/poor/donations', { donor_name: 'فاعل خير', kind: 'zakat', amount: '1000', donation_date: U.todayISO(), method: 'cash' });
  await mgr.post(`/poor/monthly/${period}/pay/${c.id}`);
  await mgr.post(`/poor/monthly/${period}/pay/${c.id}`); // تكرار
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM poor_payments WHERE status='paid'`)).n, 1);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM ledger_entries')).n, ledgerBefore, 'لا يمس حسابات الأيتام');
  const bal = await require('../src/routes/poor').balance();
  assert.equal(bal.balance, '700.00');
  const k = await mgr.get(`/poor/monthly/${period}/kashf`);
  assert.equal(k.status, 200);
  assert.match(k.text, /كشف الإعانة النقدية الشهرية/); assert.match(k.text, /المشهرة برقم 1248/); assert.match(k.text, /29001011234567/);
  assert.match(k.text, /سعد الاثنين فقير/); assert.doesNotMatch(k.text, /أحمد عيني فقير/);
});

test('قسم الفقراء: كشف العطاء العيني ببيانات الجمعية', async () => {
  const mgr = await login('manager');
  const r = await mgr.post('/poor/gifts', { title: 'عطاء عيني', items: 'أرز، سكر، زيت', dist_date: U.todayISO(), quantity: 'حصة واحدة', add_all: '1' });
  const gid = idFrom(r);
  const items = await db.many('SELECT * FROM poor_distribution_items WHERE distribution_id=$1', [gid]);
  assert.equal(items.length, 2, 'العيني + النقدي والعيني');
  await mgr.post(`/poor/gifts/${gid}/items/${items[0].id}`, { action: 'received' });
  assert.ok((await db.one('SELECT received_at FROM poor_distribution_items WHERE id=$1', [items[0].id])).received_at);
  const k = await mgr.get(`/poor/gifts/${gid}/kashf`);
  assert.equal(k.status, 200);
  assert.match(k.text, /كشف عطاء عيني/); assert.match(k.text, /أرز، سكر، زيت/); assert.match(k.text, /الجمعية الشرعية/); assert.match(k.text, /التوقيع بالاستلام/);
  // المراجع يرى ولا يعدل
  const aud = await login('auditor');
  assert.equal((await aud.get('/poor/cases')).status, 200);
  assert.equal((await aud.post('/poor/cases', { full_name: 'x', reason: 'widow', area: 'east', give_type: 'in_kind' })).status, 403);
});

test('قسم الفقراء: استيراد كشف من Excel مع فحص الرقم القومي والتكرار', async () => {
  const ExcelJS = require('exceljs');
  const mgr = await login('manager');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x');
  ws.addRow(['م', 'اسم المستفيد', 'رقم التليفون', 'الرقم القومى']);
  ws.addRow([1, 'مستورد أول', '01211112222', '28001011400011']);
  ws.addRow([2, 'مستورد مكرر', '01211113333', '28001011400011']);
  ws.addRow([3, 'مستورد رقم خطأ', '01211114444', '28013011400011']);
  ws.addRow([4, 'مستورد هاتف ناقص', '012111155', '28102021400022']);
  ws.addRow([5, 'مستورد بلا بيانات', '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const up = await mgr.upload('/poor/import', { area: 'east', give_type: 'in_kind', reason: 'low_income' }, { buffer: buf, name: 'east.xlsx' });
  const bid = idFrom(up); assert.ok(bid, 'تم الرفع');
  const pv = await mgr.get(`/poor/import/${bid}`);
  assert.match(pv.text, /مكرر في الملف/); assert.match(pv.text, /تاريخ الميلاد داخل الرقم القومي غير صحيح/); assert.match(pv.text, /رقم الهاتف غير صحيح/);
  await mgr.post(`/poor/import/${bid}/commit`);
  const added = await db.many(`SELECT * FROM poor_cases WHERE full_name LIKE 'مستورد%' ORDER BY id`);
  assert.equal(added.length, 3);
  assert.ok(added.every((c) => c.area === 'east' && c.give_type === 'in_kind'));
  assert.equal((await db.one('SELECT status FROM import_batches WHERE id=$1', [bid])).status, 'completed');
  await mgr.post(`/poor/import/${bid}/commit`);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM poor_cases WHERE full_name LIKE 'مستورد%'`)).n, 3, 'لا يتكرر الاستيراد');
});
