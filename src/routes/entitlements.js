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
  await autoSync(U.todayISO().slice(0, 7));
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
  await autoSync(period);
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
     WHERE ${where.join(' AND ')} ORDER BY ar_key(COALESCE(g.full_name, f.family_name)) COLLATE ar_sort, f.file_no`, params);
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
  await db.tx((c) => ent.amendAmount(c, id, { kafala: req.body.kafala_amount, aid: req.body.aid_amount }, U.str(req.body.reason, { max: 500 }), req.user, req));
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

// ============================================================
// كشف التوقيع بالاستلام وإيصالات الأسر (للطباعة أو PDF)
// ============================================================
const tafqit = require('../lib/tafqit');
const exporters = require('../lib/exporters');

async function receiptRows({ period, ids = null, onlyUnpaid = false }) {
  const params = []; const where = ["e.status <> 'cancelled'"];
  if (period) { params.push(period); where.push(`e.period=$${params.length}`); }
  if (ids) { params.push(ids); where.push(`e.id = ANY($${params.length})`); }
  if (onlyUnpaid) where.push('e.amount_paid < e.amount_due');
  const rows = await db.many(
    `SELECT e.*, f.file_no, f.family_name, f.aid_note, g.full_name AS guardian_name, g.relation AS guardian_relation, g.phone AS guardian_phone,
       (SELECT max(d.disb_date) FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS last_date
     FROM monthly_entitlements e JOIN families f ON f.id=e.family_id LEFT JOIN guardians g ON g.family_id=f.id
     WHERE ${where.join(' AND ')} ORDER BY ar_key(COALESCE(g.full_name, f.family_name)) COLLATE ar_sort, f.file_no`, params);
  const members = rows.length ? await db.many(
    `SELECT id, family_id, full_name FROM family_members WHERE family_id = ANY($1) ORDER BY birth_date`, [rows.map((r) => r.family_id)]) : [];
  for (const r of rows) {
    const inc = new Set((r.calc_detail.lines || []).filter((l) => l.member_id).map((l) => l.member_id));
    const excl = new Set((r.calc_detail.excluded || []).map((x) => x.id));
    r.beneficiaries = members.filter((m) => m.family_id === r.family_id && (inc.size ? inc.has(m.id) : !excl.has(m.id))).map((m) => m.full_name);
  }
  return rows;
}

async function sendPrintable(req, res, view, data, { landscape = false, filename }) {
  const org = res.locals.org;
  const [unit, sub] = tafqit.currencyWords(org.currency);
  const words = (cents) => tafqit.amountWords(cents, unit, sub);
  const forPdf = req.query.format === 'pdf';
  const assets = forPdf ? await exporters.embeddedAssets(org) : null;
  const html = await new Promise((resolve, reject) => res.app.render(view, { ...res.locals, ...data, words, forPdf, assets, landscape }, (e, h) => (e ? reject(e) : resolve(h))));
  await audit.log(req, forPdf ? 'print_pdf' : 'print', 'receipts', data.period || '', { after: { view, count: data.rows.length } });
  if (!forPdf) return res.send(html);
  const pdf = await exporters.htmlToPdf(html, { landscape, footer: `${org.name} — ${data.title}` });
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${filename}.pdf"`).send(Buffer.from(pdf));
}

// حساب تلقائي لكشف الشهر الحالي قبل عرضه (لا يوقف الصفحة لو حصل خطأ)
const autoSync = async (period) => { try { await ent.autoSync(period); } catch (e) { console.error('الحساب التلقائي:', e.message); } };

const canPrint = (req) => { if (!req.perms.has('reports.export')) throw new U.UserError('الطباعة تتطلب صلاحية الطباعة والتصدير', 403); };

router.get('/entitlements/:period(\\d{4}-\\d{2})/sheet', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const period = req.params.period;
  await autoSync(period);
  const rows = await receiptRows({ period, onlyUnpaid: req.query.only === 'unpaid' });
  await sendPrintable(req, res, 'entitlements/sheet', { period, rows, title: `كشف التوقيع بالاستلام — ${U.periodLabel(period)}`, onlyUnpaid: req.query.only === 'unpaid' },
    { landscape: true, filename: `sheet-${period}` });
}));

