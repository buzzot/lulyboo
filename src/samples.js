'use strict';
// Samples: shared logic (refs, files, tracking poller, notifications, reminders, AI waybill reading).
// Routes live in src/routes/samples.js. Carrier APIs live in src/carriers.js.

const crypto = require('node:crypto');
const CR = require('./carriers');
const P = require('./projects');
const AI = require('./ai');
const tg = require('./telegram');

// Workflow status shown everywhere. Tracking statuses (carriers.js) move it forward automatically.
const STATUSES = ['Requested', 'Confirmed', 'Shipped', 'In transit', 'Customs', 'Out for delivery', 'Delivered', 'Exception', 'Approved', 'Revise', 'Rejected', 'Cancelled'];
const STATUS_ZH = { Requested: '待确认', Confirmed: '已确认', Shipped: '已寄出', 'In transit': '运输中', Customs: '清关中', 'Out for delivery': '派送中', Delivered: '已签收', Exception: '异常', Approved: '已通过', Revise: '需修改', Rejected: '未通过', Cancelled: '已取消' };
const CLOSED = ['Approved', 'Rejected', 'Cancelled'];
const EVALUATED = ['Approved', 'Revise', 'Rejected'];
const FROM_TRACKING = { pre_transit: 'Shipped', in_transit: 'In transit', customs: 'Customs', out_for_delivery: 'Out for delivery', delivered: 'Delivered', exception: 'Exception' };
const STAGES = ['Prototype', 'EVT', 'DVT', 'PVT', 'Pre-production', 'Golden sample', 'Catalog sample', 'Other'];
const FILE_KINDS = { proforma: ['Proforma invoice', '形式发票'], waybill: ['Waybill', '运单'], invoice: ['Commercial invoice', '商业发票'], photo: ['Packing photo', '包装照片'], payment: ['Payment proof', '付款凭证'], other: ['Other', '其他'] };
const FREIGHT_BY = { supplier: ['Supplier (prepaid)', '供应商预付'], lulyboo: ['Lulyboo account (collect)', 'Lulyboo 账号到付'], included: ['Included in sample fee', '含在样品费中'] };
const DEFAULT_CHECKS = ['Dimensions vs drawing', 'Colour vs reference', 'Material, finish and smell', 'Function / performance', 'Packaging and labels', 'Safety: small parts, sharp edges'];
const pillCls = (s) => ({ Requested: 'st-req', Confirmed: 'st-req', Shipped: 'st-transit', 'In transit': 'st-transit', Customs: 'st-customs', 'Out for delivery': 'st-transit', Delivered: 'st-deliv', Exception: 'st-late', Approved: 'st-ok', Revise: 'st-customs', Rejected: 'st-late', Cancelled: 'st-req' }[s] || 'st-req');

const now = () => new Date().toISOString();
const addMin = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();

async function nextRef(db) {
  const rows = await db.list('samples', { select: 'ref' });
  return `SMP-${rows.reduce((mx, r) => Math.max(mx, Number(String(r.ref).replace(/\D/g, '')) || 1000), 1000) + 1}`;
}

async function storeFiles(db, sampleId, files, maxBytes = 20 * 1024 * 1024) {
  const saved = []; const errors = [];
  for (const f of files || []) {
    if (!f?.buffer?.length) continue;
    const name = P.safeName(f.name); const ext = P.extOf(name);
    if (!P.ALLOWED_EXT.test(ext)) { errors.push(`${name}: file type not allowed`); continue; }
    if (f.buffer.length > maxBytes) { errors.push(`${name}: larger than 20 MB`); continue; }
    const path = `samples/${sampleId}/${crypto.randomUUID()}${ext}`;
    try { await db.docs.upload(path, f.buffer, P.MIME[ext] || 'application/octet-stream'); saved.push({ name, path, bytes: f.buffer.length, mime: P.MIME[ext] || null, buffer: f.buffer }); } catch { errors.push(`${name}: could not be stored`); }
  }
  return { saved, errors };
}

const total = (s) => ['sample_fee', 'freight_cost', 'duties'].reduce((a, k) => a + (Number(s[k]) || 0), 0);

