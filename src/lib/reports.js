'use strict';
/**
 * بناء التقارير الشهرية من السجلات الفعلية.
 * كل تقرير يُرجع بنية موحدة تُستخدم في العرض والطباعة وPDF وExcel وCSV:
 * { type, title, period, level, sections: [kv | table], summary, sourceRefs }
 * لا يتضمن أي تقرير أرقام الهويات أو الحسابات البنكية.
 */
const db = require('../db');
const U = require('./util');
const finance = require('./finance');
const stats = require('./stats');
const settings = require('./settings');
const { label } = require('./labels');
const meta = require('./reports-meta');

const M = (c) => ({ money: true, cents: c });
const kv = (title, items, note) => ({ kind: 'kv', title, items, note });
const table = (title, columns, rows, totals, note) => ({ kind: 'table', title, columns, rows, totals, note });

async function financial(period, level) {
  const sum = await finance.periodSummary(db, period);
  const don = await stats.donationBreakdown(db, period);
  const ent = await stats.entitlementTotals(db, period);
  const exp = await stats.expensesPaid(db, period);
  const unpaidAll = await stats.unpaidObligations(db, period);
  const ln = sum.lines;
  const sections = [
    kv('الملخص المالي', [
      { label: 'الرصيد الافتتاحي (بداية الشهر)', ...M(sum.totals.opening), formula: 'مجموع (الوارد − الصادر) لكل القيود قبل بداية الشهر' },
      { label: 'إجمالي التبرعات المحصلة (صافي)', ...M(don.total), formula: 'قيود تحصيل التبرعات − قيود عكسها خلال الشهر؛ كل تبرع مرة واحدة' },
      { label: '— منها مساهمات الكفلاء المحصلة', ...M(don.sponsor), formula: 'جزء من الإجمالي أعلاه وليست إضافة عليه' },
      { label: '— منها التبرعات العامة', ...M(don.general), formula: 'تبرعات الصندوق العام' },
      { label: '— منها التبرعات المخصصة (مقيدة)', ...M(don.restricted), formula: 'تبرعات كفالة الأيتام والمخصصة لأسر معينة' },
      { label: 'إجمالي المصروفات المدفوعة', ...M(exp), formula: 'قيود دفع المصروفات − عكسها خلال الشهر' },
      { label: 'إجمالي مستحقات الكفالات للشهر', ...M(ent.due), formula: `مجموع كشف الاستحقاق (${ent.families} أسرة)، باستثناء الملغى بقرار` },
      { label: 'إجمالي المبالغ المصروفة للأسر (لهذا الشهر)', ...M(ent.paid), formula: 'مجموع المصروف على سجلات استحقاق الشهر' },
      { label: 'المستحقات غير المدفوعة لهذا الشهر', ...M(ent.remaining), formula: 'المستحق − المصروف (التزام وليس صرفًا)' },
      { label: 'المتبقي من عمليات الصرف الجزئي', ...M(ent.partialRemaining), formula: `للأسر التي استلمت جزئيًا (${ent.partial} أسرة)` },
      { label: 'إجمالي الالتزامات غير المدفوعة حتى نهاية الشهر', ...M(unpaidAll), formula: 'كل الأشهر حتى هذا الشهر' },
      { label: 'الأموال المقيدة (نهاية الشهر)', ...M(sum.restrictedClosing), formula: 'رصيد صندوق كفالة الأيتام' },
      { label: 'الرصيد الختامي وفق السجلات المالية', ...M(sum.totals.closing), formula: 'الافتتاحي + الوارد − الصادر', strong: true },
    ]),
    kv('حركة الصرف للأسر خلال الشهر (حسب تاريخ الصرف)', [
      { label: 'صرف للأسر (كل الأشهر)', ...M(ln.disbursedOut) },
      { label: 'عكس عمليات صرف', ...M(ln.disbursementReversals) },
      { label: 'تسويات واردة / أرصدة افتتاحية', ...M(ln.adjustmentsIn) },
      { label: 'تسويات صادرة', ...M(ln.adjustmentsOut) },
    ], 'قد يختلف «المصروف لهذا الشهر» عن «الصرف خلال الشهر» إذا صُرفت مستحقات أشهر سابقة.'),
    table('الأرصدة حسب الصندوق', [
      { key: 'name', label: 'الصندوق' }, { key: 'opening', label: 'الافتتاحي', money: true }, { key: 'in', label: 'الوارد', money: true },
      { key: 'out', label: 'الصادر', money: true }, { key: 'closing', label: 'الختامي', money: true }],
    sum.funds.map((f) => ({ name: f.name + (f.restricted ? ' (مقيد)' : ''), opening: f.opening, in: f.in, out: f.out, closing: f.closing })),
    { name: 'الإجمالي', opening: sum.totals.opening, in: sum.totals.in, out: sum.totals.out, closing: sum.totals.closing }),
  ];
  let ledgerCount = 0;
  if (level === 'detailed') {
    const rows = await db.many(`SELECT l.*, f.name AS fund_name FROM ledger_entries l JOIN funds f ON f.code=l.fund_code WHERE l.period=$1 ORDER BY l.entry_date, l.id`, [period]);
    ledgerCount = rows.length;
    const tin = rows.filter((r) => r.direction === 'in').reduce((a, r) => a + U.toCents(r.amount), 0);
    const tout = rows.filter((r) => r.direction === 'out').reduce((a, r) => a + U.toCents(r.amount), 0);
    sections.push(table('تفصيل القيود المالية للشهر', [
      { key: 'id', label: '#' }, { key: 'date', label: 'التاريخ' }, { key: 'fund', label: 'الصندوق' }, { key: 'type', label: 'النوع' },
      { key: 'desc', label: 'البيان' }, { key: 'in', label: 'وارد', money: true }, { key: 'out', label: 'صادر', money: true }],
    rows.map((r) => ({ id: r.id, date: r.entry_date, fund: r.fund_name, type: label('sourceType', r.source_type), desc: r.description,
      in: r.direction === 'in' ? U.toCents(r.amount) : null, out: r.direction === 'out' ? U.toCents(r.amount) : null })),
    { id: '', date: '', fund: '', type: '', desc: 'الإجمالي', in: tin, out: tout }));
  }
  const summary = {
    opening: sum.totals.opening, donations: don.total, sponsor: don.sponsor, general: don.general, restricted_donations: don.restricted,
    expenses: exp, due: ent.due, paid: ent.paid, unpaid: ent.remaining, partial_remaining: ent.partialRemaining, unpaid_all: unpaidAll,
    restricted_funds: sum.restrictedClosing, closing: sum.totals.closing,
  };
  return { sections, summary, extra: { ledgerCount } };
}

