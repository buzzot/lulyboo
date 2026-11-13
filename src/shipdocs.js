'use strict';
// Shipment confirmation & shipping documents — by email only.
//   1. Each supplier in a planned container (or LCL shipment) gets one request on the loading date
//      (container loading_date, or ETD − 3 days), sent at 9:00 China time. The subject carries LBS-XXXXX.
//   2. The supplier replies with the documents attached (inbound docs@…, matched by the code).
//   3. AI reads the packing list: cartons, gross weight, m³, carton size, container / seal / B/L numbers, or a new date.
//   4. You review planned vs actual and accept: the PO lines get the actual figures and the shipment is kept for stats.
//   No reply: reminders 2 and 4 days after the request. Reply with documents missing: follow-ups that ask only for
//   what is missing (2 days after the last reply, then 3 days later). The bill of lading is not chased before ETD + 3.

const crypto = require('node:crypto');
const AI = require('./ai');
const PL = require('./planning');
const SC = require('./schedules');
const { sendEmail, shipmentEmail } = require('./email');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

const CODE_RE = /\bLBS-([A-Z0-9]{5})\b/i;
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand = (n) => Array.from(crypto.randomBytes(n), (b) => ALPH[b % ALPH.length]).join('');
const newCode = () => `LBS-${rand(5)}`;
const newToken = () => crypto.randomBytes(18).toString('base64url');
const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const docsAddress = () => (process.env.DOCS_EMAIL || `docs@${domain()}`).toLowerCase();
const portName = (c) => SC.PORT[c]?.name || c || '';
const n2 = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
const int = (v) => Number(v || 0).toLocaleString('en-US');
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1000) / 1000);
const LEAD_DAYS = 3;            // loading date = ETD − 3 days when none is set
const REMIND_AFTER = [2, 4];    // no reply: days after the request
const FOLLOW_AFTER = [2, 3];    // reply with documents missing: days after the last reply, then after the 1st follow-up
const BL_AFTER_ETD = 3;         // the B/L is issued after sailing
const SEND_HOUR = 9;            // China time
const day10 = (v) => (v ? String(v).slice(0, 10) : null);

/** Date and hour in China (UTC+8), where suppliers are. */
function chinaNow(now = new Date()) { const d = new Date(now.getTime() + 8 * 3600e3); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; }
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** Documents per mode: [plan_files kind, label, what to ask, optional]. Optional ones are asked once, never chased. */
const REQUIRED = {
  FCL: [['Invoice', 'Commercial invoice', 'Commercial invoice'], ['Packing list', 'Packing list', 'Packing list with cartons, gross weight and volume (m³) per PO'], ['Bill of lading', 'Bill of lading', 'Bill of lading (draft or final)'], ['Loading photos', 'Loading photos', 'Loading photos (door open, and door closed with the seal)', true]],
  LCL: [['Warehouse receipt', 'Warehouse receipt (FCR)', 'Warehouse receipt (FCR) from the CFS warehouse'], ['Invoice', 'Commercial invoice', 'Commercial invoice'], ['Packing list', 'Packing list', 'Packing list with cartons, gross weight and volume (m³) per PO'], ['Bill of lading', 'House bill of lading', 'House bill of lading (draft or final)']],
  COURIER: [['Invoice', 'Commercial invoice', 'Commercial invoice'], ['Packing list', 'Packing list', 'Packing list with cartons, gross weight and dimensions per PO'], ['Bill of lading', 'Courier waybill', 'Courier waybill (AWB) with the tracking number']],
  '': [['Invoice', 'Commercial invoice', 'Commercial invoice'], ['Packing list', 'Packing list', 'Packing list with cartons, gross weight and volume (m³) per PO'], ['Bill of lading', 'Bill of lading / waybill', 'Bill of lading, house B/L or courier waybill']],
};
/** How a PO without a container plan ships — chosen in the send popup. */
const MODES = { FCL: 'FCL', LCL: 'LCL', COURIER: 'Courier' };
const required = (sc) => REQUIRED[sc?.mode || ''] || REQUIRED[''];
const CONFIRM = {
  FCL: 'Confirmation that the container is loaded, with the container number and seal number',
  LCL: 'Confirmation that the goods were delivered to the CFS warehouse, with the delivery date',
  COURIER: 'Confirmation of the pickup date, with the courier and tracking number',
  '': 'Confirmation of the shipping date and how it shipped: container number (FCL), warehouse receipt (LCL) or courier tracking number',
};
const confirmed = (sc) => !!(sc.confirmed_at && (sc.mode !== 'FCL' || sc.container_no));

