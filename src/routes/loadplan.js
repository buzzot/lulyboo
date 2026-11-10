'use strict';
// Container planning → Load containers: drag open PO lines into 20GP / 40GP / 40HQ containers,
// pick a sailing, and see how full each box is. Assignments are saved as plan_orders.container_id.

const { html, raw } = require('../lib/html');
const { parseForm, takeFlash, HttpError } = require('../lib/http');
const { sendEmail } = require('../email');
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
};
const STATUSES = ['planned', 'requested', 'booked'];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emails = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const n2 = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
const int = (v) => Number(v || 0).toLocaleString('en-US');
const COLORS = ['#d9634f', '#3b7dd8', '#2f9e6a', '#8e5bd1', '#d39a2a', '#1f9bb0', '#c2477f', '#6b8e23', '#7a6a58', '#b4473b'];
const missingTable = (e) => /plan_containers|container_id|PGRST20[45]|relation|column/i.test(e?.message || '');
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
    return { c, text: [`${portName(c.port)} · Container ${c.no}`, BOX[c.box]?.name || c.box, c.sailing ? `ETD ${PL.short(c.sailing.etd)}` : null, c.status === 'booked' ? 'Booked' : c.status === 'requested' ? 'Booking requested' : c.status === 'shipped' ? 'Shipped' : 'Planned'].filter(Boolean).join(' · '), url: `${BASE}/load?port=${c.port}` };
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

    const data = {
      base: BASE, port, today: day, box: BOX,
      orders: here.map((o, i) => ({
        id: o.id, po: o.po, supplier: sups[o.supplier_id]?.name || 'Supplier', product: o.product || '', qty: Number(o.qty) || 0,
        cbm: o.cbm ? Number(o.cbm) : null, est: !!o.cbm_estimated, ready: o.ready_date || null, readyText: o.ready_date ? PL.short(o.ready_date) : '',
        st: PL.state(o, day), container: cIds.has(o.container_id) ? o.container_id : null, color: COLORS[i % COLORS.length],
      })),
      containers: portCs.map((c) => ({ id: c.id, no: c.no, box: BOX[c.box] ? c.box : '40GP', sailing: c.sailing_id || '', status: c.status || 'planned', requestTo: c.request_to || '', requestedAt: c.requested_at ? PL.short(String(c.requested_at).slice(0, 10)) : '' })),
      sailings: sail.map((s) => ({ id: s.id, label: sailLabel(s), etd: s.etd })),
      states: Object.fromEntries(Object.entries(PL.STATE).map(([k, v]) => [k, { label: v.label, tag: v.tag }])),
    };
    const tabs = html`<nav class="cp-views" aria-label="Views">${[['port', 'By port'], ['load', 'Load containers'], ['timeline', 'Timeline'], ['table', 'Table'], ['docs', 'Documents']].map(([k, l]) => html`<a href="${k === 'load' ? `${BASE}/load` : `${BASE}?view=${k}`}" class="${k === 'load' ? 'on' : ''}" ${k === 'load' ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

    res.html(page({
      title: 'Load containers · Container planning', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
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
          <div class="lp-main"><div data-lp-containers></div><button type="button" class="lp-add" data-lp-add>+ Add container</button></div>
        </div>
        <div class="lp-toast" data-lp-toast role="status" aria-live="polite"></div>
        <dialog class="rp-modal" data-lp-req aria-labelledby="lp-req-t"><form data-lp-req-form>
          <div class="rp-top"><h2 id="lp-req-t">Booking request</h2><button type="button" class="icon-btn" data-lp-req-close aria-label="Close">×</button></div>
          <p class="sub rp-ctx">Sent from the portal to your logistics company. Edit anything before sending.</p>
          <div class="rp-loading" data-lp-req-loading>Preparing the packing list…</div>
          <div class="rp-fields" data-lp-req-fields hidden>
            <label>To <input name="to" type="text" required placeholder="booking@forwarder.com" autocomplete="off"></label>
            <label>CC <input name="cc" type="text" placeholder="optional, comma separated" autocomplete="off"></label>
            <label>Subject <input name="subject" type="text" required></label>
            <label class="cp-chk lp-req-chk"><input type="checkbox" name="contacts" value="1" data-lp-req-contacts> Include supplier contact details (for pickup / CFS delivery)</label>
            <label>Message <textarea name="body" rows="18" required></textarea></label>
            <div class="rp-actions"><button class="btn" data-lp-req-send>Send booking request</button><button type="button" class="btn ghost" data-lp-req-close>Cancel</button><span class="sub" data-lp-req-note></span></div>
          </div></form></dialog>`,
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

  /** Booking request e-mail for one container: packing info, cargo-ready date, port, sailing, optional supplier contacts. */
  async function bookingDraft(c, { contacts = false, by = '' } = {}) {
    const all = await db.list('plan_containers', { filters: { port: c.port }, order: 'created_at.asc' }).catch(() => []);
    const no = Math.max(1, all.findIndex((x) => x.id === c.id) + 1);
    const ls = (await db.list('plan_orders', { filters: { container_id: c.id } })).sort((a, b) => String(a.supplier_id).localeCompare(String(b.supplier_id)) || String(a.po).localeCompare(String(b.po)));
    if (!ls.length) throw new HttpError(400, 'Load some POs into this container first');
    const sups = Object.fromEntries((await Promise.all([...new Set(ls.map((l) => l.supplier_id))].map((id) => db.get('suppliers', id).catch(() => null)))).filter(Boolean).map((x) => [x.id, x]));
    const s = c.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
    const t = BOX[c.box] || BOX['40GP'];
    const sum = (k) => ls.reduce((a, l) => a + (Number(l[k]) || 0), 0);
    const has = (k) => ls.some((l) => Number(l[k]) > 0);
    const dates = ls.map((l) => l.ready_date).filter(Boolean).sort();
    const ready = dates[dates.length - 1] || null;
    const dest = s ? `${portName(s.destination)} (${s.destination})` : 'Los Angeles / Long Beach';
    const nSup = Object.keys(sups).length;
    const lines = ls.map((l, i) => `${i + 1}. ${l.po} — ${sups[l.supplier_id]?.name || 'Supplier'}${l.product ? ` — ${l.product}` : ''}\n   ${[l.qty ? `${int(l.qty)} pcs` : null, l.cartons ? `${int(l.cartons)} ctns` : null, l.cbm ? `${n2(l.cbm)} m³${l.cbm_estimated ? ' (est.)' : ''}` : null, l.gross_kg ? `${int(l.gross_kg)} kg` : null, l.ready_date ? `ready ${PL.short(l.ready_date)}` : null].filter(Boolean).join(' · ')}`);
    const total = [`${int(sum('qty'))} pcs`, has('cartons') ? `${int(sum('cartons'))} ctns` : null, `${n2(sum('cbm'))} m³`, has('gross_kg') ? `${int(sum('gross_kg'))} kg` : null].filter(Boolean).join(' · ');
    const contactBlock = Object.values(sups).map((x) => [`• ${x.name}`, x.contact_name ? `  Contact: ${x.contact_name}` : null, x.email ? `  Email: ${x.email}` : null, x.phone ? `  Phone: ${x.phone}` : null, x.address ? `  Address: ${x.address}` : null].filter(Boolean).join('\n'));
    const ref = `${c.port.slice(2)}-${no}`;
    const subject = `Booking request: 1 × ${t.name}, ${portName(c.port)} → ${s ? portName(s.destination) : 'LA / Long Beach'}${ready ? `, cargo ready ${PL.short(ready)}` : ''} [Lulyboo ${ref}]`;
    const body = [
      'Hello,', '',
      'Please book the container below and confirm space, rate, cut-off dates and the SO.', '',
      `Container: 1 × ${t.name} (planned load ${n2(sum('cbm'))} m³ of ~${t.cap} m³)`,
      `Port of loading: ${portName(c.port)} (${c.port})`,
      `Destination: ${dest}`,
      `Preferred sailing: ${s ? [s.carrier, s.vessel ? `${s.vessel}${s.voyage ? ` ${s.voyage}` : ''}` : null, `ETD ${PL.short(s.etd)}`, s.cy_cutoff ? `CY cut-off ${PL.short(s.cy_cutoff)}` : null].filter(Boolean).join(' · ') : 'first available sailing after the cargo-ready date'}`,
      `Cargo ready: ${ready ? PL.short(ready) : 'to be confirmed'}${dates.length > 1 && dates[0] !== ready ? ` (first PO ready ${PL.short(dates[0])})` : ''}`,
      `Shippers: ${nSup} supplier${nSup > 1 ? 's — cargo comes from more than one factory, please advise on loading (CFS or pickups)' : ''}`, '',
      'Packing list', ...lines, `Total: ${total}`,
      ...(contacts ? ['', 'Supplier contacts', ...contactBlock] : []),
      '', 'Thank you,', by || 'Lulyboo', 'Lulyboo',
    ].join('\n');
    const prev = (await db.list('plan_containers', { order: 'requested_at.desc' }).catch(() => [])).find((x) => x.request_to);
    return { to: c.request_to || prev?.request_to || process.env.FORWARDER_EMAIL || '', cc: c.request_cc || prev?.request_cc || '', subject, body };
  }

  router.get(`${BASE}/containers/:id/request`, json(async (req) => {
    const c = await getContainer(req.params.id);
    return { draft: await bookingDraft(c, { contacts: req.query.contacts === '1', by: req.staff?.name || '' }) };
  }));

  router.post(`${BASE}/containers/:id/request`, json(async (req) => {
    const c = await getContainer(req.params.id);
    const { fields: f } = await parseForm(req, { limitBytes: 200000 });
    const to = emails(f.to); const cc = emails(f.cc);
    if (!to.length) throw new HttpError(400, 'Add the logistics company email');
    const bad = [...to, ...cc].find((e) => !EMAIL_RE.test(e));
    if (bad) throw new HttpError(400, `Check this email address: ${bad}`);
    const subject = String(f.subject || '').trim(); const text = String(f.body || '').trim();
    if (!subject || !text) throw new HttpError(400, 'Subject and message are required');
    await sendEmail(config, { to, cc, subject, text });
    await db.update('plan_containers', { id: c.id }, { status: c.status === 'booked' ? 'booked' : 'requested', request_to: to.join(', '), request_cc: cc.join(', '), requested_at: now(), request_body: text, updated_at: now() });
    return { status: c.status === 'booked' ? 'booked' : 'requested', requestTo: to.join(', '), requestedAt: PL.short(PL.today()) };
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
