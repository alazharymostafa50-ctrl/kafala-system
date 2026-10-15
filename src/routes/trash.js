'use strict';
// الحذف القابل للاسترجاع (سلة المحذوفات): الأسر، الأفراد، الكفلاء.
// السجلات المالية لا تُحذف أبدًا؛ تُلغى أو تُعكس بقيد موثق حفاظًا على صحة الحسابات.
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const { h, can, flash } = require('../middleware');

const back = (req, def) => { const r = req.get('referer') || ''; return /^https?:\/\/[^/]+\//.test(r) ? new URL(r).pathname + new URL(r).search : def; };

// ---------- الأسر ----------
router.post('/families/:id(\\d+)/delete', can('families.archive'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const f = await db.tx(async (c) => {
    const f = await c.one('SELECT * FROM families WHERE id=$1 FOR UPDATE', [id]);
    if (!f) throw new U.UserError('الملف غير موجود', 404);
    if (f.deleted_at) throw new U.UserError('الأسرة محذوفة بالفعل');
    await c.query(`UPDATE families SET deleted_at=now(), deleted_by=$2, status_before_delete=status, status='archived', updated_at=now() WHERE id=$1`, [id, req.user.id]);
    await audit.log(req, 'delete', 'family', id, { before: { status: f.status } }, c);
    return f;
  });
  try { await require('../lib/entitlements').autoSync(); } catch (e) { /* لا يوقف الحذف */ }
  flash(req, 'success', `تم حذف «${f.family_name}» ونقلها لسلة المحذوفات. تقدر ترجعها في أي وقت.`);
  res.redirect('/families');
}));

router.post('/families/:id(\\d+)/restore', can('families.archive'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const f = await db.tx(async (c) => {
    const f = await c.one('SELECT * FROM families WHERE id=$1 FOR UPDATE', [id]);
    if (!f || !f.deleted_at) throw new U.UserError('الأسرة مش موجودة في سلة المحذوفات', 404);
    await c.query(`UPDATE families SET deleted_at=NULL, deleted_by=NULL, status=COALESCE(status_before_delete, 'active'), status_before_delete=NULL, updated_at=now() WHERE id=$1`, [id]);
    await audit.log(req, 'restore', 'family', id, { after: { status: f.status_before_delete } }, c);
    return f;
  });
  try { await require('../lib/entitlements').autoSync(); } catch (e) { /* */ }
  flash(req, 'success', `تم استرجاع «${f.family_name}».`);
  res.redirect(`/families/${id}`);
}));

// ---------- أفراد الأسرة ----------
router.post('/members/:mid(\\d+)/delete', can('families.archive'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const m = await db.tx(async (c) => {
    const m = await c.one('SELECT * FROM family_members_all WHERE id=$1 FOR UPDATE', [mid]);
    if (!m || m.deleted_at) throw new U.UserError('الفرد غير موجود', 404);
    await c.query('UPDATE family_members_all SET deleted_at=now(), deleted_by=$2, updated_at=now() WHERE id=$1', [mid, req.user.id]);
    await audit.log(req, 'delete', 'family_member', mid, { before: { full_name: m.full_name, family_id: m.family_id } }, c);
    return m;
  });
  try { await require('../lib/entitlements').autoSync(); } catch (e) { /* */ }
  flash(req, 'success', `تم حذف «${m.full_name}» ونقله لسلة المحذوفات.`);
  res.redirect(`/families/${m.family_id}`);
}));

router.post('/members/:mid(\\d+)/restore', can('families.archive'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const m = await db.tx(async (c) => {
    const m = await c.one('SELECT * FROM family_members_all WHERE id=$1 FOR UPDATE', [mid]);
    if (!m || !m.deleted_at) throw new U.UserError('الفرد مش موجود في سلة المحذوفات', 404);
    await c.query('UPDATE family_members_all SET deleted_at=NULL, deleted_by=NULL, updated_at=now() WHERE id=$1', [mid]);
    await audit.log(req, 'restore', 'family_member', mid, {}, c);
    return m;
  });
  try { await require('../lib/entitlements').autoSync(); } catch (e) { /* */ }
  flash(req, 'success', `تم استرجاع «${m.full_name}».`);
  res.redirect(back(req, `/families/${m.family_id}`));
}));

// ---------- الكفلاء ----------
router.post('/sponsors/:id(\\d+)/delete', can('sponsors.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const s = await db.tx(async (c) => {
    const s = await c.one('SELECT * FROM sponsors WHERE id=$1 FOR UPDATE', [id]);
    if (!s || s.deleted_at) throw new U.UserError('الكفيل غير موجود', 404);
    await c.query(`UPDATE sponsors SET deleted_at=now(), deleted_by=$2, status_before_delete=status, status='stopped', updated_at=now() WHERE id=$1`, [id, req.user.id]);
    await audit.log(req, 'delete', 'sponsor', id, { before: { status: s.status } }, c);
    return s;
  });
  flash(req, 'success', `تم حذف الكفيل «${s.full_name}» ونقله لسلة المحذوفات.`);
  res.redirect('/sponsors');
}));

router.post('/sponsors/:id(\\d+)/restore', can('sponsors.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const s = await db.tx(async (c) => {
    const s = await c.one('SELECT * FROM sponsors WHERE id=$1 FOR UPDATE', [id]);
    if (!s || !s.deleted_at) throw new U.UserError('الكفيل مش موجود في سلة المحذوفات', 404);
    await c.query(`UPDATE sponsors SET deleted_at=NULL, deleted_by=NULL, status=COALESCE(status_before_delete, 'active'), status_before_delete=NULL, updated_at=now() WHERE id=$1`, [id]);
    await audit.log(req, 'restore', 'sponsor', id, {}, c);
    return s;
  });
  flash(req, 'success', `تم استرجاع الكفيل «${s.full_name}».`);
  res.redirect(`/sponsors/${id}`);
}));

// ---------- صفحة سلة المحذوفات ----------
router.get('/trash', h(async (req, res) => {
  if (!req.perms.has('families.archive') && !req.perms.has('sponsors.edit')) throw new U.UserError('ليست لديك صلاحية', 403);
  const families = req.perms.has('families.archive') ? await db.many(
    `SELECT f.id, f.file_no, f.family_name, f.deleted_at, g.full_name AS guardian, u.full_name AS by_name
     FROM families f LEFT JOIN guardians g ON g.family_id=f.id LEFT JOIN users u ON u.id=f.deleted_by WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`) : [];
  const members = req.perms.has('families.archive') ? await db.many(
    `SELECT m.id, m.full_name, m.deleted_at, f.file_no, f.family_name, f.deleted_at AS fam_deleted, u.full_name AS by_name
     FROM family_members_all m JOIN families f ON f.id=m.family_id LEFT JOIN users u ON u.id=m.deleted_by WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC`) : [];
  const sponsors = req.perms.has('sponsors.edit') ? await db.many(
    `SELECT s.id, s.sponsor_no, s.full_name, s.deleted_at, u.full_name AS by_name FROM sponsors s LEFT JOIN users u ON u.id=s.deleted_by
     WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`) : [];
  res.render('trash', { title: 'سلة المحذوفات', families, members, sponsors });
}));

module.exports = router;
