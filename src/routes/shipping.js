'use strict';
// Orders → Shipping documents: shipment confirmations per supplier, the supplier upload page (/ship/:token),
// and the Shipment section on the PO page.

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const SD = require('../shipdocs');
const AI = require('../ai');

const BASE = '/admin/orders/shipping';
const portName = (c) => SC.PORT[c]?.name || c || '';
const n2 = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
const int = (v) => Number(v || 0).toLocaleString('en-US');
const poUrl = (sid, po) => `/admin/orders/view?supplier=${encodeURIComponent(sid)}&po=${encodeURIComponent(po)}`;
const missingTable = (e) => /ship_confirmations|shipment_id|loading_date|PGRST20[45]|relation|column/i.test(e?.message || '');
const BOXN = { '20GP': "20' GP", '40GP': "40' GP", '40HQ': "40' HQ", LCL: 'LCL' };
const SHORT = { Invoice: 'CI', 'Packing list': 'PL', 'Loading photos': 'Photos', 'Bill of lading': 'B/L', 'Warehouse receipt': 'FCR' };
const sd = (ts) => (ts ? PL.short(String(ts).slice(0, 10)) : '');
const fileIcon = (f) => (/pdf/.test(f.content_type) ? 'PDF' : /image/.test(f.content_type) ? 'IMG' : /sheet|excel|csv/.test(f.content_type) ? 'XLS' : /word/.test(f.content_type) ? 'DOC' : 'FILE');

/** Shipment label: "Yantian · Container 2 · 40' HQ" */
function shipLabel(sc, cs) {
  const c = sc.container_id && cs[sc.container_id];
  if (!c) return 'No container plan';
  return `${portName(c.port)} · ${c.box === 'LCL' ? 'LCL shipment' : 'Container'} ${c.no || ''}${c.box === 'LCL' ? '' : ` · ${BOXN[c.box] || c.box}`}`;
}

/** Containers numbered per port (same numbers as Load containers). */
async function containersById(db) {
  const all = await db.list('plan_containers', { order: 'created_at.asc' }).catch(() => []);
  const n = {}; const out = {};
  for (const c of all) { n[c.port] = (n[c.port] || 0) + 1; out[c.id] = { ...c, no: n[c.port] }; }
  return out;
}

const docsOf = (files, sc) => files.filter((f) => f.shipment_id === sc.id);
const DOCTAG = { have: ['ok', 'Received'], miss: ['done', 'Missing'], later: ['done', 'Later'], opt: ['done', 'Optional'] };

