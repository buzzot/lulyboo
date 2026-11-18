'use strict';
// Supplier payments: each PO's payment terms become installments; due dates follow the shipment.
//
//   Terms   "20% against BOL + 80% 50 days after arrival" → [{pct 20, trigger bl}, {pct 80, trigger arrival, offset 50}]
//           read with rules first, AI for anything unusual. Without terms on the PO, the supplier's default terms.
//   Due     PO date · before shipment (ready date) · B/L date (ATD, else ETD) · port arrival (ATA, else ETA) · delivery
//           — "est." until the real date is known, then "fixed". No container data yet: ready + 7 days ≈ ETD, + 18 ≈ ETA.
//   Amount  pct × the supplier's invoice total once its shipping documents are accepted, else × PO value (qty × cost).
//   All USD.
// Reminders (hourly tick, once a day at 9:00 local): payments due in N days / today / overdue → Telegram (the
// portal's bot) + email; docs to the broker N days before the ETA; a weekly PDF of next week's payments (Friday
// 16:00), optionally emailed to the accountant.

const PL = require('./planning');
const pdf = require('./pdf');

const TRIGGERS = { po: 'PO date', before_shipment: 'before shipment', bl: 'B/L date', arrival: 'port arrival', delivery: 'delivery', fixed: 'fixed date' };
const DEF = { remind_days: 3, broker_days: 5, report_weekday: 5, report_hour: 16 };
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const usd = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => (v ? String(v).slice(0, 10) : null);
const between = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const now = () => new Date().toISOString();

// ── Terms ───────────────────────────────────────────────────────────────────
/** The payment sentence among a PO's terms ("Payment: 30% deposit, 70% before shipment"). */
function termsText(lines) {
  for (const l of lines) for (const t of String(l.po_terms || '').split(/(?<=[.;])\s+(?=[A-Z])/)) { const m = t.match(/^\s*(?:payment(?:\s+terms?)?|terms of payment)\s*[:\-]?\s*(.+?)[.;]?\s*$/i); if (m) return m[1].trim(); }
  return null;
}

/** Rules for the usual wording. Returns null when it can't account for 100%. */
function parseTerms(text) {
  const t = String(text || '').replace(/\bT\/T\b/gi, '').trim(); if (!t) return null;
  const parts = t.split(/\s*(?:\+|,|;|\band\b|\bthen\b)\s*/i).filter((x) => /\d\s*%/.test(x));
  if (!parts.length) {
    const days = t.match(/(\d+)\s*days?\s*(?:after|from)\s*(b\/?l|bol|bill of lading|arrival|eta|delivery|invoice)/i);
    if (/^\s*100\s*%?/.test(t) || days) return [{ pct: 100, ...trig(t), label: t.slice(0, 80) }];
    return null;
  }
  const out = parts.map((p) => ({ pct: Number(p.match(/(\d+(?:\.\d+)?)\s*%/)[1]), ...trig(p), label: p.trim().slice(0, 80) }));
  const sum = out.reduce((a, x) => a + x.pct, 0);
  return Math.abs(sum - 100) < 0.01 ? out : null;
}
function trig(p) {
  const s = p.toLowerCase(); const n = Number((s.match(/(\d+)\s*days?/) || [])[1] || 0);
  const before = /\bbefore\b|prior to/.test(s);
  if (/deposit|advance|down ?payment|with (the )?order|upon order|order confirm|\bpo\b|purchase order|signing/.test(s)) return { trigger: 'po', offset_days: n };
  if (/b\/?l|\bbol\b|bill of lading|lading|invoice|shipping doc|copy of/.test(s)) return { trigger: 'bl', offset_days: before ? -n : n };
  if (/arriv|\beta\b|\bata\b|port|destination/.test(s)) return { trigger: 'arrival', offset_days: before ? -n : n };
  if (/deliver|receiv|warehouse/.test(s)) return { trigger: 'delivery', offset_days: n };
  if (/ship|load|dispatch|balance|rest|remaining|inspection/.test(s)) return { trigger: 'before_shipment', offset_days: before && n ? -n : 0 };
  return { trigger: 'before_shipment', offset_days: 0 };
}
const TERMS_TOOL = {
  name: 'payment_schedule', description: 'Split supplier payment terms into installments.',
  input_schema: { type: 'object', properties: { installments: { type: 'array', items: { type: 'object', properties: {
    pct: { type: 'number', description: 'percent of the order value; all installments add up to 100' },
    trigger: { type: 'string', enum: Object.keys(TRIGGERS).filter((k) => k !== 'fixed'), description: 'po = order/deposit; before_shipment = balance before loading; bl = against B/L copy or B/L date; arrival = port arrival; delivery = goods received' },
    offset_days: { type: 'number', description: 'days after the trigger (negative = before)' }, label: { type: 'string', description: 'short wording, e.g. "30% deposit"' },
  }, required: ['pct', 'trigger'] } } }, required: ['installments'] },
};
async function readTerms(text) {
  const rules = parseTerms(text); if (rules) return rules;
  const AI = require('./ai'); if (!AI.enabled() || !text) return null;
  try {
    const { result } = await AI.callTool({ tool: TERMS_TOOL, maxTokens: 600, content: [{ type: 'text', text: `Supplier payment terms: "${text}"` }] });
    const list = (result.installments || []).map((x) => ({ pct: Number(x.pct), trigger: TRIGGERS[x.trigger] ? x.trigger : 'before_shipment', offset_days: Math.round(Number(x.offset_days) || 0), label: String(x.label || '').slice(0, 80) })).filter((x) => x.pct > 0);
    return Math.abs(list.reduce((a, x) => a + x.pct, 0) - 100) < 0.5 ? list : null;
  } catch { return null; }
}
function describe(i) {
  if (i.trigger === 'fixed') return `${i.pct}% on ${PL.short(i.fixed_date)}`;
  const o = Number(i.offset_days) || 0; const t = TRIGGERS[i.trigger];
  if (i.trigger === 'before_shipment' && o) return `${i.pct}% ${Math.abs(o)} days ${o > 0 ? 'after' : 'before'} shipment`;
  return `${i.pct}% ${o ? `${Math.abs(o)} days ${o > 0 ? 'after' : 'before'} ${t}` : i.trigger === 'po' ? 'deposit (PO date)' : i.trigger === 'bl' ? 'against B/L' : i.trigger === 'before_shipment' ? 'before shipment' : `on ${t}`}`;
}