async function sponsors(period, level) {
  const rows = await db.many(
    `SELECT s.id, s.sponsor_no, s.full_name, s.phone, s.status,
       sc.pledged_amount::text AS pledged, sc.needs_review,
       COALESCE((SELECT SUM(d.amount) FROM donations d WHERE d.contribution_id=sc.id AND d.status='collected'),0)::text AS collected,
       (SELECT max(l.entry_date) FROM donations d JOIN ledger_entries l ON l.source_type='donation' AND l.source_id=d.id WHERE d.sponsor_id=s.id AND d.status='collected' AND l.entry_date <= $2) AS last_collected,
       (SELECT string_agg(f.file_no, '، ' ORDER BY f.file_no) FROM family_sponsorships fs JOIN families f ON f.id=fs.family_id
         WHERE fs.sponsor_id=s.id AND fs.start_date <= $2 AND (fs.end_date IS NULL OR fs.end_date >= $3)) AS families
     FROM sponsors s LEFT JOIN sponsor_contributions sc ON sc.sponsor_id=s.id AND sc.period=$1
     WHERE sc.id IS NOT NULL OR s.status <> 'stopped'
     ORDER BY s.sponsor_no`, [period, U.periodEnd(period), U.periodStart(period)]);
  const pledgeStatus = require('../routes/sponsors').pledgeStatus;
  let tp = 0; let tc = 0; let tr = 0; const counts = {};
  const out = rows.map((r) => {
    const p = U.toCents(r.pledged || 0); const c = U.toCents(r.collected); const rem = Math.max(0, p - c);
    tp += p; tc += c; tr += rem;
    const st = r.pledged == null ? null : pledgeStatus({ pledged_amount: r.pledged, collected: r.collected, period, needs_review: r.needs_review });
    if (st) counts[st] = (counts[st] || 0) + 1;
    return { no: r.sponsor_no, name: r.full_name, phone: r.phone, families: r.families || '—', pledged: p, collected: c, remaining: rem,
      status: st ? label('pledgeStatus', st) : 'لا يوجد تعهد مسجل', last: r.last_collected || '—' };
  });
  const sections = [
    kv('الإجماليات', [
      { label: 'عدد الكفلاء في التقرير', text: String(out.length) },
      { label: 'إجمالي المبالغ المتعهد بها للشهر', ...M(tp), formula: 'التعهد ليس مبلغًا محصلًا' },
      { label: 'إجمالي المحصل فعليًا', ...M(tc), formula: 'مساهمات الكفلاء المؤكد تحصيلها والمرتبطة بتعهد الشهر' },
      { label: 'إجمالي المتبقي', ...M(tr) },
      ...Object.entries(counts).map(([k, v]) => ({ label: 'عدد: ' + label('pledgeStatus', k), text: String(v) })),
    ]),
  ];
  if (level === 'detailed') {
    sections.push(table('تفصيل الكفلاء', [
      { key: 'no', label: 'رقم الكفيل' }, { key: 'name', label: 'الاسم' }, { key: 'phone', label: 'الجوال', ltr: true }, { key: 'families', label: 'الأسر المرتبطة' },
      { key: 'pledged', label: 'المتعهد به', money: true }, { key: 'collected', label: 'المحصل', money: true }, { key: 'remaining', label: 'المتبقي', money: true },
      { key: 'status', label: 'حالة السداد' }, { key: 'last', label: 'آخر تحصيل' }],
    out, { no: '', name: 'الإجمالي', phone: '', families: '', pledged: tp, collected: tc, remaining: tr, status: '', last: '' }));
  }
  return { sections, summary: { sponsors: out.length, pledged: tp, collected: tc, remaining: tr, counts } };
}