// ── Notifications
async function telegram(db, text) {
  try { const st = (await db.list('settings', { limit: 1 }))[0]; if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, text); } catch (e) { console.error('Sample Telegram failed:', e.message); }
}
const ICON = { 'In transit': '✈️', Customs: '🛃', 'Out for delivery': '🚚', Delivered: '✅', Exception: '⚠️', Shipped: '📦' };
const TONE = { Exception: 'red', Customs: 'amber', Delivered: 'green', 'Out for delivery': 'green' };

/** Tell the owner (email + Telegram) that a sample changed status. */
async function notifyStatus({ db, config, sample: s, supplier, status, detail }) {
  const url = `${config.publicUrl}/admin/samples/${s.id}`;
  const carrier = CR.CARRIERS[s.carrier]?.short || '';
  const line = `${ICON[status] || '📦'} ${s.ref} ${s.title} — ${status}${detail ? `: ${detail}` : ''}`;
  await P.notifyOwner(config, `[Sample ${s.ref}] ${status}${supplier ? ` · ${supplier.name}` : ''}`, `${line}\n\n${url}`, {
    title: `${s.title}: ${status.toLowerCase()}`, project: `${s.ref} · ${supplier?.name || ''}`,
    items: [{ tag: status, tone: TONE[status] || 'grey', title: detail || status, sub: [carrier, s.tracking_no].filter(Boolean).join(' · '), href: url }],
    button: status === 'Delivered' ? 'Evaluate the sample' : 'Open sample', link: url,
  });
  await telegram(db, `${ICON[status] || '📦'} <b>${tg.escapeHtml(s.ref)} ${tg.escapeHtml(s.title)}</b>\n${tg.escapeHtml(status)}${detail ? ` · ${tg.escapeHtml(detail)}` : ''}${supplier ? `\n${tg.escapeHtml(supplier.name)}` : ''}\n${url}`);
}

async function notifySupplierSample(db, config, supplier, s, { subject, title, lead, note, noteLabel, points = [], button }) {
  if (!supplier) return false;
  return P.notifySupplier(config, db, supplier, { subject, en: lead[0], zh: lead[1], link: `${config.publicUrl}/portal/samples/${s.id}`,
    email: { ref: s.ref, project: s.title, title, lead, note, noteLabel, points, button } });
}

// ── Tracking poller
// How often to ask the carrier again, by tracking status (minutes).
const CHECK_EVERY = { out_for_delivery: 30, exception: 60, customs: 90, in_transit: 120, pre_transit: 180, unknown: 240 };

