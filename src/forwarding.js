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
  ['container_no', 'Container'], ['container_type', 'Container type'], ['vessel', 'Vessel'], ['voyage', 'Voyage'],
  ['pol', 'Port of loading'], ['pod', 'Port of discharge'], ['cfs_cutoff', 'CFS cut-off'],
  ['etd', 'ETD'], ['atd', 'Sailed'], ['eta', 'ETA'], ['ata', 'Arrived'],
];
const DATES = ['cfs_cutoff', 'etd', 'atd', 'eta', 'ata'];
const NUMS = ['booking_no', 'hbl_no', 'mbl_no', 'container_no'];
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
      booking_no: { type: 'string', description: 'Booking / SO / reference number' },
      hbl_no: { type: 'string', description: 'House bill of lading number (issued by the forwarder)' },
      mbl_no: { type: 'string', description: 'Master / ocean bill of lading number (issued by the shipping line)' },
      container_no: { type: 'string', description: 'Container number: 4 letters + 7 digits, e.g. CSNU6184207' },
      container_type: { type: 'string', description: "e.g. 40' HQ" },
      vessel: { type: 'string', description: 'Vessel name without the voyage' },
      voyage: { type: 'string' },
      pol: { type: 'string', description: 'Port of loading, as written' },
      pod: { type: 'string', description: 'Port of discharge, as written' },
      cfs_cutoff: { type: 'string', description: 'CFS / cargo cut-off date, YYYY-MM-DD' },
      etd: { type: 'string', description: 'Estimated departure, YYYY-MM-DD' },
      atd: { type: 'string', description: 'Actual departure (has sailed), YYYY-MM-DD — only when the document says it sailed / departed' },
      eta: { type: 'string', description: 'Estimated arrival at the port of discharge, YYYY-MM-DD' },
      ata: { type: 'string', description: 'Actual arrival, YYYY-MM-DD — only for arrival notices / "arrived"' },
      pos: { type: 'array', items: { type: 'string' }, description: 'Purchase order numbers mentioned' },
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
  content.push({ type: 'text', text: `Today is ${PL.today()} (dates without a year are ${new Date().getFullYear()}). This came from a freight forwarder about an ocean shipment (FCL or LCL). Record what it says. Leave out anything not stated; never guess numbers.\n\n${String(text).slice(0, 20000)}${tables}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 1500 });
  return result || {};
}

/** Normalised facts (AI output or form values). */
function factsFrom(r = {}) {
  const out = { doc_type: DOC_TYPES[r.doc_type] ? r.doc_type : 'other', summary: r.summary ? String(r.summary).slice(0, 1000) : '' };
  for (const [k] of FIELDS) {
    const v = r[k];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    out[k] = DATES.includes(k) ? PL.isoDay(v) : NUMS.includes(k) ? clean(v, k === 'container_no' ? 11 : 40) : String(v).trim().slice(0, 120);
  }
  if (out.container_no && !/^[A-Z]{4}\d{7}$/.test(out.container_no)) delete out.container_no;   // not a container number
  out.pos = [...new Set((Array.isArray(r.pos) ? r.pos : []).map((p) => String(p).trim()).filter(Boolean))].slice(0, 20);
  return out;
}

/** Stage of a container from its forwarder data. */
function stageOf(fwd = {}, day = PL.today()) {
  if (!fwd) return null;
  if (fwd.ata || fwd.arrived) return 'arrived';
  if (fwd.atd || fwd.sailed || (fwd.etd && fwd.etd < day && fwd.mbl_no)) return fwd.eta && fwd.eta <= day ? 'arrived_due' : 'on_water';
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

/** What would change on the container: [{ key, label, old, value, state: new|changed|same }]. */
function diff(container, facts) {
  const cur = container?.fwd || {};
  return FIELDS.filter(([k]) => facts[k]).map(([k, label]) => {
    const old = cur[k] ?? (k === 'container_no' ? container?.container_no : null) ?? null;
    return { key: k, label, old, value: facts[k], state: !old ? 'new' : String(old) === String(facts[k]) ? 'same' : 'changed', date: DATES.includes(k) };
  });
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
  for (const [k] of FIELDS) if (facts[k]) next[k] = facts[k];
  if (facts.eta && cur.eta && facts.eta !== cur.eta) { next.eta_prev = cur.eta; next.eta_changed_at = now(); }
  if (facts.doc_type === 'arrival_notice' && !next.ata) next.arrived = true;
  if ((facts.doc_type === 'shipping_advice' || facts.doc_type === 'bill_of_lading') && !next.atd) next.sailed = true;
  next.updated_at = now();
  next.docs = [...(cur.docs || []), { id: upd.id, type: facts.doc_type, at: upd.created_at, files: (upd.files || []).length }].slice(-30);
  const patch = { fwd: next, updated_at: now() };
  if (next.container_no) patch.container_no = next.container_no;
  const st = stageOf(next);
  if (st && st !== 'booked' && c.status !== 'shipped') {
    patch.status = 'shipped';
    for (const l of await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => [])) await db.update('plan_orders', { id: l.id }, { shipped: true, updated_at: now() }).catch(() => null);
  } else if (st === 'booked' && ['planned', 'requested'].includes(c.status)) patch.status = 'booked';
  await db.update('plan_containers', { id: c.id }, patch);
  await db.update('fwd_updates', { id: upd.id }, { status: 'accepted', container_id: c.id, facts, decided_by: by, decided_at: now() });
  const slip = cur.eta && next.eta ? Math.round((Date.parse(next.eta) - Date.parse(cur.eta)) / 864e5) : 0;
  if (slip > 2) {
    const P = require('./projects');
    const link = `${config.publicUrl}/admin/orders/shipping#forwarder`;
    await P.notifyOwner(config, `[ETA moved] ${portName(c.port)} ${c.box === 'LCL' ? 'LCL shipment' : 'container'} — now ${PL.short(next.eta)} (+${slip} days)`, `ETA moved from ${PL.short(cur.eta)} to ${PL.short(next.eta)}.\n\n${link}`, { title: 'ETA moved', intro: `ETA moved from ${PL.short(cur.eta)} to ${PL.short(next.eta)} (+${slip} days).`, button: 'Open', link }).catch(() => null);
  }
  return { container: { ...c, ...patch }, stage: st, slip };
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

async function dismiss(db, upd, by = null) { await db.update('fwd_updates', { id: upd.id }, { status: 'dismissed', decided_by: by, decided_at: now() }); }

module.exports = { quoteIsBooked, FIELDS, DATES, DOC_TYPES, STAGES, TOOL, shipmentsAddress, read, factsFrom, stageOf, stageLabel, trackUrl, storeFiles, match, diff, createUpdate, handleFwdEmail, accept, dismiss };
