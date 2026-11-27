'use strict';
// Warehouse — inbound containers from the port to our warehouse.
//   A delivery plan per container (plan_containers.delivery): LFD (last free day), port appointment, delivery day + time,
//   trucker, warehouse, who receives it, its status and the updates it came from.
//   Updates come from the trucker / forwarder emails ("deliver plan … please confirm"): pasted or dropped on Warehouse,
//   read by AI and matched to the container (container no., MBL, NB0025). "Please confirm" → Confirm plan (email popup).
//   Telegram: 07:00 (Los Angeles) today's deliveries, 15:00 tomorrow's + LFD tomorrow without a delivery booked.
//   Documents (delivery order, POD, warehouse receipt): the day after delivery the responsible person is asked by email
//   (and you on Telegram) to upload what's missing — again every 2 days, 3 times at most.

const AI = require('./ai');
const PL = require('./planning');
const { sendEmail, layout, esc } = require('./email');

const DOCS = [['Delivery order', 'DO'], ['Proof of delivery', 'POD'], ['Warehouse receipt', 'Receipt']];
const REQUIRED = ['Proof of delivery', 'Warehouse receipt'];   // the delivery order is nice to have
const now = () => new Date().toISOString();
const day = (v) => (v ? String(v).slice(0, 10) : null);
const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const withLog = (d, text, by) => [...(d.log || []), { at: now(), text: String(text).slice(0, 300), ...(by ? { by } : {}) }].slice(-40);
const isMissing = (e) => /delivery|column|schema cache/i.test(String(e?.message || e));
/** Date and hour in Los Angeles (the warehouse). */
function laNow(t = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(t).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const kindOf = (name = '', hint = '') => {
  const s = `${name} ${hint}`.toLowerCase();
  if (/\bpod\b|proof of delivery|signed (bol|delivery)|delivery receipt/.test(s)) return 'Proof of delivery';
  if (/receipt|tally|received|receiving|wrr?\b|inbound report/.test(s)) return 'Warehouse receipt';
  if (/\bd\/?o\b|delivery order/.test(s)) return 'Delivery order';
  return 'Delivery document';
};
/** Documents on file per kind (old Mark-delivered uploads count as POD). */
function docsOf(c) {
  const fs = (c.delivery_files || []).map((f, i) => ({ ...f, i, kind: f.kind || 'Proof of delivery' }));
  return Object.fromEntries([...DOCS.map(([k]) => [k, fs.filter((f) => f.kind === k)]), ['other', fs.filter((f) => !DOCS.some(([k]) => k === f.kind))]]);
}
const missingDocs = (c) => { const d = docsOf(c); return REQUIRED.filter((k) => !d[k].length); };

// ── Reading an update ───────────────────────────────────────────────────────
const TOOL = {
  name: 'read_delivery_update',
  description: 'Read an email / document about delivering an import container from the US port to our warehouse (trucker, forwarder, customs broker).',
  input_schema: { type: 'object', properties: {
    container_no: { type: 'string', description: '4 letters + 7 digits, e.g. TCLU9707538' },
    mbl_no: { type: 'string', description: 'Master B/L / ocean B/L number, e.g. ONEYNB6BEHN79800' },
    hbl_no: { type: 'string', description: 'House B/L number' },
    booking_no: { type: 'string', description: "The forwarder's file / booking reference, e.g. NBAL2610083" },
    is_delivery: { type: 'boolean', description: 'true when the email is about delivering / picking up the container (LFD, port appointment, delivery plan, POD, empty return) — not about sailing, customs entry or invoices only' },
    our_ref: { type: 'string', description: 'Our shipment name if present, e.g. NB0025' },
    eta: { type: 'string', description: 'YYYY-MM-DD' },
    lfd: { type: 'string', description: 'Last free day at the port / terminal, YYYY-MM-DD' },
    port_appt: { type: 'string', description: 'Port / terminal pick-up appointment date, YYYY-MM-DD' },
    delivery_date: { type: 'string', description: 'Planned delivery date to our warehouse, YYYY-MM-DD' },
    delivery_time: { type: 'string', description: 'Delivery time as written, e.g. 8:30am' },
    delivered: { type: 'boolean', description: 'true when it says the container WAS delivered' },
    empty_return: { type: 'string', description: 'Last day to return the empty container, YYYY-MM-DD' },
    trucker: { type: 'string' }, warehouse: { type: 'string' },
    needs_confirmation: { type: 'boolean', description: 'they ask us to confirm the plan' },
    documents: { type: 'array', items: { type: 'object', properties: { file_name: { type: 'string' }, type: { type: 'string', enum: ['delivery_order', 'pod', 'warehouse_receipt', 'other'] } } } },
    summary: { type: 'string', description: 'One short sentence: what is planned or what happened' },
  } },
};
const AI_FILE = /\.(pdf|png|jpe?g|webp|gif)$/i;
async function read({ text, files = [] }) {
  if (!AI.enabled()) return {};
  const content = [];
  for (const f of files.slice(0, 4)) {
    if (!f.buffer?.length || f.buffer.length > 12 * 1024 * 1024 || !AI_FILE.test(f.name || '')) continue;
    const ext = (String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
    content.push(ext === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', data: f.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text: `Today is ${laNow().day} in Los Angeles (dates like 12/01 are month/day, this year or next). Attachments: ${files.map((f) => f.name).join(', ') || 'none'}.\n\nEMAIL:\n${String(text || '').slice(0, 12000)}` });
  return (await AI.callTool({ tool: TOOL, content, maxTokens: 900 })).result || {};
}
const norm = (s) => String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
/**
 * Which container, most certain first: container number (from AI or anywhere in the email) → MBL / HBL → the
 * forwarder's booking ref → our name (NB0025) → the sender: the only container still to deliver that this
 * trucker / forwarder (same email domain) wrote about before.
 */
function match(containers, r, text, from = '') {
  const SN = require('./shipname');
  const blob = norm(text);
  const cno = norm(r.container_no); const bls = [r.mbl_no, r.hbl_no].map(norm).filter((x) => x.length >= 6); const bk = norm(r.booking_no);
  const live = containers.filter((c) => !c.delivered_at || String(c.delivered_at).slice(0, 10) >= PL.addDays(laNow().day, -21));
  const pool = live.length ? live : containers;
  const dom = String(from).toLowerCase().split('@')[1] || '';
  return pool.find((c) => cno && norm(c.container_no || c.fwd?.container_no) === cno)
    || pool.find((c) => [c.fwd?.mbl_no, c.fwd?.hbl_no].some((x) => x && bls.includes(norm(x))))
    || pool.find((c) => [c.fwd?.mbl_no, c.fwd?.hbl_no].some((x) => x && norm(x).length >= 8 && blob.includes(norm(x))))
    || pool.find((c) => bk.length >= 5 && norm(c.fwd?.booking_no) && (norm(c.fwd.booking_no) === bk || bk.startsWith(norm(c.fwd.booking_no))))
    || containers.find((c) => { const k = norm(c.container_no || c.fwd?.container_no); return k.length >= 10 && blob.includes(k); })
    || containers.find((c) => { const n = norm(String(SN.shipName(c)).split('·')[0]); return n.length >= 5 && (norm(r.our_ref) === n || new RegExp(`\\b${String(SN.shipName(c)).split('·')[0].trim()}\\b`, 'i').test(text)); })
    || (() => { if (!dom || /gmail|outlook|hotmail|yahoo|qq\.com|163\.com/.test(dom)) return null;
      const xs = pool.filter((c) => !c.delivered_at && [c.delivery?.contact, ...(c.delivery?.updates || []).map((u) => u.from)].some((e) => String(e || '').toLowerCase().endsWith(`@${dom}`)));
      return xs.length === 1 ? xs[0] : null; })()
    || null;
}

/** Pasted / dropped update → the container's delivery plan. Returns { c, r } or { c: null } when no match. */
async function ingest(db, config, { text = '', files = [], by = null, containerId = null, from = '' }) {
  const containers = await db.list('plan_containers').catch(() => []);
  let r = {};
  try { r = await read({ text, files }); } catch (e) { r = { summary: `Could not read it automatically (${String(e.message).slice(0, 80)}).` }; }
  const c = containerId ? containers.find((x) => x.id === containerId) : match(containers, r, `${text} ${files.map((f) => f.name).join(' ')}`, from || (String(text).match(/^from:.*?([^\s<>"]+@[^\s<>"]+)/im) || [])[1] || '');
  if (!c) return { c: null, r };
  const d = { ...(c.delivery || {}) };
  for (const [k, v] of [['lfd', iso(r.lfd)], ['port_appt', iso(r.port_appt)], ['date', iso(r.delivery_date)], ['empty_return', iso(r.empty_return)]]) if (v) d[k] = v;
  if (r.delivery_time) d.time = String(r.delivery_time).slice(0, 20);
  if (r.trucker) d.trucker = String(r.trucker).slice(0, 80);
  if (r.warehouse) d.warehouse = String(r.warehouse).slice(0, 120);
  const fromAddr = String(from || (String(text).match(/^from:.*?([^\s<>"]+@[^\s<>"]+)/im) || [])[1] || '').toLowerCase();
  if (r.needs_confirmation && !r.delivered) d.status = 'to_confirm';
  else if (!d.status || d.status === 'none') d.status = d.date ? 'planned' : 'none';
  if (fromAddr && r.needs_confirmation) d.contact = fromAddr;
  // files: delivery order / POD / receipt, on the container
  const stored = [];
  for (const f of files.filter((x) => x.buffer?.length)) {
    const t = (r.documents || []).find((x) => x.file_name && String(f.name).toLowerCase().includes(String(x.file_name).toLowerCase().replace(/\.[a-z0-9]+$/, '')))?.type;
    const kind = { delivery_order: 'Delivery order', pod: 'Proof of delivery', warehouse_receipt: 'Warehouse receipt' }[t] || kindOf(f.name);
    const path = `delivery/${c.id}/${Date.now().toString(36)}-${String(f.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`;
    await db.docs.upload(path, f.buffer, f.type || 'application/octet-stream');
    stored.push({ name: String(f.name).slice(0, 160), path, type: f.type || '', kind, by: by || fromAddr || null, at: now() });
  }
  const subject = (String(text).match(/^subject:\s*(.+)$/im) || [])[1] || '';
  d.updates = [...(d.updates || []), { at: now(), from: fromAddr || null, by, subject: subject.slice(0, 300), text: String(text).slice(0, 5000), summary: String(r.summary || '').slice(0, 300), files: stored.map((x) => x.name), asks_confirm: !!r.needs_confirmation }].slice(-20);
  d.log = withLog(d, `Update${fromAddr ? ` from ${fromAddr}` : ''}: ${r.summary || 'added'}${stored.length ? ` · ${stored.length} file${stored.length > 1 ? 's' : ''}` : ''}`, by);
  const patch = { delivery: d, updated_at: now() };
  if (stored.length) patch.delivery_files = [...(c.delivery_files || []), ...stored];
  await db.update('plan_containers', { id: c.id }, patch);
  return { c: { ...c, ...patch }, r };
}

/** Edit the plan by hand. */
async function setPlan(db, c, f, by) {
  const d = { ...(c.delivery || {}) };
  for (const k of ['lfd', 'port_appt', 'date', 'empty_return']) if (k in f) d[k] = iso(f[k]);
  for (const [k, n] of [['time', 20], ['trucker', 80], ['warehouse', 120], ['resp_name', 60]]) if (k in f) d[k] = String(f[k] || '').trim().slice(0, n) || null;
  if ('resp_email' in f) d.resp_email = /@/.test(f.resp_email || '') ? String(f.resp_email).trim().toLowerCase() : null;
  if (!d.status || d.status === 'none') d.status = d.date ? 'planned' : 'none';
  d.log = withLog(d, `Plan updated${d.date ? ` — delivery ${PL.short(d.date)}${d.time ? ` ${d.time}` : ''}` : ''}`, by);
  await db.update('plan_containers', { id: c.id }, { delivery: d, updated_at: now() });
  return d;
}

/** Confirm the plan to whoever asked (email from the popup). */
async function confirm(db, config, c, { to = [], cc = [], subject, body, by = null }) {
  if (!to.length) throw new Error('Add who it goes to');
  const text = String(body || '').trim();
  await sendEmail(config, { to, cc, subject, text, replyTo: [inbox(), ...require('./projects').ownerEmails()], html: layout({ english: true, preheader: text.slice(0, 80), body: `<tr><td style="padding:24px 0 30px;">${esc(text).split(/\n{2,}/).map((x) => `<p style="margin:0 0 12px;font-size:15px;line-height:24px;">${x.replace(/\n/g, '<br>')}</p>`).join('')}</td></tr>` }) });
  const d = { ...(c.delivery || {}), status: 'confirmed', confirmed_at: now(), confirmed_by: by };
  d.log = withLog(d, `Plan confirmed to ${to.join(', ')}`, by);
  await db.update('plan_containers', { id: c.id }, { delivery: d, updated_at: now() });
}
function confirmDraft(c, title) {
  const d = c.delivery || {}; const last = [...(d.updates || [])].reverse().find((u) => u.asks_confirm) || {};
  const name = String(d.contact || '').split('@')[0].split(/[._-]/)[0];
  const hi = /^[a-z]{2,15}$/i.test(name) && !/^(op|ops|info|cs|import|export|dispatch|team)$/i.test(name) ? name[0].toUpperCase() + name.slice(1).toLowerCase() : 'team';
  const plan = [d.port_appt ? `Port appointment ${PL.short(d.port_appt)}` : '', d.date ? `delivery ${PL.short(d.date)}${d.time ? ` at ${d.time}` : ''}` : '', d.warehouse ? `to ${d.warehouse}` : ''].filter(Boolean).join(', ');
  return { to: d.contact ? [d.contact] : [], subject: last.subject ? `${/^re:/i.test(last.subject) ? '' : 'RE: '}${last.subject}` : `Delivery plan — ${title}`,
    body: `Hi ${hi},\n\nConfirmed — thank you. ${plan ? `${plan[0].toUpperCase()}${plan.slice(1)}.` : ''}${d.lfd ? ` LFD ${PL.short(d.lfd)} noted.` : ''}\n\nPlease send the POD once delivered.\n\nBest regards,\nMarsel` };
}

/** Ask the responsible person to upload the missing documents (email) + Telegram. */
async function requestDocs(db, config, c, title, { by = null } = {}) {
  const d = { ...(c.delivery || {}) }; const miss = missingDocs(c);
  if (!miss.length) return { skipped: true };
  const link = `${config.publicUrl || ''}/admin/warehouse#c-${c.id}`;
  const to = d.resp_email ? [d.resp_email] : String(process.env.WAREHOUSE_EMAIL || '').split(/[,;\s]+/).filter((e) => /@/.test(e));
  if (to.length) {
    const text = `Hi ${d.resp_name || 'team'},\n\n${title}${c.container_no ? ` (${c.container_no})` : ''} was delivered${c.delivered_at ? ` on ${PL.short(day(c.delivered_at))}` : d.date ? ` on ${PL.short(d.date)}` : ''}. Please upload: ${miss.join(', ')}.\n\nUpload here: ${link}\n\nThank you.`;
    await sendEmail(config, { to, cc: require('./projects').ownerEmails().filter((e) => !to.includes(e)), subject: `Please upload ${miss.join(' + ')} — ${title}`, text, html: layout({ english: true, preheader: `Please upload ${miss.join(', ')}`, body: `<tr><td style="padding:24px 0 30px;">${esc(text).split(/\n{2,}/).map((x) => `<p style="margin:0 0 12px;font-size:15px;line-height:24px;">${x.replace(/\n/g, '<br>')}</p>`).join('')}</td></tr>` }) });
  }
  await tg(db, `📄 <b>Warehouse documents missing</b>\n${title}: ${miss.join(', ')}${to.length ? ` — asked ${to.join(', ')}` : ' — no responsible person set'}\n${link}`);
  d.docs_asked = [...(d.docs_asked || []), now()].slice(-10);
  d.log = withLog(d, `Asked for ${miss.join(', ')}${to.length ? ` (${to.join(', ')})` : ''}`, by);
  await db.update('plan_containers', { id: c.id }, { delivery: d, updated_at: now() });
  return { to };
}

const inbox = () => (process.env.WAREHOUSE_INBOX || `warehouse@${(process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase()}`).toLowerCase();
const LOOKS = /\b(deliver(y|ed)?|lfd|last free day|appt|appointment|pick ?up|outgate|empty return|pod|proof of delivery|dray(age)?|trucking|warehouse receipt)\b/i;

/**
 * Email in: to warehouse@… (CC it on trucker threads) — always read; CC'd to shipments@… — read when it looks like a
 * delivery update. Matched → the container's plan + Telegram. Not matched → "To assign" on Warehouse + Telegram.
 */
async function handleEmail({ db, config, from = '', subject = '', text = '', files = [], strict = false }) {
  const body = `From: ${from}\nSubject: ${subject}\n\n${text}`;
  if (strict && !LOOKS.test(`${subject} ${text}`)) return { matched: false, skipped: true };
  const fromAddr = String(from).toLowerCase().match(/[^\s<>"]+@[^\s<>"]+/)?.[0] || '';
  const out = await ingest(db, config, { text: body, files, from: fromAddr, by: null });
  const SN = require('./shipname');
  if (out.c) {
    const d = out.c.delivery || {};
    await tg(db, `🚚 <b>Delivery update</b> · ${SN.shipName(out.c).split('·')[0].trim()}${out.c.container_no ? ` ${out.c.container_no}` : ''}\n${out.r.summary || subject}${d.status === 'to_confirm' ? '\n⚠ They ask you to confirm — Warehouse → Confirm…' : ''}\n${config.publicUrl || ''}/admin/warehouse#c-${out.c.id}`);
    return { matched: true, id: out.c.id };
  }
  if (strict && !out.r.is_delivery) return { matched: false };
  // not matched: kept for you to assign (files are stored with it)
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  const kept = [];
  for (const f of files.filter((x) => x.buffer?.length)) { const path = `delivery/inbox/${Date.now().toString(36)}-${String(f.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`; await db.docs.upload(path, f.buffer, f.type || 'application/octet-stream'); kept.push({ name: String(f.name).slice(0, 160), path, type: f.type || '' }); }
  const item = { id: Math.random().toString(36).slice(2, 10), at: now(), from: fromAddr, subject: String(subject).slice(0, 300), text: String(text).slice(0, 5000), summary: String(out.r.summary || '').slice(0, 300), container_no: out.r.container_no || null, files: kept };
  if (st) await db.update('settings', { id: st.id }, { warehouse_inbox: [...(st.warehouse_inbox || []), item].slice(-30) }).catch(() => null);
  await tg(db, `🚚 <b>Delivery update — which container?</b>\n${subject}\n${out.r.summary || ''}\nAssign it: ${config.publicUrl || ''}/admin/warehouse#inbox`);
  return { matched: false, inbox: item.id };
}
/** An unmatched email assigned by hand → read into that container. */
async function assign(db, config, itemId, containerId, by) {
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  const item = (st?.warehouse_inbox || []).find((x) => x.id === itemId); if (!item) throw new Error('Already assigned');
  const files = []; for (const f of item.files || []) { try { files.push({ ...f, buffer: await db.docs.download(f.path) }); } catch { /* gone */ } }
  const out = await ingest(db, config, { text: `From: ${item.from}\nSubject: ${item.subject}\n\n${item.text}`, files, from: item.from, by, containerId });
  await db.update('settings', { id: st.id }, { warehouse_inbox: (st.warehouse_inbox || []).filter((x) => x.id !== itemId) });
  return out;
}
async function dismiss(db, itemId) {
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  if (st) await db.update('settings', { id: st.id }, { warehouse_inbox: (st.warehouse_inbox || []).filter((x) => x.id !== itemId) });
}

async function tg(db, text) {
  try {
    const T = require('./telegram'); const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    if (T.enabled() && st?.telegram_chat_id) await T.sendMessage(st.telegram_chat_id, text);
  } catch (e) { console.error('Warehouse Telegram failed:', e.message); }
}

/** Containers still coming / just delivered, with what the page and the reminders need. */
async function board(db, today = laNow().day) {
  const SH = require('./routes/shipments');
  const rows = ((await SH.load(db).catch(() => null))?.list || []).filter((r) => r.c && ['fcl', 'lcl'].includes(r.kind) && (!r.delivered || r.delivered >= PL.addDays(today, -21)) && r.stage !== 'shipped');
  return rows.map((r) => {
    const d = r.c.delivery || {};
    const lfd = d.lfd || r.lfd || null;
    const when = r.delivered || d.date || null;
    const state = r.delivered ? (missingDocs(r.c).length ? 'docs' : 'done') : d.date ? (d.status === 'to_confirm' ? 'to_confirm' : d.status === 'confirmed' ? 'confirmed' : 'planned') : 'unplanned';
    const lfdLeft = lfd ? Math.round((Date.parse(`${lfd}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 864e5) : null;
    const risk = !r.delivered && lfd != null && lfdLeft <= 2 && (!d.date || d.date > lfd);
    return { r, d, lfd, lfdLeft, when, state, risk, docs: docsOf(r.c), missing: missingDocs(r.c) };
  });
}

// ── Hourly: Telegram at 07:00 (today) and 15:00 (tomorrow), document requests at 10:00 ──
async function runWarehouse({ db, config, at = new Date() }) {
  const la = laNow(at); const out = { today: 0, tomorrow: 0, docs: 0 };
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  const done = new Set(st?.warehouse_sent || []);   // keys of digests already sent (kept on settings)
  const mark = async (k) => { done.add(k); if (st) await db.update('settings', { id: st.id }, { warehouse_sent: [...done].slice(-60) }).catch(() => null); };
  const rows = await board(db, la.day);
  const line = (x) => `• ${x.d.time ? `${x.d.time} ` : ''}<b>${x.r.title}</b>${x.r.c.container_no ? ` ${x.r.c.container_no}` : ''} — ${x.r.suppliers.slice(0, 2).join(', ')}${x.r.cartons ? ` · ${x.r.cartons} ctns` : ''}${x.d.warehouse ? ` → ${x.d.warehouse}` : ''}${x.lfd ? ` · LFD ${PL.short(x.lfd)}` : ''}${x.state === 'to_confirm' ? ' · ⚠ plan not confirmed' : ''}`;
  if (la.hour >= 7 && !done.has(`today:${la.day}`)) {
    const xs = rows.filter((x) => !x.r.delivered && x.d.date === la.day);
    if (xs.length) { await tg(db, `🚚 <b>Deliveries today</b> (${PL.short(la.day)})\n${xs.map(line).join('\n')}`); out.today = xs.length; }
    await mark(`today:${la.day}`);
  }
  if (la.hour >= 15 && !done.has(`tomorrow:${la.day}`)) {
    const tmr = PL.addDays(la.day, 1);
    const xs = rows.filter((x) => !x.r.delivered && x.d.date === tmr);
    const lfdRisk = rows.filter((x) => !x.r.delivered && x.lfd === tmr && (!x.d.date || x.d.date > tmr));
    if (xs.length || lfdRisk.length) await tg(db, [xs.length ? `📦 <b>Deliveries tomorrow</b> (${PL.short(tmr)})\n${xs.map(line).join('\n')}` : '', lfdRisk.length ? `⚠️ <b>Last free day tomorrow — no delivery booked</b>\n${lfdRisk.map(line).join('\n')}` : ''].filter(Boolean).join('\n\n'));
    out.tomorrow = xs.length; await mark(`tomorrow:${la.day}`);
  }
  if (la.hour >= 10) {
    for (const x of rows.filter((y) => y.r.delivered && y.missing.length && y.r.delivered < la.day)) {
      const asked = x.d.docs_asked || [];
      if (asked.length >= 3 || (asked.length && PL.addDays(day(asked[asked.length - 1]), 2) > la.day)) continue;
      try { await requestDocs(db, config, x.r.c, x.r.title, { by: 'automatic' }); out.docs++; } catch (e) { console.error('Warehouse docs request:', e.message); }
    }
  }
  return out;
}

module.exports = { inbox, handleEmail, assign, dismiss, DOCS, REQUIRED, laNow, docsOf, missingDocs, kindOf, read, match, ingest, setPlan, confirm, confirmDraft, requestDocs, board, runWarehouse, isMissing };