const STATUS = {
  scheduled: { label: 'Scheduled', tag: 'plan' }, sent: { label: 'Waiting for supplier', tag: 'wait' }, received: { label: 'To review', tag: 'plan' },
  complete: { label: 'Complete', tag: 'ok' }, cancelled: { label: 'Cancelled', tag: 'done' },
};
/** Status for display. `missing` (stored) = required documents not in yet. */
function stateOf(sc, day) {
  if (sc.status === 'sent' && sc.sent_at && daysBetween(day10(sc.sent_at), day) > REMIND_AFTER[REMIND_AFTER.length - 1]) return { key: 'overdue', label: `Overdue ${daysBetween(day10(sc.sent_at), day)} d`, tag: 'bad' };
  const miss = (sc.missing || []).length;
  if ((sc.status === 'received' || sc.status === 'complete') && miss && (sc.followups || 0) >= FOLLOW_AFTER.length && sc.last_followup_at && daysBetween(day10(sc.last_followup_at), day) >= FOLLOW_AFTER[FOLLOW_AFTER.length - 1]) return { key: 'docs_missing', label: 'Documents missing', tag: 'bad' };
  if (sc.status === 'complete' && miss) return { key: 'complete', label: 'Accepted · documents missing', tag: 'wait' };
  return { key: sc.status, ...(STATUS[sc.status] || { label: sc.status, tag: 'plan' }) };
}
const logEntry = (text, at = new Date()) => ({ at: at.toISOString(), text: String(text).slice(0, 400) });
const withLog = (sc, text, at) => [...(Array.isArray(sc.log) ? sc.log : []), logEntry(text, at)].slice(-60);

/** Loading date of a container: set by you, or ETD − 3 days. */
function loadingDate(c, sailing) {
  if (c?.loading_date) return day10(c.loading_date);
  return sailing?.etd ? PL.addDays(day10(sailing.etd), -LEAD_DAYS) : null;
}
const modeOf = (c) => (!c ? '' : c.box === 'LCL' ? 'LCL' : 'FCL');
/** Earliest day to chase the bill of lading: ETD + 3, or loading date + 6. */
const blFrom = (sc, sailing) => (sailing?.etd ? PL.addDays(day10(sailing.etd), BL_AFTER_ETD) : sc.due_date ? PL.addDays(day10(sc.due_date), LEAD_DAYS + BL_AFTER_ETD) : null);

/** Planned figures of the lines, kept so the actual figures can be compared later. */
const plannedOf = (lines) => lines.map((l) => ({ id: l.id, po: l.po, product: l.product || '', qty: num(l.qty), cartons: num(l.cartons), gross_kg: num(l.gross_kg), cbm: num(l.cbm), carton: [l.carton_l_cm, l.carton_w_cm, l.carton_h_cm].every((x) => Number(x) > 0) ? [l.carton_l_cm, l.carton_w_cm, l.carton_h_cm].map(Number) : null }));
const posOf = (lines) => [...new Set(lines.map((l) => l.po).filter(Boolean))];

/** Create / update the scheduled requests for every planned container with a loading date. */
async function syncScheduled(db, day) {
  const cs = await db.list('plan_containers').catch(() => []);
  const all = await db.list('ship_confirmations').catch(() => null);
  if (!all) return { created: 0 };
  let created = 0;
  for (const c of cs) {
    const sailing = c.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
    const ld = loadingDate(c, sailing);
    const mine = all.filter((x) => x.container_id === c.id);
    const lines = ld ? (await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => [])) : [];
    const bySup = {};
    for (const l of lines) (bySup[l.supplier_id] = bySup[l.supplier_id] || []).push(l);
    for (const x of mine.filter((m) => m.status === 'scheduled' && !bySup[m.supplier_id])) await db.remove('ship_confirmations', { id: x.id });
    if (!ld || daysBetween(ld, day) > 14) continue;
    for (const [sid, ls] of Object.entries(bySup)) {
      const ex = mine.find((m) => m.supplier_id === sid && m.status !== 'cancelled');
      const patch = { pos: posOf(ls), order_ids: ls.map((l) => l.id), mode: modeOf(c), planned: plannedOf(ls), updated_at: new Date().toISOString() };
      if (!ex) {
        await db.insert('ship_confirmations', { code: newCode(), token: newToken(), supplier_id: sid, container_id: c.id, due_date: ld, status: 'scheduled', reminders: 0, followups: 0, missing: required({ mode: modeOf(c) }).filter((r) => !r[3]).map((r) => r[0]), log: [logEntry(`Scheduled for ${PL.short(ld)} (${c.loading_date ? 'loading date' : `ETD − ${LEAD_DAYS} days`})`)], created_at: new Date().toISOString(), ...patch });
        created++;
      } else if (ex.status === 'scheduled') {
        await db.update('ship_confirmations', { id: ex.id }, { ...patch, due_date: ex.new_date || ld });
      }
    }
  }
  return { created };
}

/** Facts for the email / page: lines, supplier, container, sailing. */
async function factsOf(db, sc) {
  const supplier = await db.get('suppliers', sc.supplier_id).catch(() => null);
  const c = sc.container_id ? await db.get('plan_containers', sc.container_id).catch(() => null) : null;
  const sailing = c?.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
  let lines = (await Promise.all((sc.order_ids || []).map((id) => db.get('plan_orders', id).catch(() => null)))).filter(Boolean);
  if (!lines.length && (sc.pos || []).length) lines = (await db.list('plan_orders', { filters: { supplier_id: sc.supplier_id } }).catch(() => [])).filter((l) => sc.pos.some((p) => PL.normPo(p) === PL.normPo(l.po)));
  return { supplier, c, sailing, lines };
}
const filesOf = async (db, sc) => (sc.id ? (await db.list('plan_files', { filters: { supplier_id: sc.supplier_id } }).catch(() => [])).filter((f) => f.shipment_id === sc.id) : []);

