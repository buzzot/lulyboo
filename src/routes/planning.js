'use strict';
// Container planning: /admin/logistics/planning
//   views: By port (default) · Timeline (with sailings) · Table
//   import: pick or create a supplier → drop reports / POs / status emails → AI reads → review → save

const { html, raw, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const AI = require('../ai');
const SCR = require('./schedules');
const SAM = require('./samples');

const PALETTE = ['#3b6fb6', '#d07a1e', '#2f8a63', '#7a5bb0', '#b4473b', '#1f8a9a', '#a5682a', '#5b6c8f', '#c0507e', '#4e7d2f'];
const portName = (code) => SC.PORT[code]?.name || null;
const n1 = (v) => (v === null || v === undefined || v === '' ? '—' : Math.round(Number(v) * 100) / 100);
const cbmText = (v) => (v ? `${n1(v)} m³` : 'CBM ?');
const BASE = '/admin/logistics/planning';

const editData = (o) => JSON.stringify({ id: o.id, po: o.po, supplier: o.sup?.name || '', product: o.product || '', qty: o.qty ?? '', cbm: o.cbm ?? '', ready_date: o.ready_date || '', inspection_date: o.inspection_date || '', port: o.port || '', production_status: o.production_status || '', pending_from_us: o.pending_from_us || '', notes: o.notes || '', shipped: !!o.shipped });
const editBtn = (o, cls = 'cp-edit') => html`<button type="button" class="${cls}" data-edit-order="${editData(o)}" aria-label="Edit ${o.po}" title="Edit">✎</button>`;
/** The order-line edit popup (posts to /admin/logistics/planning/:id/edit; app.js fills it). */
const editDialog = (back) => html`<dialog class="cp-dlg" data-edit-dlg aria-labelledby="cp-dlg-t"><form method="post" data-edit-form>
          <div class="cp-dlg-h"><div><h2 id="cp-dlg-t" data-f-title>Edit order</h2><span class="sub" data-f-sub></span></div><button type="button" class="icon-btn" data-edit-close aria-label="Close">×</button></div>
          <input type="hidden" name="back" value="${back}">
          <div class="cp-dlg-grid">
            <label>Loading port<select name="port" data-f="port"><option value="">To confirm</option>${SC.ORIGINS.map((p) => html`<option value="${p.code}">${p.name}</option>`)}</select></label>
            <label>Ready date<input type="date" name="ready_date" data-f="ready_date"></label>
            <label>CBM<input name="cbm" data-f="cbm" inputmode="decimal" placeholder="m³"></label>
            <label>Quantity<input name="qty" data-f="qty" inputmode="numeric"></label>
            <label class="wide">Product<input name="product" data-f="product"></label>
            <label>Production status<input name="production_status" data-f="production_status"></label>
            <label>Inspection date<input type="date" name="inspection_date" data-f="inspection_date"></label>
            <label class="wide">Waiting on Lulyboo<input name="pending_from_us" data-f="pending_from_us" placeholder="e.g. Package artwork (leave empty if nothing)"></label>
            <label class="wide">Notes<textarea name="notes" rows="2" data-f="notes"></textarea></label>
          </div>
          <label class="cp-chk"><input type="checkbox" name="all_po" value="1" checked> Apply port, date and status to every line of this PO</label>
          <label class="cp-chk"><input type="checkbox" name="all_port" value="1"> Use this port for all open orders of this supplier that have none</label>
          <label class="cp-chk"><input type="checkbox" name="shipped" value="1" data-f="shipped"> Shipped</label>
          <div class="cp-dlg-a"><button class="btn">Save</button><button type="button" class="btn ghost" data-edit-close>Cancel</button></div>
        </form></dialog>`;

function planningRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  async function load() {
    let orders = []; let missing = false;
    try { orders = await db.list('plan_orders', { order: 'ready_date.asc' }); }
    catch (e) { if (/plan_orders|PGRST205|relation/i.test(e.message)) missing = true; else throw e; }
    const ids = [...new Set(orders.map((o) => o.supplier_id))];
    const sups = Object.fromEntries((await Promise.all(ids.map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
    const files = await db.list('plan_files', { order: 'created_at.desc' }).catch(() => []);
    for (const f of files) if (!sups[f.supplier_id]) { const x = await db.get('suppliers', f.supplier_id).catch(() => null); if (x) sups[x.id] = x; }
    const allIds = [...new Set([...ids, ...files.map((f) => f.supplier_id)])];
    const color = Object.fromEntries(allIds.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
    const filesFor = (supplierId, po) => files.filter((f) => f.supplier_id === supplierId && (f.pos || []).some((x) => PL.normPo(x) === PL.normPo(po)));
    return { orders, sups, color, missing, files, filesFor };
  }

  const viewTabs = (view, q) => html`<nav class="cp-views" aria-label="Views">${[['port', 'By port'], ['timeline', 'Timeline'], ['table', 'Table'], ['docs', 'Documents']].map(([k, l]) => html`<a href="${BASE}?${new URLSearchParams({ ...q, view: k })}" class="${view === k ? 'on' : ''}" ${view === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
  const tag = (st) => html`<span class="cp-tag ${PL.STATE[st].tag}">${PL.STATE[st].label}</span>`;

  router.get(BASE, G(async (req, res) => {
    const { orders, sups, color, missing, files, filesFor } = await load();
    const day = PL.today(); const thisWeek = PL.weekStart(day);
    const view = ['port', 'timeline', 'table', 'docs'].includes(req.query.view) ? req.query.view : 'port';
    const fSup = sups[req.query.supplier] ? req.query.supplier : '';
    const showShipped = req.query.shipped === '1';
    const q = { ...(fSup ? { supplier: fSup } : {}), ...(showShipped ? { shipped: '1' } : {}) };
    const all = orders.map((o) => ({ ...o, st: PL.state(o, day), sup: sups[o.supplier_id], col: color[o.supplier_id] }));
    const list = all.filter((o) => (!fSup || o.supplier_id === fSup) && (showShipped || !o.shipped));
    const open = list.filter((o) => !o.shipped);

    // group: port → week (overdue lines go to this week)
    const portKey = (o) => o.port || '?';
    const weekKey = (o) => (!o.ready_date ? 'nodate' : o.ready_date < thisWeek ? thisWeek : PL.weekStart(o.ready_date));
    const ports = {};
    for (const o of open) { const p = (ports[portKey(o)] = ports[portKey(o)] || {}); (p[weekKey(o)] = p[weekKey(o)] || []).push(o); }
    const portOrder = [...SC.ORIGINS.map((x) => x.code), ...Object.keys(ports).filter((k) => k !== '?' && !SC.PORT[k]), '?'].filter((k) => ports[k]);
    const sixWeeks = PL.addDays(thisWeek, 42);
    const soon = open.filter((o) => o.ready_date && o.ready_date < sixWeeks);
    const soonCbm = soon.reduce((a, o) => a + (Number(o.cbm) || 0), 0);
    let boxes = [];
    for (const k of portOrder) for (const [wk, ls] of Object.entries(ports[k])) if (wk !== 'nodate' && wk < sixWeeks && k !== '?') boxes = boxes.concat(PL.suggest(ls.reduce((a, o) => a + (Number(o.cbm) || 0), 0)).boxes);
    const boxCount = boxes.reduce((m, b) => ((m[b] = (m[b] || 0) + 1), m), {});
    const attention = open.filter((o) => ['overdue', 'waiting'].includes(o.st) || !o.cbm || !o.port);

    const kpis = html`<div class="cp-kpis">
      <div class="cp-kpi"><span>Open PO lines</span><b>${open.length}</b><small>${new Set(open.map((o) => o.po)).size} POs · ${new Set(open.map((o) => o.supplier_id)).size} suppliers</small></div>
      <div class="cp-kpi"><span>Ready in next 6 weeks</span><b>${n1(soonCbm)} m³</b><small>${soon.length} lines${soon.some((o) => !o.cbm) ? ` · ${soon.filter((o) => !o.cbm).length} without CBM` : ''}</small></div>
      <div class="cp-kpi"><span>Suggested bookings</span><b>${Object.entries(boxCount).filter(([k]) => k !== 'LCL').map(([k, n]) => `${n} × ${k}`).join(' + ') || '—'}</b><small>${boxCount.LCL ? `+ ${boxCount.LCL} LCL` : 'next 6 weeks'}</small></div>
      <div class="cp-kpi ${attention.length ? 'warn' : ''}"><span>Needs attention</span><b>${attention.length}</b><small>${[['overdue', 'late'], ['waiting', 'waiting on us']].map(([s, l]) => { const c = open.filter((o) => o.st === s).length; return c ? `${c} ${l}` : null; }).filter(Boolean).concat(open.filter((o) => !o.cbm).length ? [`${open.filter((o) => !o.cbm).length} no CBM`] : []).concat(open.filter((o) => !o.port).length ? [`${open.filter((o) => !o.port).length} no port`] : []).join(' · ') || 'All good'}</small></div>
    </div>`;

    const card = (o) => html`<div class="cp-card" style="--c:${o.col}">${editBtn(o)}
      <div class="cp-card-top"><b>${o.sup?.name || 'Supplier'}</b><span>${cbmText(o.cbm)}${o.cbm_estimated ? html`<i title="Estimated from carton size"> est.</i>` : ''}</span></div>
      <div class="sub">${o.po}${filesFor(o.supplier_id, o.po).length ? html` <a class="cp-clip" href="${BASE}?view=docs&po=${encodeURIComponent(o.po)}" title="Documents for ${o.po}">📎${filesFor(o.supplier_id, o.po).length}</a>` : ''}${o.product ? ` · ${o.product}` : ''}${o.qty ? ` · ${fmt.int ? fmt.int(o.qty) : o.qty} pcs` : ''}</div>
      <div class="cp-card-foot"><span>${o.ready_date ? `Ready ${PL.short(o.ready_date)}` : 'No ready date'}</span>${tag(o.st)}</div>
      ${o.st === 'waiting' ? html`<div class="cp-wait">Waiting on us: ${o.pending_from_us}</div>` : ''}</div>`;

    let body;
    if (view === 'port') {
      body = portOrder.length ? html`<div class="cp-board">${portOrder.map((k) => {
        const weeks = Object.keys(ports[k]).sort((a, b) => (a === 'nodate' ? 1 : b === 'nodate' ? -1 : a.localeCompare(b)));
        const total = Object.values(ports[k]).flat().reduce((a, o) => a + (Number(o.cbm) || 0), 0);
        return html`<section class="cp-col ${k === '?' ? 'unknown' : ''}"><div class="cp-col-h"><h2>${k === '?' ? 'Port to confirm' : portName(k) || k}</h2><span class="sub">${k === '?' ? 'set the port' : k}</span></div>
          <div class="cp-col-sum"><b>${n1(total)} m³</b>${k !== '?' ? ` · ≈ ${PL.suggest(total).text}` : ''}</div>
          ${weeks.map((w) => {
            const ls = ports[k][w]; const cbm = ls.reduce((a, o) => a + (Number(o.cbm) || 0), 0); const sg = PL.suggest(cbm);
            const lab = w === 'nodate' ? { wk: 'No ready date', dates: '' } : PL.weekLabel(w);
            return html`<div class="cp-week"><div class="cp-week-h"><span>${lab.wk}${w === thisWeek ? ' · this week' : ''}</span><span>${lab.dates}</span></div>
              ${ls.map(card)}
              ${k !== '?' && cbm ? html`<div class="cp-fit"><div><b>${sg.text}</b><span>${sg.lcl ? 'LCL' : `${sg.fill}% full`}</span></div><div class="cp-bar"><i style="width:${sg.lcl && sg.boxes.length === 1 ? Math.round(cbm / 15 * 100) : sg.fill}%;background:${sg.lcl && sg.boxes.length === 1 ? '#d07a1e' : sg.fill >= 75 ? '#2f8a63' : '#d07a1e'}"></i></div></div>` : ''}</div>`;
          })}</section>`;
      })}</div>` : html`<div class="card cp-empty"><h2>No open orders yet</h2><p class="muted">Import a supplier's open-order report, PO or status email to start planning.</p><a class="btn" href="${BASE}/import">Import orders</a></div>`;
    } else if (view === 'timeline') {
      const weeks = Array.from({ length: 10 }, (_, i) => PL.addDays(thisWeek, i * 7));
      const end = PL.addDays(weeks[9], 7);
      const sail = await db.list('sailings', { filters: { etd: ['gte', thisWeek] }, order: 'etd.asc' }).catch(() => []);
      const col = (d) => { if (!d || d < thisWeek) return 0; const i = Math.floor((Date.parse(d) - Date.parse(thisWeek)) / (7 * 864e5)); return Math.min(9, i); };
      body = html`<div class="cp-legend">${['ready', 'production', 'waiting', 'overdue'].map((s) => html`<span><i style="background:${PL.STATE[s].color}"></i>${PL.STATE[s].label}</span>`)}<span><svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5-5 5-5-5z" fill="#2c568f"></path></svg>Sailing to LA / Long Beach</span></div>
        <div class="card cp-tl-wrap"><div class="cp-tl">
          <div class="cp-tl-row head"><div class="cp-tl-l">Port · PO</div>${weeks.map((w) => { const l = PL.weekLabel(w); return html`<div class="cp-tl-w ${w === thisWeek ? 'now' : ''}"><b>${l.wk}</b><span>${l.dates}</span></div>`; })}</div>
          ${portOrder.map((k) => {
            const ls = Object.values(ports[k]).flat().filter((o) => !o.ready_date || o.ready_date < end);
            const sp = sail.filter((s) => s.origin === k && s.etd < end);
            return html`<div class="cp-tl-port"><div class="cp-tl-row ph"><div class="cp-tl-l"><b>${k === '?' ? 'Port to confirm' : portName(k) || k}</b><span class="sub">${n1(ls.reduce((a, o) => a + (Number(o.cbm) || 0), 0))} m³</span></div>
              ${weeks.map((w, i) => html`<div class="cp-tl-s">${sp.filter((s) => col(s.etd) === i && s.etd >= w).slice(0, 4).map((s) => html`<span title="${s.carrier}${s.vessel ? ` · ${s.vessel}` : ''} · ${SC.PORT[s.destination]?.name || ''} · ${s.transit_days || '?'} d"><svg width="8" height="8" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5-5 5-5-5z" fill="#2c568f"></path></svg>${s.carrier} ${Number(s.etd.slice(8))}</span>`)}</div>`)}</div>
              ${ls.map((o) => { const c = col(o.ready_date); return html`<div class="cp-tl-row"><div class="cp-tl-l"><b>${o.po}</b><span class="sub">${o.sup?.name || ''}${o.cbm ? ` · ${n1(o.cbm)} m³` : ''}</span></div><div class="cp-tl-bar" style="grid-column:${c + 2} / ${Math.min(c + 3, 12)};background:${PL.STATE[o.st].color}" title="${[o.product, o.ready_date ? `Ready ${PL.short(o.ready_date)}` : 'No ready date', o.production_status, o.st === 'waiting' ? `Waiting on us: ${o.pending_from_us}` : null].filter(Boolean).join(' · ')}">${o.st === 'overdue' ? `Since ${PL.short(o.ready_date)}` : o.ready_date ? `Ready ${PL.short(o.ready_date)}` : 'No date'}${o.st === 'waiting' ? ` · ${o.pending_from_us}` : ''}</div></div>`; })}</div>`;
          })}
        </div></div>`;
    } else if (view === 'docs') {
      const fPo = String(req.query.po || '').trim();
      const shown = files.filter((f) => (!fSup || f.supplier_id === fSup) && (!fPo || (f.pos || []).some((x) => PL.normPo(x) === PL.normPo(fPo))));
      const allSup = await db.list('suppliers', { select: 'id,name,country,contact_name,email,active', order: 'name.asc' });
      const icon = (f) => (/pdf/.test(f.content_type) ? 'PDF' : /image/.test(f.content_type) ? 'IMG' : /sheet|excel|csv/.test(f.content_type) ? 'XLS' : /word/.test(f.content_type) ? 'DOC' : 'FILE');
      body = html`<div class="cp-docs">
        <section class="card cp-up"><h2 class="sec">Upload POs and documents</h2>
          <form method="post" action="${BASE}/files" enctype="multipart/form-data" data-busy>
            ${SAM.supplierPicker(SAM.pickableSuppliers(allSup, fSup), fSup)}
            <label>PO numbers <input name="pos" value="${fPo}" placeholder="e.g. PO200013, PO200014 (optional)"></label>
            <label>Type <select name="kind"><option value="">Detect from the file name</option>${PL.DOC_KINDS.map((k) => html`<option>${k}</option>`)}</select></label>
            <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple required aria-label="Choose files"><span class="dz-main" data-main>Drag &amp; drop or choose files</span><span class="dz-hint">PDF, Excel, Word, images · up to 25 MB each</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <label class="cp-chk"><input type="checkbox" name="read" value="1"> Also read the order lines with AI</label>
            <button class="btn">Upload</button></form></section>
        <section class="card cp-files"><div class="head-row"><h2 class="sec">${fPo ? `Documents for ${fPo}` : 'All documents'} <span class="sub">${shown.length}</span></h2>${fPo ? html`<a class="link small" href="${BASE}?view=docs${fSup ? `&supplier=${fSup}` : ''}">Show all</a>` : ''}</div>
          ${shown.length ? html`<ul class="cp-filelist">${shown.map((f) => html`<li>
            <span class="cp-ficon ${icon(f).toLowerCase()}">${icon(f)}</span>
            <div class="cp-fmain"><a href="${BASE}/files/${f.id}?inline=1" ${/pdf|image/.test(f.content_type || '') ? raw(`data-preview="${BASE}/files/${f.id}?inline=1" data-type="${/image/.test(f.content_type) ? 'image' : 'doc'}" data-dl="${BASE}/files/${f.id}"`) : raw('target="_blank" rel="noopener"')}><b>${f.name}</b></a>
              <div class="sub">${f.kind || 'Document'} · ${sups[f.supplier_id]?.name || ''} · ${fmt.date(f.created_at)}${f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</div>
              ${(f.pos || []).length ? html`<div class="cp-pos">${f.pos.slice(0, 12).map((x) => html`<a href="${BASE}?view=docs&po=${encodeURIComponent(x)}">${x}</a>`)}${f.pos.length > 12 ? html`<span class="sub">+${f.pos.length - 12}</span>` : ''}</div>` : ''}</div>
            <div class="cp-facts"><a class="icon-btn" href="${BASE}/files/${f.id}" title="Download" aria-label="Download ${f.name}">⬇</a>
              <form method="post" action="${BASE}/files/${f.id}/delete" class="inline" onsubmit="return confirm('Delete this document?')"><button class="icon-btn" title="Delete" aria-label="Delete ${f.name}">×</button></form></div></li>`)}</ul>`
          : html`<p class="muted">No documents yet. Upload POs here, or they are kept automatically when you import orders.</p>`}</section></div>`;
    } else {
      body = html`<div class="card"><div class="table-wrap"><table class="list cp-table"><thead><tr><th>Supplier</th><th>PO</th><th>Product</th><th class="r">Qty</th><th class="r">CBM</th><th>Ready</th><th>Inspection</th><th>Port</th><th>Status</th><th>Waiting on us</th><th>Docs</th><th></th></tr></thead>
        <tbody>${list.map((o) => html`<tr class="${o.shipped ? 'done' : ''}"><td><span class="cp-dot" style="background:${o.col}"></span>${o.sup?.name || '—'}</td><td><b>${o.po}</b></td><td>${o.product || '—'}</td><td class="r">${o.qty ?? '—'}</td><td class="r">${o.cbm ? n1(o.cbm) : '—'}${o.cbm_estimated ? html`<i class="sub"> est.</i>` : ''}</td>
          <td>${o.ready_date ? PL.short(o.ready_date) : '—'}</td><td>${o.inspection_date ? PL.short(o.inspection_date) : o.inspection_note || '—'}</td><td>${portName(o.port) || o.port_text || '—'}</td><td>${tag(o.st)}${o.production_status ? html`<div class="sub">${o.production_status}</div>` : ''}</td><td>${o.st === 'waiting' ? o.pending_from_us : '—'}</td>
          <td>${filesFor(o.supplier_id, o.po).length ? html`<a href="${BASE}?view=docs&po=${encodeURIComponent(o.po)}">📎 ${filesFor(o.supplier_id, o.po).length}</a>` : '—'}</td>
          <td class="cp-acts">${editBtn(o, 'link small')} <form method="post" action="${BASE}/${o.id}/shipped" class="inline"><button class="link small">${o.shipped ? 'Undo shipped' : 'Mark shipped'}</button></form>
            <form method="post" action="${BASE}/${o.id}/delete" class="inline" onsubmit="return confirm('Delete this order line?')"><button class="icon-btn" title="Delete" aria-label="Delete">×</button></form></td></tr>`)}</tbody></table></div>
        ${list.length ? '' : html`<p class="muted">Nothing to show.</p>`}</div>`;
    }

    res.html(page({
      title: 'Container planning · Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`${SCR.logisticsTabs('planning')}
        ${missing ? html`<p class="flash warn">Run the container planning SQL in Supabase first (supabase/schema.sql, "Container planning").</p>` : ''}
        <div class="cp-head"><div><h2 class="sl-title">Container planning</h2><p class="muted">Open purchase orders grouped by loading port and ready week, with a suggested container mix.</p></div>
          <div class="cp-head-r">${viewTabs(view, q)}<a class="btn" href="${BASE}/import">Import orders</a></div></div>
        <form class="cp-filters" method="get" action="${BASE}"><input type="hidden" name="view" value="${view}">
          <label>Supplier <select name="supplier" onchange="this.form.submit()"><option value="">All suppliers</option>${Object.values(sups).sort((a, b) => a.name.localeCompare(b.name)).map((s) => html`<option value="${s.id}" ${s.id === fSup ? raw('selected') : ''}>${s.name}</option>`)}</select></label>
          <label class="cp-chk"><input type="checkbox" name="shipped" value="1" ${showShipped ? raw('checked') : ''} onchange="this.form.submit()"> Show shipped</label>
          <a class="link small" href="${BASE}.csv">Download CSV</a></form>
        ${kpis}${body}
        ${editDialog(req.url)}`,
    }));
  }));

  // ── import ────────────────────────────────────────────────────────────────
  router.get(`${BASE}/import`, G(async (req, res) => {
    const all = await db.list('suppliers', { select: 'id,name,country,contact_name,email,active', order: 'name.asc' });
    const sups = SAM.pickableSuppliers(all, req.query.supplier);
    res.html(page({
      title: 'Import orders · Container planning', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`<p><a href="${BASE}">‹ Container planning</a></p><h1>Import orders</h1>
        <p class="muted">Drop the supplier's open-order report, PO or production status (Excel, PDF, screenshot, or pasted email). AI reads every line; you check it before it is saved.</p>
        <form method="post" action="${BASE}/import" enctype="multipart/form-data" data-busy class="cp-import">
          <section class="card"><h2 class="sec">1 · Supplier</h2>${SAM.supplierPicker(sups, req.query.supplier || '')}
            <label class="cp-new">Or a new supplier <input name="new_supplier" placeholder="Company name" autocomplete="off"></label></section>
          <section class="card"><h2 class="sec">2 · Documents</h2>
            <div class="mdrop" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp" aria-label="Choose order files"><span class="dz-main" data-main>Drag &amp; drop, paste a screenshot, or choose files</span><span class="dz-hint">Excel · CSV · PDF · photo · up to 20 MB</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <label class="cp-paste">Or paste an email / table<textarea name="text" rows="4" placeholder="Paste the supplier's update"></textarea></label>
            <button class="btn" ${AI.enabled() ? '' : raw('disabled title="Set ANTHROPIC_API_KEY"')}>Read with AI</button></section>
        </form>`,
    }));
  }));

  router.post(`${BASE}/import`, G(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: 80 * 1024 * 1024 });
    const back = (m) => { flash(res, 'error', m); res.redirect(`${BASE}/import${fields.supplier_id ? `?supplier=${encodeURIComponent(fields.supplier_id)}` : ''}`); };
    const newName = String(fields.new_supplier || '').trim().slice(0, 200);
    let supplier = fields.supplier_id ? await db.get('suppliers', fields.supplier_id) : null;
    if (!supplier && !newName) return back('Choose a supplier or type a new one');
    let created = false;
    if (!supplier) {   // a new supplier is created now, so its documents can be stored with it
      supplier = (await db.list('suppliers', { select: 'id,name' })).find((x) => x.name.trim().toLowerCase() === newName.toLowerCase()) || null;
      if (!supplier) { supplier = await db.insert('suppliers', { name: newName, crm_status: 'Active', created_via: 'planning' }).catch(() => db.insert('suppliers', { name: newName })); created = true; }
    }
    const docs = (files.file ? [].concat(files.file) : []).filter((f) => f.buffer?.length);
    const text = String(fields.text || '').trim();
    if (!docs.length && text.length < 10) return back('Add a file or paste the update');
    let lines = []; const notes = []; let aiName = null;
    for (const f of docs) {
      try { const r = await PL.readOrders({ name: f.name, buffer: f.buffer }); f.pos = r.orders.map((o) => o.po); lines = lines.concat(r.orders); aiName = aiName || r.supplierName; notes.push(`${f.name}: ${r.orders.length} lines`); }
      catch (e) { notes.push(`${f.name}: could not be read (${String(e.message).slice(0, 120)})`); }
    }
    if (text.length >= 10) { try { const r = await PL.readOrders({ name: 'Pasted text', text }); lines = lines.concat(r.orders); aiName = aiName || r.supplierName; notes.push(`Pasted text: ${r.orders.length} lines`); } catch (e) { notes.push(`Pasted text: could not be read (${String(e.message).slice(0, 120)})`); } }
    // keep every uploaded document, linked to the POs found in it
    const stored = await PL.storeFiles(db, supplier.id, docs, { batch: `imp-${Date.now().toString(36)}`, by: req.staff?.name || 'Owner' }).catch((e) => ({ saved: [], errors: [e.message] }));
    if (stored.saved.length) notes.push(`${stored.saved.length} file${stored.saved.length === 1 ? '' : 's'} stored`);
    if (stored.errors.length) notes.push(stored.errors.join(' · '));
    if (!lines.length) { flash(res, stored.saved.length ? 'warn' : 'error', `No order lines found. ${notes.join(' · ')}`); return res.redirect(stored.saved.length ? `${BASE}?view=docs&supplier=${supplier.id}` : `${BASE}/import`); }
    // default port: from the documents, else the supplier's usual FOB port
    let defPort = null;
    {
      const prods = await db.list('products', { filters: { supplier_id: supplier.id }, select: 'fob_port' }).catch(() => []);
      const cnt = {}; for (const p of prods) { const c = SC.portCode(p.fob_port); if (c) cnt[c] = (cnt[c] || 0) + 1; }
      defPort = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
    for (const o of lines) if (!o.port && defPort) { o.port = defPort; o.port_from_supplier = true; }
    await PL.estimateCbm(db, supplier.id, lines);
    const existing = await db.list('plan_orders', { filters: { supplier_id: supplier.id } }).catch(() => []);
    const d = PL.diff(lines, existing);
    const count = (c) => d.filter((x) => x.change === c).length;
    const portOpts = (sel) => html`<option value="">To confirm</option>${SC.ORIGINS.map((p) => html`<option value="${p.code}" ${p.code === sel ? raw('selected') : ''}>${p.name}</option>`)}`;
    res.html(page({
      title: 'Check orders · Container planning', nav: adminNav('logistics'), wide: true, req,
      body: html`<p><a href="${BASE}/import">‹ Back</a></p><h1>Check what AI read</h1>
        <p class="muted">${created ? html`New supplier: <b>${supplier.name}</b>` : supplier.name}${aiName && supplier && aiName.toLowerCase() !== supplier.name.toLowerCase() ? html` · document names <b>${aiName}</b>` : ''} · ${notes.join(' · ')}</p>
        <div class="cp-chips"><span class="cp-tag ok">${count('new')} new</span><span class="cp-tag plan">${count('updated')} updated</span><span class="cp-tag done">${count('same')} unchanged</span>${d.some((x) => !x.cbm) ? html`<span class="cp-tag wait">${d.filter((x) => !x.cbm).length} without CBM</span>` : ''}</div>
        <form method="post" action="${BASE}/save" data-busy class="card">
          <input type="hidden" name="supplier_id" value="${supplier.id}"><input type="hidden" name="n" value="${d.length}">
          <input type="hidden" name="source" value="${docs.map((f) => f.name).join(', ') || 'Pasted text'}">
          <div class="table-wrap"><table class="list cp-review"><thead><tr><th>Save</th><th>PO</th><th>Product</th><th class="r">Qty</th><th class="r">CBM</th><th>Ready</th><th>Status</th><th>Waiting on us</th><th>Port</th><th>Change</th></tr></thead>
          <tbody>${d.map((o, i) => html`<tr class="${o.change}">
            <td><input type="checkbox" name="r${i}_on" value="1" ${o.change === 'same' ? '' : raw('checked')} aria-label="Save line ${i + 1}"><input type="hidden" name="r${i}_json" value="${JSON.stringify(o)}"></td>
            <td><input name="r${i}_po" value="${o.po}" class="w-po"></td>
            <td><input name="r${i}_product" value="${o.product || ''}" class="w-prod" placeholder="(whole PO)"></td>
            <td class="r"><input name="r${i}_qty" value="${o.qty ?? ''}" class="w-num" inputmode="numeric"></td>
            <td class="r"><input name="r${i}_cbm" value="${o.cbm ?? ''}" class="w-num ${o.cbm_estimated ? 'est' : ''}" inputmode="decimal" title="${o.cbm_estimated ? 'Estimated from carton size' : ''}"></td>
            <td><input type="date" name="r${i}_ready" value="${o.ready_date || ''}"></td>
            <td><input name="r${i}_status" value="${o.production_status || ''}" class="w-st"></td>
            <td><input name="r${i}_pending" value="${o.pending_from_us || ''}" class="w-st"></td>
            <td><select name="r${i}_port">${portOpts(o.port)}</select></td>
            <td>${o.change === 'new' ? html`<span class="cp-tag ok">New</span>` : o.change === 'same' ? html`<span class="cp-tag done">Unchanged</span>` : html`<span class="cp-tag plan">Updated</span><div class="sub">${o.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(' · ')}</div>`}</td></tr>`)}</tbody></table></div>
          <p class="sub">Lines with no product update every line of that PO (ready date, status). Orange CBM is estimated from the carton size in your catalog.</p>
          <button class="btn">Save checked lines</button>
        </form>`,
    }));
  }));

  router.post(`${BASE}/save`, G(async (req, res) => {
    const { fields } = await parseForm(req, { limitBytes: 8 * 1024 * 1024 });
    let supplier = fields.supplier_id ? await db.get('suppliers', fields.supplier_id) : null;
    if (!supplier) {
      const name = String(fields.new_supplier || '').trim().slice(0, 200);
      if (!name) throw new HttpError(400, 'Choose a supplier');
      const existing = (await db.list('suppliers', { select: 'id,name' })).find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
      supplier = existing || await db.insert('suppliers', { name, crm_status: 'Active', created_via: 'planning' }).catch(() => db.insert('suppliers', { name }));
    }
    const n = Math.min(2000, Number(fields.n) || 0);
    const lines = [];
    for (let i = 0; i < n; i++) {
      if (fields[`r${i}_on`] !== '1') continue;
      let o = {}; try { o = JSON.parse(fields[`r${i}_json`] || '{}'); } catch { /* ignore */ }
      const num = (v) => { const x = Number(String(v || '').replace(/[^0-9.\-]/g, '')); return String(v || '').trim() && Number.isFinite(x) ? x : null; };
      const cbm = num(fields[`r${i}_cbm`]);
      lines.push({ ...o, po: String(fields[`r${i}_po`] || o.po || '').trim().slice(0, 60), product: String(fields[`r${i}_product`] || '').trim().slice(0, 300) || null,
        qty: num(fields[`r${i}_qty`]), cbm, cbm_estimated: !!o.cbm_estimated && cbm === o.cbm, ready_date: PL.isoDay(fields[`r${i}_ready`]),
        production_status: String(fields[`r${i}_status`] || '').trim().slice(0, 120) || null, pending_from_us: String(fields[`r${i}_pending`] || '').trim().slice(0, 200) || null,
        port: SC.PORT[fields[`r${i}_port`]] ? fields[`r${i}_port`] : null });
    }
    const valid = lines.filter((o) => o.po);
    if (!valid.length) { flash(res, 'warn', 'No lines were checked'); return res.redirect(`${BASE}/import?supplier=${supplier.id}`); }
    const r = await PL.save(db, supplier.id, valid, { batch: `imp-${Date.now().toString(36)}`, sourceName: String(fields.source || '').slice(0, 200) });
    flash(res, 'ok', `${supplier.name}: ${r.added} new, ${r.updated} updated${r.same ? `, ${r.same} unchanged` : ''}`);
    res.redirect(`${BASE}?supplier=${supplier.id}`);
  }));

  router.post(`${BASE}/:id/edit`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const o = await db.get('plan_orders', req.params.id); if (!o) throw new HttpError(404, 'Not found');
    const num = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return String(v ?? '').trim() && Number.isFinite(x) ? x : null; };
    const t = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    const port = SC.PORT[f.port] ? f.port : null;
    const shared = { port, ready_date: PL.isoDay(f.ready_date), production_status: t(f.production_status, 120), inspection_date: PL.isoDay(f.inspection_date), pending_from_us: t(f.pending_from_us, 200), shipped: f.shipped === '1' };
    const own = { product: t(f.product, 300), qty: num(f.qty), cbm: num(f.cbm), notes: t(f.notes, 1000) };
    if (own.cbm !== (o.cbm === null || o.cbm === undefined ? null : Number(o.cbm))) own.cbm_estimated = false;
    const now = new Date().toISOString();
    await db.update('plan_orders', { id: o.id }, { ...shared, ...own, updated_at: now });
    let extra = 0;
    if (f.all_po === '1') {
      for (const x of await db.list('plan_orders', { filters: { supplier_id: o.supplier_id } })) {
        if (x.id === o.id || PL.normPo(x.po) !== PL.normPo(o.po)) continue;
        await db.update('plan_orders', { id: x.id }, { ...shared, updated_at: now }); extra++;
      }
    }
    if (f.all_port === '1' && port) {
      for (const x of await db.list('plan_orders', { filters: { supplier_id: o.supplier_id } })) {
        if (x.id === o.id || x.port || x.shipped) continue;
        await db.update('plan_orders', { id: x.id }, { port, updated_at: now }); extra++;
      }
    }
    flash(res, 'ok', `${o.po} saved${extra ? ` (+${extra} other line${extra === 1 ? '' : 's'})` : ''}`);
    const back = String(f.back || '');
    res.redirect(back.startsWith(BASE) || back.startsWith('/admin/orders') ? back : BASE);
  }));

  router.post(`${BASE}/:id/shipped`, G(async (req, res) => {
    await parseForm(req).catch(() => null);
    const o = await db.get('plan_orders', req.params.id); if (!o) throw new HttpError(404, 'Not found');
    await db.update('plan_orders', { id: o.id }, { shipped: !o.shipped, updated_at: new Date().toISOString() });
    flash(res, 'ok', `${o.po} ${o.shipped ? 'back to open' : 'marked shipped'}`);
    res.redirect(`${BASE}?view=table`);
  }));
  router.post(`${BASE}/:id/delete`, G(async (req, res) => {
    await parseForm(req).catch(() => null);
    await db.remove('plan_orders', { id: req.params.id });
    flash(res, 'ok', 'Order line deleted');
    res.redirect(`${BASE}?view=table`);
  }));

  router.post(`${BASE}/files`, G(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: 120 * 1024 * 1024 });
    const supplier = fields.supplier_id ? await db.get('suppliers', fields.supplier_id) : null;
    const back = (t, m, q = '') => { flash(res, t, m); const b = String(fields.back || ''); res.redirect(b.startsWith('/admin/orders') ? `${b.split('#')[0]}#docs` : `${BASE}?view=docs${q}`); };
    if (!supplier) return back('error', 'Choose a supplier');
    const docs = (files.file ? [].concat(files.file) : []).filter((f) => f.buffer?.length);
    if (!docs.length) return back('error', 'Choose at least one file', `&supplier=${supplier.id}`);
    const typed = String(fields.pos || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    let read = null;
    if (fields.read === '1' && AI.enabled()) {
      const lines = [];
      for (const f of docs) { try { const r = await PL.readOrders({ name: f.name, buffer: f.buffer }); f.pos = [...typed, ...r.orders.map((o) => o.po)]; lines.push(...r.orders); } catch { /* keep the file anyway */ } }
      if (lines.length) { for (const o of lines) if (!o.port) o.port = null; await PL.estimateCbm(db, supplier.id, lines); read = await PL.save(db, supplier.id, lines, { batch: `doc-${Date.now().toString(36)}`, sourceName: docs.map((f) => f.name).join(', ') }); }
    }
    const kind = PL.DOC_KINDS.includes(fields.kind) ? fields.kind : null;
    const r = await PL.storeFiles(db, supplier.id, docs, { pos: typed, kind, by: req.staff?.name || 'Owner' });
    back(r.errors.length ? 'warn' : 'ok', `${r.saved.length} document${r.saved.length === 1 ? '' : 's'} stored for ${supplier.name}${read ? ` · orders: ${read.added} new, ${read.updated} updated` : ''}${r.errors.length ? ` · ${r.errors.join(' · ')}` : ''}`, `&supplier=${supplier.id}`);
  }));
  router.get(`${BASE}/files/:id`, G(async (req, res) => {
    const f = await db.get('plan_files', req.params.id); if (!f) throw new HttpError(404, 'Document not found');
    const buf = await db.docs.download(f.path);
    const inline = req.query.inline === '1' && /^(image\/|application\/pdf)/.test(f.content_type || '');
    res.writeHead(200, { 'Content-Type': f.content_type || 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }));
  router.post(`${BASE}/files/:id/delete`, G(async (req, res) => {
    await parseForm(req).catch(() => null);
    const f = await db.get('plan_files', req.params.id);
    if (f) { await db.docs.remove([f.path]).catch(() => null); await db.remove('plan_files', { id: f.id }); }
    flash(res, 'ok', 'Document deleted');
    res.redirect(`${BASE}?view=docs${f ? `&supplier=${f.supplier_id}` : ''}`);
  }));

  router.get(`${BASE}.csv`, G(async (req, res) => {
    const { orders, sups } = await load();
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['Supplier', 'PO', 'Product', 'SKU', 'Qty', 'Cartons', 'CBM', 'CBM estimated', 'Gross kg', 'Ready', 'Inspection', 'Status', 'Waiting on Lulyboo', 'Port', 'Shipped'],
      ...orders.map((o) => [sups[o.supplier_id]?.name, o.po, o.product, o.sku, o.qty, o.cartons, o.cbm, o.cbm_estimated ? 'yes' : '', o.gross_kg, o.ready_date, o.inspection_date || o.inspection_note, o.production_status, o.pending_from_us, portName(o.port) || o.port_text, o.shipped ? 'yes' : ''])];
    const body = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="container-planning-${PL.today()}.csv"` });
    res.end(body);
  }));
}

module.exports = planningRoutes;
module.exports.editDialog = editDialog;
module.exports.editBtn = editBtn;
