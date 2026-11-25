'use strict';
// Forwarder statements and invoices.
//   GET  /admin/logistics/forwarders/:id           forwarder page: open balance by age, invoices, statements, upload
//   POST /admin/logistics/fwd-statements           upload a statement (from the forwarder page, Shipments or Shipping documents)
//   GET  /admin/logistics/fwd-statements/:sid      review: each invoice with the shipment it matched; change, then save
//   POST /admin/logistics/fwd-statements/:sid/save | /discard
//   GET  /admin/logistics/fwd-statements/:sid/file the statement PDF

const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const { ddSel } = require('./logistics-costs');
const FS = require('../fwd-statements');
const PL = require('../planning');
const SN = require('../shipname');

const FBASE = '/admin/logistics/forwarders';
const SBASE = '/admin/logistics/fwd-statements';
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const money = FS.money;
const shortDay = (d) => (d ? PL.short(String(d).slice(0, 10)) : '—');
const safeBack = (b) => (/^\/admin\/[\w\-/?=&.%#]*$/.test(String(b || '')) ? String(b) : null);

/** The upload box: a dialog opened from Shipments / Shipping documents (forwarder optional: AI reads it from the PDF). */
function uploadDialog(fwds, back) {
  return html`<dialog id="fs-up" class="rp-modal fs-dlg" aria-labelledby="fs-up-t"><form method="post" action="${SBASE}" enctype="multipart/form-data" data-busy>
    <div class="rp-top"><h2 id="fs-up-t">Forwarder statement</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
    <p class="sub">Upload a statement of account (or one freight invoice). AI reads every invoice and matches it to your shipments; you check before saving.</p>
    <input type="hidden" name="back" value="${back}">
    <label class="fs-lbl"><span class="lbl">Forwarder</span>${ddSel('forwarder_id', '', [['', 'Read it from the statement'], ...fwds.map((f) => [f.id, f.company])])}</label>
    ${dropBox()}
    <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn" data-busy>Read statement</button></div></form></dialog>`;
}
const dropBox = () => html`<div class="mdrop small" data-filebox data-max="1"><div class="mdrop-box"><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp" required title="" aria-label="Statement PDF"><span class="dz-main" data-main>Drop the statement PDF, paste (⌘V) or <u>choose</u></span><span class="dz-hint">PDF or image of the statement / invoice</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>`;

const tag = (a, today) => {
  const bal = Number(a.balance) || 0; const late = FS.lateDays(a, today);
  if (bal <= 0) return html`<span class="fs-tag paid">paid</span>`;
  if ((Number(a.paid) || 0) > 0) return html`<span class="fs-tag part">part paid</span>`;
  if (late > 0) return html`<span class="fs-tag late">${late} day${late === 1 ? '' : 's'} overdue</span>`;
  return html`<span class="fs-tag open">due ${shortDay(a.due_date)}</span>`;
};

module.exports = function fwdStatementRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const now = () => new Date().toISOString();
  const by = () => require('../staff').current()?.name || 'Admin';
  const loadSt = async (sid) => { const st = await db.get('fwd_statements', sid).catch(() => null); if (!st) throw new HttpError(404, 'Statement not found'); return st; };
  const serve = (res, buf, f) => { res.statusCode = 200; res.setHeader('Content-Type', f.type || 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `${/pdf|image/.test(f.type || '') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name || 'statement')}`); res.end(buf); };
  const shipOpts = (conts) => [['', 'Not assigned'], ...conts.slice().sort((a, b) => String(b.fwd?.etd || b.created_at || '').localeCompare(String(a.fwd?.etd || a.created_at || ''))).slice(0, 300)
    .map((c) => [c.id, html`${SN.shipName(c)}${c.fwd?.mbl_no || c.fwd?.eta ? html` <span class="sub">${[c.fwd?.mbl_no ? `B/L ${c.fwd.mbl_no}` : '', c.fwd?.eta ? `ETA ${shortDay(c.fwd.eta)}` : ''].filter(Boolean).join(' · ')}</span>` : ''}`])];

  // ── upload ───────────────────────────────────────────────────────────────
  router.post(SBASE, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 26 * 1024 * 1024 });
    const back = safeBack(f.back) || FBASE;
    const file = [].concat(files.file || [])[0];
    if (!file?.buffer?.length) { flash(res, 'error', 'Choose the statement PDF'); return res.redirect(back); }
    if (!require('../ai').enabled()) { flash(res, 'error', 'AI is not set up (ANTHROPIC_API_KEY), so statements cannot be read'); return res.redirect(back); }
    let parsed;
    try { parsed = await FS.read(file); } catch (e) { flash(res, 'error', `Could not read the statement: ${String(e.message).slice(0, 200)}`); return res.redirect(back); }
    if (!parsed.invoices.length) { flash(res, 'warn', 'No invoices found on this file. Is it a forwarder statement or invoice?'); return res.redirect(back); }
    const fwds = await db.list('forwarders', { order: 'company.asc' }).catch(() => []);
    const fwd = fwds.find((x) => x.id === f.forwarder_id) || FS.guessForwarder(fwds, parsed.forwarder);
    const ext = (String(file.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || 'pdf';
    const path = `fwd-statements/${new Date().toISOString().slice(0, 7)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    await db.docs.upload(path, file.buffer, MIME[ext] || 'application/pdf');
    let st;
    try { st = await db.insert('fwd_statements', { forwarder_id: fwd?.id || null, statement_date: parsed.statement_date, status: 'review', file: { name: String(file.name).slice(0, 200), path, type: MIME[ext] || 'application/pdf', size: file.buffer.length }, parsed, created_by: by(), created_at: now() }); }
    catch (e) { if (FS.missing(e)) { flash(res, 'error', 'Run supabase/forwarder-statements.sql in Supabase first'); return res.redirect(back); } throw e; }
    res.redirect(`${SBASE}/${st.id}?back=${encodeURIComponent(back)}`);
  }));

  // ── review ───────────────────────────────────────────────────────────────
  router.get(`${SBASE}/:sid`, G(async (req, res) => {
    const st = await loadSt(req.params.sid); const p = st.parsed || { invoices: [], totals: {}, sums: {}, checks: {} };
    const fwds = await db.list('forwarders', { order: 'company.asc' }).catch(() => []);
    const fwd = fwds.find((x) => x.id === st.forwarder_id) || null;
    const conts = await db.list('plan_containers').catch(() => []);
    const rows = await FS.review(db, st, fwd);
    const today = PL.today(); const opts = shipOpts(conts);
    const matched = rows.filter((r) => r.container_id).length; const back = safeBack(req.query.back) || (fwd ? `${FBASE}/${fwd.id}` : FBASE);
    const chk = (ok, txt) => (ok ? html`<span class="fs-ok">✓ ${txt}</span>` : html`<span class="fs-bad">⚠ doesn't add up — check</span>`);
    const why = (r) => html`<span class="fs-why ${r.how === 'id' || r.how === 'saved' ? 'ok' : r.how === 'po' ? 'chk' : 'no'}">${r.how === 'none' ? r.why : `${r.how === 'po' ? '≈' : '✓'} ${r.why}`}</span>`;
    const saved = st.status === 'saved';
    res.html(page({
      title: 'Review statement', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`<nav class="crumb"><a href="${FBASE}">Forwarders</a>${fwd ? html` › <a href="${FBASE}/${fwd.id}">${fwd.company}</a>` : ''}</nav>
        <div class="fs-head"><div><h1>${saved ? 'Statement' : 'Review statement'}</h1><p class="sub">${saved ? `Saved ${fmt.date(st.saved_at)}.` : `AI read ${rows.length} invoice${rows.length === 1 ? '' : 's'} and matched ${matched} to your shipments. Check the matches, then save.`}</p></div></div>
        <div class="fs-src"><span class="fs-ic">${(String(st.file?.name || '').match(/\.([a-z0-9]+)$/i) || [, 'PDF'])[1].toUpperCase().slice(0, 4)}</span><span><a href="${SBASE}/${st.id}/file" target="_blank" rel="noopener"><b>${st.file?.name || 'statement'}</b></a><span class="sub"> · ${p.forwarder || 'forwarder not printed'}${p.statement_date ? ` · statement date ${shortDay(p.statement_date)}` : ''} · ${p.currency || 'USD'}${p.credit_term ? ` · credit term ${p.credit_term}` : ''}</span></span></div>
        <div class="fs-kpis">
          <div class="fs-kpi"><small>Invoices</small><b>${rows.length}</b>${p.totals?.records ? chk(p.checks?.records, `matches "${p.totals.records} record(s)"`) : ''}</div>
          <div class="fs-kpi"><small>Billed</small><b>${money(p.sums?.amount)}</b>${p.totals?.amount != null ? chk(p.checks?.amount, 'adds up') : ''}</div>
          <div class="fs-kpi ok"><small>Paid</small><b>${money(p.sums?.paid)}</b>${p.totals?.paid != null ? chk(p.checks?.paid, 'adds up') : ''}</div>
          <div class="fs-kpi due"><small>Balance due</small><b>${money(p.sums?.balance)}</b>${p.totals?.balance != null ? chk(p.checks?.balance, 'adds up') : ''}</div>
          <div class="fs-kpi"><small>Matched</small><b>${matched} of ${rows.length}</b><span class="sub">${rows.length - matched ? `${rows.length - matched} to choose` : 'all matched'}</span></div></div>
        <form method="post" action="${SBASE}/${st.id}/save" data-busy>
          <input type="hidden" name="back" value="${back}">
          ${fwd ? html`<input type="hidden" name="forwarder_id" value="${fwd.id}">` : html`<div class="notice warn fs-fwd"><b>Which forwarder?</b> "${p.forwarder || 'unknown'}" is not in your forwarders. ${ddSel('forwarder_id', '', [['', 'Choose…'], ...fwds.map((x) => [x.id, x.company])])} <a href="${FBASE}">Add it first</a> if it's new.</div>`}
          <section class="card flush"><div class="table-wrap"><table class="list fs-table"><thead><tr><th>Invoice</th><th>Master B/L · booking</th><th>Ref (POs)</th><th class="r">Amount</th><th class="r">Balance</th><th>Shipment</th></tr></thead><tbody>
            ${rows.map((r, i) => html`<tr>
              <td class="fs-inv"><b>${r.invoice_no}</b>${r.isNew ? html` <span class="fs-tag new">new</span>` : html` <span class="fs-tag known">saved</span>`}<small>${shortDay(r.invoice_date)}${r.due_date ? ` · due ${shortDay(r.due_date)}` : ''}</small>${r.file_no ? html`<small class="mono">${r.file_no}</small>` : ''}
                ${r.changes.length ? html`<small class="fs-chg">${r.changes.join(' · ')}</small>` : ''}<input type="hidden" name="${`inv_${i}`}" value="${r.invoice_no}"></td>
              <td>${r.mbl_no ? html`<span class="mono">${r.mbl_no}</span>` : '—'}${r.booking_no ? html`<small class="sub2">Booking <span class="mono">${r.booking_no}</span></small>` : ''}</td>
              <td class="fs-refs">${r.refs ? r.refs.split(/\s*[,;]\s*/).map((x) => html`<span>${x}</span>`) : '—'}</td>
              <td class="r"><b>${money(r.amount)}</b>${r.paid ? html`<small class="fs-paid">paid ${money(r.paid)}</small>` : ''}${r.payments.length ? html`<small class="sub2">${r.payments.map((x) => [shortDay(x.date), x.ref].filter((y) => y && y !== '—').join(' ')).join(' · ')}</small>` : ''}</td>
              <td class="r"><b class="${(r.balance || 0) > 0 ? 'fs-open' : 'fs-paid'}">${money(r.balance)}</b>${tag(r, today)}</td>
              <td class="fs-ship">${saved ? html`${r.container_id ? html`<a href="/admin/orders/shipments/${r.container_id}">${SN.shipName(conts.find((c) => c.id === r.container_id) || {})}</a>` : html`<span class="sub">not assigned</span>`}` : ddSel(`c_${i}`, r.container_id || '', opts, { cls: 'fs-dd' })}${why(r)}</td></tr>`)}
          </tbody></table></div></section>
          ${saved ? '' : html`<div class="fs-foot"><button class="btn">Save ${rows.length} invoice${rows.length === 1 ? '' : 's'}</button><button class="btn ghost" formaction="${SBASE}/${st.id}/discard" formnovalidate>Discard</button><span class="sub">Saved on each shipment and on the forwarder. The next statement updates paid amounts — no duplicates.</span></div>`}
        </form>`,
    }));
  }));

  router.post(`${SBASE}/:sid/save`, G(async (req, res) => {
    const st = await loadSt(req.params.sid); const { fields: f } = await parseForm(req);
    const fwd = await db.get('forwarders', String(f.forwarder_id || st.forwarder_id || '')).catch(() => null);
    if (!fwd) { flash(res, 'error', 'Choose the forwarder first'); return res.redirect(`${SBASE}/${st.id}`); }
    const choices = {}; for (const [k, v] of Object.entries(f)) { const m = k.match(/^inv_(\d+)$/); if (m) choices[String(v)] = String(f[`c_${m[1]}`] || ''); }
    let r; try { r = await FS.save(db, st, fwd, choices, by()); } catch (e) { if (FS.missing(e)) { flash(res, 'error', 'Run supabase/forwarder-statements.sql in Supabase first'); return res.redirect(`${SBASE}/${st.id}`); } throw e; }
    flash(res, 'ok', `Statement saved: ${[r.added ? `${r.added} new invoice${r.added === 1 ? '' : 's'}` : '', r.updated ? `${r.updated} updated` : ''].filter(Boolean).join(', ') || 'nothing changed'}`);
    res.redirect(`${FBASE}/${fwd.id}`);
  }));

  router.post(`${SBASE}/:sid/discard`, G(async (req, res) => {
    const st = await loadSt(req.params.sid); const { fields: f } = await parseForm(req).catch(() => ({ fields: {} }));
    if (st.status !== 'saved') { if (st.file?.path) await db.docs.remove([st.file.path]).catch(() => {}); await db.remove('fwd_statements', { id: st.id }); flash(res, 'ok', 'Statement discarded'); }
    res.redirect(safeBack(f?.back) || (st.forwarder_id ? `${FBASE}/${st.forwarder_id}` : FBASE));
  }));

  router.get(`${SBASE}/:sid/file`, G(async (req, res) => {
    const st = await loadSt(req.params.sid); if (!st.file?.path) throw new HttpError(404, 'No file');
    serve(res, await db.docs.download(st.file.path), st.file);
  }));

  // ── forwarder page ───────────────────────────────────────────────────────
  router.get(`${FBASE}/:id`, G(async (req, res) => {
    const fwd = await db.get('forwarders', req.params.id).catch(() => null); if (!fwd) throw new HttpError(404, 'Forwarder not found');
    const invs = (await FS.savedFor(db, fwd)).sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
    const sts = (await db.list('fwd_statements', { filters: { forwarder_id: fwd.id }, order: 'created_at.desc' }).catch(() => []));
    const conts = await db.list('plan_containers').catch(() => []);
    const today = PL.today(); const ag = FS.aging(invs, today); const quotes = (await db.list('plan_quotes').catch(() => [])).filter((q) => q.forwarder_id === fwd.id);
    const pending = sts.filter((s) => s.status === 'review');
    const shipName = (cid) => { const c = conts.find((x) => x.id === cid); return c ? SN.shipName(c) : null; };
    res.html(page({
      title: `${fwd.company} · Forwarders`, nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`<nav class="crumb"><a href="${FBASE}">Forwarders</a></nav>
        <div class="fs-head"><div><h1>${fwd.company}</h1><p class="sub">${[fwd.contact_name, fwd.email, fwd.phone].filter(Boolean).join(' · ')}${quotes.length ? ` · ${quotes.length} quote request${quotes.length === 1 ? '' : 's'}` : ''}</p></div>
          <button type="button" class="btn" data-open-dialog="fs-up1">Upload statement</button></div>
        ${pending.length ? html`<div class="notice warn">${pending.length} statement${pending.length === 1 ? '' : 's'} not saved yet: ${pending.map((s, n) => html`${n ? ' · ' : ''}<a href="${SBASE}/${s.id}">${s.file?.name || 'statement'} (${fmt.date(s.created_at)})</a>`)}</div>` : ''}
        <div class="fs-aging">
          <div class="fs-ag tot"><small>Open balance</small><b>${money(ag.total)}</b></div>
          <div class="fs-ag"><small>Not due yet</small><b>${money(ag.current)}</b></div>
          <div class="fs-ag ${ag.d30 ? 'hot' : ''}"><small>1–30 days late</small><b>${money(ag.d30)}</b></div>
          <div class="fs-ag ${ag.d60 ? 'hot' : ''}"><small>31–60</small><b>${money(ag.d60)}</b></div>
          <div class="fs-ag ${ag.d90 + ag.d90p ? 'hot' : ''}"><small>61+</small><b>${money(r2(ag.d90 + ag.d90p))}</b></div></div>
        <section class="card flush"><h2 class="sec fs-sec">Invoices <span class="count">${invs.length}</span></h2>
          ${invs.length ? html`<div class="table-wrap"><table class="list fs-table"><thead><tr><th>Invoice</th><th>Shipment</th><th>B/L · Ref</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Balance</th><th></th></tr></thead><tbody>
            ${invs.map((a) => html`<tr class="${(Number(a.balance) || 0) <= 0 && a.balance != null ? 'done' : ''}"><td class="fs-inv"><b>${a.invoice_no || '—'}</b><small>${shortDay(a.invoice_date)}${a.due_date ? ` · due ${shortDay(a.due_date)}` : ''}</small>${a.file_no ? html`<small class="mono">${a.file_no}</small>` : ''}</td>
              <td>${a.container_id && shipName(a.container_id) ? html`<a href="/admin/orders/shipments/${a.container_id}">${shipName(a.container_id)}</a>` : html`<span class="sub">not assigned</span>`}</td>
              <td>${a.mbl_no ? html`<span class="mono">${a.mbl_no}</span>` : ''}${a.refs ? html`<small class="sub2">${a.refs}</small>` : ''}</td>
              <td class="r">${money(a.amount ?? (a.lines || []).reduce((s, l) => s + (Number(l.usd) || 0), 0))}</td><td class="r">${a.paid ? money(a.paid) : '—'}${(a.payments || []).length ? html`<small class="sub2">${a.payments.map((x) => x.ref).filter(Boolean).join(', ')}</small>` : ''}</td>
              <td class="r"><b class="${(Number(a.balance) || 0) > 0 ? 'fs-open' : ''}">${a.balance != null ? money(a.balance) : '—'}</b></td><td class="r">${a.balance != null ? tag(a, today) : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="d-empty">No invoices yet. Upload a statement: every invoice on it is matched to its shipment.</p>`}</section>
        ${sts.filter((s) => s.status === 'saved').length ? html`<section class="card"><h2 class="sec">Statements</h2><ul class="fs-sts">${sts.filter((s) => s.status === 'saved').map((s) => html`<li><a href="${SBASE}/${s.id}/file" target="_blank" rel="noopener">${s.file?.name || 'statement'}</a> <span class="sub">${s.statement_date ? `dated ${shortDay(s.statement_date)} · ` : ''}${(s.parsed?.invoices || []).length} invoices · balance ${money(s.parsed?.sums?.balance)} · uploaded ${fmt.date(s.created_at)}</span> <a class="link small" href="${SBASE}/${s.id}">View</a></li>`)}</ul></section>` : ''}
        <dialog id="fs-up1" class="rp-modal fs-dlg" aria-labelledby="fs-up1-t"><form method="post" action="${SBASE}" enctype="multipart/form-data">
          <div class="rp-top"><h2 id="fs-up1-t">Upload statement · ${fwd.company}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
          <p class="sub">A statement of account or one invoice. AI reads every invoice and matches it to your shipments; you check before saving.</p>
          <input type="hidden" name="forwarder_id" value="${fwd.id}"><input type="hidden" name="back" value="${FBASE}/${fwd.id}">${dropBox()}
          <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn" data-busy>Read statement</button></div></form></dialog>`,
    }));
  }));
};
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
module.exports.uploadDialog = uploadDialog;

/** Freight invoices card for a shipment page. */
module.exports.shipmentCard = async function shipmentCard(db, containerId) {
  const invs = (await db.list('freight_actuals').catch(() => [])).filter((a) => a.container_id === containerId && (a.amount != null || (a.lines || []).length));
  if (!invs.length) return '';
  const today = PL.today();
  const tot = (k) => invs.reduce((s, a) => s + (Number(a[k]) || 0), 0);
  const amt = (a) => a.amount ?? (a.lines || []).reduce((s, l) => s + (Number(l.usd) || 0), 0);
  return html`<section class="card fs-shp"><h2 class="sec">Freight invoices <span class="count">${invs.length}</span>${tot('balance') > 0 ? html`<span class="fs-tag late fs-r">${money(tot('balance'))} open</span>` : ''}</h2>
    <ul class="fs-list">${invs.map((a) => html`<li><span><b>${a.company || 'Forwarder'} · ${a.invoice_no || 'invoice'}</b><small class="sub2">${shortDay(a.invoice_date)}${a.due_date ? ` · due ${shortDay(a.due_date)}` : ''}${a.mbl_no ? ` · B/L ${a.mbl_no}` : ''}${a.forwarder_id ? '' : ' · from a freight invoice'}</small></span>
      <span class="r"><b>${money(amt(a))}</b>${a.paid ? html`<small class="sub2">paid ${money(a.paid)}${(a.payments || []).map((x) => x.ref).filter(Boolean).length ? ` · ${(a.payments || []).map((x) => x.ref).filter(Boolean).join(', ')}` : ''}</small>` : ''}${a.balance != null ? tag(a, today) : ''}</span></li>`)}</ul>
    ${invs.some((a) => a.forwarder_id) ? html`<p class="sub">From forwarder statements · <a href="${FBASE}/${invs.find((a) => a.forwarder_id).forwarder_id}">open the forwarder</a></p>` : ''}</section>`;
};
