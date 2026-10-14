'use strict';
/**
 * قواعد العمر والاستحقاق والتنبيهات.
 * - الذكور: عند بلوغ سن المراجعة (افتراضيًا 18) يُطلب إثبات جامعي معتمد وساري.
 * - الإناث: لا يتأثر الاستحقاق بالعمر؛ الزواج يُسجل ويُعتمد بقرار موثق.
 * - كل تغيير في الحالة يُسجل كقرار تاريخي غير قابل للتعديل.
 */
const db = require('../db');
const U = require('./util');
const settings = require('./settings');
const audit = require('./audit');
const { label } = require('./labels');

const STATUSES = ['eligible', 'eligible_university', 'reached_review_age', 'awaiting_study_proof', 'missing_documents', 'suspended', 'ineligible', 'ended', 'under_review'];

/** هل لدى المستفيد إثبات جامعي معتمد وساري في تاريخ معين؟ */
async function validUniversityProof(c, memberId, onDate = U.todayISO()) {
  return c.one(
    `SELECT id, expiry_date FROM documents WHERE member_id=$1 AND doc_type='university_proof' AND status='approved'
       AND (expiry_date IS NULL OR expiry_date >= $2) ORDER BY expiry_date DESC NULLS FIRST LIMIT 1`, [memberId, onDate]);
}

