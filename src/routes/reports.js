'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const reports = require('../lib/reports');
const exporters = require('../lib/exporters');
const meta = require('../lib/reports-meta');
const { h, can, flash } = require('../middleware');
const { putFile, getFile, sha256 } = require('../lib/uploads');

/** مقارنة ثابتة الترتيب (jsonb يعيد ترتيب المفاتيح) */
const stable = (v) => (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v));


function params(req, src = req.query) {
  const type = meta.types[src.type] ? src.type : 'financial';
  const period = U.validPeriod(src.period) ? src.period : U.currentPeriod();
  const level = src.level === 'summary' ? 'summary' : 'detailed';
  if (!req.perms.has(meta.types[type].perm)) throw new U.UserError('ليست لديك صلاحية لعرض هذا النوع من التقارير', 403);
  return { type, period, level };
}

async function versions(period, type) {
  return db.many(`SELECT r.*, u1.full_name AS prepared_name, u2.full_name AS approved_name FROM monthly_reports r
    LEFT JOIN users u1 ON u1.id=r.prepared_by LEFT JOIN users u2 ON u2.id=r.approved_by WHERE r.period=$1 AND r.report_type=$2 ORDER BY r.version DESC`, [period, type]);
}

router.get('/reports', can('reports.view'), h(async (req, res) => {
  const p = params(req);
  const generated = req.query.go === '1';
  const report = generated ? await reports.build(p.type, p.period, p.level) : null;
  const vers = await versions(p.period, p.type);
  const recent = await db.many(`SELECT r.id, r.period, r.report_type, r.version, r.status, r.approved_at, u.full_name AS approved_name FROM monthly_reports r LEFT JOIN users u ON u.id=r.approved_by
    WHERE r.status IN ('approved','pending') ORDER BY r.prepared_at DESC LIMIT 12`);
  const sep = (await settings.get('finance')).separation_of_duties;
  res.render('reports/index', { title: 'التقارير الشهرية', ...p, report, vers, recent: recent.filter((r) => req.perms.has(meta.types[r.report_type]?.perm)), types: meta.types, cell: reports.cell, sep });
}));

router.get('/reports/print', can('reports.export'), h(async (req, res) => {
  const p = params(req);
  const report = await reports.build(p.type, p.period, p.level);
  await audit.log(req, 'report_print', 'report', `${p.type}:${p.period}`);
  res.send(await exporters.renderHtml(report, { user: req.user }));
}));

router.get('/reports/export.:fmt(pdf|xlsx|csv)', can('reports.export'), h(async (req, res) => {
  const p = params(req);
  const report = await reports.build(p.type, p.period, p.level);
  const name = `${p.type}-${p.period}-${p.level}`;
  await audit.log(req, 'report_export_' + req.params.fmt, 'report', `${p.type}:${p.period}`);
  if (req.params.fmt === 'pdf') {
    const buf = await exporters.toPdf(report, { user: req.user });
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${name}.pdf"`).send(Buffer.from(buf));
  } else if (req.params.fmt === 'xlsx') {
    const buf = await exporters.toXlsx(report);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', `attachment; filename="${name}.xlsx"`).send(Buffer.from(buf));
  } else {
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}.csv"`).send(exporters.toCsv(report));
  }
}));

/** إعداد نسخة للاعتماد: لقطة ثابتة من الأرقام + ملف PDF */
router.post('/reports/prepare', can('reports.export'), h(async (req, res) => {
  const p = params(req, req.body);
  const notes = U.str(req.body.accountant_notes, { max: 2000 });
  const report = await reports.build(p.type, p.period, p.level);
  const id = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['report:' + p.period + p.type]);
    const pend = await c.one(`SELECT id FROM monthly_reports WHERE period=$1 AND report_type=$2 AND status='pending'`, [p.period, p.type]);
    if (pend) throw new U.UserError('توجد نسخة بانتظار الاعتماد لهذا التقرير؛ اعتمدها أو ارفضها أولًا');
    const v = (await c.one('SELECT COALESCE(max(version),0)+1 AS v FROM monthly_reports WHERE period=$1 AND report_type=$2', [p.period, p.type])).v;
    const approval = { status: 'pending', version: v, prepared_name: req.user.full_name, prepared_at: new Date(), accountant_notes: notes };
    const pdf = Buffer.from(await exporters.toPdf(report, { user: req.user, approval }));
    const file = `reports/${p.period}-${p.type}-v${v}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    await putFile(c, file, pdf, 'application/pdf');
    const r = await c.one(`INSERT INTO monthly_reports (period, report_type, version, report_level, status, summary, source_refs, pdf_file, pdf_sha256, accountant_notes, prepared_by)
      VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10) RETURNING id`,
      [p.period, p.type, v, p.level, JSON.stringify(report.summary), JSON.stringify(report.sourceRefs), file, sha256(pdf), notes, req.user.id]);
    await audit.log(req, 'report_prepared', 'monthly_report', r.id, { after: { period: p.period, type: p.type, version: v } }, c);
    return r.id;
  });
  flash(req, 'success', 'تم حفظ نسخة التقرير وإرسالها للاعتماد');
  res.redirect(`/reports?period=${p.period}&type=${p.type}&level=${p.level}#versions`);
  return id;
}));

