'use strict';
const router = require('express').Router();
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const imp = require('../lib/importer');
const elig = require('../lib/eligibility');
const { memoryUpload } = require('../lib/uploads');
const { h, can, flash } = require('../middleware');

const TYPES = ['families', 'members', 'sponsors'];
const typeGuard = (req, type) => {
  if (!TYPES.includes(type)) throw new U.UserError('نوع الاستيراد غير صالح');
  if (type === 'sponsors' && !req.perms.has('sponsors.edit')) throw new U.UserError('استيراد الكفلاء يتطلب صلاحية تعديل الكفلاء', 403);
  if (type !== 'sponsors' && !req.perms.has('families.edit')) throw new U.UserError('استيراد الأسر والأفراد يتطلب صلاحية تعديل الأسر', 403);
};

router.get('/import', can('import.run'), h(async (req, res) => {
  const batches = await db.many(`SELECT b.id, b.import_type, b.file_name, b.status, b.created_at, b.result, jsonb_array_length(b.rows) AS n, u.full_name
    FROM import_batches b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.id DESC LIMIT 30`);
  res.render('imports/index', { title: 'استيراد البيانات', batches, labels: imp.TYPE_LABEL });
}));

router.get('/import/template/:type.xlsx', can('import.run'), h(async (req, res) => {
  if (!TYPES.includes(req.params.type)) throw new U.UserError('نوع غير صالح', 404);
  const buf = await imp.templateXlsx(req.params.type);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', `attachment; filename="template-${req.params.type}.xlsx"`).send(Buffer.from(buf));
}));

