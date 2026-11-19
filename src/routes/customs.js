'use strict';
// Logistics → Customs: entries (CBP 7501), statistics, the add / review dialog's JSON, and the 7501 files.

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const SCR = require('./schedules');
const SC = require('../schedules');
const PL = require('../planning');
const CU = require('../customs');
const AI = require('../ai');

const BASE = '/admin/logistics/customs';
const usd = (v, d = 0) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const portName = (c) => SC.PORT[c]?.name || c || '';

async function entries(db) {
  try { return { rows: await db.list('customs_entries', { order: 'entry_date.desc' }) }; }
  catch (e) { if (CU.missingTable(e)) return { rows: [], missing: true }; throw e; }
}

/** JSON for the dialog. */
/** The broker's address: from this entry's email, else from an earlier entry by the same broker. */
async function brokerEmail(db, e) {
  const b = String(e.facts?.broker || '').toLowerCase(); if (!b) return '';
  const prev = (await db.list('customs_entries').catch(() => [])).find((x) => x.id !== e.id && x.from_email && !/lulyboo/i.test(x.from_email) && String(x.facts?.broker || '').toLowerCase() === b);
  return prev ? String(prev.from_email).replace(/^.*<([^>]+)>.*$/, '$1').trim() : '';
}

async function viewOf(db, e) {
  const c = e.container_id ? await db.get('plan_containers', e.container_id).catch(() => null) : null;
  let cname = null;
  if (c) cname = require('../shipname').shipName(c);
  const f = e.facts || {};
  const lines = (e.lines || []).map((l) => ({ ...l, rate_total: CU.lineRate(l), value_pc: l.value && l.qty ? Math.round((l.value / l.qty) * 100) / 100 : null }));
  const suggestions = lines.filter((l) => l.suggestion && l.suggestion.verdict === 'suggest' && l.suggestion.hts).length;
  // products: linked (by SKU / confirmed / by hand), suggested by name (to confirm), not found; declared HTS ≠ product file
  const prods = lines.flatMap((l) => (l.products || []).map((p) => ({ l, p })));
  const linkSum = { total: prods.length, linked: prods.filter(({ p }) => p.product_id && p.how !== 'name').length, toConfirm: prods.filter(({ p }) => p.product_id && p.how === 'name').length, none: prods.filter(({ p }) => !p.product_id).length,
    htsDiff: prods.filter(({ l, p }) => p.product_id && p.hts_on_file && CU.digits(p.hts_on_file).slice(0, 8) !== CU.digits(l.hts).slice(0, 8)).map(({ l, p }) => ({ code: p.code, file: CU.fmtHts(p.hts_on_file), declared: l.hts })) };
  return {
    id: e.id, status: e.status, entry_no: e.entry_no, entry_date: e.entry_date ? PL.short(String(e.entry_date).slice(0, 10)) : '', summary: f.summary || '',
    meta: [e.entry_date ? `Entry ${PL.short(String(e.entry_date).slice(0, 10))}` : '', f.port_code ? `Port ${f.port_code}` : '', f.carrier, f.voyage ? `voyage ${f.voyage}` : '', f.broker ? `Broker ${f.broker}${f.broker_file ? ` (file ${f.broker_file})` : ''}` : '', f.export_date ? `Exported ${PL.short(f.export_date)}` : '', f.importer_last4 ? `Importer ••••${f.importer_last4}` : ''].filter(Boolean),
    container: c ? { id: c.id, name: cname, port: c.port, reason: e.match_reason || '' } : null,
    pos: e.pos || [], hbls: e.hbls || [], mbl: e.mbl || '',
    value: e.entered_value, duty: e.duty, fees: e.fees, total: e.total, mpf: f.mpf, hmf: f.hmf, rate: pct(e.duty || 0, e.entered_value), totalRate: pct(e.total || 0, e.entered_value),
    lines, checks: e.checks || [], suggestions, linkSum,
    broker: CU.brokerDraft(e, { to: e.from_email && !/lulyboo/i.test(e.from_email) ? String(e.from_email).replace(/^.*<([^>]+)>.*$/, '$1').trim() : (await brokerEmail(db, e)) || '' }),
    files: (e.files || []).map((x, i) => ({ name: x.name, url: `${BASE}/${e.id}/file/${i}`, inline: /pdf|image/.test(x.type || '') })),
  };
}

