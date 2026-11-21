'use strict';
// Orders menu: every purchase order (from Container planning lines), one row per supplier + PO,
// and a PO page with its lines, status and documents.

const { html, raw, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const PR = require('./planning');
const LP = require('./loadplan');
const money = (v, cur, dp = 2) => `${!cur || cur === 'USD' ? '$' : `${cur} `}${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dp })}`;
const AI = require('../ai');

const RANK = { overdue: 5, waiting: 4, production: 3, ready: 2, booked: 1.5, shipped: 1 };
const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const int = (v) => Number(v || 0).toLocaleString('en-US');
const n1 = (v) => (Math.round(Number(v || 0) * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** Packing math for PO lines: cartons and gross kg (given, else calculated), and the shipping picture for a whole PO. */
const PK = {
  ctn: (o) => (Number(o.cartons) > 0 ? Number(o.cartons) : o.qty && Number(o.units_per_carton) > 0 ? Math.ceil(Number(o.qty) / Number(o.units_per_carton)) : null),
  kg: (o) => { if (Number(o.gross_kg) > 0) return Number(o.gross_kg); const c = PK.ctn(o); return c && Number(o.carton_gw_kg) > 0 ? c * Number(o.carton_gw_kg) : null; },
  /** LCL up to PL.LCL_MAX m³ (charged per W/M = max(m³, t)); above that FCL with the boxes PL.suggest would pick. */
  shipping(cbm, kg, ctns) {
    if (!(cbm > 0)) return null;
    const hq = PL.BOXES.find((b) => b.code === '40HQ');
    const mode = cbm <= (PL.LCL_MAX || 15) ? 'LCL' : 'FCL';
    let boxes = '';
    if (mode === 'FCL') { const fits = PL.BOXES.slice().sort((a, b) => a.cap - b.cap).find((b) => b.cap >= cbm); boxes = fits ? `1 × ${fits.code.replace(/^(\d\d)/, "$1' ")}` : `${Math.ceil(cbm / hq.cap)} × 40' HQ`; }
    return { mode, boxes, cap: hq.cap, pct: Math.round((cbm / hq.cap) * 100), wm: Math.max(cbm, (kg || 0) / 1000), byWeight: (kg || 0) / 1000 > cbm, avgKg: ctns && kg ? kg / ctns : null };
  },
};
const portName = (c) => SC.PORT[c]?.name || null;
/** A line's container as a compact two-line chip: what and where (box · route), then status and sailing. */
function ctnChip(x, note = '') {
  const parts = require('../shipname').shipName(x.c, { sailing: x.c.sailing }).split(' · ').map((t) => t.trim()).filter(Boolean);
  let when = /^(Sails ~|Not scheduled yet)/.test(parts[0] || '') ? parts.shift() : null;
  const etd = x.c.fwd?.atd || x.c.fwd?.etd || x.c.sailing?.etd;
  if (!when && etd) when = `Sails ~${PL.short(String(etd).slice(0, 10))}`;
  const cut = x.c.status === 'booked' && (x.c.fwd?.cfs_cutoff || x.c.fwd?.cy_cutoff);
  const st = x.c.status === 'booked' ? ['booked', 'Booked'] : x.c.status === 'requested' ? ['req', 'Quotes requested'] : x.c.status === 'shipped' ? ['shipped', 'Shipped'] : ['plan', 'Planned'];
  return html`<a class="or-chip" href="${x.url}" title="${`Open on Load containers: ${x.text}`}"><span class="or-chip-i" aria-hidden="true">📦</span><span class="or-chip-t"><b>${parts.join(' · ')}</b><small><i class="${`or-dot ${st[0]}`}"></i>${st[1]}${cut ? ` · ${x.c.box === 'LCL' ? 'CFS' : 'CY'} ${PL.short(String(cut).slice(0, 10))}` : ''}${when ? ` · ${when.replace('Not scheduled yet', 'no sailing yet').replace('Sails ~', 'sails ~')}` : ''}${note ? ` · ${note}` : ''}</small></span></a>`;
}
// container column icons: box with + (add), arrows (move)
const ICON_ADD = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 6.5 9 3.5l6.5 3v7L9 16.5l-6.5-3z"/><path d="M2.5 6.5 9 9.5l6.5-3M9 9.5v7"/><path d="M16 1.5v5M13.5 4h5" stroke-linecap="round"/></svg>';
const ICON_MOVE = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h12l-3-3M17 13H5l3 3"/></svg>';
const poUrl = (supplierId, po) => `/admin/orders/view?supplier=${encodeURIComponent(supplierId)}&po=${encodeURIComponent(po)}`;
const tag = (st) => html`<span class="cp-tag ${PL.STATE[st].tag}">${PL.STATE[st].label}</span>`;

/** Group order lines into POs. */
function groupPos(lines, sups, files, day) {
  const map = new Map();
  for (const o of lines) {
    const key = `${o.supplier_id}|${PL.normPo(o.po)}`;
    if (!map.has(key)) map.set(key, { key, supplier_id: o.supplier_id, supplier: sups[o.supplier_id], po: o.po, lines: [] });
    map.get(key).lines.push({ ...o, st: PL.state(o, day) });
  }
  return [...map.values()].map((p) => {
    const ls = p.lines; const open = ls.filter((l) => !l.shipped);
    const dates = ls.map((l) => l.ready_date).filter(Boolean).sort();
    const st = open.length ? open.reduce((a, l) => (RANK[l.st] > RANK[a] ? l.st : a), 'shipped') : 'shipped';
    const ports = [...new Set(ls.map((l) => l.port).filter(Boolean))];
    const docs = files.filter((f) => f.supplier_id === p.supplier_id && (f.pos || []).some((x) => PL.normPo(x) === PL.normPo(p.po)));
    return {
      ...p, st, products: ls.map((l) => l.product).filter(Boolean), qty: ls.reduce((a, l) => a + (Number(l.qty) || 0), 0),
      cbm: ls.reduce((a, l) => a + (Number(l.cbm) || 0), 0), cbmMissing: ls.some((l) => !l.cbm), first: dates[0] || null, last: dates[dates.length - 1] || null,
      ports, docs, pending: [...new Set(open.map((l) => l.pending_from_us).filter((x) => x && PL.state({ pending_from_us: x }, day) === 'waiting'))],
      updated: ls.map((l) => l.updated_at || l.created_at).filter(Boolean).sort().pop() || null,
    };
  });
}

module.exports = function orderRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  async function load() {
    let lines = []; let missing = false;
    try { lines = await db.list('plan_orders', { order: 'ready_date.asc' }); }
    catch (e) { if (/plan_orders|PGRST205|relation/i.test(e.message)) missing = true; else throw e; }
    const noVol = [...new Set(lines.filter((o) => !o.shipped && o.product && !(Number(o.cbm) > 0)).map((o) => o.supplier_id))];
    let changed = 0;
    for (const sid of noVol) changed += await PL.fillVolumes(db, sid).catch(() => 0);
    if (changed) lines = await db.list('plan_orders', { order: 'ready_date.asc' });
    await require('../forwarding').healShipped(db, lines, await db.list('plan_containers').catch(() => []));   // a line in a shipped container is shipped
    const files = await db.list('plan_files', { order: 'created_at.desc' }).catch(() => []);
    const ids = [...new Set([...lines.map((l) => l.supplier_id), ...files.map((f) => f.supplier_id)])];
    const sups = Object.fromEntries((await Promise.all(ids.map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
    const ci = await LP.containerIndex(db).catch(() => ({ labelFor: () => null }));
    return { lines, files, sups, missing, ci };
  }
  /**
   * Status cell of an open PO: when part of it has sailed, say so ("1 of 2 lines shipped") — the tag above is the
   * status of the lines still here; then each container as a chip with how many of the PO's lines it carries.
   */
  const shipSplit = (ci, ls) => {
    const items = ls.filter((l) => l.product || ls.length === 1); const n = items.length;
    const gone = items.filter((l) => l.shipped).length;
    const boxes = new Map(); for (const l of items) { const x = ci.labelFor(l); if (x) { if (!boxes.has(x.c.id)) boxes.set(x.c.id, { x, k: 0 }); boxes.get(x.c.id).k++; } }
    const loose = items.filter((l) => !l.shipped && !ci.labelFor(l)).length;
    return html`${gone ? html`<div class="or-part">${gone} of ${n} line${n === 1 ? '' : 's'} shipped</div>` : ''}<div class="or-chips">${[...boxes.values()].map(({ x, k }) => html`${ctnChip(x, n > 1 && k < n ? `${k} of ${n} lines` : '')}`)}${loose && boxes.size ? html`<span class="or-loose">${loose} line${loose === 1 ? '' : 's'} not planned</span>` : ''}</div>`;
  };
  const ctn = (ci, ls) => { const seen = new Set(); return ls.map((l) => ci.labelFor(l)).filter((x) => x && !seen.has(x.c.id) && seen.add(x.c.id)); };

  router.get('/admin/orders', G(async (req, res) => {
    const { lines, files, sups, missing, ci } = await load();
    const day = PL.today();
    const all = groupPos(lines, sups, files, day);
    const checks = await db.list('po_checks').catch(() => []);
    for (const p of all) { const c = checks.filter((x) => x.supplier_id === p.supplier_id && PL.normPo(x.po) === PL.normPo(p.po)).sort((a, b) => String(b.checked_at || '').localeCompare(String(a.checked_at || '')))[0]; p.cmp = PL.compareToCheck(c, p.lines); }
    const q = String(req.query.q || '').trim().toLowerCase();
    const fSup = sups[req.query.supplier] ? req.query.supplier : '';
    const TABS = [['open', 'Open'], ['overdue', 'Late'], ['waiting', 'Waiting on us'], ['booked', 'Booked'], ['shipped', 'Shipped'], ['all', 'All']];
    const tab = TABS.some(([k]) => k === req.query.status) ? req.query.status : 'open';
    const isOpen = (p) => p.st !== 'shipped' && p.st !== 'booked';   // booked = the forwarder confirmed it: out of the to-do list, own tab
    const inTab = (p) => (tab === 'all' ? true : tab === 'open' ? isOpen(p) : p.st === tab);
    const hit = (p) => (!fSup || p.supplier_id === fSup) && (!q || [p.po, PL.normPo(p.po), p.supplier?.name, ...p.products].filter(Boolean).join(' ').toLowerCase().includes(q.replace(/^po\s*#?\s*(?=\d)/, '')));
    let list = all.filter((p) => inTab(p) && hit(p));
    const wider = q && !list.length && all.some(hit);   // nothing in this tab: show matches from every status
    if (wider) list = all.filter(hit);
    list = list
      .sort((a, b) => (RANK[b.st] - RANK[a.st]) || String(a.first || '9').localeCompare(String(b.first || '9')));
    const openPos = all.filter(isOpen);
    const count = (k) => all.filter((p) => (k === 'all' ? true : k === 'open' ? isOpen(p) : p.st === k)).length;
    const link = (over) => `/admin/orders?${new URLSearchParams(Object.entries({ status: tab, supplier: fSup, q: req.query.q || '', ...over }).filter(([, v]) => v))}`;

    res.html(page({
      title: 'Purchase orders', nav: adminNav('orders'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h1>Purchase orders</h1><p class="muted">Every PO from supplier reports, POs and status updates. Open one to see its lines, status and documents.</p></div>
          <div class="cp-head-r"><a class="btn ghost" href="/admin/logistics/planning">Container planning</a><a class="btn" href="/admin/logistics/planning/import">Import orders</a></div></div>
        ${missing ? html`<p class="flash warn">Run the container planning SQL in Supabase first (supabase/schema.sql, "Container planning").</p>` : ''}
        <div class="cp-kpis">
          <div class="cp-kpi"><span>Open POs</span><b>${openPos.length}</b><small>${new Set(openPos.map((p) => p.supplier_id)).size} suppliers</small></div>
          <div class="cp-kpi"><span>Open volume</span><b>${n2(openPos.reduce((a, p) => a + p.cbm, 0))} m³</b><small>${int(openPos.reduce((a, p) => a + p.qty, 0))} pcs${openPos.some((p) => p.cbmMissing) ? ` · ${openPos.filter((p) => p.cbmMissing).length} without CBM` : ''}</small></div>
          <div class="cp-kpi ${count('overdue') ? 'warn' : ''}"><span>Ready, not shipped</span><b>${count('overdue')}</b><small>ready date passed</small></div>
          <div class="cp-kpi ${count('waiting') ? 'warn' : ''}"><span>Waiting on Lulyboo</span><b>${count('waiting')}</b><small>artwork, approvals…</small></div>
        </div>
        <div class="or-bar">
          <nav class="cp-views" aria-label="Status">${TABS.map(([k, l]) => html`<a href="${link({ status: k })}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l} <span class="or-n">${count(k)}</span></a>`)}</nav>
          <form method="get" action="/admin/orders" class="or-search"><input type="hidden" name="status" value="${tab}">
            ${require('./samples').supplierPicker(Object.values(sups).sort((a, b) => a.name.localeCompare(b.name)), fSup, { name: 'supplier', required: false, all: 'All suppliers', submit: true, cls: 'pick1-filter pick1-nolbl' })}
            <input type="search" name="q" value="${req.query.q || ''}" placeholder="Search PO, product or supplier" aria-label="Search" data-live-q=".or-table tbody tr" data-live-empty="or-none"><button type="submit" class="sr-only" tabindex="-1">Search</button></form>
        </div>
        <div class="card flush"><div class="table-wrap"><table class="list or-table"><thead><tr><th>PO</th><th>Supplier</th><th>Products</th><th class="r">Qty</th><th class="r">CBM</th><th>Ready</th><th>Port</th><th>Status</th><th>Docs</th></tr></thead>
          <tbody>${list.map((p) => html`<tr class="${p.st === 'shipped' ? 'done' : ''}">
            <td><a href="${poUrl(p.supplier_id, p.po)}"><b>${p.po}</b></a></td>
            <td><a href="/admin/suppliers/${p.supplier_id}">${p.supplier?.name || '—'}</a></td>
            <td>${p.products.length ? html`${p.products[0]}${p.products.length > 1 ? html` <span class="sub">+${p.products.length - 1} more</span>` : ''}` : html`<span class="sub">${p.lines.length} line${p.lines.length === 1 ? '' : 's'}</span>`}</td>
            <td class="r">${p.cmp && !p.cmp.ok ? html`<a class="or-pkw" href="${poUrl(p.supplier_id, p.po)}" title="${`Doesn't match the PO: it says ${int(p.cmp.qty.want ?? p.cmp.qty.have)} pcs${p.cmp.amount.want != null ? ` · ${money(p.cmp.amount.want, p.cmp.currency)}` : ''}`}">⚠</a> ` : ''}${p.qty ? int(p.qty) : '—'}</td>
            <td class="r">${p.cbm ? n2(p.cbm) : '—'}${p.cbmMissing && p.cbm ? html`<span class="sub"> +?</span>` : ''}</td>
            <td>${p.first ? (p.first === p.last ? PL.short(p.first) : `${PL.short(p.first)} – ${PL.short(p.last)}`) : '—'}</td>
            <td>${p.ports.map(portName).filter(Boolean).join(', ') || html`<span class="sub">To confirm</span>`}</td>
            <td>${tag(p.st)}${p.pending.length ? html`<div class="sub or-needs" title="${`Needs: ${p.pending.join(', ')}`}">Needs: ${p.pending.join(', ')}</div>` : ''}${p.st !== 'shipped' ? shipSplit(ci, p.lines) : ''}</td>
            <td>${p.docs.length ? html`<a class="or-docs" href="${poUrl(p.supplier_id, p.po)}#docs" title="${`${p.docs.length} document${p.docs.length === 1 ? '' : 's'}`}" aria-label="${`${p.docs.length} document${p.docs.length === 1 ? '' : 's'} on PO ${p.po}`}">📎</a>` : '—'}</td></tr>`)}</tbody></table></div>
          ${wider ? html`<p class="sub or-empty">Not in "${(TABS.find(([k]) => k === tab) || [])[1]}" — showing matches from every status.</p>` : ''}
          <p class="muted or-empty" id="or-none" hidden>No match on this page — press Enter to search every status.</p>
          ${list.length ? '' : html`<p class="muted or-empty">${all.length ? 'No purchase orders match.' : 'No purchase orders yet. Import a supplier report or upload a PO to start.'}</p>`}</div>`,
    }));
  }));

  router.get('/admin/orders/view', G(async (req, res) => {
    const { lines, files, sups, ci } = await load();
    const supplier = sups[req.query.supplier] || await db.get('suppliers', String(req.query.supplier || '')).catch(() => null);
    const poQ = String(req.query.po || '');
    if (!supplier || !poQ) throw new HttpError(404, 'Purchase order not found');
    const p = groupPos(lines.filter((l) => l.supplier_id === supplier.id && PL.normPo(l.po) === PL.normPo(poQ)), { [supplier.id]: supplier }, files, PL.today())[0];
    const docs = files.filter((f) => f.supplier_id === supplier.id && (f.pos || []).some((x) => PL.normPo(x) === PL.normPo(poQ)));
    if (!p && !docs.length) throw new HttpError(404, 'Purchase order not found');
    const ls = p ? p.lines : [];
    // PO-level terms (payment, ship-to, method) shown once; line notes only when they say something about that line
    const split = ls.map((o) => ({ o, ...PL.splitTerms(o.notes, o.po_terms) }));
    const terms = [...new Set(split.flatMap((x) => String(x.po_terms || '').split(/(?<=[.;])\s+(?=[A-Z])/).map((t) => t.trim().replace(/[.;]$/, '')).filter(Boolean)))];
    // tidy what older imports stored: terms out of the line notes (skipped quietly on a database without po_terms)
    for (const x of split) if ((x.notes || null) !== (x.o.notes || null) || (x.po_terms || null) !== (x.o.po_terms || null)) await db.update('plan_orders', { id: x.o.id }, { notes: x.notes, po_terms: x.po_terms }).catch(() => null);
    for (const x of split) { x.o.notes = x.notes; x.o.po_terms = x.po_terms; }
    const back = req.url;
    const mostOf = (vals) => { const m = new Map(); for (const v of vals) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
    const mainReady = mostOf(ls.filter((o) => !o.shipped).map((o) => o.ready_date || null)) ?? null; const mainPort = mostOf(ls.map((o) => o.port || null)) ?? null;   // lines that differ say so under the product
    const mainSt = p ? (p.st === 'waiting' ? 'production' : p.st) : null;   // the PO's status is shown once, in the header; a line that differs says so
    const cmp = PL.compareToCheck(await PL.poCheck(db, supplier.id, poQ), ls);   // live lines vs the totals printed on the PO
    const prods = await db.list('products', { filters: { supplier_id: supplier.id } }).catch(() => []);
    const inCat = (o) => (o.product ? PL.catalogMatch(o, prods) : null);
    const missingCat = ls.filter((o) => o.product && !inCat(o));
    // reminders: what the supplier waits on from us, inspection to book, line notes — grouped, out of the table
    const open = ls.filter((o) => !o.shipped);
    const groupBy = (arr, key) => { const m = new Map(); for (const o of arr) { const k = key(o); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(o); } return [...m.entries()]; };
    const who = (g) => (g.length === ls.length ? (ls.length > 1 ? `all ${ls.length} lines` : '') : g.map((o) => o.product || o.sku || 'line').join(', '));
    const todo = [];
    for (const [text, g] of groupBy(open.filter((o) => o.st === 'waiting'), (o) => String(o.pending_from_us || '').trim())) {
      const m = text.match(/^(.*?)\s*\((.+)\)\s*$/);
      todo.push({ kind: 'wait', level: 'warn', icon: '⏳', title: `Waiting on you: ${m ? m[1] : text}`, sub: [m ? m[2] : '', who(g)].filter(Boolean).join(' · '), ids: g.map((o) => o.id), text });
    }
    for (const [k, g] of groupBy(open, (o) => (o.inspection_date ? `d:${o.inspection_date}` : o.inspection_note ? `n:${String(o.inspection_note).trim()}` : ''))) {
      if (k.startsWith('d:')) { const d = k.slice(2); todo.push({ kind: 'insp', level: d < PL.today() ? 'ok' : 'info', icon: '🔍', title: `Inspection ${d < PL.today() ? 'was' : 'booked for'} ${PL.short(d)}`, sub: who(g), ids: g.map((o) => o.id), date: d }); continue; }
      const note = k.slice(2); const days = (note.match(/(\d+)\s*days?\s*before/i) || [])[1];
      const ready = g.map((o) => o.ready_date).filter(Boolean).sort()[0];
      const by = days && ready ? PL.addDays(ready, -Number(days)) : null;
      const late = by && by < PL.today(); const soon = by && !late && by <= PL.addDays(PL.today(), 7);
      todo.push({ kind: 'insp', level: late ? 'bad' : soon ? 'warn' : 'info', icon: '🔍', title: by ? `Book inspection by ${PL.short(by)}${late ? ' — overdue' : ''}` : 'Inspection to book', sub: [by ? `${days} days before the ready date ${PL.short(ready)}` : note, who(g)].filter(Boolean).join(' · '), note, ids: g.map((o) => o.id), by });
    }
    const notesG = groupBy(ls.filter((o) => o.notes), (o) => String(o.notes).trim());
    const shipSection = await require('./shipping').shipmentSection(db, supplier, p?.po || poQ, back);
    // where this PO's goods are now (Orders → Shipments), and the volume the supplier actually loaded
    const SH = require('./shipments');
    const ids = new Set(ls.map((o) => o.id));
    const shp = ((await SH.load(db).catch(() => null))?.list || []).filter((r) => r.lines.some((l) => ids.has(l.id)) || (r.kind === 'courier' && (r.sc.pos || []).some((x) => PL.normPo(x) === PL.normPo(poQ))));
    const stageTag = shp.map((r) => { const [t, cls] = SH.STAGE_TAG[r.stage] || ['Shipped', 's0']; const eta = r.stage === 'sailed' && r.f?.eta ? ` · ETA ${PL.short(r.f.eta)}` : r.stage === 'delivered' && r.c?.delivered_at ? ` ${PL.short(String(r.c.delivered_at).slice(0, 10))}` : ''; return html` <a class="shp-st ${cls} cp-stage" href="/admin/orders/shipments/${r.id}" title="Open in Shipments">${t}${eta} ›</a>`; });
    const doneSc = (await db.list('ship_confirmations', { filters: { supplier_id: supplier.id } }).catch(() => [])).find((x) => x.status === 'complete' && x.actual?.cbm && (x.pos || []).length && (x.pos || []).every((q) => PL.normPo(q) === PL.normPo(poQ)));
    const actualCbm = doneSc ? Number(doneSc.actual.cbm) : null; const planCbm = doneSc?.actual?.planned_cbm != null ? Number(doneSc.actual.planned_cbm) : null;
    const icon = (f) => (/pdf/.test(f.content_type) ? 'PDF' : /image/.test(f.content_type) ? 'IMG' : /sheet|excel|csv/.test(f.content_type) ? 'XLS' : /word/.test(f.content_type) ? 'DOC' : 'FILE');
    res.html(page({
      title: `${poQ} · Purchase orders`, nav: adminNav('orders'), flash: takeFlash(req, res), wide: true, req,
      body: html`<nav class="crumb"><a href="/admin/orders">Purchase orders</a><span>›</span><a href="/admin/suppliers/${supplier.id}">${supplier.name}</a></nav>
        <div class="cp-head"><div><h1>${p?.po || poQ} ${p ? (stageTag.length ? stageTag : tag(p.st)) : ''}</h1><p class="muted">${supplier.name}${p?.ports.length ? ` · ${p.ports.map(portName).join(', ')}` : ''}${p?.first ? ` · ready ${p.first === p.last ? PL.short(p.first) : `${PL.short(p.first)} – ${PL.short(p.last)}`}` : ''}</p>${terms.length ? html`<p class="or-terms">${terms.map((t, i) => { const m = t.match(/^([^:]{2,28}):\s*(.+)$/); return html`${i ? html`<span class="or-sep">·</span>` : ''}${m ? html`<span><b>${m[1]}</b> ${m[2]}</span>` : html`<span>${t}</span>`}`; })}</p>` : ''}</div>
          <div class="cp-head-r">${p ? html`<form method="post" action="/admin/orders/shipped" class="inline"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${p.po}"><input type="hidden" name="value" value="${p.st === 'shipped' ? '0' : '1'}"><button class="btn ghost">${p.st === 'shipped' ? 'Mark not shipped' : 'Mark PO shipped'}</button></form><form method="post" action="/admin/orders/delete" class="inline" data-confirm="${`Delete ${p.po} and all its ${ls.length} line${ls.length === 1 ? '' : 's'}? Documents stay in Documents. This can't be undone.`}"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${p.po}"><button class="btn danger-btn">Delete PO</button></form>` : ''}
            <a class="btn ghost" href="/admin/logistics/planning?supplier=${supplier.id}">Open in planning</a></div></div>
        ${p ? html`<div class="cp-kpis">
          ${(() => { const open = ls.filter((o) => !o.shipped); const ds = [...new Set((open.length ? open : ls).map((o) => o.ready_date).filter(Boolean).map((d) => String(d).slice(0, 10)))].sort();
            const allShipped = ls.length && !open.length; const first = ds[0]; const td = PL.today();
            const n = first ? Math.round((Date.parse(first) - Date.parse(td)) / 86400000) : null;
            const sub = allShipped ? 'all lines shipped' : !first ? 'not given by the supplier' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`;
            const ports = p.ports.map(portName).filter(Boolean);
            return html`<div class="cp-kpi ${!allShipped && n != null && n < 0 ? 'bad' : ''}"><span>Ready to ship</span><b>${first ? (ds.length > 1 ? `${PL.short(first)} – ${PL.short(ds[ds.length - 1])}` : PL.short(first)) : '—'}</b><small>${sub}${ds.length > 1 && !allShipped ? ` · ${ds.length} dates` : ''} · ${ports.length ? html`<b class="or-kp">⚓ ${ports.join(', ')}</b>` : html`<span>port to confirm</span>`}</small></div>`; })()}
          ${(() => { const c = ls.map(PK.ctn); const tot = c.reduce((a, x) => a + (x || 0), 0); const miss = ls.filter((o, i) => o.product && c[i] == null).length;
            return html`<div class="cp-kpi"><span>Quantity</span><b>${p.qty ? int(p.qty) : '—'}</b><small>pieces · ${tot ? html`<b class="or-kp">${int(tot)} cartons</b>${miss ? html` <span title="${`${miss} line${miss === 1 ? '' : 's'} without packing`}">+${miss}?</span>` : ''}` : 'cartons unknown'}</small></div>`; })()}
          ${(() => { const priced = ls.filter((o) => o.unit_price && o.qty); const amt = priced.reduce((a, o) => a + Number(o.unit_price) * Number(o.qty), 0); return html`<div class="cp-kpi"><span>PO value</span><b>${amt ? money(amt, priced[0].currency) : '—'}</b><small>${!priced.length ? 'no cost on the lines' : priced.length < ls.filter((o) => o.product).length ? `${priced.length} of ${ls.filter((o) => o.product).length} lines priced` : 'cost × quantity'}</small></div>`; })()}
          ${actualCbm ? html`<div class="cp-kpi"><span>Volume · loaded</span><b>${n2(actualCbm)} m³</b><small>${planCbm ? `plan ${n2(planCbm)} m³${Math.abs(actualCbm - planCbm) >= 0.01 ? ` · ${actualCbm > planCbm ? '+' : ''}${Math.round(((actualCbm - planCbm) / planCbm) * 100)}%` : ' · as planned'}` : "from the supplier's packing list"}</small></div>`
            : html`<div class="cp-kpi"><span>Volume</span><b>${p.cbm ? `${n2(p.cbm)} m³` : '—'}</b><small>${p.cbm ? `≈ ${PL.suggest(p.cbm).text}` : 'CBM missing'}</small></div>`}
          ${p.pending.length ? html`<div class="cp-kpi warn"><span>Waiting on Lulyboo</span><b>${p.pending.length}</b><small>${p.pending.join(', ')}</small></div>` : ''}</div>
        ${PL.duplicateGroups(ls).length ? html`<form method="post" action="/admin/logistics/planning/dedupe" class="flash warn cp-dup"><span><b>The same item appears more than once on this PO.</b> Merge keeps one line per item with all its details.</span><button class="btn small">Merge duplicates</button></form>` : ''}
        ${todo.length || notesG.length ? html`<section class="card or-todo"><div class="head-row"><h2>To do &amp; notes ${todo.length ? html`<span class="cp-tag ${todo.some((t) => t.level === 'bad') ? 'late' : 'wait'}">${todo.filter((t) => t.level !== 'ok').length} open</span>` : ''}</h2></div>
          ${todo.map((t) => html`<div class="or-td ${t.level}"><span class="or-td-i">${t.icon}</span><div class="or-td-t"><b>${t.title}</b>${t.sub ? html`<div class="sub">${t.sub}</div>` : ''}</div>
            <div class="or-td-a">${t.kind === 'wait' ? html`<form method="post" action="/admin/orders/todo" class="inline"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="ids" value="${t.ids.join(',')}"><input type="hidden" name="what" value="done"><input type="hidden" name="back" value="${back}"><button class="btn small ghost">✓ Done</button></form>`
              : html`<form method="post" action="/admin/orders/todo" class="inline or-td-date"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="ids" value="${t.ids.join(',')}"><input type="hidden" name="what" value="inspection"><input type="hidden" name="back" value="${back}"><input type="date" name="date" value="${t.date || ''}" aria-label="Inspection date" required><button class="btn small ghost">${t.date ? 'Change' : 'Set date'}</button></form>`}</div></div>`)}
          ${notesG.length ? html`<details class="or-td-notes" ${todo.length ? '' : raw('open')}><summary>Notes <span class="sub">${notesG.length}</span></summary>${notesG.map(([n, g]) => html`<p>${who(g) && g.length < ls.length ? html`<b>${who(g)}:</b> ` : ''}${n}</p>`)}</details>` : ''}
        </section>` : ''}
        <section class="card"><div class="head-row"><h2>Lines</h2>${missingCat.length ? html`<form method="post" action="/admin/orders/catalog" class="inline"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${p.po}"><button class="btn ghost small">Add ${missingCat.length} product${missingCat.length === 1 ? '' : 's'} to ${supplier.name}'s product list</button></form>` : ''}</div><div class="table-wrap"><table class="list cp-table"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Cost / pc</th><th class="r">Amount</th><th class="r">Cartons</th><th class="r">CBM</th><th class="r">Gross kg</th><th>Container</th><th></th></tr></thead>
          <tbody>${ls.map((o) => html`<tr class="${o.shipped ? 'done' : ''}"><td>${(() => { const c = inCat(o); const pack = [o.units_per_carton ? `${int(o.units_per_carton)} pcs/ctn` : null, o.carton_l_cm && o.carton_w_cm && o.carton_h_cm ? `${Number(o.carton_l_cm)}×${Number(o.carton_w_cm)}×${Number(o.carton_h_cm)} cm` : null, o.carton_gw_kg ? `${Number(o.carton_gw_kg)} kg/ctn` : null, o.cartons ? `${int(o.cartons)} ctns` : null].filter(Boolean);
              if (!o.product) return html`<span class="sub">(whole PO)</span>`;
              return html`<span class="or-pc" tabindex="0" data-popcard>${o.product}
                <span class="or-pc-card" role="tooltip"><b>${o.product}</b>${o.sku ? html`<span class="cu-mono">${o.sku}</span>` : ''}${c ? html`<a href="/admin/products/${c.id}">✓ In ${supplier.name}'s products →</a>` : ''}${pack.length ? html`<span>📦 ${pack.join(' · ')}</span>` : html`<span class="sub">No packing data yet</span>`}</span></span>
                ${o.sku ? html`<div class="sub">${o.sku}</div>` : ''}${(() => { const d = []; if (o.ready_date && o.ready_date !== mainReady) d.push(`ready ${PL.short(o.ready_date)}`); if (o.port !== mainPort) d.push(portName(o.port) || 'port to confirm'); const lst = o.st === 'waiting' ? 'production' : o.st; const stOff = lst !== mainSt; return d.length || stOff ? html`<div class="or-diff" title="Different from the rest of the PO">${stOff ? html`${tag(lst)} ` : ''}${d.join(' · ')}</div>` : ''; })()}${c ? '' : html`<span class="or-cat no">Not in product list</span>`}`; })()}</td><td class="r">${o.qty ? int(o.qty) : '—'}</td><td class="r">${o.unit_price ? money(o.unit_price, o.currency, 3) : '—'}</td><td class="r">${o.unit_price && o.qty ? money(o.unit_price * o.qty, o.currency) : '—'}</td><td class="r">${(() => { const v = PK.ctn(o); return v == null ? (o.product && o.qty ? PR.editBtn({ ...o, sup: supplier }, 'or-add', 'add', 'Add pcs per carton') : '—') : (o.cartons ? int(v) : html`<span class="or-est" title="Calculated: qty ÷ pcs per carton">${int(v)}</span>`); })()}</td><td class="r">${!o.cbm ? '—' : o.cbm_estimated ? html`<span class="or-est" title="Calculated: cartons × carton size">${n2(o.cbm)}</span>` : n2(o.cbm)}</td><td class="r">${(() => { const v = PK.kg(o); return v == null ? (o.product && o.qty ? PR.editBtn({ ...o, sup: supplier }, 'or-add', 'add', 'Add carton weight') : '—') : (o.gross_kg ? n1(v) : html`<span class="or-est" title="Calculated: cartons × kg per carton">${n1(v)}</span>`); })()}</td>
            <td>${(() => { const x = ci.labelFor(o); const lbl = x ? 'Move to another container' : 'Add to container';
              const mv = html`<button type="button" class="or-ib" data-open-dialog="${`mv-${o.id}`}" title="${lbl}" aria-label="${`${lbl} · ${o.product || o.po}`}">${x ? raw(ICON_MOVE) : raw(ICON_ADD)}</button>`;
              if (x) return html`<span class="or-cc">${ctnChip(x)}${mv}</span>`;
              // not in a container: the same chip shape, dashed; the whole chip opens "Add to container"
              return html`<button type="button" class="or-chip add" data-open-dialog="${`mv-${o.id}`}" title="Add to container" aria-label="${`Add to container · ${o.product || o.po}`}"><span class="or-chip-i ib" aria-hidden="true">${raw(ICON_ADD)}</span><span class="or-chip-t"><b>${o.shipped ? 'No container' : 'Not planned'}</b></span></button>`; })()}</td>
            <td class="or-acts">${PR.editBtn({ ...o, sup: supplier }, 'link small')}<form method="post" action="/admin/logistics/planning/${o.id}/delete" class="inline" data-confirm="${`Delete this line (${o.po}${o.product ? ` · ${o.product}` : ''})? This can't be undone.`}"><input type="hidden" name="back" value="${back}"><button class="icon-btn" title="Delete line" aria-label="${`Delete ${o.product || o.po}`}">×</button></form></td></tr>`)}</tbody>
          ${ls.length > 1 || cmp ? (() => {
            // order total: cartons/kg from the line, else calculated from packing (PK); "+N?" = lines without data
            const sum = (f) => { const v = ls.map(f); return { total: v.reduce((a, x) => a + (x || 0), 0), missing: v.filter((x) => !x).length }; };
            const q = sum((o) => Number(o.qty) || null); const c = sum((o) => Number(o.cbm) || null); const k = sum(PK.kg); const t = sum(PK.ctn);
            const byCur = {}; let noPrice = 0;
            for (const o of ls) { if (o.unit_price && o.qty) byCur[o.currency || 'USD'] = (byCur[o.currency || 'USD'] || 0) + o.unit_price * o.qty; else noPrice++; }
            const miss = (x, what) => (x.missing ? html` <span class="sub or-miss" title="${`${x.missing} line${x.missing === 1 ? '' : 's'} without ${what}`}">+${x.missing}?</span>` : '');
            const amt = Object.entries(byCur).map(([cu, v]) => money(v, cu));
            const ship = PK.shipping(c.total, k.total, t.total);
            const short = ls.filter((o) => o.product && (PK.ctn(o) == null || PK.kg(o) == null || !Number(o.cbm))).length;
            return html`<tfoot><tr class="or-tot"><td><b>Order total</b> <span class="sub">· ${ls.length} lines</span></td><td class="r">${int(q.total)}${miss(q, 'a quantity')}</td><td></td>
              <td class="r">${amt.length ? amt.map((x, n) => html`${n ? html`<br>` : ''}${x}`) : '—'}${noPrice ? html` <span class="sub or-miss" title="${`${noPrice} line${noPrice === 1 ? '' : 's'} without a price`}">+${noPrice}?</span>` : ''}</td>
              <td class="r">${int(t.total)}${miss(t, 'cartons')}</td><td class="r">${n2(c.total)}${miss(c, 'a volume')}</td><td class="r">${n1(k.total)}${miss(k, 'a weight')}</td><td colspan="2"></td></tr>
              ${cmp ? html`<tr class="or-ship or-pochk"><td colspan="9">${cmp.ok
                ? html`<span class="or-pk ok">✓ Matches PO ${p.po} · ${int(cmp.qty.want ?? cmp.qty.have)} pcs${cmp.amount.want != null ? ` · ${money(cmp.amount.want, cmp.currency)}` : ''}</span> <span class="sub">checked against ${cmp.file || 'the PO'}${cmp.at ? ` · ${PL.short(String(cmp.at).slice(0, 10))}` : ''}</span>`
                : html`<span class="or-pk no">⚠ PO ${p.po} says ${cmp.qty.want != null ? `${int(cmp.qty.want)} pcs` : ''}${cmp.qty.want != null && cmp.amount.want != null ? ' · ' : ''}${cmp.amount.want != null ? money(cmp.amount.want, cmp.currency) : ''} — ${[cmp.qty.want != null && cmp.qty.have !== cmp.qty.want ? `${int(Math.abs(cmp.qty.want - cmp.qty.have))} pcs` : '', cmp.amount.want != null && Math.abs(cmp.amount.want - cmp.amount.have) > 1 ? money(Math.abs(cmp.amount.want - cmp.amount.have), cmp.currency) : ''].filter(Boolean).join(' / ')} ${cmp.qty.have < (cmp.qty.want ?? cmp.qty.have) || cmp.amount.have < (cmp.amount.want ?? cmp.amount.have) ? 'not in the portal' : 'more in the portal than on the PO'}</span>
                  <div class="or-pk-r"><form method="post" action="/admin/logistics/planning/po-recheck" class="inline" data-busy><input type="hidden" name="supplier_id" value="${supplier.id}"><input type="hidden" name="po" value="${p.po}"><input type="hidden" name="back" value="${back}"><button class="link small" title="AI reads the PO file again and updates the lines">Fix from the PO (re-read)</button></form>${cmp.items.length ? html`<span class="sub">${cmp.items.map((x) => `${x.sku || x.product} ${x.have > x.want ? '+' : '−'}${int(Math.abs(x.want - x.have))}`).join(' · ')}</span>` : ''}<span class="sub">or fix a quantity with ✎</span></div>`}</td></tr>` : ''}
              ${ship ? html`<tr class="or-ship"><td colspan="9"><span class="or-sc">Shipping: <b>${ship.mode}</b> — ${n2(c.total)} m³ ${ship.mode === 'FCL' ? html`≈ <b>${ship.boxes}</b>` : ''} <span class="or-fill" aria-hidden="true"><i style="${`width:${Math.min(100, ship.pct)}%`}"></i></span> ${ship.pct}% of a 40' HQ <span class="sub">(${ship.cap} m³ usable)</span></span>${short ? html`<span class="or-sc"><span class="or-warn">${short} line${short === 1 ? '' : 's'} without packing — totals are short</span></span>` : ''}</td></tr>` : ''}</tfoot>`;
          })() : ''}</table></div>
          </section>` : ''}
        ${ls.map((o) => { const SN = require('../shipname'); const cur = o.container_id;
          const cands = Object.values(ci.byId || {}).filter((c) => !c.delivered_at && (!o.port || !c.port || c.port === o.port) || c.id === cur)
            .sort((a, b) => (a.id === cur ? -1 : b.id === cur ? 1 : 0) || String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 15);
          return html`<dialog id="${`mv-${o.id}`}" class="rp-modal pd-dlg" aria-labelledby="${`mv-t-${o.id}`}"><form method="post" action="/admin/logistics/planning/line/${o.id}/move">
            <input type="hidden" name="back" value="${back}">
            <div class="rp-top"><h2 id="${`mv-t-${o.id}`}">${cur ? 'Move to another container' : 'Add to a container'}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
            <p class="sub">${o.product || 'Whole PO'} · ${o.qty ? `${int(o.qty)} pcs` : ''} — a line put into a shipped container counts as shipped.</p>
            <div class="pd-pick">${cands.length ? cands.map((c) => html`<label class="pd-opt"><input type="radio" name="container_id" value="${c.id}" ${c.id === cur ? raw('checked') : ''} required><span><b>${SN.shipName(c, { sailing: c.sailing })}</b></span><span class="pd-st ${c.status === 'shipped' ? 'ok' : ''}">${c.status === 'shipped' ? 'shipped' : c.status === 'booked' ? 'booked' : 'planned'}</span></label>`) : html`<p class="sub" style="padding:10px 12px;margin:0">No containers${o.port ? ' from this port' : ''} yet.</p>`}
              ${cur ? html`<label class="pd-opt"><input type="radio" name="container_id" value="none"><span><b>Take out of the container</b> <span class="sub">— back to Container planning</span></span><span></span></label>` : ''}</div>
            <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save</button></div></form></dialog>`; })}
        ${await (async () => { const want = PL.normPo(p?.po || poQ); const recs = (await db.list('plan_containers').catch(() => [])).filter((c) => c.record_only && ((c.record || {}).pos || []).some((x) => x.po === want && (!supplier || x.sid === supplier.id)));
          if (!recs.length) return ''; const SN = require('../shipname');
          return html`<p class="or-recs">${recs.map((c) => html`<a class="or-ctn" href="/admin/orders/shipments/${c.id}">📦 Record · ${(c.record || {}).name || SN.shipName(c)}</a>`)}</p>`; })()}
        ${await require('./payments').poCard(db, supplier, p?.po || poQ, back).catch(() => '')}
        ${shipSection}
        ${await (async () => { const list = await require('./customs').forPo(db, p?.po || poQ).catch(() => []); if (!list.length) return ''; return html`<section class="card cu-po" id="customs"><div class="head-row"><h2>Customs</h2></div>${list.map((x) => html`<div class="cu-pr"><a class="cu-mono" href="/admin/logistics/customs?review=${x.id}">${x.entry_no || 'Entry'}</a><span class="sub">${x.date ? String(x.date).slice(0, 10) : ''} · ${x.items.join(', ')}</span><span class="cu-pr-v">duty <b>$${x.duty.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b> + fees $${x.fees.toLocaleString('en-US', { minimumFractionDigits: 2 })} <span class="sub">for this PO</span></span></div>`)}</section>`; })()}
        <section class="card" id="docs"><div class="head-row"><h2>Documents <span class="sub">${docs.length}</span></h2></div>
          <div class="dc-lay ${docs.length ? '' : 'empty'}">
          ${docs.length ? html`<div class="dc-list">${(() => {
            const SHIP = /bill of lading|warehouse receipt|loading photo|waybill|awb/i;
            const isShip = (f) => !!f.shipment_id || SHIP.test(f.kind || '');
            const ship = docs.filter(isShip); const order = docs.filter((f) => !isShip(f));
            const day = (f) => PL.short(String(f.created_at || '').slice(0, 10));
            const row = (f) => html`<div class="dc-row"><span class="cp-ficon ${icon(f).toLowerCase()}">${icon(f)}</span>
              <span class="dc-nc"><a class="dc-nm" href="/admin/logistics/planning/files/${f.id}?inline=1" title="${f.name}" ${/pdf|image/.test(f.content_type || '') ? raw(`data-preview="/admin/logistics/planning/files/${f.id}?inline=1" data-type="${/image/.test(f.content_type) ? 'image' : 'doc'}" data-dl="/admin/logistics/planning/files/${f.id}"`) : raw('target="_blank" rel="noopener"')}>${f.name}</a>${(f.pos || []).length > 1 ? html`<span class="sub dc-also">also ${f.pos.filter((x) => PL.normPo(x) !== PL.normPo(poQ)).slice(0, 4).join(', ')}</span>` : ''}</span>
              <span class="dc-tc"><span class="dc-tg">${f.kind || 'Document'}</span>${f.kind === 'PO' ? html`<form method="post" action="/admin/logistics/planning/files/${f.id}/signed" class="inline"><input type="hidden" name="back" value="${back}"><button class="dc-sg ${f.signed ? 'on' : ''}" title="${f.signed ? 'Signed copy — click to undo' : 'Mark as the signed PO (the accountant checks it before paying)'}">${f.signed ? '✓ signed' : 'signed?'}</button></form>` : ''}</span>
              <span class="dc-d">${day(f)}</span><span class="dc-d">${f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
              <a class="dc-dl" href="/admin/logistics/planning/files/${f.id}" title="Download" aria-label="Download ${f.name}">⬇</a></div>`;
            const shipDays = [...new Set(ship.map(day))];
            return html`${order.length && ship.length ? html`<div class="dc-grp">Order</div>` : ''}${order.map(row)}
              ${ship.length ? (order.length ? html`<details class="dc-ship"><summary class="dc-grp">Shipping documents (${ship.length})${shipDays.length === 1 ? ` · ${shipDays[0]}` : ''}${shipSection && ship.some((f) => f.shipment_id) ? html` <span class="sub">— also in Shipping documents above</span>` : ''}</summary>${ship.map(row)}</details>` : html`<div class="dc-grp">Shipping documents${shipDays.length === 1 ? ` · ${shipDays[0]}` : ''}</div>${ship.map(row)}`) : ''}`;
          })()}</div>` : ''}
          <form method="post" action="/admin/logistics/planning/files" enctype="multipart/form-data" data-busy class="dc-up">
            <input type="hidden" name="supplier_id" value="${supplier.id}"><input type="hidden" name="pos" value="${poQ}"><input type="hidden" name="back" value="${back}">
            <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple required aria-label="Add documents"><span class="dz-main" data-main><b>Drop files here</b> or choose</span><span class="dz-hint">${docs.length ? `Linked to ${poQ}` : `PO, PI, packing list… linked to ${poQ}`}</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <label class="dc-k">Type <select name="kind"><option value="">Detect from the file name</option>${PL.DOC_KINDS.map((k) => html`<option ${k === 'PO' ? raw('selected') : ''}>${k}</option>`)}</select></label>
            <div class="dc-ft"><label class="cp-chk" title="The file is the PO signed by both sides"><input type="checkbox" name="signed" value="1"> Signed copy</label>${AI.enabled() ? html`<label class="cp-chk"><input type="checkbox" name="read" value="1" checked> Read with AI</label><span class="dc-i" tabindex="0" title="${`PO / PI: each product becomes a line of ${poQ}. Packing list: pcs per carton and carton size are saved to the product; cartons, m³ and kg are calculated from the order quantity.`}">i</span>` : ''}<button class="btn small">Upload</button></div></form>
          </div></section>
        ${PR.editDialog(back)}${require('./payments').paidDialog()}`,
    }));
  }));

  // reminders on the PO page: "Done" clears what the supplier waited on; a date books the inspection
  router.post('/admin/orders/todo', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const ids = String(f.ids || '').split(',').filter(Boolean).slice(0, 500);
    const ls = (await db.list('plan_orders', { filters: { supplier_id: f.supplier } })).filter((l) => ids.includes(l.id));
    if (!ls.length) throw new HttpError(404, 'Lines not found');
    const now = new Date().toISOString();
    if (f.what === 'done') { for (const l of ls) await db.update('plan_orders', { id: l.id }, { pending_from_us: null, updated_at: now }); flash(res, 'ok', `Marked done: ${String(ls[0].pending_from_us || '').slice(0, 80)}`); }
    else if (f.what === 'inspection') { const d = PL.isoDay(f.date); if (!d) throw new HttpError(400, 'Pick a date'); for (const l of ls) await db.update('plan_orders', { id: l.id }, { inspection_date: d, inspection_note: null, updated_at: now }); flash(res, 'ok', `Inspection set for ${PL.short(d)}`); }
    else throw new HttpError(400, 'Unknown action');
    res.redirect(String(f.back || '').startsWith('/admin/') ? f.back : '/admin/orders');
  }));

  router.post('/admin/orders/catalog', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const ls = (await db.list('plan_orders', { filters: { supplier_id: f.supplier } })).filter((l) => PL.normPo(l.po) === PL.normPo(f.po) && l.product);
    if (!ls.length) throw new HttpError(404, 'Purchase order not found');
    const r = await PL.addToCatalog(db, f.supplier, ls);
    flash(res, 'ok', r.added ? `Added to the product list: ${r.names.join(', ')}` : 'All products are already in the product list');
    res.redirect(poUrl(f.supplier, f.po));
  }));

  router.post('/admin/orders/delete', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const ls = (await db.list('plan_orders', { filters: { supplier_id: f.supplier } })).filter((l) => PL.normPo(l.po) === PL.normPo(f.po));
    if (!ls.length) throw new HttpError(404, 'Purchase order not found');
    for (const l of ls) await db.remove('plan_orders', { id: l.id });
    flash(res, 'ok', `Deleted ${ls[0].po} (${ls.length} line${ls.length === 1 ? '' : 's'}). Its documents are still in Container planning → Documents.`);
    res.redirect('/admin/orders');
  }));

  router.post('/admin/orders/shipped', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const ls = (await db.list('plan_orders', { filters: { supplier_id: f.supplier } })).filter((l) => PL.normPo(l.po) === PL.normPo(f.po));
    if (!ls.length) throw new HttpError(404, 'Purchase order not found');
    const now = new Date().toISOString();
    for (const l of ls) await db.update('plan_orders', { id: l.id }, { shipped: f.value === '1', updated_at: now });
    flash(res, 'ok', `${f.po} ${f.value === '1' ? 'marked shipped' : 'back to open'}`);
    res.redirect(poUrl(f.supplier, f.po));
  }));
};
module.exports.groupPos = groupPos; module.exports.tag = tag;
