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

const RANK = { overdue: 5, waiting: 4, production: 3, ready: 2, shipped: 1 };
const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const int = (v) => Number(v || 0).toLocaleString('en-US');
const portName = (c) => SC.PORT[c]?.name || null;
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
    const files = await db.list('plan_files', { order: 'created_at.desc' }).catch(() => []);
    const ids = [...new Set([...lines.map((l) => l.supplier_id), ...files.map((f) => f.supplier_id)])];
    const sups = Object.fromEntries((await Promise.all(ids.map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
    const ci = await LP.containerIndex(db).catch(() => ({ labelFor: () => null }));
    return { lines, files, sups, missing, ci };
  }
  const ctn = (ci, ls) => { const seen = new Set(); return ls.map((l) => ci.labelFor(l)).filter((x) => x && !seen.has(x.c.id) && seen.add(x.c.id)); };

  router.get('/admin/orders', G(async (req, res) => {
    const { lines, files, sups, missing, ci } = await load();
    const day = PL.today();
    const all = groupPos(lines, sups, files, day);
    const q = String(req.query.q || '').trim().toLowerCase();
    const fSup = sups[req.query.supplier] ? req.query.supplier : '';
    const TABS = [['open', 'Open'], ['overdue', 'Late'], ['waiting', 'Waiting on us'], ['shipped', 'Shipped'], ['all', 'All']];
    const tab = TABS.some(([k]) => k === req.query.status) ? req.query.status : 'open';
    const inTab = (p) => (tab === 'all' ? true : tab === 'open' ? p.st !== 'shipped' : p.st === tab);
    const list = all.filter((p) => inTab(p) && (!fSup || p.supplier_id === fSup)
      && (!q || [p.po, p.supplier?.name, ...p.products].filter(Boolean).join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (RANK[b.st] - RANK[a.st]) || String(a.first || '9').localeCompare(String(b.first || '9')));
    const openPos = all.filter((p) => p.st !== 'shipped');
    const count = (k) => all.filter((p) => (k === 'all' ? true : k === 'open' ? p.st !== 'shipped' : p.st === k)).length;
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
            <input type="search" name="q" value="${req.query.q || ''}" placeholder="Search PO, product or supplier" aria-label="Search"></form>
        </div>
        <div class="card flush"><div class="table-wrap"><table class="list or-table"><thead><tr><th>PO</th><th>Supplier</th><th>Products</th><th class="r">Qty</th><th class="r">CBM</th><th>Ready</th><th>Port</th><th>Status</th><th>Docs</th></tr></thead>
          <tbody>${list.map((p) => html`<tr class="${p.st === 'shipped' ? 'done' : ''}">
            <td><a href="${poUrl(p.supplier_id, p.po)}"><b>${p.po}</b></a></td>
            <td><a href="/admin/suppliers/${p.supplier_id}">${p.supplier?.name || '—'}</a></td>
            <td>${p.products.length ? html`${p.products[0]}${p.products.length > 1 ? html` <span class="sub">+${p.products.length - 1} more</span>` : ''}` : html`<span class="sub">${p.lines.length} line${p.lines.length === 1 ? '' : 's'}</span>`}</td>
            <td class="r">${p.qty ? int(p.qty) : '—'}</td>
            <td class="r">${p.cbm ? n2(p.cbm) : '—'}${p.cbmMissing && p.cbm ? html`<span class="sub"> +?</span>` : ''}</td>
            <td>${p.first ? (p.first === p.last ? PL.short(p.first) : `${PL.short(p.first)} – ${PL.short(p.last)}`) : '—'}</td>
            <td>${p.ports.map(portName).filter(Boolean).join(', ') || html`<span class="sub">To confirm</span>`}</td>
            <td>${tag(p.st)}${p.pending.length ? html`<div class="sub or-needs" title="${`Needs: ${p.pending.join(', ')}`}">Needs: ${p.pending.join(', ')}</div>` : ''}${p.st !== 'shipped' ? ctn(ci, p.lines).map((x) => html`<div><a class="or-ctn" href="${x.url}">📦 ${x.text}</a></div>`) : ''}</td>
            <td>${p.docs.length ? html`<a href="${poUrl(p.supplier_id, p.po)}#docs">📎 ${p.docs.length}</a>` : '—'}</td></tr>`)}</tbody></table></div>
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
          <div class="cp-kpi"><span>Lines</span><b>${ls.length}</b><small>${p.products.length} products</small></div>
          <div class="cp-kpi"><span>Quantity</span><b>${p.qty ? int(p.qty) : '—'}</b><small>pieces</small></div>
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
        <section class="card"><div class="head-row"><h2>Lines</h2>${missingCat.length ? html`<form method="post" action="/admin/orders/catalog" class="inline"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${p.po}"><button class="btn ghost small">Add ${missingCat.length} product${missingCat.length === 1 ? '' : 's'} to ${supplier.name}'s product list</button></form>` : ''}</div><div class="table-wrap"><table class="list cp-table"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Cost / pc</th><th class="r">Amount</th><th class="r">CBM</th><th>Ready</th><th>Port</th><th>Status</th><th>Container</th><th></th></tr></thead>
          <tbody>${ls.map((o) => html`<tr class="${o.shipped ? 'done' : ''}"><td>${(() => { const c = inCat(o); const pack = [o.units_per_carton ? `${int(o.units_per_carton)} pcs/ctn` : null, o.carton_l_cm && o.carton_w_cm && o.carton_h_cm ? `${Number(o.carton_l_cm)}×${Number(o.carton_w_cm)}×${Number(o.carton_h_cm)} cm` : null, o.carton_gw_kg ? `${Number(o.carton_gw_kg)} kg/ctn` : null, o.cartons ? `${int(o.cartons)} ctns` : null].filter(Boolean);
              if (!o.product) return html`<span class="sub">(whole PO)</span>`;
              return html`<span class="or-pc" tabindex="0" data-popcard>${o.product}
                <span class="or-pc-card" role="tooltip"><b>${o.product}</b>${o.sku ? html`<span class="cu-mono">${o.sku}</span>` : ''}${c ? html`<a href="/admin/products/${c.id}">✓ In ${supplier.name}'s products →</a>` : ''}${pack.length ? html`<span>📦 ${pack.join(' · ')}</span>` : html`<span class="sub">No packing data yet</span>`}</span></span>
                ${o.sku ? html`<div class="sub">${o.sku}</div>` : ''}${c ? '' : html`<span class="or-cat no">Not in product list</span>`}`; })()}</td><td class="r">${o.qty ? int(o.qty) : '—'}</td><td class="r">${o.unit_price ? money(o.unit_price, o.currency, 3) : '—'}</td><td class="r">${o.unit_price && o.qty ? money(o.unit_price * o.qty, o.currency) : '—'}</td><td class="r">${o.cbm ? n2(o.cbm) : '—'}${o.cbm_estimated ? html`<i class="sub" title="Calculated: cartons × carton size"> calc.</i>` : ''}</td>
            <td>${o.ready_date ? PL.short(o.ready_date) : '—'}</td><td>${portName(o.port) || html`<span class="sub">To confirm</span>`}</td>
            <td>${tag(o.st === 'waiting' ? 'production' : o.st)}${o.production_status && !/^in production$/i.test(o.production_status) ? html`<div class="sub">${o.production_status}</div>` : ''}</td>
            <td>${(() => { const x = ci.labelFor(o); return x ? html`<a class="or-ctn" href="${x.url}">📦 ${x.text}</a>` : o.shipped ? '—' : html`<a class="sub" href="/admin/logistics/planning/load${o.port ? `?port=${o.port}` : ''}">Not planned</a>`; })()}</td>
            <td class="or-acts">${PR.editBtn({ ...o, sup: supplier }, 'link small')}<form method="post" action="/admin/logistics/planning/${o.id}/delete" class="inline" data-confirm="${`Delete this line (${o.po}${o.product ? ` · ${o.product}` : ''})? This can't be undone.`}"><input type="hidden" name="back" value="${back}"><button class="icon-btn" title="Delete line" aria-label="${`Delete ${o.product || o.po}`}">×</button></form></td></tr>`)}</tbody></table></div>
          </section>` : ''}
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