/**
 * Document checklist right now: each document with its state.
 *   have · miss (chase now) · later (B/L before ETD + 3) · opt (optional, not received)
 */
function checklistOf(sc, files, sailing, day) {
  const bl = blFrom(sc, sailing);
  const out = [];
  if (!confirmed(sc)) out.push({ key: 'confirm', label: sc.mode === 'FCL' ? 'Container and seal number' : 'Shipment confirmation', ask: CONFIRM[sc.mode || ''], state: 'miss' });
  for (const [kind, label, ask, optional] of required(sc)) {
    const have = files.some((f) => f.kind === kind);
    const state = have ? 'have' : optional ? 'opt' : kind === 'Bill of lading' && sc.mode !== 'COURIER' && bl && day < bl ? 'later' : 'miss';
    out.push({ key: kind, label, ask, state, from: state === 'later' ? bl : null });
  }
  return out;
}
const missingKinds = (list) => list.filter((x) => (x.state === 'miss' || x.state === 'later') && x.key !== 'confirm').map((x) => x.key);

/** When the next automatic follow-up goes out (China date), or null. */
function nextFollowup(sc, list) {
  if (sc.paused || !['received', 'complete'].includes(sc.status)) return null;
  const chase = list.filter((x) => x.state === 'miss' || x.state === 'later');
  if (!chase.length) return null;
  if (sc.next_followup) return day10(sc.next_followup);
  const n = sc.followups || 0;
  if (n >= FOLLOW_AFTER.length) return null;
  const base = n === 0 ? (sc.received_at ? PL.addDays(day10(sc.received_at), FOLLOW_AFTER[0]) : null) : (sc.last_followup_at ? PL.addDays(day10(sc.last_followup_at), FOLLOW_AFTER[n]) : null);
  if (!base) return null;
  const firstNow = chase.filter((x) => x.state === 'miss').length ? base : null;
  const bl = chase.find((x) => x.state === 'later')?.from;
  return firstNow || (bl && bl > base ? bl : base);
}

/**
 * Editable parts of the email for one kind: request · reminder · missing.
 * items: [{ text, state, on }] — what we ask for; received: labels already in.
 */
function draftParts(sc, { supplier, c, sailing, lines }, { kind = 'request', list = [] } = {}) {
  const mode = sc.mode || '';
  const date = sc.due_date ? PL.short(sc.due_date) : 'today';
  const pos = (sc.pos || []).join(', ');
  const where = c ? portName(c.port) : [...new Set(lines.map((l) => portName(l.port)).filter(Boolean))].join(', ');
  const shipment = !c ? (mode === 'LCL' ? 'LCL (shared container)' : mode === 'FCL' ? 'FCL (full container)' : mode === 'COURIER' ? 'Courier' : '') : [mode === 'LCL' ? 'LCL (shared container)' : `FCL, ${c.box === '20GP' ? "20' GP" : c.box === '40HQ' ? "40' HQ" : "40' GP"}`, `${portName(c.port)}${sailing ? ` → ${portName(sailing.destination)}` : ''}`, sailing?.carrier, sailing?.etd ? `ETD ${PL.short(sailing.etd)}` : null].filter(Boolean).join(' · ');
  const tail = `${/^po/i.test(pos) ? '' : 'PO '}${pos}${where ? ` – ${where}` : ''}${sc.due_date ? `, ${PL.short(sc.due_date)}` : ''}`;
  const plan = mode === 'LCL'
    ? `According to our plan, the goods below are delivered to the forwarder's CFS warehouse on ${date}. Please confirm the delivery and reply to this email with the shipping documents attached.`
    : mode === 'FCL'
      ? `According to our plan, the goods below are loaded into the container on ${date}. Please confirm the loading and reply to this email with the shipping documents attached.`
      : mode === 'COURIER'
        ? 'Please confirm the courier pickup of the goods below and reply to this email with the shipping documents attached.'
        : 'Please confirm the shipment of the goods below and reply to this email with the shipping documents attached.';
  const all = [{ text: CONFIRM[mode], state: '', key: 'confirm' }, ...required(sc).map(([k, , ask, opt]) => ({ text: ask, state: opt ? 'opt' : '', key: k }))];
  const stateOfKey = (k) => list.find((x) => x.key === k)?.state;
  let subject; let intro; let items; let listLabel = 'Please send';
  if (kind === 'missing') {
    subject = `Missing shipping documents – ${tail}`;
    intro = 'Thank you for the documents you sent. We are still missing the documents below for this shipment — please reply to this email with them attached.';
    listLabel = 'Still missing';
    items = all.map((x) => { const st = stateOfKey(x.key) || (x.key === 'confirm' ? 'have' : 'miss'); const later = list.find((y) => y.key === x.key)?.from; return { text: x.text, state: st, on: st === 'miss', note: st === 'later' && later ? `not before ${PL.short(later)}` : '' }; });
  } else if (kind === 'reminder') {
    subject = `Reminder: Shipment confirmation & documents – ${tail}`;
    intro = `This is a friendly reminder: we have not received the shipment confirmation and documents yet.\n\n${plan}`;
    items = all.map((x) => { const st = stateOfKey(x.key) === 'have' ? 'have' : x.state === 'opt' ? 'opt' : 'miss'; return { text: x.text, state: st, on: st !== 'have' }; });
  } else {
    subject = `Shipment confirmation & documents – ${tail}`;
    intro = plan;
    items = all.map((x) => ({ text: x.text, state: x.state, on: true }));
  }
  const received = list.filter((x) => x.state === 'have').map((x) => (x.key === 'confirm' ? (sc.container_no ? `Container ${sc.container_no}` : 'Shipment confirmation') : x.label));
  if (sc.container_no && !received.some((r) => /^Container /.test(r))) received.push(`Container ${sc.container_no}`);
  const rows = lines.map((l) => ({ po: l.po, product: l.product || '', qty: l.qty ? int(l.qty) : '', cartons: l.cartons ? int(l.cartons) : '', cbm: l.cbm ? n2(l.cbm) : '' }));
  return { subject, intro, defaultIntro: intro, items, listLabel, received, rows, shipment, name: supplier?.contact_name || supplier?.name || '' };
}