/** Fetch tracking for one sample, store new events, move the status forward, notify. Returns the patch applied. */
async function refreshSample({ db, config, sample: s, at = now(), notify = true }) {
  if (!s.tracking_no || !['dhl', 'fedex', 'ups'].includes(s.carrier)) return null;
  let r;
  try { r = await CR.track(s.carrier, s.tracking_no); } catch (e) {
    const patch = { tracking_error: String(e.message).slice(0, 300), last_checked_at: at, next_check_at: addMin(at, 240) };
    await db.update('samples', { id: s.id }, patch); return patch;
  }
  if (!r.found) {
    const giveUp = s.shipped_at && Date.parse(at) - Date.parse(s.shipped_at) > 14 * 864e5;
    const patch = { tracking_error: giveUp ? 'Carrier has no record of this number after 14 days. Check the number.' : 'Not found yet at the carrier (new labels can take a few hours).', last_checked_at: at, next_check_at: giveUp ? null : addMin(at, 240) };
    await db.update('samples', { id: s.id }, patch); return patch;
  }
  // New events only
  const known = new Set((await db.list('sample_events', { filters: { sample_id: s.id }, select: 'key' })).map((e) => e.key));
  const fresh = r.events.filter((e) => e.key && !known.has(e.key));
  for (const e of fresh.slice(0, 80)) await db.insert('sample_events', { sample_id: s.id, at: e.at || at, code: e.code, description: String(e.description || '').slice(0, 300), location: String(e.location || '').slice(0, 120) || null, source: s.carrier, key: e.key, created_at: at });

  const patch = {
    tracking_status: r.status, tracking_summary: String(r.summary || '').slice(0, 300) || null, tracking_location: String(r.location || '').slice(0, 120) || null,
    eta: r.eta || s.eta || null, last_event_at: r.events[0]?.at || s.last_event_at || null, last_checked_at: at, tracking_error: null,
    next_check_at: r.status === 'delivered' ? null : addMin(at, CHECK_EVERY[r.status] || 180),
  };
  if (fresh.length) patch.stall_alerted_at = null;
  if (r.status === 'delivered') { patch.delivered_at = r.deliveredAt || r.events[0]?.at || at; if (r.signedBy) patch.signed_by = String(r.signedBy).slice(0, 80); }
  if (!s.shipped_at && r.status !== 'pre_transit') patch.shipped_at = r.events[r.events.length - 1]?.at || at;
  const next = FROM_TRACKING[r.status];
  const canMove = next && !CLOSED.includes(s.status) && !EVALUATED.includes(s.status) && next !== s.status;
  if (canMove) patch.status = next;
  await db.update('samples', { id: s.id }, patch);

  if (canMove && notify && ['In transit', 'Customs', 'Out for delivery', 'Delivered', 'Exception'].includes(next)) {
    // "In transit" is announced once (first movement), not on every hub.
    if (!(next === 'In transit' && s.status === 'In transit')) {
      const supplier = await db.get('suppliers', s.supplier_id);
      await notifyStatus({ db, config, sample: { ...s, ...patch }, supplier, status: next, detail: [patch.tracking_summary, patch.tracking_location].filter(Boolean).join(' · ') });
      if (next === 'Delivered') await notifySupplierSample(db, config, supplier, s, { subject: `[Lulyboo ${s.ref}] Sample delivered · 样品已签收`, title: ['Sample delivered', '样品已签收'], lead: ['Your sample has been delivered to Lulyboo:', '您的样品已送达 Lulyboo：'], points: [['We will evaluate it and send you the result in the portal.', '我们将进行评估，并在平台中告知结果。']], button: ['Open sample', '查看样品'] });
    }
  }
  return patch;
}

/** Called every few minutes: refresh due samples, then reminders. */
async function runTracking({ db, config, now: at = now(), limit = 25 }) {
  let rows;
  try { rows = (await db.list('samples')).filter((s) => s.tracking_no); } catch { return { checked: 0 }; }
  const due = rows.filter((s) => s.carrier && CR.configured(s.carrier) && !CLOSED.includes(s.status) && s.status !== 'Delivered' && !EVALUATED.includes(s.status) && (!s.next_check_at || s.next_check_at <= at)).slice(0, limit);
  for (const s of due) { try { await refreshSample({ db, config, sample: s, at }); } catch (e) { console.error('Sample tracking failed:', s.ref, e.message); } }
  return { checked: due.length };
}

