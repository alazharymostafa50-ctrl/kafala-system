'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const finance = require('../lib/finance');
const settings = require('../lib/settings');
const { memoryUpload, storeDocument } = require('../lib/uploads');
const { paged, Where } = require('../lib/paging');
const { h, can, flash } = require('../middleware');

const upload = h(async (req, res, next) => memoryUpload(Number((await settings.get('documents')).max_size_mb || 8)).single('file')(req, res, next));

async function parseExpense(c, b) {
  const cat = await c.one('SELECT * FROM expense_categories WHERE code=$1 AND is_active', [b.category_code]);
  if (!cat) throw new U.UserError('تصنيف المصروف غير صالح');
  const fund = U.oneOf(b.fund_code, ['general', 'orphans'], { label: 'الصندوق' });
  if (!cat.allowed_funds.includes(fund)) throw new U.UserError(`لا يجوز الصرف على «${cat.name}» من هذا الصندوق (الأموال المقيدة لا تُستخدم في غير أغراضها)`);
  const date = U.date(b.expense_date, { required: true, label: 'تاريخ العملية' });
  return {
    expense_date: date, category_code: cat.code, fund_code: fund,
    description: U.str(b.description, { required: true, max: 500, label: 'الوصف' }),
    amount: U.amount(b.amount), payee: U.str(b.payee, { max: 150 }), payment_method: U.str(b.payment_method, { max: 40 }),
    invoice_no: U.str(b.invoice_no, { max: 80 }), period: U.validPeriod(b.period) ? b.period : date.slice(0, 7), notes: U.str(b.notes, { max: 1000 }),
  };
}

async function step(c, expenseId, action, user, comment) {
  await c.query('INSERT INTO expense_approvals (expense_id, action, user_id, comment) VALUES ($1,$2,$3,$4)', [expenseId, action, user.id, comment || null]);
}

router.get('/expenses', can('expenses.view'), h(async (req, res) => {
  const w = new Where();
  const q = (req.query.q || '').trim();
  if (q) { const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'; w.add('(e.expense_no ILIKE ? OR e.description ILIKE ? OR e.payee ILIKE ? OR e.invoice_no ILIKE ?)', like, like, like, like); }
  if (U.validPeriod(req.query.period)) w.add('e.period = ?', req.query.period);
  if (req.query.category) w.add('e.category_code = ?', req.query.category);
  if (req.query.status) w.add('e.status = ?', req.query.status);
  const base = `SELECT e.*, c.name AS category_name, f.name AS fund_name FROM expenses e JOIN expense_categories c ON c.code=e.category_code JOIN funds f ON f.code=e.fund_code ${w.sql}`;
  const p = await paged(req, base, w.params, 'e.expense_date DESC, e.id DESC');
  const tot = await db.one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::text AS paid,
     COALESCE(SUM(amount) FILTER (WHERE status IN ('pending_approval','approved')),0)::text AS pending FROM expenses e ${w.sql}`, w.params);
  const cats = await db.many('SELECT * FROM expense_categories ORDER BY name');
  res.render('expenses/list', { title: 'المصروفات', p, tot, cats });
}));

router.get('/expenses/new', can('expenses.edit'), h(async (req, res) => {
  const cats = await db.many('SELECT * FROM expense_categories WHERE is_active ORDER BY name');
  res.render('expenses/form', { title: 'تسجيل مصروف', cats, e: { expense_date: U.todayISO(), period: U.currentPeriod(), fund_code: 'general' } });
}));

router.post('/expenses', can('expenses.edit'), upload, h(async (req, res) => {
  const row = await db.tx(async (c) => {
    const e = await parseExpense(c, req.body);
    const stored = req.file ? await storeDocument(c, req.file) : null;
    let docId = null;
    if (stored) {
      docId = (await c.one(`INSERT INTO documents (doc_type, original_name, stored_name, mime_type, size_bytes, sha256, status, uploaded_by)
        VALUES ('expense_receipt',$1,$2,$3,$4,$5,'approved',$6) RETURNING id`, [stored.original_name, stored.stored_name, stored.mime_type, stored.size_bytes, stored.sha256, req.user.id])).id;
    }
    const status = req.body.submit === '1' ? 'pending_approval' : 'draft';
    const r = await c.one(`INSERT INTO expenses (expense_date, category_code, fund_code, description, amount, payee, payment_method, invoice_no, period, notes, document_id, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [e.expense_date, e.category_code, e.fund_code, e.description, e.amount, e.payee, e.payment_method, e.invoice_no, e.period, e.notes, docId, status, req.user.id]);
    if (status === 'pending_approval') await step(c, r.id, 'submit', req.user);
    await audit.log(req, 'create', 'expense', r.id, { after: r }, c);
    return r;
  });
  flash(req, 'success', `تم تسجيل المصروف ${row.expense_no}` + (row.status === 'draft' ? ' كمسودة' : ' وإرساله للاعتماد'));
  res.redirect(`/expenses/${row.id}`);
}));

