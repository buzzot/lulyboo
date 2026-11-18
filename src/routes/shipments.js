'use strict';
// Orders → Shipments: everything that has left the factory, until it's counted in the warehouse.
// One row per container / LCL shipment (plan_containers once shipped) or courier parcel (a COURIER shipping
// confirmation without a container). Stages come from data already in the portal — Mark shipped, forwarder
// updates (ETD / ETA / arrival), customs entries — and "Delivered" is confirmed here with received cartons.

const crypto = require('node:crypto');
const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const FW = require('../forwarding');
const SD = require('../shipdocs');

const BASE = '/admin/orders/shipments';
const now = () => new Date().toISOString();
const portName = (c) => SC.PORT[c]?.name || c || '';
const BOXN = { '20GP': "20′ GP", '40GP': "40′ GP", '40HQ': "40′ HQ", LCL: 'LCL' };
const usd = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const day = (v) => (v ? String(v).slice(0, 10) : null);
const sh = (v) => (v ? PL.short(day(v)) : '');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fmtCont = (v) => (/^[A-Z]{4}\d{7}$/.test(v || '') ? `${v.slice(0, 4)} ${v.slice(4)}` : v || '');
const STAGES = [['shipped', 'Shipped'], ['sailed', 'Sailed'], ['arrived', 'Arrived'], ['customs', 'Customs'], ['delivered', 'Delivered']];
const STAGE_TAG = { shipped: ['Shipped', 's0'], sailed: ['On the water', 's1'], arrived: ['Arrived', 's2'], customs: ['Arrived · customs', 's2'], delivered: ['Delivered', 's4'], courier: ['Courier', 's3'] };

/** Everything the list and the detail page need, for every shipment. */
async function load(db) {
  const today = PL.today();
  const all = await db.list('plan_containers', { order: 'created_at.asc' }).catch(() => []);
  const n = {}; for (const c of all) { n[c.port] = (n[c.port] || 0) + 1; c.no = n[c.port]; }
  const lines = await db.list('plan_orders').catch(() => []);
  const scs = await db.list('ship_confirmations').catch(() => []);
  const quotes = await db.list('plan_quotes').catch(() => []);
  const entries = (await db.list('customs_entries').catch(() => [])).filter((e) => ['saved', 'pending'].includes(e.status));
  const sups = {}; for (const s of await db.list('suppliers').catch(() => [])) sups[s.id] = s;
  const fwdUps = await db.list('fwd_updates').catch(() => []);
  const out = [];
  for (const c of all) {
    const f = c.fwd || {};
    const fs = FW.stageOf(f);
    if (c.status !== 'shipped' && !c.delivered_at && !(fs && fs !== 'booked')) continue;
    const ls = lines.filter((l) => l.container_id === c.id);
    const cs = scs.filter((s) => s.container_id === c.id && s.status !== 'cancelled');
    const ce = entries.filter((e) => e.container_id === c.id);
    const chosen = quotes.find((q) => q.container_id === c.id && q.status === 'chosen');
    const arrivedOn = day(f.ata) || (f.arrived ? day(f.eta) : null);
    const stage = c.delivered_at ? 'delivered' : ce.length && (arrivedOn || (f.eta && f.eta <= today)) ? 'customs' : arrivedOn || fs === 'arrived' ? 'arrived' : fs === 'on_water' || fs === 'arrived_due' ? 'sailed' : 'shipped';
    const freight = chosen ? Number(chosen.total_usd ?? chosen.ocean_usd) || null : Number(f.ocean_usd) || null;
    const duty = ce.filter((e) => e.status === 'saved').reduce((a, e) => a + (Number(e.duty) || 0) + (Number(e.fees) || 0), 0) || null;
    const freeDays = chosen?.free_days ?? null;
    const lfd = day(f.free_until) || (freeDays != null && (arrivedOn || f.eta) ? PL.addDays(arrivedOn || f.eta, Number(freeDays)) : null);
    // documents still missing from suppliers
    const missing = [];
    for (const s of cs) for (const k of s.missing || []) missing.push({ kind: k, po: (s.pos || [])[0] || '' });
    const docsOk = cs.length && cs.every((s) => s.status === 'complete' && !(s.missing || []).length);
    const flags = [];
    if (stage !== 'delivered') {
      if (f.eta_prev && f.eta && f.eta > f.eta_prev && stage === 'sailed') flags.push(['amb', `ETA +${daysBetween(f.eta_prev, f.eta)} days`]);
      if (missing.length) flags.push(['amb', `Docs: ${[...new Set(missing.map((m) => `${m.kind}${m.po ? ` (${m.po})` : ''}`))].slice(0, 2).join(', ')} missing`]);
      else if (docsOk) flags.push(['grn', 'Docs ✓']);
      if ((stage === 'arrived') && !ce.length) flags.push(['red', 'No customs entry yet']);
      if (ce.length) { const e = ce[0]; flags.push(e.status === 'saved' ? ['grn', `7501 ✓ duty ${usd(e.duty)}`] : ['amb', '7501 to review']); }
      if (lfd && (stage === 'arrived' || stage === 'customs')) { const d = daysBetween(today, lfd); flags.push(d < 0 ? ['red', `Free time over (${sh(lfd)}) · book delivery`] : d <= 3 ? ['amb', `Free time ends ${sh(lfd)}`] : ['gry', `Free time to ${sh(lfd)}`]); }
      if (stage === 'sailed' && f.eta) { const d = daysBetween(today, f.eta); if (d >= 0 && d <= 7) flags.push(['blu', d === 0 ? 'Arrives today' : `Arrives in ${d} day${d === 1 ? '' : 's'}`]); if (d < 0 && !arrivedOn) flags.push(['amb', `ETA passed ${sh(f.eta)} — no arrival notice`]); }
    } else {
      const short = (c.received || []).filter((r) => r.shipped != null && r.received != null && r.received < r.shipped);
      if (short.length) flags.push(['red', `Short ${short.reduce((a, r) => a + (r.shipped - r.received), 0)} ctns`]);
      else flags.push(['grn', 'Received in full']);
    }
    const pos = [...new Map(ls.map((l) => [`${l.supplier_id}|${PL.normPo(l.po)}`, { po: l.po, supplier_id: l.supplier_id }])).values()];
    out.push({
      id: c.id, kind: c.box === 'LCL' ? 'lcl' : 'fcl', c, f, stage,
      fwdReview: fwdUps.filter((u) => u.container_id === c.id && u.status === 'pending').map((u) => u.id), fwdLog: fwdUps.filter((u) => u.container_id === c.id && ['accepted', 'logged'].includes(u.status)).length, lines: ls, scs: cs, entries: ce, chosen, flags, lfd, arrivedOn, freight, duty, drayage: Number(c.drayage_usd) || null,
      title: `${portName(c.port)} · ${c.box === 'LCL' ? 'LCL shipment' : 'Container'} ${c.no}${c.box !== 'LCL' ? ` · ${BOXN[c.box] || c.box}` : ''}`,
      sub: [f.forwarder || chosen?.company, f.booking_no, f.hbl_no ? `HBL ${f.hbl_no}` : '', [f.carrier, f.vessel, f.voyage].filter(Boolean).join(' '), fmtCont(f.container_no || c.container_no)].filter(Boolean).join(' · '),
      pos, suppliers: [...new Set(pos.map((p) => sups[p.supplier_id]?.name).filter(Boolean))], port: c.port, forwarder: f.forwarder || chosen?.company || '',
      from: day(f.atd) || (fs === 'on_water' || fs === 'arrived' || fs === 'arrived_due' ? day(f.etd) : null) || day(c.updated_at), eta: day(f.eta), delivered: day(c.delivered_at),
      cbm: ls.reduce((a, l) => a + (Number(l.cbm) || 0), 0), cartons: ls.reduce((a, l) => a + (Number(l.cartons) || 0), 0),
    });
  }
  // courier parcels: COURIER shipping confirmations without a container, once the supplier confirmed pickup
  for (const s of scs.filter((x) => x.mode === 'COURIER' && !x.container_id && ['received', 'complete'].includes(x.status))) {
    const ls = lines.filter((l) => (s.order_ids || []).includes(l.id) || (l.supplier_id === s.supplier_id && (s.pos || []).some((p) => PL.normPo(p) === PL.normPo(l.po))));
    const facts = s.facts || {};
    const stage = s.delivered_at ? 'delivered' : 'courier';
    const flags = [];
    if (stage === 'courier') { if ((s.missing || []).length) flags.push(['amb', `Docs: ${s.missing.slice(0, 2).join(', ')} missing`]); else if (s.status === 'complete') flags.push(['grn', 'Docs ✓']); }
    else { const short = (s.received || []).filter((r) => r.received < r.shipped); flags.push(short.length ? ['red', `Short ${short.reduce((a, r) => a + (r.shipped - r.received), 0)} ctns`] : ['grn', 'Received in full']); }
    out.push({
      id: `sc-${s.id}`, kind: 'courier', sc: s, stage, lines: ls, scs: [s], entries: [], flags, freight: null, duty: null, drayage: null, f: {},
      title: `Courier · ${sups[s.supplier_id]?.name || 'Supplier'}`, sub: [facts.carrier || facts.courier, facts.tracking_no || s.bl_no || facts.bl_no].filter(Boolean).join(' · '),
      pos: [...new Set((s.pos || []))].map((po) => ({ po, supplier_id: s.supplier_id })), suppliers: [sups[s.supplier_id]?.name].filter(Boolean), port: '', forwarder: facts.carrier || '',
      from: day(s.confirmed_at), eta: null, delivered: day(s.delivered_at), cbm: ls.reduce((a, l) => a + (Number(l.cbm) || 0), 0), cartons: ls.reduce((a, l) => a + (Number(l.cartons) || 0), 0),
    });
  }
  return { list: out, sups, today };
}

