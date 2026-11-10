'use strict';
// Forwarder quotations for a planned container.
//   1. We e-mail each selected forwarder a formal request for quotation; the subject carries a code (LBQ-XXXXX).
//   2. Their reply arrives through the inbound mailbox (quotes@…), is matched by that code, and AI reads the
//      rate, carrier, ETD / ETA, cut-off, validity and free time into plan_quotes, keeping the original text and files.

const crypto = require('node:crypto');
const AI = require('./ai');
const PL = require('./planning');
const SC = require('./schedules');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

const CODE_RE = /\bLBQ-([A-Z0-9]{5})\b/i;
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => `LBQ-${Array.from(crypto.randomBytes(5), (b) => ALPH[b % ALPH.length]).join('')}`;
const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const quoteAddress = () => (process.env.QUOTES_EMAIL || `quotes@${domain()}`).toLowerCase();
const portName = (c) => SC.PORT[c]?.name || c;
const n2 = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
const int = (v) => Number(v || 0).toLocaleString('en-US');
const longDate = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const isoDay = (v) => PL.isoDay(v);

/** Business day n days after today (skips Sat/Sun). */
function replyBy(n = 3) { let d = PL.today(); let k = 0; while (k < n) { d = PL.addDays(d, 1); const w = new Date(`${d}T12:00:00Z`).getUTCDay(); if (w && w !== 6) k++; } return d; }

/** Greeting name for one forwarder: "Ms. Chen" style is left to the user; we use the contact's name or "<Company> team". */
const greetName = (f) => (f?.contact_name ? f.contact_name.trim() : `${f?.company || 'Sir or Madam'}${f?.company ? ' team' : ''}`);

/**
 * Formal request-for-quotation text for one container. `{contact}` in the body is replaced per forwarder.
 * Returns { subject, body } — the code is appended to the subject when sending.
 */
function rfqText({ container, box, lines, sups, sailing, contacts = false, by = '' }) {
  const sum = (k) => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  const has = (k) => lines.some((l) => Number(l[k]) > 0);
  const dates = lines.map((l) => l.ready_date).filter(Boolean).sort();
  const ready = dates[dates.length - 1] || null;
  const dest = sailing ? `${portName(sailing.destination)} (${sailing.destination})` : 'Los Angeles (USLAX) or Long Beach (USLGB)';
  const nSup = Object.keys(sups).length;
  const pl = lines.map((l, i) => `${i + 1}. ${l.po} — ${sups[l.supplier_id]?.name || 'Supplier'}${l.product ? ` — ${l.product}` : ''}\n   ${[l.qty ? `${int(l.qty)} pcs` : null, l.cartons ? `${int(l.cartons)} cartons` : null, l.cbm ? `${n2(l.cbm)} m³${l.cbm_estimated ? ' (estimated)' : ''}` : null, l.gross_kg ? `${int(l.gross_kg)} kg` : null, l.ready_date ? `ready ${longDate(l.ready_date)}` : null].filter(Boolean).join(' · ')}`);
  const total = [`${int(sum('qty'))} pcs`, has('cartons') ? `${int(sum('cartons'))} cartons` : null, `${n2(sum('cbm'))} m³`, has('gross_kg') ? `${int(sum('gross_kg'))} kg` : null].filter(Boolean).join(' · ');
  const contactBlock = Object.values(sups).map((x) => [`• ${x.name}`, x.contact_name ? `  Contact: ${x.contact_name}` : null, x.email ? `  Email: ${x.email}` : null, x.phone ? `  Phone: ${x.phone}` : null, x.address ? `  Address: ${x.address}` : null].filter(Boolean).join('\n'));
  const subject = `Request for quotation – 1 × ${box.name}, ${portName(container.port)} → ${sailing ? portName(sailing.destination) : 'Los Angeles / Long Beach'}${ready ? `, cargo ready ${PL.short(ready)}` : ''}`;
  const body = [
    'Dear {contact},', '',
    'We would like to request your best quotation for the ocean shipment described below. Kindly reply to this email, keeping the reference in the subject line, and include:', '',
    '  1. Ocean freight rate in USD, with origin and destination charges itemised',
    '  2. Carrier, vessel and voyage',
    '  3. ETD and ETA, and the CY / documentation cut-off dates',
    '  4. Free time at destination and the validity of your quotation', '',
    'SHIPMENT DETAILS',
    `Equipment:          1 × ${box.name} (planned load ${n2(sum('cbm'))} m³)`,
    `Port of loading:    ${portName(container.port)} (${container.port}), China`,
    `Port of discharge:  ${dest}, USA`,
    `Preferred sailing:  ${sailing ? [sailing.carrier, sailing.vessel ? `${sailing.vessel}${sailing.voyage ? ` ${sailing.voyage}` : ''}` : null, `ETD ${longDate(sailing.etd)}`].filter(Boolean).join(' · ') + ' — alternatives welcome' : 'first available sailing after the cargo-ready date'}`,
    `Cargo ready:        ${ready ? longDate(ready) : 'to be confirmed'}`,
    `Shippers:           ${nSup} supplier${nSup > 1 ? 's (cargo from more than one factory — please advise on CFS delivery or pick-ups)' : ''}`, '',
    'PACKING LIST', ...pl, `Total: ${total}`,
    ...(contacts ? ['', 'SUPPLIER CONTACTS', ...contactBlock] : []),
    '', `We would appreciate your reply by ${longDate(replyBy(3))}.`, '',
    'Kind regards,', '', by || 'Lulyboo Logistics', 'Lulyboo',
  ].join('\n');
  return { subject, body };
}