router.get('/expenses/:id(\\d+)', can('expenses.view'), h(async (req, res) => {
  const e = await db.one(`SELECT e.*, c.name AS category_name, f.name AS fund_name, u1.full_name AS created_name, u2.full_name AS approved_name, u3.full_name AS paid_name
    FROM expenses e JOIN expense_categories c ON c.code=e.category_code JOIN funds f ON f.code=e.fund_code
    LEFT JOIN users u1 ON u1.id=e.created_by LEFT JOIN users u2 ON u2.id=e.approved_by LEFT JOIN users u3 ON u3.id=e.paid_by WHERE e.id=$1`, [U.intId(req.params.id)]);
  if (!e) throw new U.UserError('المصروف غير موجود', 404);
  const steps = await db.many('SELECT a.*, u.full_name FROM expense_approvals a LEFT JOIN users u ON u.id=a.user_id WHERE expense_id=$1 ORDER BY at', [e.id]);
  const ledger = await db.many(`SELECT * FROM ledger_entries WHERE source_type IN ('expense','expense_reversal') AND source_id=$1 ORDER BY id`, [e.id]);
  const sep = (await settings.get('finance')).separation_of_duties;
  res.render('expenses/show', { title: `المصروف ${e.expense_no}`, e, steps, ledger, sep });
}));

router.post('/expenses/:id(\\d+)/action', can('expenses.edit', 'expenses.approve', 'expenses.pay'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const action = U.oneOf(req.body.action, ['submit', 'approve', 'reject', 'pay', 'reverse'], { label: 'الإجراء' });
  const fin = await settings.get('finance');
  const comment = U.str(req.body.comment, { max: 500 });
  const need = { submit: 'expenses.edit', approve: 'expenses.approve', reject: 'expenses.approve', pay: 'expenses.pay', reverse: 'expenses.pay' }[action];
  if (!req.perms.has(need)) throw new U.UserError('ليست لديك صلاحية لهذا الإجراء', 403);
  let msg;
  await db.tx(async (c) => {
    const e = await c.one('SELECT * FROM expenses WHERE id=$1 FOR UPDATE', [id]);
    if (!e) throw new U.UserError('المصروف غير موجود', 404);
    const req2 = (from, label) => { if (!from.includes(e.status)) throw new U.UserError(`لا يمكن ${label} مصروف حالته «${require('../lib/labels').label('expenseStatus', e.status)}»`); };
    if (action === 'submit') {
      req2(['draft', 'rejected'], 'إرسال');
      await c.query(`UPDATE expenses SET status='pending_approval', updated_at=now() WHERE id=$1`, [id]); msg = 'تم إرسال المصروف للاعتماد';
    } else if (action === 'approve' || action === 'reject') {
      req2(['pending_approval'], action === 'approve' ? 'اعتماد' : 'رفض');
      if (fin.separation_of_duties && e.created_by === req.user.id) throw new U.UserError('لا يمكنك اعتماد مصروف أنشأته بنفسك (فصل المهام)');
      if (action === 'reject' && !comment) throw new U.UserError('سبب الرفض مطلوب');
      await c.query(`UPDATE expenses SET status=$2, approved_by=$3, approved_at=now(), updated_at=now() WHERE id=$1`, [id, action === 'approve' ? 'approved' : 'rejected', req.user.id]);
      msg = action === 'approve' ? 'تم اعتماد المصروف (لم يُدفع بعد)' : 'تم رفض المصروف';
    } else if (action === 'pay') {
      req2(['approved'], 'دفع');
      const date = U.date(req.body.paid_date, { required: true, label: 'تاريخ الدفع' });
      await finance.ensureAvailable(c, e.fund_code, e.amount, null);
      await finance.post(c, { date, fund: e.fund_code, direction: 'out', amount: e.amount, source_type: 'expense', source_id: id, description: `مصروف ${e.expense_no} — ${e.description}`, user: req.user });
      await c.query(`UPDATE expenses SET status='paid', paid_by=$2, paid_at=now(), updated_at=now() WHERE id=$1`, [id, req.user.id]);
      msg = 'تم تسجيل دفع المصروف وخصمه من الصندوق';
    } else {
      req2(['paid'], 'عكس');
      if (!comment) throw new U.UserError('سبب العكس مطلوب');
      await finance.reverse(c, 'expense', id, 'expense_reversal', { date: U.todayISO(), reason: comment, user: req.user });
      await c.query(`UPDATE expenses SET status='reversed', reversal_reason=$2, updated_at=now() WHERE id=$1`, [id, comment]);
      msg = 'تم إلغاء المصروف بقيد عكسي موثق';
    }
    await step(c, id, action, req.user, comment);
    await audit.log(req, 'expense_' + action, 'expense', id, { before: { status: e.status }, reason: comment }, c);
  });
  flash(req, 'success', msg);
  res.redirect(`/expenses/${id}`);
}));

module.exports = router;
