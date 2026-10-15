'use strict';
/**
 * قسم الفقراء والمساكين — منفصل تمامًا عن كفالة الأيتام:
 * جداول خاصة (الحالات، صندوق القسم، الصرف النقدي، العطاء العيني) وكشوف خاصة.
 */
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const tafqit = require('../lib/tafqit');
const exporters = require('../lib/exporters');
const { h, can, flash } = require('../middleware');

const AREAS = ['east', 'west', 'north', 'south'];
const REASONS = ['widow', 'divorced', 'sick', 'elderly', 'disabled', 'unemployed', 'low_income', 'other'];
const GIVE = ['cash', 'in_kind', 'both'];
const NAME_ORDER = 'ar_key(c.full_name) COLLATE ar_sort, c.case_no';

// ---------- اختيار القسم بعد الدخول ----------
router.get('/choose', h(async (req, res) => {
  const kafala = req.perms.has('dashboard.view') || req.perms.has('families.view');
  const poor = req.perms.has('poor.view');
  if (!poor) return res.redirect('/');
  if (!kafala) return res.redirect('/poor');
  const stats = await db.one(`SELECT
      (SELECT count(*) FROM families WHERE status='active' AND deleted_at IS NULL)::int AS families,
      (SELECT count(*) FROM poor_cases WHERE status='active' AND deleted_at IS NULL)::int AS cases`);
  res.render('choose', { title: 'اختيار القسم', stats });
}));

// ---------- رصيد صندوق القسم ----------
async function balance(c = db) {
  const r = await c.one(`SELECT
      COALESCE((SELECT SUM(amount) FROM poor_donations WHERE status='collected'),0)::text AS income,
      COALESCE((SELECT SUM(amount) FROM poor_payments WHERE status='paid'),0)::text AS spent`);
  return { ...r, balance: U.fromCents(U.toCents(r.income) - U.toCents(r.spent)) };
}

// ---------- الرئيسية ----------
router.get('/poor', can('poor.view'), h(async (req, res) => {
  const period = U.currentPeriod();
  const s = await db.one(`SELECT
      count(*) FILTER (WHERE status='active')::int AS active,
      count(*) FILTER (WHERE status='active' AND give_type IN ('cash','both'))::int AS cash,
      count(*) FILTER (WHERE status='active' AND give_type IN ('in_kind','both'))::int AS in_kind,
      COALESCE(SUM(monthly_amount) FILTER (WHERE status='active' AND give_type IN ('cash','both')),0)::text AS monthly_total
    FROM poor_cases WHERE deleted_at IS NULL`);
  const byArea = await db.many(`SELECT area, count(*)::int AS n FROM poor_cases WHERE deleted_at IS NULL AND status='active' GROUP BY area`);
  const paid = await db.one(`SELECT count(*)::int AS n, COALESCE(SUM(amount),0)::text AS total FROM poor_payments WHERE period=$1 AND status='paid'`, [period]);
  const dists = await db.many(`SELECT d.*, (SELECT count(*) FROM poor_distribution_items i WHERE i.distribution_id=d.id)::int AS n,
      (SELECT count(*) FROM poor_distribution_items i WHERE i.distribution_id=d.id AND i.received_at IS NOT NULL)::int AS got
    FROM poor_distributions d ORDER BY d.dist_date DESC, d.id DESC LIMIT 5`);
  res.render('poor/home', { title: 'قسم الفقراء والمساكين', period, s, byArea, paid, dists, bal: await balance() });
}));

