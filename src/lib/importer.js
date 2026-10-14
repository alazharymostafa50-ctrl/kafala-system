'use strict';
// استيراد الأسر والأفراد والكفلاء من Excel/CSV مع التحقق صفًا بصف
const ExcelJS = require('exceljs');
const U = require('./util');

const CALC = { 'ثابت': 'family_fixed', 'مبلغ ثابت للأسرة': 'family_fixed', 'family_fixed': 'family_fixed', 'لكل مستفيد': 'per_member', 'per_member': 'per_member', 'مختلط': 'mixed', 'mixed': 'mixed' };
const GENDER = { 'ذكر': 'male', 'male': 'male', 'm': 'male', 'أنثى': 'female', 'انثى': 'female', 'female': 'female', 'f': 'female' };
const YES = ['نعم', 'yes', '1', 'true', 'y'];

const FIELDS = {
  families: [
    { key: 'family_name', label: 'اسم الأسرة', required: true, aliases: ['الأسرة', 'اسم الاسرة'] },
    { key: 'guardian_name', label: 'اسم ولي الأمر', required: true, aliases: ['ولي الأمر', 'اسم ولي الامر'] },
    { key: 'guardian_phone', label: 'جوال ولي الأمر', required: true, aliases: ['الجوال', 'رقم الجوال', 'الهاتف'] },
    { key: 'guardian_phone_alt', label: 'جوال بديل', aliases: ['جوال آخر'] },
    { key: 'guardian_relation', label: 'صلة ولي الأمر', aliases: ['صلة القرابة'] },
    { key: 'city', label: 'المدينة' }, { key: 'district', label: 'المنطقة', aliases: ['الحي'] }, { key: 'address', label: 'العنوان' },
    { key: 'calc_method', label: 'طريقة الاحتساب', aliases: ['طريقة احتساب الكفالة'] },
    { key: 'monthly_amount', label: 'قيمة الكفالة الشهرية', aliases: ['المبلغ الشهري'] },
    { key: 'opened_on', label: 'تاريخ فتح الملف' },
  ],
  members: [
    { key: 'family_file_no', label: 'رقم ملف الأسرة', aliases: ['رقم الملف'] },
    { key: 'guardian_phone', label: 'جوال ولي الأمر', aliases: ['الجوال'] },
    { key: 'full_name', label: 'الاسم الرباعي', required: true, aliases: ['الاسم'] },
    { key: 'birth_date', label: 'تاريخ الميلاد', required: true },
    { key: 'gender', label: 'الجنس', required: true },
    { key: 'relation', label: 'صلة القرابة', required: true, aliases: ['الصلة'] },
    { key: 'is_orphan', label: 'يتيم (نعم/لا)', aliases: ['يتيم'] },
    { key: 'study_status', label: 'الحالة الدراسية' }, { key: 'school_name', label: 'المدرسة أو الجامعة' }, { key: 'study_level', label: 'المرحلة الدراسية' },
    { key: 'monthly_amount', label: 'المبلغ الشهري للفرد' },
  ],
  sponsors: [
    { key: 'full_name', label: 'اسم الكفيل', required: true, aliases: ['الاسم'] },
    { key: 'phone', label: 'الجوال', required: true, aliases: ['رقم الجوال'] },
    { key: 'phone_alt', label: 'جوال بديل' },
    { key: 'monthly_pledge', label: 'المبلغ الشهري المتعهد به', aliases: ['التعهد الشهري'] },
    { key: 'start_date', label: 'تاريخ البداية' },
    { key: 'family_file_no', label: 'رقم ملف الأسرة المكفولة' },
    { key: 'link_amount', label: 'المبلغ المخصص للأسرة' },
  ],
};
const TYPE_LABEL = { families: 'الأسر وأولياء الأمور', members: 'أفراد الأسر', sponsors: 'الكفلاء' };

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') { if (v.text) return String(v.text); if (v.result !== undefined) return cellValue(v.result); if (v.richText) return v.richText.map((t) => t.text).join(''); }
  return String(v).trim();
}

