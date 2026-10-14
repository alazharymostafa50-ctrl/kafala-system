'use strict';
// أنواع التقارير الشهرية وصلاحياتها
module.exports = {
  types: {
    financial: { title: 'التقرير المالي الشهري', perm: 'finance.view' },
    sponsors: { title: 'تقرير الكفلاء', perm: 'sponsors.view' },
    families: { title: 'تقرير الأسر', perm: 'families.view' },
    disbursements: { title: 'تقرير الصرف الشهري', perm: 'entitlements.view' },
    expenses: { title: 'تقرير المصروفات', perm: 'expenses.view' },
    eligibility: { title: 'تقرير مراجعة الاستحقاق', perm: 'eligibility.view' },
  },
};
