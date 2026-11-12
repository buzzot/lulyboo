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
/** Checklist: each required kind → files of that kind. */
const checklist = (sc, files) => SD.required(sc).map(([kind, label, hint]) => ({ kind, label, hint, files: docsOf(files, sc).filter((f) => f.kind === kind) }));

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
function steps(sc, files) {
  const got = docsOf(files, sc).length; const need = SD.required(sc).length;
  const have = checklist(sc, files).filter((x) => x.files.length).length;
  const done = (k) => ({ sent: !!sc.sent_at, loaded: !!sc.confirmed_at, docs: got > 0, review: sc.status === 'complete', complete: sc.status === 'complete' }[k]);
  const list = [
    ['sent', 'Request sent', sc.sent_at ? sd(sc.sent_at) : sc.status === 'scheduled' && sc.due_date ? `planned ${PL.short(sc.due_date)}` : ''],
    ['loaded', sc.mode === 'LCL' ? 'At warehouse' : 'Loaded', sc.confirmed_at ? `confirmed ${sd(sc.confirmed_at)}` : ''],
    ['docs', 'Documents in', got ? `${have} of ${need}` : ''],
    ['review', 'Your review', sc.status === 'received' ? 'check the figures' : sc.accepted_at ? `${sc.accepted_by || ''}`.trim() : ''],
    ['complete', 'Complete', sc.accepted_at ? sd(sc.accepted_at) : 'stored for stats'],
  ];
  const now = list.findIndex(([k]) => !done(k));
  return html`<div class="sd-steps">${list.map(([k, l, s], i) => html`<div class="sd-st ${done(k) ? 'done' : i === now ? 'now' : ''}"><b>${l}</b><small>${s}</small></div>`)}</div>`;
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
      <form method="post" action="${BASE}/request"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${po}"><input type="hidden" name="back" value="${back}"><button class="btn ${shipped ? '' : 'ghost'} small">Request shipping documents now</button></form></section>`;
  }
  const cs = await containersById(db);
  const files = await db.list('plan_files', { filters: { supplier_id: supplier.id } }).catch(() => []);
  const day = PL.today();
  return rows.map((sc) => {
    const st = SD.stateOf(sc, day);
    const cl = checklist(sc, files);
    const cmp = compareRows(sc);
    const facts = sc.facts || {};
    const others = (sc.pos || []).filter((p) => PL.normPo(p) !== PL.normPo(po));
    const extra = docsOf(files, sc).filter((f) => !SD.required(sc).some(([k]) => k === f.kind));
    const fileLink = (f) => html`<a href="/admin/logistics/planning/files/${f.id}?inline=1" ${/pdf|image/.test(f.content_type || '') ? raw(`data-preview="/admin/logistics/planning/files/${f.id}?inline=1" data-type="${/image/.test(f.content_type) ? 'image' : 'doc'}" data-dl="/admin/logistics/planning/files/${f.id}"`) : raw('target="_blank" rel="noopener"')}>${f.name}</a>`;
    const hasFacts = (sc.planned || []).length && (facts.lines || []).length || facts.cbm || facts.cartons;
    return html`<section class="card sd-card" id="shipment">
      <div class="head-row"><h2>Shipment <span class="sub">${shipLabel(sc, cs)}${sc.mode ? ` · ${sc.mode}` : ''}${others.length ? ` · with ${others.join(', ')}` : ''}</span></h2><span class="cp-tag ${st.tag}">${st.label}</span></div>
      ${steps(sc, files)}
      <div class="sd-grid">
        <div>
          <h3 class="sd-h">Shipping documents <span class="sub">${sc.mode || 'standard'} checklist</span></h3>
          <ul class="sd-docs">${cl.map((x) => html`<li><span class="sd-ic ${x.files.length ? fileIcon(x.files[0]).toLowerCase() : 'miss'}">${x.files.length ? fileIcon(x.files[0]) : SHORT[x.kind] || '+'}</span>
            <div class="sd-dm"><b>${x.label}</b>${x.files.length ? html`<div class="sub">${x.files.map((f, i) => html`${i ? ' · ' : ''}${fileLink(f)}`)} · ${sd(x.files[0].created_at)}</div>` : html`<div class="sub">${x.hint || 'not received yet'}</div>`}</div>
            ${x.files.length ? html`<span class="cp-tag ok">Received</span>` : html`<span class="cp-tag done">Missing</span>`}</li>`)}
            ${extra.map((f) => html`<li><span class="sd-ic ${fileIcon(f).toLowerCase()}">${fileIcon(f)}</span><div class="sd-dm"><b>${f.kind || 'Other'}</b><div class="sub">${fileLink(f)} · ${sd(f.created_at)}</div></div><span class="cp-tag ok">Received</span></li>`)}</ul>
          <form method="post" action="${BASE}/${sc.id}/upload" enctype="multipart/form-data" data-busy class="sd-up">
            <input type="hidden" name="back" value="${back}">
            <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple required aria-label="Add shipping documents"><span class="dz-main" data-main>Add documents you received another way (drag &amp; drop or choose)</span><span class="dz-hint">Type is detected from the file name${AI.enabled() ? ' · AI reads the figures' : ''}</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <div class="sd-up-row"><select name="kind" class="sd-kind" aria-label="Document type"><option value="">Detect type</option>${['Invoice', 'Packing list', 'Bill of lading', 'Warehouse receipt', 'Loading photos', 'Other'].map((k) => html`<option>${k}</option>`)}</select><button class="btn ghost small">Upload</button></div></form>
          ${facts.summary || sc.reply_text ? html`<div class="sd-note blue">${facts.summary || ''}${sc.reply_text ? html`<details class="sd-orig"><summary>Supplier's message</summary><pre>${sc.reply_text}</pre></details>` : ''}</div>` : ''}
        </div>
        <div>
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
              <div class="sd-acts"><button class="btn">Accept &amp; save</button></div>` : ''}
          </form>` : html`<div class="sd-wait"><b>${sc.status === 'scheduled' ? `Request goes out ${sc.due_date ? PL.short(sc.due_date) : ''} at 9:00 China time` : 'Waiting for the supplier'}</b>
            <p class="sub">${sc.status === 'scheduled' ? `${supplier.name} gets one email for ${(sc.pos || []).join(', ')}, with a link to upload the documents.` : `Reminders go out 2 and 4 days after the request${sc.reminders ? ` (${sc.reminders} sent)` : ''}. When documents arrive, AI reads cartons, weight, m³ and the container number here.`}</p></div>`}
          <div class="sd-acts2">
            ${sc.status === 'scheduled' ? html`<form method="post" action="${BASE}/${sc.id}/send" class="inline"><input type="hidden" name="back" value="${back}"><button class="btn small">Send now</button></form>
              <form method="post" action="${BASE}/${sc.id}/date" class="inline sd-date"><input type="hidden" name="back" value="${back}"><input type="date" name="date" value="${sc.due_date || ''}" aria-label="Send on" data-autosubmit></form>` : ''}
            ${sc.status === 'sent' || sc.status === 'received' ? html`<form method="post" action="${BASE}/${sc.id}/send" class="inline"><input type="hidden" name="back" value="${back}"><input type="hidden" name="remind" value="1"><button class="btn ghost small">${sc.status === 'received' ? 'Ask for missing documents' : 'Send reminder'}</button></form>` : ''}
            ${AI.enabled() && docsOf(files, sc).length && sc.status !== 'complete' ? html`<form method="post" action="${BASE}/${sc.id}/reread" class="inline" data-busy><input type="hidden" name="back" value="${back}"><button class="link small">Read the documents again</button></form>` : ''}
            ${sc.status !== 'complete' ? html`<form method="post" action="${BASE}/${sc.id}/cancel" class="inline" data-confirm="Stop this request? No more emails or reminders go to the supplier."><input type="hidden" name="back" value="${back}"><button class="link small">Stop request</button></form>` : ''}
            <a class="link small" href="${SD.linkFor({ publicUrl: '' }, sc)}" target="_blank" rel="noopener">Supplier's upload page</a>
          </div>
          <details class="sd-log"><summary>Activity · ${sc.code}</summary><ul>${[...(sc.log || [])].reverse().map((x) => html`<li><span>${sd(x.at)}</span>${x.text}</li>`)}</ul></details>
        </div>
      </div></section>`;
  });
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
    const groups = { action: (r) => ['received', 'overdue', 'sent'].includes(st(r)), scheduled: (r) => st(r) === 'scheduled', complete: (r) => st(r) === 'complete', all: () => true };
    const tab = groups[req.query.tab] ? req.query.tab : 'action';
    const order = { received: 0, overdue: 1, sent: 2, scheduled: 3, complete: 4 };
    const list = rows.filter(groups[tab]).sort((a, b) => (order[st(a)] - order[st(b)]) || String(a.due_date).localeCompare(String(b.due_date)));
    const n = (k) => rows.filter((r) => st(r) === k).length;
    const soon = rows.filter((r) => st(r) === 'scheduled' && r.due_date && r.due_date <= PL.addDays(day, 7));
    const month = rows.filter((r) => st(r) === 'complete' && String(r.accepted_at || '').slice(0, 7) === day.slice(0, 7)).length;
    const stats = SD.supplierStats(rows);
    res.html(page({
      title: 'Shipping documents', nav: adminNav('shipping'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h1>Shipping documents</h1><p class="muted">One request per supplier per shipment, sent automatically at 9:00 China time on the loading date. Replies and uploads land here; AI reads the figures and you accept them.</p></div></div>
        ${missing ? html`<p class="flash warn">Run the shipping documents SQL in Supabase first (supabase/schema.sql, "Shipment confirmations").</p>` : ''}
        <div class="cp-kpis">
          <div class="cp-kpi ${n('received') ? 'warn' : ''}"><span>To review</span><b>${n('received')}</b><small>documents arrived</small></div>
          <div class="cp-kpi ${n('overdue') ? 'warn' : ''}"><span>Waiting for supplier</span><b>${n('sent') + n('overdue')}</b><small>${n('overdue') ? `${n('overdue')} overdue · ` : ''}reminders on</small></div>
          <div class="cp-kpi"><span>Scheduled</span><b>${soon.length}</b><small>${soon.length ? `next ${PL.short(soon.map((r) => r.due_date).sort()[0])}` : 'next 7 days'}</small></div>
          <div class="cp-kpi"><span>Complete this month</span><b>${month}</b><small>figures saved</small></div></div>
        <div class="or-bar"><nav class="cp-views" aria-label="Show">${[['action', 'Needs action', n('received') + n('overdue') + n('sent')], ['scheduled', 'Scheduled', n('scheduled')], ['complete', 'Complete', n('complete')], ['all', 'All', rows.length]].map(([k, l, c]) => html`<a href="${BASE}?tab=${k}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l} <span class="or-n">${c}</span></a>`)}</nav></div>
        <div class="card flush"><div class="table-wrap"><table class="list sd-table"><thead><tr><th>Supplier · POs</th><th>Shipment</th><th>Loading date</th><th>Documents</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.length ? list.map((r) => {
            const s = SD.stateOf(r, day); const cl = checklist(r, files); const url = `${poUrl(r.supplier_id, (r.pos || [])[0] || '')}#shipment`;
            return html`<tr><td><a href="${url}"><b>${sups[r.supplier_id]?.name || 'Supplier'}</b></a><div class="sub">${(r.pos || []).join(', ')}</div></td>
              <td>${shipLabel(r, cs)}${r.container_no ? html`<div class="sub">${r.container_no}</div>` : ''}</td><td>${r.due_date ? PL.short(r.due_date) : '—'}</td>
              <td><div class="sd-dots">${cl.map((x) => html`<span class="sd-d ${x.files.length ? 'y' : r.status === 'scheduled' ? '' : 'n'}" title="${x.label}">${SHORT[x.kind] || x.kind}</span>`)}</div></td>
              <td><span class="cp-tag ${s.tag}">${s.label}</span>${r.status === 'sent' && r.reminders ? html`<div class="sub">${r.reminders} reminder${r.reminders > 1 ? 's' : ''} sent</div>` : ''}${r.status === 'received' && compareRows(r).warn ? html`<div class="sub">${compareRows(r).warn} difference${compareRows(r).warn > 1 ? 's' : ''}</div>` : ''}</td>
              <td class="r"><a class="btn ${s.key === 'received' ? '' : 'ghost'} small" href="${url}">${s.key === 'received' ? 'Review' : 'Open'}</a></td></tr>`;
          }) : html`<tr><td colspan="6" class="muted">${tab === 'action' ? 'Nothing needs you right now.' : 'Nothing here yet.'} Requests are created when a container has a sailing or a loading date.</td></tr>`}</tbody></table></div></div>
        ${Object.keys(stats).length ? html`<section class="card"><h2>Supplier shipping record</h2><p class="muted small">From accepted shipments: how quickly documents come back and how close the shipped volume is to the plan.</p>
          <div class="table-wrap"><table class="list"><thead><tr><th>Supplier</th><th class="r">Shipments</th><th class="r">Days to documents</th><th class="r">Volume vs plan</th><th class="r">Shipped m³</th><th class="r">Shipped kg</th></tr></thead>
          <tbody>${Object.entries(stats).sort((a, b) => b[1].n - a[1].n).map(([id, s]) => html`<tr><td>${sups[id]?.name || 'Supplier'}</td><td class="r">${s.n}</td><td class="r">${s.days == null ? '—' : s.days.toFixed(1)}</td><td class="r ${s.vol != null && Math.abs(s.vol) > 0.05 ? 'sd-off' : ''}">${s.vol == null ? '—' : `${s.vol > 0 ? '+' : ''}${(s.vol * 100).toFixed(1)}%`}</td><td class="r">${n2(s.cbm)}</td><td class="r">${int(s.kg)}</td></tr>`)}</tbody></table></div></section>` : ''}`,
    }));
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
    try { await SD.sendRequest(db, config, sc, f.remind ? { reminder: (sc.reminders || 0) + 1 } : { by: by(req) }); flash(res, 'ok', f.remind ? 'Reminder sent' : 'Request sent'); }
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

  // ── Supplier upload page (no login; the link is the key) ─────────────────
  const bySupToken = async (token) => {
    if (!/^[\w-]{16,40}$/.test(String(token || ''))) return null;
    const sc = (await db.list('ship_confirmations', { filters: { token }, limit: 1 }).catch(() => []))[0];
    return SD.linkValid(sc) ? sc : null;
  };

  router.get('/ship/:token', async (req, res) => {
    const sc = await bySupToken(req.params.token);
    if (!sc) return res.html(page({ title: 'Link expired', nav: { label: 'Shipping documents', items: [], home: '#' }, lang: false, body: html`<section class="card narrow"><h1>This link is no longer valid</h1><p>Please reply to the email from Lulyboo with your documents attached instead.</p></section>` }), 404);
    const { supplier, c, lines } = await SD.factsOf(db, sc);
    const files = (await db.list('plan_files', { filters: { supplier_id: sc.supplier_id } }).catch(() => [])).filter((x) => x.shipment_id === sc.id);
    const fl = takeFlash(req, res);
    const lcl = sc.mode === 'LCL';
    const slots = [...SD.required(sc), ['Other', 'Other documents', 'certificate of origin, test report…']];
    res.html(page({
      title: 'Shipment confirmation', flash: fl, nav: { label: 'Shipping documents', items: [], home: '#' }, lang: false,
      body: html`<section class="card narrow sd-sup">
        <p class="sub">${supplier?.name || ''} · PO ${(sc.pos || []).join(', ')}${c ? ` · ${portName(c.port)}` : ''}</p>
        <h1>Confirm shipment</h1>
        <div class="sd-sup-pos">${lines.map((l) => html`<div><b>${l.po}</b> ${l.product || ''}<span class="sub">${[l.qty ? `${int(l.qty)} pcs` : '', l.cartons ? `${int(l.cartons)} cartons` : '', l.cbm ? `${n2(l.cbm)} m³` : ''].filter(Boolean).join(' · ')}</span></div>`)}</div>
        <form method="post" action="/ship/${sc.token}" enctype="multipart/form-data" data-busy class="sd-sup-form">
          <fieldset class="sd-seg"><legend class="sr-only">Status</legend>
            <label><input type="radio" name="state" value="loaded" checked><span>${lcl ? 'Delivered to warehouse' : sc.mode === 'FCL' ? 'Loaded' : 'Shipped'}</span></label>
            <label><input type="radio" name="state" value="delayed"><span>Delayed</span></label></fieldset>
          <div class="sd-when-loaded">
            <label>${lcl ? 'Delivery date' : 'Loading date'} <input type="date" name="loaded_on" value="${sc.loaded_on || sc.due_date || ''}"></label>
            ${sc.mode !== 'LCL' ? html`<div class="sd-two"><label>Container no. <input name="container_no" value="${sc.container_no || ''}" placeholder="e.g. CSNU6184207" autocomplete="off"></label><label>Seal no. <input name="seal_no" value="${sc.seal_no || ''}" autocomplete="off"></label></div>` : ''}
            ${slots.map(([kind, label, hint]) => { const have = files.filter((x) => x.kind === kind); return html`<label class="sd-slot ${have.length ? 'done' : ''}"><span><b>${label}</b><small>${have.length ? have.map((x) => x.name).join(', ') : hint || 'PDF, Excel or photo'}</small></span>
              <input type="file" name="f_${kind.replace(/\W+/g, '_')}" multiple ${kind === 'Loading photos' ? raw('accept="image/*,application/pdf"') : ''}></label>`; })}
          </div>
          <div class="sd-when-delayed"><label>New date <input type="date" name="new_date"></label><label>Reason (optional) <input name="reason" placeholder="e.g. waiting for packaging"></label></div>
          <label>Message (optional) <textarea name="message" rows="3"></textarea></label>
          <button class="btn sd-send">Send to Lulyboo</button>
          <p class="sub">You can come back to this page later to add the bill of lading.</p>
        </form></section>`,
    }));
  });

  router.post('/ship/:token', async (req, res) => {
    const sc = await bySupToken(req.params.token);
    if (!sc) throw new HttpError(404, 'This link is no longer valid');
    const { fields: f, files } = await parseForm(req, { limitBytes: 80 * 1024 * 1024 });
    const KIND = Object.fromEntries([...SD.required(sc).map(([k]) => k), 'Other'].map((k) => [`f_${k.replace(/\W+/g, '_')}`, k]));
    const list = [];
    for (const [name, arr] of Object.entries(files)) for (const x of [].concat(arr)) if (x.buffer?.length) list.push({ ...x, kind: KIND[name] || null });
    const delayed = f.state === 'delayed';
    if (delayed && !PL.isoDay(f.new_date)) throw new HttpError(400, 'Choose the new date');
    if (!delayed && !list.length && !f.container_no && !f.message) throw new HttpError(400, 'Add at least one document');
    const text = [delayed ? `Delayed to ${f.new_date}${f.reason ? `: ${f.reason}` : ''}` : '', f.message || ''].filter(Boolean).join('\n');
    const form = delayed ? { delayed: true, new_date: f.new_date, summary: `Supplier reported a delay to ${PL.short(PL.isoDay(f.new_date))}${f.reason ? ` (${String(f.reason).slice(0, 200)})` : ''}.` }
      : { loaded: true, loaded_on: f.loaded_on, container_no: f.container_no, seal_no: f.seal_no, summary: f.message ? `Supplier wrote: ${String(f.message).slice(0, 300)}` : '' };
    await SD.receive(db, config, sc, { text, files: list, form });
    flash(res, 'ok', delayed ? 'Thank you — we noted the new date.' : 'Thank you — your documents were sent to Lulyboo.');
    res.redirect(`/ship/${sc.token}`);
  });
};
module.exports.shipmentSection = shipmentSection;