function statsOf(rows) {
  const saved = rows.filter((r) => r.status === 'saved');
  const year = String(new Date().getFullYear());
  const yr = saved.filter((r) => String(r.entry_date || '').startsWith(year));
  const months = {};
  for (const r of saved) { const m = String(r.entry_date || r.created_at || '').slice(0, 7); if (!m) continue; (months[m] ||= { value: 0, duty: 0, n: 0 }); months[m].value += Number(r.entered_value) || 0; months[m].duty += Number(r.duty) || 0; months[m].n++; }
  const mk = Object.keys(months).sort().slice(-12);
  const hts = {};
  for (const r of [...saved].sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)))) for (const l of r.lines || []) {
    const k = CU.digits(l.hts).slice(0, 10); if (!k) continue;
    (hts[k] ||= { hts: l.hts, description: l.description, value: 0, duty: 0, rate: 0, n: 0 });
    hts[k].value += Number(l.value) || 0; hts[k].duty += Number(l.duty) || 0; hts[k].rate = CU.lineRate(l); hts[k].n++; hts[k].description = l.description || hts[k].description;
  }
  const prods = {};
  for (const r of saved) for (const l of r.lines || []) for (const p of l.products || []) {
    if (!p.product_id) continue;
    (prods[p.product_id] ||= { name: p.name, code: p.code, rate: CU.lineRate(l), at: r.entry_date });
    if (String(r.entry_date) >= String(prods[p.product_id].at)) Object.assign(prods[p.product_id], { rate: CU.lineRate(l), at: r.entry_date });
  }
  const top = Object.values(prods).sort((a, b) => b.rate - a.rate)[0] || null;
  const toCheck = rows.filter((r) => ['saved', 'pending'].includes(r.status)).reduce((a, r) => a + (r.lines || []).filter((l) => l.suggestion?.verdict === 'suggest' && l.suggestion?.hts && l.suggestion.status === 'open').length, 0);
  return {
    year, yrDuty: yr.reduce((a, r) => a + (Number(r.duty) || 0), 0), yrValue: yr.reduce((a, r) => a + (Number(r.entered_value) || 0), 0), yrFees: yr.reduce((a, r) => a + (Number(r.fees) || 0), 0), yrN: yr.length,
    months: mk.map((m) => ({ m, label: new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), rate: pct(months[m].duty, months[m].value), n: months[m].n })),
    hts: Object.values(hts).sort((a, b) => b.duty - a.duty), top, toCheck,
  };
}

