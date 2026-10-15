'use strict';
// التسميات العربية لجميع الحالات والقيم المرمزة، مع لون الشارة

const L = {
  familyStatus: {
    active: ['نشط', 'success'], under_review: ['قيد المراجعة', 'warning'], suspended: ['موقوف مؤقتًا', 'danger'],
    closed: ['مغلق', 'muted'], archived: ['مؤرشف', 'muted'],
  },
  supportType: { kafala: ['كفالة', 'success'], aid: ['إعانة', 'info'], both: ['كفالة وإعانة', 'gold'] },
  calcMethod: {
    family_fixed: ['مبلغ ثابت للأسرة كلها', 'info'], per_member: ['مبلغ لكل يتيم', 'info'], mixed: ['مبلغ للأسرة + مبلغ لكل يتيم', 'info'],
  },
  eligibility: {
    eligible: ['مستحق', 'success'], eligible_university: ['مستحق بإثبات جامعي', 'success'],
    reached_review_age: ['بلغ سن المراجعة', 'warning'], awaiting_study_proof: ['بانتظار إثبات الدراسة', 'warning'],
    missing_documents: ['مستندات ناقصة', 'warning'], suspended: ['موقوف مؤقتًا', 'danger'],
    ineligible: ['غير مستحق', 'danger'], ended: ['انتهت الكفالة', 'muted'], under_review: ['قيد المراجعة', 'warning'],
  },
  gender: { male: ['ذكر', 'info'], female: ['أنثى', 'info'] },
  marital: { single: ['أعزب/عزباء', 'muted'], married: ['متزوج/ة', 'info'], divorced: ['مطلق/ة', 'muted'], widowed: ['أرمل/ة', 'muted'] },
  payout: { cash: ['نقدًا', 'muted'], bank_transfer: ['تحويل بنكي', 'muted'], wallet: ['محفظة إلكترونية', 'muted'], cheque: ['شيك', 'muted'], card: ['بطاقة', 'muted'], other: ['أخرى', 'muted'] },
  docType: {
    guardian_id: ['هوية ولي الأمر'], member_id: ['هوية المستفيد'], birth_certificate: ['شهادة الميلاد'],
    orphan_proof: ['إثبات اليُتم'], guardianship: ['مستند الولاية/الوصاية'], university_proof: ['إثبات القيد الجامعي'],
    marriage_proof: ['إثبات الزواج'], bank_document: ['مستند الحساب البنكي'], other_social: ['مستند اجتماعي إضافي'],
    other_financial: ['مستند مالي إضافي'], expense_receipt: ['مستند مصروف'], disbursement_receipt: ['إيصال صرف'],
  },
  docStatus: { pending: ['بانتظار المراجعة', 'warning'], approved: ['معتمد', 'success'], rejected: ['مرفوض', 'danger'], replaced: ['مستبدل', 'muted'] },
  sponsorStatus: { active: ['نشط', 'success'], stopped: ['متوقف', 'danger'], follow_up: ['يحتاج إلى متابعة', 'warning'] },
  sponsorType: { monthly: ['شهرية', 'muted'], quarterly: ['ربع سنوية', 'muted'], annual: ['سنوية', 'muted'], one_time: ['مرة واحدة', 'muted'] },
  linkStatus: { active: ['نشطة', 'success'], ended: ['منتهية', 'muted'], suspended: ['معلقة', 'warning'] },
  pledgeStatus: { unpaid: ['لم يسدد', 'danger'], partial: ['سدد جزئيًا', 'warning'], paid: ['سدد بالكامل', 'success'], late: ['متأخر', 'danger'], review: ['يحتاج إلى مراجعة', 'warning'] },
  donationStatus: { pending: ['مسجل بانتظار التحصيل', 'warning'], collected: ['محصل', 'success'], needs_settlement: ['يحتاج إلى تسوية', 'warning'], reversed: ['ملغى بعملية عكس', 'muted'], cancelled: ['ملغى قبل التحصيل', 'muted'] },
  expenseStatus: { draft: ['مسودة', 'muted'], pending_approval: ['بانتظار الاعتماد', 'warning'], approved: ['معتمد', 'info'], paid: ['مدفوع', 'success'], rejected: ['مرفوض', 'danger'], reversed: ['ملغى بعملية عكس', 'muted'] },
  entStatus: {
    not_paid: ['لم يتم الصرف', 'danger'], preparing: ['قيد التجهيز', 'info'], pending_approval: ['بانتظار الاعتماد', 'warning'],
    partial: ['تم الصرف جزئيًا', 'warning'], paid: ['تم الصرف بالكامل', 'success'], failed: ['متعذر الصرف', 'danger'],
    postponed: ['مؤجل', 'muted'], cancelled: ['ملغى بقرار موثق', 'muted'],
  },
  disbStatus: { pending_approval: ['بانتظار الاعتماد', 'warning'], paid: ['منفذ', 'success'], rejected: ['مرفوض', 'danger'], reversed: ['معكوس', 'muted'] },
  direction: { in: ['وارد', 'success'], out: ['صادر', 'danger'] },
  sourceType: {
    donation: ['تبرع محصل'], donation_reversal: ['عكس تبرع'], expense: ['مصروف مدفوع'], expense_reversal: ['عكس مصروف'],
    disbursement: ['صرف لأسرة'], disbursement_reversal: ['عكس صرف'], adjustment: ['تسوية'], opening: ['رصيد افتتاحي'],
  },
  adjKind: { opening: ['رصيد افتتاحي'], correction: ['تصحيح خطأ'], bank_fee: ['رسوم بنكية'], other: ['أخرى'] },
  reviewType: { marriage: ['تسجيل زواج'], age: ['بلوغ السن'], university_proof: ['إثبات جامعي'], other: ['أخرى'] },
};

function label(group, code) { const g = L[group]; return (g && g[code] && g[code][0]) || code || '—'; }
function tone(group, code) { const g = L[group]; return (g && g[code] && g[code][1]) || 'muted'; }
function options(group) { return Object.entries(L[group]).map(([value, [text]]) => ({ value, text })); }

module.exports = { L, label, tone, options };
