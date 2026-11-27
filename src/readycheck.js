'use strict';
// Ready-to-ship check — one email per supplier, 5 days before the shipping date of their open PO lines:
//   1. "Please confirm the goods are ready on <date> (or give the new date)" + the inspection date for POs without one.
//   2. The reply (subject carries LBR-XXXXX, comes back to docs@…) is read by AI: confirmed / new date / inspection date.
//      A new date is shown on the PO and applied by you (one click) — never changed silently.
//   3. No reply in 2 days → one reminder. After that the dashboard shows "No reply" and offers a quick follow-up.
//   Shipping date = the container's loading (CY) date when it has one, else the line's ready date.
//   Quick follow-up (PO page / dashboard): a short status-update email in the same way, any time.

const crypto = require('node:crypto');
const AI = require('./ai');
const PL = require('./planning');
const { sendEmail, layout, esc } = require('./email');

const CODE_RE = /\bLBR-([A-Z0-9]{5})\b/i;
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => `LBR-${Array.from(crypto.randomBytes(5), (b) => ALPH[b % ALPH.length]).join('')}`;
const LEAD = 5;            // days before the shipping date
const REMIND_AFTER = 2;    // days without a reply → one reminder
const SEND_HOUR = 9;       // China time
const now = () => new Date().toISOString();
const day = (v) => (v ? String(v).slice(0, 10) : null);
const chinaNow = (t = new Date()) => { const d = new Date(t.getTime() + 8 * 3600e3); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
const withLog = (k, text, at = now()) => [...(k.log || []), { at, text }].slice(-40);
const isMissing = (e) => /ready_checks|PGRST205|relation .* does not exist/i.test(String(e?.message || e));
const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const docsAddress = () => (process.env.DOCS_EMAIL || `docs@${domain()}`).toLowerCase();

/** Open PO lines with their shipping date (container CY date, else ready date). */
async function openLines(db, { containers = null } = {}) {
  const lines = (await db.list('plan_orders').catch(() => [])).filter((l) => !l.shipped && l.product && l.ready_date);
  const cs = Object.fromEntries((containers || await db.list('plan_containers').catch(() => [])).map((c) => [c.id, c]));
  return lines.map((l) => { const c = l.container_id ? cs[l.container_id] || null : null; return { ...l, c, ship_date: (c && c.status !== 'shipped' && day(c.loading_date)) || day(l.ready_date) }; });
}

const covers = (k, l) => (k.items || []).some((it) => it.line_id === l.id);
/** The newest check (not a follow-up) that asked about this line at its current shipping date. */
const askedFor = (checks, l) => checks.find((k) => k.kind !== 'followup' && (k.items || []).some((it) => it.line_id === l.id && it.ship_date === l.ship_date));
/** The newest message of any kind about these lines. */
function latestFor(checks, lines) {
  const ids = new Set(lines.map((l) => l.id));
  return [...checks].sort((a, b) => String(b.sent_at || b.created_at).localeCompare(String(a.sent_at || a.created_at))).find((k) => (k.items || []).some((it) => ids.has(it.line_id))) || null;
}
/** When the automatic check goes out for these lines (planned). */
const sendOn = (lines) => { const d = lines.map((l) => l.ship_date).filter(Boolean).sort()[0]; return d ? PL.addDays(d, -LEAD) : null; };

/** State of a message for chips: { key, label, cls }. */
function stateOf(k, today = PL.today()) {
  if (!k) return { key: 'none', label: 'Not sent', cls: '' };
  const f = k.facts || {};
  if (k.status === 'applied') return { key: 'applied', label: `Updated to ${PL.short(f.new_date)}`, cls: 'ok' };
  if (k.status === 'changed') return { key: 'changed', label: `New date ${PL.short(f.new_date)}`, cls: 'bad' };
  if (k.status === 'confirmed') return { key: 'confirmed', label: `Confirmed${k.reply_at ? ` ${PL.short(day(k.reply_at))}` : ''}`, cls: 'ok' };
  if (k.status === 'replied') return { key: 'replied', label: 'Replied — read it', cls: 'plan' };
  const waited = PL.daysBetween ? PL.daysBetween(day(k.sent_at), today) : Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day(k.sent_at)}T12:00:00Z`)) / 864e5);
  if (k.reminders || waited >= REMIND_AFTER) return { key: 'noreply', label: `No reply${k.reminders ? ' · reminded' : ''}`, cls: 'warn' };
  return { key: 'sent', label: `Sent ${PL.short(day(k.sent_at))}`, cls: 'bk' };
}

// ── Email ────────────────────────────────────────────────────────────────────
function compose({ supplier, items, kind = 'check', insp = {}, code }) {
  const pos = [...new Set(items.map((i) => i.po))];
  const first = items.map((i) => i.ship_date).sort()[0];
  const subject = `${kind === 'followup' ? 'Status update' : kind === 'reminder' ? 'Reminder: ready-to-ship confirmation' : 'Ready-to-ship confirmation'} — PO ${pos.join(', ')}${kind === 'followup' ? '' : ` (${PL.short(first)})`} [${code}]`;
  const ask = [];
  if (kind === 'followup') ask.push('Please send a short status update: production progress, packing, and anything that could affect the date below.');
  ask.push(kind === 'followup' ? 'Are the goods still on track to be ready on the date in the table? If not, please give the new date.' : 'Please confirm all goods will be finished and packed by the date in the table — or tell us the new date.');
  const noInsp = pos.filter((p) => !insp[p]);
  if (noInsp.length && kind !== 'followup') ask.push(`Inspection${noInsp.length > 1 ? 's' : ''} for PO ${noInsp.join(', ')}: what date is it scheduled? If it is not booked yet, please tell us the earliest date the goods can be inspected.`);
  const booked = pos.filter((p) => insp[p]).map((p) => `PO ${p}: inspection ${insp[p]}`);
  const intro = kind === 'followup' ? 'Could you give us a quick update on the order below?'
    : kind === 'reminder' ? 'We have not heard back yet about the shipment below — could you please confirm?'
      : `The order${pos.length > 1 ? 's' : ''} below ${pos.length > 1 ? 'are' : 'is'} planned to ship${first ? ` on ${PL.short(first)}` : ''}. Before we confirm the freight booking, please check with production.`;
  const rows = items.map((i) => ({ po: i.po, product: i.product || '', qty: i.qty != null ? Number(i.qty).toLocaleString('en-US') : '', date: PL.short(i.ship_date) }));
  const name = supplier.contact_name || supplier.name;
  const text = [`Dear ${name},`, '', intro, '', ...rows.map((r) => `- PO ${r.po} · ${r.product}${r.qty ? ` · ${r.qty} pcs` : ''} · ready by ${r.date}`), ...(booked.length ? ['', ...booked] : []), '', 'Please reply:', ...ask.map((x, n) => `  ${n + 1}. ${x}`), '', 'Simply reply to this email.', '', 'Thank you,', 'Lulyboo Sourcing'].join('\n');
  const td = 'padding:7px 9px;border:1px solid #ece6e4;font-size:13px;line-height:19px;';
  const table = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:6px;"><tr>${['PO', 'Product', 'Qty', 'Ready by'].map((h, n) => `<td style="${td}background:#faf6f5;font-weight:600;${n > 1 ? 'text-align:right;' : ''}">${h}</td>`).join('')}</tr>
${rows.map((r) => `<tr><td style="${td}">${esc(r.po)}</td><td style="${td}">${esc(r.product)}</td><td style="${td}text-align:right;">${esc(r.qty)}</td><td style="${td}text-align:right;font-weight:600;">${esc(r.date)}</td></tr>`).join('')}</table>`;
  const html = layout({ english: true, preheader: ask[0], body: `<tr><td style="padding:30px 0 0;"><h1 style="margin:0;font-size:25px;line-height:33px;font-weight:600;">${kind === 'followup' ? 'Status update' : 'Ready-to-ship confirmation'}</h1></td></tr>
<tr><td style="padding:20px 0 0;"><p style="margin:0 0 12px;font-size:15px;line-height:24px;">Dear ${esc(name)},</p><p style="margin:0 0 12px;font-size:15px;line-height:24px;">${esc(intro)}</p>${table}
${booked.length ? `<p style="margin:12px 0 0;font-size:14px;line-height:22px;color:#2f8a4c;">${booked.map(esc).join('<br>')}</p>` : ''}</td></tr>
<tr><td style="padding:18px 0 0;"><p style="margin:0 0 6px;font-size:12px;line-height:18px;color:#73777d;text-transform:uppercase;letter-spacing:.05em;">Please reply</p><ol style="margin:0;padding-left:20px;font-size:15px;line-height:25px;">${ask.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></td></tr>
<tr><td style="padding:20px 0 30px;"><p style="margin:0 0 14px;font-size:15px;line-height:24px;">Simply reply to this email.</p><p style="margin:0;font-size:15px;line-height:24px;">Thank you,<br>Lulyboo Sourcing</p></td></tr>` });
  return { subject, text, html, asks: ask };
}