// ---------- الحالات ----------
function parseCase(b) {
  const give = U.oneOf(b.give_type, GIVE, { label: 'نوع العطاء' });
  const nid = (b.national_id || '').toString().replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\s/g, '');
  if (nid && !/^\d{14}$/.test(nid)) throw new U.UserError('الرقم القومي يجب أن يتكون من 14 رقمًا');
  const reason = U.oneOf(b.reason, REASONS, { label: 'سبب الاستحقاق' });
  const c = {
    full_name: U.str(b.full_name, { required: true, max: 150, label: 'الاسم' }),
    national_id: nid || null,
    phone: U.phone(b.phone, { label: 'رقم الهاتف' }),
    reason,
    reason_note: U.str(b.reason_note, { max: 300 }),
    area: U.oneOf(b.area, AREAS, { label: 'المنطقة' }),
    give_type: give,
    monthly_amount: give === 'in_kind' ? '0.00' : U.amount(b.monthly_amount || '0', { label: 'المبلغ الشهري' }),
    family_size: b.family_size ? Math.min(30, Math.max(1, parseInt(b.family_size, 10) || 1)) : null,
    address: U.str(b.address, { max: 300 }),
    notes: U.str(b.notes, { max: 1000 }),
  };
  if (reason === 'other' && !c.reason_note) throw new U.UserError('اكتب سبب الاستحقاق');
  return c;
}

/** تنبيه إذا كان الشخص مسجلًا في قسم الأيتام أو مسجلًا من قبل هنا */
async function duplicates(c, cs, exceptId = null) {
  const warn = [];
  if (cs.national_id) {
    const d = await c.one('SELECT case_no FROM poor_cases WHERE national_id=$1 AND deleted_at IS NULL AND id <> $2', [cs.national_id, exceptId || 0]);
    if (d) throw new U.UserError(`هذا الرقم القومي مسجل من قبل في الحالة ${d.case_no}`);
    const g = await c.one('SELECT f.file_no FROM guardians g JOIN families f ON f.id=g.family_id WHERE g.national_id=$1 AND f.deleted_at IS NULL LIMIT 1', [cs.national_id]);
    if (g) warn.push(`صاحب هذا الرقم القومي مسجل في قسم كفالة الأيتام (ملف ${g.file_no})`);
  }
  if (cs.phone) {
    const g = await c.one('SELECT f.file_no FROM guardians g JOIN families f ON f.id=g.family_id WHERE (g.phone=$1 OR g.phone_alt=$1) AND f.deleted_at IS NULL LIMIT 1', [cs.phone]);
    if (g) warn.push(`رقم الهاتف مسجل في قسم كفالة الأيتام (ملف ${g.file_no})`);
    const p = await c.one('SELECT case_no FROM poor_cases WHERE phone=$1 AND deleted_at IS NULL AND id <> $2 LIMIT 1', [cs.phone, exceptId || 0]);
    if (p) warn.push(`رقم الهاتف مسجل في حالة أخرى (${p.case_no})`);
  }
  return warn;
}