/** Reminders (safe to run often; each fires at most once a day per sample). */
async function runReminders({ db, config, now: at = now() }) {
  let rows; try { rows = await db.list('samples'); } catch { return { sent: 0 }; }
  const day = P.dayIn(new Date(at)); let sent = 0;
  const sup = {}; const supplierOf = async (id) => (sup[id] ||= await db.get('suppliers', id));
  for (const s of rows) {
    if (CLOSED.includes(s.status)) continue;
    // 1. Supplier is late to ship
    if (['Requested', 'Confirmed'].includes(s.status) && s.due_ship_date && s.due_ship_date < day && s.late_reminded_on !== day && (s.late_reminders || 0) < 5) {
      const late = Math.round((Date.parse(day) - Date.parse(s.due_ship_date)) / 864e5);
      const supplier = await supplierOf(s.supplier_id);
      await notifySupplierSample(db, config, supplier, s, { subject: `[Lulyboo ${s.ref}] Sample is late · 样品逾期未寄出`, title: ['Reminder: please ship the sample', '提醒：请寄出样品'], lead: [`This sample was due to ship on ${s.due_ship_date}:`, `此样品应于 ${s.due_ship_date} 寄出：`], points: [['Ship it and add the tracking number in the portal, or tell us the new date.', '请寄出并在平台中填写运单号，或告知新的寄出日期。']], button: ['Add tracking', '填写运单号'] });
      if (late >= 3) await telegram(db, `⏰ <b>${tg.escapeHtml(s.ref)} ${tg.escapeHtml(s.title)}</b>\nNot shipped, ${late} days late · ${tg.escapeHtml(supplier?.name || '')}\n${config.publicUrl}/admin/samples/${s.id}`);
      await db.update('samples', { id: s.id }, { late_reminded_on: day, late_reminders: (s.late_reminders || 0) + 1 }); sent++;
    }
    // 2. No tracking movement for 4 days
    if (['Shipped', 'In transit', 'Customs', 'Exception'].includes(s.status) && s.last_event_at && !s.stall_alerted_at && Date.parse(at) - Date.parse(s.last_event_at) > 4 * 864e5) {
      const supplier = await supplierOf(s.supplier_id);
      await notifyStatus({ db, config, sample: s, supplier, status: s.status, detail: 'No tracking update for 4 days. Check with the carrier.' });
      await db.update('samples', { id: s.id }, { stall_alerted_at: at }); sent++;
    }
    // 3. Delivered but not evaluated after 5 days
    if (s.status === 'Delivered' && s.delivered_at && !s.eval_reminded_at && Date.parse(at) - Date.parse(s.delivered_at) > 5 * 864e5) {
      const supplier = await supplierOf(s.supplier_id);
      await notifyStatus({ db, config, sample: s, supplier, status: 'Delivered', detail: 'Delivered 5 days ago and not evaluated yet' });
      await db.update('samples', { id: s.id }, { eval_reminded_at: at }); sent++;
    }
  }
  return { sent };
}

async function newSampleCount(db, supplierId) {
  try { return (await db.list('samples', { filters: { supplier_id: supplierId } })).filter((s) => s.status === 'Requested' && !s.supplier_seen_at).length; } catch { return 0; }
}

// ── AI: read a waybill photo/PDF
const WAYBILL_TOOL = {
  name: 'record_waybill', description: 'Record what is printed on the courier waybill / shipping label.',
  input_schema: { type: 'object', properties: {
    carrier: { type: 'string', enum: ['dhl', 'fedex', 'ups', 'other', 'unknown'] },
    tracking_number: { type: 'string', description: 'Waybill / tracking number exactly as printed, digits and letters only.' },
    weight_kg: { type: 'number' }, pieces: { type: 'integer' }, ship_date: { type: 'string', description: 'YYYY-MM-DD if printed' },
    declared_value: { type: 'number' }, currency: { type: 'string' },
  }, required: ['carrier'] },
};
async function readWaybill(buffer, mime) {
  const data = buffer.toString('base64');
  const block = mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mime, data } } : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data } };
  const { result } = await AI.callTool({ tool: WAYBILL_TOOL, maxTokens: 800, system: 'You read courier waybills (DHL, FedEx, UPS). Copy the tracking number exactly. Leave fields empty if not printed.', content: [block, { type: 'text', text: 'Read this waybill.' }] });
  const no = CR.clean(result.tracking_number);
  const carrier = ['dhl', 'fedex', 'ups'].includes(result.carrier) ? result.carrier : CR.detect(no) || 'other';
  return { ...result, tracking_number: no || null, carrier };
}

async function supplierBadges(db, supplierId) {
  const [projects, samples] = await Promise.all([P.newProjectCount(db, supplierId), newSampleCount(db, supplierId)]);
  let hol = 0;
  try { const s = await db.get('suppliers', supplierId); hol = Number(s?.holidays_confirmed_year) === require('./holidays').targetYear() ? 0 : 1; } catch { hol = 0; }
  return { '/portal/projects': projects, '/portal/samples': samples, '/portal/holidays': hol };
}

