'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const elig = require('../lib/eligibility');
const settings = require('../lib/settings');
const { paged, Where } = require('../lib/paging');
const { h, can, flash } = require('../middleware');

const FAMILY_STATUSES = ['active', 'under_review', 'suspended', 'closed', 'archived'];
const PAYOUT = ['cash', 'bank_transfer', 'wallet', 'cheque', 'other'];

function mask(v) { if (!v) return v; const s = String(v); return s.length <= 4 ? '••••' : '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4); }

function parseFamily(b) {
  return {
    family_name: U.str(b.family_name, { required: true, max: 150, label: 'اسم الأسرة' }),
    opened_on: U.date(b.opened_on, { label: 'تاريخ فتح الملف' }) || U.todayISO(),
    address: U.str(b.address, { max: 300 }),
    city: U.str(b.city, { max: 80 }),
    district: U.str(b.district, { max: 80 }),
    calc_method: U.oneOf(b.calc_method, ['family_fixed', 'per_member', 'mixed'], { label: 'طريقة احتساب الكفالة' }),
    monthly_amount: U.amount(b.monthly_amount || '0', { allowZero: true, label: 'قيمة الكفالة الشهرية' }),
    aid_amount: U.amount(b.aid_amount || '0', { allowZero: true, label: 'قيمة الإعانة الشهرية' }),
    aid_note: U.str(b.aid_note, { max: 200, label: 'سبب الإعانة' }),
    last_review_on: U.date(b.last_review_on, { label: 'تاريخ آخر مراجعة' }),
    responsible_user_id: b.responsible_user_id ? U.intId(b.responsible_user_id) : null,
  };
}
function parseGuardian(b, canSensitive) {
  const g = {
    full_name: U.str(b.g_full_name, { required: true, max: 150, label: 'اسم ولي الأمر' }),
    relation: U.str(b.g_relation, { max: 60 }),
    phone: U.phone(b.g_phone, { required: true, label: 'جوال ولي الأمر' }),
    phone_alt: U.phone(b.g_phone_alt, { label: 'الجوال البديل' }),
    payout_method: b.g_payout_method ? U.oneOf(b.g_payout_method, PAYOUT, { label: 'وسيلة الاستلام' }) : null,
    notes: U.str(b.g_notes, { max: 1000 }),
  };
  if (canSensitive) {
    g.national_id = U.str(b.g_national_id, { max: 30, label: 'رقم الهوية' });
    g.bank_name = U.str(b.g_bank_name, { max: 100 });
    g.iban = U.str((b.g_iban || '').replace(/\s/g, '').toUpperCase(), { max: 40, label: 'IBAN' });
  }
  return g;
}

// ---------- القائمة والبحث ----------
router.get('/families', can('families.view'), h(async (req, res) => {
  const w = new Where();
  const q = (req.query.q || '').trim();
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
    const digits = q.replace(/\D/g, '');
    w.add(`(f.file_no ILIKE ? OR f.family_name ILIKE ? OR g.full_name ILIKE ? OR g.phone LIKE ? OR g.phone_alt LIKE ?
           OR EXISTS (SELECT 1 FROM family_members mm WHERE mm.family_id=f.id AND (mm.full_name ILIKE ? OR mm.member_no ILIKE ?)))`,
      like, like, like, digits ? '%' + digits + '%' : like, digits ? '%' + digits + '%' : like, like, like);
  }
  if (FAMILY_STATUSES.includes(req.query.status)) w.add('f.status = ?', req.query.status);
  else if (req.query.status !== 'all') w.add("f.status <> 'archived'");
  if (req.query.city) w.add('f.city = ?', req.query.city);
  if (req.query.nosponsor === '1') w.add(`NOT EXISTS (SELECT 1 FROM family_sponsorships s WHERE s.family_id=f.id AND s.status='active')`);
  const base = `SELECT f.*, g.full_name AS guardian_name, g.phone,
      (SELECT count(*) FROM family_members m WHERE m.family_id=f.id)::int AS members_count,
      (SELECT count(*) FROM family_members m WHERE m.family_id=f.id AND m.eligibility_status IN ('eligible','eligible_university'))::int AS eligible_count,
      (SELECT count(*) FROM family_sponsorships s WHERE s.family_id=f.id AND s.status='active')::int AS sponsors_count
    FROM families f LEFT JOIN guardians g ON g.family_id=f.id ${w.sql}`;
  const p = await paged(req, base, w.params, 'ar_key(COALESCE(g.full_name, f.family_name)) COLLATE ar_sort, f.file_no');
  const cities = await db.many(`SELECT DISTINCT city FROM families WHERE city IS NOT NULL ORDER BY city`);
  res.render('families/list', { title: 'إدارة الأسر', p, cities });
}));