async function families(period, level) {
  const rows = await db.many(
    `SELECT f.id, f.file_no, f.family_name, f.status, g.full_name AS guardian,
       (SELECT count(*) FROM family_members m WHERE m.family_id=f.id)::int AS members,
       e.eligible_count, e.amount_due::text AS due, e.amount_paid::text AS paid, e.status AS ent_status,
       (SELECT string_agg(sp.full_name, '، ') FROM family_sponsorships fs JOIN sponsors sp ON sp.id=fs.sponsor_id
         WHERE fs.family_id=f.id AND fs.start_date <= $2 AND (fs.end_date IS NULL OR fs.end_date >= $3)) AS sponsors
     FROM families f LEFT JOIN guardians g ON g.family_id=f.id LEFT JOIN monthly_entitlements e ON e.family_id=f.id AND e.period=$1
     WHERE e.id IS NOT NULL OR f.status IN ('active','under_review','suspended')
     ORDER BY f.file_no`, [period, U.periodEnd(period), U.periodStart(period)]);
  let td = 0; let tp = 0; let tm = 0; let te = 0;
  const byStatus = {};
  const out = rows.map((r) => {
    const d = U.toCents(r.due || 0); const p = U.toCents(r.paid || 0);
    td += d; tp += p; tm += r.members; te += r.eligible_count || 0;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return { file: r.file_no, guardian: r.guardian || r.family_name, members: r.members, eligible: r.eligible_count ?? '—', sponsors: r.sponsors || 'لا يوجد',
      due: d, paid: p, remaining: d - p, status: r.ent_status ? label('entStatus', r.ent_status) : 'غير مدرجة في كشف الشهر (' + label('familyStatus', r.status) + ')' };
  });
  const sections = [kv('الإجماليات', [
    { label: 'عدد الأسر في التقرير', text: String(out.length) },
    ...Object.entries(byStatus).map(([k, v]) => ({ label: 'أسر بحالة: ' + label('familyStatus', k), text: String(v) })),
    { label: 'إجمالي أفراد الأسر', text: String(tm) },
    { label: 'إجمالي المستفيدين المستحقين (حسب الكشف)', text: String(te) },
    { label: 'إجمالي المستحق', ...M(td) }, { label: 'إجمالي المصروف', ...M(tp) }, { label: 'إجمالي المتبقي', ...M(td - tp) },
  ])];
  if (level === 'detailed') {
    sections.push(table('تفصيل الأسر', [
      { key: 'file', label: 'رقم الملف' }, { key: 'guardian', label: 'ولي الأمر' }, { key: 'members', label: 'الأفراد' }, { key: 'eligible', label: 'المستحقون' },
      { key: 'sponsors', label: 'الكفلاء' }, { key: 'due', label: 'المستحق', money: true }, { key: 'paid', label: 'المصروف', money: true },
      { key: 'remaining', label: 'المتبقي', money: true }, { key: 'status', label: 'حالة الصرف' }],
    out, { file: '', guardian: 'الإجمالي', members: tm, eligible: te, sponsors: '', due: td, paid: tp, remaining: td - tp, status: '' }));
  }
  return { sections, summary: { families: out.length, members: tm, eligible: te, due: td, paid: tp } };
}

