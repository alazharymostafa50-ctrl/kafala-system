'use strict';
// أدوات مشتركة: المبالغ (بالهللة/القرش كأعداد صحيحة)، التواريخ، الفترات المالية

/** تحويل نص/رقم مالي إلى قروش صحيحة. يرفض القيم غير الصالحة. */
function toCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim().replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new UserError('قيمة مالية غير صالحة: ' + v);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const c = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}
function fromCents(c) {
  const neg = c < 0; c = Math.abs(c);
  return (neg ? '-' : '') + Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0');
}
/** عرض المبلغ بتنسيق مقروء */
function fmtMoney(v) {
  const c = toCents(typeof v === 'number' ? v.toFixed(2) : (v ?? 0));
  const neg = c < 0; const a = Math.abs(c);
  const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + int + '.' + String(a % 100).padStart(2, '0');
}

/** خطأ موجه للمستخدم برسالة عربية */
class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; this.userFacing = true; }
}

function todayISO() {
  // تاريخ اليوم وفق المنطقة الزمنية للجمعية
  const tz = process.env.APP_TZ || 'Africa/Cairo';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function currentPeriod() { return todayISO().slice(0, 7); }

/** العمر بالسنوات الكاملة في تاريخ مرجعي */
function ageOn(birthISO, refISO = todayISO()) {
  if (!birthISO) return null;
  const [by, bm, bd] = birthISO.split('-').map(Number);
  const [ry, rm, rd] = refISO.split('-').map(Number);
  let a = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) a--;
  return a;
}
/** تاريخ بلوغ عمر معين (يعالج 29 فبراير) */
function dateAtAge(birthISO, years) {
  const [by, bm, bd] = birthISO.split('-').map(Number);
  const y = by + years;
  const last = new Date(Date.UTC(y, bm, 0)).getUTCDate();
  return `${y}-${String(bm).padStart(2, '0')}-${String(Math.min(bd, last)).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
function periodStart(p) { return p + '-01'; }
function periodEnd(p) {
  const [y, m] = p.split('-').map(Number);
  return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function validPeriod(p) { return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p); }
function prevPeriod(p) { return addMonths(p + '-01', -1).slice(0, 7); }
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function periodLabel(p) { if (!validPeriod(p)) return p; const [y, m] = p.split('-'); return `${MONTHS_AR[Number(m) - 1]} ${y}`; }

/** تنظيف وإلزام الحقول النصية */
function str(v, { max = 500, required = false, label = 'الحقل' } = {}) {
  const s = (v ?? '').toString().trim();
  if (required && !s) throw new UserError(`${label} مطلوب`);
  if (s.length > max) throw new UserError(`${label} أطول من المسموح (${max} حرفًا)`);
  return s || null;
}
function phone(v, { required = false, label = 'رقم الجوال' } = {}) {
  const s = (v ?? '').toString().replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s-]/g, '');
  if (!s) { if (required) throw new UserError(`${label} مطلوب`); return null; }
  if (!/^\+?\d{7,15}$/.test(s)) throw new UserError(`${label} غير صالح`);
  return s;
}
function date(v, { required = false, label = 'التاريخ' } = {}) {
  const s = (v ?? '').toString().trim();
  if (!s) { if (required) throw new UserError(`${label} مطلوب`); return null; }
  if (!validDate(s)) throw new UserError(`${label} غير صالح`);
  return s;
}
function oneOf(v, list, { label = 'القيمة', required = true, def } = {}) {
  const s = (v ?? '').toString().trim();
  if (!s) { if (def !== undefined) return def; if (required) throw new UserError(`${label} مطلوب`); return null; }
  if (!list.includes(s)) throw new UserError(`${label} غير صالح`);
  return s;
}
function intId(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new UserError('معرّف غير صالح', 404); return n; }
function amount(v, { label = 'المبلغ', allowZero = false } = {}) {
  const c = toCents(v);
  if (c < 0 || (!allowZero && c === 0)) throw new UserError(`${label} يجب أن يكون أكبر من صفر`);
  if (c > 99999999999) throw new UserError(`${label} كبير جدًا`);
  return fromCents(c);
}

module.exports = {
  toCents, fromCents, fmtMoney, UserError, todayISO, currentPeriod, ageOn, dateAtAge, addDays, addMonths,
  periodStart, periodEnd, validPeriod, prevPeriod, validDate, periodLabel, MONTHS_AR, str, phone, date, oneOf, intId, amount,
};