async function parseFile(file) {
  const wb = new ExcelJS.Workbook();
  const name = (file.originalname || '').toLowerCase();
  let ws;
  if (name.endsWith('.csv')) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    // محلل CSV نصي يحافظ على القيم كما هي (مثل الأصفار في بداية أرقام الجوال)
    const first = text.split(/\r?\n/)[0];
    const rows = parseCsv(text, first.includes(';') && !first.includes(',') ? ';' : ',').filter((r) => r.some((v) => v.trim() !== ''));
    if (rows.length < 2) throw new U.UserError('الملف لا يحتوي على صفوف بيانات بعد صف العناوين');
    if (rows.length > 5001) throw new U.UserError('الحد الأقصى 5000 صف في الدفعة الواحدة');
    return { headers: rows[0].map((h, i) => h.trim() || `عمود ${i + 1}`), rows: rows.slice(1).map((r) => r.map((v) => v.trim())) };
  } else if (name.endsWith('.xlsx')) {
    if (file.buffer.slice(0, 2).toString('latin1') !== 'PK') throw new U.UserError('ملف Excel غير صالح');
    await wb.xlsx.load(file.buffer);
    ws = wb.worksheets[0];
  } else throw new U.UserError('الصيغ المسموحة: xlsx أو csv');
  if (!ws) throw new U.UserError('الملف لا يحتوي على بيانات');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => { rows.push(row.values.slice(1).map(cellValue)); });
  if (rows.length < 2) throw new U.UserError('الملف لا يحتوي على صفوف بيانات بعد صف العناوين');
  if (rows.length > 5001) throw new U.UserError('الحد الأقصى 5000 صف في الدفعة الواحدة');
  const headers = rows[0].map((h, i) => h || `عمود ${i + 1}`);
  const data = rows.slice(1).filter((r) => r.some((v) => v !== ''));
  return { headers, rows: data };
}

function parseCsv(text, sep) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function autoMap(type, headers) {
  const norm = (s) => String(s).replace(/[*\s]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').toLowerCase();
  const map = {};
  for (const f of FIELDS[type]) {
    const names = [f.label, f.key, ...(f.aliases || [])].map(norm);
    const idx = headers.findIndex((h) => names.includes(norm(h)));
    map[f.key] = idx >= 0 ? idx : '';
  }
  return map;
}

/** التحقق من صف وإرجاع القيم المنظفة أو قائمة الأخطاء */
function validateRow(type, raw) {
  const errors = []; const v = {};
  const get = (k) => (raw[k] ?? '').toString().trim();
  const tryF = (fn, label) => { try { return fn(); } catch (e) { errors.push(e.userFacing ? e.message : `${label}: قيمة غير صالحة`); return null; } };
  const dateOf = (s, label, req) => {
    if (!s) { if (req) errors.push(`${label} مطلوب`); return null; }
    let iso = s;
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!U.validDate(iso)) { errors.push(`${label} غير صالح (استخدم YYYY-MM-DD أو DD/MM/YYYY)`); return null; }
    return iso;
  };
  for (const f of FIELDS[type]) if (f.required && !get(f.key)) errors.push(`${f.label} مطلوب`);
  if (type === 'families') {
    v.family_name = get('family_name'); v.guardian_name = get('guardian_name');
    v.guardian_phone = tryF(() => U.phone(get('guardian_phone'), { required: true, label: 'جوال ولي الأمر' }), 'الجوال');
    v.guardian_phone_alt = tryF(() => U.phone(get('guardian_phone_alt'), { label: 'الجوال البديل' }), 'الجوال البديل');
    v.guardian_relation = get('guardian_relation') || null; v.city = get('city') || null; v.district = get('district') || null; v.address = get('address') || null;
    const cm = get('calc_method'); v.calc_method = cm ? CALC[cm] : 'family_fixed';
    if (!v.calc_method) errors.push('طريقة الاحتساب غير معروفة (ثابت / لكل مستفيد / مختلط)');
    v.monthly_amount = tryF(() => U.amount(get('monthly_amount') || '0', { allowZero: true, label: 'قيمة الكفالة' }), 'المبلغ');
    v.opened_on = dateOf(get('opened_on'), 'تاريخ فتح الملف', false) || U.todayISO();
  } else if (type === 'members') {
    v.family_file_no = get('family_file_no') || null;
    v.guardian_phone = tryF(() => U.phone(get('guardian_phone')), 'جوال ولي الأمر');
    if (!v.family_file_no && !v.guardian_phone) errors.push('حدد رقم ملف الأسرة أو جوال ولي الأمر لربط الفرد بأسرته');
    v.full_name = get('full_name'); v.relation = get('relation');
    v.birth_date = dateOf(get('birth_date'), 'تاريخ الميلاد', true);
    if (v.birth_date && v.birth_date > U.todayISO()) errors.push('تاريخ الميلاد في المستقبل');
    v.gender = GENDER[get('gender').toLowerCase()] || null; if (get('gender') && !v.gender) errors.push('الجنس يجب أن يكون ذكر أو أنثى');
    v.is_orphan = get('is_orphan') ? YES.includes(get('is_orphan').toLowerCase()) : true;
    v.study_status = get('study_status') || null; v.school_name = get('school_name') || null; v.study_level = get('study_level') || null;
    v.monthly_amount = tryF(() => U.amount(get('monthly_amount') || '0', { allowZero: true, label: 'المبلغ الشهري للفرد' }), 'المبلغ');
  } else {
    v.full_name = get('full_name');
    v.phone = tryF(() => U.phone(get('phone'), { required: true }), 'الجوال');
    v.phone_alt = tryF(() => U.phone(get('phone_alt'), { label: 'الجوال البديل' }), 'الجوال البديل');
    v.monthly_pledge = tryF(() => U.amount(get('monthly_pledge') || '0', { allowZero: true, label: 'التعهد الشهري' }), 'التعهد');
    v.start_date = dateOf(get('start_date'), 'تاريخ البداية', false);
    v.family_file_no = get('family_file_no') || null;
    v.link_amount = v.family_file_no ? tryF(() => U.amount(get('link_amount') || v.monthly_pledge || '0', { allowZero: true, label: 'المبلغ المخصص' }), 'المبلغ المخصص') : null;
  }
  return { values: v, errors };
}

