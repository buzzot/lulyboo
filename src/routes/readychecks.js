'use strict';
// Ready-to-ship confirmations (src/readycheck.js) — chip + hover card on the PO's "Ready to ship" tile,
// the dashboard's "Shipping in the next 7 days" card, and the actions behind them.
//   POST /admin/orders/ready/send        { supplier, po, kind: check|followup, back }
//   POST /admin/orders/ready/:id/remind  { back }
//   POST /admin/orders/ready/:id/apply   { back }   supplier's new date → the PO lines

const { html, raw } = require('../lib/html');
const { parseForm, flash, HttpError } = require('../lib/http');
const { guard } = require('./admin');
const ST = require('../staff');
const PL = require('../planning');
const RC = require('../readycheck');

const BASE = '/admin/orders/ready';
const poUrl = (sid, po) => `/admin/orders/view?supplier=${encodeURIComponent(sid)}&po=${encodeURIComponent(po)}`;
const day = (v) => (v ? String(v).slice(0, 10) : '');
const back = (f, d = '/admin') => (String(f.back || '').startsWith('/admin') ? f.back : d);
const btn = (action, label, { cls = 'link small', fields = {}, confirm = null } = {}) => html`<form method="post" action="${action}" class="inline">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${cls}" ${confirm ? raw(`data-confirm="${confirm.replace(/"/g, '&quot;')}"`) : ''}>${label}</button></form>`;

/**
 * Chip + hover card for a set of open lines (one PO). `k` = newest message about them (or null).
 * Planned (not sent yet): "✉ Check Nov 18" grey. Sent / no reply / confirmed / new date: coloured.
 */
/** Popup with the follow-up email to check / edit before it goes. `d` = RC.draft(). */
function followDialog(id, d, { sid, po, here, sup }) {
  return html`<dialog id="${id}" class="rp-modal fu-dlg" aria-labelledby="${`${id}-t`}"><form method="post" action="${`${BASE}/send`}" data-busy>
    <input type="hidden" name="supplier" value="${sid}"><input type="hidden" name="po" value="${po}"><input type="hidden" name="kind" value="followup"><input type="hidden" name="code" value="${d.code}"><input type="hidden" name="back" value="${here}">
    <div class="rp-top"><h2 id="${`${id}-t`}">Status update · ${sup} · PO ${po}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
    <div class="fu-two"><label>To <input name="to" value="${d.to.join(', ')}" placeholder="${d.to.length ? '' : 'supplier email'}" required></label><label>Cc <input name="cc" value="${d.cc.join(', ')}"></label></div>
    <label>Subject <input name="subject" value="${d.subject}"></label>
    <label>Message <textarea name="body" rows="14">${d.text}</textarea></label>
    <div class="rp-acts"><span class="sub">Replies come back to the portal (${d.code} in the subject) and are read automatically.</span><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Send</button></div></form></dialog>`;
}
/** "Follow up" button + the last follow-up (date · status) with its history on hover. */
function followCell({ fus, id, today = PL.today() }) {
  const last = fus[0]; const st = last ? RC.stateOf(last, today) : null;
  const card = last ? html`<span class="or-pc-card" data-wide><b class="ht-h">Status updates asked</b><div class="rc-rows">${fus.slice(0, 5).map((k) => { const s2 = RC.stateOf(k, today); return html`<div><span>${PL.short(day(k.sent_at))}</span><span><span class="rc-chip ${s2.cls}">${s2.label.replace(/^Sent .*/, 'Sent')}</span> ${k.reply_at ? html`<span class="sub">${k.facts?.summary || ''}</span>` : html`<span class="sub">to ${k.sent_to || ''}</span>`}</span></div>`; })}</div></span>` : '';
  return html`<button type="button" class="d-btn" data-open-dialog="${id}">Follow up</button>${last ? html`<span class="fu-meta ${st.cls}" tabindex="0" data-popcard>${PL.short(day(last.sent_at))} · ${({ sent: 'sent', noreply: 'no reply', replied: 'replied', confirmed: 'confirmed', changed: 'new date', applied: 'updated' })[st.key] || 'sent'}${card}</span>` : ''}`;
}