// ── Data ────────────────────────────────────────────────────────────────────
async function load(db) {
  const [lines, rows, conts, scs, sups, st] = await Promise.all([
    db.list('plan_orders').catch(() => []), db.list('po_payments', { order: 'no.asc' }).catch(() => null),
    db.list('plan_containers').catch(() => []), db.list('ship_confirmations').catch(() => []),
    db.list('suppliers', { select: 'id,name,payment_terms' }).catch(() => db.list('suppliers', { select: 'id,name' }).catch(() => [])), db.list('settings', { limit: 1 }).catch(() => []),
  ]);
  return { lines, rows, conts: Object.fromEntries(conts.map((c) => [c.id, c])), scs, sups: Object.fromEntries(sups.map((s) => [s.id, s])), settings: st[0] || {} };
}
const key = (sid, po) => `${sid}|${PL.normPo(po)}`;
function poLines(ctx, sid, po) { return ctx.lines.filter((l) => l.supplier_id === sid && PL.normPo(l.po) === PL.normPo(po)); }

/** Dates of the PO's milestones, actual when known. */
function milestones(ctx, sid, po, poDate) {
  const ls = poLines(ctx, sid, po);
  const created = ls.map((l) => day(l.created_at)).filter(Boolean).sort()[0] || null;
  const ready = ls.map((l) => l.ready_date).filter(Boolean).sort()[0] || null;
  const c = ls.map((l) => ctx.conts[l.container_id]).find(Boolean) || null; const f = c?.fwd || {};
  const etd = day(f.atd) || day(f.etd) || (ready ? PL.addDays(ready, 7) : null);
  const eta = day(f.ata) || day(f.eta) || (etd ? PL.addDays(etd, 18) : null);
  return {
    po: { d: poDate || created, fixed: true, why: poDate ? 'PO date' : 'PO date (imported)' },
    before_shipment: { d: ready, fixed: false, why: ready ? `ready ${PL.short(ready)}` : 'no ready date' },
    bl: { d: etd, fixed: !!f.atd, why: f.atd ? `sailed ${PL.short(day(f.atd))}` : f.etd ? `ETD ${PL.short(day(f.etd))}` : etd ? `≈ ready + 7 days` : 'no dates yet' },
    arrival: { d: eta, fixed: !!f.ata, why: f.ata ? `arrived ${PL.short(day(f.ata))}` : f.eta ? `ETA ${PL.short(day(f.eta))}` : eta ? '≈ ETD + 18 days' : 'no dates yet' },
    delivery: { d: day(c?.delivered_at) || (eta ? PL.addDays(eta, 7) : null), fixed: !!c?.delivered_at, why: c?.delivered_at ? `delivered ${PL.short(day(c.delivered_at))}` : 'est. ETA + 7 days' },
    container: c,
  };
}
/** PO value, or the supplier's invoice total once its documents were accepted (for a request covering this PO only). */
function baseAmount(ctx, sid, po) {
  const ls = poLines(ctx, sid, po);
  const value = r2(ls.reduce((a, l) => a + (Number(l.unit_price) || 0) * (Number(l.qty) || 0), 0));
  const sc = ctx.scs.find((s) => s.supplier_id === sid && s.status === 'complete' && (s.pos || []).length && (s.pos || []).every((x) => PL.normPo(x) === PL.normPo(po)) && Number(s.facts?.invoice_total) > 0);
  return sc ? { amount: r2(sc.facts.invoice_total), from: `invoice${sc.facts.invoice_no ? ` ${sc.facts.invoice_no}` : ''}` } : { amount: value, from: 'PO value' };
}

