'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { resetDb, login, db, idFrom } = require('./helpers');
const F = require('./fixtures');
const U = require('../src/lib/util');
const reports = require('../src/lib/reports');

let mgr; let acc; let cashier; let social;
const P = U.currentPeriod();
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

before(async () => {
  await resetDb();
  mgr = await login('manager'); acc = await login('accountant'); cashier = await login('cashier'); social = await login('social');
  await F.donation(acc, { type_code: 'orphans', amount: '20000' });
  await F.donation(acc, { type_code: 'general', amount: '3000' });
  const s = idFrom(await acc.post('/sponsors', { full_name: 'كفيل التقرير', phone: '0122222222', monthly_pledge: '600' }));
  const fam = await F.family(mgr, { calc_method: 'family_fixed', monthly_amount: '1000' });
  await F.member(mgr, fam);
  await acc.post(`/sponsors/${s}/links`, { family_id: String(fam), monthly_amount: '600', start_date: U.todayISO() });
  await acc.post(`/sponsors/${s}/collect`, { period: P, amount: '600', donation_date: U.todayISO(), payment_method: 'cash', donor_name: 'كفيل التقرير' });
  await mgr.post('/entitlements/generate', { period: P });
  const e = await db.one('SELECT id FROM monthly_entitlements WHERE family_id=$1', [fam]);
  await cashier.post(`/entitlements/item/${e.id}/disburse`, { amount: '400', date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'r1', reference: 'REC-1' });
});
after(() => db.pool.end());

test('التقرير المالي يطابق السجلات ولا يحتسب مساهمة الكفيل مرتين', async () => {
  const r = await reports.build('financial', P, 'detailed');
  const item = (lbl) => r.sections[0].items.find((i) => i.label.startsWith(lbl)).cents;
  assert.equal(item('إجمالي التبرعات المحصلة'), 2360000);
  assert.equal(item('— منها مساهمات الكفلاء'), 60000);
  assert.equal(item('— منها مساهمات الكفلاء') + item('— منها التبرعات العامة') + item('— منها التبرعات المخصصة'), item('إجمالي التبرعات المحصلة'));
  assert.equal(item('إجمالي مستحقات الشهر'), 100000);
  assert.equal(item('— منها الكفالات') + item('— منها الإعانات'), 100000);
  assert.equal(item('إجمالي المبالغ المصروفة للأسر'), 40000);
  assert.equal(item('المستحقات غير المدفوعة'), 60000);
  assert.equal(item('المتبقي من عمليات الصرف الجزئي'), 60000);
  assert.equal(item('الرصيد الختامي'), 2360000 - 40000);
});

test('جميع التقارير الستة تعمل بالمستويين، وشهر بلا عمليات يعطي أصفارًا', async () => {
  for (const t of Object.keys(reports.BUILDERS)) {
    for (const lvl of ['detailed', 'summary']) {
      const r = await mgr.get(`/reports?go=1&period=${P}&type=${t}&level=${lvl}`);
      assert.equal(r.status, 200, `${t} ${lvl}`);
    }
  }
  const empty = await reports.build('financial', '2020-01', 'detailed');
  for (const it of empty.sections[0].items) if (it.money) assert.equal(it.cents, 0, it.label);
  const d = await reports.build('disbursements', '2020-01', 'detailed');
  assert.equal(d.sections[1].rows.length, 0);
});

test('صلاحيات التقارير: الباحث الاجتماعي لا يرى التقرير المالي', async () => {
  assert.equal((await social.get(`/reports?go=1&period=${P}&type=financial`)).status, 403);
  assert.equal((await social.get(`/reports/export.xlsx?period=${P}&type=financial`)).status, 403);
  assert.equal((await cashier.get(`/reports?go=1&period=${P}&type=financial`)).status, 403);
  assert.equal((await cashier.get(`/reports/print?period=${P}&type=disbursements`)).status, 200);
});