router.get('/entitlements/:period(\\d{4}-\\d{2})/receipts', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const period = req.params.period;
  await autoSync(period);
  const rows = await receiptRows({ period, onlyUnpaid: req.query.only === 'unpaid' });
  await sendPrintable(req, res, 'entitlements/receipts', { period, rows, title: `إيصالات استلام — ${U.periodLabel(period)}` }, { filename: `receipts-${period}` });
}));

// كشف الاستلام المجمّع: جدول بكل الأسر (20 أسرة في الصفحة تقريبًا) بالتوقيع والتاريخ.
// كل شهر يُحفظ تلقائيًا كنسخة ثابتة، وأي تغيير لاحق في المستحقات يحفظ نسخة جديدة (القديمة لا تُحذف).
const statementRow = (r) => ({ file_no: r.file_no, guardian: r.guardian_name || r.family_name, phone: r.guardian_phone || '',
  kafala: r.kafala_amount, aid: r.aid_amount, due: r.amount_due });

const KINDS = {
  all: { title: 'كشف استلام الكفالة والإعانة', short: 'الكفالة والإعانة' },
  kafala: { title: 'كشف استلام الكفالة', short: 'الكفالة' },
  aid: { title: 'كشف استلام الإعانة', short: 'الإعانة' },
};
const kindOf = (q) => (KINDS[q] ? q : 'all');

/** صفوف الكشف حسب البند: كل كشف يحسب مبالغه وإجماليه لوحده */
function rowsForKind(rows, kind) {
  const out = [];
  for (const r of rows.map(statementRow)) {
    if (kind === 'kafala') { if (U.toCents(r.kafala) > 0) out.push({ ...r, aid: '0.00', due: r.kafala }); }
    else if (kind === 'aid') { if (U.toCents(r.aid) > 0) out.push({ ...r, kafala: '0.00', due: r.aid }); }
    else out.push(r);
  }
  return out;
}