/** Inspection state per PO for the email: text when booked / passed, absent when we need to ask. */
async function inspOf(db, sid, pos) {
  const IN = require('./inspections');
  const rows = await db.list('inspections').catch(() => []);
  const out = {};
  for (const po of pos) {
    const list = rows.filter((i) => i.status !== 'cancelled' && IN.covers(i, sid, po));
    const done = list.find((i) => i.status === 'passed');
    const dated = list.filter((i) => i.inspection_date && ['requested', 'scheduled', 'confirmed', 'report'].includes(i.status)).sort((a, b) => String(a.inspection_date).localeCompare(String(b.inspection_date)))[0];
    if (done) out[po] = 'passed';
    else if (dated) out[po] = `booked for ${PL.short(dated.inspection_date)}`;
    else if (list.length && list.every((i) => i.status === 'skipped')) out[po] = 'not needed';
  }
  return out;
}

/** Send one message to a supplier about these lines. kind: check | followup. */
async function send(db, config, supplier, lines, { kind = 'check', by = null } = {}) {
  const P = require('./projects');
  const to = await P.supplierRecipients(db, supplier);
  if (!to.length) throw new Error(`${supplier.name} has no email address`);
  const cc = P.ownerEmails().filter((e) => !to.includes(e));
  const items = lines.map((l) => ({ line_id: l.id, po: l.po, product: l.product, sku: l.sku || null, qty: l.qty ?? null, ready_date: day(l.ready_date), ship_date: l.ship_date || day(l.ready_date), container_id: l.container_id || null }));
  const insp = await inspOf(db, supplier.id, [...new Set(items.map((i) => i.po))]);
  const code = newCode();
  const m = compose({ supplier, items, kind, insp, code });
  await sendEmail(config, { to, cc, subject: m.subject, text: m.text, html: m.html, replyTo: [docsAddress()] });
  const at = now();
  return db.insert('ready_checks', { code, supplier_id: supplier.id, kind, items, pos: [...new Set(items.map((i) => i.po))], ship_date: items.map((i) => i.ship_date).sort()[0], status: 'sent', sent_at: at, sent_to: to.join(', '), cc: cc.join(', '), subject: m.subject, asks: m.asks, reminders: 0, facts: {}, log: [{ at, text: `${kind === 'followup' ? 'Status update asked' : 'Ready-to-ship confirmation sent'} to ${to.join(', ')}${by ? ` by ${by}` : ''}` }], created_at: at, updated_at: at });
}

