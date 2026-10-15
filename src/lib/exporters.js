'use strict';
// تصدير التقارير: HTML للطباعة، PDF (Chromium)، Excel، CSV
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const ExcelJS = require('exceljs');
const U = require('./util');
const { cell } = require('./reports');

const PUB = path.join(__dirname, '..', '..', 'public');
let fontCache = null;
async function embeddedAssets(org) {
  if (!fontCache) {
    const f = (n) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(PUB, 'fonts', n)).toString('base64');
    fontCache = { ar400: f('cairo-arabic-400-normal.woff2'), ar700: f('cairo-arabic-700-normal.woff2'), la400: f('cairo-latin-400-normal.woff2'), la700: f('cairo-latin-700-normal.woff2') };
  }
  let buf = null;
  if (org.logo && org.logo.startsWith('/branding/')) buf = (await require('./uploads').getFile('branding/logo.png'))?.data;
  if (!buf) buf = fs.readFileSync(path.join(PUB, 'img', 'logo.png'));
  const logo = 'data:image/png;base64,' + buf.toString('base64');
  return { fonts: fontCache, logo };
}

async function renderHtml(report, { forPdf = false, user = null, approval = null } = {}) {
  const assets = forPdf ? await embeddedAssets(report.org) : {
    fonts: { ar400: '/static/fonts/cairo-arabic-400-normal.woff2', ar700: '/static/fonts/cairo-arabic-700-normal.woff2', la400: '/static/fonts/cairo-latin-400-normal.woff2', la700: '/static/fonts/cairo-latin-700-normal.woff2' },
    logo: report.org.logo || '/static/img/logo.png',
  };
  return ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'reports', 'print.ejs'), { r: report, assets, forPdf, cell, U, user, approval });
}

/** تشغيل Chromium: نسخة الاستضافة السحابية (@sparticuz/chromium) أو المتصفح المثبت على الخادم */
async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const exe = process.env.CHROME_PATH;
  if (exe && fs.existsSync(exe) && !process.env.VERCEL) {
    return puppeteer.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] });
  }
  let chromium;
  try { chromium = (await import('@sparticuz/chromium')).default; } catch (_) {
    throw new U.UserError('تصدير PDF يتطلب متصفح Chromium على الخادم: اضبط المتغير CHROME_PATH (راجع دليل التثبيت). يمكنك استخدام «طباعة» ثم «حفظ كـ PDF» من المتصفح مؤقتًا.', 503);
  }
  const executablePath = await chromium.executablePath();
  // خط عربي لتذييل الصفحات (أرقام الصفحات) داخل بيئة الاستضافة
  const fontsDir = process.env.FONTCONFIG_PATH || path.join(require('os').tmpdir(), 'fonts');
  try { fs.mkdirSync(fontsDir, { recursive: true }); fs.copyFileSync(path.join(PUB, 'fonts', 'DejaVuSans.ttf'), path.join(fontsDir, 'DejaVuSans.ttf')); } catch (_) { /* اختياري */ }
  return puppeteer.launch({ executablePath, args: chromium.args, headless: 'shell', defaultViewport: { width: 1240, height: 1754 } });
}

