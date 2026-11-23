'use strict';
// Accountant view → Inspection invoices: every inspection with an invoice — date, supplier, orders, company, invoice,
// amount (USD), due, status and the invoice PDF. Mark paid; export CSV + all invoice PDFs as a ZIP.
//   GET  /admin/finance/inspections?month=&company=&status=
//   POST /admin/finance/inspections/:id/paid · /:id/unpaid
//   GET  /admin/finance/inspections/export.csv · /invoices.zip · /:id/slip/:n

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const IN = require('../inspections');
const { ddSel } = require('./logistics-costs');
const { zip } = require('../lib/zip');

const BASE = '/admin/finance/inspections';
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fileUrl = (id) => `/admin/logistics/planning/files/${id}`;

module.exports = function financeInspections(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';

  async function data(q = {}) {
    const { rows, companies, missing } = await IN.loadAll(db);
    if (missing) return { missing: true };
    const sups = Object.fromEntries((await db.list('suppliers').catch(() => [])).map((s) => [s.id, s]));
    const co = Object.fromEntries(companies.map((c) => [c.id, c]));
    const files = Object.fromEntries((await db.list('plan_files').catch(() => [])).filter((f) => f.inspection_id).map((f) => [f.id, f]));
    const all = rows.filter((i) => i.invoice_amount != null || i.invoice_file_id).map((i) => {
      const day = i.inspection_date || String(i.created_at).slice(0, 10);
      return { ...i, day, month: day.slice(0, 7), supplier: sups[i.supplier_id]?.name || '—', company: co[i.company_id]?.name || '—', file: files[i.invoice_file_id] || null };
    }).sort((a, b) => b.day.localeCompare(a.day));
    const list = all.filter((i) => (!q.month || q.month === 'all' || i.month === q.month) && (!q.company || i.company_id === q.company) && (!q.status || (q.status === 'paid' ? i.paid_at : !i.paid_at)));
    return { all, list, companies };
  }
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const qs = (q, o = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ month: q.month || '', company: q.company || '', status: q.status || '', ...o }).filter(([, v]) => v))).toString();

  router.get(BASE, G(async (req, res) => {
    const today = PL.today();
    const q = { month: /^\d{4}-\d{2}$|^all$/.test(req.query.month || '') ? req.query.month : '', company: req.query.company || '', status: ['paid', 'open'].includes(req.query.status) ? req.query.status : '' };
    const D = await data(q);
    if (D.missing) return res.html(page({ title: 'Inspection invoices', nav: adminNav('finance-insp'), req, flash: takeFlash(req, res), body: html`<h2 class="sl-title">Inspection invoices</h2><section class="card"><p>Run supabase/inspections.sql in Supabase → SQL Editor first.</p></section>` }));
    const { all, list, companies } = D;
    const sum = (a) => a.reduce((s, i) => s + (Number(i.invoice_amount) || 0), 0);
    const thisM = today.slice(0, 7);
    const mNow = all.filter((i) => i.month === thisM); const open = all.filter((i) => !i.paid_at && i.invoice_amount);
    const paidM = all.filter((i) => i.paid_at && String(i.paid_at).startsWith(thisM));
    const nextDue = open.filter((i) => i.invoice_due).map((i) => i.invoice_due).sort()[0];
    const avg = all.filter((i) => i.invoice_amount).length ? sum(all) / all.filter((i) => i.invoice_amount).length : 0;
    const months = [...new Set([thisM, ...all.map((i) => i.month)])].sort().reverse();
    const groups = []; for (const i of list) { const g = groups.find((x) => x.m === i.month); if (g) g.rows.push(i); else groups.push({ m: i.month, rows: [i] }); }
    const back = req.url;
    const res1 = (i) => (i.status === 'passed' ? html`<div class="fi-r p">${IN.SHORT[i.type] || ''} · Passed</div>` : i.status === 'failed' ? html`<div class="fi-r f">${IN.SHORT[i.type] || ''} · Failed</div>` : html`<div class="fi-r">${IN.SHORT[i.type] || ''}</div>`);
    res.html(page({
      title: 'Inspection invoices', nav: adminNav('finance-insp'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Inspection invoices</h2><p class="muted">Quality inspections paid to the inspection companies. Open the invoice, pay it, mark it paid. All amounts in USD.</p></div></div>
        <div class="pm-kp">
          <div><span>${monthName(thisM).split(' ')[0]}</span><b>${IN.usd(sum(mNow))}</b><small>${mNow.length} inspection${mNow.length === 1 ? '' : 's'}</small></div>
          <div class="${open.some((i) => i.invoice_due && i.invoice_due < today) ? 'bad' : ''}"><span>To pay</span><b>${IN.usd(sum(open))}</b><small>${open.length} invoice${open.length === 1 ? '' : 's'}${nextDue ? ` · next due ${PL.short(nextDue)}` : ''}</small></div>
          <div><span>Paid in ${monthName(thisM).split(' ')[0]}</span><b>${IN.usd(sum(paidM))}</b><small>${paidM.length} invoice${paidM.length === 1 ? '' : 's'}</small></div>
          <div><span>Average</span><b>${IN.usd(avg)}</b><small>per inspection</small></div>
        </div>
        <section class="card fi-card">
          <form method="get" action="${BASE}" class="fi-filters">
            ${ddSel('month', q.month || 'all', [['all', 'All months'], ...months.map((m) => [m, monthName(m)])])}
            ${ddSel('company', q.company, [['', 'All companies'], ...companies.map((c) => [c.id, c.name])])}
            ${ddSel('status', q.status, [['', 'All statuses'], ['open', 'To pay'], ['paid', 'Paid']])}
            <button class="btn small ghost">Show</button>
            <span class="fi-exp"><a class="btn small ghost" href="${`${BASE}/export.csv?${qs(q)}`}">⬇ CSV</a><a class="btn small ghost" href="${`${BASE}/invoices.zip?${qs(q)}`}">⬇ Invoices (ZIP)</a></span>
          </form>
          ${list.length ? html`<div class="table-wrap"><table class="list fi-table"><thead><tr><th>Inspection date</th><th>Supplier inspected</th><th>Order(s)</th><th>Inspection company</th><th>Invoice</th><th class="r">Amount</th><th>Due</th><th>Status</th><th>Invoice file</th></tr></thead><tbody>
            ${groups.map((g) => html`<tr class="fi-mo"><td colspan="9">${monthName(g.m)}</td></tr>${g.rows.map((i) => html`<tr>
              <td><b>${PL.short(i.day)}</b>${res1(i)}</td><td>${i.supplier}</td><td>${IN.posOf(i).join(', ')}</td><td>${i.company}</td><td>${i.invoice_no || '—'}</td>
              <td class="r">${i.invoice_amount != null ? IN.usd(i.invoice_amount) : '—'}</td><td>${i.invoice_due ? PL.short(i.invoice_due) : '—'}</td>
              <td>${i.paid_at ? html`<span class="cp-tag ok">Paid ${PL.short(i.paid_at)}</span>` : html`<details class="fi-pay"><summary class="cp-tag ${i.invoice_due && i.invoice_due < today ? 'bad' : 'warn'}">${i.invoice_due && i.invoice_due < today ? 'Overdue' : 'To pay'} ▾</summary>
                <form method="post" action="${`${BASE}/${i.id}/paid`}" enctype="multipart/form-data" class="fi-payf" data-busy><input type="hidden" name="back" value="${back}">
                  <label>Date paid <input type="date" name="date" value="${today}" max="${today}" required></label><label>Bank reference <input name="ref"></label><label>Slip <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg"></label><button class="btn small">Mark paid</button></form></details>`}</td>
              <td>${i.file ? html`<a class="fi-pdf" href="${`${fileUrl(i.file.id)}?inline=1`}" data-preview="${`${fileUrl(i.file.id)}?inline=1`}" data-type="${/image/.test(i.file.content_type || '') ? 'image' : 'doc'}" data-dl="${fileUrl(i.file.id)}">📎 ${i.file.name}</a>` : html`<span class="sub">no file</span>`}</td></tr>`)}`)}
            </tbody><tfoot><tr><td colspan="5">Total · ${list.length} invoice${list.length === 1 ? '' : 's'}</td><td class="r">${IN.usd(sum(list))}</td><td colspan="3"></td></tr></tfoot></table></div>`
            : html`<p class="fn-empty">No inspection invoices${q.month && q.month !== 'all' ? ` in ${monthName(q.month)}` : ''} yet.</p>`}
        </section>`,
    }));
  }));

  router.post(`${BASE}/:id/paid`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 15 * 1024 * 1024 });
    const i = await db.get('inspections', req.params.id).catch(() => null); if (!i) throw new HttpError(404, 'Inspection not found');
    const date = PL.isoDay(f.date) || PL.today();
    const slips = [...(i.paid_files || [])];
    for (const x of (files.file || []).filter((x) => x.buffer?.length)) {
      const path = `inspections/${i.supplier_id}/slip-${Date.now().toString(36)}-${String(x.name).replace(/[^\w.\-()]+/g, '_').slice(-80)}`;
      await db.docs.upload(path, x.buffer, x.type || 'application/octet-stream'); slips.push({ name: x.name, path, type: x.type, by: by(req), at: new Date().toISOString() });
    }
    await db.update('inspections', { id: i.id }, { paid_at: date, paid_by: by(req), paid_ref: String(f.ref || '').slice(0, 80) || null, paid_files: slips, log: IN.withLog(i, `Invoice paid ${PL.short(date)}${f.ref ? ` · ${f.ref}` : ''}`, by(req)), updated_at: new Date().toISOString() });
    flash(res, 'ok', `${i.ref} marked paid`);
    res.redirect(String(f.back || '').startsWith(BASE) ? f.back : BASE);
  }));

  router.get(`${BASE}/export.csv`, G(async (req, res) => {
    const D = await data(req.query); if (D.missing) return res.redirect(BASE);
    const head = ['Inspection date', 'Type', 'Result', 'Supplier', 'Orders', 'Inspection company', 'Reference', 'Invoice no', 'Amount USD', 'Due', 'Paid on', 'Bank reference', 'Invoice file'];
    const body = D.list.map((i) => [i.day, IN.SHORT[i.type] || i.type, i.status === 'passed' ? 'Passed' : i.status === 'failed' ? 'Failed' : '', i.supplier, IN.posOf(i).join(' '), i.company, i.ref, i.invoice_no || '', i.invoice_amount ?? '', i.invoice_due || '', i.paid_at || '', i.paid_ref || '', i.file?.name || ''].map(csvCell).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inspection-invoices-${PL.today()}.csv"` });
    res.end([head.join(','), ...body].join('\n'));
  }));

  router.get(`${BASE}/invoices.zip`, G(async (req, res) => {
    const D = await data(req.query); if (D.missing) return res.redirect(BASE);
    const out = [];
    for (const i of D.list.filter((x) => x.file)) { try { out.push({ name: `${i.day} ${i.supplier} ${i.invoice_no || i.ref} - ${i.file.name}`.replace(/\s+/g, ' '), data: await db.docs.download(i.file.path) }); } catch { /* skip */ } }
    if (!out.length) { flash(res, 'warn', 'No invoice files to download'); return res.redirect(BASE); }
    const buf = zip(out);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="inspection-invoices-${PL.today()}.zip"`, 'Content-Length': buf.length });
    res.end(buf);
  }));
};