async function remind(db, config, k, { by = null } = {}) {
  const sup = await db.get('suppliers', k.supplier_id); if (!sup) throw new Error('Supplier not found');
  const P = require('./projects');
  const to = await P.supplierRecipients(db, sup); if (!to.length) throw new Error(`${sup.name} has no email address`);
  const m = compose({ supplier: sup, items: k.items || [], kind: 'reminder', insp: await inspOf(db, sup.id, k.pos || []), code: k.code });
  await sendEmail(config, { to, cc: P.ownerEmails().filter((e) => !to.includes(e)), subject: m.subject, text: m.text, html: m.html, replyTo: [docsAddress()] });
  await db.update('ready_checks', { id: k.id }, { reminders: (k.reminders || 0) + 1, last_reminded_at: now(), log: withLog(k, `Reminder sent to ${to.join(', ')}${by ? ` by ${by}` : ''}`), updated_at: now() });
}

// ── Replies ──────────────────────────────────────────────────────────────────
const TOOL = {
  name: 'record_ready_reply',
  description: 'Record what the supplier answered about the goods being ready and the inspection date.',
  input_schema: { type: 'object', properties: {
    ready_ok: { type: 'boolean', description: 'true if they confirm the goods will be ready on the date we gave; false if late or not confirmed' },
    new_date: { type: 'string', description: 'New ready date YYYY-MM-DD if they give one (only when different from ours)' },
    per_po: { type: 'array', items: { type: 'object', properties: { po: { type: 'string' }, ready_date: { type: 'string' }, inspection_date: { type: 'string' } } } },
    inspection_date: { type: 'string', description: 'Inspection date YYYY-MM-DD if they state one' },
    summary: { type: 'string', description: 'One or two sentences in English: what they said' },
  } },
};
const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