/** One installment with its due date and amount. */
function resolve(ctx, row) {
  const ms = milestones(ctx, row.supplier_id, row.po, row.po_date);
  const base = baseAmount(ctx, row.supplier_id, row.po);
  let due = null; let fixed = false; let why = '';
  if (row.trigger === 'fixed') { due = row.fixed_date; fixed = true; why = 'fixed date'; }
  else { const m = ms[row.trigger] || ms.before_shipment; due = m.d ? PL.addDays(m.d, Number(row.offset_days) || 0) : null; fixed = m.fixed; why = m.why; }
  if (row.snoozed_until && row.status !== 'paid' && (!due || row.snoozed_until > due)) why += ` · snoozed to ${PL.short(row.snoozed_until)}`;
  const amount = row.amount != null ? r2(row.amount) : r2((base.amount * Number(row.pct)) / 100);
  const paid = r2(row.paid_amount || 0);
  return { ...row, due, fixed, why, amount, from: row.amount != null ? 'set by hand' : base.from, paid, left: r2(Math.max(0, amount - paid)), supplier: ctx.sups[row.supplier_id]?.name || 'Supplier', container: ms.container, describe: describe(row) };
}

/** Create the schedule of every PO that has terms (its own or the supplier's default) and no schedule yet. */
async function sync(db, ctx = null) {
  ctx = ctx || await load(db); if (!ctx.rows) return { ctx, created: 0 };
  const have = new Set(ctx.rows.map((r) => key(r.supplier_id, r.po)));
  const pos = new Map(); for (const l of ctx.lines) { if (l.shipped && l.received_at) continue; const k = key(l.supplier_id, l.po); if (!pos.has(k)) pos.set(k, { sid: l.supplier_id, po: l.po, lines: [] }); pos.get(k).lines.push(l); }
  let created = 0;
  for (const [k, p] of pos) {
    if (have.has(k)) continue;
    const text = termsText(p.lines) || ctx.sups[p.sid]?.payment_terms || null;
    const list = text ? parseTerms(text) : null;   // rules only here; AI runs when you open the PO or edit the terms
    if (!list) continue;
    for (const [i, x] of list.entries()) ctx.rows.push(await db.insert('po_payments', { supplier_id: p.sid, po: p.po, no: i + 1, of_n: list.length, pct: x.pct, trigger: x.trigger, offset_days: x.offset_days || 0, label: x.label || null, terms: text, status: 'open', created_at: now() }));
    created++;
  }
  return { ctx, created };
}