function chip({ k, lines, sid, po, here, today = PL.today(), fuId = null }) {
  const st = RC.stateOf(k, today);
  const open = lines.filter((l) => !l.shipped && l.ship_date);
  const plan = RC.sendOn(open);
  if (!k && !open.length) return '';
  const past = open.length && open.every((l) => l.ship_date < today);
  const label = k ? st.label : past ? 'Not sent' : plan ? (plan <= today ? 'Check due — sends at 9:00 China' : `Check goes ${PL.short(plan)}`) : 'No date';
  const f = k?.facts || {};
  const act = [];
  if (!k || ['confirmed', 'applied'].includes(k.status) || k.kind === 'followup') act.push(btn(`${BASE}/send`, k ? 'Ask again' : 'Send now', { fields: { supplier: sid, po, kind: 'check', back: here }, confirm: `Email the supplier now to confirm PO ${po} is ready${open[0] ? ` on ${PL.short(open[0].ship_date)}` : ''}?` }));
  if (k && ['sent'].includes(k.status)) act.push(btn(`${BASE}/${k.id}/remind`, 'Send reminder', { fields: { back: here }, confirm: 'Send the supplier a reminder now?' }));
  if (k && k.status === 'changed') act.push(btn(`${BASE}/${k.id}/apply`, `Apply ${PL.short(f.new_date)}`, { cls: 'btn small', fields: { back: here }, confirm: `Change the ready date of PO ${po} to ${PL.short(f.new_date)}?` }));
  if (fuId) act.push(html`<button type="button" class="link small" data-open-dialog="${fuId}">Quick follow-up…</button>`);
  const card = html`<span class="or-pc-card rc-card" data-wide><b class="ht-h">${k?.kind === 'followup' ? 'Status update' : 'Ready-to-ship confirmation'}${k ? html` <i class="sub rc-code">${k.code}</i>` : ''}</b>
    ${k ? html`<div class="rc-rows">
      <div><span>Sent</span><b>${PL.short(day(k.sent_at))}</b></div>
      <div><span>To</span><span class="trunc" title="${k.sent_to || ''}">${k.sent_to || '—'}</span></div>
      <div><span>Asked</span><span>ready by <b>${PL.short(k.ship_date)}</b>${(k.asks || []).some((a) => /nspection/.test(a)) ? ' · inspection date' : ''}</span></div>
      ${k.reminders ? html`<div><span>Reminder</span><span>${PL.short(day(k.last_reminded_at))}</span></div>` : ''}
      <div><span>Reply</span>${k.reply_at ? html`<span><b>${PL.short(day(k.reply_at))}</b> · ${f.summary || '—'}</span>` : html`<span class="sub">none yet${st.key === 'noreply' ? ' — follow up' : ''}</span>`}</div>
      ${f.new_date ? html`<div><span>New date</span><b class="t-bad">${PL.short(f.new_date)}</b></div>` : ''}
      ${f.inspection_date ? html`<div><span>Inspection</span><b>${PL.short(f.inspection_date)}</b></div>` : ''}
    </div>` : html`<p class="sub" style="margin:4px 0 6px">${past ? 'The shipping date has passed, so nothing goes automatically — use Quick follow-up to ask for a status update.' : plan ? `Goes automatically on ${PL.short(plan)} (5 days before shipping ${PL.short(open[0]?.ship_date)}), at 9:00 China time — one email for all of this supplier's lines shipping then. It asks to confirm the date and, if not booked, the inspection date.` : 'Needs a ready date first.'}</p>`}
    <div class="rc-acts">${act}</div></span>`;
  return html`<span class="rc-chip ${k ? st.cls : 'plan0'}" tabindex="0" data-popcard>✉ ${label}${card}</span>`;
}

/** Chip for one PO page (supplier + its lines). */
async function chipFor(db, supplier, lines, here) {
  let checks = [];
  try { checks = await db.list('ready_checks', { filters: { supplier_id: supplier.id }, order: 'created_at.desc' }); } catch (e) { if (RC.isMissing(e)) return ''; throw e; }
  const withDates = (await RC.openLines(db)).filter((l) => lines.some((x) => x.id === l.id));
  const po = lines[0]?.po || ''; const fuId = `fu-po-${String(po).replace(/\W/g, '')}`;
  const dlg = withDates.length ? followDialog(fuId, await RC.draft(db, supplier, withDates), { sid: supplier.id, po, here, sup: supplier.name }) : '';
  return html`${chip({ k: RC.latestFor(checks, lines), lines: withDates, sid: supplier.id, po, here, fuId: withDates.length ? fuId : null })}${dlg}`;
}