async function handleEmail({ db, config, from = '', subject = '', text = '' }) {
  const m = String(subject).match(CODE_RE) || String(text).match(CODE_RE); if (!m) return { matched: false };
  const k = (await db.list('ready_checks', { filters: { code: `LBR-${m[1].toUpperCase()}` }, limit: 1 }).catch(() => []))[0];
  if (!k) return { matched: false };
  let r = {};
  if (AI.enabled()) {
    const plan = (k.items || []).map((i) => `PO ${i.po} · ${i.product} · ready by ${i.ship_date}`).join('\n');
    try { r = (await AI.callTool({ tool: TOOL, content: [{ type: 'text', text: `Today is ${PL.today()} (dates without a year are ${new Date().getFullYear()}). We asked a supplier to confirm the goods below are ready on the dates shown, and for the inspection date.\n\nOUR DATES:\n${plan}\n\nTHEIR REPLY:\n${String(text).slice(0, 12000)}` }], maxTokens: 800 })).result || {}; }
    catch (e) { r = { summary: `Could not read the reply automatically (${String(e.message).slice(0, 80)}).` }; }
  }
  const ours = (k.items || []).map((i) => i.ship_date).sort()[0];
  const perPo = (Array.isArray(r.per_po) ? r.per_po : []).map((x) => ({ po: String(x.po || ''), ready_date: iso(x.ready_date), inspection_date: iso(x.inspection_date) }));
  const newDate = iso(r.new_date) || perPo.map((x) => x.ready_date).filter((d) => d && d !== ours).sort().slice(-1)[0] || null;
  const facts = { ready_ok: r.ready_ok === true && !newDate, new_date: newDate && newDate !== ours ? newDate : null, per_po: perPo, inspection_date: iso(r.inspection_date) || perPo.find((x) => x.inspection_date)?.inspection_date || null, summary: String(r.summary || '').slice(0, 600) };
  const status = facts.new_date ? 'changed' : facts.ready_ok ? 'confirmed' : 'replied';
  await db.update('ready_checks', { id: k.id }, { status, facts, reply_at: now(), reply_from: String(from).slice(0, 160), reply_text: String(text).slice(0, 20000), log: withLog(k, `Reply from ${from || 'supplier'}: ${facts.summary || status}`), updated_at: now() });
  await tell(db, config, k, status === 'changed' ? `New ready date ${PL.short(facts.new_date)} (was ${PL.short(ours)}) — apply it on the PO.` : status === 'confirmed' ? `Confirmed ready ${PL.short(ours)}${facts.inspection_date ? ` · inspection ${PL.short(facts.inspection_date)}` : ''}.` : `Replied: ${facts.summary || 'read it on the PO'}`);
  return { matched: true, id: k.id, status };
}

/** Apply the supplier's new date to the lines this message covered. */
async function apply(db, k, { by = null } = {}) {
  const f = k.facts || {}; if (!f.new_date) throw new Error('No new date to apply');
  for (const it of k.items || []) {
    const d = f.per_po?.find((x) => PL.normPo(x.po) === PL.normPo(it.po) && x.ready_date)?.ready_date || f.new_date;
    await db.update('plan_orders', { id: it.line_id }, { ready_date: d, updated_at: now() }).catch(() => null);
  }
  await db.update('ready_checks', { id: k.id }, { status: 'applied', log: withLog(k, `Ready date set to ${PL.short(f.new_date)}${by ? ` by ${by}` : ''}`), updated_at: now() });
}

async function tell(db, config, k, note) {
  const sup = await db.get('suppliers', k.supplier_id).catch(() => null);
  const title = `${sup?.name || 'Supplier'} · PO ${(k.pos || []).join(', ')}`;
  try {
    const tg = require('./telegram'); const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, `📦 <b>Ready to ship</b> ${tg.escapeHtml(title)}\n${tg.escapeHtml(note)}\n${config.publicUrl || ''}/admin/orders/view?supplier=${k.supplier_id}&po=${encodeURIComponent((k.pos || [])[0] || '')}`);
  } catch (e) { console.error('Ready-check Telegram failed:', e.message); }
}

// ── Hourly run ───────────────────────────────────────────────────────────────
async function runReadyChecks({ db, config, at = new Date() }) {
  const cn = chinaNow(at); if (cn.hour < SEND_HOUR) return { waiting: true };
  const checks = await db.list('ready_checks', { order: 'created_at.desc' });
  const today = cn.day; const until = PL.addDays(today, LEAD);
  const due = (await openLines(db)).filter((l) => l.ship_date >= today && l.ship_date <= until && !askedFor(checks, l));
  let sent = 0, reminded = 0;
  const bySup = {}; for (const l of due) (bySup[l.supplier_id] ||= []).push(l);
  for (const [sid, ls] of Object.entries(bySup)) {
    const sup = await db.get('suppliers', sid).catch(() => null); if (!sup) continue;
    try { await send(db, config, sup, ls, { kind: 'check', by: 'automatic, 5 days before shipping' }); sent++; } catch (e) { console.error(`Ready check ${sup.name}:`, e.message); }
  }
  for (const k of checks.filter((x) => x.status === 'sent' && !x.reminders && x.kind !== 'followup' && x.ship_date >= today)) {
    if (PL.addDays(day(k.sent_at), REMIND_AFTER) > today) continue;
    try { await remind(db, config, k, { by: 'automatic' }); reminded++; } catch (e) { console.error('Ready reminder:', e.message); }
  }
  return { sent, reminded };
}

module.exports = { CODE_RE, LEAD, REMIND_AFTER, openLines, askedFor, latestFor, covers, sendOn, stateOf, compose, inspOf, send, remind, handleEmail, apply, runReadyChecks, isMissing, chinaNow };
