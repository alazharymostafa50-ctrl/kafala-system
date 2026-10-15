'use strict';
/**
 * كشوف الاستحقاق الشهرية وعمليات الصرف.
 * - سجل استحقاق واحد لكل أسرة لكل شهر (قيد فريد في قاعدة البيانات).
 * - الصرف لا يتجاوز المتبقي (قيد CHECK + قفل الصف داخل معاملة).
 * - مفتاح منع التكرار لكل نموذج صرف يمنع التسجيل المزدوج.
 */
const U = require('./util');
const db = require('../db');
const finance = require('./finance');
const settings = require('./settings');
const audit = require('./audit');
const elig = require('./eligibility');

async function computeFamily(c, fam, payingStatuses) {
  const members = await c.many(
    `SELECT id, member_no, full_name, eligibility_status, monthly_amount::text AS monthly_amount
     FROM family_members WHERE family_id=$1 ORDER BY birth_date`, [fam.id]);
  const eligible = members.filter((m) => payingStatuses.includes(m.eligibility_status));
  let due = 0;
  const lines = [];
  const support = fam.support_type || 'kafala';
  const withKafala = support !== 'aid';
  if (withKafala && (fam.calc_method === 'family_fixed' || fam.calc_method === 'mixed')) {
    due += U.toCents(fam.monthly_amount);
    lines.push({ item: fam.calc_method === 'mixed' ? 'المبلغ الأساسي للأسرة' : 'مبلغ ثابت للأسرة', amount: U.fromCents(U.toCents(fam.monthly_amount)) });
  }
  if (withKafala && (fam.calc_method === 'per_member' || fam.calc_method === 'mixed')) {
    for (const m of eligible) {
      due += U.toCents(m.monthly_amount);
      lines.push({ item: `${m.full_name} (${m.member_no})`, member_id: m.id, amount: U.fromCents(U.toCents(m.monthly_amount)) });
    }
  }
  // الإعانة الشهرية للأسرة تُضاف منفصلة عن الكفالة
  const kafala = due;
  const aid = support === 'kafala' ? 0 : U.toCents(fam.aid_amount || '0');
  if (aid > 0) lines.push({ item: 'الإعانة الشهرية للأسرة', amount: U.fromCents(aid), kind: 'aid' });
  due += aid;
  return {
    due, kafala, aid, eligibleCount: eligible.length,
    detail: { method: fam.calc_method, support, lines, excluded: members.filter((m) => !payingStatuses.includes(m.eligibility_status)).map((m) => ({ id: m.id, name: m.full_name, status: m.eligibility_status })) },
  };
}

/**
 * إنشاء كشف الاستحقاق لشهر.
 * mode = 'new'  : ينشئ الكشف (يرفض إن كان موجودًا)
 * mode = 'add_missing' : إجراء إداري صريح لإضافة الأسر النشطة غير المدرجة فقط
 */
