'use strict';
/**
 * المحرك المالي: دفتر أستاذ موحد بقيود "وارد/صادر" لكل صندوق.
 * - لا تُحذف القيود ولا تُعدَّل (محمي بمشغلات في قاعدة البيانات).
 * - الأخطاء تُصحح بقيد عكسي أو تسوية موثقة.
 * - الأموال المقيدة (صندوق كفالة الأيتام) لا تُصرف إلا على أغراضها.
 * - التبرعات المخصصة لأسرة معينة تبقى محجوزة لها داخل الصندوق المقيد.
 */
const U = require('./util');

async function assertPeriodOpen(c, period) {
  const p = await c.one('SELECT status FROM financial_periods WHERE period=$1', [period]);
  if (p && p.status === 'closed') throw new U.UserError(`الفترة المالية ${U.periodLabel(period)} مقفلة؛ لا يمكن تسجيل عمليات عليها. استخدم تسوية في فترة مفتوحة.`);
}

/** قفل تسلسلي لكل صندوق لمنع السحب المتزامن الذي يتجاوز الرصيد */
async function lockFund(c, fund) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fund:' + fund]);
}

async function post(c, e) {
  if (!U.validDate(e.date)) throw new U.UserError('تاريخ القيد غير صالح');
  const period = e.date.slice(0, 7);
  await assertPeriodOpen(c, period);
  const r = await c.one(
    `INSERT INTO ledger_entries (entry_date, period, fund_code, direction, amount, source_type, source_id, family_id, description, reverses_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [e.date, period, e.fund, e.direction, e.amount, e.source_type, e.source_id ?? null, e.family_id ?? null, e.description, e.reverses_id ?? null, e.user?.id ?? null]);
  return r.id;
}

/** عكس قيد سابق بقيد مضاد مرتبط به */
async function reverse(c, sourceType, sourceId, reversalType, { date, reason, user }) {
  const orig = await c.one('SELECT * FROM ledger_entries WHERE source_type=$1 AND source_id=$2', [sourceType, sourceId]);
  if (!orig) return null;
  return post(c, {
    date, fund: orig.fund_code, direction: orig.direction === 'in' ? 'out' : 'in', amount: orig.amount,
    source_type: reversalType, source_id: sourceId, family_id: orig.family_id,
    description: `عكس: ${orig.description} — السبب: ${reason}`, reverses_id: orig.id, user,
  });
}

async function fundBalanceCents(c, fund, { before } = {}) {
  const r = await c.one(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS b
     FROM ledger_entries WHERE fund_code=$1 ${before ? 'AND entry_date < $2' : ''}`, before ? [fund, before] : [fund]);
  return U.toCents(r.b);
}

/** المبالغ المحجوزة لكل أسرة من التبرعات المخصصة لها (غير المصروفة بعد) */
async function designatedReserves(c) {
  const rows = await c.many(
    `SELECT family_id,
       GREATEST(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS remaining
     FROM ledger_entries WHERE fund_code IN (SELECT code FROM funds WHERE restricted) AND family_id IS NOT NULL
     GROUP BY family_id`);
  // التبرعات المخصصة تدخل بقيد "وارد" بعلامة family_id، والصرف للأسرة يخرج بنفس العلامة
  const map = new Map();
  for (const r of rows) map.set(r.family_id, U.toCents(r.remaining));
  return map;
}

/**
 * الرصيد المتاح للصرف من صندوق لغرض/أسرة معينة.
 * للصندوق المقيد: الرصيد ناقص ما هو محجوز لأسر أخرى.
 */
async function availableCents(c, fund, familyId = null) {
  const bal = await fundBalanceCents(c, fund);
  const f = await c.one('SELECT restricted FROM funds WHERE code=$1', [fund]);
  if (!f) throw new U.UserError('الصندوق غير معروف');
  if (!f.restricted) return bal;
  const res = await designatedReserves(c);
  let reservedOthers = 0;
  for (const [fid, cents] of res) if (fid !== familyId) reservedOthers += cents;
  return bal - reservedOthers;
}

async function ensureAvailable(c, fund, amount, familyId = null) {
  await lockFund(c, fund);
  const avail = await availableCents(c, fund, familyId);
  const need = U.toCents(amount);
  if (need > avail) {
    const f = await c.one('SELECT name FROM funds WHERE code=$1', [fund]);
    throw new U.UserError(`الرصيد المتاح في «${f.name}» (${U.fmtMoney(U.fromCents(avail))}) لا يكفي لهذه العملية (${U.fmtMoney(amount)}).`);
  }
}

/** ملخص مالي لفترة: الرصيد الافتتاحي والحركات والرصيد الختامي لكل صندوق */
async function periodSummary(c, period) {
  const start = U.periodStart(period); const end = U.periodEnd(period);
  const funds = await c.many('SELECT * FROM funds ORDER BY restricted, code');
  const opening = await c.many(
    `SELECT fund_code, COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS v
     FROM ledger_entries WHERE entry_date < $1 GROUP BY fund_code`, [start]);
  const moves = await c.many(
    `SELECT fund_code, source_type, direction, SUM(amount)::text AS v, count(*)::int AS n
     FROM ledger_entries WHERE entry_date BETWEEN $1 AND $2 GROUP BY fund_code, source_type, direction`, [start, end]);
  const out = { period, funds: [], totals: {} };
  const tot = { opening: 0, in: 0, out: 0, closing: 0 };
  const bySrc = {};
  for (const f of funds) {
    const o = U.toCents(opening.find((x) => x.fund_code === f.code)?.v || 0);
    let i = 0; let x = 0;
    for (const m of moves.filter((mm) => mm.fund_code === f.code)) {
      const v = U.toCents(m.v);
      if (m.direction === 'in') i += v; else x += v;
      const key = m.source_type + ':' + m.direction;
      bySrc[key] = (bySrc[key] || 0) + v;
    }
    out.funds.push({ code: f.code, name: f.name, restricted: f.restricted, opening: o, in: i, out: x, closing: o + i - x });
    tot.opening += o; tot.in += i; tot.out += x; tot.closing += o + i - x;
  }
  out.totals = tot;
  out.bySource = bySrc;
  const s = (k) => bySrc[k] || 0;
  out.lines = {
    donationsIn: s('donation:in'),
    donationReversals: s('donation_reversal:out'),
    expensesOut: s('expense:out'),
    expenseReversals: s('expense_reversal:in'),
    disbursedOut: s('disbursement:out'),
    disbursementReversals: s('disbursement_reversal:in'),
    adjustmentsIn: s('adjustment:in') + s('opening:in'),
    adjustmentsOut: s('adjustment:out') + s('opening:out'),
  };
  out.restrictedClosing = out.funds.filter((f) => f.restricted).reduce((a, f) => a + f.closing, 0);
  out.generalClosing = out.funds.filter((f) => !f.restricted).reduce((a, f) => a + f.closing, 0);
  return out;
}

module.exports = { post, reverse, fundBalanceCents, availableCents, ensureAvailable, designatedReserves, periodSummary, assertPeriodOpen, lockFund };