/** تسجيل قرار استحقاق وتحديث حالة المستفيد */
async function decide(c, { memberId, newStatus, reason, user, kind = 'manual', documentId = null, effectiveFrom = U.todayISO(), req = null }) {
  if (!STATUSES.includes(newStatus)) throw new U.UserError('حالة الاستحقاق غير صالحة');
  if (!reason || !String(reason).trim()) throw new U.UserError('سبب القرار مطلوب');
  const m = await c.one('SELECT * FROM family_members WHERE id=$1 FOR UPDATE', [memberId]);
  if (!m) throw new U.UserError('المستفيد غير موجود', 404);
  if (m.eligibility_status === newStatus) return null;
  const age = U.ageOn(m.birth_date);
  const d = await c.one(
    `INSERT INTO eligibility_decisions (member_id, old_status, new_status, reason, kind, age_at_decision, document_id, decided_by, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [memberId, m.eligibility_status, newStatus, String(reason).trim(), kind, age, documentId, user?.id || null, effectiveFrom]);
  await c.query('UPDATE family_members SET eligibility_status=$2, updated_at=now() WHERE id=$1', [memberId, newStatus]);
  await audit.log(req || { user }, kind === 'automatic' ? 'eligibility_auto' : 'eligibility_decision', 'family_member', memberId,
    { before: { eligibility_status: m.eligibility_status }, after: { eligibility_status: newStatus }, reason }, c);
  // تنبيه مراجعة مبلغ الأسرة إن كانت الكفالة ثابتة
  const fam = await c.one('SELECT id, file_no, calc_method FROM families WHERE id=$1', [m.family_id]);
  if (fam.calc_method === 'family_fixed') {
    await notify(c, {
      key: `fixed-review:${fam.id}:${d.id}`, kind: 'family_amount_review', severity: 'info', family_id: fam.id, member_id: memberId,
      title: `مراجعة مبلغ كفالة الأسرة ${fam.file_no}`,
      body: `تغيرت حالة ${m.full_name} إلى «${label('eligibility', newStatus)}». الكفالة مبلغ ثابت للأسرة ولن يُعدَّل تلقائيًا؛ راجع المبلغ إن لزم.`,
      link: `/families/${fam.id}`,
    });
  }
  return d.id;
}

async function notify(c, n) {
  await c.query(
    `INSERT INTO notifications (dedupe_key, kind, severity, title, body, link, family_id, member_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body,
       resolved_at = CASE WHEN notifications.kind = ANY($9) THEN NULL ELSE notifications.resolved_at END`,
    [n.key, n.kind, n.severity || 'warning', n.title, n.body || null, n.link || null, n.family_id || null, n.member_id || null, ENGINE_KINDS]);
}

// أنواع التنبيهات التي يديرها المحرك تلقائيًا (تُغلق تلقائيًا عند زوال سببها)
const ENGINE_KINDS = ['male_age_soon', 'male_age_reached', 'proof_expiring', 'document_expired', 'document_expiring', 'missing_documents', 'no_sponsor', 'review_open'];

/**
 * محرك الاستحقاق: يطبق التحولات التلقائية المسموح بها وينشئ التنبيهات.
 * يُشغَّل عند بدء الخادم ودوريًا وعند الطلب.
 */
async function runEngine({ today = U.todayISO(), user = null } = {}) {
  const cfg = await settings.get('eligibility');
  const docCfg = await settings.get('documents');
  const reviewAge = Number(cfg.male_review_age || 18);
  const months = (cfg.alert_months_before || [3, 1]).map(Number).sort((a, b) => a - b); // الأقرب أولًا
  const proofDays = Number(cfg.proof_expiry_alert_days || 30);
  const docDays = Number(cfg.document_expiry_alert_days || 30);
  const stats = { transitions: 0, notifications: 0 };

  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['eligibility-engine']);
    const live = new Set();
    const add = async (n) => { live.add(n.key); await notify(c, n); stats.notifications++; };

    const members = await c.many(
      `SELECT m.*, f.file_no, f.status AS family_status FROM family_members m JOIN families f ON f.id=m.family_id
       WHERE f.status NOT IN ('closed','archived') AND m.eligibility_status NOT IN ('ended','ineligible')`);

    for (const m of members) {
      const age = U.ageOn(m.birth_date, today);
      const reviewDate = U.dateAtAge(m.birth_date, reviewAge);
      const link = `/families/${m.family_id}#m${m.id}`;

      if (m.gender === 'male') {
        // تنبيهات قبل بلوغ سن المراجعة
        if (age < reviewAge) {
          for (const mo of months) {
            if (reviewDate <= U.addMonths(today, mo)) {
              await add({ key: `male-soon:${m.id}:${reviewAge}`, kind: 'male_age_soon', severity: mo <= 1 ? 'warning' : 'info',
                member_id: m.id, family_id: m.family_id, link,
                title: `${m.full_name} يبلغ ${reviewAge} عامًا في ${reviewDate}`,
                body: `ملف ${m.file_no}. سيحتاج إلى إثبات قيد جامعي معتمد لاستمرار الاستحقاق.` });
              break;
            }
          }
        } else {
          const proof = await validUniversityProof(c, m.id, today);
          // لا تغيير تلقائي إذا كانت الحالة «قيد المراجعة» أو موقوفة بقرار إداري
          if (['eligible', 'reached_review_age'].includes(m.eligibility_status)) {
            if (proof) {
              await decide(c, { memberId: m.id, newStatus: 'eligible_university', kind: 'automatic', documentId: proof.id, user,
                reason: `بلغ ${reviewAge} عامًا ولديه إثبات جامعي معتمد ساري` });
            } else {
              await decide(c, { memberId: m.id, newStatus: 'awaiting_study_proof', kind: 'automatic', user,
                reason: `بلغ ${reviewAge} عامًا (${reviewDate}) ولا يوجد إثبات جامعي معتمد ساري` });
            }
            stats.transitions++;
          } else if (m.eligibility_status === 'eligible_university' && !proof) {
            await decide(c, { memberId: m.id, newStatus: 'awaiting_study_proof', kind: 'automatic', user,
              reason: 'انتهى سريان الإثبات الجامعي أو لم يعد معتمدًا؛ مطلوب إثبات محدث' });
            stats.transitions++;
          }
          const cur = (await c.one('SELECT eligibility_status FROM family_members WHERE id=$1', [m.id])).eligibility_status;
          if (['awaiting_study_proof', 'reached_review_age'].includes(cur)) {
            await add({ key: `male-reached:${m.id}`, kind: 'male_age_reached', severity: 'danger', member_id: m.id, family_id: m.family_id, link,
              title: `${m.full_name} بلغ سن المراجعة ويحتاج إلى قرار`, body: `ملف ${m.file_no}. الحالة: ${label('eligibility', cur)}.` });
          }
          if (cur === 'eligible_university' && proof && proof.expiry_date && proof.expiry_date <= U.addDays(today, proofDays)) {
            await add({ key: `proof-exp:${proof.id}`, kind: 'proof_expiring', severity: 'warning', member_id: m.id, family_id: m.family_id, link,
              title: `إثبات الدراسة لـ ${m.full_name} ينتهي في ${proof.expiry_date}`, body: `ملف ${m.file_no}. اطلب إثباتًا محدثًا.` });
          }
        }
      }
    }

    // المستندات المنتهية أو القريبة من الانتهاء
    const docs = await c.many(
      `SELECT d.id, d.doc_type, d.expiry_date, d.family_id, d.member_id, f.file_no, COALESCE(m.full_name, g.full_name, f.family_name) AS owner
       FROM documents d JOIN families f ON f.id=d.family_id LEFT JOIN family_members m ON m.id=d.member_id LEFT JOIN guardians g ON g.family_id=f.id
       WHERE d.status='approved' AND d.expiry_date IS NOT NULL AND d.expiry_date <= $1 AND f.status NOT IN ('closed','archived')
         AND d.doc_type <> 'university_proof'`, [U.addDays(today, docDays)]);
    for (const d of docs) {
      const expired = d.expiry_date < today;
      await add({ key: `doc-${expired ? 'expired' : 'expiring'}:${d.id}`, kind: expired ? 'document_expired' : 'document_expiring',
        severity: expired ? 'danger' : 'warning', family_id: d.family_id, member_id: d.member_id, link: `/families/${d.family_id}/documents`,
        title: `${label('docType', d.doc_type)} — ${d.owner} ${expired ? 'منتهي' : 'ينتهي قريبًا'} (${d.expiry_date})`, body: `ملف ${d.file_no}` });
    }

    // المستندات الناقصة
    // تنبيه واحد لكل أسرة يلخص مستنداتها الناقصة
    const missing = await missingDocuments(c, docCfg);
    const byFam = new Map();
    for (const x of missing) { if (!byFam.has(x.family_id)) byFam.set(x.family_id, []); byFam.get(x.family_id).push(x); }
    for (const [fid, list] of byFam) {
      await add({ key: `missing:${fid}`, kind: 'missing_documents', severity: 'warning', family_id: fid, link: `/families/${fid}/documents`,
        title: `مستندات ناقصة (${list.length}) — ملف ${list[0].file_no}`,
        body: list.map((x) => `${label('docType', x.doc_type)}: ${x.owner}`).join('، ') });
    }

    // الأسر النشطة بلا كفيل نشط
    const noSp = await c.many(
      `SELECT f.id, f.file_no, f.family_name FROM families f WHERE f.status='active'
       AND NOT EXISTS (SELECT 1 FROM family_sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id
                       WHERE s.family_id=f.id AND s.status='active' AND sp.status <> 'stopped')`);
    for (const f of noSp) {
      await add({ key: `no-sponsor:${f.id}`, kind: 'no_sponsor', severity: 'info', family_id: f.id, link: `/families/${f.id}`,
        title: `الأسرة ${f.file_no} تحتاج إلى كفيل`, body: `${f.family_name} — لا يوجد كفيل نشط مرتبط بها. الاستحقاق لا يتوقف تلقائيًا.` });
    }

    // طلبات المراجعة المفتوحة (زواج وغيره)
    const reviews = await c.many(
      `SELECT r.*, m.full_name, m.family_id, f.file_no FROM eligibility_reviews r JOIN family_members m ON m.id=r.member_id
       JOIN families f ON f.id=m.family_id WHERE r.status='open'`);
    for (const r of reviews) {
      await add({ key: `review:${r.id}`, kind: 'review_open', severity: 'warning', member_id: r.member_id, family_id: r.family_id,
        link: '/eligibility?tab=reviews', title: `${label('reviewType', r.review_type)} بانتظار قرار: ${r.full_name}`, body: `ملف ${r.file_no}` });
    }

    // إغلاق التنبيهات التي زال سببها
    const open = await c.many(`SELECT id, dedupe_key FROM notifications WHERE resolved_at IS NULL AND kind = ANY($1)`, [ENGINE_KINDS]);
    for (const n of open) if (!live.has(n.dedupe_key)) await c.query('UPDATE notifications SET resolved_at=now() WHERE id=$1', [n.id]);
    return stats;
  });
}