async function disbursements(period, level) {
  const rows = await db.many(
    `SELECT e.*, f.file_no, f.family_name, g.full_name AS guardian,
       (SELECT max(d.disb_date) FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS last_date,
       (SELECT string_agg(DISTINCT d.method, ',') FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS methods,
       (SELECT string_agg(COALESCE(d.reference, d.disb_no), '، ') FROM disbursements d WHERE d.entitlement_id=e.id AND d.status='paid') AS refs
     FROM monthly_entitlements e JOIN families f ON f.id=e.family_id LEFT JOIN guardians g ON g.family_id=f.id
     WHERE e.period=$1 ORDER BY f.file_no`, [period]);
  const t = await stats.entitlementTotals(db, period);
  const out = rows.map((r) => ({
    file: r.file_no, name: `${r.family_name} / ${r.guardian || ''}`, due: U.toCents(r.amount_due), paid: U.toCents(r.amount_paid),
    date: r.last_date || '—', method: (r.methods || '').split(',').filter(Boolean).map((m) => label('payout', m)).join('، ') || '—',
    ref: r.refs || '—', status: label('entStatus', r.status), remaining: U.toCents(r.amount_due) - U.toCents(r.amount_paid),
  }));
  const sections = [kv('ملخص الصرف', [
    { label: 'عدد الأسر المستحقة', text: String(t.families) },
    { label: 'عدد الأسر المستلمة بالكامل', text: String(t.full) },
    { label: 'عدد الأسر المستلمة جزئيًا', text: String(t.partial) },
    { label: 'عدد الأسر غير المستلمة', text: String(t.none) },
    { label: 'إجمالي المستحق', ...M(t.due) }, { label: 'إجمالي المصروف', ...M(t.paid) }, { label: 'إجمالي المتبقي', ...M(t.remaining) },
    { label: 'نسبة إنجاز الصرف', text: t.pct + '%' },
  ], 'السجلات الملغاة بقرار موثق مستبعدة من الإجماليات.')];
  if (level === 'detailed') {
    const sum = (k) => out.reduce((a, r) => a + r[k], 0);
    sections.push(table('كشف الصرف التفصيلي', [
      { key: 'file', label: 'رقم الملف' }, { key: 'name', label: 'الأسرة / ولي الأمر' }, { key: 'due', label: 'المستحق', money: true },
      { key: 'paid', label: 'المصروف', money: true }, { key: 'date', label: 'تاريخ الصرف' }, { key: 'method', label: 'طريقة الصرف' },
      { key: 'ref', label: 'مرجع العملية' }, { key: 'status', label: 'حالة الصرف' }, { key: 'remaining', label: 'المتبقي', money: true }],
    out, { file: '', name: 'الإجمالي (شامل الملغى إن وجد)', due: sum('due'), paid: sum('paid'), date: '', method: '', ref: '', status: '', remaining: sum('remaining') },
    'التوقيع بالاستلام: يُرفق كشف التوقيعات أو الإيصالات المؤيدة لكل عملية.'));
  }
  return { sections, summary: { families: t.families, full: t.full, partial: t.partial, none: t.none, due: t.due, paid: t.paid, remaining: t.remaining } };
}