/** Dashboard: POs shipping in the next 7 days (and late ones), freight and readiness at a glance. */
async function upcoming(db, today = PL.today()) {
  const containers = await db.list('plan_containers').catch(() => []);
  // shipping within the next 7 days, plus up to 7 days late — older dates are stale, not "shipping soon"
  const lines = (await RC.openLines(db, { containers })).filter((l) => l.ship_date >= PL.addDays(today, -7) && l.ship_date <= PL.addDays(today, 7));
  let checks = []; try { checks = await db.list('ready_checks', { order: 'created_at.desc' }); } catch (e) { if (!RC.isMissing(e)) throw e; }
  const sups = Object.fromEntries((await db.list('suppliers').catch(() => [])).map((s) => [s.id, s]));
  const IN = require('../inspections'); const insRows = await db.list('inspections').catch(() => []);
  const SN = require('../shipname');
  const g = new Map();
  for (const l of lines) { const key = `${l.supplier_id}|${PL.normPo(l.po)}`; if (!g.has(key)) g.set(key, []); g.get(key).push(l); }
  const rows = [...g.values()].map((ls) => {
    const sid = ls[0].supplier_id; const po = ls[0].po; const date = ls.map((l) => l.ship_date).sort()[0];
    const cs = [...new Set(ls.map((l) => l.c).filter(Boolean))];
    const booked = cs.length && cs.every((c) => c.status === 'booked');
    const freight = !cs.length ? { cls: 'bad', text: 'No container', todo: 'Plan & book freight' }
      : booked ? { cls: 'ok', text: `Booked${cs[0].loading_date ? ` · CY ${PL.short(day(cs[0].loading_date))}` : ''}`, sub: cs.map((c) => c.name || c.box || '').filter(Boolean).join(', ') }
        : { cls: 'warn', text: cs.some((c) => c.status === 'requested') ? 'Quotes asked · not booked' : 'Planned · not booked', sub: cs.map((c) => c.name || c.box || '').filter(Boolean).join(', '), todo: 'Book freight' };
    const ig = sups[sid]?.inspection_off ? { ok: true, text: 'not needed' } : IN.poGate(insRows, sid, po);
    const k = RC.latestFor(checks, ls);
    const ready = ls.map((l) => day(l.ready_date)).sort()[0];
    const fus = checks.filter((x) => x.kind === 'followup' && ls.some((l) => RC.covers(x, l)));
    return { fus, sid, po, sup: sups[sid]?.name || 'Supplier', date, ready, late: date < today, cbm: ls.reduce((a, l) => a + (Number(l.cbm) || 0), 0), port: cs[0]?.port || ls[0].port, freight, insp: ig, k, ls };
  }).sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows) r.draft = await RC.draft(db, sups[r.sid] || { id: r.sid, name: r.sup }, r.ls).catch(() => null);
  return { rows, unbooked: rows.filter((r) => r.freight.todo).length, noReply: rows.filter((r) => ['noreply', 'changed'].includes(RC.stateOf(r.k, today).key)).length, today };
}

function upcomingCard(u, { hideBooked = false } = {}) {
  const booked = u.rows.filter((r) => r.freight.cls === 'ok').length;
  const list = hideBooked ? u.rows.filter((r) => r.freight.cls !== 'ok') : u.rows;
  const rel = (d) => { const n = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${u.today}T12:00:00Z`)) / 864e5); return n < 0 ? `${-n}d late` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n}d`; };
  const rows = list.slice(0, 12);
  return html`<section class="d-card d-12" id="shipping-soon"><div class="d-title"><h2>Shipping in the next 7 days</h2><span class="ss-hd"><span class="muted small">${u.rows.length ? `${u.rows.length} PO${u.rows.length === 1 ? '' : 's'}${u.unbooked ? ` · ${u.unbooked} freight not booked` : ''}${u.noReply ? ` · ${u.noReply} need a follow-up` : ''}` : ''}</span>
      ${booked ? html`<a class="ss-sw ${hideBooked ? 'on' : ''}" href="${`${BASE}/booked?hide=${hideBooked ? '0' : '1'}`}" role="switch" aria-checked="${hideBooked ? 'true' : 'false'}"><span class="ss-knob" aria-hidden="true"></span>Hide booked (${booked})</a>` : ''}</span></div>
    ${rows.length ? html`<div class="ss-wrap"><table class="ss-t"><thead><tr><th>Ships</th><th>PO</th><th class="r">m³</th><th>Freight</th><th>Confirmation</th><th>Inspection</th><th></th></tr></thead><tbody>
      ${rows.map((r) => html`<tr class="${r.late ? 'late' : ''}">
        <td><b>${PL.short(r.date)}</b><div class="sub ${r.late ? 't-bad' : ''}">${rel(r.date)}${r.ready && r.ready !== r.date ? html`<span title="Supplier's ready date"> · ready ${PL.short(r.ready)}</span>` : ''}</div></td>
        <td><a href="${poUrl(r.sid, r.po)}"><b>${r.po}</b></a><div class="sub trunc" title="${r.sup}">${r.sup}</div></td>
        <td class="r">${r.cbm ? r.cbm.toFixed(2) : '—'}</td>
        <td><span class="ss-pill ${r.freight.cls}">${r.freight.text}</span>${r.freight.sub ? html` <span class="sub">${r.freight.sub}</span>` : ''}${r.freight.todo ? html`<div><a class="link small" href="/admin/logistics/planning/load${r.port ? `?port=${r.port}` : ''}">${r.freight.todo} →</a></div>` : ''}</td>
        <td>${chip({ k: r.k, lines: r.ls, sid: r.sid, po: r.po, here: '/admin#shipping-soon', today: u.today, fuId: r.draft ? `fu-${r.sid}-${r.po}`.replace(/[^\w-]/g, '') : null })}</td>
        <td><span class="ss-pill ${r.insp.ok ? 'ok' : r.insp.text === 'no inspection yet' ? 'bad' : 'warn'}">${r.insp.text}</span></td>
        <td class="r ss-fu">${r.draft ? followCell({ fus: r.fus, id: `fu-${r.sid}-${r.po}`.replace(/[^\w-]/g, ''), today: u.today }) : ''}</td></tr>`)}
    </tbody></table></div>${rows.filter((r) => r.draft).map((r) => followDialog(`fu-${r.sid}-${r.po}`.replace(/[^\w-]/g, ''), r.draft, { sid: r.sid, po: r.po, here: '/admin#shipping-soon', sup: r.sup }))}${list.length > rows.length ? html`<p class="d-foot">+${list.length - rows.length} more · <a href="/admin/orders">All purchase orders</a></p>` : ''}`
    : html`<p class="d-empty">${hideBooked && u.rows.length ? 'Everything shipping in the next 7 days is booked.' : 'Nothing ships in the next 7 days.'}</p>`}</section>`;
}

function readyRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => ST.current()?.name || req.staff?.name || 'admin';
  router.post(`${BASE}/send`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const sup = await db.get('suppliers', String(f.supplier || '')).catch(() => null); if (!sup) throw new HttpError(404, 'Supplier not found');
    const ls = (await RC.openLines(db)).filter((l) => l.supplier_id === sup.id && PL.normPo(l.po) === PL.normPo(f.po));
    if (!ls.length) { flash(res, 'warn', `PO ${f.po} has no open lines with a ready date`); return res.redirect(back(f)); }
    const list = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const edits = f.body != null || f.to != null ? { to: list(f.to), cc: list(f.cc), subject: String(f.subject || '').slice(0, 300), text: String(f.body || '').slice(0, 20000), code: String(f.code || '') } : null;
    try { await RC.send(db, config, sup, ls, { kind: f.kind === 'followup' ? 'followup' : 'check', by: by(req), edits }); flash(res, 'ok', `${f.kind === 'followup' ? 'Status update asked' : 'Ready-to-ship confirmation sent'} — ${sup.name}, PO ${f.po}`); }
    catch (e) { console.error('Ready check send:', e.message); flash(res, 'warn', RC.isMissing(e) ? `Not sent — the ready_checks table is missing: run supabase/ready-checks.sql in Supabase (${String(e.message).slice(0, 140)})` : `Not sent — ${e.message}`); }
    res.redirect(back(f));
  }));
  // dashboard switch: hide POs whose freight is booked (remembered in a cookie for a year)
  router.get(`${BASE}/booked`, G(async (req, res) => {
    const on = req.query.hide === '1';
    res.setCookie('ss_hide_booked', on ? '1' : '0', { maxAge: 31536000 });
    res.redirect('/admin#shipping-soon');
  }));
  router.post(`${BASE}/:id/remind`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const k = await db.get('ready_checks', req.params.id).catch(() => null); if (!k) throw new HttpError(404, 'Not found');
    try { await RC.remind(db, config, k, { by: by(req) }); flash(res, 'ok', 'Reminder sent'); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(back(f));
  }));
  router.post(`${BASE}/:id/apply`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const k = await db.get('ready_checks', req.params.id).catch(() => null); if (!k) throw new HttpError(404, 'Not found');
    await RC.apply(db, k, { by: by(req) }); flash(res, 'ok', `Ready date updated to ${PL.short(k.facts?.new_date)}`);
    res.redirect(back(f));
  }));
}

module.exports = readyRoutes;
module.exports.chip = chip; module.exports.chipFor = chipFor; module.exports.upcoming = upcoming; module.exports.upcomingCard = upcomingCard;
