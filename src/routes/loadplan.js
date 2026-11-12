'use strict';
// Container planning → Load containers: drag open PO lines into 20GP / 40GP / 40HQ containers,
// pick a sailing, and see how full each box is. Assignments are saved as plan_orders.container_id.

const { html, raw } = require('../lib/html');
const { parseForm, takeFlash, HttpError } = require('../lib/http');
const { sendEmail } = require('../email');
const Q = require('../quotes');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const SC = require('../schedules');
const SCR = require('./schedules');

const BASE = '/admin/logistics/planning';
const BOX = {
  '20GP': { name: "20' GP", cap: 25, inner: 33.2, cols: 6, rows: 5 },
  '40GP': { name: "40' GP", cap: 55, inner: 67.7, cols: 12, rows: 5 },
  '40HQ': { name: "40' HQ", cap: 65, inner: 76.4, cols: 12, rows: 6 },
  // Less than container load: no box to fill, priced per freight ton (W/M = the larger of m³ and tonnes).
  LCL: { name: 'LCL', cap: 15, lcl: true, zone: [12, 20] },
};
const STATUSES = ['planned', 'requested', 'booked'];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emails = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const n2 = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
const int = (v) => Number(v || 0).toLocaleString('en-US');
const COLORS = ['#d9634f', '#3b7dd8', '#2f9e6a', '#8e5bd1', '#d39a2a', '#1f9bb0', '#c2477f', '#6b8e23', '#7a6a58', '#b4473b'];
const missingTable = (e) => /plan_containers|plan_quotes|forwarders|container_id|PGRST20[45]|relation|column/i.test(e?.message || '');
const portName = (c) => SC.PORT[c]?.name || c;

/** Short label for a sailing, e.g. "COSCO · ETD Nov 28 → Long Beach · 15 d". */
const sailLabel = (s) => [s.carrier, `ETD ${PL.short(s.etd)} → ${SC.PORT[s.destination]?.name || s.destination}`, s.transit_days ? `${s.transit_days} d` : null].filter(Boolean).join(' · ');

