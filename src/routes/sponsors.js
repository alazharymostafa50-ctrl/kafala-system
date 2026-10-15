'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const donations = require('../lib/donations');
const elig = require('../lib/eligibility');
const { paged, Where } = require('../lib/paging');
const { h, can, flash } = require('../middleware');

const STATUSES = ['active', 'stopped', 'follow_up'];
const TYPES = ['monthly', 'quarterly', 'annual', 'one_time'];

function parseSponsor(b) {
  return {
    full_name: U.str(b.full_name, { required: true, max: 150, label: 'اسم الكفيل' }),
    phone: U.phone(b.phone, { required: true }),
    phone_alt: U.phone(b.phone_alt, { label: 'الجوال البديل' }),
    sponsorship_type: U.oneOf(b.sponsorship_type, TYPES, { label: 'نوع الكفالة', def: 'monthly' }),
    monthly_pledge: U.amount(b.monthly_pledge || '0', { allowZero: true, label: 'المبلغ الشهري المتعهد به' }),
    start_date: U.date(b.start_date, { label: 'تاريخ البداية' }),
    status: U.oneOf(b.status, STATUSES, { def: 'active', label: 'الحالة' }),
    payment_method: U.str(b.payment_method, { max: 60 }),
    notes: U.str(b.notes, { max: 1000 }),
  };
}

/** حالة سداد التعهد الشهري */
function pledgeStatus(p, today = U.currentPeriod()) {
  const pl = U.toCents(p.pledged_amount); const col = U.toCents(p.collected);
  if (p.needs_review) return 'review';
  if (col >= pl && pl > 0) return 'paid';
  if (col > 0) return 'partial';
  if (p.period < today) return 'late';
  return 'unpaid';
}

const PLEDGE_SQL = `SELECT sc.*, sp.sponsor_no, sp.full_name, sp.phone,
   COALESCE((SELECT SUM(d.amount) FROM donations d WHERE d.contribution_id=sc.id AND d.status='collected'),0)::text AS collected,
   (SELECT max(l.entry_date) FROM donations d JOIN ledger_entries l ON l.source_type='donation' AND l.source_id=d.id WHERE d.contribution_id=sc.id AND d.status='collected') AS last_collected
   FROM sponsor_contributions sc JOIN sponsors sp ON sp.id=sc.sponsor_id`;

router.get('/sponsors', can('sponsors.view'), h(async (req, res) => {
  const w = new Where();
  const q = (req.query.q || '').trim();
  if (q) { const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'; w.add('(s.full_name ILIKE ? OR s.sponsor_no ILIKE ? OR s.phone LIKE ?)', like, like, like); }
  if (STATUSES.includes(req.query.status)) w.add('s.status = ?', req.query.status);
  w.add('s.deleted_at IS NULL');
  const base = `SELECT s.*, (SELECT count(*) FROM family_sponsorships fs WHERE fs.sponsor_id=s.id AND fs.status='active')::int AS families_n,
     (SELECT COALESCE(SUM(monthly_amount),0) FROM family_sponsorships fs WHERE fs.sponsor_id=s.id AND fs.status='active')::text AS linked_amount
     FROM sponsors s ${w.sql}`;
  const p = await paged(req, base, w.params, 's.id DESC');
  const linkFamily = req.query.link_family ? await db.one('SELECT id, file_no, family_name FROM families WHERE id=$1', [U.intId(req.query.link_family)]) : null;
  res.render('sponsors/list', { title: 'إدارة الكفلاء', p, linkFamily });
}));

router.get('/sponsors/new', can('sponsors.edit'), (req, res) => res.render('sponsors/form', { title: 'إضافة كفيل', s: { status: 'active', sponsorship_type: 'monthly', start_date: U.todayISO() }, isNew: true }));

router.post('/sponsors', can('sponsors.edit'), h(async (req, res) => {
  const s = parseSponsor(req.body);
  const row = await db.tx(async (c) => {
    const dup = await c.one('SELECT sponsor_no FROM sponsors WHERE phone=$1', [s.phone]);
    if (dup && req.body.confirm_duplicate !== '1') throw new U.UserError(`يوجد كفيل بنفس رقم الجوال (${dup.sponsor_no}). فعّل «تأكيد أنه كفيل مختلف» للمتابعة.`);
    const keys = Object.keys(s);
    const r = await c.one(`INSERT INTO sponsors (${keys.join(',')}, created_by) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}, $${keys.length + 1}) RETURNING *`, [...keys.map((k) => s[k]), req.user.id]);
    await audit.log(req, 'create', 'sponsor', r.id, { after: r }, c);
    return r;
  });
  flash(req, 'success', `تم تسجيل الكفيل ${row.sponsor_no}. اربطه الآن بأسرة أو أكثر.`);
  res.redirect(`/sponsors/${row.id}`);
}));

router.get('/sponsors/:id(\\d+)', can('sponsors.view'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const s = await db.one('SELECT * FROM sponsors WHERE id=$1', [id]);
  if (!s) throw new U.UserError('الكفيل غير موجود', 404);
  const links = await db.many(`SELECT fs.*, f.file_no, f.family_name, f.status AS family_status FROM family_sponsorships fs JOIN families f ON f.id=fs.family_id WHERE fs.sponsor_id=$1 ORDER BY fs.status, fs.start_date DESC`, [id]);
  const pledges = await db.many(`${PLEDGE_SQL} WHERE sc.sponsor_id=$1 ORDER BY sc.period DESC LIMIT 36`, [id]);
  pledges.forEach((p) => { p.pstatus = pledgeStatus(p); p.remaining = U.fromCents(Math.max(0, U.toCents(p.pledged_amount) - U.toCents(p.collected))); });
  const contributions = await db.many(`SELECT d.*, u.full_name AS by_name FROM donations d LEFT JOIN users u ON u.id=d.created_by WHERE d.sponsor_id=$1 ORDER BY d.donation_date DESC LIMIT 50`, [id]);
  const families = req.perms.has('sponsors.edit') ? await db.many(`SELECT id, file_no, family_name FROM families WHERE status IN ('active','under_review') ORDER BY file_no`) : [];
  res.render('sponsors/show', { title: `الكفيل ${s.sponsor_no}`, s, links, pledges, contributions, families, preselect: req.query.family });
}));

