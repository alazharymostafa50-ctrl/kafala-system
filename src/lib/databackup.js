'use strict';
// نسخة احتياطية للبيانات تُنزَّل من داخل المنصة كملف Excel: ورقة لكل جدول.
// لا تشمل محتوى الملفات المرفوعة (صور المستندات) ولا كلمات المرور وأسرار الدخول، ولا الجلسات وسجلات التشخيص.
const ExcelJS = require('exceljs');
const db = require('../db');

const SKIP_TABLES = new Set(['user_sessions', 'request_debug', 'app_secrets', 'app_state', 'session']);
const SKIP_COLS = { users: new Set(['password_hash', 'totp_secret']) };

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return null;
  if (typeof v === 'object') v = JSON.stringify(v);
  if (typeof v === 'string' && v.length > 32000) return v.slice(0, 32000) + '…';
  return v;
}

async function buildWorkbook(org = {}) {
  const tables = (await db.many(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).map((r) => r.table_name).filter((t) => !SKIP_TABLES.has(t));
  const cols = await db.many(`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نظام إدارة كفالة الأيتام'; wb.created = new Date();
  const info = wb.addWorksheet('معلومات النسخة', { views: [{ rightToLeft: true }] });
  info.columns = [{ header: 'البيان', key: 'k', width: 34 }, { header: 'القيمة', key: 'v', width: 60 }];
  info.addRow({ k: 'الجهة', v: [org.name, org.registration].filter(Boolean).join(' — ') });
  info.addRow({ k: 'تاريخ النسخة', v: new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' }) });
  info.addRow({ k: 'ملاحظة', v: 'كل ورقة في هذا الملف = جدول من قاعدة البيانات. صور المستندات وكلمات المرور غير مضمنة.' });
  info.addRow({});
  info.addRow({ k: 'الجدول', v: 'عدد السجلات' }).font = { bold: true };
  for (const t of tables) {
    const tcols = cols.filter((c) => c.table_name === t && c.data_type !== 'bytea' && !(SKIP_COLS[t] && SKIP_COLS[t].has(c.column_name))).map((c) => c.column_name);
    if (!tcols.length) continue;
    const rows = await db.many(`SELECT ${tcols.map((c) => `"${c}"`).join(',')} FROM "${t}" ORDER BY 1`);
    info.addRow({ k: t, v: rows.length });
    const ws = wb.addWorksheet(t.slice(0, 31), { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = tcols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) { const o = {}; for (const c of tcols) o[c] = cellValue(r[c]); ws.addRow(o); }
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