/** حساب المستندات الإلزامية الناقصة */
async function missingDocuments(c, docCfg, familyId = null) {
  const famReq = docCfg.required_family || [];
  const memReq = docCfg.required_member || [];
  const out = [];
  const fams = await c.many(
    `SELECT f.id, f.file_no, f.family_name FROM families f WHERE f.status IN ('active','under_review') ${familyId ? 'AND f.id=$1' : ''}`, familyId ? [familyId] : []);
  if (!fams.length) return out;
  const ids = fams.map((f) => f.id);
  const docs = await c.many(`SELECT family_id, member_id, doc_type FROM documents WHERE family_id = ANY($1) AND status IN ('approved','pending')`, [ids]);
  const has = new Set(docs.map((d) => `${d.family_id}:${d.member_id || 0}:${d.doc_type}`));
  const hasFam = new Set(docs.map((d) => `${d.family_id}:${d.doc_type}`));
  const members = await c.many(`SELECT id, family_id, full_name FROM family_members WHERE family_id = ANY($1) AND eligibility_status NOT IN ('ended','ineligible')`, [ids]);
  for (const f of fams) {
    for (const t of famReq) if (!hasFam.has(`${f.id}:${t}`)) out.push({ family_id: f.id, member_id: null, doc_type: t, owner: f.family_name, file_no: f.file_no });
    for (const m of members.filter((mm) => mm.family_id === f.id)) {
      for (const t of memReq) if (!has.has(`${f.id}:${m.id}:${t}`)) out.push({ family_id: f.id, member_id: m.id, doc_type: t, owner: m.full_name, file_no: f.file_no });
    }
  }
  return out;
}

module.exports = { decide, runEngine, missingDocuments, validUniversityProof, notify, STATUSES, ENGINE_KINDS };