router.get('/poor/cases', can('poor.view'), h(async (req, res) => {
  const where = ['c.deleted_at IS NULL']; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  const q = (req.query.q || '').trim();
  if (q) { const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'; params.push(like); const n = params.length; where.push(`(c.full_name ILIKE $${n} OR c.case_no ILIKE $${n} OR c.national_id LIKE $${n} OR c.phone LIKE $${n})`); }
  if (AREAS.includes(req.query.area)) add('c.area = ?', req.query.area);
  if (GIVE.includes(req.query.give)) add('c.give_type = ?', req.query.give);
  if (REASONS.includes(req.query.reason)) add('c.reason = ?', req.query.reason);
  if (['active', 'stopped'].includes(req.query.status)) add('c.status = ?', req.query.status);
  const rows = await db.many(`SELECT c.* FROM poor_cases c WHERE ${where.join(' AND ')} ORDER BY ${NAME_ORDER}`, params);
  res.render('poor/cases', { title: 'حالات الفقراء والمساكين', rows });
}));

router.get('/poor/cases/new', can('poor.edit'), (req, res) => res.render('poor/case-form', { title: 'إضافة حالة جديدة', c: { area: '', give_type: 'cash' }, isNew: true }));

router.post('/poor/cases', can('poor.edit'), h(async (req, res) => {
  const cs = parseCase(req.body);
  const { row, warn } = await db.tx(async (c) => {
    const warn = await duplicates(c, cs);
    const row = await c.one(`INSERT INTO poor_cases (full_name, national_id, phone, reason, reason_note, area, give_type, monthly_amount, family_size, address, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cs.full_name, cs.national_id, cs.phone, cs.reason, cs.reason_note, cs.area, cs.give_type, cs.monthly_amount, cs.family_size, cs.address, cs.notes, req.user.id]);
    await audit.log(req, 'create', 'poor_case', row.id, { after: row }, c);
    return { row, warn };
  });
  flash(req, warn.length ? 'warning' : 'success', `تم تسجيل الحالة ${row.case_no}.` + (warn.length ? ' تنبيه: ' + warn.join('، ') + '.' : ''));
  res.redirect(`/poor/cases/${row.id}`);
}));

router.get('/poor/cases/:id(\\d+)', can('poor.view'), h(async (req, res) => {
  const c = await db.one('SELECT c.*, u.full_name AS by_name FROM poor_cases c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=$1', [U.intId(req.params.id)]);
  if (!c) throw new U.UserError('الحالة غير موجودة', 404);
  const payments = await db.many('SELECT * FROM poor_payments WHERE case_id=$1 ORDER BY period DESC, id DESC LIMIT 24', [c.id]);
  const gifts = await db.many(`SELECT i.*, d.title, d.dist_date, d.dist_no FROM poor_distribution_items i JOIN poor_distributions d ON d.id=i.distribution_id WHERE i.case_id=$1 ORDER BY d.dist_date DESC`, [c.id]);
  res.render('poor/case-show', { title: `الحالة ${c.case_no}`, c, payments, gifts });
}));

router.get('/poor/cases/:id(\\d+)/edit', can('poor.edit'), h(async (req, res) => {
  const c = await db.one('SELECT * FROM poor_cases WHERE id=$1 AND deleted_at IS NULL', [U.intId(req.params.id)]);
  if (!c) throw new U.UserError('الحالة غير موجودة', 404);
  res.render('poor/case-form', { title: `تعديل الحالة ${c.case_no}`, c, isNew: false });
}));

router.post('/poor/cases/:id(\\d+)', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const cs = parseCase(req.body);
  const status = U.oneOf(req.body.status, ['active', 'stopped'], { def: 'active' });
  const warn = await db.tx(async (c) => {
    const before = await c.one('SELECT * FROM poor_cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!before) throw new U.UserError('الحالة غير موجودة', 404);
    const warn = await duplicates(c, cs, id);
    const f = { ...cs, status };
    const keys = Object.keys(f);
    await c.query(`UPDATE poor_cases SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => f[k])]);
    await audit.log(req, 'update', 'poor_case', id, audit.diff(before, f), c);
    return warn;
  });
  flash(req, warn.length ? 'warning' : 'success', 'تم حفظ التعديلات.' + (warn.length ? ' تنبيه: ' + warn.join('، ') + '.' : ''));
  res.redirect(`/poor/cases/${id}`);
}));

router.post('/poor/cases/:id(\\d+)/delete', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const c = await db.one('UPDATE poor_cases SET deleted_at=now(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING *', [id, req.user.id]);
  if (!c) throw new U.UserError('الحالة غير موجودة', 404);
  await audit.log(req, 'delete', 'poor_case', id, { before: { full_name: c.full_name } });
  flash(req, 'success', `تم حذف «${c.full_name}» ونقلها إلى سلة المحذوفات. يمكنك استرجاعها في أي وقت.`);
  res.redirect('/poor/cases');
}));

router.post('/poor/cases/:id(\\d+)/restore', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const c = await db.one('SELECT * FROM poor_cases WHERE id=$1 AND deleted_at IS NOT NULL', [id]);
  if (!c) throw new U.UserError('الحالة غير موجودة في سلة المحذوفات', 404);
  if (c.national_id && await db.one('SELECT 1 FROM poor_cases WHERE national_id=$1 AND deleted_at IS NULL', [c.national_id])) {
    throw new U.UserError('لا يمكن الاسترجاع: يوجد حالة أخرى بنفس الرقم القومي');
  }
  await db.query('UPDATE poor_cases SET deleted_at=NULL, deleted_by=NULL WHERE id=$1', [id]);
  await audit.log(req, 'restore', 'poor_case', id);
  flash(req, 'success', `تم استرجاع «${c.full_name}».`);
  res.redirect(`/poor/cases/${id}`);
}));