function applyMapping(row, mapping) {
  const raw = {};
  for (const [k, idx] of Object.entries(mapping)) raw[k] = idx === '' || idx === null || idx === undefined ? '' : row[Number(idx)];
  return raw;
}

/** التحقق الكامل مع اكتشاف التكرار داخل الملف وفي قاعدة البيانات */
async function validateBatch(c, type, rows, mapping) {
  const results = []; const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const { values, errors } = validateRow(type, applyMapping(rows[i], mapping));
    const warnings = [];
    let key = null;
    if (type === 'families' && values.guardian_phone) {
      key = 'p:' + values.guardian_phone;
      const ex = await c.one('SELECT f.file_no FROM guardians g JOIN families f ON f.id=g.family_id WHERE g.phone=$1 OR g.phone_alt=$1 LIMIT 1', [values.guardian_phone]);
      if (ex) errors.push(`تكرار محتمل: يوجد ملف ${ex.file_no} بنفس جوال ولي الأمر`);
    }
    if (type === 'members' && !errors.length) {
      const fam = values.family_file_no
        ? await c.one('SELECT id, file_no FROM families WHERE file_no=$1', [values.family_file_no])
        : await c.one('SELECT f.id, f.file_no FROM guardians g JOIN families f ON f.id=g.family_id WHERE g.phone=$1 LIMIT 1', [values.guardian_phone]);
      if (!fam) errors.push('لم يتم العثور على الأسرة'); else {
        values.family_id = fam.id; values.file_no = fam.file_no;
        key = `m:${fam.id}:${values.full_name}:${values.birth_date}`;
        if (await c.one('SELECT 1 FROM family_members WHERE family_id=$1 AND full_name=$2 AND birth_date=$3', [fam.id, values.full_name, values.birth_date])) errors.push('الفرد مسجل مسبقًا في هذه الأسرة');
      }
    }
    if (type === 'sponsors' && values.phone) {
      key = 's:' + values.phone;
      const ex = await c.one('SELECT sponsor_no FROM sponsors WHERE phone=$1', [values.phone]);
      if (ex) errors.push(`تكرار محتمل: الكفيل ${ex.sponsor_no} مسجل بنفس الجوال`);
      if (values.family_file_no) {
        const fam = await c.one('SELECT id FROM families WHERE file_no=$1', [values.family_file_no]);
        if (!fam) errors.push('ملف الأسرة المكفولة غير موجود'); else values.family_id = fam.id;
      }
    }
    if (key) { if (seen.has(key)) errors.push(`مكرر داخل الملف مع الصف ${seen.get(key)}`); else seen.set(key, i + 2); }
    results.push({ row: i + 2, values, errors, warnings });
  }
  return results;
}

async function templateXlsx(type) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(TYPE_LABEL[type], { views: [{ rightToLeft: true }] });
  const h = ws.addRow(FIELDS[type].map((f) => f.label + (f.required ? ' *' : '')));
  h.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF054834' } }; });
  FIELDS[type].forEach((f, i) => {
    const col = ws.getColumn(i + 1); col.width = 22;
    // أعمدة الجوال والتواريخ والأرقام المرجعية نصية حتى لا يحذف Excel الأصفار
    if (/phone|file_no|date|opened_on/.test(f.key)) col.numFmt = '@';
  });
  const notes = wb.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  [['الحقول المعلّمة * إلزامية.'], ['التواريخ بصيغة YYYY-MM-DD أو DD/MM/YYYY.'], ['طريقة الاحتساب: ثابت / لكل مستفيد / مختلط.'], ['الجنس: ذكر / أنثى. يتيم: نعم / لا.'],
    ['لربط الأفراد بأسرهم: رقم ملف الأسرة (مثل F-1001) أو جوال ولي الأمر.'], ['لا تستخدم بيانات حقيقية في بيئة التجربة.']].forEach((r) => notes.addRow(r));
  notes.getColumn(1).width = 80;
  return wb.xlsx.writeBuffer();
}

module.exports = { FIELDS, TYPE_LABEL, parseFile, autoMap, validateBatch, applyMapping, templateXlsx };