/** (Re)build one PO's schedule from terms text. Paid installments are kept; open ones are replaced. */
async function setTerms(db, sid, po, text, { poDate = null, asDefault = false } = {}) {
  const list = await readTerms(text);
  if (!list) throw Object.assign(new Error(`Couldn't read "${text}" as payment terms — write it like "30% deposit, 70% before shipment"`), { status: 400 });
  const all = (await db.list('po_payments', { filters: { supplier_id: sid } }).catch(() => [])).filter((r) => PL.normPo(r.po) === PL.normPo(po));
  const paid = all.filter((r) => r.status === 'paid' || Number(r.paid_amount) > 0);
  for (const r of all) if (!paid.includes(r)) await db.remove('po_payments', { id: r.id });
  const done = paid.reduce((a, r) => a + Number(r.pct || 0), 0);
  let pctLeft = 100 - done;
  const keep = paid.length;
  for (const [i, x] of list.entries()) {
    if (i < keep) continue;                     // already paid parts stay as they were
    const pct = i === list.length - 1 ? r2(pctLeft) : x.pct; pctLeft -= pct;
    await db.insert('po_payments', { supplier_id: sid, po, no: i + 1, of_n: list.length, pct, trigger: x.trigger, offset_days: x.offset_days || 0, label: x.label || null, terms: text, po_date: poDate || null, status: 'open', created_at: now() });
  }
  if (poDate) for (const r of paid) await db.update('po_payments', { id: r.id }, { po_date: poDate });
  if (asDefault) await db.update('suppliers', { id: sid }, { payment_terms: text }).catch(() => null);
  return list;
}

async function markPaid(db, row, { date, amount, ref, file, by }) {
  const paid = r2((Number(row.paid_amount) || 0) + Number(amount));
  const full = paid >= row.amount - 0.01;
  const log = [...(row.log || []), { at: now(), text: `Paid ${usd(amount)} on ${date}${ref ? ` · ${ref}` : ''}${by ? ` (${by})` : ''}` }].slice(-30);
  const patch = { paid_amount: paid, paid_at: date, paid_ref: ref || row.paid_ref || null, ...(file ? { paid_files: [...(row.paid_files || []), { ...file, by: by || null, at: now() }] } : {}), status: full ? 'paid' : 'open', log, updated_at: now() };
  try { await db.update('po_payments', { id: row.id }, { ...patch, paid_by: by || null }); }
  catch (e) { if (!/paid_by/i.test(e.message)) throw e; await db.update('po_payments', { id: row.id }, patch); } // before accountant.sql
  return { full, paid };
}

/** Every installment, resolved, with the PO's open/paid state. */
async function list(db) {
  const { ctx } = await sync(db);
  if (!ctx.rows) return { missing: true, rows: [], ctx };
  return { rows: ctx.rows.filter((r) => r.status !== 'cancelled').map((r) => resolve(ctx, r)), ctx };
}
const effectiveDue = (r) => (r.snoozed_until && r.status !== 'paid' && (!r.due || r.snoozed_until > r.due) ? r.snoozed_until : r.due);