/** Containers + their lines, for the Orders pages. Returns { byId, labelFor(line) }. */
async function containerIndex(db) {
  const cs = await db.list('plan_containers', { order: 'created_at.asc' }).catch(() => []);
  const sIds = [...new Set(cs.map((c) => c.sailing_id).filter(Boolean))];
  const sails = Object.fromEntries((await Promise.all(sIds.map((id) => db.get('sailings', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
  const n = {};
  const byId = {};
  for (const c of cs) { n[c.port] = (n[c.port] || 0) + 1; byId[c.id] = { ...c, no: n[c.port], sailing: sails[c.sailing_id] || null }; }
  const labelFor = (line) => {
    const c = line?.container_id && byId[line.container_id];
    if (!c) return null;
    return { c, text: [`${portName(c.port)} · ${c.box === 'LCL' ? 'LCL shipment' : 'Container'} ${c.no}`, c.box === 'LCL' ? null : BOX[c.box]?.name || c.box, c.sailing ? `ETD ${PL.short(c.sailing.etd)}` : null, c.status === 'booked' ? 'Booked' : c.status === 'requested' ? 'Quotes requested' : c.status === 'shipped' ? 'Shipped' : 'Planned'].filter(Boolean).join(' · '), url: `${BASE}/load?port=${c.port}` };
  };
  return { byId, labelFor };
}

function loadPlanRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const now = () => new Date().toISOString();

  router.get(`${BASE}/load`, G(async (req, res) => {
    const day = PL.today();
    let lines = []; let missing = false;
    try { lines = (await db.list('plan_orders', { order: 'ready_date.asc' })).filter((l) => !l.shipped); }
    catch (e) { if (/plan_orders|PGRST205|relation/i.test(e.message)) missing = true; else throw e; }
    let containers = [];
    try { containers = await db.list('plan_containers', { order: 'created_at.asc' }); }
    catch (e) { if (missingTable(e)) missing = true; else throw e; }

    const known = SC.ORIGINS.map((p) => p.code);
    const ports = [...new Set([...known.filter((k) => lines.some((l) => l.port === k)), ...lines.map((l) => l.port).filter(Boolean)])];
    if (!ports.length) ports.push(...known.slice(0, 1));
    const port = ports.includes(req.query.port) ? req.query.port : (req.query.port && /^[A-Z]{5}$/.test(req.query.port) ? req.query.port : ports[0]);
    if (!ports.includes(port)) ports.push(port);

    const supIds = [...new Set(lines.map((l) => l.supplier_id))];
    const sups = Object.fromEntries((await Promise.all(supIds.map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((s) => [s.id, s]));
    const numbered = containers.filter((c) => c.port === port).map((c, i) => ({ ...c, no: i + 1 }));
    const portCs = numbered.filter((c) => c.status !== 'shipped');
    const cIds = new Set(portCs.map((c) => c.id));
    const here = lines.filter((l) => l.port === port);
    const noPort = lines.filter((l) => !l.port).length;
    const sail = await db.list('sailings', { filters: { origin: port, etd: ['gte', day] }, order: 'etd.asc', limit: 40 }).catch(() => []);
    for (const c of portCs) if (c.sailing_id && !sail.some((s) => s.id === c.sailing_id)) { const s = await db.get('sailings', c.sailing_id).catch(() => null); if (s) sail.unshift(s); }

    let quotes = [];
    if (portCs.length) quotes = await db.list('plan_quotes', { order: 'created_at.asc' }).catch(() => []);
    const qOf = (c) => quotes.filter((q) => q.container_id === c.id).map((q) => ({
      id: q.id, code: q.code, company: q.company || 'Forwarder', to: q.to_email || '', status: q.status, sent: q.sent_at ? PL.short(String(q.sent_at).slice(0, 10)) : '',
      replied: q.replied_at ? PL.short(String(q.replied_at).slice(0, 10)) : '', total: q.total_usd != null ? Number(q.total_usd) : null, ocean: q.ocean_usd != null ? Number(q.ocean_usd) : null, currency: q.currency || '',
      carrier: q.carrier || '', vessel: q.vessel || '', etd: q.etd || '', eta: q.eta || '', etdText: q.etd ? PL.short(q.etd) : '', etaText: q.eta ? PL.short(q.eta) : '', transit: q.transit_days ?? null,
      cy: q.cy_cutoff || '', valid: q.valid_until || '', validText: q.valid_until ? PL.short(q.valid_until) : '', expired: !!(q.valid_until && q.valid_until < day), free: q.free_days ?? null,
      summary: q.summary || '', notes: q.notes || '', from: q.reply_from || '', reply: q.reply_text ? String(q.reply_text).slice(0, 8000) : '', charges: Array.isArray(q.charges) ? q.charges.slice(0, 20) : [],
      files: (Array.isArray(q.files) ? q.files : []).map((f, i) => ({ name: f.name, url: `${BASE}/quotes/${q.id}/files/${i}`, inline: /^(image\/|application\/pdf)/.test(f.type || '') })),
    }));
    const data = {
      base: BASE, port, portName: portName(port), today: day, box: BOX,
      orders: here.map((o, i) => ({
        id: o.id, po: o.po, supplier: sups[o.supplier_id]?.name || 'Supplier', product: o.product || '', qty: Number(o.qty) || 0,
        cartons: Number(o.cartons) || 0, kg: Number(o.gross_kg) || 0, carton: [o.carton_l_cm, o.carton_w_cm, o.carton_h_cm].every((x) => Number(x) > 0) ? [o.carton_l_cm, o.carton_w_cm, o.carton_h_cm].map(Number) : null,
        cbm: o.cbm ? Number(o.cbm) : null, est: !!o.cbm_estimated, ready: o.ready_date || null, readyText: o.ready_date ? PL.short(o.ready_date) : '',
        st: PL.state(o, day), container: cIds.has(o.container_id) ? o.container_id : null, color: COLORS[i % COLORS.length],
      })),
      containers: portCs.map((c) => ({ id: c.id, no: c.no, box: BOX[c.box] ? c.box : '40GP', sailing: c.sailing_id || '', loading: c.loading_date ? String(c.loading_date).slice(0, 10) : '', containerNo: c.container_no || '', status: c.status || 'planned', requestTo: c.request_to || '', requestedAt: c.requested_at ? PL.short(String(c.requested_at).slice(0, 10)) : '', quotes: qOf(c) })),
      sailings: sail.map((s) => ({ id: s.id, label: sailLabel(s), etd: s.etd })),
      states: Object.fromEntries(Object.entries(PL.STATE).map(([k, v]) => [k, { label: v.label, tag: v.tag }])),
    };
    const tabs = html`<nav class="cp-views" aria-label="Views">${[['port', 'By port'], ['load', 'Load containers'], ['timeline', 'Timeline'], ['table', 'Table'], ['docs', 'Documents']].map(([k, l]) => html`<a href="${k === 'load' ? `${BASE}/load` : `${BASE}?view=${k}`}" class="${k === 'load' ? 'on' : ''}" ${k === 'load' ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

    res.html(page({
      title: 'Load containers · Container planning', nav: adminNav('load'), flash: takeFlash(req, res), wide: true, req,
      body: html`${SCR.logisticsTabs('planning')}
        ${missing ? html`<p class="flash warn">Run the container loading SQL in Supabase first (supabase/schema.sql, "Container load plans").</p>` : ''}
        <div class="cp-head"><div><h2 class="sl-title">Container planning</h2><p class="muted">Drag open PO lines into a container. Cartons load in and the bar shows how full it is.</p></div>
          <div class="cp-head-r">${tabs}<a class="btn" href="${BASE}/import">Import orders</a></div></div>
        <div class="lp-ports"><div class="lp-seg">${ports.map((p) => html`<a href="${BASE}/load?port=${p}" class="${p === port ? 'on' : ''}">${portName(p)} <span>${p}</span></a>`)}</div>
          <span class="muted small">Each container belongs to one loading port.${noPort ? html` <a href="${BASE}?view=table">${noPort} open line${noPort === 1 ? ' has' : 's have'} no port yet</a> — set it to load ${noPort === 1 ? 'it' : 'them'}.` : ''}</span></div>
        <div class="lp" data-loadplan="${JSON.stringify(data)}">
          <aside class="card lp-pool-card"><h2 class="sec">Not loaded yet</h2><div class="sub" data-lp-poolmeta></div>
            <div class="lp-pool" data-lp-pool></div>
            <p class="sub lp-note">Lines without volume can't be loaded — type the CBM from the supplier's packing list first. It's saved to the PO.</p></aside>
          <div class="lp-main"><div data-lp-containers></div><div class="lp-tip" data-lp-tip hidden></div><button type="button" class="lp-add" data-lp-add>+ Add container</button></div>
        </div>
        <div class="lp-toast" data-lp-toast role="status" aria-live="polite"></div>
        <dialog class="rp-modal" data-lp-req aria-labelledby="lp-req-t"><form data-lp-req-form>
          <div class="rp-top"><h2 id="lp-req-t">Request quotations</h2><button type="button" class="icon-btn" data-lp-req-close aria-label="Close">×</button></div>
          <p class="sub rp-ctx">Each forwarder you tick gets their own formal email with a reference in the subject. Their replies come back here and AI reads the rate, ETD and ETA.</p>
          <div class="rp-loading" data-lp-req-loading>Preparing the packing list…</div>
          <div class="rp-fields" data-lp-req-fields hidden>
            <fieldset class="lp-fw"><legend>Send to <a class="link small" href="/admin/logistics/forwarders" target="_blank" rel="noopener">Manage forwarders</a></legend>
              <div class="lp-fw-list" data-lp-fw-list></div>
              <details class="lp-fw-add" data-lp-fw-add><summary>+ Add a forwarder</summary>
                <div class="lp-fw-addrow"><input data-nf="company" placeholder="Company" aria-label="Company"><input data-nf="contact_name" placeholder="Contact person" aria-label="Contact person"><input data-nf="email" type="email" placeholder="email@forwarder.com" aria-label="Email"><button type="button" class="btn small" data-lp-fw-save>Add</button></div></details></fieldset>
            <label>CC <input name="cc" type="text" placeholder="optional, e.g. yourself — comma separated" autocomplete="off"></label>
            <label>Subject <input name="subject" type="text" required><span class="sub lp-hint">The reference (LBQ-…) is added for each forwarder.</span></label>
            <label class="cp-chk lp-req-chk"><input type="checkbox" name="contacts" value="1" data-lp-req-contacts> Include supplier contact details (for pickup / CFS delivery)</label>
            <label class="cp-chk lp-req-chk" data-lp-req-bothrow hidden><input type="checkbox" name="both" value="1" data-lp-req-both> Also ask for a 20' GP price, to compare with LCL</label>
            <label>Message <textarea name="body" rows="18" required></textarea><span class="sub lp-hint">{contact} becomes each forwarder's contact name.</span></label>
            <div class="rp-actions"><button class="btn" data-lp-req-send>Send requests</button><button type="button" class="btn ghost" data-lp-req-close>Cancel</button><span class="sub" data-lp-req-note></span></div>
          </div></form></dialog>
        <dialog class="rp-modal lp-qdlg" data-lp-q aria-labelledby="lp-q-t"><form data-lp-q-form>
          <div class="rp-top"><h2 id="lp-q-t">Quote</h2><button type="button" class="icon-btn" data-lp-q-close aria-label="Close">×</button></div>
          <p class="sub rp-ctx" data-lp-q-sub></p>
          <div class="lp-qgrid">
            <label>All-in total (USD) <input name="total_usd" type="number" step="0.01" min="0"></label>
            <label>Ocean freight (USD) <input name="ocean_usd" type="number" step="0.01" min="0"></label>
            <label>Carrier <input name="carrier"></label><label>Vessel / voyage <input name="vessel"></label>
            <label>ETD <input name="etd" type="date"></label><label>ETA <input name="eta" type="date"></label>
            <label>CY cut-off <input name="cy_cutoff" type="date"></label><label>Valid until <input name="valid_until" type="date"></label>
            <label>Free days at destination <input name="free_days" type="number" min="0"></label><label>Status <select name="status"><option value="sent">Waiting for reply</option><option value="replied">Quoted</option><option value="declined">Declined</option><option value="chosen">Chosen</option></select></label>
          </div>
          <label class="lp-qnote">Notes <textarea name="notes" rows="3"></textarea></label>
          <div class="rp-actions"><button class="btn">Save</button><button type="button" class="btn ghost" data-lp-q-close>Cancel</button><span class="sub" data-lp-q-note></span></div></form></dialog>`,
    }));
  }));

  const json = (fn) => G(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req, res)) }); }
    catch (e) { res.json({ ok: false, error: missingTable(e) ? 'Run the container loading SQL in Supabase first.' : e.provider?.reason ? `${e.message} (${e.provider.reason})` : e.message }, e.status || 400); }
  });
  const getContainer = async (id) => { const c = await db.get('plan_containers', id).catch(() => null); if (!c) throw new HttpError(404, 'Container not found'); return c; };

  router.post(`${BASE}/containers`, json(async (req) => {
    const { fields: f } = await parseForm(req);
    const port = String(f.port || '').toUpperCase();
    if (!/^[A-Z]{5}$/.test(port)) throw new HttpError(400, 'Choose a loading port');
    const no = (await db.list('plan_containers', { filters: { port } }).catch(() => [])).length + 1;
    const c = await db.insert('plan_containers', { port, box: BOX[f.box] ? f.box : '40GP', status: 'planned', created_by: req.staff?.name || 'Owner', created_at: now(), updated_at: now() });
    return { container: { id: c.id, no, box: c.box, sailing: '', status: 'planned' } };
  }));

  router.post(`${BASE}/containers/:id`, json(async (req) => {
    const c = await getContainer(req.params.id);
    const { fields: f } = await parseForm(req);
    const patch = { updated_at: now() };
    if (f.box !== undefined) { if (!BOX[f.box]) throw new HttpError(400, 'Unknown container type'); patch.box = f.box; }
    if (f.sailing !== undefined) patch.sailing_id = f.sailing || null;
    if (f.loading_date !== undefined) patch.loading_date = PL.isoDay(f.loading_date) || null;
    if (f.status !== undefined) { if (!STATUSES.includes(f.status)) throw new HttpError(400, 'Unknown status'); patch.status = f.status; }
    await db.update('plan_containers', { id: c.id }, patch);
    return {};
  }));

  router.post(`${BASE}/containers/:id/delete`, json(async (req) => {
    const c = await getContainer(req.params.id);
    await db.update('plan_orders', { container_id: c.id }, { container_id: null, updated_at: now() });
    await db.remove('plan_containers', { id: c.id });
    return {};
  }));

  router.post(`${BASE}/containers/:id/shipped`, json(async (req) => {
    const c = await getContainer(req.params.id);
    const ls = await db.list('plan_orders', { filters: { container_id: c.id } });
    for (const l of ls) await db.update('plan_orders', { id: l.id }, { shipped: true, updated_at: now() });
    await db.update('plan_containers', { id: c.id }, { status: 'shipped', updated_at: now() });
    return { shipped: ls.length };
  }));

  router.post(`${BASE}/assign`, json(async (req) => {
    const { fields: f } = await parseForm(req);
    const o = await db.get('plan_orders', String(f.order || '')).catch(() => null);
    if (!o) throw new HttpError(404, 'Order line not found');
    if (f.container) {
      const c = await getContainer(f.container);
      if (c.status === 'shipped') throw new HttpError(400, 'That container has shipped');
      if (o.port !== c.port) throw new HttpError(400, `${o.po} loads at ${portName(o.port) || 'an unknown port'}, not ${portName(c.port)}`);
      if (!(Number(o.cbm) > 0)) throw new HttpError(400, `Add the volume of ${o.po} first`);
    }
    await db.update('plan_orders', { id: o.id }, { container_id: f.container || null, updated_at: now() });
    return {};
  }));

  /** Lines, suppliers and sailing of a container — for the quotation request. */
  async function containerFacts(c) {
    const lines = (await db.list('plan_orders', { filters: { container_id: c.id } })).sort((a, b) => String(a.supplier_id).localeCompare(String(b.supplier_id)) || String(a.po).localeCompare(String(b.po)));
    if (!lines.length) throw new HttpError(400, 'Load some POs into this container first');
    const sups = Object.fromEntries((await Promise.all([...new Set(lines.map((l) => l.supplier_id))].map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((x) => [x.id, x]));
    const sailing = c.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
    return { lines, sups, sailing, box: BOX[c.box] || BOX['40GP'] };
  }
  const fwList = async () => (await db.list('forwarders', { order: 'company.asc' }).catch(() => [])).filter((f) => f.active !== false);

  router.get(`${BASE}/containers/:id/request`, json(async (req) => {
    const c = await getContainer(req.params.id);
    const facts = await containerFacts(c);
    const draft = Q.rfqText({ container: c, ...facts, contacts: req.query.contacts === '1', both: req.query.both === '1', by: req.staff?.name || '' });
    const sent = await db.list('plan_quotes', { filters: { container_id: c.id } }).catch(() => []);
    const fws = (await fwList()).map((f) => ({ id: f.id, company: f.company, contact: f.contact_name || '', email: f.email, sent: sent.some((q) => q.forwarder_id === f.id) }));
    return { draft: { ...draft, cc: c.request_cc || '' }, forwarders: fws };
  }));

  router.post(`${BASE}/containers/:id/request`, json(async (req) => {
    const c = await getContainer(req.params.id);
    const { fields: f } = await parseForm(req, { limitBytes: 200000 });
    const ids = String(f.forwarders || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'Tick at least one forwarder');
    const cc = emails(f.cc);
    const badCc = cc.find((e) => !EMAIL_RE.test(e)); if (badCc) throw new HttpError(400, `Check this email address: ${badCc}`);
    const subject = String(f.subject || '').replace(Q.CODE_RE, '').replace(/\[\s*\]/g, '').trim(); const body = String(f.body || '').trim();
    if (!subject || !body) throw new HttpError(400, 'Subject and message are required');
    await containerFacts(c);
    const all = await fwList();
    const replyTo = [Q.quoteAddress(), process.env.EMAIL_REPLY_TO].filter(Boolean);
    const sent = []; const failed = [];
    for (const id of ids) {
      const fw = all.find((x) => x.id === id); if (!fw) continue;
      const to = emails(fw.email).filter((e) => EMAIL_RE.test(e)); const fcc = emails(fw.cc).filter((e) => EMAIL_RE.test(e));
      if (!to.length) { failed.push(`${fw.company}: no valid email`); continue; }
      const code = Q.newCode();
      const text = body.replace(/\{contact\}/g, Q.greetName(fw));
      const subj = `${subject} [${code}]`;
      try {
        await sendEmail(config, { to, cc: [...fcc, ...cc], subject: subj, text: `${text}\n\nReference: ${code}`, replyTo });
        await db.insert('plan_quotes', { container_id: c.id, forwarder_id: fw.id, code, company: fw.company, to_email: to.join(', '), sent_at: now(), status: 'sent', request_text: text, charges: [], files: [], created_at: now(), updated_at: now() });
        sent.push(fw.company);
      } catch (e) { failed.push(`${fw.company}: ${e.provider?.reason || e.message}`); }
    }
    if (sent.length) await db.update('plan_containers', { id: c.id }, { status: c.status === 'booked' ? 'booked' : 'requested', request_to: sent.join(', '), request_cc: cc.join(', '), requested_at: now(), updated_at: now() });
    if (!sent.length) throw new HttpError(502, failed.join('; ') || 'Nothing was sent');
    return { sent, failed };
  }));

  // ── quotes ────────────────────────────────────────────────────────────────
  const getQuote = async (id) => { const q = await db.get('plan_quotes', id).catch(() => null); if (!q) throw new HttpError(404, 'Quote not found'); return q; };
  router.post(`${BASE}/quotes/:id`, json(async (req) => {
    const q = await getQuote(req.params.id);
    const { fields: f } = await parseForm(req);
    const patch = { ...Q.quoteFields(f), notes: f.notes ? String(f.notes).slice(0, 2000) : null, updated_at: now() };
    if (['sent', 'replied', 'declined', 'chosen'].includes(f.status)) patch.status = f.status;
    if (patch.status === 'chosen') await chooseOnly(q);
    await db.update('plan_quotes', { id: q.id }, patch);
    return {};
  }));
  async function chooseOnly(q) {
    for (const o of await db.list('plan_quotes', { filters: { container_id: q.container_id } })) if (o.id !== q.id && o.status === 'chosen') await db.update('plan_quotes', { id: o.id }, { status: o.replied_at ? 'replied' : 'sent', updated_at: now() });
  }
  router.post(`${BASE}/quotes/:id/choose`, json(async (req) => {
    const q = await getQuote(req.params.id);
    await chooseOnly(q);
    await db.update('plan_quotes', { id: q.id }, { status: 'chosen', updated_at: now() });
    const patch = { updated_at: now() };
    if (q.etd) { const s = (await db.list('sailings', { filters: { origin: (await getContainer(q.container_id)).port, etd: q.etd } }).catch(() => [])).find((x) => !q.carrier || String(x.carrier).toLowerCase().includes(String(q.carrier).toLowerCase().split(' ')[0])); if (s) patch.sailing_id = s.id; }
    await db.update('plan_containers', { id: q.container_id }, patch);
    return { sailing: patch.sailing_id || null };
  }));
  router.get(`${BASE}/quotes/:id/files/:idx`, G(async (req, res) => {
    const q = await db.get('plan_quotes', req.params.id).catch(() => null);
    const f = q && (Array.isArray(q.files) ? q.files : [])[Number(req.params.idx)];
    if (!f) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(f.path);
    const inline = req.query.inline === '1' && /^(image\/|application\/pdf)/.test(f.type || '');
    res.writeHead(200, { 'Content-Type': f.type || 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }));

  router.post(`${BASE}/:id/cbm`, json(async (req) => {
    const o = await db.get('plan_orders', req.params.id).catch(() => null);
    if (!o) throw new HttpError(404, 'Order line not found');
    const { fields: f } = await parseForm(req);
    const v = Math.round(Number(String(f.cbm || '').replace(',', '.')) * 100) / 100;
    if (!(v > 0 && v < 1000)) throw new HttpError(400, 'Enter the volume in m³');
    await db.update('plan_orders', { id: o.id }, { cbm: v, cbm_estimated: false, updated_at: now() });
    return { cbm: v };
  }));
}

module.exports = loadPlanRoutes;
module.exports.containerIndex = containerIndex;
module.exports.BOX = BOX;
