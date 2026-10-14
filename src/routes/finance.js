'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const finance = require('../lib/finance');
const stats = require('../lib/stats');
const { paged, Where } = require('../lib/paging');
const { h, can, flash } = require('../middleware');

router.get('/finance', can('finance.view'), h(async (req, res) => {
  const period = U.validPeriod(req.query.period) ? req.query.period : U.currentPeriod();
  const sum = await finance.periodSummary(db, period);
  const unpaid = await stats.unpaidObligations(db, period);
  const reserves = await finance.designatedReserves(db);
  const resRows = reserves.size ? await db.many('SELECT id, file_no, family_name FROM families WHERE id = ANY($1)', [[...reserves.keys()]]) : [];
  resRows.forEach((r) => { r.cents = reserves.get(r.id); });
  const avail = { orphans: await finance.availableCents(db, 'orphans'), general: await finance.availableCents(db, 'general') };
  const w = new Where();
  w.add('l.period = ?', period);
  if (req.query.fund) w.add('l.fund_code = ?', req.query.fund);
  if (req.query.source) w.add('l.source_type = ?', req.query.source);
  const p = await paged(req, `SELECT l.*, u.full_name AS by_name, f.file_no FROM ledger_entries l LEFT JOIN users u ON u.id=l.created_by LEFT JOIN families f ON f.id=l.family_id ${w.sql}`, w.params, 'l.id DESC', 50);
  const adjustments = await db.many(`SELECT a.*, u.full_name AS by_name FROM financial_adjustments a LEFT JOIN users u ON u.id=a.created_by WHERE a.period=$1 ORDER BY a.id DESC`, [period]);
  const periodState = await db.one('SELECT * FROM financial_periods WHERE period=$1', [period]);
  res.render('finance/index', { title: 'الأرصدة والتسويات', period, sum, unpaid, resRows, avail, p, adjustments, periodState });
}));

router.post('/finance/adjustments', can('finance.adjust'), h(async (req, res) => {
  const b = req.body;
  const kind = U.oneOf(b.kind, ['opening', 'correction', 'bank_fee', 'other'], { label: 'نوع التسوية' });
  const fund = U.oneOf(b.fund_code, ['general', 'orphans'], { label: 'الصندوق' });
  const direction = U.oneOf(b.direction, ['in', 'out'], { label: 'الاتجاه' });
  const amount = U.amount(b.amount);
  const date = U.date(b.adj_date, { required: true, label: 'التاريخ' });
  const reason = U.str(b.reason, { required: true, max: 1000, label: 'سبب التسوية' });
  await db.tx(async (c) => {
    if (kind === 'opening') {
      const ex = await c.one(`SELECT 1 FROM financial_adjustments WHERE kind='opening' AND fund_code=$1`, [fund]);
      if (ex) throw new U.UserError('سُجل رصيد افتتاحي لهذا الصندوق مسبقًا؛ استخدم تسوية تصحيحية');
      if (direction !== 'in') throw new U.UserError('الرصيد الافتتاحي يكون واردًا');
    }
    if (direction === 'out') await finance.ensureAvailable(c, fund, amount, null);
    const lid = await finance.post(c, { date, fund, direction, amount, source_type: kind === 'opening' ? 'opening' : 'adjustment', description: `${kind === 'opening' ? 'رصيد افتتاحي' : 'تسوية'}: ${reason}`, user: req.user });
    const a = await c.one(`INSERT INTO financial_adjustments (adj_date, period, fund_code, direction, amount, kind, reason, ledger_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [date, date.slice(0, 7), fund, direction, amount, kind, reason, lid, req.user.id]);
    await audit.log(req, 'adjustment', 'financial_adjustment', a.id, { after: { kind, fund, direction, amount, date }, reason }, c);
  });
  flash(req, 'success', 'تم تسجيل التسوية الموثقة في السجل المالي');
  res.redirect(`/finance?period=${date.slice(0, 7)}`);
}));

router.post('/finance/periods/:period(\\d{4}-\\d{2})/:action(close|reopen)', h(async (req, res) => {
  const { period, action } = req.params;
  if (action === 'close' && !req.perms.has('finance.adjust')) throw new U.UserError('غير مصرح', 403);
  if (action === 'reopen' && !req.perms.has('settings.manage')) throw new U.UserError('إعادة فتح فترة مالية تتطلب صلاحية مدير النظام', 403);
  const reason = U.str(req.body.reason, { required: action === 'reopen', label: 'السبب' });
  await db.tx(async (c) => {
    await c.query(`INSERT INTO financial_periods (period, status, closed_by, closed_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (period) DO UPDATE SET status=EXCLUDED.status, closed_by=EXCLUDED.closed_by, closed_at=now()`, [period, action === 'close' ? 'closed' : 'open', req.user.id]);
    await audit.log(req, 'period_' + action, 'financial_period', period, { reason }, c);
  });
  flash(req, 'success', action === 'close' ? 'تم إقفال الفترة المالية؛ لن تُقبل عمليات بتاريخ داخلها' : 'تمت إعادة فتح الفترة المالية');
  res.redirect(`/finance?period=${period}`);
}));

module.exports = router;