router.post('/reports/:id(\\d+)/:action(approve|reject)', can('reports.approve'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const fin = await settings.get('finance');
  const r = await db.one('SELECT * FROM monthly_reports WHERE id=$1', [id]);
  if (!r || r.status !== 'pending') throw new U.UserError('لا توجد نسخة بانتظار الاعتماد');
  if (!req.perms.has(meta.types[r.report_type].perm)) throw new U.UserError('غير مصرح', 403);
  if (req.params.action === 'reject') {
    const reason = U.str(req.body.reason, { required: true, label: 'سبب الرفض' });
    await db.query(`UPDATE monthly_reports SET status='rejected', reject_reason=$2, approved_by=$3, approved_at=now() WHERE id=$1`, [id, reason, req.user.id]);
    await audit.log(req, 'report_rejected', 'monthly_report', id, { reason });
    flash(req, 'success', 'تم رفض النسخة');
  } else {
    if (fin.separation_of_duties && r.prepared_by === req.user.id) throw new U.UserError('لا يمكنك اعتماد تقرير أعددته بنفسك (فصل المهام)');
    // التحقق من أن الأرقام لم تتغير منذ الإعداد
    const now = await reports.build(r.report_type, r.period, r.report_level);
    if (stable(now.summary) !== stable(r.summary)) {
      throw new U.UserError('تغيرت البيانات منذ إعداد هذه النسخة؛ ارفضها وأعد إعداد التقرير ليعكس الأرقام الحالية');
    }
    const reason = U.str(req.body.reason, { max: 500 });
    await db.tx(async (c) => {
      const prev = await c.one(`SELECT id FROM monthly_reports WHERE period=$1 AND report_type=$2 AND status='approved' FOR UPDATE`, [r.period, r.report_type]);
      if (prev) {
        if (!reason) throw new U.UserError('توجد نسخة معتمدة سابقة؛ اذكر سبب إصدار نسخة جديدة');
        await c.query(`UPDATE monthly_reports SET status='superseded', supersede_reason=$2 WHERE id=$1`, [prev.id, reason]);
      }
      // توليد PDF النهائي بختم «معتمد» واسم المعتمد كملف جديد؛ نسخة الإعداد تبقى محفوظة
      const prep = await c.one('SELECT full_name FROM users WHERE id=$1', [r.prepared_by]);
      const approval = { status: 'approved', version: r.version, prepared_name: prep?.full_name, prepared_at: r.prepared_at, approved_name: req.user.full_name, approved_at: new Date(), accountant_notes: r.accountant_notes };
      const pdf = Buffer.from(await exporters.toPdf(now, { approval }));
      const file = `reports/${r.period}-${r.report_type}-v${r.version}-approved-${crypto.randomBytes(4).toString('hex')}.pdf`;
      await putFile(c, file, pdf, 'application/pdf');
      await c.query(`UPDATE monthly_reports SET status='approved', approved_by=$2, approved_at=now(), approved_pdf_file=$3, approved_pdf_sha256=$4 WHERE id=$1`,
        [id, req.user.id, file, sha256(pdf)]);
      await audit.log(req, 'report_approved', 'monthly_report', id, { after: { version: r.version }, reason }, c);
    });
    flash(req, 'success', `تم اعتماد الإصدار ${r.version} وحفظه. أي تغيير لاحق يتطلب إصدارًا جديدًا ولا يعدّل هذه النسخة.`);
  }
  res.redirect(`/reports?period=${r.period}&type=${r.report_type}#versions`);
}));

router.get('/reports/saved/:id(\\d+)/pdf', can('reports.view'), h(async (req, res) => {
  const r = await db.one(`SELECT * FROM monthly_reports WHERE id=$1`, [U.intId(req.params.id)]);
  if (!r) throw new U.UserError('غير موجود', 404);
  if (!req.perms.has(meta.types[r.report_type].perm)) throw new U.UserError('غير مصرح', 403);
  const useApproved = r.approved_pdf_file && req.query.draft !== '1';
  const f = await getFile(useApproved ? r.approved_pdf_file : r.pdf_file);
  if (!f) throw new U.UserError('ملف PDF غير موجود في التخزين', 404);
  const buf = f.data;
  const ok = sha256(buf) === (useApproved ? r.approved_pdf_sha256 : r.pdf_sha256);
  if (!ok) throw new U.UserError('فشل التحقق من سلامة ملف التقرير المحفوظ (تغيّر الملف). تواصل مع مدير النظام.', 409);
  await audit.log(req, 'report_saved_download', 'monthly_report', r.id);
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="${r.period}-${r.report_type}-v${r.version}.pdf"`).send(buf);
}));

module.exports = router;