async function saveStatement(period, kind, srows, userId) {
  const data = { rows: srows };
  const hash = crypto.createHash('sha256').update(JSON.stringify(srows)).digest('hex');
  const last = await db.one('SELECT * FROM monthly_statements WHERE period=$1 AND kind=$2 ORDER BY version DESC LIMIT 1', [period, kind]);
  if (last && last.data_hash === hash) return last;
  const total = U.fromCents(srows.reduce((a, r) => a + U.toCents(r.due), 0));
  try {
    return await db.one(`INSERT INTO monthly_statements (period, kind, version, data, data_hash, family_count, total_due, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [period, kind, (last ? last.version : 0) + 1, data, hash, srows.length, total, userId]);
  } catch (e) {
    if (e.code === '23505') return db.one('SELECT * FROM monthly_statements WHERE period=$1 AND kind=$2 ORDER BY version DESC LIMIT 1', [period, kind]);
    throw e;
  }
}

const perPage = (q) => { const n = parseInt(q, 10); return n >= 10 && n <= 25 ? n : 15; };

async function renderStatement(req, res, st) {
  const per = perPage(req.query.per);
  const latest = await db.one('SELECT max(version) AS v FROM monthly_statements WHERE period=$1 AND kind=$2', [st.period, st.kind]);
  await sendPrintable(req, res, 'entitlements/receipts-compact', {
    period: st.period, rows: st.data.rows, st, per, kind: st.kind, kinds: KINDS, isLatest: st.version === latest.v,
    pdfQuery: `format=pdf&per=${per}`,
    title: `${KINDS[st.kind].title} — ${U.periodLabel(st.period)}`,
  }, { filename: `kashf-${st.kind}-${st.period}-v${st.version}` });
}

router.get('/entitlements/:period(\\d{4}-\\d{2})/receipts-compact', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const period = req.params.period;
  await autoSync(period);
  const kind = kindOf(req.query.type);
  const srows = rowsForKind(await receiptRows({ period }), kind);
  if (!srows.length) throw new U.UserError(`لا توجد أسر في ${KINDS[kind].title} لشهر ${U.periodLabel(period)}.`, 404);
  const st = await saveStatement(period, kind, srows, req.user.id);
  await renderStatement(req, res, st);
}));

// أرشيف الكشوف المحفوظة لكل الشهور
router.get('/statements', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const list = await db.many(`SELECT s.id, s.period, s.kind, s.version, s.family_count, s.total_due, s.created_at, u.full_name AS by_name,
      s.version = max(s.version) OVER (PARTITION BY s.period, s.kind) AS is_latest
    FROM monthly_statements s LEFT JOIN users u ON u.id=s.created_by ORDER BY s.period DESC, s.kind, s.version DESC`);
  res.render('entitlements/statements', { title: 'أرشيف كشوف الاستلام الشهرية', list, kinds: KINDS });
}));

router.get('/statements/:id(\\d+)', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const st = await db.one('SELECT * FROM monthly_statements WHERE id=$1', [U.intId(req.params.id)]);
  if (!st) throw new U.UserError('الكشف غير موجود', 404);
  await renderStatement(req, res, st);
}));

router.get('/entitlements/item/:id(\\d+)/receipt', can('entitlements.view'), h(async (req, res) => {
  canPrint(req);
  const rows = await receiptRows({ ids: [U.intId(req.params.id)] });
  if (!rows.length) throw new U.UserError('السجل غير موجود أو ملغى', 404);
  await sendPrintable(req, res, 'entitlements/receipts', { period: rows[0].period, rows, title: `إيصال استلام ${rows[0].file_no} — ${U.periodLabel(rows[0].period)}` },
    { filename: `receipt-${rows[0].file_no}-${rows[0].period}` });
}));

// صرف سريع: «استلم بالكامل» بزر واحد (المتبقي كاملًا، اليوم، بطريقة استلام الأسرة المعتادة)
router.post('/entitlements/item/:id(\\d+)/quick', can('disbursements.create'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const fin = await settings.get('finance');
  let period;
  await db.tx(async (c) => {
    const e = await c.one(`SELECT e.*, g.payout_method FROM monthly_entitlements e LEFT JOIN guardians g ON g.family_id=e.family_id WHERE e.id=$1`, [id]);
    if (!e) throw new U.UserError('السجل غير موجود', 404);
    period = e.period;
    const pend = await c.one(`SELECT COALESCE(SUM(amount),0)::text AS v FROM disbursements WHERE entitlement_id=$1 AND status='pending_approval'`, [id]);
    const rem = U.toCents(e.amount_due) - U.toCents(e.amount_paid) - U.toCents(pend.v);
    if (rem <= 0) throw new U.UserError('هذه الأسرة استلمت مستحقها بالكامل');
    let fund = 'orphans';
    if ((await finance.availableCents(c, 'orphans', e.family_id)) < rem && fin.allow_general_fund_for_kafala && (await finance.availableCents(c, 'general')) >= rem) fund = 'general';
    const method = ['cash', 'bank_transfer', 'wallet', 'cheque', 'other'].includes(e.payout_method) ? e.payout_method : 'cash';
    await ent.disburse(c, id, { amount: U.fromCents(rem), date: U.todayISO(), method, fund, idempotency_key: U.str(req.body.idempotency_key, { required: true, max: 80, label: 'مفتاح العملية' }), notes: 'صرف سريع: استلم بالكامل' }, req.user, req);
  }).catch((e) => {
    if (e.code === '23505' && /idempotency/.test(e.constraint || e.detail || '')) throw new U.UserError('تم تسجيل هذا الصرف مسبقًا (منع التكرار)');
    throw e;
  });
  flash(req, 'success', 'تم تسجيل استلام الأسرة لمستحقها كاملًا');
  res.redirect(`/entitlements/${period}#e${id}`);
}));
