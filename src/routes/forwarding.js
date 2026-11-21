'use strict';
// Forwarder shipment data on the PO page, Shipping documents (review + unmatched) and Load containers.

const { html, raw } = require('../lib/html');
const { parseForm, flash, HttpError } = require('../lib/http');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const FW = require('../forwarding');
const AI = require('../ai');

const BASE = '/admin/orders/shipping/fwd';
const portName = (c) => SC.PORT[c]?.name || c || '';
const BOXN = { '20GP': "20' GP", '40GP': "40' GP", '40HQ': "40' HQ", LCL: 'LCL' };
const sd = (ts) => (ts ? PL.short(String(ts).slice(0, 10)) : '');
const missingTable = (e) => /fwd_updates|fwd\b|PGRST20[45]|relation|column/i.test(e?.message || '');
const cName = (c) => (c ? require('../shipname').shipName(c) : '');
const fmtCont = (v) => (/^[A-Z]{4}\d{7}$/.test(v || '') ? `${v.slice(0, 4)} ${v.slice(4)}` : v || '');

/** Containers numbered per port (same numbers as Load containers). */
async function numbered(db) {
  const all = await db.list('plan_containers', { order: 'created_at.asc' }).catch(() => []);
  const n = {}; const out = {};
  for (const c of all) { n[c.port] = (n[c.port] || 0) + 1; out[c.id] = { ...c, no: n[c.port] }; }
  return out;
}
async function pending(db, filters = {}) {
  try { return { rows: await db.list('fwd_updates', { filters: { status: 'pending', ...filters }, order: 'created_at.asc' }) }; }
  catch (e) { if (missingTable(e)) return { rows: [], missing: true }; throw e; }
}

/** Voyage line: POL ──🚢── POD, position by today between ETD and ETA. */
function voyage(c, fwd = c?.fwd || {}) {
  if (!fwd.etd && !fwd.eta) return '';
  const day = PL.today();
  const st = FW.stageOf(fwd, day);
  const a = Date.parse(fwd.atd || fwd.etd); const b = Date.parse(fwd.ata || fwd.eta);
  const pct = st === 'arrived' ? 100 : st === 'booked' || !a || !b ? 0 : Math.max(4, Math.min(96, Math.round((Date.parse(day) - a) / Math.max(1, b - a) * 100)));
  return html`<div class="fw-voy"><b>${fwd.pol || portName(c?.port)}</b><span class="sub">${fwd.atd || fwd.etd ? PL.short(fwd.atd || fwd.etd) : ''}</span>
    <div class="fw-bar" role="img" aria-label="${pct}% of the voyage"><i style="width:${pct}%"></i><em style="left:${pct}%">🚢</em></div>
    <b>${fwd.pod || '—'}</b><span class="sub fw-eta">${fwd.ata ? `arrived ${PL.short(fwd.ata)}` : fwd.eta ? `ETA ${PL.short(fwd.eta)}` : ''}</span></div>`;
}

