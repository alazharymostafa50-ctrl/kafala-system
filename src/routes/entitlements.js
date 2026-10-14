'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const ent = require('../lib/entitlements');
const elig = require('../lib/eligibility');
const stats = require('../lib/stats');
const settings = require('../lib/settings');
const finance = require('../lib/finance');
const { memoryUpload, storeDocument } = require('../lib/uploads');
const { h, can, flash } = require('../middleware');

const upload = h(async (req, res, next) => memoryUpload(Number((await settings.get('documents')).max_size_mb || 8)).single('file')(req, res, next));

router.get('/entitlements', can('entitlements.view'), h(async (req, res) => {
  const runs = await db.many(
    `SELECT r.*, u.full_name AS by_name, count(e.id)::int AS families, COALESCE(SUM(e.amount_due) FILTER (WHERE e.status<>'cancelled'),0)::text AS due,
       COALESCE(SUM(e.amount_paid),0)::text AS paid FROM monthly_runs r LEFT JOIN monthly_entitlements e ON e.run_id=r.id LEFT JOIN users u ON u.id=r.created_by
     GROUP BY r.id, u.full_name ORDER BY r.period DESC`);
  res.render('entitlements/index', { title: 'الاستحقاقات والصرف الشهري', runs, period: U.currentPeriod() });
}));

router.post('/entitlements/generate', can('entitlements.generate'), h(async (req, res) => {
  const period = req.body.period;
  const mode = req.body.mode === 'add_missing' ? 'add_missing' : 'new';
  await elig.runEngine({ user: req.user });
  const r = await db.tx((c) => ent.generate(c, period, req.user, { mode, req }));
  flash(req, 'success', `تم إنشاء ${r.created} سجل استحقاق بإجمالي ${U.fmtMoney(U.fromCents(r.total))}` +
    (r.flagged ? ` — ${r.flagged} سجل يحتاج مراجعة` : '') + (r.skippedZero.length ? ` — استُبعدت ${r.skippedZero.length} أسرة لعدم وجود مبلغ مستحق (${r.skippedZero.slice(0, 10).join('، ')})` : ''));
  res.redirect(`/entitlements/${period}`);
}));