/** Progress along the voyage, 0–100. */
function progress(r, today) {
  if (r.stage === 'delivered' || r.stage === 'arrived' || r.stage === 'customs') return 100;
  if (r.stage === 'courier') return r.from ? 50 : 10;
  if (!r.from || !r.eta) return r.stage === 'sailed' ? 10 : 3;
  return Math.max(3, Math.min(97, Math.round(((Date.parse(today) - Date.parse(r.from)) / Math.max(1, Date.parse(r.eta) - Date.parse(r.from))) * 100)));
}

function rowHTML(r, today) {
  const [lab, cls] = STAGE_TAG[r.stage];
  const pct = progress(r, today);
  const left = r.stage === 'delivered' ? `Delivered ${sh(r.delivered)}` : r.stage === 'arrived' || r.stage === 'customs' ? `Arrived ${r.f.pod || ''} ${sh(r.arrivedOn || r.eta)}` : r.stage === 'courier' ? `Picked up ${sh(r.from)}` : r.stage === 'sailed' ? `Sailed ${sh(r.from)}` : `Shipped ${sh(r.from)}`;
  const right = r.stage === 'delivered' ? (r.c?.delivered_to || r.sc?.delivered_to || '') : r.stage === 'arrived' || r.stage === 'customs' ? (r.lfd ? `Free time → ${sh(r.lfd)}` : '') : r.eta ? `ETA ${sh(r.eta)}` : r.f.etd ? `ETD ${sh(r.f.etd)}` : '';
  const late = r.f.eta_prev && r.eta && r.eta > r.f.eta_prev && r.stage === 'sailed';
  const cost = (r.freight || 0) + (r.duty || 0) + (r.drayage || 0);
  return html`<a class="shp-row" href="${BASE}/${r.id}">
    <div class="shp-t"><span class="shp-st ${cls}">${lab}</span><b>${r.title}</b><span class="sub">${r.sub || '—'}</span></div>
    <div class="shp-pos">${r.pos.slice(0, 5).map((p) => html`<span>${p.po}</span>`)}${r.pos.length > 5 ? html`<span>+${r.pos.length - 5}</span>` : ''}<em class="sub">${r.suppliers.length > 2 ? `${r.suppliers.length} suppliers` : r.suppliers.join(' · ')}</em></div>
    <div class="shp-trk"><div class="shp-ln"><span>${left}</span><b class="${late ? 'late' : ''}">${right}${late ? html` <s>${sh(r.f.eta_prev)}</s>` : ''}</b></div><div class="shp-pb ${cls}"><i style="width:${pct}%"></i>${r.stage === 'sailed' ? html`<em style="left:${pct}%">🚢</em>` : ''}</div></div>
    <div class="shp-fl">${r.flags.map(([k, t]) => html`<span class="shp-f ${k}">${t}</span>`)}${r.c && r.stage !== 'delivered' ? html`<button type="button" class="shp-fwb ${r.fwdReview?.length ? 'on' : ''}" data-fwc="${r.c.id}" ${r.fwdReview?.length ? raw(`data-fwc-rev="${r.fwdReview[0]}"`) : ''} data-fwc-name="${r.title}" data-fwc-sub="${r.f.forwarder || ''}" title="Paste or drop an email from the forwarder">${r.fwdReview?.length ? `${r.fwdReview.length} to review` : '＋ Forwarder update'}</button>` : ''}</div>
    <div class="shp-cost">${cost ? html`<b>${usd(cost)}</b><span class="sub">${[r.freight ? 'freight' : '', r.duty ? 'duty' : '', r.drayage ? 'delivery' : ''].filter(Boolean).join(' + ')}</span>` : html`<span class="sub">${r.cbm ? `${Math.round(r.cbm * 100) / 100} m³` : ''}</span>`}</div>
  </a>`;
}