/** Facts grid + sources + drop strip, for the Shipment card on the PO page. */
async function fwdBox(db, containerId, back, { supplierBl = null } = {}) {
  const cs = await numbered(db);
  const c = cs[containerId]; if (!c) return '';
  await FW.settle(db, [c]);
  const fwd = c.fwd || {};
  const { rows: waiting, missing } = await pending(db, { container_id: c.id });
  if (missing) return html`<p class="flash warn">Run the forwarder SQL in Supabase first (supabase/schema.sql, "Forwarder shipment data").</p>`;
  const has = FIELDS_SHOWN.some((k) => fwd[k]);
  const st = FW.stageOf(fwd);
  const fact = (label, v, small, cls = '') => html`<div class="fw-f ${cls}"><span>${label}</span><b>${v || raw('<i class="fw-none">—</i>')}</b>${small ? html`<small>${small}</small>` : ''}</div>`;
  // for LCL the supplier's B/L is normally the forwarder's house B/L: show it when the forwarder's update has none
  const sBl = supplierBl ? String(supplierBl).replace(/\s/g, '').toUpperCase() : null;
  const hbl = fwd.hbl_no || sBl;
  const hblNote = !sBl ? '' : !fwd.hbl_no ? "from the supplier's B/L" : sBl === fwd.hbl_no ? "matches the supplier's B/L ✓" : `supplier's B/L: ${sBl} — different`;
  const docs = [...(fwd.docs || [])].reverse();
  const track = FW.trackUrl(fwd);
  const one = !has && !waiting.length && !docs.length && !track;   // nothing yet: one line, not an empty panel
  return html`<div class="fw ${one ? 'fw-one' : ''}" id="forwarder">
    <div class="fw-h"><b>Forwarder${fwd.forwarder ? ` · ${fwd.forwarder}` : ''}</b><span class="sub">${fwd.updated_at ? `last update ${sd(fwd.updated_at)}` : 'no data yet'}</span></div>

    ${has ? html`<div class="fw-facts">
      ${fact('House B/L', hbl, hblNote, fwd.hbl_no && sBl && sBl !== fwd.hbl_no ? 'chg' : '')}
      ${fact('Master B/L', fwd.mbl_no, fwd.booking_no ? `booking ${fwd.booking_no}` : '')}
      ${fact('Container', fmtCont(fwd.container_no || c.container_no), [fwd.container_type, c.box === 'LCL' ? 'shared' : ''].filter(Boolean).join(' · '))}
      ${fact('Vessel / voyage', [fwd.vessel, fwd.voyage].filter(Boolean).join(' '), '')}
      ${fact(st === 'booked' || !st ? 'ETD' : 'Sailed', fwd.atd ? PL.short(fwd.atd) : fwd.etd ? PL.short(fwd.etd) : '', [fwd.pol, st === 'booked' && fwd.cfs_cutoff ? `cut-off ${PL.short(fwd.cfs_cutoff)}` : ''].filter(Boolean).join(' · '))}
      ${fact('ETA', fwd.eta ? PL.short(fwd.eta) : '', fwd.eta_prev ? `was ${PL.short(fwd.eta_prev)} · updated ${sd(fwd.eta_changed_at)}` : '', `hl${fwd.eta_prev ? ' chg' : ''}`)}
      ${fact('Discharge', fwd.pod, '')}
      ${fact('Arrival', fwd.ata ? PL.short(fwd.ata) : fwd.arrived ? 'notice received' : '', '')}
    </div>
    ${voyage(c, fwd)}` : ''}
    ${docs.length || track ? html`<div class="fw-src">${docs.length ? 'Sources:' : ''} ${docs.map((d) => html`<span class="fw-chip">${FW.DOC_TYPES[d.type] || 'Document'} · ${sd(d.at)}</span>`)}${track ? html`<a href="${track}" target="_blank" rel="noopener" class="fw-track">Track ${fwd.container_no ? 'container' : 'B/L'} ↗</a>` : ''}</div>` : ''}
    ${fwdActions(c, fwd, waiting.length, (await logOf(db, c.id).catch(() => [])).length, waiting[0]?.id)}
  </div>`;
}
/** Buttons that open the forwarder check window (public/app.js FwdCheck): new update, ones waiting for review, the log. */
function fwdActions(c, fwd, nReview = 0, nLog = 0, firstReview = null) {
  const name = require('../shipname').shipName(c);
  const sub = [c.box === 'LCL' ? 'LCL' : c.box, fwd?.forwarder].filter(Boolean).join(' · ');
  return html`<div class="fw-acts">
    <button type="button" class="btn ghost small" data-fwc="${c.id}" data-fwc-name="${name}" data-fwc-sub="${sub}" title="Paste or drop an email, PDF or screenshot from the forwarder — AI compares it with this shipment">＋ Forwarder update</button>
    ${nReview ? html`<button type="button" class="btn small" data-fwc="${c.id}" data-fwc-rev="${firstReview}" data-fwc-name="${name}" data-fwc-sub="${sub}">${nReview} update${nReview > 1 ? 's' : ''} to review</button>` : ''}
    ${nLog ? html`<button type="button" class="link small" data-fwc="${c.id}" data-fwc-log data-fwc-name="${name}" data-fwc-sub="${sub}">Log (${nLog})</button>` : ''}
  </div>`;
}
const FIELDS_SHOWN = ['hbl_no', 'mbl_no', 'container_no', 'vessel', 'etd', 'eta', 'pod', 'booking_no', 'forwarder'];