router.get('/entitlements/:period(\\d{4}-\\d{2})', can('entitlements.view'), h(async (req, res) => {
  const period = req.params.period;
  if (!U.validPeriod(period)) throw new U.UserError('الشهر غير صالح', 404);
  const run = await db.one('SELECT * FROM monthly_runs WHERE period=$1', [period]);
  const params = [period]; const where = ['e.period=$1'];
  if (req.query.only === 'unpaid') where.push("e.amount_paid = 0 AND e.status <> 'cancelled'");
  if (req.query.only === 'review') where.push('e.needs_review');
  if (req.query.status) { params.push(req.query.status); where.push(`e.status=$${params.length}`); }
  if (req.query.q) { params.push('%' + req.query.q.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(f.file_no ILIKE $${params.length} OR f.family_name ILIKE $${params.length} OR g.full_name ILIKE $${params.length})`); }
  const rows = await db.many(
    `SELECT e.*, f.file_no, f.family_name, g.full_name AS guardian_name, g.payout_method,
       (SELECT max(disb_date) FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS last_date,
       (SELECT string_agg(DISTINCT d.method, ',') FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS methods,
       (SELECT string_agg(d.reference, '، ') FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid' AND d.reference IS NOT NULL) AS refs
     FROM monthly_entitlements e JOIN families f ON f.id=e.family_id LEFT JOIN guardians g ON g.family_id=f.id
     WHERE ${where.join(' AND ')} ORDER BY f.file_no`, params);
  const totals = await stats.entitlementTotals(db, period);
  const pending = await db.many(
    `SELECT d.*, f.file_no, f.family_name, u.full_name AS by_name FROM disbursements d JOIN families f ON f.id=d.family_id LEFT JOIN users u ON u.id=d.created_by
     WHERE d.period=$1 AND d.status='pending_approval' ORDER BY d.created_at`, [period]);
  const avail = { orphans: await finance.availableCents(db, 'orphans'), general: await finance.availableCents(db, 'general') };
  const fin = await settings.get('finance');
  res.render('entitlements/period', { title: `كشف ${U.periodLabel(period)}`, period, run, rows, totals, pending, avail, fin, newKey: () => crypto.randomUUID() });
}));

router.get('/entitlements/item/:id(\\d+)', can('entitlements.view'), h(async (req, res) => {
  const e = await db.one(`SELECT e.*, f.file_no, f.family_name FROM monthly_entitlements e JOIN families f ON f.id=e.family_id WHERE e.id=$1`, [U.intId(req.params.id)]);
  if (!e) throw new U.UserError('السجل غير موجود', 404);
  const ds = await db.many(`SELECT d.*, u1.full_name AS by_name, u2.full_name AS appr_name FROM disbursements d LEFT JOIN users u1 ON u1.id=d.created_by LEFT JOIN users u2 ON u2.id=d.approved_by WHERE entitlement_id=$1 ORDER BY d.created_at`, [e.id]);
  const log = await db.many(`SELECT * FROM audit_logs WHERE entity='monthly_entitlement' AND entity_id=$1 ORDER BY at`, [String(e.id)]);
  res.render('entitlements/item', { title: `استحقاق ${e.file_no} — ${U.periodLabel(e.period)}`, e, ds, log, newKey: crypto.randomUUID() });
}));

router.post('/entitlements/item/:id(\\d+)/disburse', can('disbursements.create'), upload, h(async (req, res) => {
  const id = U.intId(req.params.id);
  let period;
  await db.tx(async (c) => {
    const e = await c.one('SELECT family_id, period FROM monthly_entitlements WHERE id=$1', [id]);
    if (!e) throw new U.UserError('السجل غير موجود', 404);
    period = e.period;
    let docId = null;
    const stored = req.file ? await storeDocument(c, req.file) : null;
    if (stored) {
      docId = (await c.one(`INSERT INTO documents (family_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, status, uploaded_by)
        VALUES ($1,'disbursement_receipt',$2,$3,$4,$5,$6,'approved',$7) RETURNING id`, [e.family_id, stored.original_name, stored.stored_name, stored.mime_type, stored.size_bytes, stored.sha256, req.user.id])).id;
    }
    await ent.disburse(c, id, { ...req.body, document_id: docId }, req.user, req);
  }).catch((e) => {
    if (e.code === '23505' && /idempotency/.test(e.constraint || e.detail || '')) throw new U.UserError('تم استلام هذا الطلب مسبقًا (منع الإرسال المكرر). حدّث الصفحة للتحقق.');
    throw e;
  });
  flash(req, 'success', 'تم تسجيل عملية الصرف وتحديث المتبقي والأرصدة');
  res.redirect(req.body.back === 'item' ? `/entitlements/item/${id}` : `/entitlements/${period}#e${id}`);
}));

router.post('/disbursements/:id(\\d+)/:action(approve|reject|reverse)', h(async (req, res) => {
  const id = U.intId(req.params.id);
  const action = req.params.action;
  if (!req.perms.has('disbursements.approve')) throw new U.UserError('ليست لديك صلاحية اعتماد أو عكس الصرف', 403);
  const d = await db.one('SELECT period, entitlement_id FROM disbursements WHERE id=$1', [id]);
  if (!d) throw new U.UserError('العملية غير موجودة', 404);
  const reason = U.str(req.body.reason, { max: 500 });
  await db.tx((c) => (action === 'reverse' ? ent.reverseDisbursement(c, id, req.user, reason, req) : ent.approveDisbursement(c, id, req.user, action === 'approve', reason, req)));
  flash(req, 'success', { approve: 'تم اعتماد الصرف وتسجيله ماليًا', reject: 'تم رفض عملية الصرف', reverse: 'تم عكس عملية الصرف بقيد موثق' }[action]);
  res.redirect(req.body.back === 'item' ? `/entitlements/item/${d.entitlement_id}` : `/entitlements/${d.period}`);
}));

router.post('/entitlements/item/:id(\\d+)/status', can('entitlements.generate'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  await db.tx((c) => ent.setStatus(c, id, req.body.status, U.str(req.body.reason, { max: 500 }), req.user, req));
  flash(req, 'success', 'تم تحديث حالة الصرف مع توثيق السبب');
  res.redirect(`/entitlements/item/${id}`);
}));

router.post('/entitlements/item/:id(\\d+)/amend', can('entitlements.generate'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  await db.tx((c) => ent.amendAmount(c, id, req.body.amount_due, U.str(req.body.reason, { max: 500 }), req.user, req));
  flash(req, 'success', 'تم تعديل المبلغ المستحق بقرار موثق');
  res.redirect(`/entitlements/item/${id}`);
}));

router.post('/entitlements/:period(\\d{4}-\\d{2})/close', can('entitlements.generate'), h(async (req, res) => {
  const period = req.params.period;
  const r = await db.query(`UPDATE monthly_runs SET status='closed' WHERE period=$1 AND status='open'`, [period]);
  if (!r.rowCount) throw new U.UserError('الكشف غير موجود أو مقفل مسبقًا');
  await audit.log(req, 'run_closed', 'monthly_run', period);
  flash(req, 'success', 'تم إقفال كشف الشهر؛ لا يمكن تعديل المستحقات إلا بتسوية موثقة. يظل تسجيل الصرف على المتبقي متاحًا.');
  res.redirect(`/entitlements/${period}`);
}));

module.exports = router;