// ── Weekly PDF ─────────────────────────────────────────────────────────────
function weekOf(d) { const dt = new Date(d + 'T00:00:00Z'); const dow = (dt.getUTCDay() + 6) % 7; return PL.addDays(d, -dow); } // Monday
function reportPdf(rows, { from, to, title = 'Supplier payments', company = 'Lulyboo' }) {
  const d = pdf.doc(); const L = 40; const R = 572; let y = 40;
  const head = () => {
    d.rect(0, 0, 612, 6, { fill: '#c8553d' });
    d.text(L, y, `${company} · ${title}`, { size: 18, bold: true }); y += 26;
    d.text(L, y, `${PL.short(from)} – ${PL.short(to)} ${to.slice(0, 4)} · all amounts USD · generated ${new Date().toISOString().slice(0, 10)}`, { size: 9.5, color: '#6b665f' }); y += 24;
  };
  head();
  const due = rows.filter((r) => r.left > 0).sort((a, b) => String(effectiveDue(a)).localeCompare(String(effectiveDue(b))));
  const today = PL.today(); const overdue = due.filter((r) => effectiveDue(r) < from); const earlyLbl = from > today ? `Still open before ${PL.short(from)}` : 'Overdue'; const inWeek = due.filter((r) => effectiveDue(r) >= from && effectiveDue(r) <= to);
  const sum = (a) => a.reduce((s, r) => s + r.left, 0);
  // totals
  const boxes = [[`Due ${PL.short(from)} – ${PL.short(to)}`, usd(sum(inWeek)), `${inWeek.length} payment${inWeek.length === 1 ? '' : 's'}`], [earlyLbl, usd(sum(overdue)), `${overdue.length} payment${overdue.length === 1 ? '' : 's'}`], ['Total to pay', usd(sum(inWeek) + sum(overdue)), `${new Set([...inWeek, ...overdue].map((r) => r.supplier_id)).size} suppliers`]];
  const bw = (R - L - 20) / 3;
  boxes.forEach(([k, v, s], i) => { const x = L + i * (bw + 10); d.rect(x, y, bw, 58, { fill: i === 1 && overdue.some((r) => effectiveDue(r) < today) ? '#fff3f1' : '#f6f4f0' }); d.text(x + 10, y + 9, k.toUpperCase(), { size: 7.5, bold: true, color: '#8a8680' }); d.text(x + 10, y + 22, v, { size: 15, bold: true, color: i === 1 && overdue.some((r) => effectiveDue(r) < today) ? '#b23a2a' : '#222222' }); d.text(x + 10, y + 42, s, { size: 8.5, color: '#6b665f' }); });
  y += 76;
  const cols = [[L, 74, 'Due'], [L + 76, 120, 'Supplier'], [L + 198, 62, 'PO'], [L + 262, 150, 'Terms'], [L + 414, 38, '%'], [L + 452, 80, 'Amount']];
  const table = (name, list) => {
    if (!list.length) return;
    if (y > 700) { d.page(); y = 40; }
    d.text(L, y, name, { size: 11, bold: true }); y += 18;
    d.rect(L, y, R - L, 18, { fill: '#f1eee9' });
    cols.forEach(([x, w, t], i) => d.text(x + 4, y + 5, t.toUpperCase(), { size: 7.5, bold: true, color: '#6b665f', align: i >= 4 ? 'right' : 'left', width: w - 8 }));
    y += 20;
    for (const r of list) {
      if (y > 730) { d.page(); y = 40; }
      const dd = effectiveDue(r);
      const vals = [`${PL.short(dd)}${r.fixed ? '' : ' (est.)'}`, r.supplier, r.po, `${r.describe} · ${r.no}/${r.of_n || r.no}`, `${r.pct}%`, usd(r.left)];
      vals.forEach((v, i) => { const [x, w] = cols[i]; d.text(x + 4, y + 4, d.fit(v, w - 8, 9, i === 5), { size: 9, bold: i === 5, color: dd < today ? '#b23a2a' : '#222222', align: i >= 4 ? 'right' : 'left', width: w - 8 }); });
      y += 17; d.line(L, y, R, y);
      y += 2;
    }
    d.text(L + 412, y + 4, 'Subtotal', { size: 9, bold: true, color: '#6b665f', align: 'right', width: 32 }); d.text(L + 452, y + 4, usd(sum(list)), { size: 9.5, bold: true, align: 'right', width: 72 }); y += 28;
  };
  table(earlyLbl, overdue);
  table(`Due ${PL.short(from)} – ${PL.short(to)}`, inWeek);
  if (!overdue.length && !inWeek.length) { d.text(L, y, 'No supplier payments are due this week.', { size: 11, color: '#6b665f' }); y += 20; }
  d.text(L, 760, '"est." = the date follows the shipment (ETD / ETA) and may still move. Amounts are the open balance of each installment.', { size: 7.5, color: '#8a8680' });
  return d.end();
}

async function makeReport(db, config, { from = null, send = false, by = 'schedule' } = {}) {
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0] || {};
  from = from || weekOf(PL.addDays(PL.today(), 7));
  const to = PL.addDays(from, 6);
  const { rows } = await list(db);
  const buf = reportPdf(rows, { from, to });
  const name = `Lulyboo payments ${from} to ${to}.pdf`;
  const path = `payments/reports/${from}-${Date.now().toString(36)}.pdf`;
  await db.docs.upload(path, buf, 'application/pdf');
  const due = rows.filter((r) => r.left > 0 && effectiveDue(r) && effectiveDue(r) <= to);
  const total = r2(due.reduce((a, r) => a + r.left, 0));
  let sentTo = null;
  if (send && st.accountant_email) {
    const { sendEmail } = require('./email');
    await sendEmail(config, { to: st.accountant_email, subject: `Supplier payments ${PL.short(from)} – ${PL.short(to)}: ${usd(total)}`, text: `Hello,\n\nAttached are Lulyboo's planned supplier payments for ${PL.short(from)} – ${PL.short(to)}: ${due.length} payment${due.length === 1 ? '' : 's'}, ${usd(total)} in total (including anything overdue).\n\nThank you,\nLulyboo`, attachments: [{ filename: name, content: buf }] });
    sentTo = st.accountant_email;
  }
  const rep = await db.insert('payment_reports', { week_start: from, week_end: to, path, name, total, count: due.length, sent_to: sentTo, created_by: by, created_at: now() });
  return { rep, buf, total, count: due.length, sentTo };
}

