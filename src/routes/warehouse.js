'use strict';
// Operations → Warehouse: containers from the port to our warehouse (src/warehouse.js).
//   GET  /admin/warehouse                       small dashboard + deliveries + documents to collect + received
//   POST /admin/warehouse/update                paste / drop a trucker or forwarder email → matched to its container
//   POST /admin/warehouse/:id/plan              edit the delivery plan (LFD, appointment, day, time, who receives it)
//   POST /admin/warehouse/:id/confirm           confirm the plan by email (popup)
//   POST /admin/warehouse/:id/files             add delivery order / POD / warehouse receipt
//   POST /admin/warehouse/:id/ask               ask the responsible person to upload what's missing

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const ST = require('../staff');
const PL = require('../planning');
const WH = require('../warehouse');
const { ddSel } = require('./logistics-costs');

const BASE = '/admin/warehouse';
const SHP = '/admin/orders/shipments';
const sh = (d) => (d ? PL.short(String(d).slice(0, 10)) : '—');
const wk = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) : '');

module.exports = function warehouseRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => ST.current()?.name || req.staff?.name || 'admin';

  router.get(BASE, G(async (req, res) => {
    const today = WH.laNow().day; const tmr = PL.addDays(today, 1); const wkEnd = PL.addDays(today, 7);
    const rows = await WH.board(db, today);
    const open = rows.filter((x) => !x.r.delivered);
    const kTod = open.filter((x) => x.d.date === today); const kTmr = open.filter((x) => x.d.date === tmr);
    const kWeek = open.filter((x) => x.d.date && x.d.date <= wkEnd && x.d.date >= today);
    const risk = open.filter((x) => x.risk); const docs = rows.filter((x) => x.state === 'docs');
    const lastResp = rows.map((x) => x.d).filter((d) => d.resp_email).sort((a, b) => String(b.log?.at(-1)?.at || '').localeCompare(String(a.log?.at(-1)?.at || '')))[0] || {};
    const groups = [['Today', (x) => x.d.date === today], ['Tomorrow', (x) => x.d.date === tmr], ['This week', (x) => x.d.date > tmr && x.d.date <= wkEnd], ['Later', (x) => x.d.date > wkEnd], ['Past due — not delivered', (x) => x.d.date && x.d.date < today], ['Delivery not booked yet', (x) => !x.d.date]];
    const STATE = { to_confirm: ['To confirm', 'warn'], confirmed: ['Confirmed', 'ok'], planned: ['Planned', 'bk'], unplanned: ['Not booked', ''] };
    const lfdTag = (x) => (x.lfd ? html`<span class="wh-lfd ${x.r.delivered ? '' : x.lfdLeft < 0 ? 'bad' : x.lfdLeft <= 1 ? 'bad' : x.lfdLeft <= 3 ? 'warn' : ''}" title="Last free day at the port">LFD ${sh(x.lfd)}${x.r.delivered ? '' : x.lfdLeft < 0 ? ` · ${-x.lfdLeft}d over` : x.lfdLeft === 0 ? ' · today' : ` · ${x.lfdLeft}d`}</span>` : html`<span class="sub">LFD —</span>`);
    const docTiles = (x) => html`<span class="wh-docs">${WH.DOCS.map(([k, s]) => { const fs = x.docs[k]; const need = x.r.delivered && WH.REQUIRED.includes(k); return html`<span class="wh-doc ${fs.length ? 'ok' : need ? 'miss' : ''}" title="${fs.length ? fs.map((f) => f.name).join('\n') : `${k}: ${need ? 'missing' : 'not yet'}`}">${fs.length ? html`<a href="${`${SHP}/${x.r.id}/file/${fs[0].i}?inline=1`}" target="_blank" rel="noopener">${s} ✓</a>` : s}</span>`; })}</span>`;
    const planDlg = (x) => html`<dialog id="${`wh-plan-${x.r.id}`}" class="rp-modal wh-dlg" aria-labelledby="${`wh-plan-${x.r.id}-t`}"><form method="post" action="${`${BASE}/${x.r.id}/plan`}" data-busy>
      <div class="rp-top"><h2 id="${`wh-plan-${x.r.id}-t`}">Delivery plan · ${x.r.title}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
      <div class="wh-g3"><label>Last free day <input type="date" name="lfd" value="${x.d.lfd || x.lfd || ''}"></label><label>Port appointment <input type="date" name="port_appt" value="${x.d.port_appt || ''}"></label><label>Empty return by <input type="date" name="empty_return" value="${x.d.empty_return || ''}"></label>
        <label>Delivery day <input type="date" name="date" value="${x.d.date || ''}"></label><label>Time <input name="time" value="${x.d.time || ''}" placeholder="8:30am"></label><label>Trucker <input name="trucker" value="${x.d.trucker || ''}" placeholder="e.g. AFTY LAX"></label></div>
      <label>Deliver to <input name="warehouse" value="${x.d.warehouse || x.r.c.delivered_to || 'Bake Warehouse, 15041 Bake Pkwy, Irvine'}"></label>
      <div class="wh-g2"><label>Receives it <input name="resp_name" value="${x.d.resp_name || lastResp.resp_name || ''}" placeholder="name"></label><label>Their email <input type="email" name="resp_email" value="${x.d.resp_email || lastResp.resp_email || ''}" placeholder="asked for the POD + receipt after delivery"></label></div>
      <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save plan</button></div></form></dialog>`;
    const confDlg = (x) => { const m = WH.confirmDraft(x.r.c, x.r.title); return html`<dialog id="${`wh-conf-${x.r.id}`}" class="rp-modal wh-dlg" aria-labelledby="${`wh-conf-${x.r.id}-t`}"><form method="post" action="${`${BASE}/${x.r.id}/confirm`}" data-busy>
      <div class="rp-top"><h2 id="${`wh-conf-${x.r.id}-t`}">Confirm delivery plan · ${x.r.title}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
      <div class="wh-g2"><label>To <input name="to" value="${m.to.join(', ')}" required></label><label>Cc <input name="cc" value="marsel@lulyboo.com"></label></div>
      <label>Subject <input name="subject" value="${m.subject}"></label><label>Message <textarea name="body" rows="9">${m.body}</textarea></label>
      <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Send confirmation</button></div></form></dialog>`; };
    const upd = (x) => { const u = (x.d.updates || []).at(-1); return u ? html`<span class="wh-upd" tabindex="0" data-popcard>${sh(u.at)} update<span class="or-pc-card" data-wide><b class="ht-h">Updates</b><div class="rc-rows">${[...x.d.updates].reverse().slice(0, 5).map((v) => html`<div><span>${sh(v.at)}</span><span>${v.summary || v.subject || 'update'}${v.from ? html` <i class="sub">${v.from}</i>` : ''}</span></div>`)}</div></span></span>` : ''; };
    const row = (x) => { const s = STATE[x.state] || STATE.unplanned; const c = x.r.c;
      return html`<tr id="${`c-${c.id}`}" class="${x.risk ? 'risk' : ''}">
        <td class="wh-when">${x.d.date ? html`<b>${x.d.time || '—'}</b><div class="sub">${wk(x.d.date)} ${sh(x.d.date)}</div>` : html`<span class="sub">—</span>`}</td>
        <td><a href="${`${SHP}/${x.r.id}`}"><b>${x.r.title.split('·')[0].trim()}</b></a>${(() => { const n = c.container_no || x.r.f.container_no || ''; return n && !x.r.title.replace(/\W/g, '').includes(n.replace(/\W/g, '')) ? html` <span class="cu-mono sub">${n}</span>` : ''; })()}<span class="sub"> · ${c.box || ''}</span><div class="sub trunc" title="${x.r.suppliers.join(', ')}">${x.r.suppliers.slice(0, 2).join(', ')}${x.r.suppliers.length > 2 ? ` +${x.r.suppliers.length - 2}` : ''}</div></td>
        <td class="r">${x.r.cartons ? html`${x.r.cartons}<span class="sub"> ctns</span>` : '—'}<div class="sub">${x.r.cbm ? `${x.r.cbm.toFixed(1)} m³` : ''}</div></td>
        <td>${lfdTag(x)}<div class="sub">${x.r.arrivedOn ? `arrived ${sh(x.r.arrivedOn)}` : x.r.eta ? `ETA ${sh(x.r.eta)}` : ''}${x.d.port_appt ? ` · port appt ${sh(x.d.port_appt)}` : ''}</div></td>
        <td><span class="cp-tag ${x.risk && x.state === 'unplanned' ? 'bad' : s[1]}">${x.risk && x.state === 'unplanned' ? 'Book now' : s[0]}</span>${x.d.trucker ? html`<div class="sub">${x.d.trucker}</div>` : ''}${upd(x)}</td>
        <td>${docTiles(x)}</td>
        <td class="sub">${x.d.resp_name || x.d.resp_email || '—'}</td>
        <td class="r wh-act">${x.state === 'to_confirm' ? html`<button type="button" class="btn small" data-open-dialog="${`wh-conf-${x.r.id}`}">Confirm…</button>` : ''}<button type="button" class="d-btn" data-open-dialog="${`wh-plan-${x.r.id}`}">${x.d.date ? 'Edit' : 'Plan'}</button><a class="link small" href="${`${SHP}/${x.r.id}`}" title="Mark received with the counts on the shipment page">Receive →</a></td></tr>`; };
    const docRow = (x) => { const asked = x.d.docs_asked || [];
      return html`<div class="wh-dr" id="${`c-${x.r.c.id}`}"><div><a href="${`${SHP}/${x.r.id}`}"><b>${x.r.title.split('·')[0].trim()}</b></a> <span class="sub">delivered ${sh(x.r.delivered)} · ${x.r.suppliers.slice(0, 2).join(', ')}</span><div>${x.missing.map((k) => html`<span class="wh-doc miss">${k} missing</span> `)}<span class="sub">${asked.length ? `asked ${asked.map(sh).join(', ')}${x.d.resp_email ? ` · ${x.d.resp_email}` : ''}` : 'not asked yet'}</span></div></div>
        <form method="post" action="${`${BASE}/${x.r.c.id}/files`}" enctype="multipart/form-data" data-busy class="wh-up"><div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple aria-label="${`Documents for ${x.r.title}`}"><span class="dz-main" data-main>Drop or paste POD / receipt</span></div><ul class="dz-list" data-list></ul></div>${ddSel('kind', '', [['', 'Detect'], ...WH.DOCS.map(([k]) => [k, k])])}<button class="btn small ghost">Add</button></form>
        <form method="post" action="${`${BASE}/${x.r.c.id}/ask`}" class="inline"><button class="link small" data-confirm="Email the person receiving it to upload the missing documents?">${asked.length ? 'Ask again' : 'Ask to upload'}</button></form></div>`; };
    const kpi = (label, n, sub, cls = '') => html`<div class="d-kpi wh-k ${n && cls ? cls : ''}"><span>${label}</span><b>${n}</b><small>${sub}</small></div>`;
    const done = rows.filter((x) => x.state === 'done');
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    const inboxItems = [...(st?.warehouse_inbox || [])].reverse();
    res.html(page({
      title: 'Warehouse', nav: adminNav('warehouse'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h1>Warehouse</h1><p class="muted">Containers from the port to the warehouse — delivery plans, last free days and documents.</p></div>
          <div class="cp-head-r"><button type="button" class="btn" data-open-dialog="wh-add">+ Add update</button></div></div>
        <div class="d-kpis wh-kpis">${kpi('Today', kTod.length, kTod.map((x) => `${x.d.time || ''} ${x.r.title.split('·')[0].trim()}`.trim()).join(' · ') || 'no deliveries', 'accent')}${kpi('Tomorrow', kTmr.length, kTmr.map((x) => `${x.d.time || ''} ${x.r.title.split('·')[0].trim()}`.trim()).join(' · ') || 'no deliveries', 'accent')}
          ${kpi('Next 7 days', kWeek.length, `${kWeek.reduce((a, x) => a + (x.r.cartons || 0), 0)} cartons`)}${kpi('LFD at risk', risk.length, risk.length ? risk.map((x) => `${x.r.title.split('·')[0].trim()} ${sh(x.lfd)}`).join(' · ') : 'none', 'danger')}${kpi('Documents missing', docs.length, docs.length ? 'POD / receipt to collect' : 'all filed', 'warn')}</div>
        ${inboxItems.length ? html`<section class="card wh-inbox" id="inbox"><div class="in-sh"><h3 class="in-h">To assign <span class="cp-tag warn">${inboxItems.length}</span></h3><span class="sub">Delivery emails the portal couldn't match to a container</span></div>
          ${inboxItems.map((m) => html`<div class="wh-ib"><div><b>${m.subject || '(no subject)'}</b><div class="sub">${m.from || ''} · ${sh(m.at)}${m.container_no ? ` · container ${m.container_no}` : ''}${m.files?.length ? ` · ${m.files.length} file${m.files.length > 1 ? 's' : ''}` : ''}</div>${m.summary ? html`<div class="sub">${m.summary}</div>` : ''}</div>
            <form method="post" action="${`${BASE}/inbox/${m.id}/assign`}" class="wh-ia" data-busy>${ddSel('container', '', [['', 'Choose container…'], ...open.map((x) => [x.r.c.id, `${x.r.title.split('·')[0].trim()}${x.r.c.container_no && !x.r.title.includes(x.r.c.container_no.slice(4)) ? ` ${x.r.c.container_no}` : ''} · ${x.r.suppliers[0] || ''}`])])}<button class="btn small">Assign</button></form>
            <form method="post" action="${`${BASE}/inbox/${m.id}/dismiss`}" class="inline"><button class="link small">Not a delivery</button></form></div>`)}</section>` : ''}
        <section class="card"><div class="in-sh"><h3 class="in-h">Deliveries</h3><span class="sub">CC <b>${WH.inbox()}</b> on trucker emails — read and filed automatically · Telegram 7:00 today, 15:00 tomorrow</span></div>
          ${open.length ? html`<div class="ss-wrap"><table class="ss-t wh-t"><thead><tr><th>Delivery</th><th>Container</th><th class="r">Cargo</th><th>Port</th><th>Plan</th><th>Documents</th><th>Receives</th><th></th></tr></thead>
            ${groups.map(([g, fn]) => { const xs = open.filter(fn).sort((a, b) => String(a.d.date || a.r.eta || '').localeCompare(String(b.d.date || b.r.eta || '')) || String(a.d.time || '').localeCompare(String(b.d.time || ''))); return xs.length ? html`<tbody><tr class="wh-grp"><th colspan="8">${g} <span class="sub">${xs.length}</span></th></tr>${xs.map(row)}</tbody>` : ''; })}</table></div>` : html`<p class="d-empty">Nothing on its way to the warehouse.</p>`}</section>
        ${docs.length ? html`<section class="card"><div class="in-sh"><h3 class="in-h">Documents to collect</h3><span class="sub">Delivered — POD and warehouse receipt still missing</span></div>${docs.map(docRow)}</section>` : ''}
        ${done.length ? html`<section class="card"><div class="in-sh"><h3 class="in-h">Received · last 3 weeks</h3></div><div class="wh-done">${done.map((x) => html`<div class="wh-dn"><a href="${`${SHP}/${x.r.id}`}"><b>${x.r.title.split('·')[0].trim()}</b></a><span class="sub">${sh(x.r.delivered)} · ${x.r.suppliers.slice(0, 2).join(', ')}</span>${docTiles(x)}</div>`)}</div></section>` : ''}
        ${open.map(planDlg)}${open.filter((x) => x.state === 'to_confirm').map(confDlg)}
        <dialog id="wh-add" class="rp-modal wh-dlg" aria-labelledby="wh-add-t"><form method="post" action="${`${BASE}/update`}" enctype="multipart/form-data" data-busy>
          <div class="rp-top"><h2 id="wh-add-t">Add a delivery update</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
          <p class="sub">A trucker or forwarder email — delivery plan, LFD, port appointment, POD. AI reads it and finds the container by its number, the B/L, the forwarder's file number or NB0025. Tip: CC <b>${WH.inbox()}</b> and it arrives here by itself.</p>
          <label>Email text <textarea name="text" rows="7" placeholder="Paste the email — subject and body"></textarea></label>
          <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple aria-label="Files"><span class="dz-main" data-main>Drop or paste (⌘V) a screenshot, DO, POD or receipt</span></div><ul class="dz-list" data-list></ul></div>
          <label>Container <span class="sub">if it can't be found automatically</span>${ddSel('container', '', [['', 'Find automatically'], ...open.map((x) => [x.r.c.id, `${x.r.title.split('·')[0].trim()} ${x.r.c.container_no || ''}`])])}</label>
          <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Add &amp; read</button></div></form></dialog>`,
    }));
  }));

  const one = async (id) => { const c = await db.get('plan_containers', id).catch(() => null); if (!c) throw new HttpError(404, 'Container not found'); return c; };
  const titleOf = (c) => require('../shipname').shipName(c).split('·')[0].trim();
  router.post(`${BASE}/update`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const list = (files.file || []).filter((x) => x.buffer?.length); const text = String(f.text || '').trim();
    if (!text && !list.length) { flash(res, 'warn', 'Paste the email or add a file'); return res.redirect(BASE); }
    try {
      const out = await WH.ingest(db, config, { text, files: list, by: by(req), containerId: f.container || null });
      if (!out.c) flash(res, 'warn', `Couldn't tell which container this is${out.r.container_no ? ` (${out.r.container_no})` : ''} — choose it in "Container" and add it again.`);
      else { const d = out.c.delivery || {}; flash(res, 'ok', `${titleOf(out.c)}: ${out.r.summary || 'updated'}${d.status === 'to_confirm' ? ' — they ask you to confirm' : ''}`); return res.redirect(`${BASE}#c-${out.c.id}`); }
    } catch (e) { flash(res, 'warn', WH.isMissing(e) ? 'Run supabase/warehouse.sql in Supabase first' : e.message); }
    res.redirect(BASE);
  }));
  router.post(`${BASE}/inbox/:item/assign`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    if (!f.container) { flash(res, 'warn', 'Choose the container'); return res.redirect(`${BASE}#inbox`); }
    try { const out = await WH.assign(db, config, req.params.item, f.container, by(req)); flash(res, 'ok', `${titleOf(out.c)}: ${out.r.summary || 'updated'}`); return res.redirect(`${BASE}#c-${out.c.id}`); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(BASE);
  }));
  router.post(`${BASE}/inbox/:item/dismiss`, G(async (req, res) => { await WH.dismiss(db, req.params.item); flash(res, 'ok', 'Removed'); res.redirect(BASE); }));
  router.post(`${BASE}/:id/plan`, G(async (req, res) => {
    const { fields: f } = await parseForm(req); const c = await one(req.params.id);
    try { await WH.setPlan(db, c, f, by(req)); flash(res, 'ok', `${titleOf(c)}: plan saved`); } catch (e) { flash(res, 'warn', WH.isMissing(e) ? 'Run supabase/warehouse.sql in Supabase first' : e.message); }
    res.redirect(`${BASE}#c-${c.id}`);
  }));
  router.post(`${BASE}/:id/confirm`, G(async (req, res) => {
    const { fields: f } = await parseForm(req); const c = await one(req.params.id);
    const list = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /@/.test(x));
    try { await WH.confirm(db, config, c, { to: list(f.to), cc: list(f.cc), subject: String(f.subject || '').slice(0, 300), body: String(f.body || ''), by: by(req) }); flash(res, 'ok', `${titleOf(c)}: plan confirmed`); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(`${BASE}#c-${c.id}`);
  }));
  router.post(`${BASE}/:id/files`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 }); const c = await one(req.params.id);
    const list = (files.file || []).filter((x) => x.buffer?.length); if (!list.length) { flash(res, 'warn', 'Drop a file first'); return res.redirect(BASE); }
    const add = [];
    for (const x of list) { const path = `delivery/${c.id}/${Date.now().toString(36)}-${String(x.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`; await db.docs.upload(path, x.buffer, x.type || 'application/octet-stream'); add.push({ name: String(x.name).slice(0, 160), path, type: x.type || '', kind: WH.DOCS.some(([k]) => k === f.kind) ? f.kind : WH.kindOf(x.name), by: by(req), at: new Date().toISOString() }); }
    await db.update('plan_containers', { id: c.id }, { delivery_files: [...(c.delivery_files || []), ...add], updated_at: new Date().toISOString() });
    flash(res, 'ok', `Added ${add.map((x) => x.kind).join(', ')}`); res.redirect(`${BASE}#c-${c.id}`);
  }));
  router.post(`${BASE}/:id/ask`, G(async (req, res) => {
    const c = await one(req.params.id);
    try { const r = await WH.requestDocs(db, config, c, titleOf(c), { by: by(req) }); flash(res, r.skipped ? 'ok' : r.to.length ? 'ok' : 'warn', r.skipped ? 'Nothing missing' : r.to.length ? `Asked ${r.to.join(', ')}` : 'Sent to Telegram only — add who receives it under Edit'); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(BASE);
  }));
};