/** Differences between planned and actual, for the review table. */
function compareRows(sc) {
  const facts = sc.facts || {};
  const pairs = SD.matchLines(sc.planned || [], facts);
  const pct = (a, p) => (a != null && p ? (a - p) / p : null);
  const rows = [];
  const sum = (side, k) => { const xs = pairs.map((x) => x[side]?.[k]).filter((v) => v != null); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const add = (label, p, a, unit, fmtv) => {
    const d = pct(a, p);
    const diff = a == null ? { t: '—', c: '' } : p == null ? { t: 'new', c: 'okc' } : Math.abs(d) < 0.02 ? { t: '✓', c: 'okc' } : { t: `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%`, c: 'warnc' };
    rows.push({ label, p: p == null ? '—' : `${fmtv(p)}${unit}`, a: a == null ? '—' : `${fmtv(a)}${unit}`, diff });
  };
  add('Quantity', sum('plan', 'qty'), sum('act', 'qty'), ' pcs', int);
  add('Cartons', sum('plan', 'cartons'), sum('act', 'cartons') ?? facts.cartons ?? null, '', int);
  add('Gross weight', sum('plan', 'gross_kg'), sum('act', 'gross_kg') ?? facts.gross_kg ?? null, ' kg', int);
  add('Volume', sum('plan', 'cbm'), sum('act', 'cbm') ?? facts.cbm ?? null, ' m³', n2);
  const sz = pairs.filter((x) => x.act?.carton && x.plan.carton && x.act.carton.join('×') !== x.plan.carton.join('×'));
  for (const x of sz) rows.push({ label: `Carton size${pairs.length > 1 ? ` · ${x.plan.product || x.plan.po}` : ''}`, p: `${x.plan.carton.join('×')} cm`, a: `${x.act.carton.join('×')} cm`, diff: { t: 'changed', c: 'warnc' } });
  return { rows, warn: rows.filter((r) => r.diff.c === 'warnc').length, pairs };
}

/** Progress steps. */
function steps(sc, list, nfiles) {
  const need = list.filter((x) => x.key !== 'confirm' && x.state !== 'opt').length;
  const have = list.filter((x) => x.key !== 'confirm' && x.state === 'have' && !/Optional/.test(x.label)).length;
  const done = (k) => ({ sent: !!sc.sent_at, loaded: !!sc.confirmed_at, docs: nfiles > 0, review: sc.status === 'complete', complete: sc.status === 'complete' && !(sc.missing || []).length }[k]);
  const items = [
    ['sent', 'Request sent', sc.sent_at ? sd(sc.sent_at) : sc.status === 'scheduled' && sc.due_date ? `planned ${PL.short(sc.due_date)}` : ''],
    ['loaded', sc.mode === 'LCL' ? 'At warehouse' : sc.mode === 'COURIER' ? 'Picked up' : sc.mode === 'FCL' ? 'Loaded' : 'Shipped', sc.confirmed_at ? `confirmed ${sd(sc.confirmed_at)}` : ''],
    ['docs', 'Documents in', nfiles ? `${Math.min(have, need)} of ${need} required` : ''],
    ['review', 'Your review', sc.status === 'received' ? 'check the figures' : sc.accepted_at ? 'figures accepted' : ''],
    ['complete', 'Complete', sc.status === 'complete' && (sc.missing || []).length ? 'waiting for documents' : sc.accepted_at ? sd(sc.accepted_at) : 'stored for stats'],
  ];
  const now = items.findIndex(([k]) => !done(k));
  return html`<div class="sd-steps">${items.map(([k, l, s], i) => html`<div class="sd-st ${done(k) ? 'done' : i === now ? 'now' : ''}"><b>${l}</b><small>${s}</small></div>`)}</div>`;
}

/** What happens next, automatically: { text, date, kind (popup), dateAction }. */
function plan(sc, list, today) {
  const due = (d) => (d && today && d < today ? today : d);
  const miss = list.filter((x) => x.state === 'miss');
  const later = list.filter((x) => x.state === 'later');
  if (sc.status === 'scheduled') return { text: `Request goes out at 9:00 China time`, date: sc.due_date, kind: 'request', label: 'Send request now', dateAction: 'date' };
  if (sc.status === 'sent') {
    const n = sc.reminders || 0;
    const d = n < SD.REMIND_AFTER.length ? PL.addDays(String(sc.sent_at).slice(0, 10), SD.REMIND_AFTER[n]) : null;
    return { text: sc.paused ? 'Reminders paused' : d ? `Reminder ${n + 1} of ${SD.REMIND_AFTER.length} — if there is still no reply` : 'No more automatic reminders — shown as overdue', date: sc.paused ? null : due(d), kind: 'reminder', label: 'Send reminder now', pausable: true };
  }
  if (!miss.length && !later.length) return { text: 'All required documents are in — no more emails', date: null };
  const next = SD.nextFollowup(sc, list);
  const what = (next && later.length && !miss.length ? later : miss.length ? miss : later).map((x) => x.label).join(', ');
  return {
    text: sc.paused ? 'Follow-ups paused' : next ? `Ask for ${what}${later.length && miss.length ? ` (${later.map((x) => x.label).join(', ')} later, after ${PL.short(later[0].from)})` : later.length && !miss.length ? ' (issued after sailing)' : ''}` : 'Follow-ups finished — shown as “Documents missing”',
    date: sc.paused ? null : due(next), kind: 'missing', label: 'Send follow-up now', dateAction: 'next', pausable: true,
  };
}

/** The Shipment card(s) on a PO page. */
async function shipmentSection(db, supplier, po, back) {
  let rows;
  try { rows = (await db.list('ship_confirmations', { filters: { supplier_id: supplier.id }, order: 'created_at.desc' })).filter((x) => x.status !== 'cancelled' && (x.pos || []).some((p) => PL.normPo(p) === PL.normPo(po))); }
  catch (e) { if (missingTable(e)) return html`<section class="card" id="shipment"><h2>Shipment</h2><p class="flash warn">Run the shipping documents SQL in Supabase first (supabase/schema.sql, "Shipment confirmations").</p></section>`; throw e; }
  const lines = (await db.list('plan_orders', { filters: { supplier_id: supplier.id } }).catch(() => [])).filter((l) => PL.normPo(l.po) === PL.normPo(po));
  if (!rows.length) {
    if (!lines.length) return '';
    const shipped = lines.every((l) => l.shipped); const inC = lines.some((l) => l.container_id);
    return html`<section class="card sd-none" id="shipment"><div class="head-row"><h2>Shipment</h2></div>
      <p class="muted">${shipped ? 'This PO is shipped, but no shipping documents were requested.' : inC ? 'The request for shipping documents goes out automatically on the container’s loading date.' : 'Plan this PO into a container to request shipping documents automatically on the loading date — or ask now.'}</p>
      <form method="post" action="${BASE}/request" data-sd-open data-kind="request" data-supplier="${supplier.id}" data-po="${po}"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${po}"><input type="hidden" name="back" value="${back}"><button class="btn ${shipped ? '' : 'ghost'} small">Request shipping documents now</button></form></section>${sendDialog()}`;
  }
  const cs = await containersById(db);
  const files = await db.list('plan_files', { filters: { supplier_id: supplier.id } }).catch(() => []);
  const day = PL.today(); const cday = SD.chinaNow().day;
  const cards = [];
  for (const sc of rows) {
    const { sailing } = await SD.factsOf(db, sc);
    const mine = docsOf(files, sc);
    const list = SD.checklistOf(sc, mine, sailing, cday);
    const st = SD.stateOf(sc, day);
    const cmp = compareRows(sc);
    const facts = sc.facts || {};
    const nx = plan(sc, list, cday);
    const others = (sc.pos || []).filter((p) => PL.normPo(p) !== PL.normPo(po));
    const extra = mine.filter((f) => !SD.required(sc).some(([k]) => k === f.kind));
    const fileLink = (f) => html`<a href="/admin/logistics/planning/files/${f.id}?inline=1" ${/pdf|image/.test(f.content_type || '') ? raw(`data-preview="/admin/logistics/planning/files/${f.id}?inline=1" data-type="${/image/.test(f.content_type) ? 'image' : 'doc'}" data-dl="/admin/logistics/planning/files/${f.id}"`) : raw('target="_blank" rel="noopener"')}>${f.name}</a>`;
    const hasFacts = (sc.planned || []).length && (facts.lines || []).length || facts.cbm || facts.cartons;
    const how = (f) => (/^Email from/.test(f.uploaded_by || '') ? 'by email' : f.uploaded_by ? 'added by you' : '');
    const log = [...(sc.log || [])].slice(-4);
    cards.push(html`<section class="card sd-card" id="shipment">
      <div class="head-row"><h2>Shipment <span class="sub">${shipLabel(sc, cs)}${sc.mode ? ` · ${SD.MODES[sc.mode] || sc.mode}` : ''}${others.length ? ` · with ${others.join(', ')}` : ''}</span></h2><span class="cp-tag ${st.tag}">${st.label}</span></div>
      ${steps(sc, list, mine.length)}
      <div class="sd-grid">
        <div>
          <h3 class="sd-h">Shipping documents <span class="sub">${sc.mode || 'standard'} checklist</span></h3>
          <ul class="sd-docs">${list.filter((x) => x.key !== 'confirm').map((x) => { const fs = mine.filter((f) => f.kind === x.key); const tg = DOCTAG[x.state]; return html`<li><span class="sd-ic ${fs.length ? fileIcon(fs[0]).toLowerCase() : 'miss'}">${fs.length ? fileIcon(fs[0]) : SHORT[x.key] || '+'}</span>
            <div class="sd-dm"><b>${x.label}${x.state === 'opt' || (fs.length && SD.required(sc).find((r) => r[0] === x.key)?.[3]) ? html` <span class="sd-opt">optional · not chased</span>` : ''}</b>${fs.length ? html`<div class="sub">${fs.map((f, i) => html`${i ? ' · ' : ''}${fileLink(f)}`)} · ${[how(fs[0]), sd(fs[0].created_at)].filter(Boolean).join(' ')}</div>` : html`<div class="sub">${x.state === 'later' ? `expected after sailing — asked for from ${PL.short(x.from)}` : x.state === 'opt' ? 'asked for once' : 'not received yet'}</div>`}</div>
            <span class="cp-tag ${tg[0]}">${tg[1]}</span></li>`; })}
            ${extra.map((f) => html`<li><span class="sd-ic ${fileIcon(f).toLowerCase()}">${fileIcon(f)}</span><div class="sd-dm"><b>${f.kind || 'Other'}</b><div class="sub">${fileLink(f)} · ${[how(f), sd(f.created_at)].filter(Boolean).join(' ')}</div></div><span class="cp-tag ok">Received</span></li>`)}</ul>
          <details class="sd-add"><summary>Got a document another way (WeChat, forwarder)? <b>Add file</b></summary>
          <form method="post" action="${BASE}/${sc.id}/upload" enctype="multipart/form-data" data-busy class="sd-up">
            <input type="hidden" name="back" value="${back}">
            <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple required aria-label="Add shipping documents"><span class="dz-main" data-main>Drag &amp; drop or choose files</span><span class="dz-hint">Type is detected from the file name${AI.enabled() ? ' · AI reads the figures' : ''}</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <div class="sd-up-row"><select name="kind" class="sd-kind" aria-label="Document type"><option value="">Detect type</option>${['Invoice', 'Packing list', 'Bill of lading', 'Warehouse receipt', 'Loading photos', 'Other'].map((k) => html`<option>${k}</option>`)}</select><button class="btn ghost small">Upload</button></div></form></details>
          ${facts.summary || sc.reply_text ? html`<div class="sd-note blue">${facts.summary || ''}${sc.reply_text ? html`<details class="sd-orig"><summary>Supplier's last email</summary><pre>${sc.reply_text}</pre></details>` : ''}</div>` : ''}
        </div>
        <div>
          <div class="sd-fu">
            <div class="sd-fu-h"><b>${sc.status === 'scheduled' ? 'Request' : sc.status === 'sent' ? 'Reminders' : 'Follow-ups'}</b>
              ${nx.pausable ? html`<form method="post" action="${BASE}/${sc.id}/pause" class="inline"><input type="hidden" name="back" value="${back}"><input type="hidden" name="value" value="${sc.paused ? '0' : '1'}"><button class="link small">${sc.paused ? 'Resume' : 'Pause'}</button></form>` : ''}</div>
            <ul class="sd-tl">${log.map((x) => html`<li class="done"><span>${sd(x.at)}</span><span>${x.text}</span></li>`)}
              <li class="${nx.date ? 'next' : 'end'}"><span>${nx.date ? PL.short(nx.date) : '—'}</span><span>${nx.date ? html`<b>Next:</b> ` : ''}${nx.text}</span></li></ul>
            <div class="sd-acts2">
              ${nx.kind ? html`<form method="post" action="${BASE}/${sc.id}/send" class="inline" data-sd-open data-kind="${nx.kind}" data-id="${sc.id}"><input type="hidden" name="back" value="${back}"><input type="hidden" name="kind" value="${nx.kind}"><button class="btn small">${nx.label}</button></form>` : ''}
              ${nx.dateAction && nx.date ? html`<form method="post" action="${BASE}/${sc.id}/${nx.dateAction}" class="inline sd-date"><input type="hidden" name="back" value="${back}"><label class="sub">Change date <input type="date" name="date" value="${nx.date}" aria-label="Change date" data-autosubmit></label></form>` : ''}
            </div>
          </div>
          ${hasFacts ? html`<form method="post" action="${BASE}/${sc.id}/accept" class="sd-ai">
            <input type="hidden" name="back" value="${back}">
            <div class="sd-ai-h"><b>${sc.status === 'complete' ? 'Actual figures' : 'Read from the documents'}</b><span class="sub">${sc.status === 'complete' ? `accepted ${sd(sc.accepted_at)}` : 'check, then accept'}</span></div>
            <div class="sd-facts">
              ${sc.mode !== 'LCL' ? html`<label><span>Container</span><input name="container_no" value="${facts.container_no || sc.container_no || ''}" placeholder="—" ${sc.status === 'complete' ? raw('readonly') : ''}></label><label><span>Seal</span><input name="seal_no" value="${facts.seal_no || sc.seal_no || ''}" placeholder="—" ${sc.status === 'complete' ? raw('readonly') : ''}></label>` : ''}
              <label><span>B/L no.</span><input name="bl_no" value="${facts.bl_no || sc.bl_no || ''}" placeholder="—" ${sc.status === 'complete' ? raw('readonly') : ''}></label>
              <label><span>${sc.mode === 'LCL' ? 'Delivered' : 'Loaded'}</span><input type="date" name="loaded_on" value="${facts.loaded_on || sc.loaded_on || ''}" ${sc.status === 'complete' ? raw('readonly') : ''}></label></div>
            <table class="sd-cmp"><thead><tr><th></th><th>Planned</th><th>Actual</th><th>Diff</th></tr></thead>
              <tbody>${cmp.rows.map((r) => html`<tr><td>${r.label}</td><td>${r.p}</td><td>${r.a}</td><td class="${r.diff.c}">${r.diff.t}</td></tr>`)}</tbody></table>
            ${sc.status !== 'complete' ? html`${cmp.warn ? html`<p class="sd-note warn">${cmp.warn} difference${cmp.warn > 1 ? 's' : ''} from the plan. Accepting saves the actual figures to the PO lines.</p>` : html`<p class="sd-note ok">Matches the plan.</p>`}
              <label class="cp-chk sd-chk"><input type="checkbox" name="products" value="1" ${cmp.rows.some((r) => /Carton size/.test(r.label)) ? raw('checked') : ''}> Also update the packing in ${supplier.name}'s product list</label>
              <div class="sd-acts"><button class="btn">Accept &amp; save</button>${list.some((x) => x.state === 'miss' || x.state === 'later') ? html`<span class="sub"> — missing documents can still come later</span>` : ''}</div>` : ''}
          </form>` : sc.status !== 'scheduled' ? html`<p class="sub sd-wait2">When the supplier replies, AI reads cartons, weight, m³ and the container number from the documents here.</p>` : ''}
          <div class="sd-acts2">
            ${AI.enabled() && mine.length && sc.status !== 'complete' ? html`<form method="post" action="${BASE}/${sc.id}/reread" class="inline" data-busy><input type="hidden" name="back" value="${back}"><button class="link small">Read the documents again</button></form>` : ''}
            ${sc.status !== 'complete' ? html`<form method="post" action="${BASE}/${sc.id}/cancel" class="inline" data-confirm="Stop this request? No more emails, reminders or follow-ups go to the supplier."><input type="hidden" name="back" value="${back}"><button class="link small">Stop request</button></form>` : ''}
          </div>
          <details class="sd-log"><summary>All activity · ${sc.code}</summary><ul>${[...(sc.log || [])].reverse().map((x) => html`<li><span>${sd(x.at)}</span>${x.text}</li>`)}</ul></details>
        </div>
      </div></section>`);
  }
  return [...cards, sendDialog()];
}

/** Popup to check recipients and the message before a request, reminder or follow-up goes out. */
function sendDialog() {
  return html`<dialog class="rp-modal sd-dlg" data-sd-dlg aria-labelledby="sd-dlg-t"><form data-sd-form>
    <div class="sd-dh"><div><h2 id="sd-dlg-t" data-sd-title>Request shipping documents</h2><div class="sub" data-sd-ctx></div></div><button type="button" class="icon-btn" data-sd-close aria-label="Close">×</button></div>
    <div class="sd-seg" data-sd-tabs role="tablist"></div>
    <div class="sd-mode" data-sd-modes hidden><span>Ships as</span><div class="sd-mseg" role="radiogroup" aria-label="Ships as" data-sd-mseg></div></div>
    <div class="rp-loading" data-sd-loading>Preparing the email…</div>
    <div data-sd-fields hidden>
      <div class="sd-sec"><div class="sd-lbl">To <button type="button" class="sd-lnk" data-sd-cc-open>+ CC</button></div>
        <div class="sd-rcp" data-sd-to><input type="text" data-sd-add placeholder="Add email…" autocomplete="off" aria-label="Add recipient"></div>
        <div class="sd-ccrow" data-sd-ccrow hidden><span>CC</span><div class="sd-rcp" data-sd-cc><input type="text" data-sd-add placeholder="Add email…" autocomplete="off" aria-label="Add CC"></div></div></div>
      <div class="sd-sec"><div class="sd-lbl">Subject</div>
        <div class="sd-subj"><input type="text" name="subject" required aria-label="Subject"><span class="sd-ref" data-sd-code title="Added automatically so the reply is matched to this shipment"></span></div></div>
      <div class="sd-sec"><div class="sd-lbl">Message <button type="button" class="sd-lnk" data-sd-reset>Reset to standard text</button></div>
        <p class="sd-greet" data-sd-greet></p>
        <textarea name="intro" rows="4" required aria-label="Message"></textarea>
        <div class="sd-fixed" data-sd-fixed></div></div>
      <div class="sd-sec"><div class="sd-lbl"><span data-sd-listlbl>Please send</span><span class="sd-lbl-n">untick to leave out</span></div>
        <div class="sd-items" data-sd-items></div>
        <label class="sd-rcv" data-sd-rcvrow hidden><input type="checkbox" data-sd-rcv checked> Also list what already arrived: <b data-sd-rcvlist></b></label></div>
    </div>
    <div class="sd-foot" data-sd-actions hidden><button class="btn" data-sd-send>Send</button><button type="button" class="btn ghost" data-sd-close>Cancel</button><span class="sub" data-sd-note role="status"></span><span class="sd-sum" data-sd-sum></span></div>
  </form></dialog>`;
}

module.exports = function shippingRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const backTo = (f, sc) => (String(f.back || '').startsWith('/admin/') ? f.back : sc?.pos?.[0] ? `${poUrl(sc.supplier_id, sc.pos[0])}#shipment` : BASE);
  const getSc = async (id) => { const sc = await db.get('ship_confirmations', id).catch(() => null); if (!sc) throw new HttpError(404, 'Shipment request not found'); return sc; };

  router.get(BASE, G(async (req, res) => {
    let rows = []; let missing = false;
    try { await SD.syncScheduled(db, SD.chinaNow().day); rows = await db.list('ship_confirmations', { order: 'created_at.desc' }); }
    catch (e) { if (missingTable(e)) missing = true; else throw e; }
    rows = rows.filter((x) => x.status !== 'cancelled');
    const day = PL.today();
    const cs = await containersById(db);
    const sups = Object.fromEntries((await Promise.all([...new Set(rows.map((r) => r.supplier_id))].map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
    const files = await db.list('plan_files').catch(() => []);
    const st = (r) => SD.stateOf(r, day).key;
    const groups = { action: (r) => ['received', 'overdue', 'sent', 'docs_missing'].includes(st(r)), scheduled: (r) => st(r) === 'scheduled', complete: (r) => st(r) === 'complete', all: () => true };
    const tab = groups[req.query.tab] ? req.query.tab : 'action';
    const order = { received: 0, overdue: 1, docs_missing: 2, sent: 3, scheduled: 4, complete: 5 };
    const list = rows.filter(groups[tab]).sort((a, b) => (order[st(a)] - order[st(b)]) || String(a.due_date).localeCompare(String(b.due_date)));
    const n = (k) => rows.filter((r) => st(r) === k).length;
    const soon = rows.filter((r) => st(r) === 'scheduled' && r.due_date && r.due_date <= PL.addDays(day, 7));
    const month = rows.filter((r) => st(r) === 'complete' && String(r.accepted_at || '').slice(0, 7) === day.slice(0, 7)).length;
    const stats = SD.supplierStats(rows);
    res.html(page({
      title: 'Shipping documents', nav: adminNav('shipping'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h1>Shipping documents</h1><p class="muted">One request per supplier per shipment, sent automatically at 9:00 China time on the loading date. Suppliers reply by email; AI reads the documents and you accept the figures. Missing documents are followed up automatically.</p></div></div>
        ${missing ? html`<p class="flash warn">Run the shipping documents SQL in Supabase first (supabase/schema.sql, "Shipment confirmations").</p>` : ''}
        <div class="cp-kpis">
          <div class="cp-kpi ${n('received') ? 'warn' : ''}"><span>To review</span><b>${n('received')}</b><small>documents arrived</small></div>
          <div class="cp-kpi ${n('overdue') + n('docs_missing') ? 'warn' : ''}"><span>Waiting for supplier</span><b>${n('sent') + n('overdue') + n('docs_missing')}</b><small>${[n('overdue') ? `${n('overdue')} overdue` : '', n('docs_missing') ? `${n('docs_missing')} documents missing` : ''].filter(Boolean).join(' · ') || 'reminders on'}</small></div>
          <div class="cp-kpi"><span>Scheduled</span><b>${soon.length}</b><small>${soon.length ? `next ${PL.short(soon.map((r) => r.due_date).sort()[0])}` : 'next 7 days'}</small></div>
          <div class="cp-kpi"><span>Complete this month</span><b>${month}</b><small>figures saved</small></div></div>
        <div class="or-bar"><nav class="cp-views" aria-label="Show">${[['action', 'Needs action', n('received') + n('overdue') + n('sent') + n('docs_missing')], ['scheduled', 'Scheduled', n('scheduled')], ['complete', 'Complete', n('complete')], ['all', 'All', rows.length]].map(([k, l, c]) => html`<a href="${BASE}?tab=${k}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l} <span class="or-n">${c}</span></a>`)}</nav></div>
        <div class="card flush"><div class="table-wrap"><table class="list sd-table"><thead><tr><th>Supplier · POs</th><th>Shipment</th><th>Loading date</th><th>Documents</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.length ? list.map((r) => {
            const s = SD.stateOf(r, day); const mine = docsOf(files, r); const cl = SD.required(r).map(([k, label, , opt]) => ({ kind: k, label, have: mine.some((f) => f.kind === k), opt })); const url = `${poUrl(r.supplier_id, (r.pos || [])[0] || '')}#shipment`;
            return html`<tr><td><a href="${url}"><b>${sups[r.supplier_id]?.name || 'Supplier'}</b></a><div class="sub">${(r.pos || []).join(', ')}</div></td>
              <td>${shipLabel(r, cs)}${r.container_no ? html`<div class="sub">${r.container_no}</div>` : ''}</td><td>${r.due_date ? PL.short(r.due_date) : '—'}</td>
              <td><div class="sd-dots">${cl.map((x) => html`<span class="sd-d ${x.have ? 'y' : r.status === 'scheduled' || x.opt ? '' : 'n'}" title="${x.label}${x.opt ? ' (optional)' : ''}">${SHORT[x.kind] || x.kind}</span>`)}</div></td>
              <td><span class="cp-tag ${s.tag}">${s.label}</span>${r.status === 'sent' && r.reminders ? html`<div class="sub">${r.reminders} reminder${r.reminders > 1 ? 's' : ''} sent</div>` : ''}${r.status === 'received' && compareRows(r).warn ? html`<div class="sub">${compareRows(r).warn} difference${compareRows(r).warn > 1 ? 's' : ''}</div>` : ''}</td>
              <td class="r"><a class="btn ${s.key === 'received' ? '' : 'ghost'} small" href="${url}">${s.key === 'received' ? 'Review' : 'Open'}</a></td></tr>`;
          }) : html`<tr><td colspan="6" class="muted">${tab === 'action' ? 'Nothing needs you right now.' : 'Nothing here yet.'} Requests are created when a container has a sailing or a loading date.</td></tr>`}</tbody></table></div></div>
        ${Object.keys(stats).length ? html`<section class="card"><h2>Supplier shipping record</h2><p class="muted small">From accepted shipments: how quickly documents come back and how close the shipped volume is to the plan.</p>
          <div class="table-wrap"><table class="list"><thead><tr><th>Supplier</th><th class="r">Shipments</th><th class="r">Days to documents</th><th class="r">Volume vs plan</th><th class="r">Shipped m³</th><th class="r">Shipped kg</th></tr></thead>
          <tbody>${Object.entries(stats).sort((a, b) => b[1].n - a[1].n).map(([id, s]) => html`<tr><td>${sups[id]?.name || 'Supplier'}</td><td class="r">${s.n}</td><td class="r">${s.days == null ? '—' : s.days.toFixed(1)}</td><td class="r ${s.vol != null && Math.abs(s.vol) > 0.05 ? 'sd-off' : ''}">${s.vol == null ? '—' : `${s.vol > 0 ? '+' : ''}${(s.vol * 100).toFixed(1)}%`}</td><td class="r">${n2(s.cbm)}</td><td class="r">${int(s.kg)}</td></tr>`)}</tbody></table></div></section>` : ''}`,
    }));
  }));

  const json = (fn) => G(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req, res)) }); }
    catch (e) { res.json({ ok: false, error: missingTable(e) ? 'Run the shipping documents SQL in Supabase first.' : e.provider?.reason ? `${e.message} (${e.provider.reason})` : e.message }, e.status || 400); }
  });
  const target = async (q) => (q.id ? getSc(q.id) : SD.createFor(db, { supplierId: String(q.supplier || ''), po: String(q.po || ''), dryRun: true }));
  const KINDS = ['request', 'reminder', 'missing'];

  /** Popup data: recipients, subject, message, the document list with states, and which kinds make sense now. */
  router.get(`${BASE}/draft`, json(async (req) => {
    let sc = await target(req.query);
    const choose = !sc.container_id;   // no container plan: you say how it ships (FCL / LCL / courier)
    if (choose && req.query.mode !== undefined) sc = { ...sc, mode: SD.MODES[req.query.mode] ? req.query.mode : '' };
    const facts = await SD.factsOf(db, sc);
    if (!facts.supplier) throw new HttpError(404, 'Supplier not found');
    const list = SD.checklistOf(sc, await SD.filesOf(db, sc), facts.sailing, SD.chinaNow().day);
    const kinds = !sc.id || sc.status === 'scheduled' ? ['request'] : sc.status === 'sent' ? ['request', 'reminder'] : ['request', 'reminder', 'missing'];
    const kind = kinds.includes(req.query.kind) ? req.query.kind : kinds[kinds.length - 1];
    const d = SD.draftParts(sc, facts, { kind, list });
    const users = await db.list('supplier_users', { filters: { supplier_id: sc.supplier_id } }).catch(() => []);
    const seen = new Set(); const to = [];
    const add = (email, label, on = true) => { const e = String(email || '').trim().toLowerCase(); if (!e || seen.has(e)) return; seen.add(e); to.push({ email: e, label, on }); };
    for (const e of String(sc.sent_to || '').split(/[,;\s]+/)) add(e, e === String(facts.supplier.email || '').toLowerCase() ? facts.supplier.contact_name || 'Company email' : 'Sent to before');
    add(facts.supplier.email, facts.supplier.contact_name || 'Company email');
    for (const u of users) add(u.email, `${u.name || 'Portal user'}${u.status === 'disabled' ? ' · disabled' : ''}`, false);
    const P = require('../projects');
    const nx = kind === 'missing' ? SD.nextFollowup(sc, list) : null;
    const sentDay = sc.sent_at ? String(sc.sent_at).slice(0, 10) : null;
    const after = kind === 'request' ? (sc.status === 'scheduled' || !sc.id ? 'Reminders go out automatically on day 2 and day 4 if there is no reply.' : '')
      : kind === 'reminder' ? `Reminder ${(sc.reminders || 0) + 1} of ${SD.REMIND_AFTER.length}${sentDay ? ` · request sent ${PL.short(sentDay)}` : ''} · then shown as overdue on the dashboard.`
        : nx ? `Next automatic follow-up: ${nx <= SD.chinaNow().day ? 'today' : PL.short(nx)} — this one replaces it.` : 'No more automatic follow-ups after this one.';
    return {
      kind, kinds, code: sc.id ? sc.code : 'LBS-·····', title: { request: 'Request shipping documents', reminder: 'Send reminder', missing: 'Ask for missing documents' }[kind],
      ctx: [facts.supplier.name, `PO ${(sc.pos || []).join(', ')}`, d.shipment].filter(Boolean).join(' · '),
      to, cc: kind === 'request' && !sc.sent_at ? P.ownerEmails() : [], subject: d.subject, intro: d.intro, greet: d.name || 'Sir or Madam',
      fixed: d.rows.map((r) => [r.po, r.product, r.qty ? `${r.qty} pcs` : '', r.cartons ? `${r.cartons} ctns` : '', r.cbm ? `${r.cbm} m³` : ''].filter(Boolean).join(' · ')).join('  |  '),
      listLabel: d.listLabel, items: d.items, received: d.received, after, choose, mode: sc.mode || '', modes: SD.MODES,
    };
  }));

  router.post(`${BASE}/send`, json(async (req) => {
    const { fields: f } = await parseForm(req, { limitBytes: 100000 });
    const kind = KINDS.includes(f.kind) ? f.kind : 'request';
    const list = (v) => [].concat(v || []).join(',').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const to = list(f.to);
    if (!to.length) throw new HttpError(400, 'Add at least one recipient');
    if (!String(f.subject || '').trim() || !String(f.intro || '').trim()) throw new HttpError(400, 'Subject and message are required');
    const items = [].concat(f.item || []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 20);
    if (!items.length) throw new HttpError(400, 'Tick at least one document to ask for');
    const mode = f.mode !== undefined ? (SD.MODES[f.mode] ? f.mode : '') : undefined;
    let sc = f.id ? await getSc(f.id) : await SD.createFor(db, { supplierId: String(f.supplier || ''), po: String(f.po || ''), mode });
    if (!sc.container_id && mode !== undefined && (sc.mode || '') !== mode) { await db.update('ship_confirmations', { id: sc.id }, { mode, updated_at: new Date().toISOString() }); sc = { ...sc, mode }; }
    const out = await SD.sendRequest(db, config, sc, { kind, by: by(req), edits: { to, cc: list(f.cc), subject: String(f.subject).slice(0, 300), intro: String(f.intro).slice(0, 4000), items, received: f.received === '1' } });
    return { sent: out.to, id: sc.id };
  }));

  router.post(`${BASE}/:id/next`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    const d = PL.isoDay(f.date); if (!d) throw new HttpError(400, 'Choose a date');
    await db.update('ship_confirmations', { id: sc.id }, { next_followup: d, log: [...(sc.log || []), { at: new Date().toISOString(), text: `Next follow-up moved to ${PL.short(d)} by ${by(req)}` }], updated_at: new Date().toISOString() });
    flash(res, 'ok', `Next follow-up ${PL.short(d)}`); res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/pause`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    const v = f.value === '1';
    await db.update('ship_confirmations', { id: sc.id }, { paused: v, log: [...(sc.log || []), { at: new Date().toISOString(), text: `${v ? 'Paused' : 'Resumed'} by ${by(req)}` }], updated_at: new Date().toISOString() });
    flash(res, 'ok', v ? 'Automatic emails paused for this shipment' : 'Automatic emails resumed'); res.redirect(backTo(f, sc));
  }));

  router.post(`${BASE}/request`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const sc = await SD.createFor(db, { supplierId: f.supplier, po: f.po });
    try { await SD.sendRequest(db, config, sc, { by: by(req) }); flash(res, 'ok', 'Request for shipping documents sent'); }
    catch (e) { flash(res, 'error', `Could not send: ${e.provider?.reason || e.message}`); }
    res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/send`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    try { const kind = ['reminder', 'missing'].includes(f.kind) ? f.kind : 'request'; await SD.sendRequest(db, config, sc, { kind, by: by(req) }); flash(res, 'ok', kind === 'request' ? 'Request sent' : kind === 'reminder' ? 'Reminder sent' : 'Follow-up sent'); }
    catch (e) { flash(res, 'error', `Could not send: ${e.provider?.reason || e.message}`); }
    res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/date`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    const d = PL.isoDay(f.date); if (!d) throw new HttpError(400, 'Choose a date');
    await db.update('ship_confirmations', { id: sc.id }, { due_date: d, new_date: d, log: [...(sc.log || []), { at: new Date().toISOString(), text: `Send date moved to ${PL.short(d)} by ${by(req)}` }], updated_at: new Date().toISOString() });
    flash(res, 'ok', `Request goes out ${PL.short(d)}`); res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/cancel`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    await db.update('ship_confirmations', { id: sc.id }, { status: 'cancelled', log: [...(sc.log || []), { at: new Date().toISOString(), text: `Stopped by ${by(req)}` }], updated_at: new Date().toISOString() });
    flash(res, 'ok', 'Request stopped'); res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/upload`, G(async (req, res) => {
    const sc = await getSc(req.params.id);
    const { fields: f, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const list = Object.values(files).flat().map((x) => ({ ...x, kind: f.kind || null }));
    if (!list.length) throw new HttpError(400, 'Choose a file');
    await SD.receive(db, config, sc, { files: list, by: `Uploaded by ${by(req)}`, quiet: true });
    flash(res, 'ok', `${list.length} document${list.length > 1 ? 's' : ''} added`); res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/reread`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    const fs = (await db.list('plan_files', { filters: { supplier_id: sc.supplier_id } }).catch(() => [])).filter((x) => x.shipment_id === sc.id && x.kind !== 'Loading photos');
    const loaded = [];
    for (const x of fs.slice(0, 6)) { try { loaded.push({ name: x.name, type: x.content_type, kind: x.kind, buffer: await db.docs.download(x.path) }); } catch { /* skip */ } }
    try {
      const r = SD.factsFrom(await SD.readDocs({ text: sc.reply_text || '', files: loaded, planned: sc.planned || [] }));
      await db.update('ship_confirmations', { id: sc.id }, { facts: { ...(sc.facts || {}), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))) }, updated_at: new Date().toISOString() });
      flash(res, 'ok', 'Documents read again');
    } catch (e) { flash(res, 'error', `Could not read the documents: ${e.message}`); }
    res.redirect(backTo(f, sc));
  }));
  router.post(`${BASE}/:id/accept`, G(async (req, res) => {
    const sc = await getSc(req.params.id); const { fields: f } = await parseForm(req);
    if (sc.status === 'complete') throw new HttpError(400, 'Already accepted');
    const clean = (v, n) => (v ? String(v).replace(/\s+/g, '').toUpperCase().slice(0, n) : null);
    const r = await SD.accept(db, sc, { values: { container_no: clean(f.container_no, 15), seal_no: clean(f.seal_no, 30), bl_no: clean(f.bl_no, 40), loaded_on: PL.isoDay(f.loaded_on) }, updateProducts: f.products === '1', by: by(req) });
    flash(res, 'ok', `Saved — ${r.lines} PO line${r.lines === 1 ? '' : 's'} updated with the actual figures`); res.redirect(backTo(f, sc));
  }));

};
module.exports.shipmentSection = shipmentSection;