module.exports = function shipmentRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';

  router.get(BASE, G(async (req, res) => {
    const { list, today } = await load(db);
    const q = req.query;
    const view = q.view === 'delivered' ? 'delivered' : 'active';
    const tile = ['transit', 'soon', 'port', 'done'].includes(q.tile) ? q.tile : '';
    const ports = [...new Set(list.filter((r) => r.port).map((r) => r.port))];
    const fwds = [...new Set(list.map((r) => r.forwarder).filter(Boolean))].sort();
    const term = String(q.q || '').trim().toUpperCase().replace(/\s+/g, '');
    const hit = (r) => !term || [r.title, r.sub, ...r.pos.map((p) => p.po), ...r.lines.map((l) => `${l.sku || ''} ${l.product || ''}`), r.f.hbl_no, r.f.mbl_no, r.f.container_no, r.c?.container_no, r.f.booking_no].filter(Boolean).join(' ').toUpperCase().replace(/\s+/g, '').includes(term);
    const base = list.filter((r) => (!q.port || r.port === q.port) && (!q.fwd || r.forwarder === q.fwd) && hit(r));
    const month = today.slice(0, 7);
    const dAgo = PL.addDays(today, -30);
    const T = {
      transit: base.filter((r) => ['shipped', 'sailed', 'courier'].includes(r.stage)),
      soon: base.filter((r) => r.stage === 'sailed' && r.eta && r.eta >= today && r.eta <= PL.addDays(today, 7)),
      port: base.filter((r) => r.stage === 'arrived' || r.stage === 'customs'),
      done: base.filter((r) => r.stage === 'delivered' && r.delivered && r.delivered >= dAgo),
    };
    const monthCost = base.filter((r) => (r.delivered || r.arrivedOn || r.eta || '').startsWith(month)).reduce((a, r) => ({ f: a.f + (r.freight || 0), d: a.d + (r.duty || 0) + (r.drayage || 0) }), { f: 0, d: 0 });
    const lfdSoon = T.port.filter((r) => r.lfd).sort((a, b) => a.lfd.localeCompare(b.lfd))[0];
    const shortN = T.done.filter((r) => r.flags.some(([k]) => k === 'red')).length;
    let rows = tile ? T[tile] : base.filter((r) => (view === 'delivered' ? r.stage === 'delivered' : r.stage !== 'delivered'));
    const groups = view === 'delivered' || tile === 'done'
      ? [['Delivered', rows.sort((a, b) => String(b.delivered).localeCompare(String(a.delivered)))]]
      : [['At port / customs', rows.filter((r) => r.stage === 'arrived' || r.stage === 'customs')], ['On the water', rows.filter((r) => r.stage === 'sailed').sort((a, b) => String(a.eta || '9').localeCompare(String(b.eta || '9')))], ['Shipped · waiting to sail', rows.filter((r) => r.stage === 'shipped')], ['Courier', rows.filter((r) => r.stage === 'courier')], ['Delivered', rows.filter((r) => r.stage === 'delivered')]];
    const link = (o) => `${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries({ port: q.port || '', fwd: q.fwd || '', q: q.q || '', view, tile, ...o }).filter(([, v]) => v)))}`;
    const recent = base.filter((r) => r.stage === 'delivered' && r.delivered >= dAgo).length;
    res.html(page({
      title: 'Shipments', nav: adminNav('shipments'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Shipments</h2><p class="muted">Everything that has left the factory, until it's in your warehouse.</p></div></div>
        <div class="shp-kp">
          ${[['transit', 'In transit', T.transit.length, `${T.transit.filter((r) => r.stage === 'sailed').length} on the water`], ['soon', 'Arriving ≤ 7 days', T.soon.length, T.soon.map((r) => sh(r.eta)).slice(0, 3).join(' · ')], ['port', 'At port / customs', T.port.length, lfdSoon ? `Free time ends ${sh(lfdSoon.lfd)}` : ''], ['done', 'Delivered · 30 days', T.done.length, shortN ? `${shortN} with a shortage` : '']].map(([k, l, nn, s]) => html`<a href="${link({ tile: tile === k ? '' : k })}" class="${tile === k ? 'on' : ''}"><span>${l}</span><b>${nn}</b><small>${s}</small></a>`)}
          <div><span>Landed cost · ${new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span><b>${usd(monthCost.f + monthCost.d)}</b><small>freight ${usd(monthCost.f)} · duty ${usd(monthCost.d)}</small></div>
        </div>
        <form method="get" action="${BASE}" class="shp-bar">
          ${ports.length > 1 ? html`<span class="rh-seg">${[['', 'All'], ...ports.map((p) => [p, portName(p)])].map(([v, l]) => html`<a href="${link({ port: v })}" class="${(q.port || '') === v ? 'on' : ''}">${l}</a>`)}</span>` : ''}
          ${fwds.length > 1 ? html`<select name="fwd" data-autosubmit aria-label="Forwarder"><option value="">All forwarders</option>${fwds.map((x) => html`<option ${q.fwd === x ? raw('selected') : ''}>${x}</option>`)}</select>` : ''}
          <span class="rh-seg"><a href="${link({ view: 'active', tile: '' })}" class="${view === 'active' && !tile ? 'on' : ''}">Active</a><a href="${link({ view: 'delivered', tile: '' })}" class="${view === 'delivered' && !tile ? 'on' : ''}">Delivered</a></span>
          <input type="search" name="q" value="${q.q || ''}" placeholder="Search PO, B/L, container, SKU…" aria-label="Search">
          ${q.port ? html`<input type="hidden" name="port" value="${q.port}">` : ''}<input type="hidden" name="view" value="${view}">
        </form>
        ${rows.length ? groups.filter(([, rs]) => rs.length).map(([g, rs]) => html`<div class="shp-grp">${g} <span>${rs.length}</span></div>${rs.map((r) => rowHTML(r, today))}`) : html`<section class="card"><p class="muted">${list.length ? 'Nothing matches.' : 'Nothing shipped yet. A container shows here once it is marked shipped on Load containers, or once the forwarder says it sailed.'}</p></section>`}
        ${view === 'active' && !tile && recent ? html`<p class="shp-more"><a href="${link({ view: 'delivered' })}">Delivered · last 30 days (${recent}) →</a></p>` : ''}`,
    }));
  }));

  async function one(id) {
    const { list, today } = await load(db);
    const r = list.find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'Shipment not found');
    return { r, today };
  }

  router.get(`${BASE}/:id`, G(async (req, res) => {
    const { r, today } = await one(req.params.id);
    const prods = await db.list('products').catch(() => []);
    const sups = {}; for (const s of await db.list('suppliers').catch(() => [])) sups[s.id] = s;
    // duty per piece from customs entries (by line, else product code), freight share by m³
    const dutyPc = (l) => {
      for (const e of r.entries.filter((x) => x.status === 'saved')) for (const cl of e.lines || []) for (const p of cl.products || []) {
        if ((p.line_id && p.line_id === l.id) || (l.sku && p.code && p.code.replace(/\W/g, '').toUpperCase() === String(l.sku).replace(/\W/g, '').toUpperCase())) return p.per_pc;
      }
      return null;
    };
    const totCbm = r.lines.reduce((a, l) => a + (Number(l.cbm) || 0), 0);
    const freightPc = (l) => (r.freight && totCbm && l.cbm && l.qty ? (r.freight * (Number(l.cbm) / totCbm)) / Number(l.qty) : null);
    // steps
    const f = r.f; const done = (k) => STAGES.findIndex(([x]) => x === k) <= STAGES.findIndex(([x]) => x === (r.stage === 'courier' ? 'shipped' : r.stage));
    const sDate = { shipped: sh(r.scs.map((s) => s.confirmed_at).filter(Boolean).sort()[0] || r.from), sailed: f.atd || (done('sailed') && f.etd) ? `${sh(f.atd || f.etd)}${f.pol ? ` · ${f.pol}` : ''}` : f.etd ? `ETD ${sh(f.etd)}` : '', arrived: r.arrivedOn ? `${sh(r.arrivedOn)}${f.pod ? ` · ${f.pod}` : ''}` : f.eta ? `ETA ${sh(f.eta)}` : '', customs: r.entries.length ? `7501 · duty ${usd(r.entries[0].duty)}` : '', delivered: r.delivered ? sh(r.delivered) : r.lfd ? `free time to ${sh(r.lfd)}` : '' };
    const steps = r.kind === 'courier' ? [['shipped', 'Picked up'], ['delivered', 'Delivered']] : STAGES;
    const cur = steps.findIndex(([k]) => !done(k));
    // timeline
    const ev = [];
    for (const s of r.scs) {
      if (s.confirmed_at) ev.push([day(s.confirmed_at), '📦', s.mode === 'LCL' ? "At the forwarder's warehouse" : s.mode === 'COURIER' ? 'Picked up by the courier' : 'Loaded', `${sups[s.supplier_id]?.name || ''} · ${(s.pos || []).join(', ')}`]);
      if (s.status === 'complete' && s.accepted_at) ev.push([day(s.accepted_at), '📄', 'Supplier documents accepted', `${sups[s.supplier_id]?.name || ''}`]);
    }
    for (const u of (r.c ? await db.list('fwd_updates', { filters: { container_id: r.c.id } }).catch(() => []) : []).filter((x) => ['accepted', 'logged'].includes(x.status))) ev.push([day(u.decided_at || u.created_at), '⚓', FW.DOC_TYPES[u.facts?.doc_type] || 'Forwarder update', u.facts?.summary || '']);
    if (f.atd || (done('sailed') && f.etd)) ev.push([day(f.atd || f.etd), '🚢', 'Sailed', [f.carrier, f.vessel, f.voyage].filter(Boolean).join(' ') + (f.eta ? ` — ETA ${sh(f.eta)}` : '')]);
    if (r.arrivedOn) ev.push([r.arrivedOn, '⚓', `Arrived${f.pod ? ` ${f.pod}` : ''}`, r.lfd ? `free time until ${sh(r.lfd)}` : '']);
    for (const e of r.entries) ev.push([day(e.entry_date || e.created_at), '🛃', `Customs entry ${e.entry_no || ''}`, `duty ${usd(e.duty, 2)} + fees ${usd(e.fees, 2)}${e.status === 'pending' ? ' · to review' : ''}`]);
    if (r.delivered) ev.push([r.delivered, '✅', `Delivered${(r.c || r.sc).delivered_to ? ` to ${(r.c || r.sc).delivered_to}` : ''}`, (r.c || r.sc).delivery_note || '']);
    ev.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
    // documents — each with its files (preview in a popup, download), customs linked to its record
    const files = r.scs.length ? await db.list('plan_files').catch(() => []) : [];
    const sFiles = files.filter((x) => r.scs.some((s) => s.id === x.shipment_id));
    const ups = r.c ? (await db.list('fwd_updates', { filters: { container_id: r.c.id } }).catch(() => [])).filter((x) => ['accepted', 'logged'].includes(x.status)) : [];
    const canSee = (t) => /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(t || '');
    const fl = (name, url, type, dl, rm = null) => ({ name, url, type: type || '', dl: dl || url, rm });
    const pf = (x) => fl(x.name, `/admin/logistics/planning/files/${x.id}`, x.content_type, null, { src: 'plan', ref: x.id });
    const of = (re) => sFiles.filter((x) => re.test(x.kind || '')).map(pf);
    const fwdFiles = (re) => ups.filter((u) => re.test(u.facts?.doc_type || '')).flatMap((u) => (u.files || []).map((x, i) => fl(x.name, `/admin/orders/shipping/fwd/${u.id}/files/${i}`, x.type, null, { src: 'fwd', ref: u.id, i })));
    const fwdDocs = new Set((f.docs || []).map((d) => d.type));
    const bl = [f.hbl_no ? `HBL ${f.hbl_no}` : '', f.mbl_no ? `MBL ${f.mbl_no}` : ''].filter(Boolean).join(' · ');
    const docs = [
      { l: 'Commercial invoice', files: of(/invoice/i) },
      { l: 'Packing list', files: of(/packing/i) },
      ...(r.kind === 'lcl' ? [{ l: 'Warehouse receipt (FCR)', files: of(/warehouse/i) }] : []),
      { l: r.kind === 'courier' ? 'Courier waybill' : r.kind === 'lcl' ? 'House B/L' : 'Bill of lading', files: [...of(/bill of lading|waybill/i), ...fwdFiles(/bill|bl/i)], note: bl, okIf: !!(f.hbl_no || f.mbl_no) },
      ...(of(/loading photo/i).length ? [{ l: 'Loading photos', files: of(/loading photo/i), gallery: true }] : []),
      ...(r.kind === 'courier' ? [] : [
        { l: 'Booking / shipping advice', files: fwdFiles(/booking|shipping_advice|so\b/i), okIf: fwdDocs.has('booking') || fwdDocs.has('shipping_advice'), optional: true },
        { l: 'Arrival notice', files: fwdFiles(/arrival/i), okIf: fwdDocs.has('arrival_notice') || !!r.arrivedOn },
      ]),
      ...(r.kind === 'courier' ? [] : [{ l: 'Customs entry (7501)', customs: true, files: r.entries.flatMap((e) => (e.files || []).map((x, i) => fl(x.name, `/admin/logistics/customs/${e.id}/file/${i}`, x.type))), okIf: r.entries.some((e) => e.status === 'saved') }]),
      { l: 'Delivery receipt / POD', files: ((r.c || r.sc).delivery_files || []).map((x, i) => fl(x.name, `${BASE}/${r.id}/file/${i}`, x.type, null, { src: 'delivery', ref: '', i })) },
    ];
    const fileA = (x, g) => (canSee(x.type) ? html`<a class="shp-fa" href="${x.url}?inline=1" data-preview="${x.url}?inline=1" data-type="${/image/.test(x.type) ? 'image' : 'doc'}" data-dl="${x.dl}" ${g ? raw(`data-gallery="${g}"`) : ''} title="Preview">${x.name}</a>` : html`<a class="shp-fa" href="${x.dl}" title="Download">${x.name}</a>`);
    // container, voyage, delays
    const sailing = r.c?.sailing_id ? await db.get('sailings', r.c.sailing_id).catch(() => null) : null;
    const planEtd = sailing?.etd ? day(sailing.etd) : null;
    const planEta = sailing?.eta ? day(sailing.eta) : planEtd && sailing?.transit_days ? PL.addDays(planEtd, Number(sailing.transit_days)) : null;
    const lateBy = (planned, act) => (planned && act ? daysBetween(planned, act) : 0);
    const dep = { plan: planEtd, now: day(f.atd) || day(f.etd), actual: !!f.atd };
    const arr = { plan: planEta, now: day(f.ata) || day(f.eta), actual: !!f.ata };
    const changes = [];
    for (const u of ups) for (const x of u.applied || []) if (['etd', 'eta', 'atd', 'cy_cutoff', 'si_cutoff', 'vessel', 'loading_date'].includes(x.key) && x.from && x.to && String(x.from) !== String(x.to)) {
      const d = /date|etd|eta|atd|cutoff/.test(x.key) && /^\d{4}-\d\d-\d\d/.test(String(x.from)) ? daysBetween(day(x.from), day(x.to)) : null;
      changes.push({ at: day(u.decided_at || u.created_at), what: x.label, from: /^\d{4}-/.test(String(x.from)) ? sh(x.from) : x.from, to: /^\d{4}-/.test(String(x.to)) ? sh(x.to) : x.to, d, src: FW.DOC_TYPES[u.facts?.doc_type] || 'Forwarder update' });
    }
    if (f.eta_prev && f.eta && !changes.some((x) => x.what === 'ETA')) changes.push({ at: day(f.eta_changed_at), what: 'ETA', from: sh(f.eta_prev), to: sh(f.eta), d: daysBetween(day(f.eta_prev), day(f.eta)), src: 'Forwarder update' });
    changes.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const scF = r.scs.map((s) => s.facts || {});
    const cNo = fmtCont(f.container_no || r.c?.container_no || SD.cleanNo(scF.map((x) => x.container_no).find((v) => SD.cleanNo(v))) || '');
    const seal = f.seal_no || r.c?.seal_no || scF.map((x) => x.seal_no).find((v) => SD.cleanNo(v)) || '';
    const fwdList = r.c ? (await db.list('forwarders', { order: 'company.asc' }).catch(() => [])).filter((x) => x.active !== false && x.company) : [];
    const tot = (k) => r.lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
    const int = (v) => Number(v || 0).toLocaleString('en-US');
    const n2 = (v) => (Math.round(Number(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fact = (label, v, small = '', cls = '') => html`<div class="shp-fct ${cls}"><span>${label}</span><b>${v || raw('<i class="fw-none">—</i>')}</b>${small ? html`<small>${small}</small>` : ''}</div>`;
    const leg = (label, port, x, est, act) => { const late = lateBy(x.plan, x.now);
      return html`<div class="shp-leg"><span class="sub">${label}</span><b>${port || '—'}</b>
        <div class="shp-leg-d">${x.now ? html`<b>${sh(x.now)}</b> <span class="sub">${x.actual ? act.toLowerCase() : est}</span>` : html`<span class="sub">${est} not known yet</span>`}</div>
        ${x.plan ? html`<div class="sub">planned ${sh(x.plan)}${late ? html` <span class="shp-f ${late > 0 ? 'amb' : 'grn'}">${late > 0 ? `${late} day${late === 1 ? '' : 's'} late` : `${-late} day${late === -1 ? '' : 's'} early`}</span>` : x.now ? ' · on time' : ''}</div>` : ''}</div>`; };
    const htsOf = (l) => { for (const e of r.entries) for (const cl of e.lines || []) for (const p of cl.products || []) if ((p.line_id && p.line_id === l.id) || (l.sku && p.code && p.code.replace(/\W/g, '').toUpperCase() === String(l.sku).replace(/\W/g, '').toUpperCase())) return { hts: cl.hts, rate: cl.rate, entry: e.id }; return null; };
    const prodHts = (l) => { const pr = prods.find((p) => p.supplier_id === l.supplier_id && ((l.sku && p.sku === l.sku) || (l.product && p.name === l.product))); return pr?.hts_verified_code || pr?.hts_code || ''; };
    const rec = {}; for (const x of ((r.c || r.sc).received || [])) rec[x.line_id] = x;
    const cost = (r.freight || 0) + (r.duty || 0) + (r.drayage || 0);
    const editable = r.stage !== 'delivered';
    res.html(page({
      title: r.title, nav: adminNav('shipments'), flash: takeFlash(req, res), wide: true, req,
      body: html`<p class="crumbs"><a href="${BASE}">Shipments</a></p>
        <section class="card shp-d">
          <div class="shp-dh"><h1>${r.title}</h1><span class="shp-st ${STAGE_TAG[r.stage][1]}">${STAGE_TAG[r.stage][0]}</span>
            <span class="shp-dact">${r.c ? html`<a class="btn ghost small" href="/admin/logistics/planning/load?port=${r.c.port}#c-${r.c.id}">Container plan</a>` : ''}${FW.trackUrl(f) ? html`<a class="btn ghost small" href="${FW.trackUrl(f)}" target="_blank" rel="noopener">Track ↗</a>` : ''}
            ${r.c && editable ? html`<button type="button" class="btn ghost small" data-fwc="${r.c.id}" data-fwc-name="${r.title}" data-fwc-sub="${f.forwarder || ''}" title="Paste or drop an email, PDF or screenshot from the forwarder — AI compares it with this shipment">＋ Forwarder update</button>` : ''}
            ${r.c && r.fwdReview.length ? html`<button type="button" class="btn small" data-fwc="${r.c.id}" data-fwc-rev="${r.fwdReview[0]}" data-fwc-name="${r.title}" data-fwc-sub="${f.forwarder || ''}">${r.fwdReview.length} update${r.fwdReview.length > 1 ? 's' : ''} to review</button>` : ''}
            ${r.c && r.fwdLog ? html`<button type="button" class="link small" data-fwc="${r.c.id}" data-fwc-log data-fwc-name="${r.title}">Forwarder log (${r.fwdLog})</button>` : ''}
            ${editable ? html`<button type="button" class="btn small" data-open-dialog="shp-deliver">Mark delivered…</button>` : html`<form method="post" action="${BASE}/${r.id}/reopen" class="inline"><button class="link small">Reopen</button></form>`}</span></div>
          <p class="sub">${r.sub}</p>
          <div class="shp-steps">${steps.map(([k, l], i) => html`<div class="shp-s ${done(k) ? 'done' : i === cur ? 'now' : ''}"><b>${l}</b><small>${sDate[k] || ''}</small></div>`)}</div>
          ${r.flags.length ? html`<div class="shp-fl">${r.flags.map(([k, t]) => html`<span class="shp-f ${k}">${t}</span>`)}</div>` : ''}
          <div class="shp-two">
            <div>
              ${r.kind === 'courier' ? html`<h3>Parcel</h3><div class="shp-facts">${fact('Courier', r.forwarder)}${fact('Tracking no.', r.sub.split(' · ')[1] || '')}${fact('Picked up', sh(r.from))}${fact('Cartons · m³', [tot('cartons') ? `${int(tot('cartons'))} ctns` : '', tot('cbm') ? `${n2(tot('cbm'))} m³` : ''].filter(Boolean).join(' · '))}</div>`
              : html`<h3>Voyage</h3>
              <div class="shp-voy">
                ${leg('Departure', f.pol || portName(r.c?.port), dep, 'ETD', 'Sailed')}
                <div class="shp-voy-mid">${dep.now && arr.now ? (() => { const pct = arr.actual ? 100 : !dep.actual ? 0 : Math.max(4, Math.min(96, Math.round((daysBetween(dep.now, today) / Math.max(1, daysBetween(dep.now, arr.now))) * 100))); return html`<div class="shp-vbar"><i style="width:${pct}%"></i><em style="left:${pct}%">🚢</em></div><span class="sub">${daysBetween(dep.now, arr.now)} days at sea${dep.actual && !arr.actual ? ` · ${Math.max(0, daysBetween(today, arr.now))} to go` : ''}</span>`; })() : html`<span class="sub">no sailing dates yet — add a forwarder update</span>`}</div>
                ${leg('Arrival', f.pod || 'Los Angeles / Long Beach', arr, 'ETA', 'Arrived')}
              </div>
              <h3>Container &amp; booking</h3>
              <div class="shp-facts">
                <div class="shp-fct"><span>Forwarder</span>${f.forwarder || r.forwarder ? html`<b>${f.forwarder || r.forwarder}</b>` : ''}
                  <form method="post" action="${BASE}/${r.id}/forwarder" class="shp-fwsel ${f.forwarder || r.forwarder ? 'chg' : ''}"><select name="forwarder" data-autosubmit aria-label="Forwarder"><option value="">${f.forwarder || r.forwarder ? 'Change…' : 'Choose forwarder…'}</option>${fwdList.map((x) => html`<option value="${x.company}" ${!(f.forwarder || r.forwarder) || x.company !== (f.forwarder || r.forwarder) ? '' : raw('disabled')}>${x.company}</option>`)}</select></form>
                  ${f.booking_no ? html`<small>booking ${f.booking_no}</small>` : ''}</div>
                ${fact('Carrier · vessel', [f.carrier, f.vessel].filter(Boolean).join(' · '), f.voyage ? `voyage ${f.voyage}` : '')}
                ${fact(r.kind === 'lcl' ? 'Container (shared)' : 'Container', cNo, [r.kind === 'lcl' ? 'LCL' : BOXN[r.c?.box] || f.container_type, seal ? `seal ${seal}` : ''].filter(Boolean).join(' · '), 'mono')}
                ${fact('House B/L', f.hbl_no || r.scs.map((s) => SD.cleanNo(s.bl_no)).find(Boolean) || '', '', 'mono')}
                ${fact('Master B/L', f.mbl_no, '', 'mono')}
                ${dep.actual ? fact('Free time', r.lfd ? `until ${sh(r.lfd)}` : '', r.lfd && !r.delivered ? (daysBetween(today, r.lfd) >= 0 ? `${daysBetween(today, r.lfd)} days left` : `${-daysBetween(today, r.lfd)} days over`) : '', r.lfd && !r.delivered && r.lfd < today ? 'bad' : '') : fact('Cut-off', f.cy_cutoff ? `CY ${sh(f.cy_cutoff)}` : f.cfs_cutoff ? `CFS ${sh(f.cfs_cutoff)}` : '', f.si_cutoff ? `SI ${sh(f.si_cutoff)}` : '')}
                ${fact('Cargo', [tot('cartons') ? `${int(tot('cartons'))} ctns` : '', tot('cbm') ? `${n2(tot('cbm'))} m³` : ''].filter(Boolean).join(' · '), tot('gross_kg') ? `${int(Math.round(tot('gross_kg')))} kg` : '')}
                ${fact('Price', f.ocean_usd ? usd(f.ocean_usd) : r.freight ? usd(r.freight) : '', f.rate_valid ? `valid to ${sh(f.rate_valid)}` : '')}
              </div>
              <h3>Changes &amp; delays ${changes.length ? html`<span class="sub">${changes.length}</span>` : ''}</h3>
              ${changes.length ? html`<ul class="shp-chg">${changes.map((x) => html`<li><span class="sub">${sh(x.at)}</span><span><b>${x.what}</b> ${x.from} → <b>${x.to}</b>${x.d ? html` <span class="shp-f ${x.d > 0 ? 'amb' : 'grn'}">${x.d > 0 ? `+${x.d}` : x.d} day${Math.abs(x.d) === 1 ? '' : 's'}</span>` : ''}</span><span class="sub">${x.src}</span></li>`)}</ul>` : html`<p class="sub shp-none">No changes from the forwarder${dep.plan ? ' — on the planned sailing' : ''}.</p>`}`}
              <h3>What's in it</h3>
              <div class="table-wrap"><table class="list shp-t"><thead><tr><th>PO</th><th>SKU</th><th>Product</th><th class="r">Ctns</th><th class="r">Pcs</th><th class="r">m³</th><th>HTS</th>${r.stage === 'delivered' ? html`<th class="r">Received</th>` : ''}</tr></thead><tbody>
                ${r.lines.map((l) => { const h = htsOf(l); const rc = rec[l.id];
                  return html`<tr><td><a href="/admin/orders/view?supplier=${l.supplier_id}&po=${encodeURIComponent(l.po)}">${l.po}</a></td><td class="cu-mono">${l.sku || '—'}</td><td>${l.product || '—'}${l.split_no ? html` <em class="lp-chip-pt">part ${l.split_no}</em>` : ''}</td><td class="r">${l.cartons != null ? int(l.cartons) : '—'}</td><td class="r">${l.qty != null ? int(l.qty) : '—'}</td><td class="r">${l.cbm != null ? n2(l.cbm) : '—'}</td>
                    <td>${h ? html`<a class="cu-mono" href="/admin/logistics/customs?review=${h.entry}" title="Open the customs entry">${h.hts}</a>${h.rate != null ? html` <span class="sub">${h.rate}%</span>` : ''}` : html`<span class="sub">${prodHts(l) || '—'}</span>`}</td>
                    ${r.stage === 'delivered' ? html`<td class="r">${rc ? html`${rc.received}${rc.received < rc.shipped ? html` <span class="shp-f red">−${rc.shipped - rc.received}</span>` : ''}` : '—'}</td>` : ''}</tr>`; })}
              </tbody></table></div>
              <h3>Timeline</h3>
              ${ev.length ? html`<ul class="shp-tl">${ev.map(([d, i, t, s]) => html`<li><span class="sub">${sh(d)}</span><span>${i}</span><span><b>${t}</b>${s ? html` — ${s}` : ''}</span></li>`)}</ul>` : html`<p class="sub">Nothing yet.</p>`}
            </div>
            <div>
              <h3>Documents</h3>
              <div class="shp-docs3">${docs.map((d) => { const ok = d.files.length > 0 || !!d.okIf; return html`<div class="shp-dr ${ok ? 'ok' : ''}">
                <span class="shp-dr-i">${ok ? '✓' : ''}</span><span class="shp-dr-l">${d.l}</span>
                <span class="shp-dr-f">${d.files.length ? d.files.map((x) => html`<span class="shp-dr-x">${fileA(x, d.gallery ? `g-${r.id}` : null)}${x.rm ? html`<form method="post" action="${BASE}/${r.id}/doc/remove" class="inline" data-confirm="${`Delete ${x.name}? It's removed from the portal.`}"><input type="hidden" name="src" value="${x.rm.src}"><input type="hidden" name="ref" value="${x.rm.ref}"><input type="hidden" name="i" value="${x.rm.i ?? ''}"><button class="shp-dr-rm" title="Delete this file" aria-label="${`Delete ${x.name}`}">×</button></form>` : ''}</span>`) : html`<span class="sub">${ok ? (d.note || 'no file') : d.optional ? 'optional' : 'waiting'}</span>`}${d.files.length && d.note ? html`<span class="sub cu-mono">${d.note}</span>` : ''}</span>
              </div>${d.customs ? r.entries.map((e) => html`<a class="shp-cu" href="/admin/logistics/customs?review=${e.id}"><span><b class="cu-mono">${e.entry_no || 'Entry'}</b> · ${sh(e.entry_date || e.created_at)}${e.status === 'pending' ? html` <span class="shp-f amb">to review</span>` : ''} · duty ${usd(e.duty, 2)} + fees ${usd(e.fees, 2)}</span><span class="shp-cu-go">Customs record →</span></a>`) : ''}`; })}</div>
              <details class="shp-cost-d"><summary><b>Cost</b> <span class="sub">${cost ? usd(cost, 2) : 'nothing yet'}</span></summary>
              <table class="shp-ct"><tbody>
                <tr><td>Freight${r.forwarder ? ` (${r.forwarder})` : ''}</td><td class="r">${r.freight ? usd(r.freight, 2) : html`<span class="sub">—</span>`}</td></tr>
                <tr><td>Duty + MPF/HMF</td><td class="r">${r.duty ? usd(r.duty, 2) : html`<span class="sub">${r.kind === 'courier' ? '—' : 'when the 7501 is in'}</span>`}</td></tr>
                <tr><td>Delivery / drayage</td><td class="r">${r.drayage ? usd(r.drayage, 2) : html`<span class="sub">add when invoiced</span>`}</td></tr>
                <tr class="tot"><td>Total</td><td class="r">${usd(cost, 2)}</td></tr></tbody></table>
              ${r.c ? html`<form method="post" action="${BASE}/${r.id}/cost" class="shp-dray"><label>Delivery / drayage USD <input name="drayage" type="number" min="0" step="0.01" value="${r.drayage ?? ''}"></label><button class="btn ghost small">Save</button></form>` : ''}
              </details>
            </div>
          </div>
        </section>
        ${editable ? html`<dialog id="shp-deliver" class="rp-modal shp-dlg" aria-labelledby="shp-dt"><form method="post" action="${BASE}/${r.id}/delivered" enctype="multipart/form-data" class="lp-fd">
          <div class="rp-top"><h2 id="shp-dt">Delivered · ${r.title}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
          <div class="shp-g3"><label>Delivered on<input type="date" name="date" value="${today}" required></label><label>Received at<input name="to" value="${(r.c || r.sc).delivered_to || 'Lake Forest warehouse'}" list="shp-to"><datalist id="shp-to"><option>Lake Forest warehouse</option><option>3PL</option><option>Amazon FBA</option></datalist></label><label>Delivery receipt / POD<input type="file" name="file" multiple accept=".pdf,image/*"></label></div>
          <div class="table-wrap"><table class="list shp-t"><thead><tr><th>PO</th><th>SKU</th><th>Product</th><th class="r">Shipped</th><th class="r">Received</th></tr></thead><tbody>
            ${r.lines.map((l) => html`<tr><td>${l.po}</td><td class="cu-mono">${l.sku || '—'}</td><td>${l.product || '—'}</td><td class="r">${l.cartons != null ? `${l.cartons} ctns` : l.qty != null ? `${l.qty} pcs` : '—'}</td><td class="r"><input class="shp-in" type="number" min="0" name="r_${l.id}" value="${l.cartons ?? l.qty ?? ''}" aria-label="Received ${l.product || l.po}"></td></tr>`)}
          </tbody></table></div>
          <label class="shp-note">Note (damage, shortage)<input name="note" placeholder="e.g. 2 cartons SWS 001 missing — claim with the forwarder"></label>
          <div class="lp-fd-acts"><span class="sub">Closes the shipment; its PO lines become Received. A shortage stays on the PO and the supplier's record.</span><span class="r"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Mark delivered</button></span></div>
        </form></dialog>` : ''}`,
    }));
  }));

  async function store(files) {
    const out = [];
    for (const f of files) {
      if (!f.buffer?.length || f.buffer.length > 25 * 1024 * 1024) continue;
      const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
      const path = `deliveries/${new Date().toISOString().slice(0, 7)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
      const type = /\.pdf$/i.test(safe) ? 'application/pdf' : f.type && !/octet/.test(f.type) ? f.type : 'application/octet-stream';
      try { await db.docs.upload(path, f.buffer, type); out.push({ name: String(f.name || safe).slice(0, 200), path, type, size: f.buffer.length }); } catch (e) { console.error('Delivery file upload failed:', e.message); }
    }
    return out;
  }
  const target = (r) => (r.c ? ['plan_containers', r.c.id] : ['ship_confirmations', r.sc.id]);

  router.post(`${BASE}/:id/forwarder`, G(async (req, res) => {
    const { r } = await one(req.params.id); const { fields } = await parseForm(req);
    if (!r.c) throw new HttpError(400, 'Only for containers and LCL shipments');
    const name = String(fields.forwarder || '').trim().slice(0, 120);
    const known = (await db.list('forwarders').catch(() => [])).find((x) => x.company === name);
    if (!known) throw new HttpError(400, 'Choose a forwarder from the list');
    await db.update('plan_containers', { id: r.c.id }, { fwd: { ...(r.c.fwd || {}), forwarder: known.company, forwarder_id: known.id, updated_at: now() }, updated_at: now() });
    flash(res, 'ok', `Forwarder: ${known.company}`); res.redirect(`${BASE}/${r.id}`);
  }));

  // delete a wrong file (supplier document, forwarder attachment or delivery receipt); customs entries are kept
  router.post(`${BASE}/:id/doc/remove`, G(async (req, res) => {
    const { r } = await one(req.params.id); const { fields: x } = await parseForm(req);
    let name = '';
    if (x.src === 'plan') {
      const f = await db.get('plan_files', String(x.ref)).catch(() => null);
      const sc = f && r.scs.find((s) => s.id === f.shipment_id);
      if (!sc) throw new HttpError(404, 'File not found');
      await db.docs.remove([f.path]).catch(() => null); await db.remove('plan_files', { id: f.id }); name = f.name;
      const fresh = await db.get('ship_confirmations', sc.id); const { sailing } = await SD.factsOf(db, fresh);
      const missing = SD.missingKinds(SD.checklistOf(fresh, await SD.filesOf(db, fresh), sailing, SD.chinaNow().day));
      await db.update('ship_confirmations', { id: sc.id }, { missing, log: [...(fresh.log || []), { at: now(), text: `Removed ${f.name} (${by(req)})` }].slice(-60), updated_at: now() });
    } else if (x.src === 'fwd') {
      const u = await db.get('fwd_updates', String(x.ref)).catch(() => null);
      if (!u || !r.c || u.container_id !== r.c.id) throw new HttpError(404, 'File not found');
      const i = Number(x.i); const f = (u.files || [])[i]; if (!f) throw new HttpError(404, 'File not found');
      await db.docs.remove([f.path]).catch(() => null);
      await db.update('fwd_updates', { id: u.id }, { files: u.files.filter((_, k) => k !== i) }); name = f.name;
    } else if (x.src === 'delivery') {
      const [table, id] = target(r); const list = (r.c || r.sc).delivery_files || []; const i = Number(x.i); const f = list[i];
      if (!f) throw new HttpError(404, 'File not found');
      await db.docs.remove([f.path]).catch(() => null);
      await db.update(table, { id }, { delivery_files: list.filter((_, k) => k !== i), updated_at: now() }); name = f.name;
    } else throw new HttpError(400, 'This file can\'t be deleted here');
    flash(res, 'ok', `Deleted ${name}`); res.redirect(`${BASE}/${r.id}`);
  }));

  router.post(`${BASE}/:id/delivered`, G(async (req, res) => {
    const { r } = await one(req.params.id);
    const { fields, files } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const date = PL.isoDay(fields.date) || PL.today();
    const received = r.lines.map((l) => { const shipped = Number(l.cartons ?? l.qty) || 0; const v = fields[`r_${l.id}`]; const got = v === undefined || v === '' ? shipped : Math.max(0, Math.round(Number(v))); return { line_id: l.id, po: l.po, sku: l.sku || null, product: l.product || null, supplier_id: l.supplier_id, unit: l.cartons != null ? 'ctns' : 'pcs', shipped, received: got }; });
    const stored = await store(Object.values(files || {}).flat());
    const [table, id] = target(r);
    const prev = (r.c || r.sc).delivery_files || [];
    try {
      await db.update(table, { id }, { delivered_at: date, delivered_to: String(fields.to || '').slice(0, 120) || null, delivery_note: String(fields.note || '').slice(0, 1000) || null, received, delivery_files: [...prev, ...stored], delivered_by: by(req), updated_at: now() });
    } catch (e) { if (/delivered|received|delivery/i.test(e.message)) { flash(res, 'warn', 'Run the shipments SQL in Supabase first (supabase/schema.sql, "Shipments").'); return res.redirect(`${BASE}/${r.id}`); } throw e; }
    for (const x of received) await db.update('plan_orders', { id: x.line_id }, { shipped: true, received_at: date, received_qty: x.received, updated_at: now() }).catch(() => null);
    // shortages on the supplier's record
    const short = received.filter((x) => x.received < x.shipped);
    const bySup = {}; for (const x of short) (bySup[x.supplier_id] ||= []).push(x);
    for (const [sid, xs] of Object.entries(bySup)) await db.insert('supplier_activities', { supplier_id: sid, activity_date: date, type: 'Note', summary: `Shortage on delivery (${r.title}): ${xs.map((x) => `PO ${x.po}${x.sku ? ` ${x.sku}` : ''} −${x.shipped - x.received} ${x.unit}`).join('; ')}${fields.note ? ` — ${String(fields.note).slice(0, 300)}` : ''}`, done: false }).catch(() => null);
    flash(res, 'ok', short.length ? `Delivered — ${short.length} line${short.length > 1 ? 's' : ''} short, noted on the supplier.` : 'Delivered — received in full.');
    res.redirect(`${BASE}/${r.id}`);
  }));
  router.post(`${BASE}/:id/reopen`, G(async (req, res) => {
    const { r } = await one(req.params.id);
    const [table, id] = target(r);
    await db.update(table, { id }, { delivered_at: null, updated_at: now() });
    for (const l of r.lines) await db.update('plan_orders', { id: l.id }, { received_at: null, updated_at: now() }).catch(() => null);
    flash(res, 'ok', 'Reopened.'); res.redirect(`${BASE}/${r.id}`);
  }));
  router.post(`${BASE}/:id/cost`, G(async (req, res) => {
    const { r } = await one(req.params.id);
    const { fields } = await parseForm(req);
    const v = fields.drayage === '' ? null : Number(fields.drayage);
    if (r.c) await db.update('plan_containers', { id: r.c.id }, { drayage_usd: Number.isFinite(v) ? v : null, updated_at: now() }).catch((e) => { throw new HttpError(400, /drayage/.test(e.message) ? 'Run the shipments SQL in Supabase first.' : e.message); });
    flash(res, 'ok', 'Saved.'); res.redirect(`${BASE}/${r.id}`);
  }));
  router.get(`${BASE}/:id/file/:i`, G(async (req, res) => {
    const { r } = await one(req.params.id);
    const f = ((r.c || r.sc).delivery_files || [])[Number(req.params.i)]; if (!f) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(f.path);
    const type = f.type || 'application/octet-stream';
    const inline = req.query.inline === '1' && /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(type);
    const head = { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    res.writeHead(200, head); res.end(buf);
  }));
};
module.exports.load = load;
module.exports.STAGE_TAG = STAGE_TAG;