// ---------- إنشاء ----------
router.get('/families/new', can('families.edit'), h(async (req, res) => {
  const users = await db.many('SELECT id, full_name FROM users WHERE is_active ORDER BY full_name');
  res.render('families/form', { title: 'إضافة أسرة', f: { calc_method: 'family_fixed', status: 'active', opened_on: U.todayISO() }, g: {}, users, isNew: true });
}));

router.post('/families', can('families.edit'), h(async (req, res) => {
  const sens = req.perms.has('families.sensitive');
  const f = parseFamily(req.body);
  const g = parseGuardian(req.body, sens);
  const status = req.perms.has('eligibility.decide') ? U.oneOf(req.body.status, ['active', 'under_review'], { def: 'under_review' }) : 'under_review';
  const id = await db.tx(async (c) => {
    // تنبيه عند احتمال التكرار برقم الجوال
    const dup = await c.one('SELECT f.file_no FROM guardians g JOIN families f ON f.id=g.family_id WHERE g.phone=$1 OR g.phone_alt=$1 LIMIT 1', [g.phone]);
    if (dup && req.body.confirm_duplicate !== '1') throw new U.UserError(`يوجد ملف أسرة مسجل بنفس رقم الجوال (${dup.file_no}). إذا كانت أسرة مختلفة فعلًا، فعّل خيار «تأكيد أنها أسرة مختلفة» وأعد الحفظ.`);
    const row = await c.one(
      `INSERT INTO families (family_name, opened_on, status, address, city, district, calc_method, monthly_amount, aid_amount, aid_note, last_review_on, responsible_user_id, confidential_notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [f.family_name, f.opened_on, status, f.address, f.city, f.district, f.calc_method, f.monthly_amount, f.aid_amount, f.aid_note, f.last_review_on, f.responsible_user_id,
        sens ? U.str(req.body.confidential_notes, { max: 3000 }) : null, req.user.id]);
    await c.query(
      `INSERT INTO guardians (family_id, full_name, relation, national_id, phone, phone_alt, payout_method, bank_name, iban, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.id, g.full_name, g.relation, g.national_id || null, g.phone, g.phone_alt, g.payout_method, g.bank_name || null, g.iban || null, g.notes]);
    await audit.log(req, 'create', 'family', row.id, { after: { ...row, guardian: g } }, c);
    return row.id;
  });
  flash(req, 'success', 'تم إنشاء ملف الأسرة بنجاح. أضف أفراد الأسرة الآن.');
  res.redirect(`/families/${id}`);
}));

// ---------- عرض الملف ----------
async function loadFamily(id) {
  const f = await db.one(`SELECT f.*, u.full_name AS responsible_name FROM families f LEFT JOIN users u ON u.id=f.responsible_user_id WHERE f.id=$1`, [id]);
  if (!f) throw new U.UserError('ملف الأسرة غير موجود', 404);
  f.guardian = await db.one('SELECT * FROM guardians WHERE family_id=$1', [id]) || {};
  return f;
}

router.get('/families/:id', can('families.view'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const f = await loadFamily(id);
  const sens = req.perms.has('families.sensitive');
  if (!sens) { f.guardian.national_id = mask(f.guardian.national_id); f.guardian.iban = mask(f.guardian.iban); f.confidential_notes = null; }
  const members = await db.many('SELECT * FROM family_members WHERE family_id=$1 ORDER BY birth_date', [id]);
  members.forEach((m) => { m.age = U.ageOn(m.birth_date); if (!sens) m.national_id = mask(m.national_id); });
  const decisions = await db.many(
    `SELECT d.*, m.full_name, u.full_name AS by_name FROM eligibility_decisions d JOIN family_members m ON m.id=d.member_id
     LEFT JOIN users u ON u.id=d.decided_by WHERE m.family_id=$1 ORDER BY d.decided_at DESC LIMIT 100`, [id]);
  const sponsors = req.perms.has('sponsors.view') ? await db.many(
    `SELECT s.*, sp.full_name, sp.sponsor_no, sp.status AS sponsor_status FROM family_sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id
     WHERE s.family_id=$1 ORDER BY s.status, s.start_date DESC`, [id]) : null;
  const ents = req.perms.has('entitlements.view') ? await db.many(
    `SELECT * FROM monthly_entitlements WHERE family_id=$1 ORDER BY period DESC LIMIT 24`, [id]) : null;
  const reviews = await db.many(`SELECT r.*, m.full_name FROM eligibility_reviews r JOIN family_members m ON m.id=r.member_id WHERE m.family_id=$1 AND r.status='open'`, [id]);
  const missing = await elig.missingDocuments(db, await settings.get('documents'), id);
  const notes = await db.many(`SELECT * FROM notifications WHERE family_id=$1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`, [id]);
  res.render('families/show', { title: `ملف الأسرة ${f.file_no}`, f, members, decisions, sponsors, ents, reviews, missing, notes, sens });
}));