// ── Reminders ───────────────────────────────────────────────────────────────
async function telegram(db, text, buttons) {
  const tg = require('./telegram');
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  if (!tg.enabled() || !st?.telegram_chat_id) return false;
  await tg.sendMessage(st.telegram_chat_id, text, { buttons }).catch((e) => console.error('Payment Telegram failed:', e.message));
  return true;
}

async function runReminders({ db, config }) {
  const C = require('./crm'); const tg = require('./telegram');
  const local = C.localNow(); if (local.hour < 9) return;
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0]; if (!st) return;
  const today = local.date; const url = config.publicUrl || '';
  const E = tg.escapeHtml;
  // payments: once a day
  if (st.payments_reminded_on !== today) {
    await db.update('settings', { id: st.id ?? 1 }, { payments_reminded_on: today }).catch(() => null);
    const { rows, missing } = await list(db);
    if (!missing) {
      const days = st.payment_remind_days ?? DEF.remind_days;
      const due = rows.filter((r) => r.status !== 'paid' && r.left > 0 && effectiveDue(r)).map((r) => ({ r, d: effectiveDue(r), n: between(today, effectiveDue(r)) }))
        .filter((x) => x.n < 0 || x.n === 0 || x.n === days).sort((a, b) => a.n - b.n);
      for (const { r, n } of due) {
        const head = n < 0 ? `⚠️ <b>Overdue ${-n} day${n === -1 ? '' : 's'}</b>` : n === 0 ? '💵 <b>Payment due today</b>' : `💵 <b>Payment due in ${n} days</b>`;
        if (st.payment_telegram !== false) await telegram(db, `${head}\n${E(r.supplier)} · PO ${E(r.po)}\n${E(r.describe)} — <b>${usd(r.left)}</b> · due ${E(PL.short(effectiveDue(r)))}${r.fixed ? '' : ' (est.)'}`,
          [[{ text: '✓ Mark paid', data: `pp:${r.id}` }, { text: 'Snooze 1 day', data: `pz:${r.id}` }], [{ text: 'Open PO ↗', url: `${url}/admin/orders/view?supplier=${r.supplier_id}&po=${encodeURIComponent(r.po)}` }]]);
      }
      if (due.length && st.payment_email !== false) {
        const P = require('./projects');
        await P.notifyOwner(config, `[Payments] ${due.length} supplier payment${due.length === 1 ? '' : 's'} to make — ${usd(due.reduce((a, x) => a + x.r.left, 0))}`,
          due.map(({ r, n }) => `${n < 0 ? `OVERDUE ${-n}d` : n === 0 ? 'TODAY' : `in ${n}d`} · ${r.supplier} · PO ${r.po} · ${r.describe} · ${usd(r.left)}`).join('\n'),
          { title: 'Supplier payments', intro: due.map(({ r, n }) => `${n < 0 ? `Overdue ${-n} days` : n === 0 ? 'Due today' : `Due in ${n} days`}: ${r.supplier}, PO ${r.po}, ${usd(r.left)}`).join(' · '), button: 'Open Payments', link: `${url}/admin/orders/payments` }).catch(() => null);
      }
    }
    // docs to the broker: N days before the ETA, until sent
    const bd = st.broker_remind_days ?? DEF.broker_days;
    const conts = await db.list('plan_containers').catch(() => []);
    for (const c of conts) {
      const f = c.fwd || {}; const eta = day(f.eta); if (!eta || f.ata || c.broker_docs_sent_at || c.delivered_at) continue;
      const n = between(today, eta); if (n > bd || n < -3) continue;
      const docs = await brokerDocs(db, c);
      const have = (re) => docs.some((x) => re.test(x.kind));
      if (st.broker_telegram !== false) await telegram(db, `📄 <b>Send docs to the broker</b>\n${E(c.name || `${c.box === 'LCL' ? 'LCL shipment' : 'Container'}`)}${f.container_no ? ` · ${E(f.container_no)}` : ''} · ETA <b>${E(PL.short(eta))}</b> (${n >= 0 ? `${n} day${n === 1 ? '' : 's'}` : `${-n} days ago`})\nCI ${have(/invoice/i) ? '✓' : '✗'} · PL ${have(/packing/i) ? '✓' : '✗'} · B/L ${have(/bill|b\/l/i) ? '✓' : '✗'} · Arrival notice ${have(/arrival/i) ? '✓' : '✗'}`,
        [[{ text: '✉ Email broker', url: `${url}/admin/orders/shipments/${c.id}#broker` }, { text: '✓ Already sent', data: `bs:${c.id}` }]]);
    }
  }
  // per-PO CI / PL still missing after the goods shipped — once a day while open
  if (st.docs_reminded_on !== today && st.docs_telegram !== false) {
    await db.update('settings', { id: st.id ?? 1 }, { docs_reminded_on: today }).catch(() => null);
    const D = require('./podocs');
    const pre = { lines: await db.list('plan_orders').catch(() => []), scs: await db.list('ship_confirmations').catch(() => []), files: await db.list('plan_files').catch(() => []) };
    pre.sups = Object.fromEntries((await db.list('suppliers', { select: 'id,name,email' }).catch(() => [])).map((x) => [x.id, x]));
    for (const c of await db.list('plan_containers').catch(() => [])) {
      const chk = await D.check(db, c, pre); if (!chk.alert) continue;
      const f = c.fwd || {};
      await telegram(db, `📄 <b>Documents missing</b> — ${E(c.name || (c.box === 'LCL' ? 'LCL shipment' : 'Container'))}${f.atd ? ` (sailed ${E(PL.short(day(f.atd)))})` : ' (shipped)'}${f.eta ? ` · ETA ${E(PL.short(day(f.ata || f.eta)))}` : ''}\n${chk.open.map((p) => `${E(p.po)} ${E(p.supplier)}: ${p.missing.join(', ')}`).join('\n')}`,
        [[{ text: '✉ Request from suppliers', data: `rd:${c.id}` }, { text: 'Open shipment ↗', url: `${url}/admin/orders/shipments/${c.id}` }]]);
    }
  }
  // weekly report: Friday 16:00 local (settings), for next Monday–Sunday
  const wd = st.report_weekday ?? DEF.report_weekday; const hr = st.report_hour ?? DEF.report_hour;
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  if (st.weekly_report !== false && dow === wd && local.hour >= hr && st.report_made_on !== today) {
    await db.update('settings', { id: st.id ?? 1 }, { report_made_on: today }).catch(() => null);
    try {
      const r = await makeReport(db, config, { send: !!st.report_to_accountant, by: 'schedule' });
      if (st.report_telegram !== false) await telegram(db, `📊 <b>Payments next week</b> (${E(PL.short(r.rep.week_start))} – ${E(PL.short(r.rep.week_end))})\n${r.count} payment${r.count === 1 ? '' : 's'} · <b>${usd(r.total)}</b>${r.sentTo ? `\nPDF sent to ${E(r.sentTo)}` : ''}`, [[{ text: 'Open PDF ↗', url: `${url}/admin/orders/payments/reports/${r.rep.id}` }]]);
    } catch (e) { if (!/payment_reports|po_payments|PGRST205/.test(e.message)) console.error('Weekly payments report failed:', e.message); }
  }
}