function dropForm(action, back, compact) {
  return html`<form method="post" action="${action}" enctype="multipart/form-data" class="fw-drop" data-fwd-drop data-busy>
    <input type="hidden" name="back" value="${back}">
    <input type="file" name="file" multiple hidden data-fwd-file accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.csv,image/*,application/pdf">
    <div class="fw-dz" data-fwd-zone tabindex="0"><span>✦</span><span>${compact ? html`<b>More from the forwarder?</b>` : html`<b>Got something from the forwarder?</b>`} Paste a screenshot (⌘V), drop a PDF or <button type="button" class="link small" data-fwd-choose>choose a file</button>${AI.enabled() ? ' — AI reads it.' : '.'}</span>
      <button type="button" class="link small fw-txt-open" data-fwd-txtopen>Paste text</button></div>
    <div class="fw-txt" data-fwd-txt hidden><textarea name="text" rows="4" placeholder="Paste the forwarder's email or message…" aria-label="Forwarder message"></textarea><button class="btn small">Read</button></div>
  </form>`;
}

/** Review form for one pending update. With no container (unmatched) a shipment must be chosen. */
function reviewForm(u, cs, back, { choose = false } = {}) {
  const c = u.container_id ? cs[u.container_id] : null;
  const facts = u.facts || {};
  const rows = FW.diff(c, facts);
  const live = Object.values(cs).filter((x) => !x.record_only);
  const open = live.filter((x) => x.status !== 'planned' || x.fwd).concat(live.filter((x) => x.status === 'planned' && !x.fwd));
  const files = (u.files || []).map((f, i) => ({ ...f, url: `${BASE}/${u.id}/files/${i}` }));
  const willShip = ['shipping_advice', 'bill_of_lading'].includes(facts.doc_type) || facts.atd;
  return html`<form method="post" action="${BASE}/${u.id}/accept" class="fw-rv" id="fwd-${u.id}">
    <input type="hidden" name="back" value="${back}">
    <div class="fw-rv-h"><b>${FW.DOC_TYPES[facts.doc_type] || 'Forwarder update'} <span class="cp-tag wait">To review</span></b>
      <span class="sub">${[u.from_email ? `From ${u.from_email}` : u.source === 'upload' ? 'Added by you' : '', sd(u.created_at), u.subject ? `“${u.subject}”` : ''].filter(Boolean).join(' · ')}</span></div>
    ${c && !choose ? html`<div class="fw-match">✓ ${u.match_reason === 'added on this shipment' ? 'Added on' : 'Matched to'} <b>${cName(c)}</b>${u.match_reason && u.match_reason !== 'added on this shipment' ? html` by ${u.match_reason}` : ''}</div>`
      : html`<label class="fw-pick"><span>Shipment</span><select name="container" required><option value="">Choose the container / LCL shipment…</option>${open.map((x) => html`<option value="${x.id}" ${x.id === u.container_id ? raw('selected') : ''}>${cName(x)}${x.fwd?.hbl_no ? ` · HBL ${x.fwd.hbl_no}` : ''}${x.status === 'shipped' ? ' · shipped' : ''}</option>`)}</select></label>`}
    ${facts.summary ? html`<p class="fw-sum">${facts.summary}</p>` : ''}
    ${rows.length ? html`<table class="fw-tbl"><thead><tr><th>Field</th><th>Read from the document</th><th></th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td>${r.label}</td><td><input name="v_${r.key}" value="${r.value}" ${r.date ? raw('type="date"') : ''} aria-label="${r.label}">${r.state === 'changed' ? html` <span class="fw-was">was ${r.date ? PL.short(r.old) : r.old}</span>` : ''}</td><td>${r.state === 'new' ? html`<span class="fw-new">NEW</span>` : r.state === 'changed' ? html`<span class="fw-chg">CHANGED</span>` : html`<span class="sub">same</span>`}</td></tr>`)}
    </tbody></table>` : html`<p class="sub">${AI.enabled() ? 'Nothing readable found — open the file and dismiss it, or add what it says below.' : 'AI is off — open the file and enter what it says.'}</p>`}
    ${!rows.length ? html`<div class="fw-manual">${[['eta', 'ETA', 'date'], ['etd', 'ETD', 'date'], ['hbl_no', 'House B/L'], ['container_no', 'Container']].map(([k, l, t]) => html`<label><span>${l}</span><input name="v_${k}" ${t ? raw(`type="${t}"`) : ''}></label>`)}</div>` : ''}
    ${files.length ? html`<div class="fw-src">${files.map((f) => html`<a class="fw-chip" href="${f.url}?inline=1" ${/pdf|image/.test(f.type || '') ? raw(`data-preview="${f.url}?inline=1" data-type="${/image/.test(f.type) ? 'image' : 'doc'}" data-dl="${f.url}"`) : raw('target="_blank" rel="noopener"')}>📄 ${f.name}</a>`)}</div>` : ''}
    ${u.text ? html`<details class="sd-orig"><summary>Original message</summary><pre>${String(u.text).slice(0, 6000)}</pre></details>` : ''}
    <div class="fw-acts"><button class="btn small">Accept &amp; save</button>
      <details class="dd fw-not" data-dd><summary class="btn ghost small">${c && !choose ? 'Not this shipment' : 'Other options'} <span class="dd-car" aria-hidden="true">▾</span></summary><div class="dd-menu fw-not-m">
        ${c && !choose ? html`<button formaction="${BASE}/${u.id}/detach" formnovalidate><b>Attach to another shipment…</b><small>moves it to Unmatched, where you pick the shipment</small></button>` : ''}
        <button type="button" class="rec" data-open-dialog="${`rec-u-${u.id}`}"><b>✦ Save as record only</b><small>keep duty, costs, dates and POs — no tracking, not in active shipments</small></button></div></details>
      <button class="link small" formaction="${BASE}/${u.id}/dismiss" formnovalidate>Dismiss</button>
      <span class="sub fw-hint">${willShip ? 'Accepting marks it sailed — the container and its POs become shipped.' : facts.doc_type === 'arrival_notice' ? 'Accepting marks it arrived.' : ''}</span></div>
  </form>
  <dialog id="${`rec-u-${u.id}`}" class="rp-modal rf-dlg" aria-labelledby="${`rec-u-t-${u.id}`}"><form method="post" action="${BASE}/${u.id}/record" data-busy>
    <input type="hidden" name="back" value="${back}">
    <div class="rp-top"><h2 id="${`rec-u-t-${u.id}`}">Save as record only</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
    <p class="sub">Filled in from the document — check and save. The record keeps the numbers and this document; it isn't tracked and stays out of active shipments.</p>
    ${require('../views/record-form').recordFields(require('../records').fromUpdate(u), { customs: facts.doc_type === 'customs_entry', id: u.id })}
    <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save record</button></div></form></dialog>`;
}

/** Shipping documents page: forwarder updates waiting for you (matched and unmatched). */
async function fwdSection(db, back = '/admin/orders/shipping') {
  const { rows, missing } = await pending(db);
  if (missing) return html`<section class="card" id="forwarder"><h2>Forwarder updates</h2><p class="flash warn">Run the forwarder SQL in Supabase first (supabase/schema.sql, "Forwarder shipment data").</p></section>`;
  const cs = await numbered(db);
  const arriving = Object.values(cs).filter((c) => c.fwd?.eta && !c.fwd.ata && !c.fwd.arrived && c.fwd.eta <= PL.addDays(PL.today(), 7) && FW.stageOf(c.fwd) !== 'booked').sort((a, b) => a.fwd.eta.localeCompare(b.fwd.eta));
  const matched = rows.filter((u) => u.container_id && cs[u.container_id]);
  const unmatched = rows.filter((u) => !u.container_id || !cs[u.container_id]);
  return html`<section class="card" id="forwarder"><div class="head-row"><h2>Forwarder updates</h2><span class="sub">Forward or CC forwarder emails to <b>${FW.shipmentsAddress()}</b></span></div>
    ${!rows.length && !arriving.length ? html`<p class="muted">Nothing to review. Booking confirmations, shipping advice, ETA changes and arrival notices show up here.</p>` : ''}
    ${matched.map((u) => reviewForm(u, cs, `${back}#forwarder`))}
    ${unmatched.length ? html`<h3 class="sd-h">Unmatched <span class="sub">couldn't tell which shipment — attach it</span></h3>${unmatched.map((u) => reviewForm(u, cs, `${back}#forwarder`, { choose: true }))}` : ''}
    ${arriving.length ? html`<h3 class="sd-h">Arriving this week</h3><ul class="fw-arr">${arriving.map((c) => html`<li><a href="/admin/logistics/planning/load?port=${c.port}#c-${c.id}"><b>${cName(c)}</b></a><span>${c.fwd.pod || ''}</span><span class="fw-eta">ETA ${PL.short(c.fwd.eta)}</span>${c.fwd.hbl_no ? html`<span class="sub">HBL ${c.fwd.hbl_no}</span>` : ''}</li>`)}</ul>` : ''}
    ${dropForm(`${BASE}/new`, `${back}#forwarder`, false)}
  </section>`;
}

/** "On the water" list for Load containers: shipped containers of this port that have not arrived. */
async function onTheWater(db, port) {
  const cs = Object.values(await numbered(db)).filter((c) => c.port === port && c.status === 'shipped' && !(c.fwd?.ata || c.fwd?.arrived));
  if (!cs.length) return '';
  const lines = await db.list('plan_orders').catch(() => []);
  return html`<section class="card fw-otw"><div class="rh-head"><h2 class="sec">On the water <span class="sub">${cs.length}</span></h2><a class="link small" href="/admin/orders/shipments">All shipments →</a></div>
    ${cs.map((c) => { const ls = lines.filter((l) => l.container_id === c.id); const pos = [...new Map(ls.map((l) => [`${l.supplier_id}|${PL.normPo(l.po)}`, l])).values()]; const f = c.fwd || {};
      return html`<div class="fw-otw-c" id="c-${c.id}"><div class="fw-otw-h"><b>${cName(c)}</b> <span class="cp-tag ${FW.stageOf(f) === 'arrived_due' ? 'wait' : 'plan'}">${FW.stageLabel(FW.stageOf(f)) || 'Shipped'}</span>
        <span class="sub">${[f.forwarder, f.hbl_no ? `HBL ${f.hbl_no}` : '', f.container_no ? fmtCont(f.container_no) : '', [f.vessel, f.voyage].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</span></div>
        ${voyage(c, f) || html`<p class="sub">No forwarder data yet — forward their shipping advice to ${FW.shipmentsAddress()}.</p>`}
        <div class="fw-otw-pos">${pos.map((l) => html`<a class="lp-polink" href="/admin/orders/view?supplier=${l.supplier_id}&po=${encodeURIComponent(l.po)}#shipment">${l.po}</a>`)}${FW.trackUrl(f) ? html`<a href="${FW.trackUrl(f)}" target="_blank" rel="noopener" class="fw-track">Track ↗</a>` : ''}</div></div>`; })}
  </section>`;
}

/** Small summary for the Load containers data. */
function summary(c) {
  const f = c.fwd; if (!f) return null;
  const cut = c.box === 'LCL' ? f.cfs_cutoff || f.cy_cutoff : f.cy_cutoff || f.cfs_cutoff;
  return { booking: f.booking_no || '', carrier: f.carrier || '', cut: cut ? PL.short(cut) : '', cutName: c.box === 'LCL' ? 'CFS cut-off' : 'CY cut-off', si: f.si_cutoff ? PL.short(f.si_cutoff) : '', transit: f.transit || '', price: f.ocean_usd ? `$${Number(f.ocean_usd).toLocaleString('en-US')}` : '',
    forwarder: f.forwarder || '', hbl: f.hbl_no || '', mbl: f.mbl_no || '', no: fmtCont(f.container_no || ''), vessel: [f.vessel, f.voyage].filter(Boolean).join(' '), pol: f.pol || '', pod: f.pod || '', etd: f.atd || f.etd || '', eta: f.ata || f.eta || '', etdText: f.atd || f.etd ? PL.short(f.atd || f.etd) : '', etaText: f.ata || f.eta ? PL.short(f.ata || f.eta) : '', etaPrev: f.eta_prev ? PL.short(f.eta_prev) : '', stage: FW.stageOf(f) || '', track: FW.trackUrl(f) || '',
    cutDay: cut ? String(cut).slice(0, 10) : '', etdDay: f.etd ? String(f.etd).slice(0, 10) : '', confirmed: f.confirmed || null };
}

/** Display text for a field value. */
function show(key, v) {
  if (v == null || v === '') return '';
  if (FW.DATES.includes(key) || key === 'loading_date') return PL.short(String(v).slice(0, 10));
  if (key === 'ocean_usd') return `$${Number(v).toLocaleString('en-US')}`;
  if (key === 'container_no') return fmtCont(v);
  return String(v);
}

/** Everything the check dialog shows for one update. */
async function checkView(db, u) {
  const BOX = require('./loadplan').BOX;
  const cs = await numbered(db);
  const c = u.container_id ? cs[u.container_id] : null;
  const facts = u.facts || {};
  const base = { id: u.id, status: u.status, type: FW.DOC_TYPES[facts.doc_type] || 'Forwarder update', summary: facts.summary || '', from: u.from_email || '', subject: u.subject || '', at: PL.short(String(u.created_at || '').slice(0, 10)),
    files: (u.files || []).map((f, i) => ({ name: f.name, url: `${BASE}/${u.id}/files/${i}`, inline: /pdf|image/.test(f.type || '') })), text: u.text ? String(u.text).slice(0, 6000) : '', forwarder: facts.forwarder || '' };
  if (!c) return { ...base, container: null, rows: [], alerts: [], read: !!facts.summary };
  const ctx = await FW.context(db, c);
  const rows = FW.diff(c, facts, ctx).map((r) => ({ key: r.key, label: r.label, old: show(r.key, r.old), value: show(r.key, r.value), raw: r.value, state: r.state, tick: r.tick, note: r.note || '' }));
  const alerts = FW.checks(c, facts, ctx, { box: BOX });
  return { ...base, container: { id: c.id, name: cName(c), box: c.box }, rows, alerts, read: rows.length > 0 || alerts.length > 0 || !!facts.summary };
}

/** Container log: updates you accepted or kept. */
async function logOf(db, cid) {
  const us = (await db.list('fwd_updates', { filters: { container_id: cid }, order: 'created_at.desc' }).catch(() => [])).filter((u) => ['accepted', 'logged'].includes(u.status));
  return us.map((u) => ({
    id: u.id, at: PL.short(String(u.decided_at || u.created_at || '').slice(0, 10)), type: FW.DOC_TYPES[u.facts?.doc_type] || 'Forwarder update', status: u.status,
    changes: (u.applied || []).map((a) => `${a.label}${a.from ? ` ${show(a.key, a.from)} →` : ''} ${show(a.key, a.to)}`),
    summary: u.facts?.summary || '', how: u.source === 'upload' ? `Added by ${u.created_by || 'you'}` : u.from_email ? `Email from ${u.from_email}` : 'Email',
    files: (u.files || []).map((f, i) => ({ name: f.name, url: `${BASE}/${u.id}/files/${i}`, inline: /pdf|image/.test(f.type || '') })), text: u.text ? String(u.text).slice(0, 6000) : '',
  }));
}

function routes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const backOf = (f, d = '/admin/orders/shipping#forwarder') => (String(f.back || '').startsWith('/admin/') ? f.back : d);
  const getU = async (id) => { const u = await db.get('fwd_updates', id).catch(() => null); if (!u) throw new HttpError(404, 'Forwarder update not found'); return u; };
  const files = (f) => Object.values(f || {}).flat().filter((x) => x && x.buffer?.length);
  const add = async (req, res, containerId) => {
    const { fields, files: fs } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const list = files(fs); const text = String(fields.text || '').trim();
    if (!list.length && !text) { flash(res, 'warn', 'Paste a screenshot, drop a file or paste the message first.'); return res.redirect(backOf(fields)); }
    try {
      const u = await FW.createUpdate(db, config, { source: 'upload', text, files: list, containerId, by: by(req), notify: false });
      flash(res, 'ok', u.container_id ? 'Read — check the values and accept.' : 'Read, but no shipment matched — choose one below.');
      const back = backOf(fields);
      return res.redirect(`${back.split('#')[0]}#fwd-${u.id}`);
    } catch (e) { if (missingTable(e)) { flash(res, 'warn', 'Run the forwarder SQL in Supabase first.'); return res.redirect(backOf(fields)); } throw e; }
  };
  router.post(`${BASE}/container/:cid`, G(async (req, res) => {
    const c = await db.get('plan_containers', req.params.cid).catch(() => null); if (!c) throw new HttpError(404, 'Container not found');
    return add(req, res, c.id);
  }));
  router.post(`${BASE}/new`, G(async (req, res) => add(req, res, null)));

  // JSON for the check dialog on Load containers
  const J = (fn) => G(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req, res)) }); }
    catch (e) { res.json({ ok: false, error: missingTable(e) ? 'Run the forwarder SQL in Supabase first.' : e.message }, e.status || 400); }
  });
  router.post(`${BASE}/check`, J(async (req) => {
    const { fields, files: fs } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const c = await db.get('plan_containers', String(fields.container || '')).catch(() => null);
    if (!c) throw new HttpError(404, 'Container not found');
    const list = files(fs); const text = String(fields.text || '').trim();
    if (!list.length && !text) throw new HttpError(400, 'Paste the email or drop a file first');
    const u = await FW.createUpdate(db, config, { source: 'upload', text, files: list, containerId: c.id, by: by(req), notify: false });
    // a customs entry summary goes to Customs instead
    if (u.facts?.doc_type === 'customs_entry') {
      await db.remove('fwd_updates', { id: u.id }).catch(() => null);
      for (const f of u.files || []) await db.docs.remove(f.path).catch(() => null);
      const e = await require('../customs').createEntry(db, config, { files: list, text, source: 'upload', containerId: c.id, by: by(req) });
      return { customs: e.id };
    }
    return { view: await checkView(db, u) };
  }));
  router.get(`${BASE}/:id/view`, J(async (req) => ({ view: await checkView(db, await getU(req.params.id)) })));
  router.post(`${BASE}/:id/apply`, J(async (req) => {
    const { fields: f } = await parseForm(req);
    const u = await getU(req.params.id);
    const only = String(f.only || '').split(',').map((x) => x.trim()).filter(Boolean);
    const view = await checkView(db, u);
    const values = { _only: only };
    for (const r of view.rows) if (only.includes(r.key)) values[r.key] = r.raw;
    const out = await FW.accept(db, config, u, { values, by: by(req) });
    const c = out.container;
    return { applied: out.applied.length, container: { id: c.id, status: c.status, loading: c.loading_date ? String(c.loading_date).slice(0, 10) : '', containerNo: c.container_no || '', fwd: summary(c) }, log: (await logOf(db, c.id)).length };
  }));
  router.post(`${BASE}/:id/logonly`, J(async (req) => {
    const u = await getU(req.params.id);
    await FW.logOnly(db, u, { by: by(req) });
    return { log: (await logOf(db, u.container_id)).length };
  }));
  router.post(`${BASE}/:id/discard`, J(async (req) => { await FW.dismiss(db, await getU(req.params.id), by(req)); return {}; }));
  router.get(`${BASE}/container/:cid/log`, J(async (req) => ({ log: await logOf(db, req.params.cid) })));

  router.post(`${BASE}/:id/accept`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    const u = await getU(req.params.id);
    const values = {};
    for (const [k] of FW.FIELDS) if (fields[`v_${k}`] !== undefined && String(fields[`v_${k}`]).trim() !== '') values[k] = String(fields[`v_${k}`]).trim();
    try {
      const out = await FW.accept(db, config, u, { values, containerId: fields.container || null, by: by(req) });
      flash(res, 'ok', `Saved${out.stage ? ` — ${FW.stageLabel(out.stage).toLowerCase()}` : ''}${out.slip > 2 ? ` · ETA moved ${out.slip} days` : ''}.`);
    } catch (e) { if (e.status === 400) flash(res, 'warn', e.message); else throw e; }
    res.redirect(backOf(fields));
  }));
  router.post(`${BASE}/:id/dismiss`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    await FW.dismiss(db, await getU(req.params.id), by(req));
    flash(res, 'ok', 'Dismissed.'); res.redirect(backOf(fields));
  }));
  // "Save as record only": a record-only shipment holding this document (a 7501 also goes to Customs, linked to it)
  router.post(`${BASE}/:id/record`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    const u = await getU(req.params.id);
    const REC = require('../records');
    const near = u.container_id ? await db.get('plan_containers', u.container_id).catch(() => null) : null;
    let rec;
    try { rec = await REC.create(db, { ...fields, mark_shipped: fields.mark_shipped === '1', port: near?.port || 'CNYTN', fwd: (() => { const fx = FW.portFix(u.facts || {}); return Object.fromEntries(['forwarder', 'carrier', 'vessel', 'voyage', 'hbl_no', 'mbl_no', 'booking_no', 'pol', 'pod'].filter((k) => fx[k]).map((k) => [k, fx[k]])); })() }, { by: by(req) }); }
    catch (e) { if (/record_only|record\b|column/i.test(e.message)) { flash(res, 'error', 'Run supabase/records.sql in Supabase → SQL Editor first.'); return res.redirect(backOf(fields)); } throw e; }
    await db.update('fwd_updates', { id: u.id }, { container_id: rec.id, match_reason: 'saved as a record', status: 'logged', decided_by: by(req), decided_at: new Date().toISOString() });
    let note = '';
    if (u.facts?.doc_type === 'customs_entry') {
      try {
        const files = []; for (const f of u.files || []) files.push({ name: f.name, type: f.type, buffer: await db.docs.download(f.path) });
        await require('../customs').createEntry(db, config, { files, text: u.text || '', source: 'upload', containerId: rec.id, by: by(req) });
        note = ' — the 7501 is in Customs to review; its duty counts on the record once saved';
      } catch (e) { note = ` — the 7501 couldn't be read into Customs (${String(e.message).slice(0, 80)})`; }
    }
    flash(res, 'ok', `Saved as a record${note}.`);
    res.redirect(`/admin/orders/shipments/${rec.id}`);
  }));
  router.post(`${BASE}/:id/detach`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    const u = await getU(req.params.id);
    await db.update('fwd_updates', { id: u.id }, { container_id: null, match_reason: null });
    flash(res, 'ok', 'Moved to Unmatched on Shipping documents — attach it to the right shipment there.');
    res.redirect(backOf(fields));
  }));
  router.get(`${BASE}/:id/files/:i`, G(async (req, res) => {
    const u = await getU(req.params.id);
    const f = (u.files || [])[Number(req.params.i)]; if (!f) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(f.path);
    const type = f.type || 'application/octet-stream';
    const inline = req.query.inline === '1' && /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(type);
    const head = { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    res.writeHead(200, head); res.end(buf);
  }));
}

module.exports = routes;
Object.assign(module.exports, { fwdActions, checkView, logOf, fwdBox, fwdSection, onTheWater, summary, voyage, pending, numbered, BASE });