test('قالب الطباعة: A4، RTL، ترويسة، إجماليات، ولا بيانات حساسة', async () => {
  const fam = (await db.one('SELECT family_id FROM monthly_entitlements LIMIT 1')).family_id;
  await mgr.post(`/families/${fam}`, { family_name: 'أسرة', g_full_name: 'ولي', g_phone: '0100000999', g_national_id: '28801019999999', g_iban: 'EG000000SECRET', calc_method: 'family_fixed', monthly_amount: '1000' });
  const r = await mgr.get(`/reports/print?period=${P}&type=disbursements&level=detailed`);
  assert.match(r.text, /dir="rtl"/); assert.match(r.text, /size: A4/); assert.match(r.text, /<thead>/); assert.match(r.text, /<tfoot>/);
  assert.match(r.text, /الجمعية الشرعية/); assert.match(r.text, /المستلمة بالكامل/);
  assert.doesNotMatch(r.text, /28801019999999|EG000000SECRET/);
  const fr = await mgr.get(`/reports/print?period=${P}&type=families&level=detailed`);
  assert.doesNotMatch(fr.text, /28801019999999|EG000000SECRET/);
});

test('تصدير Excel وCSV', async () => {
  const x = await mgr.get(`/reports/export.xlsx?period=${P}&type=disbursements`).buffer(true).parse(binary);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
  const ws = wb.worksheets[0];
  assert.equal(ws.views[0].rightToLeft, true);
  let found = false; ws.eachRow((row) => { if (row.values.includes('الإجمالي (شامل الملغى إن وجد)')) found = true; });
  assert.ok(found, 'صف الإجمالي موجود');
  const c = await mgr.get(`/reports/export.csv?period=${P}&type=financial`);
  assert.ok(c.text.startsWith('﻿'));
  assert.match(c.text, /الرصيد الختامي/);
});

test('تصدير PDF عربي حقيقي', { skip: !process.env.CHROME_PATH || !fs.existsSync(process.env.CHROME_PATH || '') }, async () => {
  const r = await mgr.get(`/reports/export.pdf?period=${P}&type=financial`).buffer(true).parse(binary);
  assert.equal(r.status, 200);
  assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  assert.ok(r.body.length > 10000);
});

test('حفظ التقرير المعتمد: إعداد، منع اعتماد المعد لنفسه، اعتماد، ثبات النسخة، وإصدار جديد عند تغير البيانات', { skip: !process.env.CHROME_PATH || !fs.existsSync(process.env.CHROME_PATH || '') }, async () => {
  await acc.post('/reports/prepare', { period: P, type: 'financial', level: 'detailed', accountant_notes: 'ملاحظة المحاسب' });
  const v1 = await db.one(`SELECT * FROM monthly_reports WHERE period=$1 AND report_type='financial'`, [P]);
  assert.equal(v1.status, 'pending'); assert.ok(v1.pdf_file);
  // المحاسب نفسه لا يملك الاعتماد؛ المدير يعتمد
  assert.equal((await acc.post(`/reports/${v1.id}/approve`, {})).status, 403);
  await mgr.post(`/reports/${v1.id}/approve`, {});
  const a1 = await db.one('SELECT * FROM monthly_reports WHERE id=$1', [v1.id]);
  assert.equal(a1.status, 'approved'); assert.ok(a1.approved_pdf_file);
  assert.equal(a1.summary.closing, 2360000 - 40000);
  await assert.rejects(db.query(`UPDATE monthly_reports SET summary='{}' WHERE id=$1`, [v1.id]), /لا يُعدَّل/);
  const pdf = await mgr.get(`/reports/saved/${v1.id}/pdf`).buffer(true).parse(binary);
  assert.equal(pdf.body.slice(0, 5).toString(), '%PDF-');
  // تغيير البيانات بعد الاعتماد → النسخة المعتمدة لا تتغير، والإصدار الجديد يستبدلها مع سبب
  await F.donation(acc, { type_code: 'general', amount: '100' });
  await acc.post('/reports/prepare', { period: P, type: 'financial', level: 'detailed' });
  const v2 = await db.one(`SELECT * FROM monthly_reports WHERE period=$1 AND report_type='financial' AND version=2`, [P]);
  await F.donation(acc, { type_code: 'general', amount: '1' }); // تغيّر بعد الإعداد
  await mgr.post(`/reports/${v2.id}/approve`, { reason: 'تبرع متأخر' });
  assert.equal((await db.one('SELECT status FROM monthly_reports WHERE id=$1', [v2.id])).status, 'pending', 'رفض الاعتماد لأن الأرقام تغيرت');
  await mgr.post(`/reports/${v2.id}/reject`, { reason: 'إعادة إعداد' });
  await acc.post('/reports/prepare', { period: P, type: 'financial', level: 'detailed' });
  const v3 = await db.one(`SELECT * FROM monthly_reports WHERE period=$1 AND report_type='financial' AND version=3`, [P]);
  await mgr.post(`/reports/${v3.id}/approve`, {});
  assert.equal((await db.one('SELECT status FROM monthly_reports WHERE id=$1', [v3.id])).status, 'pending', 'يلزم ذكر سبب الإصدار الجديد');
  await mgr.post(`/reports/${v3.id}/approve`, { reason: 'تبرعات متأخرة' });
  const rows = await db.many(`SELECT version, status, summary FROM monthly_reports WHERE period=$1 AND report_type='financial' ORDER BY version`, [P]);
  assert.deepEqual(rows.map((x) => x.status), ['superseded', 'rejected', 'approved']);
  assert.equal(rows[0].summary.closing, 2360000 - 40000, 'النسخة القديمة محفوظة كما هي');
  assert.equal(rows[2].summary.closing, 2360000 - 40000 + 10100);
});