/** Telegram buttons: pp = mark paid in full today, pz = snooze 1 day, bs = docs sent to the broker. */
async function handleCallback(db, data, config = null) {
  let m = /^(pp|pz):([0-9a-f-]{36})$/.exec(data || '');
  if (m) {
    const { rows } = await list(db); const r = rows.find((x) => x.id === m[2]); if (!r) return 'Payment not found';
    if (m[1] === 'pp') { if (r.status === 'paid') return 'Already paid'; await markPaid(db, r, { date: PL.today(), amount: r.left, ref: 'Telegram', by: 'Telegram' }); return `✅ Paid ${usd(r.left)}`; }
    const until = PL.addDays(PL.today(), 1); await db.update('po_payments', { id: r.id }, { snoozed_until: until }); return `💤 Reminder moved to ${PL.short(until)}`;
  }
  m = /^rd:([0-9a-f-]{36})$/.exec(data || '');
  if (m) {
    const c = await db.get('plan_containers', m[1]).catch(() => null); if (!c) return 'Shipment not found';
    const D = require('./podocs'); const chk = await D.check(db, c);
    const items = chk.open.flatMap((p) => p.missing.map((kind) => ({ sid: p.sid, po: p.po, kind })));
    if (!items.length) return '✅ Nothing missing any more';
    const out = await D.request(db, config || {}, c, items, { by: 'Telegram' });
    return out.sent.length ? `✉ Requested from ${out.sent.join(', ')}${out.failed.length ? ` · not sent: ${out.failed.length}` : ''}` : `Not sent: ${out.failed.join(' · ')}`;
  }
  m = /^bs:([0-9a-f-]{36})$/.exec(data || '');
  if (m) { await db.update('plan_containers', { id: m[1] }, { broker_docs_sent_at: now() }); return '✅ Marked as sent to the broker'; }
  return null;
}

