'use strict';
// مصدر موحد للأرقام المستخدمة في لوحة التحكم والتقارير لضمان تطابقها
const db = require('../db');
const U = require('./util');
const finance = require('./finance');
const settings = require('./settings');

async function donationBreakdown(c, period) {
  // يُحتسب كل تبرع مرة واحدة فقط من قيد الدفتر الخاص به؛ مساهمات الكفلاء جزء من الإجمالي وليست إضافة عليه
  const rows = await c.many(
    `SELECT l.source_type, l.direction, d.type_code, dt.is_sponsor_contribution AS sp, dt.is_family_designated AS fam, f.restricted, SUM(l.amount)::text AS v
     FROM ledger_entries l JOIN donations d ON d.id=l.source_id JOIN donation_types dt ON dt.code=d.type_code JOIN funds f ON f.code=l.fund_code
     WHERE l.source_type IN ('donation','donation_reversal') AND l.period=$1
     GROUP BY 1,2,3,4,5,6`, [period]);
  const r = { total: 0, sponsor: 0, general: 0, restricted: 0, familyDesignated: 0, reversals: 0 };
  for (const x of rows) {
    const v = U.toCents(x.v) * (x.source_type === 'donation' ? 1 : -1);
    if (x.source_type === 'donation_reversal') r.reversals += U.toCents(x.v);
    r.total += v;
    if (x.sp) r.sponsor += v;
    else if (x.restricted) { r.restricted += v; if (x.fam) r.familyDesignated += v; }
    else r.general += v;
  }
  return r;
}

async function entitlementTotals(c, period) {
  const r = await c.one(
    `SELECT count(*)::int AS families,
       COALESCE(SUM(amount_due),0)::text AS due, COALESCE(SUM(amount_paid),0)::text AS paid,
       COALESCE(SUM(kafala_amount),0)::text AS kafala, COALESCE(SUM(aid_amount),0)::text AS aid,
       count(*) FILTER (WHERE status='paid')::int AS full_n,
       count(*) FILTER (WHERE status='partial')::int AS partial_n,
       count(*) FILTER (WHERE amount_paid=0)::int AS none_n,
       COALESCE(SUM(amount_due-amount_paid) FILTER (WHERE status='partial'),0)::text AS partial_remaining
     FROM monthly_entitlements WHERE period=$1 AND status <> 'cancelled'`, [period]);
  const due = U.toCents(r.due); const paid = U.toCents(r.paid);
  return { families: r.families, due, paid, remaining: due - paid, kafala: U.toCents(r.kafala), aid: U.toCents(r.aid), full: r.full_n, partial: r.partial_n, none: r.none_n,
    partialRemaining: U.toCents(r.partial_remaining), pct: due ? Math.round((paid / due) * 1000) / 10 : 0 };
}

/** الالتزامات غير المدفوعة حتى نهاية الشهر (كل الأشهر حتى الشهر المحدد) */
async function unpaidObligations(c, period) {
  const r = await c.one(
    `SELECT COALESCE(SUM(amount_due-amount_paid),0)::text AS v FROM monthly_entitlements
     WHERE period <= $1 AND status NOT IN ('cancelled')`, [period]);
  return U.toCents(r.v);
}

async function expensesPaid(c, period) {
  const r = await c.one(
    `SELECT COALESCE(SUM(CASE WHEN source_type='expense' THEN amount ELSE -amount END),0)::text AS v
     FROM ledger_entries WHERE source_type IN ('expense','expense_reversal') AND period=$1`, [period]);
  return U.toCents(r.v);
}