// ── reading a reply ─────────────────────────────────────────────────────────
const TOOL = {
  name: 'record_quote',
  description: 'Record the freight quotation a forwarder sent in reply to our request for quotation.',
  input_schema: {
    type: 'object',
    properties: {
      is_quote: { type: 'boolean', description: 'True when the email gives a price or schedule for our shipment' },
      declined: { type: 'boolean', description: 'True when the forwarder says they cannot quote / have no space' },
      currency: { type: 'string', description: 'Currency of the rates, e.g. USD' },
      ocean_usd: { type: 'number', description: 'Ocean freight for the container in USD (base rate)' },
      total_usd: { type: 'number', description: 'All-in total in USD for the container including origin and destination charges that are stated. Do not invent charges.' },
      charges: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, per: { type: 'string', description: 'per container, per BL, per shipment…' } }, required: ['name'] } },
      carrier: { type: 'string' }, vessel: { type: 'string', description: 'Vessel and voyage' },
      etd: { type: 'string', description: 'YYYY-MM-DD' }, eta: { type: 'string', description: 'YYYY-MM-DD' },
      transit_days: { type: 'integer' }, cy_cutoff: { type: 'string', description: 'YYYY-MM-DD' },
      valid_until: { type: 'string', description: 'YYYY-MM-DD' }, free_days: { type: 'integer', description: 'Free days at destination (demurrage/detention)' },
      summary: { type: 'string', description: '2–4 plain English sentences: the offer, options, conditions, anything to watch.' },
    },
    required: ['is_quote', 'summary'],
  },
};
const AI_DOC = /\.(pdf|png|jpe?g|webp)$/i;
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function readQuote({ text, files = [], sentText = '' }) {
  const content = [];
  let tables = '';
  for (const f of files.slice(0, 5)) {
    const n = String(f.name || '').toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (!f.buffer?.length || f.buffer.length > 10 * 1024 * 1024) continue;
    if (AI_DOC.test(n)) content.push(ext === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: MIME[ext], data: f.buffer.toString('base64') } });
    else if (/\.(xlsx|xlsm)$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseXlsx(f.buffer).slice(0, 80).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
    else if (/\.csv$/.test(n)) { try { tables += `\n\n${f.name}:\n${parseCsv(decodeText(f.buffer)).slice(0, 80).map((r) => r.join(' | ')).join('\n')}`; } catch { /* unreadable */ } }
  }
  const year = new Date().getFullYear();
  content.push({ type: 'text', text: `Today is ${PL.today()} (dates without a year are ${year} or ${year + 1}). A freight forwarder replied to our request for quotation. Record their offer. If several options are offered, record the cheapest that matches our request in the fields and describe the others in the summary.\n\nOUR REQUEST:\n${String(sentText).slice(0, 6000)}\n\nTHEIR REPLY:\n${String(text).slice(0, 30000)}${tables}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 3000 });
  return result || {};
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const intOrNull = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v)) : null);

/** Fields of a quote from AI output or a manual form. */
function quoteFields(r) {
  return {
    currency: r.currency ? String(r.currency).slice(0, 8).toUpperCase() : null,
    ocean_usd: num(r.ocean_usd), total_usd: num(r.total_usd ?? r.ocean_usd),
    carrier: r.carrier ? String(r.carrier).slice(0, 80) : null, vessel: r.vessel ? String(r.vessel).slice(0, 120) : null,
    etd: isoDay(r.etd), eta: isoDay(r.eta), transit_days: intOrNull(r.transit_days) ?? (isoDay(r.etd) && isoDay(r.eta) ? Math.round((Date.parse(isoDay(r.eta)) - Date.parse(isoDay(r.etd))) / 864e5) : null),
    cy_cutoff: isoDay(r.cy_cutoff), valid_until: isoDay(r.valid_until), free_days: intOrNull(r.free_days),
  };
}

/** Inbound reply → quote. Returns { matched, quote? }. */
async function handleQuoteEmail({ db, from, subject, text, files = [] }) {
  const m = String(subject || '').match(CODE_RE) || String(text || '').match(CODE_RE);
  if (!m) return { matched: false };
  const code = `LBQ-${m[1].toUpperCase()}`;
  const q = (await db.list('plan_quotes', { filters: { code }, limit: 1 }).catch(() => []))[0];
  if (!q) return { matched: false };
  const stored = Array.isArray(q.files) ? [...q.files] : [];
  for (const f of files) {
    if (!f.buffer?.length || f.buffer.length > 25 * 1024 * 1024) continue;
    const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
    const ext = (safe.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    const path = `quotes/${q.container_id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    const type = MIME[ext] || f.type || 'application/octet-stream';
    try { await db.docs.upload(path, f.buffer, type); stored.push({ name: String(f.name || safe).slice(0, 200), path, type, size: f.buffer.length }); } catch { /* keep going */ }
  }
  const patch = { reply_from: String(from).slice(0, 300), reply_text: String(text || '').slice(0, 60000), replied_at: new Date().toISOString(), files: stored, updated_at: new Date().toISOString(), status: q.status === 'chosen' ? 'chosen' : 'replied' };
  if (AI.enabled()) {
    try {
      const r = await readQuote({ text, files, sentText: q.request_text || '' });
      Object.assign(patch, Object.fromEntries(Object.entries(quoteFields(r)).filter(([, v]) => v !== null)), { summary: r.summary ? String(r.summary).slice(0, 2000) : null });
      if (r.declined && !r.is_quote) patch.status = 'declined';
    } catch (e) { patch.summary = `Could not read this reply automatically (${String(e.message).slice(0, 120)}). Open the original email below.`; }
  }
  await db.update('plan_quotes', { id: q.id }, patch);
  return { matched: true, quote: q.id, status: patch.status };
}

module.exports = { CODE_RE, newCode, quoteAddress, greetName, rfqText, replyBy, TOOL, readQuote, quoteFields, handleQuoteEmail, longDate };
