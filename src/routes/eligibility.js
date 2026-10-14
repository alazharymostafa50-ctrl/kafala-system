'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const elig = require('../lib/eligibility');
const settings = require('../lib/settings');
const { h, can, flash } = require('../middleware');

/** بيانات شاشة/تقرير مراجعة الاستحقاق — مصدر واحد لكليهما */
async function reviewData(today = U.todayISO()) {
  const cfg = await settings.get('eligibility');
  const age = Number(cfg.male_review_age || 18);
  const proofDays = Number(cfg.proof_expiry_alert_days || 30);
  const males = await db.many(
    `SELECT m.*, f.file_no, f.family_name FROM family_members m JOIN families f ON f.id=m.family_id
     WHERE m.gender='male' AND f.status NOT IN ('closed','archived') AND m.eligibility_status NOT IN ('ended','ineligible') ORDER BY m.birth_date`);
  const soon3 = []; const soon1 = []; const reached = [];
  for (const m of males) {
    m.age = U.ageOn(m.birth_date, today); m.review_date = U.dateAtAge(m.birth_date, age);
    if (m.age >= age) { if (!['eligible_university'].includes(m.eligibility_status)) reached.push(m); }
    else if (m.review_date <= U.addMonths(today, 1)) soon1.push(m);
    else if (m.review_date <= U.addMonths(today, 3)) soon3.push(m);
  }
  const proofs = await db.many(
    `SELECT d.id, d.expiry_date, m.id AS member_id, m.full_name, m.eligibility_status, f.id AS family_id, f.file_no FROM documents d
     JOIN family_members m ON m.id=d.member_id JOIN families f ON f.id=d.family_id
     WHERE d.doc_type='university_proof' AND d.status='approved' AND d.expiry_date <= $1 AND f.status NOT IN ('closed','archived')
       AND NOT EXISTS (SELECT 1 FROM documents d2 WHERE d2.member_id=d.member_id AND d2.doc_type='university_proof' AND d2.status='approved' AND d2.expiry_date > d.expiry_date)
     ORDER BY d.expiry_date`, [U.addDays(today, proofDays)]);
  const missing = await elig.missingDocuments(db, await settings.get('documents'));
  const expiredDocs = await db.many(
    `SELECT d.id, d.doc_type, d.expiry_date, f.id AS family_id, f.file_no, COALESCE(m.full_name, f.family_name) AS owner FROM documents d
     JOIN families f ON f.id=d.family_id LEFT JOIN family_members m ON m.id=d.member_id
     WHERE d.status='approved' AND d.expiry_date < $1 AND f.status NOT IN ('closed','archived')
       AND NOT EXISTS (SELECT 1 FROM documents d2 WHERE d2.replaces_id=d.id) ORDER BY d.expiry_date`, [today]);
  const reviews = await db.many(
    `SELECT r.*, m.full_name, m.gender, m.eligibility_status, m.family_id, f.file_no, u.full_name AS requester FROM eligibility_reviews r
     JOIN family_members m ON m.id=r.member_id JOIN families f ON f.id=m.family_id LEFT JOIN users u ON u.id=r.requested_by
     WHERE r.status='open' ORDER BY r.requested_at`);
  const pendingDecision = await db.many(
    `SELECT m.*, f.file_no FROM family_members m JOIN families f ON f.id=m.family_id
     WHERE m.eligibility_status IN ('under_review','missing_documents','reached_review_age') AND f.status NOT IN ('closed','archived') ORDER BY m.updated_at`);
  const noSponsor = await db.many(
    `SELECT f.id, f.file_no, f.family_name FROM families f WHERE f.status='active' AND NOT EXISTS
     (SELECT 1 FROM family_sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.family_id=f.id AND s.status='active' AND sp.status <> 'stopped') ORDER BY f.id`);
  return { age, soon3, soon1, reached, proofs, missing, expiredDocs, reviews, pendingDecision, noSponsor, today };
}

router.get('/eligibility', can('eligibility.view'), h(async (req, res) => {
  const d = await reviewData();
  const cfg = await settings.get('eligibility');
  const tab = req.query.tab || 'age';
  res.render('eligibility/index', { title: 'مراجعة الاستحقاقات', d, tab, statuses: elig.STATUSES, femaleStatus: cfg.female_marriage_new_status || 'ended' });
}));

router.post('/eligibility/run', can('eligibility.view'), h(async (req, res) => {
  const s = await elig.runEngine({ user: req.user });
  flash(req, 'success', `تم تحديث الاستحقاقات والتنبيهات: ${s.transitions} تغيير تلقائي موثق، ${s.notifications} تنبيه نشط.`);
  res.redirect('/eligibility');
}));

router.post('/eligibility/reviews/:id/dismiss', can('eligibility.decide'), h(async (req, res) => {
  const reason = U.str(req.body.reason, { required: true, label: 'سبب الإغلاق' });
  await db.tx(async (c) => {
    const r = await c.one(`UPDATE eligibility_reviews SET status='dismissed', resolved_by=$2, resolved_at=now(), details = details || ' — أُغلق: ' || $3 WHERE id=$1 AND status='open' RETURNING member_id`, [U.intId(req.params.id), req.user.id, reason]);
    if (!r) throw new U.UserError('الطلب غير موجود أو مغلق');
    await require('../lib/audit').log(req, 'review_dismissed', 'eligibility_review', req.params.id, { reason }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم إغلاق طلب المراجعة دون تغيير الاستحقاق');
  res.redirect('/eligibility?tab=reviews');
}));

module.exports = router;
module.exports.reviewData = reviewData;
