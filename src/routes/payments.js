'use strict';
// Orders → Payments: every installment from each PO's payment terms, with dates that follow the shipment.
//   GET  /admin/orders/payments                 list, cash-out chart, reminder settings, weekly PDFs
//   POST /admin/orders/payments/:id/paid        record a payment (date, amount, ref, slip)
//   POST /admin/orders/payments/:id/reopen      undo
//   POST /admin/orders/payments/terms           set / change a PO's terms (rebuilds the open installments)
//   POST /admin/orders/payments/settings        reminders, accountant email, broker email
//   POST /admin/orders/payments/report          make the weekly PDF now (optionally email it)
//   GET  /admin/orders/payments/reports/:id     download a weekly PDF

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const PL = require('../planning');
const PM = require('../payments');

const BASE = '/admin/orders/payments';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usd = PM.usd;
const usd0 = (v) => `$${Math.round(Number(v || 0)).toLocaleString('en-US')}`;
const k = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : usd0(v));
const SQL_MSG = 'Run supabase/payments.sql in Supabase → SQL Editor first.';

/** Payments card on the PO page. */
async function poCard(db, supplier, po, back) {
  const { rows, missing, ctx } = await PM.list(db).catch(() => ({ rows: [], missing: true }));
  if (missing) return '';
  const mine = rows.filter((r) => r.supplier_id === supplier.id && PL.normPo(r.po) === PL.normPo(po)).sort((a, b) => a.no - b.no);
  const lines = ctx.lines.filter((l) => l.supplier_id === supplier.id && PL.normPo(l.po) === PL.normPo(po));
  const text = mine[0]?.terms || PM.termsText(lines) || supplier.payment_terms || '';
  const today = PL.today();
  const totalLeft = mine.reduce((a, r) => a + r.left, 0);
  const form = (open) => html`<details class="pm-edit" ${open ? raw('open') : ''}><summary>${mine.length ? 'edit' : 'Set payment terms'}</summary>
    <form method="post" action="${BASE}/terms" class="pm-tf"><input type="hidden" name="supplier" value="${supplier.id}"><input type="hidden" name="po" value="${po}"><input type="hidden" name="back" value="${back}">
      <label>Terms <input name="terms" value="${text}" placeholder="e.g. 30% deposit, 70% before shipment" required></label>
      <label>PO date <input type="date" name="po_date" value="${mine[0]?.po_date || ''}"></label>
      <label class="cp-chk"><input type="checkbox" name="default" value="1" ${supplier.payment_terms ? '' : raw('checked')}> Default for ${supplier.name}</label>
      <button class="btn small">Save</button></form></details>`;
  if (!mine.length) return html`<section class="card pm-card" id="payments"><div class="head-row"><h2>Payments</h2></div>
    <p class="sub">${text ? html`Couldn't read “${text}” as payment terms yet.` : 'No payment terms on this PO.'}</p>${form(true)}</section>`;
  return html`<section class="card pm-card" id="payments"><div class="head-row"><h2>Payments ${totalLeft > 0 ? html`<span class="sub">${usd(totalLeft)} to pay</span>` : html`<span class="cp-tag ok">Paid</span>`}</h2><a class="sub" href="${BASE}?supplier=${supplier.id}">All payments →</a></div>
    <div class="pm-terms"><b>Terms</b> ${text} ${form(false)}</div>
    ${mine.map((r) => { const d = PM.effectiveDue(r); const late = r.status !== 'paid' && d && d < today; return html`<div class="pm-sch ${r.status === 'paid' ? 'paid' : late ? 'late' : ''}">
      <span class="pm-dot"></span>
      <div><b>${r.describe} — ${usd(r.amount)}</b>
        <div class="sub">${r.status === 'paid' ? html`paid ${PL.short(r.paid_at)}${r.paid_ref ? ` · ${r.paid_ref}` : ''}${r.paid_by ? ` · by ${r.paid_by}` : ''} ${slips(r)}` : html`${d ? html`${late ? 'was due' : r.fixed ? 'due' : 'expected'} <b>${PL.short(d)}</b>` : 'date not known yet'} · ${r.why}${r.paid > 0 ? ` · ${usd(r.paid)} paid, ${usd(r.left)} left` : ''}`} · ${r.from}</div></div>
      ${r.status === 'paid' ? html`<span class="cp-tag ok">Paid</span>` : paidBtn(r, back)}</div>`; })}
  </section>`;
}
/** Links to the bank slips of a payment. */
function slips(r) {
  return html`${(r.paid_files || []).map((f, i) => { const u = `/admin/finance/slips/${r.id}/${i}`; return html`<a class="pm-slip" href="${u}" title="${f.name}" ${/pdf|image/.test(f.type || '') ? raw(`data-preview="${u}?inline=1" data-type="${/image/.test(f.type) ? 'image' : 'doc'}" data-dl="${u}"`) : raw('download')}>📎 slip</a>`; })}`;
}
function paidBtn(r, back, cls = 'ghost') {
  return html`<button type="button" class="btn small ${cls}" data-open-dialog="pm-paid" data-pm-id="${r.id}" data-pm-amount="${r.left.toFixed(2)}" data-pm-what="${`${r.supplier} · PO ${r.po} · ${r.describe}`}" data-pm-back="${back}">Mark paid…</button>`;
}
function paidDialog() {
  return html`<dialog id="pm-paid" class="rp-modal pm-dlg" aria-labelledby="pm-t"><form method="post" enctype="multipart/form-data" data-pm-form>
    <div class="rp-top"><h2 id="pm-t">Mark paid</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
    <p class="sub" data-pm-what></p><input type="hidden" name="back" data-pm-back>
    <div class="pm-dg"><label>Date paid <input type="date" name="date" value="${PL.today()}" required></label><label>Amount USD <input name="amount" inputmode="decimal" required data-pm-amount></label></div>
    <label>Bank reference <input name="ref" placeholder="optional"></label>
    <label>Payment slip <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg"></label>
    <p class="sub">Paying less? The rest stays open on the same installment.</p>
    <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save payment</button></div></form></dialog>`;
}

