'use strict';
// منطق التبرعات المشترك (التسجيل، التحصيل، العكس) — كل تبرع ينتج قيدًا واحدًا فقط عند التحصيل
const U = require('./util');
const finance = require('./finance');
const audit = require('./audit');

const METHODS = ['cash', 'bank_transfer', 'wallet', 'cheque', 'card', 'other'];

async function create(c, b, user, req, { collectNow = false } = {}) {
  const type = await c.one('SELECT * FROM donation_types WHERE code=$1 AND is_active', [b.type_code]);
  if (!type) throw new U.UserError('نوع التبرع غير صالح');
  const d = {
    donation_date: U.date(b.donation_date, { required: true, label: 'تاريخ العملية' }),
    donor_name: U.str(b.donor_name, { required: true, max: 150, label: 'اسم المتبرع أو الرمز' }),
    amount: U.amount(b.amount),
    payment_method: U.oneOf(b.payment_method, METHODS, { label: 'طريقة الدفع' }),
    reference: U.str(b.reference, { max: 120 }),
    period: U.validPeriod(b.period) ? b.period : null,
    purpose: U.str(b.purpose, { max: 300 }),
    notes: U.str(b.notes, { max: 1000 }),
    family_id: null, sponsor_id: null, contribution_id: null,
  };
  if (!d.period) d.period = d.donation_date.slice(0, 7);
  if (d.donation_date > U.todayISO()) throw new U.UserError('تاريخ التبرع لا يمكن أن يكون في المستقبل');
  if (type.is_family_designated) {
    d.family_id = U.intId(b.family_id);
    if (!(await c.one('SELECT 1 FROM families WHERE id=$1', [d.family_id]))) throw new U.UserError('الأسرة غير موجودة');
  }
  if (type.is_sponsor_contribution) {
    d.sponsor_id = U.intId(b.sponsor_id);
    const sp = await c.one('SELECT id, full_name, monthly_pledge FROM sponsors WHERE id=$1', [d.sponsor_id]);
    if (!sp) throw new U.UserError('الكفيل غير موجود');
    // ربط المساهمة بتعهد الشهر (يُنشأ إن لم يوجد) لضمان احتسابها مرة واحدة
    const sc = await c.one(
      `INSERT INTO sponsor_contributions (sponsor_id, period, pledged_amount, created_by)
       VALUES ($1,$2,(SELECT COALESCE(SUM(monthly_amount), $4) FROM family_sponsorships WHERE sponsor_id=$1 AND status='active'),$3)
       ON CONFLICT (sponsor_id, period) DO UPDATE SET sponsor_id=EXCLUDED.sponsor_id RETURNING id`,
      [d.sponsor_id, d.period, user.id, sp.monthly_pledge]);
    d.contribution_id = sc.id;
    if (!b.donor_name) d.donor_name = sp.full_name;
  }
  const row = await c.one(
    `INSERT INTO donations (donation_date, donor_name, type_code, fund_code, amount, payment_method, reference, period, purpose, family_id, sponsor_id, contribution_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [d.donation_date, d.donor_name, type.code, type.fund_code, d.amount, d.payment_method, d.reference, d.period, d.purpose, d.family_id, d.sponsor_id,
      d.contribution_id, d.notes, user.id]);
  await audit.log(req || { user }, 'create', 'donation', row.id, { after: row }, c);
  if (collectNow) await collect(c, row.id, { date: d.donation_date }, user, req);
  return row;
}

async function collect(c, id, { date }, user, req) {
  const d = await c.one('SELECT * FROM donations WHERE id=$1 FOR UPDATE', [id]);
  if (!d) throw new U.UserError('التبرع غير موجود', 404);
  if (!['pending', 'needs_settlement'].includes(d.status)) throw new U.UserError('هذا التبرع ليس بانتظار التحصيل (منع الاحتساب المزدوج)');
  const cdate = U.date(date, { required: true, label: 'تاريخ التحصيل' });
  if (cdate > U.todayISO()) throw new U.UserError('تاريخ التحصيل لا يمكن أن يكون في المستقبل');
  await finance.post(c, { date: cdate, fund: d.fund_code, direction: 'in', amount: d.amount, source_type: 'donation', source_id: d.id,
    family_id: d.family_id, description: `تبرع ${d.receipt_no} — ${d.donor_name}`, user });
  await c.query(`UPDATE donations SET status='collected', collected_at=now(), collected_by=$2, updated_at=now() WHERE id=$1`, [id, user.id]);
  await audit.log(req || { user }, 'collect', 'donation', id, { before: { status: d.status }, after: { status: 'collected', date: cdate } }, c);
}

async function reverse(c, id, reason, user, req) {
  if (!reason) throw new U.UserError('سبب الإلغاء مطلوب للتوثيق');
  const d = await c.one('SELECT * FROM donations WHERE id=$1 FOR UPDATE', [id]);
  if (!d) throw new U.UserError('التبرع غير موجود', 404);
  if (d.status === 'collected') {
    // لا يجوز أن يصبح رصيد الصندوق المقيد سالبًا بسبب العكس
    await finance.lockFund(c, d.fund_code);
    const bal = await finance.fundBalanceCents(c, d.fund_code);
    if (bal < U.toCents(d.amount)) throw new U.UserError('لا يمكن عكس التبرع لأن المبلغ صُرف بالفعل؛ سجّل تسوية موثقة بدلًا من ذلك');
    await finance.reverse(c, 'donation', id, 'donation_reversal', { date: U.todayISO(), reason, user });
    await c.query(`UPDATE donations SET status='reversed', reversal_reason=$2, reversed_by=$3, reversed_at=now(), updated_at=now() WHERE id=$1`, [id, reason, user.id]);
  } else if (['pending', 'needs_settlement'].includes(d.status)) {
    await c.query(`UPDATE donations SET status='cancelled', reversal_reason=$2, reversed_by=$3, reversed_at=now(), updated_at=now() WHERE id=$1`, [id, reason, user.id]);
  } else throw new U.UserError('التبرع ملغى مسبقًا');
  await audit.log(req || { user }, 'reverse', 'donation', id, { before: { status: d.status }, reason }, c);
}

module.exports = { create, collect, reverse, METHODS };