// ── Broker documents of a container ─────────────────────────────────────────
async function brokerDocs(db, c) {
  const lines = (await db.list('plan_orders').catch(() => [])).filter((l) => l.container_id === c.id);
  const pos = new Set(lines.map((l) => `${l.supplier_id}|${PL.normPo(l.po)}`));
  const scs = (await db.list('ship_confirmations').catch(() => [])).filter((s) => s.container_id === c.id);
  const files = (await db.list('plan_files').catch(() => [])).filter((f) => scs.some((s) => s.id === f.shipment_id) || ((f.pos || []).some((p) => pos.has(`${f.supplier_id}|${PL.normPo(p)}`)) && /invoice|packing|bill of lading/i.test(f.kind || '')));
  const D = require('./podocs');
  const inBox = (f) => { const seen = new Set(); return (f.pos || []).filter((p) => pos.has(`${f.supplier_id}|${PL.normPo(p)}`)).map((p) => PL.normPo(p)).filter((p) => !seen.has(p) && seen.add(p)); };
  const out = files.filter((f) => /invoice|packing|bill of lading|warehouse/i.test(f.kind || '')).map((f) => { const t = D.classify(f); return { src: 'plan', id: f.id, ref: f.id, name: f.name, kind: t === 'PI' ? 'Proforma invoice' : t === 'PIPL' ? 'Packing list' : t === 'CIPL' ? 'Invoice & packing list' : f.kind, path: f.path, type: f.content_type, po: inBox(f).join(', '), pi: t === 'PI', at: f.created_at, url: `/admin/logistics/planning/files/${f.id}` }; })
    .sort((a, b) => String(a.po || 'zz').localeCompare(String(b.po || 'zz')) || String(a.kind).localeCompare(String(b.kind)));
  const ups = (await db.list('fwd_updates', { filters: { container_id: c.id } }).catch(() => [])).filter((u) => ['accepted', 'logged'].includes(u.status));
  for (const u of ups) (u.files || []).forEach((x, i) => { const t = u.facts?.doc_type || ''; if (/arrival|bill|bl|invoice|packing/i.test(t)) out.push({ src: 'fwd', id: `${u.id}:${i}`, ref: u.id, i, name: x.name, kind: /arrival/i.test(t) ? 'Arrival notice' : /bill|bl/i.test(t) ? 'Bill of lading' : t, path: x.path, type: x.type, at: u.created_at, url: `/admin/orders/shipping/fwd/${u.id}/files/${i}` }); });
  const seen = new Set();
  return out.filter((x) => { const k = `${x.name}|${x.kind}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((x) => ({ ...x, nice: niceName(x) }));
}
/** A long file name becomes "PO400001-CI-2026-11-18.pdf" (PO, document, date received); short names stay. */
const KSHORT = { Invoice: 'CI', 'Invoice & packing list': 'CI-PL', 'Packing list': 'PL', 'Proforma invoice': 'PI', 'Bill of lading': 'BL', 'Warehouse receipt': 'WR', 'Arrival notice': 'AN' };
function niceName(x) {
  const name = String(x.name || 'file');
  if (name.length <= 30) return name;
  const ext = (/\.[a-z0-9]{2,5}$/i.exec(name) || [''])[0].toLowerCase();
  const po = String(x.po || '').split(',')[0].trim();
  return `${po ? `PO${po}-` : ''}${KSHORT[x.kind] || String(x.kind || 'Doc').replace(/\s+/g, '')}-${String(x.at || new Date().toISOString()).slice(0, 10)}${ext}`;
}
async function brokerEmail(db) {
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0] || {};
  if (st.broker_email) return st.broker_email;
  const e = (await db.list('customs_entries', { order: 'created_at.desc' }).catch(() => [])).find((x) => x.from_email && !/lulyboo/i.test(x.from_email));
  return e ? String(e.from_email).replace(/^.*<([^>]+)>.*$/, '$1').trim() : '';
}

module.exports = { TRIGGERS, DEF, parseTerms, readTerms, termsText, describe, load, sync, resolve, list, setTerms, markPaid, effectiveDue, weekOf, reportPdf, makeReport, runReminders, handleCallback, brokerDocs, brokerEmail, usd, between, milestones };