module.exports = function paymentRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const back = (f, def = BASE) => (String(f.back || '').startsWith('/admin/') ? f.back : def);

  router.get(BASE, G(async (req, res) => {
    const { rows, missing, ctx } = await PM.list(db);
    const ctxSups = ctx?.sups || {};
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0] || {};
    const q = req.query; const today = PL.today();
    if (missing) return res.html(page({ title: 'Payments', nav: adminNav('payments'), req, flash: takeFlash(req, res), body: html`<h2 class="sl-title">Payments</h2><section class="card"><p>${SQL_MSG}</p></section>` }));
    const sups = [...new Map(rows.map((r) => [r.supplier_id, r.supplier])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const open = rows.filter((r) => r.status !== 'paid' && r.left > 0).map((r) => ({ ...r, d: PM.effectiveDue(r) }));
    const mine = open.filter((r) => !q.supplier || r.supplier_id === q.supplier);
    const horizon = q.range === 'all' ? '9999-12-31' : PL.addDays(today, q.range === '90' ? 90 : 30);
    const over = mine.filter((r) => r.d && r.d < today);
    const upcoming = mine.filter((r) => r.d && r.d >= today && r.d <= horizon).sort((a, b) => a.d.localeCompare(b.d));
    const undated = q.range === 'all' ? mine.filter((r) => !r.d) : [];
    const sum = (a) => a.reduce((s, r) => s + r.left, 0);
    const in7 = open.filter((r) => r.d && r.d >= today && r.d <= PL.addDays(today, 7)); const in30 = open.filter((r) => r.d && r.d >= today && r.d <= PL.addDays(today, 30));
    const month = today.slice(0, 7);
    const paidMonth = rows.filter((r) => String(r.paid_at || '').startsWith(month));
    // cash out by week (8 weeks from this Monday)
    const w0 = PM.weekOf(today);
    const weeks = Array.from({ length: 8 }, (_, i) => { const a = PL.addDays(w0, i * 7); const b = PL.addDays(a, 6); return { a, v: sum(open.filter((r) => r.d && (i === 0 ? r.d <= b : r.d >= a && r.d <= b))) }; });
    const max = Math.max(1, ...weeks.map((w) => w.v));
    const groups = new Map(); for (const r of upcoming) { const w = PM.weekOf(r.d); const lbl = w === w0 ? `This week · ${PL.short(w)} – ${PL.short(PL.addDays(w, 6))}` : `${PL.short(w)} – ${PL.short(PL.addDays(w, 6))}`; if (!groups.has(lbl)) groups.set(lbl, []); groups.get(lbl).push(r); }
    // hover card: the PO's whole payment schedule + the supplier's default terms
    const termsCard = (r) => {
      const sched = rows.filter((x) => x.supplier_id === r.supplier_id && PL.normPo(x.po) === PL.normPo(r.po)).sort((a, b) => a.no - b.no);
      const base = sched.reduce((a, x) => a + x.amount, 0);
      const def = (ctxSups[r.supplier_id] || {}).payment_terms;
      return html`<span class="pmc-h"><b>${r.supplier}</b><span>PO ${r.po}</span></span>
        <span class="pmc-t">“${r.terms || sched.map((x) => x.describe).join(' + ')}”</span>
        <span class="pmc-s">${sched.map((x) => { const d = PM.effectiveDue(x); const st = x.status === 'paid' ? 'paid' : d && d < today ? 'late' : ''; return html`<span class="pmc-r ${x.id === r.id ? 'me' : ''} ${st}"><span>${x.no}. ${x.describe}</span><span>${usd(x.amount)}</span><span>${x.status === 'paid' ? `paid ${PL.short(x.paid_at)}` : d ? `${PL.short(d)}${x.fixed ? '' : ' est.'}` : 'date tbc'}</span></span>`; })}</span>
        <span class="pmc-f">${usd(base)} total · from ${r.from}${def && def !== r.terms ? html`<br>Supplier default: ${def}` : ''}</span>
        <a href="/admin/orders/view?supplier=${r.supplier_id}&po=${encodeURIComponent(r.po)}#payments">Edit terms on the PO →</a>`;
    };
    const row = (r) => { const n = r.d ? PM.between(today, r.d) : null; return html`<div class="pm-row ${n != null && n < 0 ? 'over' : ''}">
      <div class="pm-d"><b>${r.d ? PL.short(r.d) : '—'}</b><small>${n == null ? 'no date yet' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}</small></div>
      <div><b>${r.supplier}</b><div class="sub"><a href="/admin/orders/view?supplier=${r.supplier_id}&po=${encodeURIComponent(r.po)}#payments">PO ${r.po}</a> · ${r.no} of ${r.of_n || r.no}</div></div>
      <div><span class="pmx-tip" tabindex="0" data-popcard>${r.describe}<span class="or-pc-card">${termsCard(r)}</span></span><span class="${r.fixed ? 'pm-fix' : 'pm-est'}">${r.fixed ? 'fixed' : 'est.'}</span><div class="sub">${r.why}</div></div>
      <div class="pm-amt">${usd(r.left)}${r.paid > 0 ? html`<div class="sub">of ${usd(r.amount)}</div>` : ''}</div>
      <div class="sub">${r.from}</div>
      <div class="pm-act">${paidBtn(r, req.url, n != null && n < 0 ? '' : 'ghost')}</div></div>`; };
    const reports = (await db.list('payment_reports', { order: 'created_at.desc', limit: 8 }).catch(() => []));
    const link = (o) => `${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries({ supplier: q.supplier || '', range: q.range || '', ...o }).filter(([, v]) => v)))}`;
    const recentPaid = rows.filter((r) => r.paid_at && (!q.supplier || r.supplier_id === q.supplier)).sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))).slice(0, 8);
    res.html(page({
      title: 'Payments', nav: adminNav('payments'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Payments</h2><p class="muted">Every installment from each PO's payment terms — due dates move with the shipment until they're fixed. All USD.</p></div></div>
        <div class="pm-kp">
          <div class="${over.length ? 'bad' : ''}"><span>Overdue</span><b>${usd0(sum(open.filter((r) => r.d && r.d < today)))}</b><small>${open.filter((r) => r.d && r.d < today).length} payment(s)</small></div>
          <div><span>Due in 7 days</span><b>${usd0(sum(in7))}</b><small>${in7.length} payment(s)</small></div>
          <div><span>Next 30 days</span><b>${usd0(sum(in30))}</b><small>${in30.length} payment(s) · ${new Set(in30.map((r) => r.supplier_id)).size} supplier(s)</small></div>
          <div><span>Paid in ${new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span><b>${usd0(paidMonth.reduce((a, r) => a + r.paid, 0))}</b><small>${paidMonth.length} payment(s)</small></div>
        </div>
        <div class="pm-lay"><div>
        <section class="card"><div class="head-row"><h2>Cash out by week</h2><span class="sub">next 8 weeks</span></div>
          <div class="pmw-bars">${weeks.map((w, i) => html`<div class="pmw-bar ${i === 0 ? 'now' : ''}"><em>${w.v ? k(w.v) : ''}</em><i style="height:${Math.max(2, Math.round((w.v / max) * 84))}px"></i><span>${i === 0 ? 'This week' : PL.short(w.a)}</span></div>`)}</div></section>
        <section class="card"><div class="head-row"><h2>Upcoming</h2>
          <form method="get" action="${BASE}" class="pm-filt"><select name="supplier" data-autosubmit aria-label="Supplier"><option value="">All suppliers</option>${sups.map(([id, n]) => html`<option value="${id}" ${q.supplier === id ? raw('selected') : ''}>${n}</option>`)}</select>
          <select name="range" data-autosubmit aria-label="Range"><option value="">Next 30 days</option><option value="90" ${q.range === '90' ? raw('selected') : ''}>Next 90 days</option><option value="all" ${q.range === 'all' ? raw('selected') : ''}>Everything open</option></select></form></div>
          ${over.length ? html`<div class="pm-wk">Overdue</div>${over.map(row)}` : ''}
          ${[...groups.entries()].map(([g, rs]) => html`<div class="pm-wk">${g} <span>${usd0(sum(rs))}</span></div>${rs.map(row)}`)}
          ${undated.length ? html`<div class="pm-wk">No date yet</div>${undated.map(row)}` : ''}
          ${!over.length && !groups.size && !undated.length ? html`<p class="sub">Nothing to pay ${q.range === 'all' ? '' : 'in this period'}. ${rows.length ? '' : 'Payment terms are read from each PO ("Payment: …"); set them on a PO page if a PO has none.'}</p>` : ''}
        </section>
        ${recentPaid.length ? html`<section class="card"><div class="head-row"><h2>Recently paid</h2></div>${recentPaid.map((r) => html`<div class="pm-row paid"><div class="pm-d"><b>${PL.short(r.paid_at)}</b></div><div><b>${r.supplier}</b><div class="sub">PO ${r.po} · ${r.no} of ${r.of_n || r.no}</div></div><div>${r.describe}<div class="sub">${[r.paid_ref, r.paid_by ? `by ${r.paid_by}` : ''].filter(Boolean).join(' · ')}</div></div><div class="pm-amt">${usd(r.paid)}</div><div>${slips(r)}</div><div class="pm-act"><form method="post" action="${BASE}/${r.id}/reopen" class="inline" data-confirm="Undo this payment?"><input type="hidden" name="back" value="${req.url}"><button class="link small">Undo</button></form></div></div>`)}</section>` : ''}
        </div><aside>
        <section class="card pm-side"><h2>Weekly report</h2>
          <p class="sub">A PDF of next week's payments (plus anything overdue), made every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][st.report_weekday ?? PM.DEF.report_weekday]} at ${st.report_hour ?? PM.DEF.report_hour}:00${st.report_to_accountant && st.accountant_email ? html` and emailed to <b>${st.accountant_email}</b>` : ''}.</p>
          <form method="post" action="${BASE}/report" class="pm-rep"><label>Week of <input type="date" name="from" value="${PM.weekOf(PL.addDays(today, 7))}"></label>
            <label class="cp-chk"><input type="checkbox" name="send" value="1" ${st.accountant_email ? '' : raw('disabled')}> Email to the accountant</label><button class="btn small">Make PDF</button></form>
          ${reports.length ? html`<ul class="pm-reps">${reports.map((r) => html`<li><a href="${BASE}/reports/${r.id}">📄 ${PL.short(r.week_start)} – ${PL.short(r.week_end)}</a><span class="sub">${usd0(r.total)} · ${r.count}${r.sent_to ? ' · emailed' : ''}</span></li>`)}</ul>` : ''}
        </section>
        <section class="card pm-side"><h2>Reminders</h2>
          <form method="post" action="${BASE}/settings" class="pm-set">
            <div class="pm-g"><span title="Also on the due day, and daily while late">Payments</span><span><input type="number" name="payment_remind_days" min="1" max="30" value="${st.payment_remind_days ?? PM.DEF.remind_days}" aria-label="Days before"> days before</span>
              <span>Docs to broker</span><span><input type="number" name="broker_remind_days" min="1" max="30" value="${st.broker_remind_days ?? PM.DEF.broker_days}" aria-label="Days before ETA"> days before ETA</span>
              <span>Weekly report</span><span><select name="report_weekday" aria-label="Day">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => html`<option value="${i}" ${(st.report_weekday ?? PM.DEF.report_weekday) === i ? raw('selected') : ''}>${d}</option>`)}</select> at <input type="number" name="report_hour" min="6" max="22" value="${st.report_hour ?? PM.DEF.report_hour}" aria-label="Hour">:00</span>
              <span>Broker email</span><input type="email" name="broker_email" value="${st.broker_email || ''}" placeholder="from the last customs entry">
              <span>Accountant</span><input type="email" name="accountant_email" value="${st.accountant_email || ''}" placeholder="accountant@…">
              <span></span><label class="cp-chk"><input type="checkbox" name="report_to_accountant" value="1" ${st.report_to_accountant ? raw('checked') : ''}> Email the weekly PDF</label></div>
            <fieldset class="pm-ch"><legend>Send to</legend>
              <div class="pm-ch-h"><span></span><b>Telegram</b><b>Email</b></div>
              <div><span>Payment reminders</span><input type="checkbox" name="payment_telegram" value="1" ${st.payment_telegram !== false ? raw('checked') : ''} aria-label="Payment reminders on Telegram"><input type="checkbox" name="payment_email" value="1" ${st.payment_email !== false ? raw('checked') : ''} aria-label="Payment reminders by email"></div>
              <div><span>Docs to the broker</span><input type="checkbox" name="broker_telegram" value="1" ${st.broker_telegram !== false ? raw('checked') : ''} aria-label="Broker reminders on Telegram"><span class="sub">—</span></div>
              <div><span title="After the goods shipped">Missing CI / PL</span><input type="checkbox" name="docs_telegram" value="1" ${st.docs_telegram !== false ? raw('checked') : ''} aria-label="Missing documents on Telegram"><span class="sub">—</span></div>
              <div><span>Weekly report ready</span><input type="checkbox" name="report_telegram" value="1" ${st.report_telegram !== false ? raw('checked') : ''} aria-label="Weekly report on Telegram"><span class="sub">—</span></div>
            </fieldset>
            <p class="sub">${require('../telegram').enabled() && st.telegram_chat_id ? 'Telegram goes to the portal bot, with Mark paid / Snooze buttons.' : 'Telegram is not connected — connect the bot on the CRM page (Reminders).'} Email reminders go to you.</p>
            <button class="btn small">Save</button></form>
        </section></aside></div>
        ${paidDialog()}`,
    }));
  }));

  router.post(`${BASE}/:id/paid`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 15 * 1024 * 1024 });
    const { rows } = await PM.list(db); const r = rows.find((x) => x.id === req.params.id); if (!r) throw new HttpError(404, 'Payment not found');
    const amount = Number(String(f.amount || '').replace(/[^0-9.]/g, '')); if (!(amount > 0)) throw new HttpError(400, 'Enter the amount paid');
    const date = PL.isoDay(f.date) || PL.today();
    let file = null; const up = Object.values(files || {}).flat().find((x) => x.buffer?.length);
    if (up) { const path = `payments/slips/${r.id}-${Date.now().toString(36)}-${String(up.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`; await db.docs.upload(path, up.buffer, up.type || 'application/octet-stream'); file = { name: up.name, path, type: up.type }; }
    const out = await PM.markPaid(db, r, { date, amount, ref: String(f.ref || '').trim().slice(0, 120), file, by: by(req) });
    flash(res, 'ok', out.full ? `Paid ${usd(amount)} — ${r.supplier}, PO ${r.po}` : `${usd(amount)} recorded — ${usd(r.amount - out.paid)} still open`);
    res.redirect(back(f));
  }));
  router.post(`${BASE}/:id/reopen`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const r = await db.get('po_payments', req.params.id); if (!r) throw new HttpError(404, 'Payment not found');
    await db.update('po_payments', { id: r.id }, { status: 'open', paid_amount: 0, paid_at: null, paid_ref: null, log: [...(r.log || []), { at: new Date().toISOString(), text: `Payment undone (${by(req)})` }] });
    flash(res, 'ok', 'Payment undone'); res.redirect(back(f));
  }));
  router.post(`${BASE}/terms`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const sup = await db.get('suppliers', String(f.supplier || '')); if (!sup) throw new HttpError(404, 'Supplier not found');
    const text = String(f.terms || '').trim().slice(0, 300); if (!text) throw new HttpError(400, 'Type the payment terms');
    const list = await PM.setTerms(db, sup.id, String(f.po || ''), text, { poDate: PL.isoDay(f.po_date), asDefault: f.default === '1' });
    flash(res, 'ok', `Payment terms: ${list.map(PM.describe).join(' · ')}`); res.redirect(back(f));
  }));
  router.post(`${BASE}/settings`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    const em = (v) => { const s = String(v || '').trim(); if (s && !EMAIL_RE.test(s)) throw new HttpError(400, `“${s}” is not an email address`); return s || null; };
    const st = (await db.list('settings', { limit: 1 }))[0];
    await db.update('settings', { id: st?.id ?? 1 }, { payment_remind_days: n(f.payment_remind_days, 1, 30, 3), broker_remind_days: n(f.broker_remind_days, 1, 30, 5), broker_email: em(f.broker_email), accountant_email: em(f.accountant_email), report_to_accountant: f.report_to_accountant === '1', report_weekday: n(f.report_weekday, 0, 6, 5), report_hour: n(f.report_hour, 6, 22, 16), payment_telegram: f.payment_telegram === '1', payment_email: f.payment_email === '1', broker_telegram: f.broker_telegram === '1', report_telegram: f.report_telegram === '1', docs_telegram: f.docs_telegram === '1' });
    flash(res, 'ok', 'Reminder settings saved'); res.redirect(BASE);
  }));
  router.post(`${BASE}/report`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const from = PM.weekOf(PL.isoDay(f.from) || PL.addDays(PL.today(), 7));
    const r = await PM.makeReport(db, config, { from, send: f.send === '1', by: by(req) });
    flash(res, 'ok', `Report for ${PL.short(r.rep.week_start)} – ${PL.short(r.rep.week_end)}: ${r.count} payment(s), ${usd(r.total)}${r.sentTo ? ` · emailed to ${r.sentTo}` : ''}`);
    res.redirect(BASE);
  }));
  router.get(`${BASE}/reports/:id`, G(async (req, res) => {
    const r = await db.get('payment_reports', req.params.id).catch(() => null); if (!r) throw new HttpError(404, 'Report not found');
    const buf = await db.docs.download(r.path);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${String(r.name || 'payments.pdf').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
    res.end(buf);
  }));
};
module.exports.poCard = poCard;
module.exports.paidDialog = paidDialog;
