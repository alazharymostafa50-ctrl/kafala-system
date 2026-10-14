'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const donations = require('../lib/donations');
const { paged, Where } = require('../lib/paging');
const { h, can, flash } = require('../middleware');

router.get('/donations', can('donations.view'), h(async (req, res) => {
  const w = new Where();
  const q = (req.query.q || '').trim();
  if (q) { const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'; w.add('(d.receipt_no ILIKE ? OR d.donor_name ILIKE ? OR d.reference ILIKE ?)', like, like, like); }
  if (U.validPeriod(req.query.period)) w.add('d.period = ?', req.query.period);
  if (req.query.type) w.add('d.type_code = ?', req.query.type);
  if (req.query.status) w.add('d.status = ?', req.query.status);
  const base = `SELECT d.*, t.name AS type_name, f.name AS fund_name, fa.file_no, sp.sponsor_no FROM donations d JOIN donation_types t ON t.code=d.type_code
    JOIN funds f ON f.code=d.fund_code LEFT JOIN families fa ON fa.id=d.family_id LEFT JOIN sponsors sp ON sp.id=d.sponsor_id ${w.sql}`;
  const p = await paged(req, base, w.params, 'd.donation_date DESC, d.id DESC');
  const tot = await db.one(`SELECT COALESCE(SUM(d.amount) FILTER (WHERE d.status NOT IN ('cancelled','reversed')),0)::text AS registered,
      COALESCE(SUM(d.amount) FILTER (WHERE d.status='collected'),0)::text AS collected,
      COALESCE(SUM(d.amount) FILTER (WHERE d.status='collected' AND f.restricted),0)::text AS restricted,
      COALESCE(SUM(d.amount) FILTER (WHERE d.status IN ('pending','needs_settlement')),0)::text AS uncollected
    FROM donations d JOIN funds f ON f.code=d.fund_code ${w.sql}`, w.params);
  const types = await db.many('SELECT * FROM donation_types ORDER BY is_system DESC, name');
  res.render('donations/list', { title: 'التبرعات', p, tot, types });
}));

router.get('/donations/new', can('donations.edit'), h(async (req, res) => {
  const types = await db.many('SELECT t.*, f.name AS fund_name FROM donation_types t JOIN funds f ON f.code=t.fund_code WHERE t.is_active ORDER BY t.is_system DESC, t.name');
  const families = await db.many(`SELECT id, file_no, family_name FROM families WHERE status IN ('active','under_review') ORDER BY file_no`);
  const sponsors = await db.many(`SELECT id, sponsor_no, full_name FROM sponsors WHERE status <> 'stopped' ORDER BY sponsor_no`);
  res.render('donations/form', { title: 'تسجيل تبرع', types, families, sponsors });
}));

router.post('/donations', can('donations.edit'), h(async (req, res) => {
  const collectNow = req.body.collect_now === '1' && req.perms.has('donations.collect');
  const row = await db.tx((c) => donations.create(c, req.body, req.user, req, { collectNow }));
  flash(req, 'success', `تم تسجيل التبرع بإيصال ${row.receipt_no}` + (collectNow ? ' وتأكيد تحصيله' : ' بانتظار التحصيل'));
  res.redirect(`/donations/${row.id}`);
}));

router.get('/donations/:id(\\d+)', can('donations.view'), h(async (req, res) => {
  const d = await db.one(`SELECT d.*, t.name AS type_name, f.name AS fund_name, fa.file_no, fa.family_name, sp.sponsor_no, sp.full_name AS sponsor_name,
      u1.full_name AS created_name, u2.full_name AS collected_name, u3.full_name AS reversed_name
    FROM donations d JOIN donation_types t ON t.code=d.type_code JOIN funds f ON f.code=d.fund_code LEFT JOIN families fa ON fa.id=d.family_id
    LEFT JOIN sponsors sp ON sp.id=d.sponsor_id LEFT JOIN users u1 ON u1.id=d.created_by LEFT JOIN users u2 ON u2.id=d.collected_by LEFT JOIN users u3 ON u3.id=d.reversed_by
    WHERE d.id=$1`, [U.intId(req.params.id)]);
  if (!d) throw new U.UserError('التبرع غير موجود', 404);
  const ledger = await db.many(`SELECT * FROM ledger_entries WHERE source_type IN ('donation','donation_reversal') AND source_id=$1 ORDER BY id`, [d.id]);
  res.render('donations/show', { title: `التبرع ${d.receipt_no}`, d, ledger });
}));

router.post('/donations/:id(\\d+)/collect', can('donations.collect'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  await db.tx((c) => donations.collect(c, id, { date: req.body.date }, req.user, req));
  flash(req, 'success', 'تم تأكيد التحصيل وتسجيل القيد المالي');
  res.redirect(`/donations/${id}`);
}));

router.post('/donations/:id(\\d+)/settlement', can('donations.collect'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const note = U.str(req.body.note, { required: true, label: 'الملاحظة' });
  const r = await db.query(`UPDATE donations SET status='needs_settlement', notes=COALESCE(notes,'') || ' | تسوية: ' || $2, updated_at=now() WHERE id=$1 AND status='pending'`, [id, note]);
  if (!r.rowCount) throw new U.UserError('يمكن تحويل التبرعات غير المحصلة فقط إلى «يحتاج تسوية»');
  await require('../lib/audit').log(req, 'needs_settlement', 'donation', id, { reason: note });
  flash(req, 'success', 'تم تعليم التبرع بأنه يحتاج إلى تسوية');
  res.redirect(`/donations/${id}`);
}));

router.post('/donations/:id(\\d+)/reverse', can('donations.collect'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  await db.tx((c) => donations.reverse(c, id, U.str(req.body.reason, { required: true, label: 'السبب' }), req.user, req));
  flash(req, 'success', 'تم إلغاء التبرع بعملية عكس موثقة (القيد الأصلي محفوظ)');
  res.redirect(`/donations/${id}`);
}));

module.exports = router;
