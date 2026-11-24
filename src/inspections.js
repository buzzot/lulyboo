'use strict';
// Quality inspections before shipping.
//
//   Every open PO needs one by default (switch off per PO or per supplier). The hourly run creates a "to request" row
//   for each new PO and tells you on Telegram: inspect around ready date − 3 days, book a month before that.
//   Request  → email (English) to the inspection company, cc the supplier, with the testing requirements file (a new
//              version each time you change it) and the order lines. Only inspection documents are attached (no PO / order files). Ref LBI-XXXX in the subject.
//   N days before the inspection day (7 by default) two confirmation emails go out: to the inspector (date, factory,
//   final qty) and to the supplier (is the date OK, goods finished and packed). Replies go to inspect@ and AI reads
//   them: confirmed, or an issue with a new date. No reply in 2 days → reminder + Telegram.
//   Report   → email to inspect@: AI finds the inspection (by ref, else by PO numbers), files the PDF on every PO it
//              covers, writes a summary with a suggested result. You decide: Pass / Fail / Pass with notes.
//   Invoice  → amount, number and due date (USD) → Accountant view → Inspection invoices; Paid closes it.

const PL = require('./planning');
const AI = require('./ai');
const { sendEmail, layout, esc } = require('./email');

const TYPES = { psi: 'Pre-shipment (PSI)', dupro: 'During production (DUPRO)', loading: 'Loading check', audit: 'Factory audit' };
const SHORT = { psi: 'PSI', dupro: 'DUPRO', loading: 'Loading check', audit: 'Factory audit' };
const AQLS = ['II · 2.5 / 4.0', 'II · 1.5 / 4.0', 'II · 1.0 / 2.5', 'I · 2.5 / 4.0', 'S-4 · 2.5 / 4.0'];
const STATUS = {
  todo: ['To request', 'warn'], requested: ['Requested', 'plan'], scheduled: ['Scheduled', 'bk'], confirmed: ['Confirmed', 'ok'],
  report: ['Report in — your decision', 'warn'], passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], skipped: ['Not needed', 'done'], cancelled: ['Cancelled', 'done'],
};
const OPEN = ['todo', 'requested', 'scheduled', 'confirmed', 'report'];
const LEAD = { before_ready: 3, book_ahead: 30, remind_after: 2 };
const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const inspectAddress = () => (process.env.INSPECT_EMAIL || `inspect@${domain()}`).toLowerCase();
const REF_RE = /\bLBI-([A-Z0-9]{4,6})\b/i;
const now = () => new Date().toISOString();
const num = (v) => { const n = Number(String(v ?? '').replace(/[,$\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const usd = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newRef = () => `LBI-${Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('')}`;
const logEntry = (text, by) => ({ at: now(), text: String(text).slice(0, 400), ...(by ? { by } : {}) });
const withLog = (i, text, by) => [...(i.log || []), logEntry(text, by)].slice(-60);
const posOf = (i) => (Array.isArray(i.pos) ? i.pos : []);
const covers = (i, sid, po) => i.supplier_id === sid && posOf(i).some((p) => PL.normPo(p) === PL.normPo(po));
const isMissing = (e) => /inspection|PGRST205|relation|schema cache|column/i.test(e?.message || '');

/** Suggested inspection day and "book by" for a ready date. */
function timing(ready) {
  if (!ready) return { target: null, bookBy: null };
  const target = PL.addDays(ready, -LEAD.before_ready);
  return { target, bookBy: PL.addDays(target, -LEAD.book_ahead) };
}

async function loadAll(db) {
  try {
    const [rows, companies] = await Promise.all([db.list('inspections', { order: 'created_at.desc' }), db.list('inspection_companies', { order: 'name.asc' })]);
    return { rows, companies, missing: false };
  } catch (e) { if (isMissing(e)) return { rows: [], companies: [], missing: true }; throw e; }
}

/** Open POs (not shipped) per supplier: ready date, qty, cartons. */
async function openPos(db) {
  const lines = (await db.list('plan_orders').catch(() => [])).filter((l) => !l.shipped && l.po);
  const m = new Map();
  for (const l of lines) {
    const k = `${l.supplier_id}|${PL.normPo(l.po)}`;
    if (!m.has(k)) m.set(k, { key: k, supplier_id: l.supplier_id, po: PL.cleanPo ? PL.cleanPo(l.po) : l.po, ready: null, qty: 0, lines: [] });
    const x = m.get(k); x.lines.push(l); x.qty += Number(l.qty) || 0;
    if (l.ready_date && (!x.ready || l.ready_date > x.ready)) x.ready = l.ready_date;
  }
  return [...m.values()];
}

/** POs that still need an inspection: no inspection row at all (any status but cancelled), supplier not switched off. */
async function needs(db, { rows = null } = {}) {
  const all = rows || (await loadAll(db)).rows;
  const sups = Object.fromEntries((await db.list('suppliers').catch(() => [])).map((s) => [s.id, s]));
  return (await openPos(db)).filter((p) => !sups[p.supplier_id]?.inspection_off && !all.some((i) => i.status !== 'cancelled' && covers(i, p.supplier_id, p.po)))
    .map((p) => ({ ...p, supplier: sups[p.supplier_id]?.name || 'Supplier', ...timing(p.ready) }));
}

/** The inspection rows for one PO (newest first). */
async function forPo(db, sid, po) {
  const { rows, missing } = await loadAll(db);
  return { list: rows.filter((i) => covers(i, sid, po)), missing };
}

/** Files linked to an inspection (requirements, report, invoice, photos). */
async function filesOf(db, i) {
  return (await db.list('plan_files', { filters: { supplier_id: i.supplier_id } }).catch(() => [])).filter((f) => f.inspection_id === i.id || f.id === i.req_file_id);
}

/** Requirement-file versions used for this supplier, newest first: [{ file, version, used: [{ref, at}] }]. */
async function reqVersions(db, sid) {
  const files = (await db.list('plan_files', { filters: { supplier_id: sid } }).catch(() => [])).filter((f) => f.kind === 'Inspection requirements');
  const rows = (await loadAll(db)).rows.filter((i) => i.supplier_id === sid);
  return files.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((f, n) => ({ file: f, version: n + 1, used: rows.filter((i) => i.req_file_id === f.id).map((i) => ({ ref: i.ref, at: i.request_sent_at || i.created_at })) })).reverse();
}

/** Store one uploaded file as a PO document linked to the inspection. */
async function storeFile(db, i, f, kind, by) {
  if (!f?.buffer?.length) return null;
  if (f.buffer.length > 25 * 1024 * 1024) throw new Error(`${f.name}: larger than 25 MB`);
  const ext = (String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
  const path = `inspections/${i.supplier_id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
  const type = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[ext] || f.type || 'application/octet-stream';
  await db.docs.upload(path, f.buffer, type);
  return db.insert('plan_files', { supplier_id: i.supplier_id, name: String(f.name).slice(0, 200), path, size: f.buffer.length, content_type: type, kind, pos: posOf(i), uploaded_by: by || null, inspection_id: i.id || null, created_at: now() });
}

// ── Emails ──────────────────────────────────────────────────────────────────
function mail({ title, name, intro, rows = [], facts = [], asks = [], closing }) {
  const td = 'padding:7px 9px;border:1px solid #ece6e4;font-size:13px;line-height:19px;';
  const table = rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:8px;"><tr>${['PO', 'Product', 'Qty', 'Cartons'].map((h, n) => `<td style="${td}background:#faf6f5;font-weight:600;${n > 1 ? 'text-align:right;' : ''}">${h}</td>`).join('')}</tr>${rows.map((r) => `<tr><td style="${td}">${esc(r.po)}</td><td style="${td}">${esc(r.product || '')}</td><td style="${td}text-align:right;">${esc(r.qty ?? '')}</td><td style="${td}text-align:right;">${esc(r.cartons ?? '')}</td></tr>`).join('')}</table>` : '';
  const dl = facts.length ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:6px;">${facts.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;font-size:14px;color:#73777d;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;font-size:14px;font-weight:600;">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>` : '';
  const paras = (t) => esc(t).split(/\n{2,}/).map((x) => `<p style="margin:0 0 12px;font-size:15px;line-height:24px;">${x.replace(/\n/g, '<br>')}</p>`).join('');
  const text = [`Dear ${name || 'Sir or Madam'},`, '', intro, '', ...facts.map(([k, v]) => `${k}: ${v}`), ...(rows.length ? ['', ...rows.map((r) => `- PO ${r.po}${r.product ? ` · ${r.product}` : ''}${r.qty ? ` · ${r.qty} pcs` : ''}${r.cartons ? ` · ${r.cartons} cartons` : ''}`)] : []), ...(asks.length ? ['', 'Please:', ...asks.map((x, n) => `  ${n + 1}. ${x}`)] : []), '', closing || '', '', 'Thank you,', 'Lulyboo Quality'].join('\n');
  return { text, html: layout({ english: true, preheader: title, body: `<tr><td style="padding:30px 0 0;"><h1 style="margin:0;font-size:24px;line-height:32px;font-weight:600;">${esc(title)}</h1></td></tr>
<tr><td style="padding:18px 0 0;"><p style="margin:0 0 12px;font-size:15px;line-height:24px;">Dear ${esc(name || 'Sir or Madam')},</p>${paras(intro)}${dl}${table}</td></tr>
${asks.length ? `<tr><td style="padding:16px 0 0;"><ol style="margin:0;padding-left:20px;font-size:15px;line-height:25px;">${asks.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></td></tr>` : ''}
<tr><td style="padding:18px 0 30px;">${closing ? `<p style="margin:0 0 14px;font-size:15px;line-height:24px;">${esc(closing)}</p>` : ''}<p style="margin:0;font-size:15px;line-height:24px;">Thank you,<br>Lulyboo Quality</p></td></tr>` }) };
}
const CLOSING = 'Please reply to this email and keep the reference in the subject.';

async function context(db, i) {
  const sup = await db.get('suppliers', i.supplier_id).catch(() => null) || {};
  const co = i.company_id ? await db.get('inspection_companies', i.company_id).catch(() => null) : null;
  const lines = (await db.list('plan_orders', { filters: { supplier_id: i.supplier_id } }).catch(() => [])).filter((l) => posOf(i).some((p) => PL.normPo(p) === PL.normPo(l.po)));
  const ctn = (l) => l.cartons || (l.units_per_carton && l.qty ? Math.ceil(l.qty / l.units_per_carton) : null);
  const rows = lines.map((l) => ({ po: l.po, product: l.product || '', qty: l.qty ? Number(l.qty).toLocaleString('en-US') : '', cartons: ctn(l) ? Number(ctn(l)).toLocaleString('en-US') : '' }));
  const totalQty = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0); const totalCtn = lines.reduce((a, l) => a + (ctn(l) || 0), 0);
  const addr = [sup.address, sup.city, sup.province, sup.country].filter(Boolean).join(', ');
  const contact = [sup.contact_name, sup.phone || sup.wechat].filter(Boolean).join(' · ');
  return { sup, co, lines, rows, totalQty, totalCtn, addr, contact };
}
const longDay = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'to be agreed');

/** The request to the inspection company (cc the supplier). `edits`: { to, cc, intro }. */
async function requestDraft(db, i, edits = {}) {
  const c = await context(db, i);
  const P = require('./projects');
  const to = edits.to?.length ? edits.to : [c.co?.email].filter(Boolean);
  const cc = edits.cc?.length ? edits.cc : [...(c.co?.cc ? String(c.co.cc).split(/[,;\s]+/) : []), ...(await P.supplierRecipients(db, c.sup).catch(() => []))].filter(Boolean);
  const intro = edits.intro || `Please arrange a ${TYPES[i.type] || 'pre-shipment inspection'} for ${c.sup.name || 'our supplier'}, PO ${posOf(i).join(', ')}${i.inspection_date ? `, on ${longDay(i.inspection_date)}` : ''}. Our testing requirements are attached — please follow them and report against them.`;
  const facts = [['Reference', i.ref], ['Inspection', TYPES[i.type] || 'Pre-shipment (PSI)'], ['Date', i.inspection_date ? longDay(i.inspection_date) : 'please propose'], ['AQL', i.aql || 'General level II · 2.5 / 4.0'], ['Factory', c.sup.name || ''], ...(c.addr ? [['Address', c.addr]] : []), ...(c.contact ? [['Contact', c.contact]] : []), ['Total', `${c.totalQty.toLocaleString('en-US')} pcs${c.totalCtn ? ` · ${c.totalCtn.toLocaleString('en-US')} cartons` : ''}`]];
  const asks = ['Confirm the inspection date and the inspector', 'Send the inspection report (PDF) and your invoice to this email when done'];
  const m = mail({ title: `Inspection request ${i.ref}`, name: c.co?.contact || c.co?.name, intro, rows: c.rows, facts, asks, closing: CLOSING });
  return { to, cc: cc.filter((e) => !to.includes(e)), subject: `Inspection request ${i.ref} — PO ${posOf(i).join(', ')}, ${c.sup.name || ''}, ${SHORT[i.type] || 'PSI'}${i.inspection_date ? ` ${PL.short(i.inspection_date)}` : ''}`, intro, ...m, ctx: c };
}

async function attachmentsFor(db, i) {
  const files = await db.list('plan_files', { filters: { supplier_id: i.supplier_id } }).catch(() => []);
  const req = files.find((f) => f.id === i.req_file_id);
  const pick = [req].filter(Boolean);   // inspection documents only — PO / order files are not sent
  const out = [];
  for (const f of pick) { try { out.push({ filename: f.name, content: await db.docs.download(f.path) }); } catch { /* skip unreadable */ } }
  return out;
}

async function sendRequest(db, config, i, { edits = {}, by = null } = {}) {
  const d = await requestDraft(db, i, edits);
  if (!d.to.length) throw new Error('The inspection company has no email — add it under Inspection companies');
  await sendEmail(config, { to: d.to, cc: d.cc, subject: d.subject, text: d.text, html: d.html, replyTo: [inspectAddress()], attachments: await attachmentsFor(db, i) });
  const patch = { status: ['todo', 'requested'].includes(i.status) ? 'requested' : i.status, request_sent_at: now(), log: withLog(i, `Request sent to ${d.to.join(', ')}${d.cc.length ? ` · cc ${d.cc.join(', ')}` : ''}`, by), updated_at: now() };
  await db.update('inspections', { id: i.id }, patch);
  return { ...i, ...patch };
}

/** The two confirmation emails N days before: inspector + supplier. `only`: 'inspector' | 'supplier' for a reminder. */
async function sendConfirmations(db, config, i, { by = null, only = null, reminder = false } = {}) {
  const c = await context(db, i);
  const P = require('./projects');
  const sent = [];
  const day = longDay(i.inspection_date);
  const pre = reminder ? 'Reminder: ' : '';
  if ((!only || only === 'inspector') && c.co?.email) {
    const m = mail({ title: `${pre}Please confirm inspection ${i.ref}`, name: c.co.contact || c.co.name, intro: `The ${TYPES[i.type] || 'inspection'} for ${c.sup.name} is on ${day}. Please confirm the date and tell us the inspector's name. Final quantities are below.`, rows: c.rows, facts: [['Reference', i.ref], ['Date', day], ['Factory', c.sup.name || ''], ...(c.addr ? [['Address', c.addr]] : []), ['Total', `${c.totalQty.toLocaleString('en-US')} pcs${c.totalCtn ? ` · ${c.totalCtn.toLocaleString('en-US')} cartons` : ''}`]], closing: CLOSING });
    await sendEmail(config, { to: [c.co.email], cc: c.co.cc ? String(c.co.cc).split(/[,;\s]+/).filter(Boolean) : undefined, subject: `${pre}Please confirm inspection ${i.ref} — ${PL.short(i.inspection_date)}, ${c.sup.name || ''}`, text: m.text, html: m.html, replyTo: [inspectAddress()] });
    sent.push('inspector');
  }
  const sto = await P.supplierRecipients(db, c.sup).catch(() => []);
  if ((!only || only === 'supplier') && sto.length) {
    const m = mail({ title: `${pre}Inspection on ${PL.short(i.inspection_date)} — is the date OK?`, name: c.sup.contact_name || c.sup.name, intro: `Our inspector will come on ${day} for PO ${posOf(i).join(', ')}. Please confirm the date is OK: all goods finished and at least 80% packed in export cartons. If not, tell us the date that works.`, rows: c.rows, facts: [['Reference', i.ref], ['Inspection', TYPES[i.type] || 'Pre-shipment (PSI)'], ['Date', day]], closing: CLOSING });
    await sendEmail(config, { to: sto, subject: `${pre}Inspection ${i.ref} on ${PL.short(i.inspection_date)} — please confirm the date`, text: m.text, html: m.html, replyTo: [inspectAddress()] });
    sent.push('supplier');
  }
  if (!sent.length) throw new Error('No email address for the inspection company or the supplier');
  const patch = { updated_at: now(), log: withLog(i, `${reminder ? 'Reminder' : 'Confirmation request'} sent to the ${sent.join(' and the ')}`, by) };
  if (!reminder) { patch.confirm_sent_at = now(); for (const s of sent) patch[`${s}_confirm`] = i[`${s}_confirm`] === 'confirmed' ? 'confirmed' : 'asked'; } else patch.reminded_at = now();
  await db.update('inspections', { id: i.id }, patch);
  return { ...i, ...patch };
}

/** Status after a confirmation answer: both confirmed → confirmed. */
function afterConfirm(i) {
  if (['scheduled', 'requested'].includes(i.status) && i.inspector_confirm === 'confirmed' && (i.supplier_confirm === 'confirmed' || !i.supplier_confirm)) return 'confirmed';
  return i.status;
}

// ── Inbound email (inspect@) ────────────────────────────────────────────────
const TOOL = {
  name: 'read_inspection_email',
  description: 'Read an email about a quality inspection (from the inspection company or the supplier) and its attachments.',
  input_schema: { type: 'object', properties: {
    sender_role: { type: 'string', enum: ['inspection_company', 'supplier', 'unknown'] },
    message_type: { type: 'string', enum: ['booking_confirmed', 'date_confirmed', 'date_issue', 'report', 'invoice', 'report_and_invoice', 'other'], description: 'booking_confirmed = the company booked the date; date_confirmed = replies "OK/confirmed" to our confirmation request; date_issue = cannot do the date / asks to move' },
    booked_date: { type: 'string', description: 'YYYY-MM-DD inspection date they confirmed or booked' },
    proposed_date: { type: 'string', description: 'YYYY-MM-DD new date they propose' },
    inspector: { type: 'string' },
    pos: { type: 'array', items: { type: 'string' }, description: 'PO numbers mentioned in the email or the report' },
    result: { type: 'string', enum: ['pass', 'fail', 'hold', 'unknown'], description: 'overall result stated in the report' },
    critical: { type: 'number' }, major: { type: 'number' }, minor: { type: 'number' },
    limit_major: { type: 'number' }, limit_minor: { type: 'number' }, sampled: { type: 'number' },
    findings: { type: 'string', description: 'the main defects / problems, one short line' },
    summary: { type: 'string', description: 'one or two plain sentences for the buyer' },
    invoice_no: { type: 'string' }, invoice_amount: { type: 'number' }, invoice_currency: { type: 'string' }, invoice_due: { type: 'string', description: 'YYYY-MM-DD' },
    documents: { type: 'array', items: { type: 'object', properties: { file_name: { type: 'string' }, type: { type: 'string', enum: ['report', 'invoice', 'photos', 'other'] } } } },
  } },
};
const AI_FILE = /\.(pdf|png|jpe?g|webp|gif)$/i;
async function readEmail({ text, files = [], hint = '' }) {
  const content = [];
  for (const f of files.slice(0, 5)) {
    if (!f.buffer?.length || f.buffer.length > 12 * 1024 * 1024 || !AI_FILE.test(f.name || '')) continue;
    const ext = (String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
    content.push(ext === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg', data: f.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text: `Today is ${PL.today()}. ${hint}\nAttachments: ${files.map((f) => f.name).join(', ') || 'none'}.\n\nEMAIL:\n${String(text || '').slice(0, 15000)}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 1500 });
  return result || {};
}
const isSig = (f) => /^image\//i.test(f.type || '') && ((f.buffer?.length || 0) < 30 * 1024 || /logo|signature|image0\d\d|outlook|icon/i.test(f.name || ''));

async function handleInspectionEmail({ db, config, from = '', subject = '', text = '', files = [] }) {
  const { rows, companies, missing } = await loadAll(db);
  if (missing) return { matched: false, missing: true };
  const kept = files.filter((f) => f.buffer?.length && !isSig(f));
  const m = String(subject).match(REF_RE) || String(text).match(REF_RE);
  let i = m ? rows.find((x) => x.ref.toUpperCase() === `LBI-${m[1].toUpperCase()}`) : null;
  let r = {};
  if (AI.enabled()) { try { r = await readEmail({ text: `Subject: ${subject}\nFrom: ${from}\n\n${text}`, files: kept, hint: i ? `This is about inspection ${i.ref} for PO ${posOf(i).join(', ')} on ${i.inspection_date || 'date tbc'}.` : '' }); } catch (e) { r = { summary: `Could not read it automatically (${String(e.message).slice(0, 80)}).` }; } }
  // no reference: find the inspection by the PO numbers in the report
  if (!i) {
    const pos = (r.pos || []).map((p) => PL.normPo(p)).filter(Boolean);
    const rank = (x) => (['requested', 'scheduled', 'confirmed', 'report'].includes(x.status) ? 0 : x.status === 'todo' ? 1 : 2);
    const hits = rows.filter((x) => !['cancelled', 'skipped'].includes(x.status) && posOf(x).some((p) => pos.includes(PL.normPo(p)))).sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)));
    i = hits[0] || null;
  }
  if (!i) return { matched: false };
  const fromAddr = String(from).toLowerCase().match(/[^\s<>"]+@[^\s<>"]+/)?.[0] || '';
  const co = companies.find((c) => c.id === i.company_id);
  const sameDomain = (a, b) => a && b && a.split('@')[1] === String(b).toLowerCase().split('@')[1];
  const role = co && (sameDomain(fromAddr, co.email) || String(co.cc || '').toLowerCase().includes(fromAddr)) ? 'inspector' : r.sender_role === 'supplier' ? 'supplier' : r.sender_role === 'inspection_company' ? 'inspector' : 'supplier';
  const by = `Email from ${fromAddr || 'unknown'}`;
  const patch = { updated_at: now() }; const notes = [];
  // files: report / invoice / photos — as PO documents on every PO of the inspection
  const docType = (f) => (r.documents || []).find((d) => d.file_name && String(f.name).toLowerCase().includes(String(d.file_name).toLowerCase().replace(/\.[a-z0-9]+$/, '')))?.type
    || (/invoice|inv[-_ ]?\d|debit/i.test(f.name) ? 'invoice' : /report|rpt|inspection|psi|dupro/i.test(f.name) ? 'report' : /^image\//.test(f.type || '') ? 'photos' : ['report', 'report_and_invoice'].includes(r.message_type) ? 'report' : r.message_type === 'invoice' ? 'invoice' : 'other');
  const KIND = { report: 'Inspection report', invoice: 'Inspection invoice', photos: 'Inspection photos', other: 'Inspection document' };
  const stored = [];
  for (const f of kept) { const t = docType(f); const rec = await storeFile(db, i, f, KIND[t], by); if (rec) { stored.push({ t, rec }); if (t === 'invoice' && !i.invoice_file_id) patch.invoice_file_id = rec.id; } }
  const hasReport = stored.some((s) => s.t === 'report') || ['report', 'report_and_invoice'].includes(r.message_type) && stored.length;
  if (hasReport) {
    patch.ai = { result: r.result || 'unknown', critical: num(r.critical), major: num(r.major), minor: num(r.minor), limit_major: num(r.limit_major), limit_minor: num(r.limit_minor), sampled: num(r.sampled), findings: r.findings || '', summary: r.summary || '', pos: r.pos || [], at: now() };
    if (!['passed', 'failed'].includes(i.status)) patch.status = 'report';
    notes.push(`Report received — AI suggests ${String(r.result || 'unknown').toUpperCase()}`);
  }
  if (r.invoice_amount != null || r.invoice_no || stored.some((s) => s.t === 'invoice')) {
    if (r.invoice_no) patch.invoice_no = String(r.invoice_no).slice(0, 60);
    if (r.invoice_amount != null) patch.invoice_amount = num(r.invoice_amount);
    if (PL.isoDay(r.invoice_due)) patch.invoice_due = PL.isoDay(r.invoice_due);
    notes.push(`Invoice${r.invoice_no ? ` ${r.invoice_no}` : ''}${r.invoice_amount != null ? ` · ${usd(r.invoice_amount)}${r.invoice_currency && !/usd/i.test(r.invoice_currency) ? ` (${r.invoice_currency} — check)` : ''}` : ''}`);
  }
  if (!hasReport && ['booking_confirmed', 'date_confirmed'].includes(r.message_type)) {
    const d = PL.isoDay(r.booked_date);
    if (role === 'inspector') {
      if (d && d !== i.inspection_date) patch.inspection_date = d;
      if (i.confirm_sent_at) { patch.inspector_confirm = 'confirmed'; patch.inspector_note = (r.summary || '').slice(0, 300); }
      if (['todo', 'requested'].includes(i.status)) patch.status = 'scheduled';
      notes.push(i.confirm_sent_at ? 'Inspector confirmed the date' : `Inspection company booked ${PL.short(d || i.inspection_date)}${r.inspector ? ` · ${r.inspector}` : ''}`);
    } else { patch.supplier_confirm = 'confirmed'; patch.supplier_note = (r.summary || '').slice(0, 300); notes.push('Supplier confirmed the date'); }
  }
  if (!hasReport && r.message_type === 'date_issue') {
    patch[`${role}_confirm`] = 'issue'; patch[`${role}_note`] = (r.summary || text).slice(0, 300);
    if (PL.isoDay(r.proposed_date)) patch.proposed_date = PL.isoDay(r.proposed_date);
    notes.push(`${role === 'inspector' ? 'Inspector' : 'Supplier'} has an issue with the date${patch.proposed_date ? ` — proposes ${PL.short(patch.proposed_date)}` : ''}`);
  }
  const next = { ...i, ...patch };
  if (!patch.status) { const s = afterConfirm(next); if (s !== i.status) patch.status = s; }
  if (!notes.length) notes.push(`Email from ${role === 'inspector' ? 'the inspection company' : 'the supplier'}${stored.length ? ` with ${stored.length} file${stored.length > 1 ? 's' : ''}` : ''}${r.summary ? `: ${r.summary}` : ''}`);
  patch.log = withLog(i, notes.join(' · '), by);
  await db.update('inspections', { id: i.id }, patch);
  await tell(db, config, { ...i, ...patch }, notes.join(' · '));
  return { matched: true, id: i.id, files: stored.length, type: r.message_type || 'other' };
}

async function tell(db, config, i, note, { email = true } = {}) {
  const sup = await db.get('suppliers', i.supplier_id).catch(() => null);
  const link = `${config.publicUrl}/admin/orders/inspections/${i.id}`;
  const title = `${i.ref} · ${sup?.name || 'Supplier'} · PO ${posOf(i).join(', ')}`;
  try {
    const tg = require('./telegram');
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, `🔍 <b>Inspection</b> ${tg.escapeHtml(title)}\n${tg.escapeHtml(note)}\n${link}`);
  } catch (e) { console.error('Inspection Telegram failed:', e.message); }
  if (email) { try { await require('./projects').notifyOwner(config, `[Inspection] ${title}`, `${note}\n\n${link}`, { title: 'Inspection', intro: note, project: title, button: 'Open', link }); } catch { /* best effort */ } }
}

// ── Decisions / invoice ─────────────────────────────────────────────────────
async function decide(db, i, decision, { note = '', by = null } = {}) {
  if (!['pass', 'fail', 'pass_notes'].includes(decision)) throw new Error('Choose Pass, Fail or Pass with notes');
  const patch = { decision, decision_note: String(note || '').slice(0, 1000) || null, decided_at: now(), decided_by: by, status: decision === 'fail' ? 'failed' : 'passed', updated_at: now() };
  patch.log = withLog(i, `${decision === 'fail' ? 'Failed' : decision === 'pass_notes' ? 'Passed with notes' : 'Passed'}${note ? ` — ${note}` : ''}`, by);
  await db.update('inspections', { id: i.id }, patch);
  return { ...i, ...patch };
}

/** Per PO: the latest inspection's state for the booking check. ok = passed. */
function poGate(rows, sid, po) {
  const list = rows.filter((i) => i.status !== 'cancelled' && covers(i, sid, po)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!list.length) return { need: true, ok: false, text: 'no inspection yet' };
  if (list.some((i) => i.status === 'passed')) return { need: true, ok: true, text: 'passed' };
  if (list.every((i) => i.status === 'skipped')) return { need: false, ok: true, text: 'not needed' };
  const i = list.find((x) => x.status !== 'skipped');
  return { need: true, ok: false, text: STATUS[i.status]?.[0].toLowerCase() || i.status, ref: i.ref, id: i.id };
}

// ── Hourly run ──────────────────────────────────────────────────────────────
async function runInspections({ db, config }) {
  const { rows, missing } = await loadAll(db);
  if (missing) return { missing: true };
  const today = PL.today();
  let created = 0, confirms = 0, reminders = 0;
  // 1. new POs → a "to request" row + Telegram, once
  for (const p of await needs(db, { rows })) {
    const i = await db.insert('inspections', { ref: newRef(), supplier_id: p.supplier_id, pos: [p.po], type: 'psi', status: 'todo', target_date: p.target, log: [logEntry(`New PO — inspection needed${p.target ? ` around ${PL.short(p.target)}, book by ${PL.short(p.bookBy)}` : ''}`)], created_at: now() });
    rows.push(i); created++;
    await tell(db, config, i, `New PO ${p.po} (${p.supplier}) — schedule the inspection${p.target ? `: inspect around ${PL.short(p.target)}, book by ${PL.short(p.bookBy)}` : ''}.`, { email: false });
  }
  // 2. confirmations N days before the inspection day
  for (const i of rows.filter((x) => ['requested', 'scheduled'].includes(x.status) && x.inspection_date && !x.confirm_sent_at)) {
    if (today < PL.addDays(i.inspection_date, -(i.confirm_days ?? 7)) || today > i.inspection_date) continue;
    try { await sendConfirmations(db, config, i); confirms++; } catch (e) { await db.update('inspections', { id: i.id }, { log: withLog(i, `Confirmation emails failed: ${e.message}`), updated_at: now() }).catch(() => null); }
  }
  // 3. no answer in 2 days → reminder to whoever hasn't answered + Telegram
  for (const i of rows.filter((x) => x.confirm_sent_at && !x.reminded_at && ['requested', 'scheduled'].includes(x.status) && x.inspection_date >= today)) {
    if (PL.addDays(String(i.confirm_sent_at).slice(0, 10), LEAD.remind_after) > today) continue;
    const waiting = ['inspector', 'supplier'].filter((s) => i[`${s}_confirm`] === 'asked');
    if (!waiting.length) continue;
    for (const s of waiting) { try { await sendConfirmations(db, config, i, { only: s, reminder: true }); } catch { /* logged in the row */ } }
    await db.update('inspections', { id: i.id }, { reminded_at: now(), updated_at: now() }).catch(() => null);
    await tell(db, config, i, `No answer from the ${waiting.join(' and the ')} about ${PL.short(i.inspection_date)} — reminder sent.`, { email: false });
    reminders++;
  }
  // 4. Monday: what's open (to request, decisions, invoices due this week)
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  if (dow === 1 && st && st.inspections_digest_on !== today && new Date().getUTCHours() >= 16) {
    const todo = rows.filter((x) => x.status === 'todo'); const dec = rows.filter((x) => x.status === 'report');
    const due = rows.filter((x) => x.invoice_amount && !x.paid_at && x.invoice_due && x.invoice_due <= PL.addDays(today, 6));
    if (todo.length || dec.length || due.length) {
      try {
        const tg = require('./telegram');
        if (tg.enabled() && st.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, [`🔍 <b>Inspections this week</b>`, todo.length ? `To request: ${todo.length} (${todo.slice(0, 6).map((x) => posOf(x).join('+')).join(', ')})` : '', dec.length ? `Reports waiting for your decision: ${dec.length}` : '', due.length ? `Invoices due: ${due.length} · ${usd(due.reduce((a, x) => a + Number(x.invoice_amount), 0))}` : '', `${config.publicUrl}/admin/orders/inspections`].filter(Boolean).join('\n'));
      } catch (e) { console.error('Inspection digest failed:', e.message); }
    }
    await db.update('settings', { id: st.id }, { inspections_digest_on: today }).catch(() => null);
  }
  return { created, confirms, reminders };
}

module.exports = { TYPES, SHORT, AQLS, STATUS, OPEN, LEAD, REF_RE, inspectAddress, newRef, timing, loadAll, openPos, needs, forPo, filesOf, reqVersions, storeFile, requestDraft, sendRequest, sendConfirmations, afterConfirm, readEmail, handleInspectionEmail, decide, poGate, runInspections, withLog, posOf, covers, usd, num, isMissing, longDay, attachmentsFor };
