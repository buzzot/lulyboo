'use strict';
// Forwarder shipment data: booking confirmations, shipping advice, B/Ls, ETA changes and arrival notices.
//   In:   replies in the quote thread once the shipment is booked (LBQ-…), emails sent / CC'd to shipments@<inbound>,
//         or a file / screenshot / text dropped on the shipment.
//   Read: AI pulls container, B/L numbers, vessel, ETD / ETA, ports.
//   Match: quote code → house B/L (also the supplier's) → container / MBL / booking no. → PO numbers. No match → Unmatched.
//   Review: nothing changes until you accept. Accepting updates the container / LCL shipment ("fwd"), moves its stage
//   (booked → sailed → arrived), marks it shipped when it sails, and tells you when the ETA slips by more than 2 days.

const crypto = require('node:crypto');
const AI = require('./ai');
const PL = require('./planning');
const SC = require('./schedules');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const shipmentsAddress = () => (process.env.SHIPMENTS_EMAIL || `shipments@${domain()}`).toLowerCase();
const now = () => new Date().toISOString();
const clean = (v, n = 40) => (v ? String(v).replace(/\s+/g, '').toUpperCase().slice(0, n) : null);
const portName = (c) => SC.PORT[c]?.name || c || '';

/** Fields kept on a container / LCL shipment, in display order. */
const FIELDS = [
  ['forwarder', 'Forwarder'], ['booking_no', 'Booking no.'], ['hbl_no', 'House B/L'], ['mbl_no', 'Master B/L'],
  ['container_no', 'Container'], ['container_type', 'Container type'], ['carrier', 'Carrier'], ['vessel', 'Vessel'], ['voyage', 'Voyage'],
  ['pol', 'Port of loading'], ['pod', 'Port of discharge'], ['si_cutoff', 'SI cut-off'], ['cy_cutoff', 'CY cut-off'], ['cfs_cutoff', 'CFS cut-off'],
  ['etd', 'ETD'], ['atd', 'Sailed'], ['eta', 'ETA'], ['ata', 'Arrived'], ['transit', 'Transit'],
  ['ocean_usd', 'Ocean freight (USD)'], ['rate_valid', 'Rate valid until'], ['volume_cbm', 'Volume (m³)'], ['cartons', 'Cartons'], ['gross_kg', 'Weight (kg)'],
];
const DATES = ['si_cutoff', 'cy_cutoff', 'cfs_cutoff', 'etd', 'atd', 'eta', 'ata', 'rate_valid'];
const NUMS = ['booking_no', 'hbl_no', 'mbl_no', 'container_no'];
const MONEY = ['ocean_usd', 'volume_cbm', 'cartons', 'gross_kg'];
// checked against the loaded cargo, not copied onto the container
const CHECK_ONLY = ['container_type', 'volume_cbm', 'cartons', 'gross_kg'];
const DOC_TYPES = { booking_confirmation: 'Booking confirmation', shipping_advice: 'Shipping advice', bill_of_lading: 'Bill of lading', arrival_notice: 'Arrival notice', eta_update: 'ETA update', invoice: 'Freight invoice', other: 'Forwarder document' };
const STAGES = [['booked', 'Booked'], ['sailed', 'Sailed'], ['on_water', 'On the water'], ['arrived', 'Arrived']];