test('المستندات: رفع آمن، رفض الملفات المزيفة، وحماية التنزيل', async () => {
  const fam = await F.family(mgr);
  const ok = await social.upload(`/families/${fam}/documents`, { doc_type: 'orphan_proof' }, { buffer: F.PNG, name: 'proof.png' });
  assert.equal(ok.status, 302);
  const d = await db.one('SELECT * FROM documents WHERE family_id=$1', [fam]);
  assert.equal(d.mime_type, 'image/png');
  assert.notEqual(d.stored_name, 'proof.png');
  const stored = await db.one('SELECT sha256, size_bytes FROM stored_files WHERE key=$1', [d.stored_name]);
  assert.equal(stored.sha256, d.sha256, 'الملف محفوظ في التخزين الخاص بقاعدة البيانات');
  // ملف تنفيذي متنكر كصورة
  await social.upload(`/families/${fam}/documents`, { doc_type: 'other_social' }, { buffer: Buffer.from('MZ\x90\x00 fake exe'), name: 'image.png' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM documents WHERE family_id=$1', [fam])).n, 1);
  // PDF يحتوي JavaScript
  await social.upload(`/families/${fam}/documents`, { doc_type: 'other_social' }, { buffer: Buffer.from('%PDF-1.4 /JavaScript (app.alert(1))'), name: 'x.pdf' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM documents WHERE family_id=$1', [fam])).n, 1);
  // التنزيل يتطلب الصلاحية
  const anon = require('supertest')(require('./helpers').getApp());
  assert.equal((await anon.get(`/documents/${d.id}/file`)).status, 302);
  assert.equal((await acc.get(`/documents/${d.id}/file`)).status, 403);
  const dl = await social.get(`/documents/${d.id}/file?download=1`).buffer(true).parse(binary);
  assert.equal(dl.status, 200); assert.ok(dl.body.equals(F.PNG));
  assert.match(dl.headers['content-disposition'], /attachment/);
  assert.notEqual((await anon.get(`/static/${d.stored_name}`)).status, 200);
  await db.query(`INSERT INTO stored_files (key, mime_type, size_bytes, sha256, data) VALUES ('reports/t.pdf','application/pdf',1,'x','\\x00') ON CONFLICT DO NOTHING`);
  await assert.rejects(db.query(`DELETE FROM stored_files WHERE key='reports/t.pdf'`), /غير قابل/);
  // استبدال المستند مع الاحتفاظ بالسابق
  await social.upload(`/families/${fam}/documents`, { doc_type: 'orphan_proof', replaces_id: String(d.id) }, { buffer: F.PDF, name: 'proof2.pdf' });
  assert.equal((await db.one('SELECT status FROM documents WHERE id=$1', [d.id])).status, 'replaced');
  assert.ok(await db.one(`SELECT 1 FROM audit_logs WHERE action='document_download' AND entity_id=$1`, [String(d.id)]));
});

test('الاستيراد: معاينة، اكتشاف التكرار والأخطاء، واستيراد الصالح فقط مع التقرير', async () => {
  const csv = '﻿اسم الأسرة,اسم ولي الأمر,جوال ولي الأمر,المدينة,طريقة الاحتساب,قيمة الكفالة الشهرية\n'
    + 'أسرة مستوردة 1,ولي 1,0155555501,طنطا,ثابت,700\n'
    + 'أسرة مستوردة 2,ولي 2,0155555502,طنطا,لكل مستفيد,0\n'
    + 'أسرة مكررة,ولي 3,0155555501,طنطا,ثابت,700\n'
    + ',ولي 4,0155555504,طنطا,ثابت,700\n'
    + 'أسرة خطأ,ولي 5,abc,طنطا,غريب,xyz\n';
  const up = await social.upload('/import', { import_type: 'families' }, { buffer: Buffer.from(csv), name: 'families.csv' });
  const bid = idFrom(up);
  const preview = await social.get(`/import/${bid}`);
  assert.match(preview.text, /مكرر داخل الملف/);
  assert.match(preview.text, /اسم الأسرة مطلوب/);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM families WHERE family_name LIKE 'أسرة مستوردة%'`)).n, 0, 'لا إدخال قبل التأكيد');
  await social.post(`/import/${bid}/commit`, {});
  const b = await db.one('SELECT * FROM import_batches WHERE id=$1', [bid]);
  assert.equal(b.status, 'completed'); assert.equal(b.result.imported, 2); assert.equal(b.result.failed, 3);
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM families WHERE family_name LIKE 'أسرة مستوردة%' AND status='under_review'`)).n, 2);
  // استيراد الأفراد بربطهم برقم الجوال
  const fno = (await db.one(`SELECT f.file_no FROM families f JOIN guardians g ON g.family_id=f.id WHERE g.phone='0155555501'`)).file_no;
  const csv2 = 'رقم ملف الأسرة,جوال ولي الأمر,الاسم الرباعي,تاريخ الميلاد,الجنس,صلة القرابة\n'
    + `${fno},,طفل مستورد,15/03/2015,ذكر,ابن\n,0155555502,طفلة مستوردة,2012-07-01,أنثى,ابنة\n,0199999999,مجهول,2012-07-01,ذكر,ابن\n`;
  const admin = await login('admin');
  assert.equal((await mgr.get('/import')).status, 403, 'الاستيراد يتطلب صلاحية مستقلة');
  const b2 = idFrom(await admin.upload('/import', { import_type: 'members' }, { buffer: Buffer.from(csv2), name: 'members.csv' }));
  await admin.post(`/import/${b2}/commit`, { approve_eligible: '1' });
  const r2 = (await db.one('SELECT result FROM import_batches WHERE id=$1', [b2])).result;
  assert.equal(r2.imported, 2); assert.equal(r2.failed, 1);
  const m = await db.one(`SELECT birth_date, eligibility_status FROM family_members WHERE full_name='طفل مستورد'`);
  assert.equal(m.birth_date, '2015-03-15'); assert.equal(m.eligibility_status, 'eligible');
  const tpl = await admin.get('/import/template/sponsors.xlsx').buffer(true).parse(binary);
  assert.equal(tpl.status, 200);
});