// ---------- الصرف النقدي الشهري ----------
async function monthlyRows(period) {
  return db.many(`SELECT c.*, p.id AS pay_id, p.amount AS paid_amount, p.pay_date
    FROM poor_cases c LEFT JOIN poor_payments p ON p.case_id=c.id AND p.period=$1 AND p.status='paid'
    WHERE c.deleted_at IS NULL AND ((c.status='active' AND c.give_type IN ('cash','both') AND c.monthly_amount > 0) OR p.id IS NOT NULL)
    ORDER BY ${NAME_ORDER}`, [period]);
}

router.get('/poor/monthly', can('poor.view'), (req, res) => res.redirect('/poor/monthly/' + U.currentPeriod()));

router.get('/poor/monthly/:period(\\d{4}-\\d{2})', can('poor.view'), h(async (req, res) => {
  const period = req.params.period;
  const rows = await monthlyRows(period);
  const due = rows.reduce((a, r) => a + U.toCents(r.pay_id ? r.paid_amount : r.monthly_amount), 0);
  const paid = rows.reduce((a, r) => a + (r.pay_id ? U.toCents(r.paid_amount) : 0), 0);
  res.render('poor/monthly', { title: `الإعانة النقدية — ${U.periodLabel(period)}`, period, rows, due, paid, bal: await balance() });
}));

router.post('/poor/monthly/:period(\\d{4}-\\d{2})/pay/:id(\\d+)', can('poor.finance'), h(async (req, res) => {
  const period = req.params.period; const id = U.intId(req.params.id);
  const c = await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['poor-fund']);
    const c = await t.one(`SELECT * FROM poor_cases WHERE id=$1 AND deleted_at IS NULL AND status='active' AND give_type IN ('cash','both')`, [id]);
    if (!c) throw new U.UserError('الحالة غير موجودة أو ليس لها إعانة نقدية', 404);
    if (U.toCents(c.monthly_amount) <= 0) throw new U.UserError('لا يوجد مبلغ شهري لهذه الحالة');
    if (await t.one(`SELECT 1 FROM poor_payments WHERE case_id=$1 AND period=$2 AND status='paid'`, [id, period])) throw new U.UserError('سُجّل استلام هذه الحالة لهذا الشهر من قبل');
    const b = await balance(t);
    if (U.toCents(b.balance) < U.toCents(c.monthly_amount)) throw new U.UserError(`رصيد صندوق الفقراء غير كافٍ (المتاح ${b.balance})`);
    const p = await t.one(`INSERT INTO poor_payments (case_id, period, amount, pay_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, period, c.monthly_amount, U.todayISO(), req.user.id]);
    await audit.log(req, 'poor_paid', 'poor_payment', p.id, { after: { case: c.case_no, period, amount: c.monthly_amount } }, t);
    return c;
  });
  flash(req, 'success', `تم تسجيل استلام «${c.full_name}» مبلغ ${c.monthly_amount}.`);
  res.redirect(`/poor/monthly/${period}#c${id}`);
}));

router.post('/poor/payments/:id(\\d+)/reverse', can('poor.finance'), h(async (req, res) => {
  const reason = U.str(req.body.reason, { required: true, max: 300, label: 'سبب الإلغاء' });
  const p = await db.one(`UPDATE poor_payments SET status='reversed', reverse_reason=$2 WHERE id=$1 AND status='paid' RETURNING *`, [U.intId(req.params.id), reason]);
  if (!p) throw new U.UserError('العملية غير موجودة أو ملغاة من قبل', 404);
  await audit.log(req, 'poor_payment_reversed', 'poor_payment', p.id, { reason });
  flash(req, 'success', 'تم إلغاء الاستلام وإرجاع المبلغ إلى رصيد الصندوق.');
  res.redirect(`/poor/monthly/${p.period}`);
}));