router.get('/sponsors/:id(\\d+)/edit', can('sponsors.edit'), h(async (req, res) => {
  const s = await db.one('SELECT * FROM sponsors WHERE id=$1', [U.intId(req.params.id)]);
  if (!s) throw new U.UserError('الكفيل غير موجود', 404);
  res.render('sponsors/form', { title: 'تعديل الكفيل', s, isNew: false });
}));

router.post('/sponsors/:id(\\d+)', can('sponsors.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const s = parseSponsor(req.body);
  await db.tx(async (c) => {
    const b = await c.one('SELECT * FROM sponsors WHERE id=$1 FOR UPDATE', [id]);
    if (!b) throw new U.UserError('الكفيل غير موجود', 404);
    const keys = Object.keys(s);
    await c.query(`UPDATE sponsors SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => s[k])]);
    const d = audit.diff(b, s);
    if (d.changed) await audit.log(req, 'update', 'sponsor', id, d, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', s.status === 'stopped' ? 'تم حفظ التعديل. السجلات السابقة محفوظة، وستظهر الأسر المرتبطة في قائمة «تحتاج كفيلًا» دون إيقاف استحقاقها.' : 'تم حفظ التعديلات');
  res.redirect(`/sponsors/${id}`);
}));

// ربط كفيل بأسرة
router.post('/sponsors/:id(\\d+)/links', can('sponsors.edit'), h(async (req, res) => {
  const sid = U.intId(req.params.id);
  const fid = U.intId(req.body.family_id);
  const amount = U.amount(req.body.monthly_amount, { label: 'المبلغ الشهري المخصص', allowZero: true });
  const start = U.date(req.body.start_date, { required: true, label: 'تاريخ البداية' });
  await db.tx(async (c) => {
    const r = await c.one(`INSERT INTO family_sponsorships (sponsor_id, family_id, sponsorship_type, monthly_amount, start_date, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [sid, fid, U.oneOf(req.body.sponsorship_type, TYPES, { def: 'monthly' }), amount, start, U.str(req.body.notes, { max: 500 }), req.user.id])
      .catch((e) => { if (e.code === '23505') throw new U.UserError('يوجد ارتباط نشط بين هذا الكفيل وهذه الأسرة مسبقًا'); throw e; });
    await audit.log(req, 'link', 'family_sponsorship', r.id, { after: r }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم ربط الكفيل بالأسرة');
  res.redirect(`/sponsors/${sid}`);
}));

router.post('/links/:id/end', can('sponsors.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const end = U.date(req.body.end_date, { required: true, label: 'تاريخ الانتهاء' });
  const reason = U.str(req.body.reason, { required: true, label: 'السبب' });
  let sid;
  await db.tx(async (c) => {
    const l = await c.one('SELECT * FROM family_sponsorships WHERE id=$1 FOR UPDATE', [id]);
    if (!l || l.status !== 'active') throw new U.UserError('الارتباط غير نشط');
    if (end < l.start_date) throw new U.UserError('تاريخ الانتهاء قبل تاريخ البداية');
    sid = l.sponsor_id;
    await c.query(`UPDATE family_sponsorships SET status='ended', end_date=$2, notes=COALESCE(notes,'') || ' | إنهاء: ' || $3, updated_at=now() WHERE id=$1`, [id, end, reason]);
    await audit.log(req, 'unlink', 'family_sponsorship', id, { before: { status: 'active' }, after: { status: 'ended', end_date: end }, reason }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم إنهاء الارتباط مع الاحتفاظ بسجله');
  res.redirect(`/sponsors/${sid}`);
}));

// توليد تعهدات شهر لجميع الكفلاء النشطين
router.post('/sponsors/pledges/generate', can('sponsors.edit'), h(async (req, res) => {
  const period = req.body.period;
  if (!U.validPeriod(period)) throw new U.UserError('الشهر غير صالح');
  const n = await db.tx(async (c) => {
    const r = await c.query(
      `INSERT INTO sponsor_contributions (sponsor_id, period, pledged_amount, created_by)
       SELECT s.id, $1, COALESCE(NULLIF((SELECT SUM(fs.monthly_amount) FROM family_sponsorships fs WHERE fs.sponsor_id=s.id AND fs.status='active'
                 AND fs.start_date <= $3::date),0), s.monthly_pledge), $2
       FROM sponsors s WHERE s.status IN ('active','follow_up') AND s.sponsorship_type='monthly'
       ON CONFLICT (sponsor_id, period) DO NOTHING`, [period, req.user.id, U.periodEnd(period)]);
    await audit.log(req, 'pledges_generated', 'sponsor_contributions', period, { after: { created: r.rowCount } }, c);
    return r.rowCount;
  });
  flash(req, 'success', `تم إنشاء ${n} تعهد لشهر ${U.periodLabel(period)} (التعهد ليس مبلغًا محصلًا).`);
  res.redirect(`/sponsors/pledges?period=${period}`);
}));


// متابعة التعهدات لشهر
router.get('/sponsors/pledges', can('sponsors.view'), h(async (req, res) => {
  const period = U.validPeriod(req.query.period) ? req.query.period : U.currentPeriod();
  const rows = await db.many(`${PLEDGE_SQL} WHERE sc.period=$1 ORDER BY sp.sponsor_no`, [period]);
  rows.forEach((p) => { p.pstatus = pledgeStatus(p); p.remaining = U.fromCents(Math.max(0, U.toCents(p.pledged_amount) - U.toCents(p.collected))); });
  const filtered = req.query.status ? rows.filter((r) => r.pstatus === req.query.status) : rows;
  res.render('sponsors/pledges', { title: 'تعهدات الكفلاء الشهرية', period, rows: filtered, all: rows });
}));

// تسجيل تحصيل مساهمة كفيل (تبرع من نوع «مساهمة كفيل» يُحتسب مرة واحدة)
router.post('/sponsors/:id(\\d+)/collect', can('donations.edit'), h(async (req, res) => {
  const sid = U.intId(req.params.id);
  const collectNow = req.perms.has('donations.collect');
  await db.tx(async (c) => {
    await donations.create(c, { ...req.body, type_code: 'sponsor', sponsor_id: sid }, req.user, req, { collectNow });
  });
  flash(req, 'success', collectNow ? 'تم تسجيل التحصيل وإضافته إلى صندوق كفالة الأيتام' : 'تم تسجيل المساهمة بانتظار تأكيد التحصيل من المحاسب');
  res.redirect(req.body.back === 'pledges' ? `/sponsors/pledges?period=${req.body.period}` : `/sponsors/${sid}`);
}));

router.post('/pledges/:id/review', can('sponsors.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const p = await db.one(`UPDATE sponsor_contributions SET needs_review = NOT needs_review, notes=COALESCE($2, notes) WHERE id=$1 RETURNING sponsor_id, needs_review`, [id, U.str(req.body.notes, { max: 500 })]);
  if (!p) throw new U.UserError('التعهد غير موجود', 404);
  await audit.log(req, 'pledge_review_flag', 'sponsor_contribution', id, { after: { needs_review: p.needs_review } });
  res.redirect(`/sponsors/${p.sponsor_id}`);
}));

module.exports = router;
module.exports.pledgeStatus = pledgeStatus;
module.exports.PLEDGE_SQL = PLEDGE_SQL;
