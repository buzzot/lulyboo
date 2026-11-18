'use strict';
// Finance (the accountant's view): which documents each supplier payment needs before it is paid, the supplier's
// bank details, and the owner notices when the accountant pays or asks something.
//   Needed documents follow the installment's trigger:
//     deposit / before shipment / fixed date → signed PO
//     against B/L                             → signed PO + bill of lading
//     after arrival / delivery                → signed PO + bill of lading + arrival notice
//   A PO file without the "signed" tick is flagged, not blocking.

const PL = require('./planning');
const PM = require('./payments');

const DOCS = { PO: 'Signed PO', BL: 'Bill of lading', AN: 'Arrival notice' };
const SHORT = { PO: 'PO', BL: 'B/L', AN: 'AN' };
const NEED = { po: ['PO'], before_shipment: ['PO'], fixed: ['PO'], bl: ['PO', 'BL'], arrival: ['PO', 'BL', 'AN'], delivery: ['PO', 'BL', 'AN'] };
const need = (trigger) => NEED[trigger] || ['PO'];

/** Everything needed to work out documents for many payments in one go. */
async function preload(db) {
  const [files, ups] = await Promise.all([
    db.list('plan_files').catch(() => []),
    db.list('fwd_updates').catch(() => []),
  ]);
  return { files, ups: ups.filter((u) => ['accepted', 'logged'].includes(u.status) && u.container_id && (u.files || []).length) };
}

const planLink = (f) => ({ name: f.name, url: `/admin/logistics/planning/files/${f.id}`, type: f.content_type || '', signed: !!f.signed, id: f.id, src: 'plan' });
const fwdLink = (u, x, i) => ({ name: x.name, url: `/admin/orders/shipping/fwd/${u.id}/files/${i}`, type: x.type || '', src: 'fwd' });

/** The documents of one payment row (resolved, with .container): { PO, BL, AN, need, missing, unsigned, ok } */
function docsFor(pre, r) {
  const mine = pre.files.filter((f) => f.supplier_id === r.supplier_id && (f.pos || []).some((x) => PL.normPo(x) === PL.normPo(r.po)));
  const isPO = (f) => f.kind === 'PO' || (!f.kind && /(^|[^a-z])(po|purchase order)([^a-z]|$)/i.test(f.name || ''));
  const isBL = (f) => /bill of lading/i.test(f.kind || '') || /(^|[^a-z])(b\/?l|bol|hbl|mbl)([^a-z]|$)|bill of lading/i.test(f.name || '');
  const cid = r.container?.id || null;
  const fwd = (re) => (cid ? pre.ups.filter((u) => u.container_id === cid && re.test(u.facts?.doc_type || '')).flatMap((u) => (u.files || []).map((x, i) => fwdLink(u, x, i))) : []);
  const po = mine.filter(isPO).map(planLink);
  const bl = [...mine.filter((f) => !isPO(f) && isBL(f)).map(planLink), ...fwd(/bill_of_lading/)];
  const an = fwd(/arrival_notice/);
  const needs = need(r.trigger);
  const have = { PO: po, BL: bl, AN: an };
  const missing = needs.filter((k) => !have[k].length);
  const unsigned = needs.includes('PO') && po.length > 0 && !po.some((f) => f.signed);
  return { PO: po, BL: bl, AN: an, need: needs, missing, unsigned, ok: !missing.length && !unsigned };
}

/** Chip state for one document kind: ok | warn (PO not signed) | miss | off (not needed yet). */
function chip(d, k) {
  if (!d.need.includes(k)) return d[k].length ? (k === 'PO' && !d[k].some((f) => f.signed) ? 'warn' : 'ok') : 'off';
  if (!d[k].length) return 'miss';
  return k === 'PO' && !d[k].some((f) => f.signed) ? 'warn' : 'ok';
}

// ── Bank details ──────────────────────────────────────────────────────────
const BANK = [['bank_beneficiary', 'Beneficiary'], ['bank_name', 'Bank'], ['bank_swift', 'SWIFT'], ['bank_account', 'Account no.'], ['bank_address', 'Bank address']];
const hasBank = (s) => !!(s && (s.bank_account || s.bank_swift || s.bank_name));
const mask = (v) => { const t = String(v || '').replace(/\s+/g, ''); return t.length > 4 ? `•••• ${t.slice(-4)}` : t ? '••••' : ''; };

// ── Owner notices ─────────────────────────────────────────────────────────
async function telegram(db, text) {
  const tg = require('./telegram');
  const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
  if (!tg.enabled() || !st?.telegram_chat_id) return false;
  await tg.sendMessage(st.telegram_chat_id, text).catch((e) => console.error('Finance Telegram failed:', e.message));
  return true;
}
async function notifyPaid(db, config, r, { amount, date, ref, by, slip }) {
  const P = require('./projects'); const tg = require('./telegram'); const E = tg.escapeHtml;
  const link = `${config.publicUrl || ''}/admin/finance?tab=paid&id=${r.id}`;
  await telegram(db, `💸 <b>Paid by ${E(by)}</b>\n${E(r.supplier)} · PO ${E(r.po)}\n${E(r.describe)} — <b>${PM.usd(amount)}</b> on ${E(PL.short(date))}${ref ? ` · ${E(ref)}` : ''}${slip ? '\nSlip attached' : ''}\n${link}`);
  await P.notifyOwner(config, `[Payments] ${by} paid ${PM.usd(amount)} — ${r.supplier}, PO ${r.po}`,
    `${r.describe}\nPaid ${PM.usd(amount)} on ${date}${ref ? ` · ref ${ref}` : ''}${slip ? `\nSlip: ${slip.name}` : ''}\n\n${link}`,
    { title: `Payment made by ${by}`, intro: `${r.supplier} · PO ${r.po} — ${r.describe}: ${PM.usd(amount)} paid on ${PL.short(date)}${ref ? ` (ref ${ref})` : ''}.`, button: 'Open', link }).catch(() => null);
}
async function notifyQuestion(db, config, r, { text, by, email }) {
  const P = require('./projects'); const tg = require('./telegram'); const E = tg.escapeHtml;
  const link = `${config.publicUrl || ''}/admin/finance?id=${r.id}`;
  await telegram(db, `❓ <b>${E(by)} asks about a payment</b>\n${E(r.supplier)} · PO ${E(r.po)} · ${E(r.describe)} (${PM.usd(r.left)})\n“${E(text)}”\n${link}`);
  await P.notifyOwner(config, `[Payments] Question from ${by} — ${r.supplier}, PO ${r.po}`, `${text}\n\n${r.describe} · ${PM.usd(r.left)}\n${link}`,
    { title: `${by} has a question`, intro: `${r.supplier} · PO ${r.po} — ${r.describe} (${PM.usd(r.left)}): “${text}”`, button: 'Open payment', link }, email || undefined).catch(() => null);
}

// ── CSV ───────────────────────────────────────────────────────────────────
const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head, rows) => `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

module.exports = { DOCS, SHORT, NEED, need, preload, docsFor, chip, BANK, hasBank, mask, notifyPaid, notifyQuestion, telegram, csv };