// ---------- الطباعة ----------
async function sendPrint(req, res, view, data, filename) {
  if (!req.perms.has('reports.export') && !req.perms.has('poor.edit') && !req.perms.has('poor.finance')) throw new U.UserError('ليست لديك صلاحية الطباعة', 403);
  const org = res.locals.org;
  const [unit, sub] = tafqit.currencyWords(org.currency);
  const words = (cents) => tafqit.amountWords(cents, unit, sub);
  const forPdf = req.query.format === 'pdf';
  const assets = forPdf ? await exporters.embeddedAssets(org) : null;
  const per = [10, 15, 20].includes(Number(req.query.per)) ? Number(req.query.per) : 15;
  const html = await new Promise((resolve, reject) => res.app.render(view, { ...res.locals, ...data, per, words, forPdf, assets, landscape: false, pdfQuery: `format=pdf&per=${per}` }, (e, h2) => (e ? reject(e) : resolve(h2))));
  await audit.log(req, forPdf ? 'print_pdf' : 'print', 'poor', data.ref || '', { after: { count: data.rows.length } });
  if (!forPdf) return res.send(html);
  const pdf = await exporters.htmlToPdf(html, { footer: `${org.name} — ${data.title}` });
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${filename}.pdf"`).send(Buffer.from(pdf));
}

router.get('/poor/monthly/:period(\\d{4}-\\d{2})/kashf', can('poor.view'), h(async (req, res) => {
  const period = req.params.period;
  const rows = (await monthlyRows(period)).map((r) => ({ ...r, amount: r.pay_id ? r.paid_amount : r.monthly_amount }));
  if (!rows.length) throw new U.UserError('لا توجد حالات لها إعانة نقدية شهرية.', 404);
  await sendPrint(req, res, 'poor/kashf', {
    rows, ref: period, kind: 'cash', title: `كشف الإعانة النقدية — ${U.periodLabel(period)}`,
    docTitle: 'كشف الإعانة النقدية الشهرية', docSub: 'شهر ' + U.periodLabel(period), backHref: `/poor/monthly/${period}`,
  }, `poor-cash-${period}`);
}));

// ---------- صندوق القسم: التبرعات ----------
router.get('/poor/donations', can('poor.view'), h(async (req, res) => {
  const rows = await db.many(`SELECT d.*, u.full_name AS by_name FROM poor_donations d LEFT JOIN users u ON u.id=d.created_by ORDER BY d.donation_date DESC, d.id DESC LIMIT 300`);
  const payments = await db.many(`SELECT p.*, c.full_name, c.case_no FROM poor_payments p JOIN poor_cases c ON c.id=p.case_id ORDER BY p.created_at DESC LIMIT 30`);
  res.render('poor/donations', { title: 'صندوق الفقراء والمساكين', rows, payments, bal: await balance() });
}));

router.post('/poor/donations', can('poor.finance'), h(async (req, res) => {
  const b = req.body;
  const d = {
    donor_name: U.str(b.donor_name, { required: true, max: 150, label: 'اسم المتبرع' }),
    kind: U.oneOf(b.kind, ['zakat', 'sadaqa', 'other'], { def: 'sadaqa' }),
    amount: U.amount(b.amount),
    donation_date: U.date(b.donation_date, { required: true }),
    method: U.oneOf(b.method, ['cash', 'bank_transfer', 'wallet', 'cheque', 'other'], { def: 'cash' }),
    notes: U.str(b.notes, { max: 500 }),
  };
  const row = await db.one(`INSERT INTO poor_donations (donor_name, kind, amount, donation_date, method, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.donor_name, d.kind, d.amount, d.donation_date, d.method, d.notes, req.user.id]);
  await audit.log(req, 'create', 'poor_donation', row.id, { after: row });
  flash(req, 'success', `تم تسجيل التبرع بإيصال رقم ${row.receipt_no}.`);
  res.redirect('/poor/donations');
}));

router.post('/poor/donations/:id(\\d+)/cancel', can('poor.finance'), h(async (req, res) => {
  const reason = U.str(req.body.reason, { required: true, max: 300, label: 'سبب الإلغاء' });
  const d = await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['poor-fund']);
    const d = await t.one(`SELECT * FROM poor_donations WHERE id=$1 AND status='collected' FOR UPDATE`, [U.intId(req.params.id)]);
    if (!d) throw new U.UserError('التبرع غير موجود أو ملغى من قبل', 404);
    const b = await balance(t);
    if (U.toCents(b.balance) < U.toCents(d.amount)) throw new U.UserError('لا يمكن الإلغاء: سيصبح رصيد الصندوق بالسالب');
    await t.query(`UPDATE poor_donations SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [d.id, reason]);
    await audit.log(req, 'poor_donation_cancelled', 'poor_donation', d.id, { reason }, t);
    return d;
  });
  flash(req, 'success', `تم إلغاء التبرع ${d.receipt_no}.`);
  res.redirect('/poor/donations');
}));

