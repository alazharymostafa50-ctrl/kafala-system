'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resetDb, login, db } = require('./helpers');
const F = require('./fixtures');
const U = require('../src/lib/util');
const ent = require('../src/lib/entitlements');
const reports = require('../src/lib/reports');
const stats = require('../src/lib/stats');
const finance = require('../src/lib/finance');

const P = U.currentPeriod();
let mgr; let acc;
before(async () => { await resetDb(); mgr = await login('manager'); acc = await login('accountant'); });
after(() => db.pool.end());

test('شهر بعدد كبير من الأسر والعمليات (400 أسرة)', async () => {
  await F.donation(acc, { type_code: 'orphans', amount: '5000000' });
  const t0 = Date.now();
  await db.tx(async (c) => {
    for (let i = 0; i < 400; i++) {
      const f = await c.one(`INSERT INTO families (family_name, status, calc_method, monthly_amount) VALUES ($1,'active',$2,$3) RETURNING id`, ['أسرة حجم ' + i, i % 2 ? 'per_member' : 'family_fixed', i % 2 ? '0' : '800']);
      await c.query(`INSERT INTO guardians (family_id, full_name, phone) VALUES ($1,'ولي',$2)`, [f.id, '0170' + String(i).padStart(7, '0')]);
      for (let k = 0; k < 3; k++) await c.query(`INSERT INTO family_members (family_id, full_name, birth_date, gender, relation, eligibility_status, monthly_amount) VALUES ($1,$2,'2015-01-01','male','ابن','eligible','250')`, [f.id, `فرد ${i}-${k}`]);
    }
  });
  const user = await db.one(`SELECT id, username FROM users WHERE username='manager'`);
  const r = await db.tx((c) => ent.generate(c, P, user));
  assert.equal(r.created, 400);
  const rows = await db.many('SELECT id, amount_due FROM monthly_entitlements WHERE period=$1 ORDER BY id', [P]);
  let i = 0;
  for (const e of rows) {
    i++;
    if (i % 5 === 0) continue;
    const amt = i % 7 === 0 ? U.fromCents(U.toCents(e.amount_due) / 2) : e.amount_due;
    await db.tx((c) => ent.disburse(c, e.id, { amount: amt, date: U.todayISO(), method: 'cash', fund: 'orphans', idempotency_key: 'v' + e.id }, user));
  }
  const t = await stats.entitlementTotals(db, P);
  const raw = await db.one(`SELECT SUM(amount_due)::text AS due, SUM(amount_paid)::text AS paid FROM monthly_entitlements WHERE period=$1`, [P]);
  assert.equal(t.due, U.toCents(raw.due)); assert.equal(t.paid, U.toCents(raw.paid));
  assert.equal(t.full + t.partial + t.none, 400);
  assert.equal(t.none, 80);
  const disbLedger = await db.one(`SELECT SUM(amount)::text AS v FROM ledger_entries WHERE source_type='disbursement' AND period=$1`, [P]);
  assert.equal(U.toCents(disbLedger.v), t.paid);
  const t1 = Date.now();
  const rep = await reports.build('disbursements', P, 'detailed');
  assert.equal(rep.sections[1].rows.length, 400);
  const page = await mgr.get(`/entitlements/${P}`);
  assert.equal(page.status, 200);
  const dash = await mgr.get('/');
  assert.equal(dash.status, 200);
  assert.ok(Date.now() - t1 < 10000, 'التقرير واللوحة سريعان');
  const sum = await finance.periodSummary(db, P);
  assert.equal(sum.totals.closing, 500000000 - t.paid);
  console.log(`  ⏱  إنشاء وصرف 400 أسرة: ${t1 - t0}ms، التقرير واللوحة: ${Date.now() - t1}ms`);
});

test('النسخ الاحتياطي المشفر والاستعادة إلى قاعدة منفصلة', async () => {
  const { backup } = require('../scripts/backup');
  const { restore } = require('../scripts/restore');
  const fam = await F.family(mgr);
  await mgr.upload(`/families/${fam}/documents`, { doc_type: 'orphan_proof' }, { buffer: F.PNG, name: 'p.png' });
  const file = backup();
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file);
  assert.equal(raw.slice(0, 8).toString(), 'KAFBAK01');
  assert.ok(!raw.includes(Buffer.from('أسرة حجم')), 'المحتوى مشفر');
  const target = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/kafala_test_restore');
  execFileSync('psql', [process.env.DATABASE_URL.replace(/\/[^/]+$/, '/postgres'), '-q', '-c', 'DROP DATABASE IF EXISTS kafala_test_restore', '-c', 'CREATE DATABASE kafala_test_restore']);
  const storage = fs.mkdtempSync('/tmp/kaf-restore-');
  restore(file, { targetDb: target, storage });
  const { Client } = require('pg');
  const cl = new Client({ connectionString: target }); await cl.connect();
  const q = async (dbx, sql) => (await dbx.query(sql)).rows[0];
  for (const sql of ['SELECT count(*)::int AS n FROM families', 'SELECT SUM(amount)::text AS n FROM ledger_entries', 'SELECT count(*)::int AS n FROM audit_logs', 'SELECT count(*)::int AS n FROM documents']) {
    assert.deepEqual(await q(cl, sql), await q(db, sql), sql);
  }
  // القيود المحمية تبقى محمية بعد الاستعادة
  await assert.rejects(cl.query('DELETE FROM ledger_entries'), /غير قابل/);
  await cl.end();
  const doc = await db.one('SELECT stored_name FROM documents WHERE family_id=$1', [fam]);
  const cl2 = new Client({ connectionString: target }); await cl2.connect();
  assert.equal((await cl2.query('SELECT count(*)::int AS n FROM stored_files WHERE key=$1', [doc.stored_name])).rows[0].n, 1, 'المستند ضمن النسخة');
  await cl2.end();
  process.env.BACKUP_KEY = 'wrong-key-wrong-key';
  assert.throws(() => restore(file, { targetDb: target, storage }), /فك التشفير/);
});