async function toPdf(report, opts = {}) {
  const html = await renderHtml(report, { ...opts, forPdf: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluateHandle('document.fonts.ready');
    return await page.pdf({
      format: 'A4', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#666;padding:0 12mm;display:flex;justify-content:space-between;font-family:'DejaVu Sans',sans-serif;direction:rtl">
        <span>${escapeHtml(report.org.name || '')} — ${escapeHtml(report.title)} — ${escapeHtml(report.periodLabel)}</span>
        <span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>`,
      margin: { top: '12mm', bottom: '16mm', left: '10mm', right: '10mm' },
    });
  } finally { await browser.close(); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = report.org.system_name || 'Kafala'; wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31), { views: [{ rightToLeft: true }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const green = 'FF054834'; const gold = 'FFF6EFDC';
  const font = { name: 'Arial' };
  ws.addRow([report.org.name + (report.org.registration ? ' — ' + report.org.registration : '')]).font = { ...font, bold: true, size: 14, color: { argb: green } };
  if (report.org.subtitle) ws.addRow([report.org.subtitle]).font = { ...font, size: 10 };
  ws.addRow([`${report.title} — ${report.periodLabel}`]).font = { ...font, bold: true, size: 13 };
  ws.addRow([`تاريخ الاستخراج: ${new Date(report.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} — العملة: ${report.org.currency || ''} — المستوى: ${report.level === 'summary' ? 'مختصر' : 'تفصيلي'}`]).font = { ...font, size: 9, color: { argb: 'FF666666' } };
  ws.addRow([]);
  let maxCols = 3;
  for (const s of report.sections) {
    const hr = ws.addRow([s.title]); hr.font = { ...font, bold: true, size: 12, color: { argb: green } };
    if (s.kind === 'kv') {
      for (const it of s.items) {
        const r = ws.addRow([it.label, it.money ? it.cents / 100 : it.text, it.formula || '']);
        if (it.money) r.getCell(2).numFmt = '#,##0.00';
        if (it.strong) r.font = { ...font, bold: true };
      }
    } else {
      maxCols = Math.max(maxCols, s.columns.length);
      const h = ws.addRow(s.columns.map((c) => c.label));
      h.eachCell((c) => { c.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: green } }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
      if (!s.rows.length) ws.addRow(['لا توجد بيانات']);
      for (const row of s.rows) {
        const r = ws.addRow(s.columns.map((c) => (c.money ? (row[c.key] == null ? null : row[c.key] / 100) : row[c.key])));
        s.columns.forEach((c, i) => { if (c.money) r.getCell(i + 1).numFmt = '#,##0.00'; });
      }
      if (s.totals) {
        const r = ws.addRow(s.columns.map((c) => (c.money ? s.totals[c.key] / 100 : s.totals[c.key])));
        r.eachCell((c, i) => { c.font = { ...font, bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: gold } }; if (s.columns[i - 1]?.money) c.numFmt = '#,##0.00'; });
      }
    }
    if (s.note) ws.addRow([s.note]).font = { ...font, italic: true, size: 9 };
    ws.addRow([]);
  }
  for (let i = 1; i <= maxCols; i++) ws.getColumn(i).width = i === 1 ? 38 : 18;
  return wb.xlsx.writeBuffer();
}

function toCsv(report) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // حماية من حقن الصيغ في برامج الجداول
  const safe = (v) => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) && isNaN(Number(s)) ? "'" + s : s; };
  const lines = [[report.org.name], [`${report.title} — ${report.periodLabel}`], []];
  for (const s of report.sections) {
    lines.push([s.title]);
    if (s.kind === 'kv') for (const it of s.items) lines.push([it.label, it.money ? U.fromCents(it.cents) : it.text]);
    else {
      lines.push(s.columns.map((c) => c.label));
      for (const r of s.rows) lines.push(s.columns.map((c) => (c.money ? (r[c.key] == null ? '' : U.fromCents(r[c.key])) : r[c.key])));
      if (s.totals) lines.push(s.columns.map((c) => (c.money ? U.fromCents(s.totals[c.key]) : s.totals[c.key])));
    }
    lines.push([]);
  }
  return '﻿' + lines.map((l) => l.map((v) => q(safe(v))).join(',')).join('\r\n');
}

/** تحويل صفحة HTML جاهزة للطباعة إلى PDF (A4) مع أرقام الصفحات */
async function htmlToPdf(html, { landscape = false, footer = '' } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluateHandle('document.fonts.ready');
    return await page.pdf({
      format: 'A4', landscape, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#666;padding:0 12mm;display:flex;justify-content:space-between;font-family:'DejaVu Sans',sans-serif;direction:rtl">
        <span>${escapeHtml(footer)}</span><span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>`,
      margin: { top: '10mm', bottom: '14mm', left: '8mm', right: '8mm' },
    });
  } finally { await browser.close(); }
}

module.exports = { renderHtml, toPdf, toXlsx, toCsv, htmlToPdf, embeddedAssets };