// ---------- تعديل ----------
router.get('/families/:id/edit', can('families.edit'), h(async (req, res) => {
  const f = await loadFamily(U.intId(req.params.id));
  const users = await db.many('SELECT id, full_name FROM users WHERE is_active ORDER BY full_name');
  if (!req.perms.has('families.sensitive')) { f.guardian.national_id = mask(f.guardian.national_id); f.guardian.iban = mask(f.guardian.iban); }
  res.render('families/form', { title: 'تعديل ملف الأسرة', f, g: f.guardian, users, isNew: false });
}));

router.post('/families/:id', can('families.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const sens = req.perms.has('families.sensitive');
  const f = parseFamily(req.body);
  const g = parseGuardian(req.body, sens);
  await db.tx(async (c) => {
    const before = await c.one('SELECT * FROM families WHERE id=$1 FOR UPDATE', [id]);
    if (!before) throw new U.UserError('الملف غير موجود', 404);
    const gb = await c.one('SELECT * FROM guardians WHERE family_id=$1', [id]);
    const fields = { ...f };
    if (sens) fields.confidential_notes = U.str(req.body.confidential_notes, { max: 3000 });
    const keys = Object.keys(fields);
    await c.query(`UPDATE families SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => fields[k])]);
    const gkeys = Object.keys(g);
    await c.query(`UPDATE guardians SET ${gkeys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE family_id=$1`, [id, ...gkeys.map((k) => g[k])]);
    const d1 = audit.diff(before, fields); const d2 = audit.diff(gb, g);
    if (d1.changed || d2.changed) await audit.log(req, 'update', 'family', id, { before: { ...d1.before, guardian: d2.before }, after: { ...d1.after, guardian: d2.after } }, c);
    if (before.calc_method !== f.calc_method || before.monthly_amount !== f.monthly_amount || before.aid_amount !== f.aid_amount) {
      await elig.notify(c, { key: `calc-change:${id}:${Date.now()}`, kind: 'family_amount_review', severity: 'info', family_id: id, link: `/families/${id}`,
        title: `تغيرت الكفالة أو الإعانة لملف ${before.file_no}`, body: 'يسري التغيير على الكشوف الجديدة فقط ولا يعدّل الأشهر السابقة.' });
    }
  });
  flash(req, 'success', 'تم حفظ التعديلات');
  res.redirect(`/families/${id}`);
}));

// تغيير حالة الملف (إيقاف/إغلاق/أرشفة) — لا يحذف أي سجلات
router.post('/families/:id/status', can('families.edit'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const status = U.oneOf(req.body.status, FAMILY_STATUSES, { label: 'الحالة' });
  if (['closed', 'archived'].includes(status) && !req.perms.has('families.archive')) throw new U.UserError('ليست لديك صلاحية إغلاق أو أرشفة الملفات', 403);
  if (status === 'active' && !req.perms.has('eligibility.decide')) throw new U.UserError('تفعيل الملف يتطلب صلاحية اعتماد قرارات الاستحقاق', 403);
  const reason = U.str(req.body.reason, { required: true, max: 500, label: 'سبب تغيير الحالة' });
  await db.tx(async (c) => {
    const b = await c.one('SELECT status FROM families WHERE id=$1 FOR UPDATE', [id]);
    if (!b) throw new U.UserError('الملف غير موجود', 404);
    await c.query('UPDATE families SET status=$2, last_review_on=CURRENT_DATE, updated_at=now() WHERE id=$1', [id, status]);
    await audit.log(req, 'status_change', 'family', id, { before: { status: b.status }, after: { status }, reason }, c);
  });
  flash(req, 'success', 'تم تحديث حالة الملف. السجلات المالية السابقة محفوظة كما هي.');
  res.redirect(`/families/${id}`);
}));

// ---------- الأفراد ----------
function parseMember(b, sens) {
  const m = {
    full_name: U.str(b.full_name, { required: true, max: 150, label: 'الاسم الرباعي' }),
    birth_date: U.date(b.birth_date, { required: true, label: 'تاريخ الميلاد' }),
    gender: U.oneOf(b.gender, ['male', 'female'], { label: 'الجنس' }),
    relation: U.str(b.relation, { required: true, max: 60, label: 'صلة القرابة' }),
    is_orphan: b.is_orphan === '1',
    study_status: U.str(b.study_status, { max: 60 }),
    school_name: U.str(b.school_name, { max: 150 }),
    study_level: U.str(b.study_level, { max: 60 }),
    sponsorship_start: U.date(b.sponsorship_start, { label: 'تاريخ بداية الكفالة' }),
    monthly_amount: U.amount(b.monthly_amount || '0', { allowZero: true, label: 'المبلغ الشهري للفرد' }),
    notes: U.str(b.notes, { max: 1000 }),
  };
  if (m.birth_date > U.todayISO()) throw new U.UserError('تاريخ الميلاد لا يمكن أن يكون في المستقبل');
  if (U.ageOn(m.birth_date) > 120) throw new U.UserError('تاريخ الميلاد غير منطقي');
  if (sens) m.national_id = U.str(b.national_id, { max: 30 });
  return m;
}

router.get('/families/:id/members/new', can('families.edit'), h(async (req, res) => {
  const f = await loadFamily(U.intId(req.params.id));
  res.render('families/member-form', { title: 'إضافة فرد', f, m: { is_orphan: true, sponsorship_start: U.todayISO() }, isNew: true });
}));

router.post('/families/:id/members', can('families.edit'), h(async (req, res) => {
  const fid = U.intId(req.params.id);
  const sens = req.perms.has('families.sensitive');
  const m = parseMember(req.body, sens);
  const canDecide = req.perms.has('eligibility.decide');
  const initial = canDecide ? U.oneOf(req.body.eligibility_status, elig.STATUSES, { def: 'under_review' }) : 'under_review';
  await db.tx(async (c) => {
    const fam = await c.one('SELECT id FROM families WHERE id=$1', [fid]);
    if (!fam) throw new U.UserError('الملف غير موجود', 404);
    const dup = await c.one('SELECT member_no FROM family_members WHERE family_id=$1 AND full_name=$2 AND birth_date=$3', [fid, m.full_name, m.birth_date]);
    if (dup) throw new U.UserError(`هذا الفرد مسجل مسبقًا في الأسرة (${dup.member_no})`);
    const row = await c.one(
      `INSERT INTO family_members (family_id, full_name, birth_date, gender, relation, is_orphan, national_id, study_status, school_name, study_level,
         sponsorship_start, eligibility_status, monthly_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [fid, m.full_name, m.birth_date, m.gender, m.relation, m.is_orphan, m.national_id || null, m.study_status, m.school_name, m.study_level,
        m.sponsorship_start, initial, m.monthly_amount, m.notes, req.user.id]);
    await c.query(`INSERT INTO eligibility_decisions (member_id, old_status, new_status, reason, kind, age_at_decision, decided_by)
                   VALUES ($1,NULL,$2,$3,'initial',$4,$5)`, [row.id, initial, canDecide ? 'الحالة الابتدائية عند التسجيل' : 'تسجيل جديد بانتظار قرار الاستحقاق', U.ageOn(m.birth_date), req.user.id]);
    await audit.log(req, 'create', 'family_member', row.id, { after: row }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تمت إضافة الفرد' + (canDecide ? '' : '، وحالته «قيد المراجعة» حتى يعتمد المسؤول استحقاقه'));
  res.redirect(`/families/${fid}`);
}));

router.get('/members/:mid/edit', can('families.edit'), h(async (req, res) => {
  const m = await db.one('SELECT * FROM family_members WHERE id=$1', [U.intId(req.params.mid)]);
  if (!m) throw new U.UserError('المستفيد غير موجود', 404);
  if (!req.perms.has('families.sensitive')) m.national_id = mask(m.national_id);
  const f = await loadFamily(m.family_id);
  res.render('families/member-form', { title: 'تعديل بيانات فرد', f, m, isNew: false });
}));

router.post('/members/:mid', can('families.edit'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const m = parseMember(req.body, req.perms.has('families.sensitive'));
  let fid;
  await db.tx(async (c) => {
    const b = await c.one('SELECT * FROM family_members WHERE id=$1 FOR UPDATE', [mid]);
    if (!b) throw new U.UserError('المستفيد غير موجود', 404);
    fid = b.family_id;
    const keys = Object.keys(m);
    await c.query(`UPDATE family_members SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [mid, ...keys.map((k) => m[k])]);
    const d = audit.diff(b, m);
    if (d.changed) await audit.log(req, 'update', 'family_member', mid, d, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم حفظ بيانات الفرد');
  res.redirect(`/families/${fid}#m${mid}`);
}));

// قرار استحقاق يدوي
router.post('/members/:mid/decision', can('eligibility.decide'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const status = U.oneOf(req.body.new_status, elig.STATUSES, { label: 'الحالة الجديدة' });
  const reason = U.str(req.body.reason, { required: true, max: 1000, label: 'سبب القرار' });
  const eff = U.date(req.body.effective_from, { label: 'تاريخ السريان' }) || U.todayISO();
  let fid;
  await db.tx(async (c) => {
    const m = await c.one('SELECT family_id FROM family_members WHERE id=$1', [mid]);
    if (!m) throw new U.UserError('المستفيد غير موجود', 404);
    fid = m.family_id;
    const doc = req.body.document_id ? U.intId(req.body.document_id) : null;
    await elig.decide(c, { memberId: mid, newStatus: status, reason, user: req.user, effectiveFrom: eff, documentId: doc, req });
    if (req.body.review_id) {
      const did = (await c.one('SELECT max(id) AS id FROM eligibility_decisions WHERE member_id=$1', [mid])).id;
      await c.query(`UPDATE eligibility_reviews SET status='resolved', resolved_by=$2, resolved_at=now(), decision_id=$3 WHERE id=$1 AND status='open'`,
        [U.intId(req.body.review_id), req.user.id, did]);
    }
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم تسجيل قرار الاستحقاق. يسري على كشوف الاستحقاق الجديدة ولا يغير الأشهر السابقة.');
  res.redirect(req.body.back === 'eligibility' ? '/eligibility?tab=reviews' : `/families/${fid}#m${mid}`);
}));

// تسجيل زواج مستفيدة (ينشئ طلب مراجعة؛ لا إيقاف نهائي دون قرار)
router.post('/members/:mid/marriage', can('families.edit'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const date = U.date(req.body.marriage_date, { required: true, label: 'تاريخ الزواج' });
  let fid;
  await db.tx(async (c) => {
    const m = await c.one('SELECT * FROM family_members WHERE id=$1 FOR UPDATE', [mid]);
    if (!m) throw new U.UserError('المستفيد غير موجود', 404);
    fid = m.family_id;
    const docId = req.body.document_id ? U.intId(req.body.document_id) : null;
    await c.query(`UPDATE family_members SET marital_status='married', marriage_date=$2, updated_at=now() WHERE id=$1`, [mid, date]);
    const open = await c.one(`SELECT id FROM eligibility_reviews WHERE member_id=$1 AND review_type='marriage' AND status='open'`, [mid]);
    if (!open) {
      await c.query(`INSERT INTO eligibility_reviews (member_id, review_type, details, document_id, requested_by) VALUES ($1,'marriage',$2,$3,$4)`,
        [mid, `تاريخ الزواج: ${date}. ${U.str(req.body.details, { max: 500 }) || ''}`, docId, req.user.id]);
    }
    await audit.log(req, 'marriage_registered', 'family_member', mid, { before: { marital_status: m.marital_status }, after: { marital_status: 'married', marriage_date: date } }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم تسجيل الزواج وإنشاء طلب مراجعة. لن يتغير الاستحقاق إلا بقرار معتمد موثق.');
  res.redirect(`/families/${fid}#m${mid}`);
}));

router.get('/members/:mid/history', can('families.view'), h(async (req, res) => {
  const mid = U.intId(req.params.mid);
  const m = await db.one('SELECT m.*, f.file_no FROM family_members m JOIN families f ON f.id=m.family_id WHERE m.id=$1', [mid]);
  if (!m) throw new U.UserError('المستفيد غير موجود', 404);
  m.age = U.ageOn(m.birth_date);
  const decisions = await db.many(`SELECT d.*, u.full_name AS by_name FROM eligibility_decisions d LEFT JOIN users u ON u.id=d.decided_by WHERE member_id=$1 ORDER BY decided_at`, [mid]);
  const changes = await db.many(`SELECT * FROM audit_logs WHERE entity='family_member' AND entity_id=$1 ORDER BY at`, [String(mid)]);
  res.render('families/member-history', { title: `السجل التاريخي — ${m.full_name}`, m, decisions, changes });
}));

module.exports = router;