async function generate(c, period, user, { mode = 'new', req = null } = {}) {
  if (!U.validPeriod(period)) throw new U.UserError('الشهر غير صالح');
  const cfg = await settings.get('eligibility');
  const paying = cfg.paying_statuses || ['eligible', 'eligible_university'];
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['run:' + period]);
  let run = await c.one('SELECT * FROM monthly_runs WHERE period=$1', [period]);
  if (run && mode === 'new') throw new U.UserError(`كشف ${U.periodLabel(period)} موجود مسبقًا. لإضافة الأسر غير المدرجة استخدم «إضافة الأسر غير المدرجة».`);
  if (!run && mode !== 'new') throw new U.UserError('لا يوجد كشف لهذا الشهر بعد');
  if (run && run.status === 'closed') throw new U.UserError('كشف هذا الشهر مقفل');
  if (!run) run = await c.one('INSERT INTO monthly_runs (period, created_by) VALUES ($1,$2) RETURNING *', [period, user.id]);

  const fams = await c.many(
    `SELECT f.id, f.file_no, f.family_name, f.calc_method, f.monthly_amount::text AS monthly_amount, f.aid_amount::text AS aid_amount, f.support_type FROM families f
     WHERE f.status='active' AND f.opened_on <= $2
       AND NOT EXISTS (SELECT 1 FROM monthly_entitlements e WHERE e.family_id=f.id AND e.period=$1)
     ORDER BY f.id`, [period, U.periodEnd(period)]);
  const result = { created: 0, skippedZero: [], flagged: 0, total: 0 };
  const prev = U.prevPeriod(period);
  for (const f of fams) {
    const r = await computeFamily(c, f, paying);
    if (r.due <= 0) { result.skippedZero.push(f.file_no); continue; }
    let needsReview = false; let reason = null;
    if (f.support_type !== 'aid' && f.calc_method === 'mixed' && r.eligibleCount === 0) { needsReview = true; reason = 'لا يوجد مستفيد مستحق حاليًا ويُصرف المبلغ الأساسي فقط — يحتاج مراجعة'; }
    if (f.support_type !== 'aid' && f.calc_method === 'family_fixed') {
      const p = await c.one('SELECT eligible_count FROM monthly_entitlements WHERE family_id=$1 AND period=$2', [f.id, prev]);
      if (r.eligibleCount === 0) { needsReview = true; reason = 'لا يوجد مستفيد مستحق حاليًا والكفالة مبلغ ثابت — يحتاج مراجعة'; }
      else if (p && p.eligible_count !== r.eligibleCount) { needsReview = true; reason = `تغير عدد المستحقين من ${p.eligible_count} إلى ${r.eligibleCount} والمبلغ ثابت — يحتاج مراجعة`; }
    }
    const e = await c.one(
      `INSERT INTO monthly_entitlements (run_id, family_id, period, calc_method, eligible_count, amount_due, kafala_amount, aid_amount, calc_detail, needs_review, status_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [run.id, f.id, period, f.calc_method, r.eligibleCount, U.fromCents(r.due), U.fromCents(r.kafala), U.fromCents(r.aid), JSON.stringify(r.detail), needsReview, reason]);
    if (needsReview) {
      result.flagged++;
      await elig.notify(c, { key: `ent-review:${e.id}`, kind: 'entitlement_review', severity: 'warning', family_id: f.id,
        title: `مراجعة استحقاق ${f.file_no} لشهر ${U.periodLabel(period)}`, body: reason, link: `/entitlements/${period}?only=review` });
    }
    result.created++; result.total += r.due;
  }
  if (mode === 'new' || result.created > 0) await audit.log(req || { user }, mode === 'new' ? 'entitlements_generated' : 'entitlements_added_missing', 'monthly_run', period,
    { after: { created: result.created, total: U.fromCents(result.total), skipped_zero: result.skippedZero } }, c);
  return result;
}

async function refreshStatus(c, entId) {
  const e = await c.one('SELECT * FROM monthly_entitlements WHERE id=$1', [entId]);
  const pend = await c.one(`SELECT count(*)::int AS n FROM disbursements WHERE entitlement_id=$1 AND status='pending_approval'`, [entId]);
  const due = U.toCents(e.amount_due); const paid = U.toCents(e.amount_paid);
  let status = e.status;
  if (paid >= due && due > 0) status = 'paid';
  else if (pend.n > 0) status = 'pending_approval';
  else if (paid > 0) status = 'partial';
  else if (['paid', 'partial', 'pending_approval'].includes(e.status)) status = 'not_paid';
  if (status !== e.status) await c.query('UPDATE monthly_entitlements SET status=$2, updated_at=now() WHERE id=$1', [entId, status]);
  return status;
}

async function pendingCents(c, entId) {
  const r = await c.one(`SELECT COALESCE(SUM(amount),0)::text AS v FROM disbursements WHERE entitlement_id=$1 AND status='pending_approval'`, [entId]);
  return U.toCents(r.v);
}

/** تسجيل عملية صرف لأسرة */
async function disburse(c, entId, input, user, req = null) {
  const fin = await settings.get('finance');
  const e = await c.one('SELECT e.*, f.file_no, f.family_name FROM monthly_entitlements e JOIN families f ON f.id=e.family_id WHERE e.id=$1 FOR UPDATE OF e', [entId]);
  if (!e) throw new U.UserError('سجل الاستحقاق غير موجود', 404);
  if (['cancelled', 'postponed', 'failed'].includes(e.status)) throw new U.UserError(`لا يمكن الصرف لسجل حالته «${require('./labels').label('entStatus', e.status)}». غيّر الحالة أولًا بقرار موثق.`);
  const amount = U.amount(input.amount);
  const remaining = U.toCents(e.amount_due) - U.toCents(e.amount_paid) - (await pendingCents(c, entId));
  if (remaining <= 0) throw new U.UserError('تم صرف المستحق بالكامل لهذه الأسرة عن هذا الشهر (منع تكرار الصرف)');
  if (U.toCents(amount) > remaining) throw new U.UserError(`المبلغ أكبر من المتبقي (${U.fmtMoney(U.fromCents(remaining))})`);
  if (!fin.allow_partial_disbursement && U.toCents(amount) !== remaining) throw new U.UserError('الصرف الجزئي غير مسموح وفق الإعدادات؛ يجب صرف المتبقي كاملًا');
  const date = U.date(input.date, { required: true, label: 'تاريخ الصرف' });
  const method = U.oneOf(input.method, ['cash', 'bank_transfer', 'wallet', 'cheque', 'other'], { label: 'طريقة الصرف' });
  const fund = U.oneOf(input.fund, ['orphans', 'general'], { label: 'الصندوق' });
  if (fund === 'general' && !fin.allow_general_fund_for_kafala) throw new U.UserError('الصرف من الصندوق العام للكفالات غير مسموح وفق الإعدادات');
  const key = U.str(input.idempotency_key, { required: true, max: 80, label: 'مفتاح العملية' });
  const needsApproval = !!fin.disbursement_requires_approval;

  await finance.ensureAvailable(c, fund, amount, e.family_id);
  const d = await c.one(
    `INSERT INTO disbursements (entitlement_id, family_id, period, amount, fund_code, disb_date, method, reference, document_id, status, idempotency_key, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [entId, e.family_id, e.period, amount, fund, date, method, U.str(input.reference, { max: 120 }), input.document_id || null,
      needsApproval ? 'pending_approval' : 'paid', key, U.str(input.notes, { max: 1000 }), user.id]);
  if (!needsApproval) await applyDisbursement(c, d, user);
  await refreshStatus(c, entId);
  await audit.log(req || { user }, 'disbursement_created', 'disbursement', d.id, { after: { family: e.file_no, period: e.period, amount, fund, method, status: d.status } }, c);
  return d;
}

async function applyDisbursement(c, d, user) {
  const e = await c.one('SELECT e.*, f.file_no FROM monthly_entitlements e JOIN families f ON f.id=e.family_id WHERE e.id=$1', [d.entitlement_id]);
  await finance.post(c, { date: d.disb_date, fund: d.fund_code, direction: 'out', amount: d.amount, source_type: 'disbursement', source_id: d.id,
    family_id: d.family_id, description: `صرف كفالة ${e.file_no} عن ${U.periodLabel(d.period)} (${d.disb_no})`, user });
  await c.query('UPDATE monthly_entitlements SET amount_paid = amount_paid + $2, updated_at=now() WHERE id=$1', [d.entitlement_id, d.amount]);
}

async function approveDisbursement(c, id, user, approve, comment, req) {
  const fin = await settings.get('finance');
  const d = await c.one('SELECT * FROM disbursements WHERE id=$1 FOR UPDATE', [id]);
  if (!d) throw new U.UserError('العملية غير موجودة', 404);
  if (d.status !== 'pending_approval') throw new U.UserError('العملية ليست بانتظار الاعتماد');
  if (fin.separation_of_duties && d.created_by === user.id) throw new U.UserError('لا يمكنك اعتماد عملية سجلتها بنفسك (فصل المهام)');
  await c.one('SELECT id FROM monthly_entitlements WHERE id=$1 FOR UPDATE', [d.entitlement_id]);
  if (approve) {
    await finance.ensureAvailable(c, d.fund_code, d.amount, d.family_id);
    await c.query(`UPDATE disbursements SET status='paid', approved_by=$2, approved_at=now() WHERE id=$1`, [id, user.id]);
    await applyDisbursement(c, { ...d, status: 'paid' }, user);
  } else {
    if (!comment) throw new U.UserError('سبب الرفض مطلوب');
    await c.query(`UPDATE disbursements SET status='rejected', approved_by=$2, approved_at=now(), reversal_reason=$3 WHERE id=$1`, [id, user.id, comment]);
  }
  await refreshStatus(c, d.entitlement_id);
  await audit.log(req, approve ? 'disbursement_approved' : 'disbursement_rejected', 'disbursement', id, { reason: comment }, c);
}

async function reverseDisbursement(c, id, user, reason, req) {
  if (!reason) throw new U.UserError('سبب العكس مطلوب');
  const d = await c.one('SELECT * FROM disbursements WHERE id=$1 FOR UPDATE', [id]);
  if (!d) throw new U.UserError('العملية غير موجودة', 404);
  if (d.status !== 'paid') throw new U.UserError('لا يمكن عكس إلا العمليات المنفذة');
  await c.one('SELECT id FROM monthly_entitlements WHERE id=$1 FOR UPDATE', [d.entitlement_id]);
  await finance.reverse(c, 'disbursement', id, 'disbursement_reversal', { date: U.todayISO(), reason, user });
  await c.query(`UPDATE disbursements SET status='reversed', reversal_reason=$2, reversed_by=$3, reversed_at=now() WHERE id=$1`, [id, reason, user.id]);
  await c.query('UPDATE monthly_entitlements SET amount_paid = amount_paid - $2, updated_at=now() WHERE id=$1', [d.entitlement_id, d.amount]);
  await refreshStatus(c, d.entitlement_id);
  await audit.log(req, 'disbursement_reversed', 'disbursement', id, { reason }, c);
}

/** تغيير حالة سجل الاستحقاق يدويًا (مؤجل، متعذر، ملغى بقرار...) */
async function setStatus(c, entId, status, reason, user, req) {
  const allowed = ['not_paid', 'preparing', 'failed', 'postponed', 'cancelled'];
  if (!allowed.includes(status)) throw new U.UserError('حالة غير صالحة');
  if (!reason) throw new U.UserError('سبب تغيير الحالة مطلوب للتوثيق');
  const e = await c.one('SELECT * FROM monthly_entitlements WHERE id=$1 FOR UPDATE', [entId]);
  if (!e) throw new U.UserError('السجل غير موجود', 404);
  if (U.toCents(e.amount_paid) > 0 || (await pendingCents(c, entId)) > 0) throw new U.UserError('يوجد صرف مسجل لهذا السجل؛ لا يمكن تغيير حالته يدويًا. اعكس العمليات أولًا إن لزم.');
  await c.query('UPDATE monthly_entitlements SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1', [entId, status, reason]);
  await audit.log(req, 'entitlement_status', 'monthly_entitlement', entId, { before: { status: e.status }, after: { status }, reason }, c);
}

/** تعديل مبلغي الكفالة والإعانة بقرار موثق (لا يقل الإجمالي عن المصروف) */
async function amendAmount(c, entId, { kafala, aid }, reason, user, req) {
  if (!reason) throw new U.UserError('سبب التعديل مطلوب');
  const e = await c.one('SELECT * FROM monthly_entitlements WHERE id=$1 FOR UPDATE', [entId]);
  if (!e) throw new U.UserError('السجل غير موجود', 404);
  const run = await c.one('SELECT status FROM monthly_runs WHERE id=$1', [e.run_id]);
  if (run.status === 'closed') throw new U.UserError('كشف الشهر مقفل؛ أي تعديل رجعي يتم عبر تسوية مالية موثقة');
  const k = U.amount(kafala ?? e.kafala_amount, { allowZero: true, label: 'مبلغ الكفالة' });
  const a = U.amount(aid ?? e.aid_amount, { allowZero: true, label: 'مبلغ الإعانة' });
  const amt = U.fromCents(U.toCents(k) + U.toCents(a));
  if (U.toCents(amt) < U.toCents(e.amount_paid) + (await pendingCents(c, entId))) throw new U.UserError('لا يمكن أن يقل المستحق عن المبلغ المصروف');
  const detail = { ...e.calc_detail, amendments: [...(e.calc_detail.amendments || []), { from: e.amount_due, to: amt, kafala: k, aid: a, reason, by: user.username, at: new Date().toISOString() }] };
  await c.query('UPDATE monthly_entitlements SET amount_due=$2, kafala_amount=$3, aid_amount=$4, calc_detail=$5, needs_review=FALSE, updated_at=now() WHERE id=$1', [entId, amt, k, a, JSON.stringify(detail)]);
  await refreshStatus(c, entId);
  await audit.log(req, 'entitlement_amended', 'monthly_entitlement', entId, { before: { kafala: e.kafala_amount, aid: e.aid_amount }, after: { kafala: k, aid: a }, reason }, c);
}

const SYSTEM_USER = { id: null, username: 'system' };
const AUTO_CANCEL = 'أُلغي تلقائيًا: الأسرة محذوفة أو غير نشطة';

/**
 * الحساب التلقائي لكشف الشهر الحالي (عند فتح الصفحات وفي المهمة الدورية):
 * - ينشئ كشف الشهر لو مش موجود، ويضيف الأسر النشطة الجديدة.
 * - يعيد حساب مبالغ الأسر اللي لسه ماستلمتش (لو اتغيرت بيانات الأسرة) — إلا لو المبلغ اتعدل يدويًا.
 * - يلغي سجلات الأسر المحذوفة/غير النشطة اللي لسه ماستلمتش، ويرجّعها لو الأسرة رجعت.
 */
async function autoSync(period = U.todayISO().slice(0, 7)) {
  const fin = await settings.get('finance');
  if (fin.auto_generate === false) return null;
  if (process.env.NODE_ENV === 'test' && process.env.AUTO_SYNC_TEST !== '1') return null; // الاختبارات القديمة تتحكم في الكشف يدويًا
  if (period !== U.todayISO().slice(0, 7)) return null;
  return db.tx(async (c) => {
    const run = await c.one('SELECT * FROM monthly_runs WHERE period=$1', [period]);
    if (run && run.status === 'closed') return null;
    const cfg = await settings.get('eligibility');
    const paying = cfg.paying_statuses || ['eligible', 'eligible_university'];
    let updated = 0; let cancelled = 0; let restored = 0;
    if (run) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['run:' + period]);
      const ents = await c.many(
        `SELECT e.*, f.status AS fam_status, f.deleted_at, f.calc_method AS f_calc, f.monthly_amount::text AS monthly_amount, f.aid_amount::text AS f_aid, f.support_type, f.id AS fid
         FROM monthly_entitlements e JOIN families f ON f.id=e.family_id
         WHERE e.period=$1 AND e.amount_paid = 0
           AND NOT EXISTS (SELECT 1 FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='pending_approval')`, [period]);
      for (const e of ents) {
        const active = e.fam_status === 'active' && !e.deleted_at;
        if (!active) {
          if (e.status !== 'cancelled') {
            await c.query(`UPDATE monthly_entitlements SET status='cancelled', status_reason=$2, updated_at=now() WHERE id=$1`, [e.id, AUTO_CANCEL]);
            cancelled++;
          }
          continue;
        }
        if (e.status === 'cancelled' && e.status_reason !== AUTO_CANCEL) continue; // إلغاء يدوي يبقى كما هو
        if ((e.calc_detail.amendments || []).length) continue; // تعديل يدوي يبقى كما هو
        const r = await computeFamily(c, { id: e.fid, calc_method: e.f_calc, monthly_amount: e.monthly_amount, aid_amount: e.f_aid, support_type: e.support_type }, paying);
        const changed = U.toCents(e.amount_due) !== r.due || U.toCents(e.kafala_amount) !== r.kafala || U.toCents(e.aid_amount) !== r.aid || e.eligible_count !== r.eligibleCount;
        if (e.status === 'cancelled') {
          await c.query(`UPDATE monthly_entitlements SET status='not_paid', status_reason=NULL, amount_due=$2, kafala_amount=$3, aid_amount=$4, eligible_count=$5, calc_detail=$6, calc_method=$7, updated_at=now() WHERE id=$1`,
            [e.id, U.fromCents(r.due), U.fromCents(r.kafala), U.fromCents(r.aid), r.eligibleCount, JSON.stringify(r.detail), e.f_calc]);
          restored++;
        } else if (changed) {
          await c.query(`UPDATE monthly_entitlements SET amount_due=$2, kafala_amount=$3, aid_amount=$4, eligible_count=$5, calc_detail=$6, calc_method=$7, updated_at=now() WHERE id=$1`,
            [e.id, U.fromCents(r.due), U.fromCents(r.kafala), U.fromCents(r.aid), r.eligibleCount, JSON.stringify(r.detail), e.f_calc]);
          updated++;
        }
      }
    }
    const g = await generate(c, period, SYSTEM_USER, { mode: run ? 'add_missing' : 'new' });
    if (updated || cancelled || restored) {
      await audit.log({ user: SYSTEM_USER }, 'entitlements_auto_recalc', 'monthly_run', period, { after: { updated, cancelled, restored } }, c);
    }
    return { created: g.created, updated, cancelled, restored };
  });
}

module.exports = { generate, autoSync, disburse, approveDisbursement, reverseDisbursement, setStatus, amendAmount, refreshStatus, computeFamily };