// ---------- العطاء العيني ----------
router.get('/poor/gifts', can('poor.view'), h(async (req, res) => {
  const rows = await db.many(`SELECT d.*, (SELECT count(*) FROM poor_distribution_items i WHERE i.distribution_id=d.id)::int AS n,
      (SELECT count(*) FROM poor_distribution_items i WHERE i.distribution_id=d.id AND i.received_at IS NOT NULL)::int AS got
    FROM poor_distributions d ORDER BY d.dist_date DESC, d.id DESC`);
  res.render('poor/gifts', { title: 'العطاء العيني', rows });
}));

router.post('/poor/gifts', can('poor.edit'), h(async (req, res) => {
  const b = req.body;
  const d = await db.tx(async (t) => {
    const d = await t.one(`INSERT INTO poor_distributions (title, items, dist_date, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [U.str(b.title, { required: true, max: 150, label: 'اسم العطاء' }), U.str(b.items, { max: 300 }), U.date(b.dist_date, { required: true, label: 'تاريخ التوزيع' }), U.str(b.notes, { max: 500 }), req.user.id]);
    let added = 0;
    if (b.add_all === '1') {
      const r = await t.query(`INSERT INTO poor_distribution_items (distribution_id, case_id, quantity)
        SELECT $1, id, $2 FROM poor_cases WHERE deleted_at IS NULL AND status='active' AND give_type IN ('in_kind','both') ON CONFLICT DO NOTHING`, [d.id, U.str(b.quantity, { max: 100 })]);
      added = r.rowCount;
    }
    await audit.log(req, 'create', 'poor_distribution', d.id, { after: { ...d, added } }, t);
    return d;
  });
  flash(req, 'success', `تم إنشاء «${d.title}». أضف الحالات أو عدّل الكميات ثم اطبع الكشف.`);
  res.redirect(`/poor/gifts/${d.id}`);
}));

async function giftRows(id) {
  return db.many(`SELECT i.*, c.case_no, c.full_name, c.national_id, c.phone, c.area, c.give_type, c.deleted_at
    FROM poor_distribution_items i JOIN poor_cases c ON c.id=i.case_id WHERE i.distribution_id=$1 ORDER BY ${NAME_ORDER}`, [id]);
}

router.get('/poor/gifts/:id(\\d+)', can('poor.view'), h(async (req, res) => {
  const d = await db.one('SELECT * FROM poor_distributions WHERE id=$1', [U.intId(req.params.id)]);
  if (!d) throw new U.UserError('العطاء غير موجود', 404);
  const rows = await giftRows(d.id);
  const others = await db.many(`SELECT c.id, c.case_no, c.full_name, c.area FROM poor_cases c WHERE c.deleted_at IS NULL AND c.status='active'
      AND NOT EXISTS (SELECT 1 FROM poor_distribution_items i WHERE i.distribution_id=$1 AND i.case_id=c.id) ORDER BY ${NAME_ORDER}`, [d.id]);
  res.render('poor/gift', { title: d.title, d, rows, others });
}));

const openGift = async (t, id) => {
  const d = await t.one('SELECT * FROM poor_distributions WHERE id=$1 FOR UPDATE', [id]);
  if (!d) throw new U.UserError('العطاء غير موجود', 404);
  if (d.status === 'closed') throw new U.UserError('هذا العطاء مقفل');
  return d;
};

router.post('/poor/gifts/:id(\\d+)/add', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const qty = U.str(req.body.quantity, { max: 100 });
  const n = await db.tx(async (t) => {
    await openGift(t, id);
    if (req.body.add_all === '1') {
      const area = AREAS.includes(req.body.area) ? req.body.area : null;
      const r = await t.query(`INSERT INTO poor_distribution_items (distribution_id, case_id, quantity)
        SELECT $1, id, $2 FROM poor_cases WHERE deleted_at IS NULL AND status='active' AND give_type IN ('in_kind','both') AND ($3::text IS NULL OR area=$3)
        ON CONFLICT DO NOTHING`, [id, qty, area]);
      return r.rowCount;
    }
    const ids = [].concat(req.body.case_id || []).map((x) => U.intId(x));
    if (!ids.length) throw new U.UserError('اختر حالة واحدة على الأقل');
    const r = await t.query(`INSERT INTO poor_distribution_items (distribution_id, case_id, quantity)
      SELECT $1, id, $2 FROM poor_cases WHERE id = ANY($3) AND deleted_at IS NULL ON CONFLICT DO NOTHING`, [id, qty, ids]);
    return r.rowCount;
  });
  await audit.log(req, 'poor_gift_add', 'poor_distribution', id, { after: { added: n } });
  flash(req, 'success', `تمت إضافة ${n} حالة إلى الكشف.`);
  res.redirect(`/poor/gifts/${id}`);
}));

router.post('/poor/gifts/:id(\\d+)/items/:item(\\d+)', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id); const item = U.intId(req.params.item);
  await db.tx(async (t) => {
    await openGift(t, id);
    const act = req.body.action;
    if (act === 'remove') await t.query('DELETE FROM poor_distribution_items WHERE id=$1 AND distribution_id=$2', [item, id]);
    else if (act === 'received') await t.query('UPDATE poor_distribution_items SET received_at=now() WHERE id=$1 AND distribution_id=$2', [item, id]);
    else if (act === 'unreceived') await t.query('UPDATE poor_distribution_items SET received_at=NULL WHERE id=$1 AND distribution_id=$2', [item, id]);
    else if (act === 'qty') await t.query('UPDATE poor_distribution_items SET quantity=$3 WHERE id=$1 AND distribution_id=$2', [item, id, U.str(req.body.quantity, { max: 100 })]);
    await audit.log(req, 'poor_gift_item_' + (act || 'none'), 'poor_distribution', id, { after: { item } }, t);
  });
  res.redirect(`/poor/gifts/${id}#i${item}`);
}));

router.post('/poor/gifts/:id(\\d+)/close', can('poor.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const reopen = req.body.reopen === '1';
  await db.query(`UPDATE poor_distributions SET status=$2 WHERE id=$1`, [id, reopen ? 'open' : 'closed']);
  await audit.log(req, reopen ? 'poor_gift_reopened' : 'poor_gift_closed', 'poor_distribution', id);
  flash(req, 'success', reopen ? 'تم فتح الكشف للتعديل.' : 'تم إقفال الكشف.');
  res.redirect(`/poor/gifts/${id}`);
}));

router.get('/poor/gifts/:id(\\d+)/kashf', can('poor.view'), h(async (req, res) => {
  const d = await db.one('SELECT * FROM poor_distributions WHERE id=$1', [U.intId(req.params.id)]);
  if (!d) throw new U.UserError('العطاء غير موجود', 404);
  const rows = await giftRows(d.id);
  if (!rows.length) throw new U.UserError('الكشف فارغ. أضف الحالات أولًا.', 404);
  await sendPrint(req, res, 'poor/kashf', {
    rows, ref: d.dist_no, kind: 'gift', d, title: `كشف عطاء عيني — ${d.title}`,
    docTitle: 'كشف عطاء عيني', docSub: new Date(d.dist_date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }), backHref: `/poor/gifts/${d.id}`,
  }, `poor-gift-${d.dist_no}`);
}));

module.exports = router;
module.exports.balance = balance;