module.exports = function customsRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const J = (fn) => G(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req, res)) }); }
    catch (e) { res.json({ ok: false, error: CU.missingTable(e) ? 'Run the customs SQL in Supabase first (supabase/schema.sql, "Customs entries").' : e.message }, e.status || 400); }
  });
  const getE = async (id) => { const e = await db.get('customs_entries', id).catch(() => null); if (!e) throw new HttpError(404, 'Customs entry not found'); return e; };

  router.get(BASE, G(async (req, res) => {
    const { rows, missing } = await entries(db);
    const s = statsOf(rows);
    const pending = rows.filter((r) => r.status === 'pending');
    const saved = rows.filter((r) => r.status === 'saved');
    const conts = {}; for (const r of saved) if (r.container_id && !conts[r.container_id]) { const c = await db.get('plan_containers', r.container_id).catch(() => null); conts[r.container_id] = c ? `${portName(c.port)} ${c.box === 'LCL' ? 'LCL' : c.box}` : ''; }
    const maxRate = Math.max(1, ...s.months.map((m) => m.rate || 0));
    res.html(page({
      title: 'Customs · Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`${SCR.logisticsTabs('customs')}
        ${missing ? html`<p class="flash warn">Run the customs SQL in Supabase first (supabase/schema.sql, "Customs entries").</p>` : ''}
        <div class="cp-head"><div><h2 class="sl-title">Customs</h2><p class="muted">Entry summaries (CBP 7501): what you pay, on which products, and how it changes. Email them to <b>${CU.customsAddress()}</b> or add them here.</p></div>
          <div class="cp-head-r">${saved.length ? html`<a class="btn ghost small" href="${BASE}/export.csv">Export CSV</a>` : ''}<button type="button" class="btn" data-cu-add ${AI.enabled() ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>＋ Add customs entry</button></div></div>
        <div data-customs="${JSON.stringify({ base: BASE, review: req.query.review || '' })}"></div>
        ${pending.length ? html`<section class="card cu-pend"><h2 class="sec">To review <span class="sub">${pending.length}</span></h2>${pending.map((r) => html`<div class="cu-pr"><b class="cu-mono">${r.entry_no || 'Entry'}</b><span class="sub">${r.entry_date ? PL.short(String(r.entry_date).slice(0, 10)) : ''} · ${usd(r.duty, 2)} duty on ${usd(r.entered_value)}${r.from_email ? ` · from ${r.from_email}` : ''}</span><button type="button" class="btn small" data-cu-open="${r.id}">Review</button></div>`)}</section>` : ''}
        ${saved.length ? html`
        <div class="cu-kp">
          <div><span>Duty · ${s.year}</span><b>${usd(s.yrDuty)}</b><small>${s.yrN} entr${s.yrN === 1 ? 'y' : 'ies'}</small></div>
          <div><span>Effective rate</span><b>${s.yrValue ? `${pct(s.yrDuty, s.yrValue)}%` : '—'}</b><small>duty ÷ entered value</small></div>
          <div><span>Fees (MPF + HMF)</span><b>${usd(s.yrFees)}</b><small>${s.yrValue ? `${pct(s.yrFees, s.yrValue)}%` : ''}</small></div>
          <div><span>Highest rate product</span><b>${s.top ? s.top.code : '—'}</b><small>${s.top ? `${s.top.rate}%` : ''}</small></div>
          <div><span>HTS to check</span><b class="${s.toCheck ? 'cu-red' : ''}">${s.toCheck}</b><small>AI suggestions</small></div>
        </div>
        <div class="cu-two">
          <section class="card"><div class="rh-head"><h2 class="sec">Effective duty rate by month</h2><span class="sub">duty ÷ entered value</span></div>
            <div class="cu-bars">${s.months.map((m, i) => html`<div class="cu-bar"><span>${m.rate == null ? '—' : `${m.rate}%`}</span><i class="${i === s.months.length - 1 ? 'now' : ''}" style="height:${Math.max(4, Math.round(((m.rate || 0) / maxRate) * 110))}px" title="${m.n} entr${m.n === 1 ? 'y' : 'ies'}"></i><em>${m.label}</em></div>`)}</div></section>
          <section class="card"><div class="rh-head"><h2 class="sec">By HTS code</h2></div>
            <div class="table-wrap"><table class="list cu-t"><thead><tr><th>HTS</th><th class="r">Value</th><th class="r">Duty</th><th class="r">Rate now</th></tr></thead><tbody>
            ${s.hts.slice(0, 12).map((h) => html`<tr><td><span class="cu-mono hts-tip" data-hts="${h.hts}" tabindex="0">${h.hts}</span><div class="sub">${h.description || ''}</div></td><td class="r">${usd(h.value)}</td><td class="r">${usd(h.duty)}</td><td class="r">${h.rate}%</td></tr>`)}</tbody></table></div></section>
        </div>
        <section class="card flush"><div class="rh-head pad"><h2 class="sec">Entries <span class="sub">${saved.length}</span></h2></div>
          <div class="table-wrap"><table class="list cu-t"><thead><tr><th>Entry</th><th>Date</th><th>Shipment</th><th>POs</th><th class="r">Value</th><th class="r">Duty</th><th class="r">Rate</th><th class="r">Fees</th><th></th></tr></thead><tbody>
          ${saved.map((r) => { const open = (r.lines || []).filter((l) => l.suggestion?.verdict === 'suggest' && l.suggestion?.hts && l.suggestion.status === 'open').length; return html`<tr><td><button type="button" class="link cu-mono" data-cu-open="${r.id}">${r.entry_no || 'Entry'}</button></td><td>${r.entry_date ? PL.short(String(r.entry_date).slice(0, 10)) : '—'}</td><td>${conts[r.container_id] || '—'}</td><td class="sub">${(r.pos || []).join(', ')}</td><td class="r">${usd(r.entered_value)}</td><td class="r"><b>${usd(r.duty)}</b></td><td class="r">${r.entered_value ? `${pct(r.duty || 0, r.entered_value)}%` : '—'}</td><td class="r">${usd(r.fees)}</td><td>${open ? html`<span class="cp-tag wait">${open} HTS to check</span>` : html`<span class="cp-tag ok">Checked</span>`}</td></tr>`; })}
          </tbody></table></div></section>` : !pending.length ? html`<section class="card"><p class="muted">No customs entries yet. Add your first 7501 with “＋ Add customs entry”, or email it to ${CU.customsAddress()}.</p></section>` : ''}`,
    }));
  }));

  router.post(`${BASE}/read`, J(async (req) => {
    const { fields, files } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const list = Object.values(files || {}).flat().filter((x) => x && x.buffer?.length);
    const text = String(fields.text || '').trim();
    if (!list.length && !text) throw new HttpError(400, 'Drop the 7501 PDF or paste it first');
    const e = await CU.createEntry(db, config, { files: list, text, source: 'upload', containerId: fields.container || null, poHint: String(fields.pos || '').split(/[,;\s]+/).filter(Boolean), by: by(req) });
    return { view: await viewOf(db, e) };
  }));
  // hover card for an HTS code anywhere in the portal: GET /admin/logistics/customs/hts?code=9603.21.0000
  router.get(`${BASE}/hts`, J(async (req) => ({ hts: await require('../duty').explainHts(String(req.query.code || '')) })));
  router.get(`${BASE}/:id/view`, J(async (req) => ({ view: await viewOf(db, await getE(req.params.id)) })));
  router.post(`${BASE}/:id/save`, J(async (req) => { const e = await getE(req.params.id); await CU.save(db, e, { by: by(req) }); return { view: await viewOf(db, await getE(e.id)) }; }));
  router.post(`${BASE}/:id/discard`, J(async (req) => { const e = await getE(req.params.id); if (e.status === 'saved') throw new HttpError(400, 'A saved entry stays in the statistics'); await db.update('customs_entries', { id: e.id }, { status: 'discarded' }); return {}; }));
  router.post(`${BASE}/:id/hts`, J(async (req) => {
    const { fields: f } = await parseForm(req);
    const e = await getE(req.params.id);
    const r = await CU.confirmHts(db, e, f.line, f.use, by(req));
    return { ...r, view: await viewOf(db, await getE(e.id)) };
  }));
  // link a 7501 line's product: confirm the suggestion, or pick another product
  router.get(`${BASE}/products`, J(async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase(); if (q.length < 2) return { products: [] };
    const sups = {}; for (const x of await db.list('suppliers').catch(() => [])) sups[x.id] = x.name;
    const list = (await db.list('products').catch(() => [])).filter((p) => !p.archived_at && [p.supplier_sku, p.product_name, p.lulyboo_sku].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 12);
    return { products: list.map((p) => ({ id: p.id, sku: p.supplier_sku || '', name: p.product_name || '', supplier: sups[p.supplier_id] || '' })) };
  }));
  router.post(`${BASE}/:id/link`, J(async (req) => {
    const { fields: f } = await parseForm(req);
    const e = await getE(req.params.id);
    const lines = e.lines || []; const l = lines.find((x) => String(x.no) === String(f.line)); const p = l && (l.products || [])[Number(f.i)];
    if (!p) throw new HttpError(404, 'Line not found');
    if (f.product) {
      const prod = await db.get('products', String(f.product)).catch(() => null); if (!prod) throw new HttpError(404, 'Product not found');
      Object.assign(p, { product_id: prod.id, name: prod.product_name || p.name, supplier_id: prod.supplier_id, how: 'manual', hts_on_file: prod.hts_verified_code || null, supplier_hs: prod.hs_code || null });
    } else if (f.unlink) Object.assign(p, { product_id: null, how: null, hts_on_file: null });
    else if (p.product_id) p.how = 'confirmed';
    await db.update('customs_entries', { id: e.id }, { lines });
    // the comparisons depend on the product: re-run them
    try { const ch = await CU.checks(db, { ...(e.facts || {}), entry_no: e.entry_no, lines }, { selfId: e.id }); await db.update('customs_entries', { id: e.id }, { checks: ch }); } catch (err) { console.error('Customs re-check failed:', err.message); }
    if (e.status === 'saved' && p.product_id) await CU.setPaid(db, p.product_id, { rate: CU.lineRate(l), at: e.entry_date, entry: e.entry_no });
    return { view: await viewOf(db, await getE(e.id)) };
  }));
  router.get(`${BASE}/:id/file/:i`, G(async (req, res) => {
    const e = await getE(req.params.id);
    const f = (e.files || [])[Number(req.params.i)]; if (!f) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(f.path);
    const type = f.type || 'application/octet-stream';
    const inline = req.query.inline === '1' && /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(type);
    const head = { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    res.writeHead(200, head); res.end(buf);
  }));
  router.get(`${BASE}/export.csv`, G(async (req, res) => {
    const { rows } = await entries(db);
    const head = ['Entry', 'Entry date', 'Line', 'Description', 'HTS', 'Base rate %', 'Chapter 99', 'Total rate %', 'Qty', 'Unit', 'Gross kg', 'Entered value', 'Duty', 'MPF', 'HMF', 'Products', 'POs', 'HTS suggestion'];
    const out = [head.join(',')];
    for (const r of rows.filter((x) => x.status === 'saved')) for (const l of r.lines || []) out.push([r.entry_no, String(r.entry_date || '').slice(0, 10), l.no, l.description, l.hts, l.rate, (l.extras || []).map((x) => `${x.code} ${x.rate}%`).join(' + '), CU.lineRate(l), l.qty, l.unit, l.kg, l.value, l.duty, l.mpf, l.hmf, (l.products || []).map((p) => p.code).join(' + '), (l.pos || []).join(' + '), l.suggestion?.hts && l.suggestion.status === 'open' ? l.suggestion.hts : ''].map(csvCell).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customs-entries-${PL.today()}.csv"`, 'Cache-Control': 'private, no-store' });
    res.end(`﻿${out.join('\n')}`);
  }));
};

/** Saved entries that include a product — for its page. */
async function forProduct(db, productId) {
  const rows = await db.list('customs_entries', { order: 'entry_date.desc' }).catch(() => []);
  const out = [];
  for (const r of rows.filter((x) => x.status === 'saved')) for (const l of r.lines || []) for (const p of l.products || []) if (p.product_id === productId) out.push({ id: r.id, entry_no: r.entry_no, date: r.entry_date, po: p.po, qty: p.qty, value_pc: p.value && p.qty ? p.value / p.qty : null, hts: l.hts, rate: CU.lineRate(l), per_pc: p.per_pc, extras: l.extras || [], base: l.rate });
  return out;
}
/** Saved entries that include a PO — for the PO page, with duty allocated to the PO's products. */
async function forPo(db, po) {
  const rows = await db.list('customs_entries', { order: 'entry_date.desc' }).catch(() => []);
  const k = PL.normPo(po); const out = [];
  for (const r of rows.filter((x) => x.status === 'saved' && (x.pos || []).some((p) => PL.normPo(p) === k))) {
    let duty = 0; let fees = 0; const items = [];
    for (const l of r.lines || []) for (const p of l.products || []) if (p.po && PL.normPo(p.po) === k) { duty += p.duty || 0; fees += p.fees || 0; items.push(`${p.code} ${CU.lineRate(l)}%`); }
    out.push({ id: r.id, entry_no: r.entry_no, date: r.entry_date, duty: Math.round(duty * 100) / 100, fees: Math.round(fees * 100) / 100, items, total: r.total });
  }
  return out;
}
Object.assign(module.exports, { forProduct, forPo, viewOf, BASE });