const TOOL = {
  name: 'record_forwarder_update',
  description: 'Record what a freight forwarder / carrier document or email says about a shipment.',
  input_schema: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', enum: Object.keys(DOC_TYPES) },
      forwarder: { type: 'string', description: 'Forwarder or NVOCC company name' },
      booking_no: { type: 'string', description: "The forwarder's booking / file / SO reference. Often the first token of the subject, e.g. \"YN0012 - S/MGTT ...\" → YN0012" },
      hbl_no: { type: 'string', description: 'House bill of lading number (issued by the forwarder)' },
      mbl_no: { type: 'string', description: 'Master / ocean bill of lading number (issued by the shipping line)' },
      container_no: { type: 'string', description: 'Container number: 4 letters + 7 digits, e.g. CSNU6184207' },
      container_type: { type: 'string', description: "Container size and type as booked, e.g. 20' GP, 40' GP, 40' HQ, or LCL" },
      container_count: { type: 'number', description: 'Number of containers, e.g. 1 for "1 x 20\'GP"' },
      carrier: { type: 'string', description: 'Shipping line / carrier, e.g. MSC, COSCO, ONE' },
      vessel: { type: 'string', description: 'Vessel name without the voyage' },
      voyage: { type: 'string' },
      pol: { type: 'string', description: 'Port of loading, as written' },
      pod: { type: 'string', description: 'Port of discharge, as written' },
      si_cutoff: { type: 'string', description: 'SI (shipping instructions) / documents / VGM cut-off, YYYY-MM-DD' },
      cy_cutoff: { type: 'string', description: 'CY cut-off: last day the loaded container may enter the terminal (FCL), YYYY-MM-DD' },
      cfs_cutoff: { type: 'string', description: 'CFS cut-off: last day cargo may be delivered to the CFS warehouse (LCL), YYYY-MM-DD' },
      transit: { type: 'string', description: 'Transit time as written, e.g. "16-18 days"' },
      ocean_usd: { type: 'number', description: 'Ocean freight / rate in USD for the whole shipment (per container × count for FCL)' },
      rate_valid: { type: 'string', description: 'Date the rate is valid until, YYYY-MM-DD' },
      volume_cbm: { type: 'number', description: 'Total volume in m³ / CBM as stated' },
      cartons: { type: 'number', description: 'Total cartons / packages as stated' },
      gross_kg: { type: 'number', description: 'Total gross weight in kg as stated' },
      shippers: { type: 'array', items: { type: 'string' }, description: 'Shippers / factories (S/... in subjects, "Factory:" lines)' },
      consignee: { type: 'string', description: 'Consignee (C/... or "Cnee:")' },
      etd: { type: 'string', description: 'Estimated departure, YYYY-MM-DD' },
      atd: { type: 'string', description: 'Actual departure (has sailed), YYYY-MM-DD — only when the document says it sailed / departed' },
      eta: { type: 'string', description: 'Estimated arrival at the port of discharge, YYYY-MM-DD' },
      ata: { type: 'string', description: 'Actual arrival, YYYY-MM-DD — only for arrival notices / "arrived"' },
      pos: { type: 'array', items: { type: 'string' }, description: 'Purchase order numbers mentioned, each separately ("PO# 400001 + 500024" → ["400001","500024"])' },
      summary: { type: 'string', description: 'One or two sentences: what this document says (status, dates, changes)' },
    },
    required: ['doc_type', 'summary'],
  },
};
const AI_DOC = /\.(pdf|png|jpe?g|webp|gif)$/i;
const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