router.post('/import', can('import.run'), memoryUpload(10).single('file'), h(async (req, res) => {
  const type = req.body.import_type; typeGuard(req, type);
  if (!req.file) throw new U.UserError('اختر ملفًا');
  const { headers, rows } = await imp.parseFile(req.file);
  const mapping = imp.autoMap(type, headers);
  const b = await db.one(`INSERT INTO import_batches (import_type, file_name, headers, rows, mapping, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [type, String(req.file.originalname).slice(0, 200), JSON.stringify(headers), JSON.stringify(rows), JSON.stringify(mapping), req.user.id]);
  await audit.log(req, 'import_uploaded', 'import_batch', b.id, { after: { type, rows: rows.length } });
  res.redirect(`/import/${b.id}`);
}));

router.get('/import/:id(\\d+)', can('import.run'), h(async (req, res) => {
  const b = await db.one('SELECT * FROM import_batches WHERE id=$1', [U.intId(req.params.id)]);
  if (!b) throw new U.UserError('الدفعة غير موجودة', 404);
  typeGuard(req, b.import_type);
  const results = b.status === 'uploaded' ? await imp.validateBatch(db, b.import_type, b.rows, b.mapping) : null;
  res.render('imports/batch', { title: 'معاينة الاستيراد', b, fields: imp.FIELDS[b.import_type], results, label: imp.TYPE_LABEL[b.import_type] });
}));

router.post('/import/:id(\\d+)/mapping', can('import.run'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const b = await db.one(`SELECT * FROM import_batches WHERE id=$1 AND status='uploaded'`, [id]);
  if (!b) throw new U.UserError('الدفعة غير متاحة', 404);
  typeGuard(req, b.import_type);
  const mapping = {};
  for (const f of imp.FIELDS[b.import_type]) {
    const v = req.body['map_' + f.key];
    mapping[f.key] = v === '' || v === undefined ? '' : Math.min(Math.max(0, Number(v)), b.headers.length - 1);
  }
  await db.query('UPDATE import_batches SET mapping=$2 WHERE id=$1', [id, JSON.stringify(mapping)]);
  flash(req, 'success', 'تم تحديث مطابقة الأعمدة وإعادة التحقق');
  res.redirect(`/import/${id}`);
}));

router.post('/import/:id(\\d+)/cancel', can('import.run'), h(async (req, res) => {
  await db.query(`UPDATE import_batches SET status='cancelled', completed_at=now() WHERE id=$1 AND status='uploaded'`, [U.intId(req.params.id)]);
  res.redirect('/import');
}));

router.post('/import/:id(\\d+)/commit', can('import.run'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const approveEligible = req.body.approve_eligible === '1' && req.perms.has('eligibility.decide');
  const summary = await db.tx(async (c) => {
    const b = await c.one(`SELECT * FROM import_batches WHERE id=$1 AND status='uploaded' FOR UPDATE`, [id]);
    if (!b) throw new U.UserError('الدفعة غير متاحة أو تم استيرادها مسبقًا');
    typeGuard(req, b.import_type);
    const results = await imp.validateBatch(c, b.import_type, b.rows, b.mapping);
    const imported = []; const failed = [];
    for (const r of results) {
      if (r.errors.length) { failed.push({ row: r.row, errors: r.errors }); continue; }
      const v = r.values;
      if (b.import_type === 'families') {
        const f = await c.one(`INSERT INTO families (family_name, opened_on, status, city, district, address, calc_method, monthly_amount, created_by)
          VALUES ($1,$2,'under_review',$3,$4,$5,$6,$7,$8) RETURNING id, file_no`, [v.family_name, v.opened_on, v.city, v.district, v.address, v.calc_method, v.monthly_amount, req.user.id]);
        await c.query('INSERT INTO guardians (family_id, full_name, relation, phone, phone_alt) VALUES ($1,$2,$3,$4,$5)', [f.id, v.guardian_name, v.guardian_relation, v.guardian_phone, v.guardian_phone_alt]);
        imported.push({ row: r.row, ref: f.file_no });
      } else if (b.import_type === 'members') {
        const st = approveEligible ? 'eligible' : 'under_review';
        const m = await c.one(`INSERT INTO family_members (family_id, full_name, birth_date, gender, relation, is_orphan, study_status, school_name, study_level, eligibility_status, monthly_amount, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, member_no`, [v.family_id, v.full_name, v.birth_date, v.gender, v.relation, v.is_orphan, v.study_status, v.school_name, v.study_level, st, v.monthly_amount, req.user.id]);
        await c.query(`INSERT INTO eligibility_decisions (member_id, new_status, reason, kind, age_at_decision, decided_by) VALUES ($1,$2,$3,'initial',$4,$5)`,
          [m.id, st, `استيراد من ملف (الدفعة ${id})` + (approveEligible ? ' — اعتماد المستورد' : ''), U.ageOn(v.birth_date), req.user.id]);
        imported.push({ row: r.row, ref: m.member_no });
      } else {
        const s = await c.one(`INSERT INTO sponsors (full_name, phone, phone_alt, monthly_pledge, start_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, sponsor_no`,
          [v.full_name, v.phone, v.phone_alt, v.monthly_pledge, v.start_date, req.user.id]);
        if (v.family_id) await c.query('INSERT INTO family_sponsorships (sponsor_id, family_id, monthly_amount, start_date, created_by) VALUES ($1,$2,$3,$4,$5)', [s.id, v.family_id, v.link_amount, v.start_date || U.todayISO(), req.user.id]);
        imported.push({ row: r.row, ref: s.sponsor_no });
      }
    }
    const result = { imported: imported.length, failed: failed.length, imported_refs: imported, failures: failed };
    await c.query(`UPDATE import_batches SET status='completed', result=$2, completed_at=now() WHERE id=$1`, [id, JSON.stringify(result)]);
    await audit.log(req, 'import_completed', 'import_batch', id, { after: { type: b.import_type, imported: imported.length, failed: failed.length, approve_eligible: approveEligible } }, c);
    return result;
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, summary.failed ? 'warning' : 'success', `تم استيراد ${summary.imported} سجل. ${summary.failed ? `لم يُستورد ${summary.failed} صف بسبب أخطاء (انظر التقرير أدناه).` : ''}`);
  res.redirect(`/import/${id}`);
}));

module.exports = router;