// ── Carrier notification emails (UPS / FedEx / DHL alerts forwarded to samples@<inbound domain>)
// Used when a carrier API is not connected. Finds tracking numbers in the email, matches them to samples,
// reads the status from the wording and moves the sample forward like the API poller does.
const NUM_RE = /\b(1Z[0-9A-Z]{16}|\d{22}|\d{20}|\d{15}|\d{12}|\d{10})\b/g;
function emailStatus(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(was |has been |package |shipment )?delivered\b/.test(t) && !/(not|attempt(ed)?|unable to be|could not be) (be )?delivered|delivery attempt|scheduled delivery/.test(t)) return 'delivered';
  if (/out for delivery|with delivery courier|on (its|the) way to you today/.test(t)) return 'out_for_delivery';
  if (/customs|clearance|import (duty|charges|tax)|duties|brokerage/.test(t)) return /held|delay|action required|pay|payment|documents? (needed|required)/.test(t) ? 'exception' : 'customs';
  if (/exception|delay(ed)?|unable to deliver|delivery attempt|returned to sender|address (issue|problem)|action required/.test(t)) return 'exception';
  if (/label (has been )?created|shipment (details|information) (received|sent)|ready for ups|order processed/.test(t)) return 'pre_transit';
  if (/on the way|in transit|shipped|departed|arrived|picked up|scheduled delivery|estimated delivery|update/.test(t)) return 'in_transit';
  return null;
}
async function handleTrackingEmail({ db, config, from = '', subject = '', text = '', messageId = '', date = null }) {
  const body = `${subject}\n${text}`;
  const up = body.toUpperCase().replace(/1Z(?:[ -]?[0-9A-Z]){16}/g, (m) => m.replace(/[ -]/g, '')).replace(/(\d)[ -](?=\d)/g, '$1');
  const nums = [...new Set((up.match(NUM_RE) || []).map(CR.clean))];
  const refs = [...new Set(body.match(/SMP-\d{4,}/gi) || [])].map((x) => x.toUpperCase());
  const all = await db.list('samples');
  const matches = all.filter((s) => (s.tracking_no && nums.includes(CR.clean(s.tracking_no))) || refs.includes(s.ref));
  if (!matches.length) return { matched: false, numbers: nums };
  const code = emailStatus(body);
  const at = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : now();
  const sender = (String(from).match(/@([\w.-]+)/) || [])[1] || 'email';
  const updated = [];
  for (const s of matches) {
    const key = `email|${messageId || subject}`.slice(0, 200);
    const seen = await db.list('sample_events', { filters: { sample_id: s.id, key } });
    if (seen.length) continue;
    await db.insert('sample_events', { sample_id: s.id, at, code: code || 'note', description: `${String(subject).slice(0, 240)}`, location: `Email from ${sender}`.slice(0, 120), source: 'email', key, created_at: now() });
    const patch = { last_event_at: at, stall_alerted_at: null, updated_at: now() };
    if (code) { patch.tracking_status = code; patch.tracking_summary = String(subject).slice(0, 300); }
    if (code === 'delivered') { patch.delivered_at = at; patch.next_check_at = null; }
    if (!s.shipped_at && code && code !== 'pre_transit') patch.shipped_at = at;
    const next = code ? FROM_TRACKING[code] : null;
    const canMove = next && !CLOSED.includes(s.status) && !EVALUATED.includes(s.status) && next !== s.status && !(s.status === 'Delivered' && next !== 'Delivered');
    if (canMove) patch.status = next;
    await db.update('samples', { id: s.id }, patch);
    if (canMove && ['In transit', 'Customs', 'Out for delivery', 'Delivered', 'Exception'].includes(next)) {
      const supplier = await db.get('suppliers', s.supplier_id);
      await notifyStatus({ db, config, sample: { ...s, ...patch }, supplier, status: next, detail: `${String(subject).slice(0, 160)} (carrier email)` });
    }
    updated.push({ ref: s.ref, status: canMove ? next : s.status });
  }
  return { matched: true, updated };
}

module.exports = { handleTrackingEmail, emailStatus, supplierBadges, STATUSES, STATUS_ZH, CLOSED, EVALUATED, STAGES, FILE_KINDS, FREIGHT_BY, DEFAULT_CHECKS, pillCls, nextRef, storeFiles, total, notifyStatus, notifySupplierSample, refreshSample, runTracking, runReminders, newSampleCount, readWaybill, CHECK_EVERY };