async function read({ text = '', files = [] }) {
  const content = []; let tables = '';
  for (const f of files.slice(0, 6)) {
    const n = String(f.name || '').toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (!f.buffer?.length || f.buffer.length > 10 * 1024 * 1024) continue;
    if (AI_DOC.test(n) || /^image\//.test(f.type || '')) {
      const mt = MIMES[ext] || (/^image\/(png|jpeg|webp|gif)$/.test(f.type || '') ? f.type : null);
      if (!mt) continue;
      content.push(mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } });
    } else if (/\.(xlsx|xlsm)$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseXlsx(f.buffer).slice(0, 80).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
    else if (/\.csv$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseCsv(decodeText(f.buffer)).slice(0, 80).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
  }
  content.push({ type: 'text', text: `Today is ${PL.today()} (dates without a year are ${new Date().getFullYear()}). This came from a freight forwarder about an ocean shipment (FCL or LCL). Record what it says. Leave out anything not stated; never guess numbers. Read the subject line too: forwarders pack the booking number, shippers (S/), consignee (C/), lane as port codes (YTN = Yantian, LAX = Los Angeles, LGB = Long Beach, NGB = Ningbo, SHA = Shanghai), container count and type, PO numbers and a date into it. Dates like 11/04/26 are US format (month/day/year).\n\n${String(text).slice(0, 20000)}${tables}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 1500 });
  return result || {};
}

/** Normalised facts (AI output or form values). */
function factsFrom(r = {}) {
  const out = { doc_type: DOC_TYPES[r.doc_type] ? r.doc_type : 'other', summary: r.summary ? String(r.summary).slice(0, 1000) : '' };
  for (const [k] of FIELDS) {
    const v = r[k];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (MONEY.includes(k)) { const n = Number(String(v).replace(/[^0-9.]/g, '')); if (n > 0) out[k] = n; continue; }
    out[k] = DATES.includes(k) ? PL.isoDay(v) : NUMS.includes(k) ? clean(v, k === 'container_no' ? 11 : 40) : String(v).trim().slice(0, 120);
  }
  if (Array.isArray(r.shippers)) out.shippers = r.shippers.map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  if (r.consignee) out.consignee = String(r.consignee).trim().slice(0, 120);
  if (Number(r.container_count) > 0) out.container_count = Number(r.container_count);
  if (out.container_no && !/^[A-Z]{4}\d{7}$/.test(out.container_no)) delete out.container_no;   // not a container number
  out.pos = [...new Set((Array.isArray(r.pos) ? r.pos : []).map((p) => String(p).trim()).filter(Boolean))].slice(0, 20);
  return out;
}

/** Stage of a container from its forwarder data. */
function stageOf(fwd = {}, day = PL.today()) {
  if (!fwd) return null;
  if (fwd.ata || fwd.arrived) return 'arrived';
  // shipping advice / B/L can come before departure: it counts as sailed from the ETD on
  if (fwd.atd || (fwd.sailed && (!fwd.etd || fwd.etd <= day)) || (fwd.etd && fwd.etd < day && fwd.mbl_no)) return fwd.eta && fwd.eta <= day ? 'arrived_due' : 'on_water';
  if (fwd.booking_no || fwd.etd || fwd.vessel || fwd.forwarder) return 'booked';
  return null;
}
const stageLabel = (s) => ({ booked: 'Booked', on_water: 'On the water', arrived_due: 'Due to arrive', arrived: 'Arrived' }[s] || '');
const trackUrl = (fwd) => (fwd?.container_no ? `https://www.track-trace.com/container?number=${encodeURIComponent(fwd.container_no)}` : fwd?.mbl_no ? `https://www.track-trace.com/bol?number=${encodeURIComponent(fwd.mbl_no)}` : null);

/** Store files of an update (forwarder documents aren't tied to one supplier). */
async function storeFiles(db, files = []) {
  const out = [];
  for (const f of files) {
    if (!f.buffer?.length || f.buffer.length > 25 * 1024 * 1024) continue;
    const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
    const ext = (safe.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    const path = `forwarders/${new Date().toISOString().slice(0, 7)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const type = MIMES[ext] || (f.type && !/octet/.test(f.type) ? f.type : 'application/octet-stream');
    try { await db.docs.upload(path, f.buffer, type); out.push({ name: String(f.name || safe).slice(0, 200), path, type, size: f.buffer.length }); } catch (e) { console.error('Forwarder file upload failed:', e.message); }
  }
  return out;
}

/** Find the container / LCL shipment an update belongs to. */
async function match(db, facts, { quoteCode = null } = {}) {
  if (quoteCode) {
    const q = (await db.list('plan_quotes', { filters: { code: quoteCode }, limit: 1 }).catch(() => []))[0];
    if (q) return { container_id: q.container_id, reason: `quote ${quoteCode}`, quote: q };
  }
  const cs = await db.list('plan_containers').catch(() => []);
  const scs = await db.list('ship_confirmations').catch(() => []);
  const same = (a, b) => a && b && clean(a) === clean(b);
  for (const [k, label] of [['hbl_no', 'house B/L'], ['container_no', 'container'], ['mbl_no', 'master B/L'], ['booking_no', 'booking no.']]) {
    const v = facts[k]; if (!v) continue;
    const c = cs.find((x) => same(x.fwd?.[k], v) || (k === 'container_no' && same(x.container_no, v)));
    if (c) return { container_id: c.id, reason: `${label} ${v}` };
    if (k === 'hbl_no' || k === 'container_no' || k === 'mbl_no') {
      const sc = scs.find((x) => x.container_id && (same(x.bl_no, v) || same(x.container_no, v) || same(x.facts?.bl_no, v) || same(x.facts?.container_no, v)));
      if (sc) return { container_id: sc.container_id, reason: `${label} ${v} (from the supplier's documents)` };
    }
  }
  if ((facts.pos || []).length) {
    const ls = (await db.list('plan_orders').catch(() => [])).filter((l) => l.container_id && facts.pos.some((p) => PL.normPo(p) === PL.normPo(l.po)));
    const ids = [...new Set(ls.map((l) => l.container_id))];
    if (ids.length === 1) return { container_id: ids[0], reason: `PO ${facts.pos.join(', ')}` };
  }
  return { container_id: null, reason: null };
}

/** Box key from what the forwarder wrote: "1 x 20'GP" → 20GP. */
function boxOf(t) {
  const x = String(t || '').toUpperCase().replace(/\s+/g, '');
  if (!x) return null;
  if (/LCL/.test(x)) return 'LCL';
  if (/20/.test(x)) return '20GP';
  if (/40.*(HQ|HC|HIGH)/.test(x)) return '40HQ';
  if (/40/.test(x)) return '40GP';
  return null;
}

/**
 * What would change on the container: [{ key, label, old, value, state: new|changed|same, date, tick }].
 * `ctx` (from context()) supplies portal values that aren't stored on the container yet (chosen quote, sailing).
 */
function diff(container, facts, ctx = {}) {
  const cur = container?.fwd || {};
  const from = (k) => cur[k] ?? (k === 'container_no' ? container?.container_no : null) ?? ctx.portal?.[k] ?? null;
  const eq = (a, b, k) => (MONEY.includes(k) ? Math.abs(Number(a) - Number(b)) < 0.005 : clean(String(a), 200) === clean(String(b), 200));
  const rows = FIELDS.filter(([k]) => facts[k] != null && facts[k] !== '' && !CHECK_ONLY.includes(k)).map(([k, label]) => {
    const old = from(k);
    const state = old == null || old === '' ? 'new' : eq(old, facts[k], k) ? 'same' : 'changed';
    return { key: k, label, old, value: facts[k], state, date: DATES.includes(k), tick: state !== 'same' };
  });
  // loading date: the day before the cut-off
  const cut = container?.box === 'LCL' ? facts.cfs_cutoff || facts.cy_cutoff : facts.cy_cutoff || facts.cfs_cutoff;
  if (cut && container) {
    const want = PL.addDays(cut, -1); const have = container.loading_date ? String(container.loading_date).slice(0, 10) : null;
    if (have !== want) rows.push({ key: 'loading_date', label: container.box === 'LCL' ? 'Delivery to CFS' : 'Loading date', old: have, value: want, state: have ? 'changed' : 'suggest', date: true, tick: !have || have > cut, note: 'cut-off − 1 day' });
  }
  return rows;
}

/** Portal facts about a container for comparing: lines, suppliers, chosen quote, sailing. */
async function context(db, c) {
  const lines = (await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => [])).filter((l) => !l.shipped || c.status === 'shipped');
  const sups = {}; for (const id of [...new Set(lines.map((l) => l.supplier_id))]) sups[id] = await db.get('suppliers', id).catch(() => null);
  const quotes = await db.list('plan_quotes', { filters: { container_id: c.id } }).catch(() => []);
  const chosen = quotes.find((q) => q.status === 'chosen') || null;
  const sail = c.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
  const portal = {};
  if (chosen) { if (chosen.ocean_usd != null || chosen.total_usd != null) portal.ocean_usd = Number(chosen.ocean_usd ?? chosen.total_usd); if (chosen.valid_until) portal.rate_valid = chosen.valid_until; if (chosen.carrier) portal.carrier = chosen.carrier; if (chosen.company) portal.forwarder = chosen.company; }
  if (sail) { if (sail.etd) portal.etd = portal.etd || sail.etd; if (sail.eta) portal.eta = sail.eta; if (sail.carrier) portal.carrier = portal.carrier || sail.carrier; if (sail.vessel) portal.vessel = sail.vessel; }
  const sum = (k) => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  return { lines, sups, chosen, sail, portal, cbm: Math.round(sum('cbm') * 100) / 100, cartons: sum('cartons'), kg: sum('gross_kg'), allKg: lines.length && lines.every((l) => Number(l.gross_kg) > 0), allCtn: lines.length && lines.every((l) => Number(l.cartons) > 0) };
}

/** Problems and confirmations: [{ level: bad|warn|ok, html-free text, action? }]. */
function checks(c, facts, ctx, { box = {}, day = PL.today() } = {}) {
  const out = []; const S = (d) => PL.short(d);
  const typeBox = boxOf(facts.container_type);
  const name = (k) => box[k]?.name || k;
  if (typeBox && c.box && typeBox !== c.box) out.push({ level: 'bad', text: `Container type: they booked ${facts.container_count > 1 ? `${facts.container_count} × ` : ''}${name(typeBox)}, the portal plans ${name(c.box)}.`, action: { kind: 'box', box: typeBox, label: `Switch to ${name(typeBox)}` } });
  else if (facts.container_count > 1) out.push({ level: 'warn', text: `They booked ${facts.container_count} containers — the portal plans one.` });
  // POs
  if ((facts.pos || []).length && ctx.lines.length) {
    const theirs = new Set(facts.pos.map(PL.normPo));
    const ours = [...new Map(ctx.lines.map((l) => [PL.normPo(l.po), l])).values()];
    const missing = ours.filter((l) => !theirs.has(PL.normPo(l.po)));
    const extra = facts.pos.filter((p) => !ours.some((l) => PL.normPo(l.po) === PL.normPo(p)));
    for (const l of missing) {
      const ls = ctx.lines.filter((x) => PL.normPo(x.po) === PL.normPo(l.po)); const cbm = ls.reduce((a, x) => a + (Number(x.cbm) || 0), 0);
      out.push({ level: 'warn', text: `${l.po} isn't in their booking (${cbm ? `${Math.round(cbm * 100) / 100} m³, ` : ''}${ctx.sups[l.supplier_id]?.name || 'supplier'}). Ask them to add it, or move it out.`, action: { kind: 'copy', label: 'Copy reply', text: `Hi, please add PO ${l.po} (${ctx.sups[l.supplier_id]?.name || ''}${cbm ? `, ${Math.round(cbm * 100) / 100} CBM` : ''}) to booking ${facts.booking_no || ''}. Thank you.` } });
    }
    for (const p of extra) out.push({ level: 'warn', text: `PO ${p} is in their booking but not in this container.` });
    if (!missing.length && !extra.length) out.push({ level: 'ok', text: `POs match: ${ours.map((l) => l.po).join(', ')}.` });
  }
  // cargo ready vs cut-off
  const cutKey = c.box === 'LCL' ? (facts.cfs_cutoff ? 'cfs_cutoff' : 'cy_cutoff') : (facts.cy_cutoff ? 'cy_cutoff' : 'cfs_cutoff');
  const cut = facts[cutKey]; const cutName = cutKey === 'cfs_cutoff' ? 'CFS cut-off' : 'CY cut-off';
  if (cut && ctx.lines.length) {
    const dated = ctx.lines.filter((l) => l.ready_date).sort((a, b) => String(b.ready_date).localeCompare(String(a.ready_date)));
    const late = dated.filter((l) => String(l.ready_date).slice(0, 10) > cut);
    if (late.length) out.push({ level: 'bad', text: `Cargo ready after the ${cutName}: ${[...new Set(late.map((l) => `${l.po} ready ${S(String(l.ready_date).slice(0, 10))}`))].join(', ')} — ${cutName} is ${S(cut)}.` });
    else if (dated.length) { const last = String(dated[0].ready_date).slice(0, 10); const d = Math.round((Date.parse(cut) - Date.parse(last)) / 864e5); out.push({ level: 'ok', text: `All cargo ready ${S(last)} — ${d} day${d === 1 ? '' : 's'} before the ${cutName} (${S(cut)}).` }); }
  }
  if (facts.si_cutoff && !['shipped'].includes(c.status)) {
    if (facts.si_cutoff < day) out.push({ level: 'warn', text: `SI cut-off ${S(facts.si_cutoff)} has passed — check the shipping instructions were sent.` });
    else if (facts.si_cutoff <= PL.addDays(day, 3)) out.push({ level: 'warn', text: `SI cut-off is ${S(facts.si_cutoff)} — send the shipping instructions by then.` });
  }
  // rate
  if (facts.rate_valid) {
    const sail = facts.etd || ctx.portal.etd;
    if (sail && facts.rate_valid < sail) out.push({ level: 'bad', text: `Rate valid until ${S(facts.rate_valid)}, but ETD is ${S(sail)} — ask them to confirm the price still holds.` });
    else if (facts.rate_valid < day) out.push({ level: 'warn', text: `Rate expired ${S(facts.rate_valid)}.` });
  }
  if (facts.ocean_usd && ctx.chosen && (ctx.chosen.ocean_usd != null || ctx.chosen.total_usd != null)) {
    const q = Number(ctx.chosen.ocean_usd ?? ctx.chosen.total_usd);
    if (Math.abs(q - facts.ocean_usd) >= 1) out.push({ level: 'warn', text: `Price $${facts.ocean_usd.toLocaleString('en-US')} differs from their chosen quote ($${q.toLocaleString('en-US')}, ${ctx.chosen.code}).` });
    else out.push({ level: 'ok', text: `Price $${facts.ocean_usd.toLocaleString('en-US')} matches the chosen quote.` });
  }
  // volume / cartons / weight
  const cap = box[c.box]?.cap; const lcl = box[c.box]?.lcl;
  if (facts.volume_cbm && ctx.cbm) {
    const d = Math.round((ctx.cbm - facts.volume_cbm) * 100) / 100;
    if (Math.abs(d) > Math.max(0.5, ctx.cbm * 0.03)) out.push({ level: 'warn', text: `Volume: they have ${facts.volume_cbm} m³, the portal has ${ctx.cbm} m³ loaded (${d > 0 ? `${d} m³ more` : `${-d} m³ less`}).` });
    if (!lcl && cap && Math.max(facts.volume_cbm, ctx.cbm) > cap && (!typeBox || typeBox === c.box)) out.push({ level: 'warn', text: `${Math.max(facts.volume_cbm, ctx.cbm)} m³ is above the ${cap} m³ practical load of a ${box[c.box]?.name || c.box} — confirm with them it fits.` });
  }
  if (facts.cartons && ctx.allCtn && Math.abs(facts.cartons - ctx.cartons) > Math.max(2, ctx.cartons * 0.02)) out.push({ level: 'warn', text: `Cartons: they have ${facts.cartons.toLocaleString('en-US')}, the portal has ${ctx.cartons.toLocaleString('en-US')}.` });
  if (facts.gross_kg && ctx.allKg && Math.abs(facts.gross_kg - ctx.kg) > Math.max(50, ctx.kg * 0.05)) out.push({ level: 'warn', text: `Weight: they have ${Math.round(facts.gross_kg).toLocaleString('en-US')} kg, the portal has ${Math.round(ctx.kg).toLocaleString('en-US')} kg.` });
  // shippers and consignee
  if ((facts.shippers || []).length && ctx.lines.length) {
    const key = (x) => String(x || '').toLowerCase().replace(/\b(co|ltd|corp|inc|limited|company|trading|products?|commodity|industrial|technology)\b|[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const theirs = facts.shippers.map(key);
    const miss = Object.values(ctx.sups).filter(Boolean).filter((sp) => { const k = key(sp.name); return !theirs.some((t) => t.some((w) => k.includes(w))); });
    if (miss.length) out.push({ level: 'warn', text: `Shipper${miss.length > 1 ? 's' : ''} not in their booking: ${miss.map((x) => x.name).join(', ')}.` });
    else out.push({ level: 'ok', text: `Shippers match: ${facts.shippers.join(', ')}.` });
  }
  if (facts.consignee && !/lulyboo/i.test(facts.consignee)) out.push({ level: 'warn', text: `Consignee is “${facts.consignee}” — not Lulyboo.` });
  const rank = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * New forwarder update: files stored, AI read, matched, saved as "pending", owner told.
 * containerId: when you drop it on a shipment. text: email body or pasted text.
 */
async function createUpdate(db, config, { source = 'email', from = '', subject = '', text = '', files = [], containerId = null, quoteCode = null, by = null, notify = true }) {
  const stored = await storeFiles(db, files);
  let facts = { doc_type: 'other', summary: '', pos: [] };
  if (AI.enabled() && (files.length || String(text).trim())) {
    try { facts = factsFrom(await read({ text: [subject ? `Subject: ${subject}` : '', text].filter(Boolean).join('\n\n'), files })); }
    catch (e) { facts.summary = `Could not read this automatically (${String(e.message).slice(0, 100)}). Open the files or enter the values.`; }
  }
  const m = containerId ? { container_id: containerId, reason: 'added on this shipment' } : await match(db, facts, { quoteCode });
  const row = await db.insert('fwd_updates', {
    container_id: m.container_id, match_reason: m.reason, source, from_email: String(from || '').slice(0, 300), subject: String(subject || '').slice(0, 300),
    text: String(text || '').slice(0, 30000), facts, files: stored, status: 'pending', created_by: by, created_at: now(),
  });
  if (notify) {
    const P = require('./projects');
    const c = m.container_id ? await db.get('plan_containers', m.container_id).catch(() => null) : null;
    const what = `${DOC_TYPES[facts.doc_type] || 'Forwarder update'}${facts.hbl_no ? ` · HBL ${facts.hbl_no}` : ''}${facts.eta ? ` · ETA ${PL.short(facts.eta)}` : ''}`;
    const link = `${config.publicUrl}/admin/orders/shipping#forwarder`;
    const where = c ? `${portName(c.port)} · ${c.box === 'LCL' ? 'LCL shipment' : 'container'}` : 'not matched to a shipment yet';
    await P.notifyOwner(config, `[Forwarder update] ${what}`, `${where}\n${facts.summary || ''}\n\n${link}`, { title: 'Forwarder update to review', intro: `${what} — ${where}. ${facts.summary || ''}`, button: 'Review', link }).catch(() => null);
    await telegram(db, `🚢 <b>Forwarder update</b>`, `${what}\n${where}`, link);
  }
  return row;
}

/** Inbound email: shipments@… or a reply in a booked quote thread. */
async function handleFwdEmail({ db, config, from, subject, text, files = [], quoteCode = null }) {
  const row = await createUpdate(db, config, { source: 'email', from, subject, text, files, quoteCode });
  return { matched: !!row.container_id, update: row.id };
}

/**
 * Accept an update: values (edited in the review) go onto the container's forwarder data.
 * Sailing marks the container and its PO lines shipped. ETA slipping > 2 days → notice.
 */
async function accept(db, config, upd, { values = null, containerId = null, by = null } = {}) {
  const cid = containerId || upd.container_id;
  const c = cid ? await db.get('plan_containers', cid).catch(() => null) : null;
  if (!c) throw Object.assign(new Error('Choose the shipment this update belongs to'), { status: 400 });
  const facts = factsFrom({ ...upd.facts, ...(values || {}) });
  const cur = { ...(c.fwd || {}) };
  const next = { ...cur };
  // `only`: the fields ticked in the check (null = every field read)
  const only = values && Array.isArray(values._only) ? new Set(values._only) : null;
  const applied = [];
  for (const [k, label] of FIELDS) {
    if (facts[k] == null || facts[k] === '' || CHECK_ONLY.includes(k) || (only && !only.has(k))) continue;
    if (String(cur[k] ?? '') !== String(facts[k])) applied.push({ key: k, label, from: cur[k] ?? null, to: facts[k] });
    next[k] = facts[k];
  }
  if (facts.eta && cur.eta && facts.eta !== cur.eta) { next.eta_prev = cur.eta; next.eta_changed_at = now(); }
  if (facts.doc_type === 'arrival_notice' && !next.ata) next.arrived = true;
  if ((facts.doc_type === 'shipping_advice' || facts.doc_type === 'bill_of_lading') && !next.atd) next.sailed = true;
  next.updated_at = now();
  next.docs = [...(cur.docs || []), { id: upd.id, type: facts.doc_type, at: upd.created_at, files: (upd.files || []).length }].slice(-30);
  const patch = { fwd: next, updated_at: now() };
  if (next.container_no) patch.container_no = next.container_no;
  if (values?.loading_date && (!only || only.has('loading_date'))) { const d = PL.isoDay(values.loading_date); if (d) { applied.push({ key: 'loading_date', label: 'Loading date', from: c.loading_date ? String(c.loading_date).slice(0, 10) : null, to: d }); patch.loading_date = d; } }
  const st = stageOf(next);
  if (st && st !== 'booked' && c.status !== 'shipped') {
    patch.status = 'shipped';
    await shipLines(db, c.id);
  } else if (st === 'booked' && ['planned', 'requested'].includes(c.status)) patch.status = 'booked';
  await db.update('plan_containers', { id: c.id }, patch);
  await decide(db, upd.id, { status: 'accepted', container_id: c.id, facts, decided_by: by, decided_at: now(), applied });
  if (facts.ocean_usd || next.ocean_usd) await require('./rate-history').recordBooking(db, { ...c, ...patch }, next).catch((e) => console.error('Rate history (booking) failed:', e.message));
  const slip = cur.eta && next.eta ? Math.round((Date.parse(next.eta) - Date.parse(cur.eta)) / 864e5) : 0;
  if (slip > 2) {
    const P = require('./projects');
    const link = `${config.publicUrl}/admin/orders/shipping#forwarder`;
    await P.notifyOwner(config, `[ETA moved] ${portName(c.port)} ${c.box === 'LCL' ? 'LCL shipment' : 'container'} — now ${PL.short(next.eta)} (+${slip} days)`, `ETA moved from ${PL.short(cur.eta)} to ${PL.short(next.eta)}.\n\n${link}`, { title: 'ETA moved', intro: `ETA moved from ${PL.short(cur.eta)} to ${PL.short(next.eta)} (+${slip} days).`, button: 'Open', link }).catch(() => null);
  }
  return { container: { ...c, ...patch }, stage: st, slip, applied };
}

async function telegram(db, head, body, link) {
  try {
    const tg = require('./telegram');
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, `${head}\n${tg.escapeHtml(body)}\n${link}`);
  } catch (e) { console.error('Forwarder Telegram failed:', e.message); }
}

/** A reply in a quote thread is a shipment update once that forwarder was chosen or the container is booked. */
async function quoteIsBooked(db, subject, text) {
  const QT = require('./quotes');
  const m = String(subject || '').match(QT.CODE_RE) || String(text || '').match(QT.CODE_RE);
  if (!m) return null;
  const code = `LBQ-${m[1].toUpperCase()}`;
  const q = (await db.list('plan_quotes', { filters: { code }, limit: 1 }).catch(() => []))[0];
  if (!q) return null;
  if (q.status === 'chosen') return code;
  // booked without marking a quote chosen: replies count as updates unless another forwarder was chosen
  const c = await db.get('plan_containers', q.container_id).catch(() => null);
  if (!c || !['booked', 'shipped'].includes(c.status) || q.status === 'declined') return null;
  const chosen = (await db.list('plan_quotes', { filters: { container_id: c.id } }).catch(() => [])).some((x) => x.status === 'chosen');
  return chosen ? null : code;
}

async function shipLines(db, containerId) {
  for (const l of await db.list('plan_orders', { filters: { container_id: containerId } }).catch(() => [])) if (!l.shipped) await db.update('plan_orders', { id: l.id }, { shipped: true, updated_at: now() }).catch(() => null);
}

/** Booked containers whose ETD has passed after a shipping advice / B/L become shipped (checked when pages load). */
async function settle(db, containers) {
  for (const c of containers) {
    if (!c.fwd) continue;
    const st = stageOf(c.fwd);
    if (c.status === 'shipped') {
      // marked shipped by an early shipping advice (before this fix) while the ETD is still ahead → back to booked
      if (st === 'booked' && c.fwd.sailed && !c.fwd.atd) {
        await db.update('plan_containers', { id: c.id }, { status: 'booked', updated_at: now() }).catch(() => null);
        for (const l of await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => [])) if (l.shipped) await db.update('plan_orders', { id: l.id }, { shipped: false, updated_at: now() }).catch(() => null);
        c.status = 'booked';
      }
      continue;
    }
    if (st && st !== 'booked') { await db.update('plan_containers', { id: c.id }, { status: 'shipped', updated_at: now() }).catch(() => null); await shipLines(db, c.id); c.status = 'shipped'; }
  }
}

/** Save the decision; `applied` needs the newer column — retry without it. */
async function decide(db, id, patch) {
  try { await db.update('fwd_updates', { id }, patch); }
  catch (e) { if (patch.applied !== undefined && /applied/i.test(e.message)) { const { applied, ...rest } = patch; await db.update('fwd_updates', { id }, rest); } else throw e; }
}

/** Keep the message in the container's log without changing anything. */
async function logOnly(db, upd, { containerId = null, by = null } = {}) {
  const cid = containerId || upd.container_id;
  if (!cid) throw Object.assign(new Error('Choose the shipment this update belongs to'), { status: 400 });
  await decide(db, upd.id, { status: 'logged', container_id: cid, decided_by: by, decided_at: now(), applied: [] });
}

async function dismiss(db, upd, by = null) { await db.update('fwd_updates', { id: upd.id }, { status: 'dismissed', decided_by: by, decided_at: now() }); }

module.exports = { boxOf, context, checks, logOnly, settle, quoteIsBooked, FIELDS, DATES, DOC_TYPES, STAGES, TOOL, shipmentsAddress, read, factsFrom, stageOf, stageLabel, trackUrl, storeFiles, match, diff, createUpdate, handleFwdEmail, accept, dismiss };
