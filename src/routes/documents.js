'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const elig = require('../lib/eligibility');
const settings = require('../lib/settings');
const { memoryUpload, storeDocument, getFile } = require('../lib/uploads');
const { h, can, flash } = require('../middleware');

const DOC_TYPES = ['guardian_id', 'member_id', 'birth_certificate', 'orphan_proof', 'guardianship', 'university_proof', 'marriage_proof',
  'bank_document', 'other_social', 'other_financial'];
const SENSITIVE_TYPES = ['guardian_id', 'member_id', 'bank_document'];

const uploadMw = h(async (req, res, next) => {
  const cfg = await settings.get('documents');
  memoryUpload(Number(cfg.max_size_mb || 8)).single('file')(req, res, next);
});

router.get('/families/:id/documents', can('documents.view', 'documents.upload'), h(async (req, res) => {
  const fid = U.intId(req.params.id);
  const f = await db.one('SELECT id, file_no, family_name FROM families WHERE id=$1', [fid]);
  if (!f) throw new U.UserError('الملف غير موجود', 404);
  const members = await db.many('SELECT id, full_name, member_no FROM family_members WHERE family_id=$1 ORDER BY birth_date', [fid]);
  const docs = await db.many(
    `SELECT d.*, m.full_name AS member_name, u.full_name AS uploader, r.full_name AS reviewer FROM documents d
     LEFT JOIN family_members m ON m.id=d.member_id LEFT JOIN users u ON u.id=d.uploaded_by LEFT JOIN users r ON r.id=d.reviewed_by
     WHERE d.family_id=$1 ORDER BY d.status='replaced', d.uploaded_at DESC`, [fid]);
  const missing = await elig.missingDocuments(db, await settings.get('documents'), fid);
  res.render('families/documents', { title: `مستندات ${f.file_no}`, f, members, docs, missing, DOC_TYPES, today: U.todayISO(), SENSITIVE_TYPES });
}));

router.post('/families/:id/documents', can('documents.upload'), uploadMw, h(async (req, res) => {
  const fid = U.intId(req.params.id);
  const b = req.body;
  const type = U.oneOf(b.doc_type, DOC_TYPES, { label: 'نوع المستند' });
  const memberId = b.member_id ? U.intId(b.member_id) : null;
  const issue = U.date(b.issue_date, { label: 'تاريخ الإصدار' });
  const expiry = U.date(b.expiry_date, { label: 'تاريخ الانتهاء' });
  if (issue && expiry && expiry < issue) throw new U.UserError('تاريخ الانتهاء قبل تاريخ الإصدار');
  if (type === 'university_proof' && !expiry) throw new U.UserError('إثبات القيد الجامعي يتطلب تاريخ انتهاء');
  if (['member_id', 'birth_certificate', 'university_proof', 'marriage_proof'].includes(type) && !memberId) throw new U.UserError('حدد المستفيد المرتبط بهذا المستند');
  const replaces = b.replaces_id ? U.intId(b.replaces_id) : null;
  await db.tx(async (c) => {
    const stored = await storeDocument(c, req.file);
    if (memberId) {
      const m = await c.one('SELECT id FROM family_members WHERE id=$1 AND family_id=$2', [memberId, fid]);
      if (!m) throw new U.UserError('المستفيد لا ينتمي لهذه الأسرة');
    }
    const row = await c.one(
      `INSERT INTO documents (family_id, member_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, issue_date, expiry_date, replaces_id, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [fid, memberId, type, stored.original_name, stored.stored_name, stored.mime_type, stored.size_bytes, stored.sha256, issue, expiry, replaces,
        U.str(b.notes, { max: 500 }), req.user.id]);
    if (replaces) {
      const old = await c.one('SELECT id FROM documents WHERE id=$1 AND family_id=$2', [replaces, fid]);
      if (!old) throw new U.UserError('المستند المستبدل غير موجود');
      await c.query(`UPDATE documents SET status='replaced' WHERE id=$1`, [replaces]);
    }
    await audit.log(req, 'upload', 'document', row.id, { after: { family_id: fid, member_id: memberId, doc_type: type, size: stored.size_bytes, sha256: stored.sha256, replaces } }, c);
  });
  flash(req, 'success', 'تم رفع المستند وهو الآن بانتظار المراجعة والاعتماد');
  res.redirect(`/families/${fid}/documents`);
}));

router.post('/documents/:id/review', can('documents.approve'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const action = U.oneOf(req.body.action, ['approve', 'reject'], { label: 'الإجراء' });
  let fid;
  await db.tx(async (c) => {
    const d = await c.one('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id]);
    if (!d) throw new U.UserError('المستند غير موجود', 404);
    if (d.status === 'replaced') throw new U.UserError('هذا المستند مستبدل بنسخة أحدث');
    fid = d.family_id;
    const status = action === 'approve' ? 'approved' : 'rejected';
    await c.query('UPDATE documents SET status=$2, reviewed_by=$3, reviewed_at=now(), notes=COALESCE($4, notes) WHERE id=$1', [id, status, req.user.id, U.str(req.body.notes, { max: 500 })]);
    await audit.log(req, 'document_' + action, 'document', id, { before: { status: d.status }, after: { status } }, c);
    // اعتماد إثبات جامعي ساري لمستفيد ذكر بانتظار الإثبات → قرار استحقاق موثق
    if (action === 'approve' && d.doc_type === 'university_proof' && d.member_id && (!d.expiry_date || d.expiry_date >= U.todayISO())) {
      const m = await c.one('SELECT eligibility_status FROM family_members WHERE id=$1', [d.member_id]);
      if (['awaiting_study_proof', 'reached_review_age', 'eligible'].includes(m.eligibility_status) && req.perms.has('eligibility.decide')) {
        await elig.decide(c, { memberId: d.member_id, newStatus: 'eligible_university', documentId: id, user: req.user, req,
          reason: `اعتماد إثبات قيد جامعي ساري حتى ${d.expiry_date || 'غير محدد'}` });
      }
    }
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', action === 'approve' ? 'تم اعتماد المستند' : 'تم رفض المستند');
  res.redirect(`/families/${fid}/documents`);
}));

// عرض/تنزيل الملف بعد التحقق من الصلاحية في الخادم
router.get('/documents/:id/file', can('documents.view', 'expenses.view', 'entitlements.view'), h(async (req, res) => {
  const d = await db.one('SELECT * FROM documents WHERE id=$1', [U.intId(req.params.id)]);
  if (!d) throw new U.UserError('المستند غير موجود', 404);
  const need = d.doc_type === 'expense_receipt' ? ['expenses.view'] : d.doc_type === 'disbursement_receipt' ? ['entitlements.view', 'documents.view'] : ['documents.view'];
  if (!need.some((p) => req.perms.has(p))) throw new U.UserError('ليست لديك صلاحية لعرض هذا المستند', 403);
  if (SENSITIVE_TYPES.includes(d.doc_type) && !req.perms.has('families.sensitive')) throw new U.UserError('هذا المستند حساس ويتطلب صلاحية البيانات الحساسة', 403);
  const f = await getFile(d.stored_name);
  if (!f) throw new U.UserError('ملف المستند غير موجود في التخزين', 404);
  await audit.log(req, req.query.download ? 'document_download' : 'document_view', 'document', d.id);
  res.set('Content-Type', d.mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.original_name)}`);
  res.send(f.data);
}));

module.exports = router;
