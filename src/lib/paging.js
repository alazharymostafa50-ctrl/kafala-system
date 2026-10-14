'use strict';
const db = require('../db');

/**
 * استعلام مع ترقيم الصفحات.
 * baseSql: الاستعلام بدون ORDER/LIMIT، params: معاملاته
 */
async function paged(req, baseSql, params, orderBy, pageSize = 25) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalRow = await db.one(`SELECT count(*)::int AS n FROM (${baseSql}) x`, params);
  const rows = await db.many(`${baseSql} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  const pages = Math.max(1, Math.ceil(totalRow.n / pageSize));
  const qs = (p) => { const q = new URLSearchParams(req.query); q.set('page', p); return '?' + q.toString(); };
  return { rows, page, pages, total: totalRow.n, qs };
}

/** بناء شروط WHERE بأمان (معاملات مرقمة) */
class Where {
  constructor(params = []) { this.parts = []; this.params = params; }
  add(sql, ...vals) {
    let s = sql;
    for (const v of vals) { this.params.push(v); s = s.replace('?', '$' + this.params.length); }
    this.parts.push(s); return this;
  }
  get sql() { return this.parts.length ? 'WHERE ' + this.parts.join(' AND ') : ''; }
}

module.exports = { paged, Where };