async function expenses(period, level) {
  const rows = await db.many(
    `SELECT e.*, c.name AS cat FROM expenses e JOIN expense_categories c ON c.code=e.category_code
     WHERE e.period=$1 AND e.status <> 'draft' ORDER BY e.expense_date, e.id`, [period]);
  const byCat = {};
  for (const r of rows) {
    if (!byCat[r.cat]) byCat[r.cat] = { cat: r.cat, paid: 0, pending: 0, n: 0 };
    byCat[r.cat].n++;
    if (r.status === 'paid') byCat[r.cat].paid += U.toCents(r.amount);
    if (['pending_approval', 'approved'].includes(r.status)) byCat[r.cat].pending += U.toCents(r.amount);
  }
  const cats = Object.values(byCat);
  const tPaid = cats.reduce((a, c) => a + c.paid, 0); const tPend = cats.reduce((a, c) => a + c.pending, 0);
  const sections = [table('الإجماليات حسب التصنيف', [
    { key: 'cat', label: 'التصنيف' }, { key: 'n', label: 'عدد العمليات' }, { key: 'paid', label: 'المدفوع', money: true }, { key: 'pending', label: 'معتمد/بانتظار — غير مدفوع', money: true }],
  cats, { cat: 'الإجمالي', n: rows.length, paid: tPaid, pending: tPend }, 'المصروفات الملغاة أو المرفوضة تظهر في التفصيل ولا تدخل في المدفوع.')];
  if (level === 'detailed') {
    sections.push(table('تفصيل المصروفات', [
      { key: 'no', label: 'رقم العملية' }, { key: 'date', label: 'التاريخ' }, { key: 'cat', label: 'التصنيف' }, { key: 'desc', label: 'الوصف' },
      { key: 'amount', label: 'المبلغ', money: true }, { key: 'method', label: 'طريقة الدفع' }, { key: 'doc', label: 'المستند المؤيد' }, { key: 'status', label: 'حالة الاعتماد والسداد' }],
    rows.map((r) => ({ no: r.expense_no, date: r.expense_date, cat: r.cat, desc: r.description, amount: U.toCents(r.amount), method: r.payment_method || '—',
      doc: r.invoice_no || (r.document_id ? 'مرفق' : '—'), status: label('expenseStatus', r.status) })),
    { no: '', date: '', cat: '', desc: 'إجمالي المدفوع', amount: tPaid, method: '', doc: '', status: '' }));
  }
  return { sections, summary: { count: rows.length, paid: tPaid, pending: tPend, byCategory: Object.fromEntries(cats.map((c) => [c.cat, c.paid])) } };
}