const CLOSING = 'Please reply to this email with the files attached and keep the reference in the subject. If the shipment date has changed, just tell us the new date in your reply.';
/** Finished email: parts + edits ({ subject, intro, items: [text], received: bool }). The code always ends the subject. */
function composeEmail(sc, parts, edits = {}) {
  const d = { ...parts, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  const subject = `${String(d.subject).replace(CODE_RE, '').replace(/\[\s*\]/g, '').trim()} [${sc.code}]`;
  const asks = (edits.items ? edits.items : parts.items.filter((x) => x.on).map((x) => x.text)).map((x) => String(x).replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
  const received = edits.received === false ? [] : parts.received;
  return { subject, ...shipmentEmail({ name: d.name, intro: d.intro, rows: d.rows, shipment: d.shipment, listLabel: d.listLabel, asks, received, closing: CLOSING }) };
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/**
 * Send a request, reminder or missing-documents follow-up now.
 * `edits` from the popup: { to: [], cc: [], subject, intro, items: [text], received: bool }. Without `to`: the supplier's
 * email and portal users (automatic run).
 */
async function sendRequest(db, config, sc, { kind = 'request', by = null, at = new Date(), edits = null } = {}) {
  const facts = await factsOf(db, sc);
  if (!facts.supplier) throw new Error('Supplier not found');
  const P = require('./projects');
  const to = edits?.to ? [...new Set(edits.to.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : await P.supplierRecipients(db, facts.supplier);
  const ccIn = edits?.cc ? edits.cc.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : null;
  const bad = [...to, ...(ccIn || [])].find((e) => !EMAIL_RE.test(e)); if (bad) throw new Error(`Check this email address: ${bad}`);
  if (!to.length) throw new Error(`${facts.supplier.name} has no email address — add one in the To field`);
  const cc = ccIn ? [...new Set(ccIn)].filter((e) => !to.includes(e)) : kind === 'request' ? P.ownerEmails() : [];
  const list = checklistOf(sc, await filesOf(db, sc), facts.sailing, chinaNow(at).day);
  const parts = draftParts(sc, facts, { kind, list });
  if (kind === 'missing' && !edits?.items && !parts.items.some((x) => x.on)) return { skipped: true };
  const m = composeEmail(sc, parts, edits || {});
  await sendEmail(config, { to, cc, subject: m.subject, text: m.text, html: m.html, replyTo: [docsAddress()] });
  const now = at.toISOString();
  const who = `${to.join(', ')}${by ? ` by ${by}` : ''}`;
  const patch = kind === 'missing'
    ? { followups: (sc.followups || 0) + 1, last_followup_at: now, next_followup: null, log: withLog(sc, `Follow-up ${(sc.followups || 0) + 1} — asked for ${(edits?.items || parts.items.filter((x) => x.on).map((x) => x.text)).length} missing item(s), sent to ${who}`, at), updated_at: now }
    : kind === 'reminder'
      ? { reminders: (sc.reminders || 0) + 1, last_reminded_at: now, log: withLog(sc, `Reminder ${(sc.reminders || 0) + 1} sent to ${who}`, at), updated_at: now }
      : { status: sc.status === 'received' || sc.status === 'complete' ? sc.status : 'sent', sent_at: now, sent_to: to.join(', '), reminders: 0, planned: plannedOf(facts.lines), log: withLog(sc, `Request sent to ${who}`, at), updated_at: now };
  await db.update('ship_confirmations', { id: sc.id }, patch);
  return { to, cc };
}

/** Hourly: schedule, send what is due (9:00 China time), remind, and follow up on missing documents. */
async function runShipConfirmations({ db, config, now = new Date() }) {
  const { day, hour } = chinaNow(now);
  await syncScheduled(db, day);
  const all = await db.list('ship_confirmations').catch(() => []);
  let sent = 0; let reminded = 0; let followed = 0;
  if (hour < SEND_HOUR) return { sent, reminded, followed };
  for (const sc of all.filter((x) => x.status === 'scheduled' && x.due_date && day10(x.due_date) <= day)) {
    try { await sendRequest(db, config, sc, { at: now }); sent++; } catch (e) { await db.update('ship_confirmations', { id: sc.id }, { log: withLog(sc, `Could not send: ${e.provider?.reason || e.message}`), updated_at: new Date().toISOString() }).catch(() => null); console.error('Shipment request failed:', e.message); }
  }
  for (const sc of all.filter((x) => x.status === 'sent' && x.sent_at && !x.paused)) {
    const n = sc.reminders || 0;
    if (n < REMIND_AFTER.length && daysBetween(day10(sc.sent_at), day) >= REMIND_AFTER[n]) {
      try { await sendRequest(db, config, sc, { kind: 'reminder', at: now }); reminded++; } catch (e) { console.error('Shipment reminder failed:', e.message); }
    }
  }
  for (const sc of all.filter((x) => ['received', 'complete'].includes(x.status) && !x.paused)) {
    const f = await factsOf(db, sc);
    const list = checklistOf(sc, await filesOf(db, sc), f.sailing, day);
    const next = nextFollowup(sc, list);
    if (next && next <= day && list.some((x) => x.state === 'miss')) {
      try { const r = await sendRequest(db, config, sc, { kind: 'missing', at: now }); if (!r.skipped) followed++; } catch (e) { console.error('Shipment follow-up failed:', e.message); }
    }
  }
  return { sent, reminded, followed };
}

// ── reading documents ───────────────────────────────────────────────────────
const TOOL = {
  name: 'record_shipment',
  description: 'Record what the supplier confirmed about the shipment and the figures in its shipping documents (packing list, invoice, B/L, warehouse receipt).',
  input_schema: {
    type: 'object',
    properties: {
      loaded: { type: 'boolean', description: 'True when the supplier confirms the goods are loaded / delivered to the warehouse / shipped' },
      delayed: { type: 'boolean', description: 'True when the supplier says the shipment is delayed' },
      new_date: { type: 'string', description: 'New loading / shipping date when delayed, YYYY-MM-DD' },
      loaded_on: { type: 'string', description: 'Date the container was loaded or goods were delivered, YYYY-MM-DD' },
      container_no: { type: 'string', description: 'Container number, e.g. CSNU6184207 (4 letters + 7 digits), no spaces' },
      seal_no: { type: 'string' },
      bl_no: { type: 'string', description: 'Bill of lading or house B/L number' },
      vessel: { type: 'string' },
      lines: {
        type: 'array', description: 'One entry per PO / product line in the packing list',
        items: { type: 'object', properties: { po: { type: 'string' }, product: { type: 'string' }, qty: { type: 'number', description: 'pieces' }, cartons: { type: 'number' }, gross_kg: { type: 'number', description: 'total gross weight of the line in kg' }, cbm: { type: 'number', description: 'total volume of the line in m³' }, carton_l_cm: { type: 'number' }, carton_w_cm: { type: 'number' }, carton_h_cm: { type: 'number' }, units_per_carton: { type: 'number' }, carton_gw_kg: { type: 'number' } } },
      },
      total_cartons: { type: 'number' }, total_gross_kg: { type: 'number' }, total_cbm: { type: 'number' },
      summary: { type: 'string', description: 'One or two sentences: what the supplier said and which documents were sent' },
    },
    required: ['summary'],
  },
};
const AI_DOC = /\.(pdf|png|jpe?g|webp)$/i;
const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function readDocs({ text = '', files = [], planned = [] }) {
  const content = []; let tables = '';
  for (const f of files.slice(0, 6)) {
    const n = String(f.name || '').toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (!f.buffer?.length || f.buffer.length > 10 * 1024 * 1024) continue;
    if (/^image\//.test(f.type || '') && f.kind === 'Loading photos') continue; // photos carry no figures
    if (AI_DOC.test(n)) content.push(ext === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: MIMES[ext], data: f.buffer.toString('base64') } });
    else if (/\.(xlsx|xlsm)$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseXlsx(f.buffer).slice(0, 120).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
    else if (/\.csv$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseCsv(decodeText(f.buffer)).slice(0, 120).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
  }
  const plan = planned.map((p) => `${p.po} · ${p.product || '(whole PO)'} · ${p.qty ?? '?'} pcs · ${p.cartons ?? '?'} ctns · ${p.cbm ?? '?'} m³`).join('\n');
  const year = new Date().getFullYear();
  content.push({ type: 'text', text: `Today is ${PL.today()} (dates without a year are ${year}). A supplier replied to our request to confirm a shipment and send the shipping documents. Record what they confirmed and the actual figures from the documents. Give per-line totals (all cartons of the line), not per-carton values, for cartons / gross_kg / cbm. Leave out anything not stated.\n\nPLANNED LINES:\n${plan}\n\nTHEIR MESSAGE:\n${String(text).slice(0, 20000)}${tables}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 3000 });
  return result || {};
}

const cleanNo = (v, n = 40) => (v ? String(v).replace(/\s+/g, '').toUpperCase().slice(0, n) : null);
/** Normalised AI / form output → stored facts. */
function factsFrom(r) {
  const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 60).map((l) => ({ po: l.po ? String(l.po).slice(0, 40) : '', product: l.product ? String(l.product).slice(0, 160) : '', qty: num(l.qty), cartons: num(l.cartons), gross_kg: num(l.gross_kg), cbm: num(l.cbm), carton: [l.carton_l_cm, l.carton_w_cm, l.carton_h_cm].every((x) => Number(x) > 0) ? [l.carton_l_cm, l.carton_w_cm, l.carton_h_cm].map(Number) : null, units_per_carton: num(l.units_per_carton), carton_gw_kg: num(l.carton_gw_kg) }));
  const sum = (k) => (lines.some((l) => l[k] != null) ? Math.round(lines.reduce((a, l) => a + (l[k] || 0), 0) * 1000) / 1000 : null);
  return {
    loaded: !!r.loaded, delayed: !!r.delayed, new_date: PL.isoDay(r.new_date), loaded_on: PL.isoDay(r.loaded_on),
    container_no: cleanNo(r.container_no, 15), seal_no: cleanNo(r.seal_no, 30), bl_no: cleanNo(r.bl_no, 40), vessel: r.vessel ? String(r.vessel).slice(0, 80) : null,
    lines, cartons: num(r.total_cartons) ?? sum('cartons'), gross_kg: num(r.total_gross_kg) ?? sum('gross_kg'), cbm: num(r.total_cbm) ?? sum('cbm'),
    summary: r.summary ? String(r.summary).slice(0, 1000) : '',
  };
}
/** Merge new facts into what we had (a later B/L should not wipe the packing list figures). */
function mergeFacts(old, nw) {
  if (!old) return nw;
  const out = { ...old };
  for (const [k, v] of Object.entries(nw)) if (v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false) out[k] = v;
  if (nw.summary) out.summary = [old.summary, nw.summary].filter(Boolean).join(' ').slice(-1000);
  return out;
}

/** Kind of a file sent for a shipment. */
function kindOf(name, type) {
  const n = String(name || '').toLowerCase();
  if (/packing|\bp\.?l\b/.test(n)) return 'Packing list';
  if (/invoice|\bci\b/.test(n)) return 'Invoice';
  if (/\bb\/?l\b|bill.?of.?lading|\bhbl\b|\bmbl\b|lading|waybill|\bawb\b/.test(n)) return 'Bill of lading';
  if (/fcr|cargo.?receipt|warehouse|\bcfs\b|入仓/.test(n)) return 'Warehouse receipt';
  if (/^image\//.test(type || '') || /\.(jpe?g|png|heic|webp)$/.test(n)) return 'Loading photos';
  return 'Other';
}

/**
 * Files + message from the supplier (email reply or upload page) → stored, read, status updated, owner told.
 * `form` (upload page) may carry loaded / delayed / new_date / loaded_on / container_no / seal_no.
 */
async function receive(db, config, sc, { from = '', text = '', files = [], form = null, by = null, quiet = false }) {
  const now = new Date().toISOString();
  const kept = files.filter((f) => f.buffer?.length).map((f) => ({ ...f, kind: f.kind || kindOf(f.name, f.type) }));
  const stored = [];
  for (const kind of [...new Set(kept.map((f) => f.kind))]) {
    const r = await PL.storeFiles(db, sc.supplier_id, kept.filter((f) => f.kind === kind), { pos: sc.pos || [], kind, by: by || (from ? `Email from ${from}`.slice(0, 120) : 'Supplier upload'), shipmentId: sc.id });
    stored.push(...r.saved, ...r.skipped);
  }
  let facts = form ? factsFrom(form) : null;
  if (AI.enabled() && (kept.some((f) => f.kind !== 'Loading photos') || (!form && text.trim()))) {
    try { const r = factsFrom(await readDocs({ text, files: kept, planned: sc.planned || [] })); facts = facts ? { ...r, ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== null && v !== '' && v !== false && !(Array.isArray(v) && !v.length))) } : r; }
    catch (e) { facts = facts || { summary: `Could not read the documents automatically (${String(e.message).slice(0, 100)}).` }; }
  }
  facts = mergeFacts(sc.facts, facts || { summary: '' });
  const delayed = facts.delayed && facts.new_date && !kept.some((f) => /Packing list|Invoice|Bill of lading|Warehouse receipt/.test(f.kind));
  const patch = { facts: { ...facts, delayed: false }, updated_at: now, reply_text: text ? String(text).slice(0, 30000) : sc.reply_text || null, received_at: now };
  let note;
  if (delayed) {
    Object.assign(patch, { status: 'scheduled', due_date: facts.new_date, new_date: facts.new_date, reminders: 0, received_at: sc.received_at || null });
    note = `Supplier reported a delay — new date ${PL.short(facts.new_date)}. The request goes out again then.`;
  } else {
    Object.assign(patch, { status: sc.status === 'complete' ? 'complete' : 'received' });
    if (facts.loaded || facts.container_no || kept.length) patch.confirmed_at = sc.confirmed_at || now;
    for (const k of ['container_no', 'seal_no', 'bl_no', 'loaded_on']) if (facts[k]) patch[k] = facts[k];
    note = `${by ? `${by}:` : 'Reply received'}${kept.length ? ` with ${kept.length} file${kept.length > 1 ? 's' : ''} (${[...new Set(kept.map((f) => f.kind))].join(', ')})` : ''}${facts.loaded ? ' — confirmed shipped' : ''}`;
  }
  if (!by && !delayed) Object.assign(patch, { followups: 0, next_followup: null, last_followup_at: null }); // a supplier reply starts the follow-up cycle again
  if (by) patch.received_at = sc.received_at || now; // your own upload doesn't count as the supplier's reply
  patch.log = withLog(sc, note);
  const nsc = { ...sc, ...patch };
  const f = await factsOf(db, nsc);
  patch.missing = missingKinds(checklistOf(nsc, await filesOf(db, nsc), f.sailing, chinaNow().day));
  await db.update('ship_confirmations', { id: sc.id }, patch);
  // confirmed → the PO lines are shipped
  if (!delayed && patch.confirmed_at) for (const id of sc.order_ids || []) await db.update('plan_orders', { id }, { shipped: true, updated_at: now }).catch(() => null);
  if (!quiet) await tellOwner(db, config, { ...sc, ...patch }, note);
  return { matched: true, id: sc.id, delayed: !!delayed, files: stored.length };
}

async function tellOwner(db, config, sc, note) {
  const P = require('./projects');
  const sup = await db.get('suppliers', sc.supplier_id).catch(() => null);
  const po = (sc.pos || [])[0];
  const link = po ? `${config.publicUrl}/admin/orders/view?supplier=${sc.supplier_id}&po=${encodeURIComponent(po)}#shipment` : `${config.publicUrl}/admin/orders/shipping`;
  const title = `${sup?.name || 'Supplier'} — PO ${(sc.pos || []).join(', ')}`;
  await P.notifyOwner(config, `[Shipping documents] ${title}`, `${note}\n\n${link}`, { title: 'Shipping documents', intro: note, project: title, button: sc.status === 'received' ? 'Review' : 'Open', link });
  try {
    const tg = require('./telegram');
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, `📄 <b>Shipping documents</b>\n${tg.escapeHtml(title)}\n${tg.escapeHtml(note)}\n${link}`);
  } catch (e) { console.error('Shipping Telegram failed:', e.message); }
}

/** Inbound email (docs@… or LBS code in the subject). */
async function handleShipEmail({ db, config, from, subject, text, files = [] }) {
  const m = String(subject || '').match(CODE_RE) || String(text || '').match(CODE_RE);
  if (!m) return { matched: false };
  const sc = (await db.list('ship_confirmations', { filters: { code: `LBS-${m[1].toUpperCase()}` }, limit: 1 }).catch(() => []))[0];
  if (!sc) return { matched: false };
  return receive(db, config, sc, { from, text, files });
}

/** Actual figures per planned line (matched by PO, then product name, then order). */
function matchLines(planned = [], facts = {}) {
  const act = [...(facts.lines || [])]; const used = new Set();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return planned.map((p) => {
    const samePo = act.map((a, i) => [a, i]).filter(([a, i]) => !used.has(i) && (!a.po || PL.normPo(a.po) === PL.normPo(p.po)));
    let hit = samePo.find(([a]) => p.product && a.product && (norm(a.product).includes(norm(p.product)) || norm(p.product).includes(norm(a.product))));
    if (!hit && samePo.length && planned.filter((x) => PL.normPo(x.po) === PL.normPo(p.po)).length === 1) hit = samePo[0];
    if (!hit) hit = samePo[0];
    if (hit) used.add(hit[1]);
    return { plan: p, act: hit ? hit[0] : null };
  });
}

/** Accept the actual figures: PO lines get them, the container its number, products their packing; stats kept. */
async function accept(db, sc, { values = {}, updateProducts = false, by = null } = {}) {
  const facts = { ...(sc.facts || {}), ...Object.fromEntries(Object.entries(values).filter(([k]) => ['container_no', 'seal_no', 'bl_no', 'loaded_on'].includes(k))) };
  const pairs = matchLines(sc.planned || [], facts);
  const now = new Date().toISOString();
  const forCatalog = [];
  for (const { plan, act } of pairs) {
    if (!act) continue;
    const patch = { updated_at: now, shipped: true };
    for (const k of ['cartons', 'gross_kg', 'cbm']) if (act[k] != null) patch[k] = act[k];
    if (act.cbm != null) patch.cbm_estimated = false;
    if (act.carton) [patch.carton_l_cm, patch.carton_w_cm, patch.carton_h_cm] = act.carton;
    if (act.units_per_carton != null) patch.units_per_carton = act.units_per_carton;
    if (act.carton_gw_kg != null) patch.carton_gw_kg = act.carton_gw_kg;
    await db.update('plan_orders', { id: plan.id }, patch).catch(() => null);
    forCatalog.push({ po: plan.po, product: plan.product, sku: null, ...patch, fromPackingList: true });
  }
  if (updateProducts && forCatalog.length) await PL.packingToCatalog(db, sc.supplier_id, forCatalog).catch(() => 0);
  if (sc.container_id && (facts.container_no || facts.seal_no)) await db.update('plan_containers', { id: sc.container_id }, { container_no: facts.container_no || null, seal_no: facts.seal_no || null, updated_at: now }).catch(() => null);
  const tot = (side, k) => { const xs = pairs.map((x) => x[side]?.[k]).filter((v) => v != null); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) * 1000) / 1000 : null; };
  const actual = { cartons: tot('act', 'cartons') ?? facts.cartons ?? null, gross_kg: tot('act', 'gross_kg') ?? facts.gross_kg ?? null, cbm: tot('act', 'cbm') ?? facts.cbm ?? null, planned_cbm: tot('plan', 'cbm'), planned_cartons: tot('plan', 'cartons'), docs_days: sc.sent_at ? daysBetween(String(sc.sent_at).slice(0, 10), now.slice(0, 10)) : null };
  await db.update('ship_confirmations', { id: sc.id }, { status: 'complete', facts, actual, container_no: facts.container_no || sc.container_no || null, seal_no: facts.seal_no || sc.seal_no || null, bl_no: facts.bl_no || sc.bl_no || null, loaded_on: facts.loaded_on || sc.loaded_on || null, accepted_at: now, accepted_by: by, log: withLog(sc, `Accepted${by ? ` by ${by}` : ''} — figures saved to the PO`), updated_at: now });
  return { lines: forCatalog.length };
}

/** Request for one supplier's PO right away (e.g. a PO shipped without a container plan). */
async function createFor(db, { supplierId, po, dryRun = false, mode = null }) {
  const lines = (await db.list('plan_orders', { filters: { supplier_id: supplierId } })).filter((l) => PL.normPo(l.po) === PL.normPo(po));
  if (!lines.length) throw new Error('Purchase order not found');
  const cIds = [...new Set(lines.map((l) => l.container_id).filter(Boolean))];
  const c = cIds.length === 1 ? await db.get('plan_containers', cIds[0]).catch(() => null) : null;
  const all = await db.list('ship_confirmations', { filters: { supplier_id: supplierId } }).catch(() => []);
  const ex = all.find((x) => x.status !== 'cancelled' && (c ? x.container_id === c.id : (x.pos || []).some((p) => PL.normPo(p) === PL.normPo(po))));
  if (ex) return ex;
  const sameC = c ? (await db.list('plan_orders', { filters: { container_id: c.id } })).filter((l) => l.supplier_id === supplierId) : lines;
  const sailing = c?.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
  const md = c ? modeOf(c) : MODES[mode] ? mode : '';
  const row = { code: newCode(), token: newToken(), supplier_id: supplierId, container_id: c?.id || null, mode: md, followups: 0, missing: required({ mode: md }).filter((r) => !r[3]).map((r) => r[0]), pos: posOf(sameC), order_ids: sameC.map((l) => l.id), planned: plannedOf(sameC), due_date: loadingDate(c, sailing) || PL.today(), status: 'scheduled', reminders: 0, log: [logEntry('Created by hand')], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  return dryRun ? { ...row, id: null, code: 'LBS-NEW', token: '…' } : db.insert('ship_confirmations', row);
}

/** Upload link still valid? */

/** Per supplier: shipments, average days to documents, volume accuracy. */
function supplierStats(rows) {
  const by = {};
  for (const r of rows.filter((x) => x.status === 'complete' && x.actual)) {
    const s = (by[r.supplier_id] = by[r.supplier_id] || { n: 0, days: [], vol: [], kg: 0, cbm: 0 });
    s.n++;
    if (r.actual.docs_days != null) s.days.push(r.actual.docs_days);
    if (r.actual.cbm && r.actual.planned_cbm) s.vol.push((r.actual.cbm - r.actual.planned_cbm) / r.actual.planned_cbm);
    s.kg += r.actual.gross_kg || 0; s.cbm += r.actual.cbm || 0;
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return Object.fromEntries(Object.entries(by).map(([k, s]) => [k, { n: s.n, days: avg(s.days), vol: avg(s.vol), kg: s.kg, cbm: s.cbm }]));
}

module.exports = { MODES, REMIND_AFTER, FOLLOW_AFTER, draftParts, checklistOf, nextFollowup, missingKinds, filesOf, blFrom, CLOSING, factsOf, CODE_RE, REQUIRED, required, STATUS, stateOf, chinaNow, loadingDate, docsAddress, composeEmail, sendRequest, syncScheduled, runShipConfirmations, readDocs, factsFrom, receive, handleShipEmail, matchLines, accept, createFor, supplierStats, kindOf, daysBetween, LEAD_DAYS };