async function admin(c) {
  const eCfg = await settings.get('eligibility');
  const paying = eCfg.paying_statuses || ['eligible', 'eligible_university'];
  const f = await c.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active,
       count(*) FILTER (WHERE status='suspended')::int AS suspended, count(*) FILTER (WHERE status='under_review')::int AS review
     FROM families WHERE status <> 'archived'`);
  const m = await c.one(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE m.is_orphan AND m.eligibility_status = ANY($1))::int AS eligible_orphans,
       count(*) FILTER (WHERE m.eligibility_status IN ('reached_review_age','awaiting_study_proof','missing_documents','under_review'))::int AS needs_review
     FROM family_members m JOIN families f ON f.id=m.family_id WHERE f.status NOT IN ('archived','closed')`, [paying]);
  const s = await c.one(`SELECT count(*) FILTER (WHERE status='active')::int AS active FROM sponsors`);
  const ns = await c.one(
    `SELECT count(*)::int AS n FROM families f WHERE f.status='active' AND NOT EXISTS
     (SELECT 1 FROM family_sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.family_id=f.id AND s.status='active' AND sp.status <> 'stopped')`);
  const missing = await require('./eligibility').missingDocuments(c, await settings.get('documents'));
  const expired = await c.one(`SELECT count(*)::int AS n FROM documents d JOIN families f ON f.id=d.family_id WHERE d.status='approved' AND d.expiry_date < $1
     AND f.status NOT IN ('closed','archived') AND NOT EXISTS (SELECT 1 FROM documents d2 WHERE d2.replaces_id=d.id)`, [U.todayISO()]);
  return { families: f, members: m, activeSponsors: s.active, noSponsor: ns.n, docIssues: missing.length + expired.n, missingDocs: missing.length, expiredDocs: expired.n };
}

async function dashboard(period) {
  const c = db;
  const [adm, don, ent, exp, unpaid, sum] = await Promise.all([
    admin(c), donationBreakdown(c, period), entitlementTotals(c, period), expensesPaid(c, period), unpaidObligations(c, period), finance.periodSummary(c, period),
  ]);
  const available = await finance.fundBalanceCents(c, 'general') + await finance.fundBalanceCents(c, 'orphans');
  const run = await c.one('SELECT status FROM monthly_runs WHERE period=$1', [period]);
  const pendingDocs = await c.one(`SELECT count(*)::int AS n FROM documents WHERE status='pending'`);
  const pendingExp = await c.one(`SELECT count(*)::int AS n FROM expenses WHERE status IN ('pending_approval','approved')`);
  const reviews = await c.one(`SELECT count(*)::int AS n FROM eligibility_reviews WHERE status='open'`);
  return { adm, don, ent, exp, unpaid, sum, available, run, pendingDocs: pendingDocs.n, pendingExp: pendingExp.n, reviews: reviews.n };
}

async function chartSeries(endPeriod, n = 12) {
  const periods = [];
  let p = endPeriod;
  for (let i = 0; i < n; i++) { periods.unshift(p); p = U.prevPeriod(p); }
  const led = await db.many(
    `SELECT period, source_type, SUM(amount)::text AS v FROM ledger_entries WHERE period = ANY($1)
     AND source_type IN ('donation','donation_reversal','expense','expense_reversal','disbursement','disbursement_reversal') GROUP BY 1,2`, [periods]);
  const ents = await db.many(`SELECT period, SUM(amount_due)::text AS v FROM monthly_entitlements WHERE period = ANY($1) AND status<>'cancelled' GROUP BY 1`, [periods]);
  const get = (per, t) => U.toCents(led.find((x) => x.period === per && x.source_type === t)?.v || 0) / 100;
  return {
    labels: periods.map(U.periodLabel),
    donations: periods.map((x) => get(x, 'donation') - get(x, 'donation_reversal')),
    expenses: periods.map((x) => get(x, 'expense') - get(x, 'expense_reversal')),
    disbursed: periods.map((x) => get(x, 'disbursement') - get(x, 'disbursement_reversal')),
    due: periods.map((x) => U.toCents(ents.find((e) => e.period === x)?.v || 0) / 100),
  };
}

module.exports = { donationBreakdown, entitlementTotals, unpaidObligations, expensesPaid, admin, dashboard, chartSeries };
