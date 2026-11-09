'use strict';
// Samples.
//   Admin  /admin/samples ...   request a sample, follow shipping (DHL/FedEx/UPS tracked automatically), costs, documents, evaluation
//   Portal /portal/samples ...  the supplier confirms (fee, ship date), ships (waybill photo read by AI), sees tracking and the result
// Suppliers see only their own samples and never the internal notes.

const { html, raw, fmt, t, m, confirmAttr } = require('../lib/html');
const { icon } = require('../views/icons');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const { currentSupplierUser } = require('../auth');
const P = require('../projects');
const S = require('../samples');
const CR = require('../carriers');
const AI = require('../ai');

const num = (x) => { if (x === undefined || x === null || String(x).trim() === '') return null; const n = Number(String(x).replace(/[,$\s]/g, '')); return Number.isFinite(n) ? n : null; };
const int = (x) => { const n = num(x); return n === null ? null : Math.round(n); };
const str = (x, max = 4000) => { const s = String(x ?? '').replace(/\r/g, '').trim().slice(0, max); return s || null; };
const day = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const THUMB = /\.(png|jpe?g|webp|gif)$/i;
const shortDate = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' }); } catch { return String(iso).slice(0, 10); } };
const when = (iso) => { if (!iso) return ''; let txt = iso; try { txt = new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' }); } catch { /* keep */ } return html`<time datetime="${iso}" data-local>${txt}</time>`; };
const daysSince = (iso, ref = Date.now()) => Math.floor((ref - Date.parse(iso)) / 864e5);
const serve = (res, buf, name, type, inline) => {
  res.statusCode = 200;
  const ok = inline && P.INLINE_OK.test(name);
  res.setHeader('Content-Type', ok ? (P.MIME[P.extOf(name)] || type || 'application/octet-stream') : (type || 'application/octet-stream'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (ok) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', /\.pdf$/i.test(name) ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"); }
  res.setHeader('Content-Disposition', `${ok ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(buf);
};
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.zip';
const drop = (name, en, zh, { multiple = true, accept = ACCEPT, hint = 'PDF, JPG, PNG' } = {}) => html`<div class="mdrop small" data-filebox${multiple ? '' : raw(' data-max="1"')}>
  <div class="mdrop-box"><input type="file" name="${name}" ${multiple ? raw('multiple') : ''} accept="${accept}" aria-label="Choose files">
    <span class="dz-main" data-main>${t(en, zh)}</span><span class="dz-hint">${hint} · ${t('up to 20 MB', '最大 20 MB')}</span></div>
  <ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>`;
const carrierBadge = (c) => (c && c !== 'other' ? html`<span class="cl ${c}">${CR.CARRIERS[c]?.short || c}</span>` : '');
const statusPill = (s, zh = false) => html`<span class="stp ${S.pillCls(s)}"><i></i>${zh ? t(s, S.STATUS_ZH[s] || s) : s}</span>`;
const kindLabel = (k, zh) => (zh ? t(...(S.FILE_KINDS[k] || S.FILE_KINDS.other)) : (S.FILE_KINDS[k] || S.FILE_KINDS.other)[0]);
const freightLabel = (k, zh) => (S.FREIGHT_BY[k] ? (zh ? t(...S.FREIGHT_BY[k]) : S.FREIGHT_BY[k][0]) : '');

// The next thing that should happen, and whether it is on us ("mine").
function nextAction(s, today) {
  const late = s.due_ship_date && s.due_ship_date < today ? Math.round((Date.parse(today) - Date.parse(s.due_ship_date)) / 864e5) : 0;
  switch (s.status) {
    case 'Requested': return late ? { text: `Supplier late ${late} d`, sub: 'Not confirmed · reminders sent', tone: 'bad' } : { text: 'Waiting for supplier', sub: s.due_ship_date ? `Ship by ${shortDate(s.due_ship_date)}` : 'To confirm' };
    case 'Confirmed':
      if (Number(s.sample_fee) > 0 && !s.fee_paid_at) return { text: 'Pay sample fee', sub: fmt.money(s.sample_fee, s.currency), tone: 'bad', mine: true };
      return late ? { text: `Not shipped · ${late} d late`, sub: 'Reminders sent automatically', tone: 'bad' } : { text: 'Waiting for shipment', sub: s.due_ship_date ? `Ship by ${shortDate(s.due_ship_date)}` : '' };
    case 'Shipped': case 'In transit': case 'Out for delivery':
      return { text: 'Wait for delivery', sub: CR.configured(s.carrier) ? 'Auto-tracked' : 'Track on carrier site' };
    case 'Customs': return { text: 'In customs', sub: 'Watch for duty or documents', tone: 'warn' };
    case 'Exception': return { text: 'Check with carrier', sub: s.tracking_summary || 'Delivery problem', tone: 'bad', mine: true };
    case 'Delivered': return { text: 'Evaluate sample', sub: s.delivered_at ? `Delivered ${daysSince(s.delivered_at)} d ago` : '', tone: 'warn', mine: true };
    case 'Revise': return { text: 'Request revised sample', sub: 'Evaluation: revise', mine: true };
    case 'Approved': return { text: 'Done', sub: s.eval_score ? `Score ${s.eval_score}/10` : 'Approved' };
    case 'Rejected': return { text: 'Done', sub: 'Rejected' };
    default: return { text: s.status, sub: '' };
  }
}

const STEPS = [['Requested', '已请求'], ['Confirmed', '已确认'], ['Shipped', '已寄出'], ['In transit', '运输中'], ['Delivered', '已签收'], ['Evaluated', '已评估']];
function stepIndex(s) {
  return { Requested: 0, Confirmed: 1, Shipped: 2, 'In transit': 3, Customs: 3, 'Out for delivery': 3, Exception: 3, Delivered: 4, Approved: 5, Revise: 5, Rejected: 5, Cancelled: -1 }[s.status] ?? 0;
}
function tracker(s, zh = false) {
  const cur = stepIndex(s);
  const dates = [s.created_at, s.confirmed_at, s.shipped_at, null, s.delivered_at, s.evaluated_at];
  const label = (i) => (i === 3 && ['Customs', 'Out for delivery', 'Exception'].includes(s.status) ? (zh ? t(s.status, S.STATUS_ZH[s.status]) : s.status) : (zh ? t(...STEPS[i]) : STEPS[i][0]));
  return html`<div class="track">${STEPS.map((_, i) => {
    const cls = i < cur || (i === cur && i === 5) ? 'done' : i === cur ? `cur${s.status === 'Exception' ? ' bad' : ''}` : '';
    const sub = i === 3 && i === cur && s.eta ? `ETA ${shortDate(s.eta)}` : dates[i] && i <= cur ? shortDate(dates[i]) : '';
    return html`<div class="s ${cls}"><div class="dot">${cls === 'done' ? '✓' : i + 1}</div>${label(i)}<small>${sub || '—'}</small></div>`;
  })}</div>`;
}

function timeline(events, { carrierOnly = false } = {}) {
  const list = carrierOnly ? events.filter((e) => ['dhl', 'fedex', 'ups'].includes(e.source)) : events;
  if (!list.length) return '';
  return html`<ul class="tl">${list.map((e, i) => html`<li class="${i === 0 ? 'now' : ''} ${e.code === 'exception' ? 'warn' : ''} ${e.code === 'delivered' ? 'ok' : ''}"><span class="tl-t">${when(e.at)}</span><span class="d"></span><div><b>${e.description || e.code}</b>${e.location ? html`<small>${e.location}</small>` : ''}</div></li>`)}</ul>`;
}

function docTiles(files, hrefOf, { zh = false, del = null } = {}) {
  if (!files.length) return html`<p class="muted small">${zh ? t('No documents yet.', '暂无文件。') : 'No documents yet.'}</p>`;
  return html`<ul class="att-tiles">${files.map((f) => {
    const href = hrefOf(f); const img = THUMB.test(f.name); const prev = P.INLINE_OK.test(f.name);
    const face = img ? html`<img src="${href}?inline=1" alt="" loading="lazy">` : html`<span class="att-ic">${f.kind === 'waybill' ? '✈️' : f.kind === 'payment' ? '💳' : f.kind === 'photo' ? '📷' : '🧾'}</span><span class="att-ext">${P.extOf(f.name).slice(1).toUpperCase()}</span>`;
    return html`<li class="att-tile">${prev ? html`<button type="button" class="att-face" data-preview="${href}?inline=1" data-type="${img ? 'image' : 'doc'}" data-dl="${href}" aria-label="Preview">${face}</button>` : html`<a class="att-face" href="${href}">${face}</a>`}
      <div class="att-meta"><span>${kindLabel(f.kind, zh)}</span>${del ? html`<form method="post" action="${del(f)}" class="inline" data-confirm="Remove this file?"><button class="ic-btn danger" title="Remove" aria-label="Remove">${icon('trash', 14)}</button></form>` : html`<a class="att-dl" href="${href}" title="Download" aria-label="Download">${icon('download', 15)}</a>`}</div></li>`;
  })}</ul>`;
}

// Supplier field as a popup with search (single choice). Leaves out inactive and "Pending: email" suppliers.
const pickableSuppliers = (all, keepId) => all.filter((x) => (x.active !== false && !/^pending:/i.test(String(x.name || '').trim())) || x.id === keepId);
const supplierPicker = (suppliers, sel) => html`<div class="pick1" data-single-pick><span class="lbl">Supplier</span>
              <input type="hidden" name="supplier_id" value="${sel}" data-pick-value required>
              <button type="button" class="pick1-btn" data-pick-open><span data-pick-label>${suppliers.find((x) => x.id === sel)?.name || 'Choose a supplier…'}</span><span aria-hidden="true">▾</span></button>
              <dialog class="pick-dlg" data-pick-dlg aria-label="Choose a supplier">
                <div class="pick-head"><div class="pick-title"><h3>Choose a supplier</h3><button type="button" class="pick-x" data-pick-close aria-label="Close">×</button></div>
                  <input type="search" class="pick-q" placeholder="Search by name, country, contact or email" autocomplete="off" data-pick-q><span class="sub" data-pick-count>${suppliers.length} suppliers</span></div>
                <ul class="pick-list">${suppliers.map((x) => html`<li><button type="button" class="pick1-row ${x.id === sel ? 'on' : ''}" data-id="${x.id}" data-name="${x.name}" data-q="${[x.name, x.country, x.contact_name, x.email].filter(Boolean).join(' ').toLowerCase()}">
                  <span class="pk-av" aria-hidden="true">${String(x.name).replace(/\(.*?\)/g, '').split(/[\s,.-]+/).filter((w) => /^[a-z0-9]/i.test(w) && !/^(co|ltd|inc|llc|the)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'}</span>
                  <span class="pk-main"><b>${x.name}</b><span class="sub">${[x.country, x.contact_name, x.email].filter(Boolean).join(' · ')}</span></span><span class="pick1-check" aria-hidden="true">✓</span></button></li>`)}</ul>
                <p class="pick-empty" data-pick-empty hidden>No suppliers match your search.</p>
              </dialog></div>`;

module.exports = function sampleRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const A = (fn) => async (req, res) => {
    const cur = await currentSupplierUser(db, config, req);
    if (!cur) return res.redirect('/login');
    req.supplier = cur.supplier; req.user = cur.user; req.base = '/portal';
    req.navBadges = await S.supplierBadges(db, cur.supplier.id);
    return fn(req, res);
  };
  const supNav = () => require('./supplier').nav('samples');
  const now = () => new Date().toISOString();
  const today = () => P.dayIn();
  const log = (sampleId, description, source = 'system', code = 'note') => db.insert('sample_events', { sample_id: sampleId, at: now(), code, description: String(description).slice(0, 300), source, created_at: now() });
  async function load(id) { const s = await db.get('samples', id); if (!s) throw new HttpError(404, 'Sample not found'); return s; }

  // ═════════════════════════ ADMIN ═════════════════════════
  const FILTERS = [
    ['all', 'All', () => true], ['action', 'Action needed', (s, d) => nextAction(s, d).mine],
    ['waiting', 'Not shipped', (s) => ['Requested', 'Confirmed'].includes(s.status)],
    ['transit', 'In transit', (s) => ['Shipped', 'In transit', 'Out for delivery'].includes(s.status)],
    ['customs', 'Customs & problems', (s) => ['Customs', 'Exception'].includes(s.status)],
    ['evaluate', 'To evaluate', (s) => s.status === 'Delivered'],
    ['unpaid', 'Unpaid', (s) => Number(s.sample_fee) > 0 && !s.fee_paid_at && s.status !== 'Cancelled'],
    ['closed', 'Closed', (s) => S.CLOSED.includes(s.status)],
  ];

  router.get('/admin/samples', G(async (req, res) => {
    const [samples, suppliers] = await Promise.all([db.list('samples', { order: 'created_at.desc' }), db.list('suppliers', { select: 'id,name' })]);
    const names = Object.fromEntries(suppliers.map((x) => [x.id, x.name]));
    const thumbs = {};
    for (const f of await db.list('sample_files', { filters: { kind: 'photo' }, order: 'created_at.asc' }).catch(() => [])) if (THUMB.test(f.name) && !thumbs[f.sample_id]) thumbs[f.sample_id] = f.id;
    const d = today(); const f = FILTERS.find(([k]) => k === req.query.f) || FILTERS[0];
    const q = String(req.query.q || '').trim().toLowerCase();
    const open = samples.filter((s) => f[0] === 'closed' || f[0] === 'all' ? true : !S.CLOSED.includes(s.status));
    const shown = open.filter((s) => f[2](s, d) && (!q || `${s.ref} ${s.title} ${names[s.supplier_id] || ''} ${s.tracking_no || ''}`.toLowerCase().includes(q)));
    const live = samples.filter((s) => !S.CLOSED.includes(s.status));
    const kpi = {
      action: live.filter((s) => nextAction(s, d).mine).length,
      transit: live.filter((s) => ['Shipped', 'In transit', 'Out for delivery'].includes(s.status)).length,
      problems: live.filter((s) => ['Customs', 'Exception'].includes(s.status) || nextAction(s, d).tone === 'bad').length,
      evaluate: live.filter((s) => s.status === 'Delivered').length,
      unpaid: live.filter((s) => Number(s.sample_fee) > 0 && !s.fee_paid_at).reduce((a, s) => a + Number(s.sample_fee), 0),
    };
    const conn = ['dhl', 'fedex', 'ups'].map((c) => [c, CR.configured(c)]);
    res.html(page({
      title: 'Samples', nav: adminNav('samples'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="smp-head"><div><h1>Samples</h1><p>Every sample from request to evaluation. DHL, FedEx and UPS tracking updates arrive automatically.</p></div>
        <div class="smp-actions"><span class="conn">${conn.map(([c, ok]) => html`<span class="conn-c ${ok ? 'on' : ''}" title="${ok ? 'API connected' : 'API not connected: add keys in Railway'}">${carrierBadge(c)}${ok ? '✓' : '—'}</span>`)}</span><a class="btn ghost" href="/admin/samples/new?mode=shipped">+ Add shipped sample</a><a class="btn" href="/admin/samples/new">+ Request sample</a></div></div>
        <div class="kpis">
          <a class="kpi2 ${kpi.action ? 'alert' : ''}" href="?f=action"><b>${kpi.action}</b><span>Need your action</span></a>
          <a class="kpi2" href="?f=transit"><b>${kpi.transit}</b><span>In transit</span></a>
          <a class="kpi2 ${kpi.problems ? 'alert' : ''}" href="?f=customs"><b>${kpi.problems}</b><span>Late, customs or problems</span></a>
          <a class="kpi2" href="?f=evaluate"><b>${kpi.evaluate}</b><span>Waiting for evaluation</span></a>
          <a class="kpi2" href="?f=unpaid"><b>${fmt.money(kpi.unpaid, 'USD')}</b><span>Unpaid sample fees</span></a>
        </div>
        <form method="get" class="smp-bar"><div class="chips">${FILTERS.map(([k, l, fn]) => html`<a class="chip2 ${k === f[0] ? 'on' : ''}" href="?f=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}">${l} <em>${(k === 'closed' || k === 'all' ? samples : live).filter((s) => fn(s, d)).length}</em></a>`)}</div>
          <input type="hidden" name="f" value="${f[0]}"><input type="search" name="q" value="${req.query.q || ''}" placeholder="Search sample, supplier, tracking…"></form>
        ${shown.length ? html`<section class="card flush"><div class="table-wrap"><table class="stbl"><thead><tr><th>Sample</th><th>Status</th><th>Shipped · ETA</th><th>Tracking</th><th>Cost</th><th>Next action</th></tr></thead><tbody>
          ${shown.map((s) => { const na = nextAction(s, d); return html`<tr data-href="/admin/samples/${s.id}">
            <td><a class="sm" href="/admin/samples/${s.id}">${thumbs[s.id] ? html`<img class="ph" src="/admin/sample-files/${thumbs[s.id]}?inline=1" alt="" loading="lazy">` : html`<span class="ph">${s.stage ? s.stage.slice(0, 3).toUpperCase() : 'SMP'}</span>`}<span><b>${s.title}</b><small>${names[s.supplier_id] || ''} · ${s.ref}${s.qty ? ` · ${s.qty} pcs` : ''}</small></span></a></td>
            <td>${statusPill(s.status)}</td>
            <td>${s.shipped_at ? shortDate(s.shipped_at) : '—'}<div class="eta">${s.delivered_at ? `Delivered ${shortDate(s.delivered_at)}` : s.eta ? `ETA ${shortDate(s.eta)}` : s.due_ship_date ? `Ship by ${shortDate(s.due_ship_date)}` : ''}</div></td>
            <td>${s.tracking_no ? html`<div class="carrier">${carrierBadge(s.carrier)}<code>${s.tracking_no}</code></div><div class="eta">${s.tracking_error ? html`<span class="neg">${s.tracking_error}</span>` : [s.tracking_summary, s.tracking_location].filter(Boolean).join(' · ')}</div>` : html`<span class="muted">No tracking yet</span>`}</td>
            <td class="money">${S.total(s) ? html`<b>${fmt.money(S.total(s), s.currency)}</b>` : html`<b class="muted">—</b>`}${Number(s.sample_fee) > 0 ? html`<small class="${s.fee_paid_at ? 'paid' : 'unpaid'}">${s.fee_paid_at ? 'Fee paid' : 'Fee unpaid'}</small>` : ''}</td>
            <td class="nxt ${na.tone || ''}"><b>${na.text}</b><small>${na.sub || ''}</small></td></tr>`; })}
        </tbody></table></div></section>` : html`<section class="card"><p class="d-empty">${samples.length ? 'No samples match this filter.' : 'No samples yet. Request one here, or from a supplier thread in Development.'}</p></section>`}`,
    }));
  }));

  // ── Request a sample
  router.get('/admin/samples/new', G(async (req, res) => {
    const [allSup, projects] = await Promise.all([db.list('suppliers', { select: 'id,name,active,country,email,contact_name', order: 'name.asc' }), db.list('dev_projects', { order: 'created_at.desc' })]);
    // Only real suppliers: not inactive, not unfinished invitations ("Pending: email").
    const suppliers = pickableSuppliers(allSup, req.query.supplier);
    let pre = { supplier_id: req.query.supplier || '', project_id: req.query.project || '', invitation_id: req.query.invitation || '', title: '', stage: '', qty: '' };
    if (pre.invitation_id) { const inv = await db.get('dev_invitations', pre.invitation_id); if (inv) { pre.supplier_id = inv.supplier_id; pre.project_id = inv.project_id; } }
    if (req.query.from) { const o = await db.get('samples', req.query.from); if (o) pre = { ...pre, supplier_id: o.supplier_id, project_id: o.project_id || '', invitation_id: o.invitation_id || '', title: o.title, stage: o.stage || '', qty: o.qty || '', note: o.eval_notes ? `Revised sample. Changes needed:\n${o.eval_notes}` : '' }; }
    if (pre.project_id && !pre.title) { const p = projects.find((x) => x.id === pre.project_id); if (p) pre.title = p.name; }
    const shipped = req.query.mode === 'shipped';
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    res.html(page({
      title: 'New sample', nav: adminNav('samples'), flash: takeFlash(req, res), req,
      body: html`<p class="sub crumbs"><a href="/admin/samples">Samples</a> › New</p><h1>New sample</h1>
        <form method="post" action="/admin/samples" enctype="multipart/form-data" class="card fields smp-form" data-sample-mode="${shipped ? 'shipped' : 'request'}">
          <input type="hidden" name="invitation_id" value="${pre.invitation_id}">
          <div class="mode-seg" role="radiogroup" aria-label="Type">
            <label><input type="radio" name="mode" value="request" ${shipped ? '' : raw('checked')}><span><b>Request a sample</b><small>Ask the supplier to send one</small></span></label>
            <label><input type="radio" name="mode" value="shipped" ${shipped ? raw('checked') : ''}><span><b>Already shipped</b><small>Add a sample that is on its way</small></span></label>
          </div>
          <div class="f2">
            <label class="full"><span class="lbl">What sample</span><input name="title" required maxlength="160" value="${pre.title}" placeholder="e.g. Salon Teether Set – 3PC"></label>
            ${supplierPicker(suppliers, pre.supplier_id)}
            <label><span class="lbl">Development project <span class="muted">(optional)</span></span><select name="project_id"><option value="">—</option>${projects.map((p) => html`<option value="${p.id}" ${p.id === pre.project_id ? raw('selected') : ''}>${p.ref} · ${p.name}</option>`)}</select></label>
            <label><span class="lbl">Stage</span><select name="stage"><option value="">—</option>${S.STAGES.map((x) => html`<option ${x === pre.stage ? raw('selected') : ''}>${x}</option>`)}</select></label>
            <label><span class="lbl">Quantity (pcs)</span><input name="qty" type="number" min="1" step="1" value="${pre.qty}"></label>
            <label data-for="request"><span class="lbl">Ship by</span><input name="due_ship_date" type="date" value="${inDays(7)}"></label>
            <label data-for="shipped"><span class="lbl">Tracking number</span><input name="tracking_no" autocomplete="off" spellcheck="false" placeholder="e.g. 3471829104" data-detect-carrier></label>
            <label data-for="shipped"><span class="lbl">Carrier</span><select name="carrier"><option value="">Detect automatically</option>${['dhl', 'fedex', 'ups', 'other'].map((c) => html`<option value="${c}">${CR.CARRIERS[c].name}</option>`)}</select></label>
            <label data-for="shipped"><span class="lbl">Ship date</span><input name="shipped_at" type="date" value="${inDays(0)}"></label>
            <label data-for="shipped"><span class="lbl">Sample fee</span><input name="sample_fee" inputmode="decimal" placeholder="0 = free"></label>
            <label data-for="shipped"><span class="lbl">Freight cost</span><input name="freight_cost" inputmode="decimal"></label>
            <label data-for="shipped" class="chk"><input type="checkbox" name="fee_paid" value="1"> Sample fee already paid</label>
            <label><span class="lbl">Freight</span><select name="freight_by">${Object.entries(S.FREIGHT_BY).map(([k, v]) => html`<option value="${k}" ${k === 'supplier' ? raw('selected') : ''}>${v[0]}</option>`)}</select></label>
            <label class="full" data-for="request"><span class="lbl">Instructions for the supplier <span class="muted">(shared)</span></span><textarea name="request_note" rows="3" placeholder="Colour, material, packaging, what to include, ship-to address…">${pre.note || ''}</textarea></label>
            <div class="full"><span class="lbl">Photos of the item <span class="muted">(optional)</span></span>${drop('photos', 'Drop photos of the sample, or paste a screenshot', '拖入样品照片', { accept: '.jpg,.jpeg,.png,.webp', hint: 'JPG, PNG, WEBP' })}</div>
            <label class="full"><span class="lbl">Internal notes <span class="muted">(only you)</span></span><textarea name="internal_notes" rows="2"></textarea></label>
          </div>
          <label class="chk" data-for="request"><input type="checkbox" name="send_email" value="1" checked> Email the request to the supplier now (English + 中文)</label>
          <p class="muted small" data-for="shipped">Tracking starts right away. The supplier can see the sample and add documents in the portal; no request email is sent.</p>
          <div class="form-actions"><button class="btn" data-for="request">Request sample</button><button class="btn" data-for="shipped">Add shipped sample</button><a class="link" href="/admin/samples">Cancel</a></div>
        </form>`,
    }));
  }));

  router.post('/admin/samples', G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const supplier = await db.get('suppliers', f.supplier_id);
    if (!supplier || !str(f.title)) { flash(res, 'error', 'Choose a supplier and describe the sample'); return res.redirect('/admin/samples/new'); }
    const inv = f.invitation_id ? await db.get('dev_invitations', f.invitation_id) : null;
    const isShipped = f.mode === 'shipped';
    const savePhotos = async (sampleId) => {
      const r = await S.storeFiles(db, sampleId, [].concat(files?.photos || []).filter((x) => THUMB.test(x.name || '')));
      for (const a of r.saved) await db.insert('sample_files', { sample_id: sampleId, kind: 'photo', name: a.name, path: a.path, mime: a.mime, bytes: a.bytes, uploaded_by: 'admin', created_at: now() });
      return r;
    };
    if (isShipped && !CR.clean(f.tracking_no)) { flash(res, 'error', 'Enter the tracking number of the shipped sample'); return res.redirect('/admin/samples/new?mode=shipped'); }
    const s = await db.insert('samples', {
      ref: await S.nextRef(db), title: str(f.title, 160), supplier_id: supplier.id, project_id: f.project_id || inv?.project_id || null, invitation_id: inv && inv.supplier_id === supplier.id ? inv.id : null,
      stage: str(f.stage, 40), qty: int(f.qty), status: 'Requested', request_note: str(f.request_note), internal_notes: str(f.internal_notes), due_ship_date: day(f.due_ship_date),
      freight_by: S.FREIGHT_BY[f.freight_by] ? f.freight_by : null, currency: 'USD', eval_checks: S.DEFAULT_CHECKS.map((label) => ({ label, result: null })), created_at: now(), updated_at: now(),
    });
    if (isShipped) {
      await db.update('samples', { id: s.id }, { sample_fee: num(f.sample_fee), freight_cost: num(f.freight_cost), fee_paid_at: f.fee_paid === '1' && num(f.sample_fee) ? now() : null, due_ship_date: null, confirmed_at: now() });
      await log(s.id, 'Shipped sample added', 'admin');
      await savePhotos(s.id);
      const r = await setTracking({ ...s, status: 'Confirmed' }, f, 'admin');
      if (inv && inv.status !== 'Selected') await db.update('dev_invitations', { id: inv.id }, { status: 'Sample' }).catch(() => {});
      const now2 = await db.get('samples', s.id);
      flash(res, now2.tracking_error ? 'warn' : 'ok', `${s.ref} added · ${CR.CARRIERS[r.carrier]?.name || 'Carrier'} ${r.no}${r.auto ? (now2.tracking_error ? ` · ${now2.tracking_error}` : ' · tracking started') : ' · automatic tracking not available for this carrier'}`);
      return res.redirect(`/admin/samples/${s.id}`);
    }
    await log(s.id, 'Sample requested', 'admin');
    await savePhotos(s.id);
    if (inv && inv.status !== 'Selected') await db.update('dev_invitations', { id: inv.id }, { status: 'Sample' }).catch(() => {});
    if (f.send_email === '1') await S.notifySupplierSample(db, config, supplier, s, {
      subject: `[Lulyboo ${s.ref}] Sample request · 样品请求: ${s.title}`, title: ['Sample request', '样品请求'], lead: ['Please send us a sample of:', '请寄送以下样品：'],
      noteLabel: ['Instructions', '要求'], note: s.request_note,
      points: [[`${s.qty ? `${s.qty} pcs` : 'Quantity as agreed'}${s.stage ? ` · ${s.stage}` : ''}${s.due_ship_date ? ` · ship by ${s.due_ship_date}` : ''}`, `${s.qty ? `${s.qty} 件` : '数量按约定'}${s.stage ? ` · ${s.stage}` : ''}${s.due_ship_date ? ` · 请于 ${s.due_ship_date} 前寄出` : ''}`],
        ['Confirm the sample fee and ship date in the portal.', '请在平台中确认样品费和寄出日期。'], ['When shipped, upload the waybill photo; tracking starts automatically.', '寄出后上传运单照片，系统将自动跟踪物流。']],
      button: ['Open sample', '查看样品'],
    });
    flash(res, 'ok', `${s.ref} requested${f.send_email === '1' ? ' and emailed to the supplier' : ''}`);
    res.redirect(`/admin/samples/${s.id}`);
  }));

  // ── Detail
  router.get('/admin/samples/:id', G(async (req, res) => {
    const s = await load(req.params.id);
    const allSup = await db.list('suppliers', { select: 'id,name,active,country,email,contact_name', order: 'name.asc' });
    const [supplier, events, files, project] = await Promise.all([db.get('suppliers', s.supplier_id), db.list('sample_events', { filters: { sample_id: s.id }, order: 'at.desc' }), db.list('sample_files', { filters: { sample_id: s.id }, order: 'created_at.asc' }), s.project_id ? db.get('dev_projects', s.project_id) : null]);
    const carrierEv = events.filter((e) => ['dhl', 'fedex', 'ups'].includes(e.source));
    const logEv = events.filter((e) => !['dhl', 'fedex', 'ups'].includes(e.source));
    const auto = s.tracking_no && CR.configured(s.carrier);
    const na = nextAction(s, today());
    const checks = (s.eval_checks?.length ? s.eval_checks : S.DEFAULT_CHECKS.map((label) => ({ label, result: null })));
    const canEval = ['Delivered', 'Approved', 'Revise', 'Rejected', 'Exception', 'Customs', 'Out for delivery', 'In transit', 'Shipped'].includes(s.status);
    const dt = (x) => (x ? String(x).slice(0, 10) : '');
    res.html(page({
      title: `${s.ref} ${s.title}`, nav: adminNav('samples'), flash: takeFlash(req, res), wide: true, req,
      body: html`<p class="sub crumbs"><a href="/admin/samples">Samples</a> › ${s.ref}</p>
      <div class="smp-head">${files.find((f) => f.kind === 'photo' && THUMB.test(f.name)) ? html`<button type="button" class="smp-thumb" data-preview="/admin/sample-files/${files.find((f) => f.kind === 'photo' && THUMB.test(f.name)).id}?inline=1" data-type="image" data-dl="/admin/sample-files/${files.find((f) => f.kind === 'photo' && THUMB.test(f.name)).id}" aria-label="View photo"><img src="/admin/sample-files/${files.find((f) => f.kind === 'photo' && THUMB.test(f.name)).id}?inline=1" alt=""></button>` : ''}<div class="smp-title"><h1>${s.title}${s.stage ? html` <span class="tag">${s.stage}</span>` : ''}</h1>
        <p><a href="/admin/suppliers/${s.supplier_id}">${supplier?.name || 'Supplier'}</a> <a class="ic-btn sm-edit" href="#edit" title="Change sample or supplier" aria-label="Edit">${icon('pencil', 14)}</a>${project ? html` · <a href="/admin/projects/${project.id}${s.invitation_id ? `/suppliers/${s.invitation_id}` : ''}">${project.ref}</a>` : ''}${s.qty ? ` · ${s.qty} pcs` : ''} · requested ${shortDate(s.created_at)}</p></div>
        <div class="smp-actions">${statusPill(s.status)}
          ${s.status === 'Revise' ? html`<a class="btn" href="/admin/samples/new?from=${s.id}">Request revised sample</a>` : ''}
          ${!['Delivered', ...S.CLOSED, ...S.EVALUATED].includes(s.status) ? html`<form method="post" action="/admin/samples/${s.id}/status" class="inline"><input type="hidden" name="to" value="Delivered"><button class="btn ghost">Mark delivered</button></form>` : ''}
          <details class="more-menu"><summary class="btn ghost" aria-label="More">⋯</summary><div>
            ${s.status !== 'Cancelled' ? html`<form method="post" action="/admin/samples/${s.id}/status"><input type="hidden" name="to" value="Cancelled"><button class="link">Cancel sample</button></form>` : html`<form method="post" action="/admin/samples/${s.id}/status"><input type="hidden" name="to" value="Requested"><button class="link">Reopen</button></form>`}
            <form method="post" action="/admin/samples/${s.id}/delete" data-confirm="Delete ${s.ref} and its documents?"><button class="link danger">Delete</button></form></div></details></div></div>
      <section class="card">${s.status === 'Cancelled' ? html`<p class="muted">Cancelled.</p>` : tracker(s)}
        <div class="na ${na.tone || ''}"><b>Next:</b> ${na.text}${na.sub ? html` <span class="muted">· ${na.sub}</span>` : ''}</div></section>
      <div class="dt-grid"><div>
        <section class="card"><div class="head-row"><h2>Tracking${s.tracking_no ? html` <span class="muted">· ${CR.CARRIERS[s.carrier]?.name || s.carrier_other || 'Carrier'} ${s.tracking_no}</span>` : ''}</h2>
          <div class="row-actions">${s.tracking_no && auto ? html`<form method="post" action="/admin/samples/${s.id}/refresh" class="inline"><button class="btn small ghost" data-busy>↻ Check now</button></form>` : ''}${CR.trackingUrl(s.carrier, s.tracking_no) ? html`<a class="btn small ghost" target="_blank" rel="noopener" href="${CR.trackingUrl(s.carrier, s.tracking_no)}">Open on ${CR.CARRIERS[s.carrier].short}</a>` : ''}</div></div>
          ${s.tracking_no ? (auto ? html`<div class="auto">⚡ Auto-tracking on. You get email${raw(' + Telegram')} for first movement, customs, problems, out for delivery and delivered.${s.last_checked_at ? html` Last check ${when(s.last_checked_at)}.` : ''}</div>`
            : html`<div class="auto w">${['dhl', 'fedex', 'ups'].includes(s.carrier) ? `${CR.CARRIERS[s.carrier].name} API is not connected yet, so this shipment is not tracked automatically. Add the API keys in Railway.` : 'Automatic tracking works for DHL, FedEx and UPS. Track this one on the carrier site.'}</div>`) : ''}
          ${s.tracking_error ? html`<div class="auto w">! ${s.tracking_error}</div>` : ''}
          ${carrierEv.length ? timeline(carrierEv) : s.tracking_no ? html`<p class="muted small">No carrier events yet.</p>` : ''}
          <details class="sub-form" ${s.tracking_no ? '' : raw('open')}><summary>${s.tracking_no ? 'Change tracking number' : 'Add tracking number'}</summary>
            <form method="post" action="/admin/samples/${s.id}/tracking" class="inline-fields">
              <label><span class="lbl">Tracking number</span><input name="tracking_no" value="${s.tracking_no || ''}" required autocomplete="off" spellcheck="false" data-detect-carrier></label>
              <label><span class="lbl">Carrier</span><select name="carrier"><option value="">Detect automatically</option>${['dhl', 'fedex', 'ups', 'other'].map((c) => html`<option value="${c}" ${c === s.carrier ? raw('selected') : ''}>${CR.CARRIERS[c].name}</option>`)}</select></label>
              <button class="btn small">Save</button></form></details>
        </section>
        <section class="card"><h2>Evaluation${!canEval ? html` <span class="muted">· opens when the sample ships</span>` : s.evaluated_at ? html` <span class="muted">· ${shortDate(s.evaluated_at)}</span>` : ''}</h2>
          <form method="post" action="/admin/samples/${s.id}/evaluate" class="evalf">
            <ul class="evalc">${checks.map((c, i) => html`<li><span>${c.label}<input type="hidden" name="label_${i}" value="${c.label}"></span>
              <span class="seg"><label class="p"><input type="radio" name="r_${i}" value="pass" ${c.result === 'pass' ? raw('checked') : ''}><span>Pass</span></label><label class="f"><input type="radio" name="r_${i}" value="fail" ${c.result === 'fail' ? raw('checked') : ''}><span>Fail</span></label></span></li>`)}
              <li class="add"><input name="label_${checks.length}" placeholder="+ Add a check (e.g. Drop test 1 m)"><span class="seg"><label class="p"><input type="radio" name="r_${checks.length}" value="pass"><span>Pass</span></label><label class="f"><input type="radio" name="r_${checks.length}" value="fail"><span>Fail</span></label></span></li></ul>
            <div class="f2"><label class="full"><span class="lbl">Notes for the supplier <span class="muted">(sent with the result)</span></span><textarea name="eval_notes" rows="3">${s.eval_notes || ''}</textarea></label>
              <label><span class="lbl">Score (1–10)</span><input name="eval_score" type="number" min="1" max="10" value="${s.eval_score || ''}"></label>
              <label class="chk"><input type="checkbox" name="notify" value="1" checked> Send the result to the supplier</label></div>
            <div class="form-actions eval-actions"><button class="btn ok" name="result" value="Approved" ${canEval ? '' : raw('disabled')}>✓ Approve</button><button class="btn ghost" name="result" value="Revise" ${canEval ? '' : raw('disabled')}>↺ Needs revision</button><button class="btn ghost danger" name="result" value="Rejected" ${canEval ? '' : raw('disabled')}>✕ Reject</button><button class="link" name="result" value="" ${canEval ? '' : raw('disabled')}>Save without result</button></div>
          </form></section>
      </div><div>
        <section class="card" id="edit"><h2>Sample & shipment</h2>
          <form method="post" action="/admin/samples/${s.id}/update" class="fields compact-f">
            <div class="f2">
              <label class="full"><span class="lbl">What sample</span><input name="title" required maxlength="160" value="${s.title}"></label>
              <div class="full">${supplierPicker(pickableSuppliers(allSup, s.supplier_id), s.supplier_id)}</div>
              <label><span class="lbl">Ship by</span><input type="date" name="due_ship_date" value="${dt(s.due_ship_date)}"></label>
              <label><span class="lbl">Shipped</span><input type="date" name="shipped_at" value="${dt(s.shipped_at)}"></label>
              <label><span class="lbl">Quantity</span><input type="number" name="qty" min="0" value="${s.qty ?? ''}"></label>
              <label><span class="lbl">Stage</span><select name="stage"><option value="">—</option>${S.STAGES.map((x) => html`<option ${x === s.stage ? raw('selected') : ''}>${x}</option>`)}</select></label>
              <label><span class="lbl">Boxes</span><input type="number" name="boxes" min="0" value="${s.boxes ?? ''}"></label>
              <label><span class="lbl">Weight kg</span><input name="weight_kg" inputmode="decimal" value="${s.weight_kg ?? ''}"></label>
              <label><span class="lbl">Declared value</span><input name="declared_value" inputmode="decimal" value="${s.declared_value ?? ''}"></label>
              <label><span class="lbl">Freight</span><select name="freight_by"><option value="">—</option>${Object.entries(S.FREIGHT_BY).map(([k, v]) => html`<option value="${k}" ${k === s.freight_by ? raw('selected') : ''}>${v[0]}</option>`)}</select></label>
            </div>
            <h3>Costs</h3>
            <div class="f2">
              <label><span class="lbl">Sample fee</span><input name="sample_fee" inputmode="decimal" value="${s.sample_fee ?? ''}"></label>
              <label><span class="lbl">Freight cost</span><input name="freight_cost" inputmode="decimal" value="${s.freight_cost ?? ''}"></label>
              <label><span class="lbl">US duties & taxes</span><input name="duties" inputmode="decimal" value="${s.duties ?? ''}"></label>
              <label><span class="lbl">Currency</span><select name="currency">${['USD', 'CNY', 'EUR'].map((c) => html`<option ${c === s.currency ? raw('selected') : ''}>${c}</option>`)}</select></label>
              <label class="chk full"><input type="checkbox" name="fee_refundable" value="1" ${s.fee_refundable ? raw('checked') : ''}> Sample fee is refunded on the first order</label>
              <label class="full"><span class="lbl">Instructions for the supplier <span class="muted">(shared)</span></span><textarea name="request_note" rows="2">${s.request_note || ''}</textarea></label>
              <label class="full"><span class="lbl">Internal notes</span><textarea name="internal_notes" rows="2">${s.internal_notes || ''}</textarea></label>
            </div>
            <div class="total-row"><span>Total</span><b>${fmt.money(S.total(s), s.currency)}</b></div>
            <div class="form-actions"><button class="btn small">Save</button></div>
          </form>
          ${Number(s.sample_fee) > 0 ? html`<form method="post" action="/admin/samples/${s.id}/fee-paid" class="fee-row ${s.fee_paid_at ? 'paid' : ''}">${s.fee_paid_at ? html`<span>✓ Sample fee paid ${shortDate(s.fee_paid_at)}</span><button class="link">Undo</button>` : html`<span>Sample fee ${fmt.money(s.sample_fee, s.currency)} not paid</span><button class="btn small">Mark paid</button>`}</form>` : ''}
          ${s.delivered_at ? html`<p class="sub">Delivered ${when(s.delivered_at)}${s.signed_by ? ` · signed ${s.signed_by}` : ''}</p>` : ''}
        </section>
        <section class="card"><h2>Documents</h2>
          ${docTiles(files, (f) => `/admin/sample-files/${f.id}`, { del: (f) => `/admin/samples/${s.id}/files/${f.id}/delete` })}
          <form method="post" enctype="multipart/form-data" action="/admin/samples/${s.id}/files" class="doc-add">
            <select name="kind">${Object.entries(S.FILE_KINDS).map(([k, v]) => html`<option value="${k}" ${k === 'payment' ? raw('selected') : ''}>${v[0]}</option>`)}</select>
            ${drop('files', 'Drop proforma, invoice, payment proof or photos', '拖入文件')}
            <button class="btn small">Upload</button></form></section>
        <section class="card"><h2>Activity</h2>${logEv.length ? html`<ul class="alog">${logEv.slice(0, 30).map((e) => html`<li class="${e.source}"><span>${when(e.at)}</span>${e.description}<em>${e.source === 'supplier' ? 'Supplier' : e.source === 'admin' ? 'You' : 'Automatic'}</em></li>`)}</ul>` : html`<p class="muted small">Nothing yet.</p>`}</section>
      </div></div>`,
    }));
  }));

  router.post('/admin/samples/:id/update', G(async (req, res) => {
    const s = await load(req.params.id); const { fields: f } = await parseForm(req);
    let newSupplier = null;
    if (f.supplier_id && f.supplier_id !== s.supplier_id) { newSupplier = await db.get('suppliers', f.supplier_id); if (!newSupplier) { flash(res, 'error', 'Supplier not found'); return res.redirect(`/admin/samples/${s.id}`); } }
    const patch = {
      ...(str(f.title, 160) ? { title: str(f.title, 160) } : {}),
      ...(newSupplier ? { supplier_id: newSupplier.id, invitation_id: null, supplier_seen_at: null } : {}),
      due_ship_date: day(f.due_ship_date), qty: int(f.qty), stage: str(f.stage, 40), boxes: int(f.boxes), weight_kg: num(f.weight_kg), declared_value: num(f.declared_value),
      freight_by: S.FREIGHT_BY[f.freight_by] ? f.freight_by : null, sample_fee: num(f.sample_fee), freight_cost: num(f.freight_cost), duties: num(f.duties),
      currency: ['USD', 'CNY', 'EUR'].includes(f.currency) ? f.currency : 'USD', fee_refundable: f.fee_refundable === '1', request_note: str(f.request_note), internal_notes: str(f.internal_notes), updated_at: now(),
    };
    if (day(f.shipped_at) && day(f.shipped_at) !== String(s.shipped_at || '').slice(0, 10)) patch.shipped_at = `${f.shipped_at}T12:00:00Z`;
    if (patch.due_ship_date !== s.due_ship_date) { patch.late_reminded_on = null; patch.late_reminders = 0; }
    await db.update('samples', { id: s.id }, patch);
    if (newSupplier) await log(s.id, `Supplier changed to ${newSupplier.name}`, 'admin');
    flash(res, 'ok', newSupplier ? `Saved · supplier is now ${newSupplier.name}` : 'Saved'); res.redirect(`/admin/samples/${s.id}`);
  }));

  // Shared: set a tracking number, detect the carrier, check immediately.
  async function setTracking(s, f, source) {
    const no = CR.clean(f.tracking_no).slice(0, 40);
    if (!no) return { error: m('Enter a tracking number', '请填写运单号') };
    const carrier = ['dhl', 'fedex', 'ups', 'other'].includes(f.carrier) ? f.carrier : CR.detect(no) || 'other';
    const patch = { tracking_no: no, carrier, carrier_other: carrier === 'other' ? str(f.carrier_other, 60) : null, tracking_status: null, tracking_summary: null, tracking_location: null, tracking_error: null, next_check_at: now(), updated_at: now() };
    if (['Requested', 'Confirmed'].includes(s.status)) { patch.status = 'Shipped'; patch.shipped_at = s.shipped_at || (day(f.shipped_at) ? `${f.shipped_at}T12:00:00Z` : now()); }
    if (no !== s.tracking_no) await db.remove('sample_events', { sample_id: s.id, source: s.carrier || 'none' }).catch(() => {});
    await db.update('samples', { id: s.id }, patch);
    await log(s.id, `Tracking ${CR.CARRIERS[carrier]?.name || carrier} ${no} added`, source);
    const fresh = { ...s, ...patch };
    if (CR.configured(carrier)) { try { await S.refreshSample({ db, config, sample: fresh, notify: source !== 'admin' }); } catch (e) { console.error('First tracking check failed:', e.message); } }
    return { carrier, no, auto: CR.configured(carrier) };
  }

  router.post('/admin/samples/:id/tracking', G(async (req, res) => {
    const s = await load(req.params.id); const { fields: f } = await parseForm(req);
    const r = await setTracking(s, f, 'admin');
    if (r.error) flash(res, 'error', r.error); else flash(res, 'ok', `${CR.CARRIERS[r.carrier]?.name || 'Carrier'} ${r.no} saved${r.auto ? ' · tracking started' : ''}`);
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/refresh', G(async (req, res) => {
    const s = await load(req.params.id);
    const p = await S.refreshSample({ db, config, sample: s });
    flash(res, p?.tracking_error ? 'warn' : 'ok', p?.tracking_error || (p ? 'Tracking updated' : 'Automatic tracking is not available for this carrier'));
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/fee-paid', G(async (req, res) => {
    const s = await load(req.params.id);
    await db.update('samples', { id: s.id }, { fee_paid_at: s.fee_paid_at ? null : now(), updated_at: now() });
    await log(s.id, s.fee_paid_at ? 'Fee payment undone' : `Sample fee ${fmt.money(s.sample_fee, s.currency)} marked paid`, 'admin');
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/status', G(async (req, res) => {
    const s = await load(req.params.id); const { fields: f } = await parseForm(req);
    const to = ['Delivered', 'Cancelled', 'Requested'].includes(f.to) ? f.to : null;
    if (to) {
      const patch = { status: to, updated_at: now() };
      if (to === 'Delivered') { patch.delivered_at = s.delivered_at || now(); patch.next_check_at = null; }
      if (to === 'Cancelled') patch.next_check_at = null;
      await db.update('samples', { id: s.id }, patch);
      await log(s.id, to === 'Requested' ? 'Reopened' : `Marked ${to.toLowerCase()} by hand`, 'admin');
      flash(res, 'ok', `${s.ref}: ${to}`);
    }
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/evaluate', G(async (req, res) => {
    const s = await load(req.params.id); const { fields: f } = await parseForm(req);
    const checks = [];
    for (let i = 0; i < 40; i++) { const label = str(f[`label_${i}`], 120); if (!label) continue; checks.push({ label, result: ['pass', 'fail'].includes(f[`r_${i}`]) ? f[`r_${i}`] : null }); }
    const result = ['Approved', 'Revise', 'Rejected'].includes(f.result) ? f.result : null;
    const patch = { eval_checks: checks, eval_notes: str(f.eval_notes), eval_score: Math.min(10, Math.max(1, int(f.eval_score) || 0)) || null, updated_at: now() };
    if (result) { patch.status = result; patch.evaluated_at = now(); patch.next_check_at = null; if (!s.delivered_at) patch.delivered_at = now(); }
    await db.update('samples', { id: s.id }, patch);
    if (result) {
      await log(s.id, `Evaluation: ${result}${patch.eval_score ? ` (${patch.eval_score}/10)` : ''}`, 'admin');
      const fails = checks.filter((c) => c.result === 'fail').map((c) => c.label);
      if (s.project_id && s.invitation_id) {
        const body = `Sample ${s.ref} (${s.stage || 'sample'}) evaluated: ${result}.${fails.length ? `\nNot OK: ${fails.join('; ')}.` : ''}${patch.eval_notes ? `\n${patch.eval_notes}` : ''}`;
        await db.insert('dev_messages', { invitation_id: s.invitation_id, direction: 'admin', author: 'Lulyboo', body, attachments: [], created_at: now() }).catch(() => {});
      }
      if (f.notify === '1') {
        const supplier = await db.get('suppliers', s.supplier_id);
        const zh = { Approved: '样品已通过', Revise: '样品需要修改', Rejected: '样品未通过' }[result];
        await S.notifySupplierSample(db, config, supplier, { ...s, ...patch }, {
          subject: `[Lulyboo ${s.ref}] ${result === 'Approved' ? 'Sample approved' : result === 'Revise' ? 'Sample needs changes' : 'Sample not approved'} · ${zh}`,
          title: [result === 'Approved' ? 'Sample approved' : result === 'Revise' ? 'Sample needs changes' : 'Sample not approved', zh], lead: ['We evaluated your sample:', '我们已评估您的样品：'],
          noteLabel: ['Feedback', '反馈'], note: [fails.length ? `Not OK: ${fails.join('; ')}` : '', patch.eval_notes || ''].filter(Boolean).join('\n\n') || null,
          points: result === 'Revise' ? [['Please prepare a revised sample. We will send a new request.', '请准备修改后的样品，我们将发送新的样品请求。']] : [], button: ['Open sample', '查看样品'],
        });
      }
    }
    flash(res, 'ok', result ? `Evaluation saved: ${result}` : 'Evaluation saved');
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/files', G(async (req, res) => {
    const s = await load(req.params.id); const { fields: f, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const r = await S.storeFiles(db, s.id, [].concat(files?.files || []));
    for (const a of r.saved) await db.insert('sample_files', { sample_id: s.id, kind: S.FILE_KINDS[f.kind] ? f.kind : 'other', name: a.name, path: a.path, mime: a.mime, bytes: a.bytes, uploaded_by: 'admin', created_at: now() });
    if (r.saved.length && f.kind === 'payment' && !s.fee_paid_at && Number(s.sample_fee) > 0) await db.update('samples', { id: s.id }, { fee_paid_at: now() });
    flash(res, r.errors.length ? 'warn' : 'ok', r.saved.length ? `${r.saved.length} file(s) added${r.errors.length ? ` · ${r.errors.join(' · ')}` : ''}` : r.errors.join(' · ') || 'Choose a file');
    res.redirect(`/admin/samples/${s.id}`);
  }));
  router.post('/admin/samples/:id/files/:fid/delete', G(async (req, res) => {
    const f = await db.get('sample_files', req.params.fid);
    if (f && f.sample_id === req.params.id) { await db.docs.remove([f.path]).catch(() => {}); await db.remove('sample_files', { id: f.id }); }
    res.redirect(`/admin/samples/${req.params.id}`);
  }));
  router.get('/admin/sample-files/:fid', G(async (req, res) => {
    const f = await db.get('sample_files', req.params.fid); if (!f) throw new HttpError(404, 'File not found');
    serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
  }));
  router.post('/admin/samples/:id/delete', G(async (req, res) => {
    const s = await load(req.params.id);
    const files = await db.list('sample_files', { filters: { sample_id: s.id } });
    if (files.length) await db.docs.remove(files.map((f) => f.path)).catch(() => {});
    await db.remove('sample_files', { sample_id: s.id }); await db.remove('sample_events', { sample_id: s.id }); await db.remove('samples', { id: s.id });
    flash(res, 'ok', `${s.ref} deleted`); res.redirect('/admin/samples');
  }));
  router.post('/admin/samples-carriers/test', G(async (req, res) => {
    const out = {}; for (const c of ['dhl', 'fedex', 'ups']) out[c] = await CR.testConnection(c);
    flash(res, Object.values(out).every((x) => x.ok) ? 'ok' : 'warn', ['dhl', 'fedex', 'ups'].map((c) => `${CR.CARRIERS[c].short}: ${out[c].message}`).join(' · '));
    res.redirect('/admin/samples');
  }));

  // ═════════════════════════ SUPPLIER PORTAL ═════════════════════════
  async function own(req) { const s = await db.get('samples', req.params.id); if (!s || s.supplier_id !== req.supplier.id) throw new HttpError(404, m('Sample not found', '未找到样品')); return s; }
  const supAction = (s) => ({ Requested: [t('Confirm', '确认'), 'bad'], Confirmed: [t('Ship & add tracking', '寄出并填写运单号'), 'bad'], Revise: [t('Revise', '修改'), 'warn'] }[s.status] || null);

  router.get('/portal/samples', A(async (req, res) => {
    const list = (await db.list('samples', { filters: { supplier_id: req.supplier.id }, order: 'created_at.desc' })).filter((s) => s.status !== 'Cancelled' || daysSince(s.updated_at) < 30);
    res.html(page({ title: 'Samples', nav: supNav(), flash: takeFlash(req, res), req,
      body: html`<h1>${t('Samples', '样品')}</h1><p class="muted">${t('Samples Lulyboo asked you to send. Confirm the fee and ship date, then add the tracking number; we follow the shipment automatically.', 'Lulyboo 请您寄送的样品。请确认样品费和寄出日期，寄出后填写运单号，系统会自动跟踪物流。')}</p>
        ${list.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>${t('Sample', '样品')}</th><th>${t('Requested', '请求日期')}</th><th>${t('Ship by', '寄出期限')}</th><th>${t('Status', '状态')}</th><th>${t('Tracking', '运单号')}</th><th>${t('Action needed', '待办')}</th></tr></thead><tbody>
          ${list.map((s) => { const a = supAction(s); const fresh = s.status === 'Requested' && !s.supplier_seen_at; return html`<tr class="${fresh ? 'is-new' : ''}"><td><a class="sp-name" href="/portal/samples/${s.id}">${s.title}</a>${fresh ? html` <span class="new-tag">${t('New', '新')}</span>` : ''}<div class="sub">${s.ref}${s.stage ? ` · ${s.stage}` : ''}${s.qty ? ` · ${s.qty} pcs` : ''}</div></td>
            <td class="nowrap">${fmt.date(s.created_at)}</td><td class="nowrap">${s.due_ship_date ? fmt.date(s.due_ship_date) : '—'}</td><td>${statusPill(s.status, true)}</td>
            <td>${s.tracking_no ? html`<div class="carrier">${carrierBadge(s.carrier)}<code>${s.tracking_no}</code></div>` : '—'}</td>
            <td>${a ? html`<a class="act ${a[1]}" href="/portal/samples/${s.id}">${a[0]}</a>` : html`<span class="muted">—</span>`}</td></tr>`; })}</tbody></table></div>`
          : html`<div class="card"><p class="d-empty">${t('No sample requests yet.', '暂无样品请求。')}</p></div>`}`,
    }));
  }));

  router.get('/portal/samples/:id', A(async (req, res) => {
    const s = await own(req);
    if (!s.supplier_seen_at) { await db.update('samples', { id: s.id }, { supplier_seen_at: now() }); if (req.navBadges?.['/portal/samples']) req.navBadges['/portal/samples']--; }
    const [events, files] = await Promise.all([db.list('sample_events', { filters: { sample_id: s.id }, order: 'at.desc' }), db.list('sample_files', { filters: { sample_id: s.id }, order: 'created_at.asc' })]);
    const href = (f) => `/portal/sample-files/${f.id}`;
    const dt = (x) => (x ? String(x).slice(0, 10) : '');
    const carrierEv = events.filter((e) => ['dhl', 'fedex', 'ups'].includes(e.source));
    const steps = [['Confirm', '确认', ['Requested']], ['Ship', '寄送', ['Confirmed']], ['Delivered', '已签收', ['Shipped', 'In transit', 'Customs', 'Out for delivery', 'Exception', 'Delivered']], ['Result', '评估结果', ['Approved', 'Revise', 'Rejected']]];
    const curStep = steps.findIndex((x) => x[2].includes(s.status));
    res.html(page({ title: `${s.ref} ${s.title}`, nav: supNav(), flash: takeFlash(req, res), req,
      body: html`<div class="sup-wrap"><p class="sub crumbs"><a href="/portal/samples">${t('Samples', '样品')}</a> › ${s.ref}</p>
      <h1>${s.title}</h1><p class="muted head-sub">${[s.stage, s.qty ? `${s.qty} pcs` : null].filter(Boolean).join(' · ')}${s.due_ship_date ? html` · ${t('ship by', '请于')} <b>${fmt.date(s.due_ship_date)}</b>${t('', ' 前寄出')}` : ''} · ${statusPill(s.status, true)}</p>
      ${s.status !== 'Cancelled' ? html`<div class="steps2">${steps.map((x, i) => html`<span class="${i < curStep ? 'done' : i === curStep ? 'cur' : ''}">${i < curStep ? '✓ ' : ''}${t(x[0], x[1])}</span>`)}</div>` : html`<div class="flash warn">${t('This sample request was cancelled.', '此样品请求已取消。')}</div>`}
      ${s.request_note ? html`<section class="card"><h2>${t('Instructions', '要求')}</h2><p class="pre">${s.request_note}</p></section>` : ''}

      ${s.status === 'Requested' ? html`<section class="card"><h2>${t('1. Confirm the sample', '1. 确认样品')}</h2>
        <form method="post" enctype="multipart/form-data" action="/portal/samples/${s.id}/confirm" class="fields">
          <div class="f2">
            <label><span class="lbl">${t('Sample fee', '样品费')}</span><input name="sample_fee" inputmode="decimal" placeholder="0 = free" value="${s.sample_fee ?? ''}"></label>
            <label><span class="lbl">${t('Currency', '币种')}</span><select name="currency">${['USD', 'CNY'].map((c) => html`<option ${c === s.currency ? raw('selected') : ''}>${c}</option>`)}</select></label>
            <label><span class="lbl">${t('Freight', '运费')}</span><select name="freight_by">${Object.entries(S.FREIGHT_BY).map(([k, v]) => html`<option value="${k}" ${k === (s.freight_by || 'supplier') ? raw('selected') : ''}>${v[0]} · ${v[1]}</option>`)}</select></label>
            <label><span class="lbl">${t('Freight cost (if we pay you)', '运费金额（如需我方支付）')}</span><input name="freight_cost" inputmode="decimal" value="${s.freight_cost ?? ''}"></label>
            <label><span class="lbl">${t('We will ship on', '预计寄出日期')}</span><input type="date" name="due_ship_date" value="${dt(s.due_ship_date)}" required></label>
            <label class="chk"><input type="checkbox" name="fee_refundable" value="1"> ${t('Fee refunded on the first order', '首单后退还样品费')}</label>
            <div class="full"><span class="lbl">${t('Proforma invoice (optional)', '形式发票（可选）')}</span>${drop('proforma', 'Drop the proforma invoice', '拖入形式发票')}</div>
            <label class="full"><span class="lbl">${t('Note (optional)', '备注（可选）')}</span><textarea name="note" rows="2"></textarea></label>
          </div>
          <div class="form-actions"><button class="btn">${t('Confirm', '确认')}</button>
          <details class="decline"><summary class="link">${t('We cannot make this sample', '无法提供此样品')}</summary><div><textarea name="decline_reason" rows="2" placeholder="Reason · 原因"></textarea><button class="btn ghost small danger" formaction="/portal/samples/${s.id}/decline" formnovalidate>${t('Send', '提交')}</button></div></details></div>
        </form></section>` : ''}

      ${['Requested', 'Confirmed'].includes(s.status) ? html`<section class="card ${s.status === 'Requested' ? 'dim' : ''}"><h2>${t(s.status === 'Requested' ? '2. Ship the sample' : 'Ship the sample', s.status === 'Requested' ? '2. 寄送样品' : '寄送样品')}</h2>
        <form method="post" enctype="multipart/form-data" action="/portal/samples/${s.id}/ship" class="fields" data-waybill-form="/portal/samples/${s.id}/waybill-read">
          <div class="full"><span class="lbl">${t('Waybill photo · fastest', '运单照片 · 最快')}</span>${drop('waybill', 'Drop a photo of the waybill or paste a screenshot. We read the carrier and number for you.', '拖入运单照片或粘贴截图，系统自动识别快递公司和单号。', { multiple: false, accept: '.jpg,.jpeg,.png,.webp,.pdf' })}<p class="read" data-waybill-result hidden></p></div>
          <div class="f2">
            <label><span class="lbl">${t('Tracking number', '运单号')}</span><input name="tracking_no" required autocomplete="off" spellcheck="false" data-detect-carrier value="${s.tracking_no || ''}"><span class="detect" data-detect-out></span></label>
            <label><span class="lbl">${t('Carrier', '快递公司')}</span><select name="carrier"><option value="">Detect automatically · 自动识别</option>${['dhl', 'fedex', 'ups', 'other'].map((c) => html`<option value="${c}">${CR.CARRIERS[c].name}</option>`)}</select></label>
            <label><span class="lbl">${t('Ship date', '寄出日期')}</span><input type="date" name="shipped_at" value="${today()}"></label>
            <label><span class="lbl">${t('Boxes', '箱数')}</span><input name="boxes" type="number" min="1" value="1"></label>
            <label><span class="lbl">${t('Weight kg', '重量 kg')}</span><input name="weight_kg" inputmode="decimal"></label>
            <label><span class="lbl">${t('Declared value USD', '申报价值 USD')}</span><input name="declared_value" inputmode="decimal"></label>
            <div class="full"><span class="lbl">${t('Commercial invoice & packing photos', '商业发票和包装照片')}</span>${drop('docs', 'Drop files here', '拖入文件')}</div>
          </div>
          <div class="form-actions"><button class="btn">${t('Mark as shipped', '确认已寄出')}</button><span class="muted small">${t('Lulyboo is notified and tracking starts automatically.', '提交后系统自动跟踪物流并通知 Lulyboo。')}</span></div>
        </form></section>` : ''}

      ${s.tracking_no ? html`<section class="card"><div class="head-row"><h2>${t('Tracking', '物流跟踪')} <span class="muted">· ${CR.CARRIERS[s.carrier]?.name || ''} ${s.tracking_no}</span></h2>${CR.trackingUrl(s.carrier, s.tracking_no) ? html`<a class="btn small ghost" target="_blank" rel="noopener" href="${CR.trackingUrl(s.carrier, s.tracking_no)}">${t('Carrier site', '快递官网')}</a>` : ''}</div>
        ${carrierEv.length ? timeline(carrierEv) : html`<p class="muted small">${t('Tracking updates appear here automatically.', '物流信息将自动显示在此处。')}</p>`}</section>` : ''}

      ${S.EVALUATED.includes(s.status) ? html`<section class="card"><h2>${t('Result', '评估结果')}</h2><p>${statusPill(s.status, true)}${s.eval_score ? html` <b>${s.eval_score}/10</b>` : ''}</p>
        ${(s.eval_checks || []).filter((c) => c.result).length ? html`<ul class="evalc ro">${s.eval_checks.filter((c) => c.result).map((c) => html`<li><span>${c.label}</span><span class="${c.result === 'pass' ? 'pos' : 'neg'}">${c.result === 'pass' ? '✓' : '✕'}</span></li>`)}</ul>` : ''}
        ${s.eval_notes ? html`<p class="pre">${s.eval_notes}</p>` : ''}</section>` : ''}

      <section class="card"><h2>${t('Documents', '文件')}</h2>${docTiles(files, href, { zh: true })}
        ${s.status !== 'Cancelled' ? html`<form method="post" enctype="multipart/form-data" action="/portal/samples/${s.id}/files" class="doc-add"><select name="kind">${Object.entries(S.FILE_KINDS).filter(([k]) => k !== 'payment').map(([k, v]) => html`<option value="${k}">${v[0]} · ${v[1]}</option>`)}</select>${drop('files', 'Add documents', '添加文件')}<button class="btn small">${t('Upload', '上传')}</button></form>` : ''}</section>
      </div>`,
    }));
  }));

  router.post('/portal/samples/:id/confirm', A(async (req, res) => {
    const s = await own(req); const { fields: f, files } = await parseForm(req, { limitBytes: 30 * 1024 * 1024 });
    if (s.status !== 'Requested') return res.redirect(`/portal/samples/${s.id}`);
    const fee = num(f.sample_fee);
    await db.update('samples', { id: s.id }, { status: 'Confirmed', confirmed_at: now(), sample_fee: fee, currency: ['USD', 'CNY'].includes(f.currency) ? f.currency : 'USD', freight_by: S.FREIGHT_BY[f.freight_by] ? f.freight_by : s.freight_by, freight_cost: num(f.freight_cost), fee_refundable: f.fee_refundable === '1', due_ship_date: day(f.due_ship_date) || s.due_ship_date, late_reminded_on: null, late_reminders: 0, updated_at: now() });
    const r = await S.storeFiles(db, s.id, [].concat(files?.proforma || []));
    for (const a of r.saved) await db.insert('sample_files', { sample_id: s.id, kind: 'proforma', name: a.name, path: a.path, mime: a.mime, bytes: a.bytes, uploaded_by: 'supplier', created_at: now() });
    await log(s.id, `Supplier confirmed${fee ? ` · fee ${fmt.money(fee, f.currency || 'USD')}` : ' · free sample'}${day(f.due_ship_date) ? ` · ships ${f.due_ship_date}` : ''}${str(f.note) ? ` · “${str(f.note, 200)}”` : ''}`, 'supplier');
    await S.notifyStatus({ db, config, sample: { ...s, status: 'Confirmed' }, supplier: req.supplier, status: 'Confirmed', detail: `${fee ? `Fee ${fmt.money(fee, f.currency || 'USD')} to pay` : 'Free sample'}${day(f.due_ship_date) ? ` · ships ${f.due_ship_date}` : ''}` });
    flash(res, 'ok', m('Confirmed. Please ship by the date you gave and add the tracking number.', '已确认。请按约定日期寄出并填写运单号。'));
    res.redirect(`/portal/samples/${s.id}`);
  }));
  router.post('/portal/samples/:id/decline', A(async (req, res) => {
    const s = await own(req); const { fields: f } = await parseForm(req, { limitBytes: 30 * 1024 * 1024 });
    if (!['Requested', 'Confirmed'].includes(s.status)) return res.redirect(`/portal/samples/${s.id}`);
    await db.update('samples', { id: s.id }, { status: 'Cancelled', next_check_at: null, updated_at: now() });
    await log(s.id, `Supplier cannot provide the sample${str(f.decline_reason) ? `: ${str(f.decline_reason, 200)}` : ''}`, 'supplier');
    await S.notifyStatus({ db, config, sample: s, supplier: req.supplier, status: 'Cancelled', detail: `Supplier cannot provide it${str(f.decline_reason) ? `: ${str(f.decline_reason, 200)}` : ''}` });
    flash(res, 'ok', m('Thank you, Lulyboo has been told.', '已通知 Lulyboo，谢谢。'));
    res.redirect('/portal/samples');
  }));
  router.post('/portal/samples/:id/ship', A(async (req, res) => {
    const s = await own(req); const { fields: f, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    if (!['Requested', 'Confirmed'].includes(s.status)) return res.redirect(`/portal/samples/${s.id}`);
    const way = [].concat(files?.waybill || [])[0];
    // No number typed but a waybill photo: let AI read it.
    if (!CR.clean(f.tracking_no) && way?.buffer?.length && AI.enabled()) { try { const w = await S.readWaybill(way.buffer, P.MIME[P.extOf(way.name)]); f.tracking_no = w.tracking_number; f.carrier = f.carrier || w.carrier; f.weight_kg = f.weight_kg || w.weight_kg; } catch (e) { console.error('Waybill read failed:', e.message); } }
    const r = await setTracking(s, f, 'supplier');
    if (r.error) { flash(res, 'error', r.error); return res.redirect(`/portal/samples/${s.id}`); }
    await db.update('samples', { id: s.id }, { boxes: int(f.boxes), weight_kg: num(f.weight_kg), declared_value: num(f.declared_value), confirmed_at: s.confirmed_at || now(), ...(day(f.shipped_at) ? { shipped_at: `${f.shipped_at}T12:00:00Z` } : {}) });
    const up = await S.storeFiles(db, s.id, [...(way ? [way] : []), ...[].concat(files?.docs || [])]);
    for (const a of up.saved) await db.insert('sample_files', { sample_id: s.id, kind: way && a.name === P.safeName(way.name) ? 'waybill' : (THUMB.test(a.name) ? 'photo' : 'invoice'), name: a.name, path: a.path, mime: a.mime, bytes: a.bytes, uploaded_by: 'supplier', created_at: now() });
    const fresh = await db.get('samples', s.id);
    await S.notifyStatus({ db, config, sample: fresh, supplier: req.supplier, status: 'Shipped', detail: `${CR.CARRIERS[r.carrier]?.name || 'Carrier'} ${r.no}${r.auto ? ' · tracked automatically' : ''}` });
    flash(res, 'ok', m('Marked as shipped. Thank you!', '已确认寄出，谢谢！'));
    res.redirect(`/portal/samples/${s.id}`);
  }));
  // AI reads a waybill photo while the supplier is filling the form (JSON).
  router.post('/portal/samples/:id/waybill-read', A(async (req, res) => {
    const s = await own(req); const { files } = await parseForm(req, { limitBytes: 12 * 1024 * 1024 });
    const way = [].concat(files?.waybill || [])[0];
    if (!way?.buffer?.length) return res.json({ ok: false, error: 'No file' }, 400);
    if (!AI.enabled()) return res.json({ ok: false, error: 'AI not available' });
    try { const w = await S.readWaybill(way.buffer, P.MIME[P.extOf(way.name)]); return res.json({ ok: true, sample: s.ref, ...w }); } catch (e) { return res.json({ ok: false, error: 'Could not read the waybill' }); }
  }));
  router.post('/portal/samples/:id/files', A(async (req, res) => {
    const s = await own(req); const { fields: f, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const r = await S.storeFiles(db, s.id, [].concat(files?.files || []));
    for (const a of r.saved) await db.insert('sample_files', { sample_id: s.id, kind: S.FILE_KINDS[f.kind] && f.kind !== 'payment' ? f.kind : 'other', name: a.name, path: a.path, mime: a.mime, bytes: a.bytes, uploaded_by: 'supplier', created_at: now() });
    if (r.saved.length) await log(s.id, `Supplier added ${r.saved.length} document(s)`, 'supplier');
    flash(res, r.errors.length ? 'warn' : 'ok', r.saved.length ? m('Uploaded', '已上传') : r.errors.join(' · ') || m('Choose a file', '请选择文件'));
    res.redirect(`/portal/samples/${s.id}`);
  }));
  router.get('/portal/sample-files/:fid', A(async (req, res) => {
    const f = await db.get('sample_files', req.params.fid); const s = f && await db.get('samples', f.sample_id);
    if (!f || !s || s.supplier_id !== req.supplier.id) throw new HttpError(404, m('File not found', '未找到文件'));
    serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
  }));
};
module.exports.nextAction = nextAction;
