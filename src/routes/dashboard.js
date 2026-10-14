'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const stats = require('../lib/stats');
const { h, can, flash } = require('../middleware');

router.get('/', h(async (req, res) => {
  if (!req.perms.has('dashboard.view')) return res.render('home-basic', { title: 'الرئيسية' });
  const period = U.validPeriod(req.query.period) ? req.query.period : U.currentPeriod();
  const d = await stats.dashboard(period);
  const chart = await stats.chartSeries(period);
  const showFin = req.perms.has('finance.view') || req.perms.has('donations.view');
  res.render('dashboard', { title: 'لوحة التحكم', period, d, chart, showFin });
}));

router.get('/notifications', h(async (req, res) => {
  const showResolved = req.query.resolved === '1';
  const rows = await db.many(
    `SELECT n.*, u.full_name AS resolver FROM notifications n LEFT JOIN users u ON u.id=n.resolved_by
     WHERE ${showResolved ? 'n.resolved_at IS NOT NULL' : 'n.resolved_at IS NULL'}
     ORDER BY CASE n.severity WHEN 'danger' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n.created_at DESC LIMIT 500`);
  // إخفاء تنبيهات الأسر عمن لا يملك صلاحية عرض الأسر
  const visible = req.perms.has('families.view') ? rows : rows.filter((r) => !r.family_id);
  res.render('notifications', { title: 'التنبيهات', rows: visible, showResolved });
}));

router.post('/notifications/:id/resolve', can('families.edit', 'eligibility.decide', 'finance.view'), h(async (req, res) => {
  await db.query('UPDATE notifications SET resolved_at=now(), resolved_by=$2 WHERE id=$1 AND resolved_at IS NULL', [U.intId(req.params.id), req.user.id]);
  flash(req, 'success', 'تم وضع علامة «تمت المعالجة» على التنبيه');
  res.redirect('/notifications');
}));

module.exports = router;
