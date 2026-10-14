'use strict';
// كتابة المبالغ بالحروف العربية (التفقيط) للإيصالات: «فقط ... لا غير»
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const TEENS = ['عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function below1000(n) {
  const h = Math.floor(n / 100); const r = n % 100;
  const parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 10) parts.push(ONES[r]);
    else if (r < 20) parts.push(TEENS[r - 10]);
    else { const o = r % 10; const t = Math.floor(r / 10); parts.push(o ? `${ONES[o]} و${TENS[t]}` : TENS[t]); }
  }
  return parts.join(' و');
}

function scale(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${below1000(n)} ${few}`;
  return `${below1000(n)} ${many}`;
}

function intToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'صفر';
  const parts = [];
  const millions = Math.floor(n / 1e6); const thousands = Math.floor((n % 1e6) / 1000); const rest = n % 1000;
  if (millions) parts.push(scale(millions, ['مليون', 'مليونان', 'ملايين', 'مليونًا']));
  if (thousands) parts.push(scale(thousands, ['ألف', 'ألفان', 'آلاف', 'ألفًا']));
  if (rest) parts.push(below1000(rest));
  return parts.join(' و');
}

/** مبلغ بالقروش → «فقط ... جنيه و... قرشًا لا غير» */
/** اسم العملة المناسب للتفقيط حسب رمز العملة في الإعدادات */
function currencyWords(code = '') {
  if (/ر\.?س|ريال|SAR/i.test(code)) return ['ريالًا', 'هللة'];
  if (/د\.?ك|دينار/i.test(code)) return ['دينارًا', 'فلسًا'];
  return ['جنيهًا', 'قرشًا'];
}

function amountWords(cents, unit = 'جنيهًا', subunit = 'قرشًا') {
  const whole = Math.floor(cents / 100); const frac = cents % 100;
  let s = `فقط ${intToWords(whole)} ${unit}`;
  if (frac) s += ` و${intToWords(frac)} ${subunit}`;
  return s + ' لا غير';
}

module.exports = { intToWords, amountWords, currencyWords };