async function eligibility(period, level) {
  const { reviewData } = require('../routes/eligibility');
  const today = period === U.currentPeriod() ? U.todayISO() : U.periodEnd(period);
  const d = await reviewData(today);
  const memberCols = [{ key: 'file', label: 'رقم الملف' }, { key: 'name', label: 'الاسم' }, { key: 'birth', label: 'الميلاد' }, { key: 'age', label: 'العمر' }, { key: 'info', label: 'ملاحظة' }, { key: 'status', label: 'الحالة' }];
  const mrow = (m, info) => ({ file: m.file_no, name: m.full_name, birth: m.birth_date, age: m.age ?? U.ageOn(m.birth_date, today), info, status: label('eligibility', m.eligibility_status) });
  const sections = [kv('ملخص الحالات', [
    { label: `ذكور بلغوا ${d.age} عامًا ويحتاجون مراجعة`, text: String(d.reached.length) },
    { label: `ذكور سيبلغون ${d.age} خلال شهر`, text: String(d.soon1.length) },
    { label: `ذكور سيبلغون ${d.age} خلال ثلاثة أشهر`, text: String(d.soon3.length) },
    { label: 'إثباتات جامعية منتهية أو قريبة الانتهاء', text: String(d.proofs.length) },
    { label: 'مستندات منتهية', text: String(d.expiredDocs.length) },
    { label: 'مستندات إلزامية ناقصة', text: String(d.missing.length) },
    { label: 'حالات زواج وطلبات بانتظار اعتماد', text: String(d.reviews.length) },
    { label: 'مستفيدون بحالة تتطلب قرارًا', text: String(d.pendingDecision.length) },
    { label: 'أسر تحتاج إلى كفيل بديل', text: String(d.noSponsor.length) },
  ], `محسوب بتاريخ ${today}`)];
  if (level === 'detailed') {
    sections.push(table('بلوغ الذكور السن المحدد / نقص الإثبات الجامعي', memberCols, d.reached.map((m) => mrow(m, 'تاريخ البلوغ ' + m.review_date))));
    sections.push(table('سيبلغون السن خلال ثلاثة أشهر', memberCols, [...d.soon1, ...d.soon3].map((m) => mrow(m, 'تاريخ البلوغ ' + m.review_date))));
    sections.push(table('الإثباتات الجامعية', [{ key: 'file', label: 'الملف' }, { key: 'name', label: 'المستفيد' }, { key: 'exp', label: 'تاريخ الانتهاء' }],
      d.proofs.map((p) => ({ file: p.file_no, name: p.full_name, exp: p.expiry_date }))));
    sections.push(table('حالات الزواج والطلبات بانتظار الاعتماد', [{ key: 'file', label: 'الملف' }, { key: 'name', label: 'المستفيد' }, { key: 'type', label: 'النوع' }, { key: 'details', label: 'التفاصيل' }],
      d.reviews.map((r) => ({ file: r.file_no, name: r.full_name, type: label('reviewType', r.review_type), details: r.details }))));
    sections.push(table('مستندات منتهية', [{ key: 'file', label: 'الملف' }, { key: 'doc', label: 'المستند' }, { key: 'owner', label: 'صاحبه' }, { key: 'exp', label: 'انتهى في' }],
      d.expiredDocs.map((x) => ({ file: x.file_no, doc: label('docType', x.doc_type), owner: x.owner, exp: x.expiry_date }))));
    sections.push(table('الملفات الناقصة', [{ key: 'file', label: 'الملف' }, { key: 'doc', label: 'المستند الناقص' }, { key: 'owner', label: 'صاحبه' }],
      d.missing.map((x) => ({ file: x.file_no, doc: label('docType', x.doc_type), owner: x.owner }))));
    sections.push(table('الأسر التي تحتاج إلى كفيل بديل', [{ key: 'file', label: 'الملف' }, { key: 'name', label: 'الأسرة' }],
      d.noSponsor.map((f) => ({ file: f.file_no, name: f.family_name }))));
  }
  return { sections, summary: { reached: d.reached.length, soon1: d.soon1.length, soon3: d.soon3.length, proofs: d.proofs.length, expired: d.expiredDocs.length, missing: d.missing.length, reviews: d.reviews.length, noSponsor: d.noSponsor.length } };
}

const BUILDERS = { financial, sponsors, families, disbursements, expenses, eligibility };

async function build(type, period, level = 'detailed') {
  if (!BUILDERS[type]) throw new U.UserError('نوع التقرير غير معروف');
  if (!U.validPeriod(period)) throw new U.UserError('الشهر غير صالح');
  level = level === 'summary' ? 'summary' : 'detailed';
  const r = await BUILDERS[type](period, level);
  const org = await settings.get('org');
  const refs = await db.one(
    `SELECT (SELECT COALESCE(max(id),0) FROM ledger_entries)::text AS ledger_max_id,
       (SELECT count(*) FROM ledger_entries WHERE period=$1)::int AS ledger_entries_in_period,
       (SELECT count(*) FROM monthly_entitlements WHERE period=$1)::int AS entitlements,
       (SELECT COALESCE(max(id),0) FROM disbursements)::int AS disbursement_max_id,
       (SELECT COALESCE(max(id),0) FROM donations)::int AS donation_max_id,
       (SELECT COALESCE(max(id),0) FROM expenses)::int AS expense_max_id,
       (SELECT COALESCE(max(id),0) FROM eligibility_decisions)::int AS decision_max_id`, [period]);
  return {
    type, period, level, title: meta.types[type].title, periodLabel: U.periodLabel(period), generatedAt: new Date(),
    org, sections: r.sections, summary: r.summary, sourceRefs: refs,
  };
}

/** تنسيق قيمة خلية للعرض */
function cell(col, v) {
  if (col.money) return v === null || v === undefined || v === '' ? '' : U.fmtMoney(U.fromCents(v));
  return v === null || v === undefined ? '' : String(v);
}

module.exports = { build, cell, BUILDERS };
