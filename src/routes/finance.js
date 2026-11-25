'use strict';
// Finance: the accountant's pages (Admin and Director can open them too).
//   GET  /admin/finance?tab=pay|week|docs|paid&id=   queue of payments + side panel for one payment
//   POST /admin/finance/:id/paid                      record a payment (the accountant must attach the bank slip)
//   POST /admin/finance/:id/ask                       question to Lulyboo (Telegram + email to the owner)
//   GET  /admin/finance/slips/:id/:i                  a payment slip
//   GET  /admin/finance/bank/:sid                     the full account number (JSON, audited)
//   GET  /admin/finance/docs                          documents per PO
//   GET  /admin/finance/reports  · POST make a PDF · GET /reports/:id · GET /export.csv?kind=paid|open
//   POST /admin/suppliers/:id/bank                    save a supplier's bank details (Admin / Director)
//   POST /admin/logistics/planning/files/:id/signed   tick / untick "signed" on a PO file

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const ST = require('../staff');
const PL = require('../planning');
const PM = require('../payments');
const FN = require('../finance');

const BASE = '/admin/finance';
const usd = PM.usd;
const usd0 = (v) => `$${Math.round(Number(v || 0)).toLocaleString('en-US')}`;
const SQL_MSG = 'Run supabase/accountant.sql in Supabase → SQL Editor first.';
const TABS = [['pay', 'To pay'], ['week', 'This week'], ['docs', 'Waiting docs'], ['paid', 'Paid']];
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const isPrev = (t) => /pdf|image/.test(t || '');
const fileA = (f, cls = '') => html`<a class="${cls}" href="${f.url}" title="${f.name}" ${isPrev(f.type) ? raw(`data-preview="${f.url}?inline=1" data-type="${/image/.test(f.type) ? 'image' : 'doc'}" data-dl="${f.url}"`) : raw('download')}>${f.name}</a>`;

module.exports = function financeRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const role = (req) => req.staff?.role || 'admin';

  async function data() {
    const { rows, missing } = await PM.list(db);
    if (missing) return { missing: true };
    const pre = await FN.preload(db);
    const today = PL.today();
    const all = rows.map((r) => ({ ...r, d: PM.effectiveDue(r), docs: FN.docsFor(pre, r) }));
    const open = all.filter((r) => r.status !== 'paid' && r.left > 0);
    return { all, open, today, weekEnd: PL.addDays(PM.weekOf(today), 6) };
  }
  const sum = (a, k = 'left') => a.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  const chips = (r) => html`<span class="fn-chips">${['PO', 'BL', 'AN'].map((k) => { const s = FN.chip(r.docs, k); return html`<span class="fn-chip ${s}" title="${`${FN.DOCS[k]}: ${s === 'ok' ? 'on file' : s === 'warn' ? 'on file, not marked signed' : s === 'miss' ? 'missing' : 'not needed yet'}`}">${FN.SHORT[k]}</span>`; })}</span>`;
  const dueTxt = (r, today) => { if (!r.d) return 'date tbc'; const n = PM.between(today, r.d); return n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`; };

  // ── Queue + panel ───────────────────────────────────────────────────────
  router.get(BASE, G(async (req, res) => {
    const q = req.query; const D = await data();
    const navKey = q.tab === 'paid' ? 'finance-paid' : 'finance';
    if (D.missing) return res.html(page({ title: 'Payments', nav: adminNav(navKey), req, flash: takeFlash(req, res), body: html`<h2 class="sl-title">Payments</h2><section class="card"><p>Run supabase/payments.sql in Supabase → SQL Editor first.</p></section>` }));
    const { all, open, today, weekEnd } = D;
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : today.slice(0, 7);
    const view = q.view === 'po' ? 'po' : 'date';
    const qs = String(q.q || '').trim(); const ql = qs.toLowerCase(); const qn = qs.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const hit = (r) => !ql || String(r.supplier || '').toLowerCase().includes(ql) || (qn && PL.normPo(r.po).toLowerCase().includes(qn)) || String(r.po || '').toLowerCase().includes(ql);
    const lists = {
      pay: open.filter((r) => r.d && r.d <= PL.addDays(today, 30)).sort((a, b) => a.d.localeCompare(b.d)),
      week: open.filter((r) => r.d && r.d <= weekEnd).sort((a, b) => a.d.localeCompare(b.d)),
      docs: open.filter((r) => !r.docs.ok).sort((a, b) => String(a.d || '9999').localeCompare(String(b.d || '9999'))),
      paid: all.filter((r) => r.paid > 0 && String(r.paid_at || '').startsWith(month)).sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))),
    };
    for (const k of Object.keys(lists)) lists[k] = lists[k].filter(hit);
    const tab = lists[q.tab] ? q.tab : 'pay';
    const list = lists[tab];
    // By order: one line per PO, its installments side by side
    const show = ['open', 'paid', 'all'].includes(q.show) ? q.show : 'open';
    const orders = (() => {
      const m = new Map();
      for (const r of all) { const k = `${r.supplier_id}|${PL.normPo(r.po)}`; if (!m.has(k)) m.set(k, { key: k, supplier: r.supplier, supplier_id: r.supplier_id, po: r.po, rows: [] }); m.get(k).rows.push(r); }
      return [...m.values()].map((o) => {
        o.rows.sort((a, b) => a.no - b.no);
        const openRows = o.rows.filter((x) => x.status !== 'paid' && x.left > 0);
        o.total = o.rows.reduce((t, x) => t + (Number(x.amount) || 0), 0); o.left = openRows.reduce((t, x) => t + x.left, 0); o.paid = o.rows.reduce((t, x) => t + (Number(x.paid) || 0), 0);
        o.done = !openRows.length; o.next = openRows.map((x) => x.d).filter(Boolean).sort()[0] || (o.done ? null : '9999');
        o.lastPaid = o.rows.map((x) => String(x.paid_at || '')).sort().pop() || '';
        o.docsRow = openRows[0] || o.rows[o.rows.length - 1]; o.nOpen = openRows.length;
        return o;
      });
    })();
    const ordersHit = orders.filter((o) => hit(o.rows[0]));
    const ocount = { open: ordersHit.filter((o) => !o.done).length, paid: ordersHit.filter((o) => o.done).length, all: ordersHit.length };
    const olist = ordersHit.filter((o) => (show === 'open' ? !o.done : show === 'paid' ? o.done : true))
      .sort((a, b) => (a.done - b.done) || (a.done ? b.lastPaid.localeCompare(a.lastPaid) : String(a.next).localeCompare(String(b.next))) || a.supplier.localeCompare(b.supplier));
    const over = open.filter((r) => r.d && r.d < today); const thisWeek = open.filter((r) => r.d && r.d >= today && r.d <= weekEnd);
    const paidNow = all.filter((r) => r.paid > 0 && String(r.paid_at || '').startsWith(today.slice(0, 7)));
    const sel = all.find((r) => r.id === q.id) || (view === 'date' ? list[0] : null) || null;
    const href = (o) => `${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries(view === 'po' ? { view, show: show === 'open' ? '' : show, q: qs, ...o } : { tab, month: tab === 'paid' && month !== today.slice(0, 7) ? month : '', q: qs, ...o }).filter(([, v]) => v)))}`;
    const vhref = (v) => `${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries({ view: v === 'po' ? 'po' : '', q: qs }).filter(([, x]) => x)))}`;
    const days = (d) => PM.between(today, d);
    const amt = (v) => (Math.round(Number(v || 0) * 100) % 100 ? usd(v) : usd0(v));
    const cell = (x) => {
      const done = x.status === 'paid' || x.left <= 0; const n = x.d ? days(x.d) : null;
      const cls = done ? 'paid' : n == null ? 'next' : n < 0 ? 'late' : n <= 7 ? 'soon' : 'next';
      const st = done ? '✓ paid' : x.paid > 0 ? `${amt(x.left)} open` : n == null ? 'date tbc' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`;
      const when = done ? html`paid ${x.paid_at ? PL.short(String(x.paid_at).slice(0, 10)) : ''}` : x.d ? (x.fixed ? html`due ${PL.short(x.d)}` : html`<em>est. ${PL.short(x.d)}</em>`) : html`<em>date not known yet</em>`;
      return html`<a class="ip ${cls} ${sel && sel.id === x.id ? 'on' : ''}" href="${href({ id: x.id })}" title="${`${x.no} of ${x.of_n || x.no} · ${x.describe} · ${x.why}`}"><span class="t"><span>${x.no} · ${x.describe}</span></span><span class="v"><b>${amt(x.amount)}</b><span>${st}</span></span><span class="w">${when}</span></a>`;
    };
    const ncol = Math.max(3, ...olist.map((o) => o.rows.length));
    const orow = (o) => html`<div class="po-row ${o.done ? 'done' : ''}" style="${raw(`--n:${ncol}`)}"><span class="po-s"><b>${o.supplier}</b><small><a href="${`/admin/orders/view?supplier=${o.supplier_id}&po=${encodeURIComponent(o.po)}`}">PO ${o.po}</a> · ${amt(o.total)} total</small></span>
      ${Array.from({ length: ncol }, (_, i) => (o.rows[i] ? cell(o.rows[i]) : html`<span class="ip-none">—</span>`))}
      ${chips(o.docsRow)}<span class="po-l">${o.done ? html`<span class="po-ok">Paid</span><small>${amt(o.paid)}</small>` : html`${amt(o.left)}<small>${o.paid > 0 ? `of ${amt(o.total)}` : 'nothing paid yet'}</small>`}</span></div>`;
    const searchForm = html`<form method="get" action="${BASE}" class="fn-search" role="search">${view === 'po' ? html`<input type="hidden" name="view" value="po">${show !== 'open' ? html`<input type="hidden" name="show" value="${show}">` : ''}` : html`<input type="hidden" name="tab" value="${tab}">${tab === 'paid' && month !== today.slice(0, 7) ? html`<input type="hidden" name="month" value="${month}">` : ''}`}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" name="q" value="${qs}" placeholder="Search supplier or PO…" aria-label="Search supplier or PO"></form>`;
    const viewSw = html`<nav class="fn-view" aria-label="View"><a href="${vhref('date')}" class="${view === 'date' ? 'on' : ''}">By date</a><a href="${vhref('po')}" class="${view === 'po' ? 'on' : ''}">By order</a></nav>`;
    const months = [...new Set([today.slice(0, 7), ...all.filter((r) => r.paid_at).map((r) => String(r.paid_at).slice(0, 7))])].sort().reverse().slice(0, 18);
    const row = (r) => html`<a class="fn-row ${sel && sel.id === r.id ? 'on' : ''} ${tab !== 'paid' && r.d && r.d < today ? 'late' : ''}" href="${href({ id: r.id })}">
      ${tab === 'paid' ? html`<span class="fn-d"><b>${PL.short(r.paid_at)}</b><small>${r.paid_by ? `by ${r.paid_by}` : ''}</small></span>` : html`<span class="fn-d"><b>${r.d ? PL.short(r.d) : '—'}</b><small>${dueTxt(r, today)}${r.d && !r.fixed ? ' · est.' : ''}</small></span>`}
      <span class="fn-s"><b>${r.supplier}</b><small>PO ${r.po} · ${r.no} of ${r.of_n || r.no}</small></span>
      <span class="fn-i">${r.describe}<small>${r.why}</small></span>
      ${chips(r)}
      <span class="fn-a">${usd(tab === 'paid' ? r.paid : r.left)}${tab === 'paid' && (r.paid_files || []).length ? html`<small>📎 slip</small>` : tab !== 'paid' && r.paid > 0 ? html`<small>of ${usd(r.amount)}</small>` : ''}</span></a>`;

    res.html(page({
      title: tab === 'paid' ? 'Paid' : 'Payments', nav: adminNav(navKey), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">${tab === 'paid' ? 'Paid' : 'Supplier payments'}</h2><p class="muted">Check the documents, pay from the bank details, then mark it paid with the bank slip. All USD.</p></div></div>
        <div class="pm-kp">
          <div class="${over.length ? 'bad' : ''}"><span>Overdue</span><b>${usd0(sum(over))}</b><small>${over.length} payment${over.length === 1 ? '' : 's'}</small></div>
          <div><span>Due this week</span><b>${usd0(sum(thisWeek))}</b><small>${thisWeek.length} payment${thisWeek.length === 1 ? '' : 's'} · to ${PL.short(weekEnd)}</small></div>
          <div class="${lists.docs.length ? 'warn' : ''}"><span>Docs to check</span><b>${lists.docs.length}</b><small>payment${lists.docs.length === 1 ? '' : 's'} waiting on documents</small></div>
          <div><span>Paid in ${monthName(today.slice(0, 7)).split(' ')[0]}</span><b>${usd0(sum(paidNow, 'paid'))}</b><small>${paidNow.length} payment${paidNow.length === 1 ? '' : 's'}</small></div>
        </div>
        <div class="fn-lay ${sel ? 'has-panel' : ''}">
          <section class="card fn-q">${view === 'po' ? html`
            <div class="fn-top"><nav class="fn-tabs" aria-label="Orders">${[['open', 'Open orders'], ['paid', 'Fully paid'], ['all', 'All']].map(([k, l]) => html`<a href="${`${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries({ view: 'po', show: k === 'open' ? '' : k, q: qs }).filter(([, v]) => v)))}`}" class="${show === k ? 'on' : ''}" ${show === k ? raw('aria-current="page"') : ''}>${l}${k === 'all' ? '' : html` <span>${ocount[k]}</span>`}</a>`)}</nav>
              <div class="fn-tools">${searchForm}${viewSw}</div></div>
            ${olist.length ? html`<div class="po-head" style="${raw(`--n:${ncol}`)}"><span>Supplier · PO <i>${show === 'paid' ? '↓ last paid' : '↓ next payment due'}</i></span>${Array.from({ length: ncol }, (_, i) => html`<span>Payment ${i + 1}</span>`)}<span>Docs</span><span class="r">${show === 'paid' ? 'Paid' : 'Left to pay'}</span></div>${olist.map(orow)}
              <div class="fn-tot"><span>${olist.length} order${olist.length === 1 ? '' : 's'}${show !== 'paid' ? ` · ${olist.reduce((t, o) => t + o.nOpen, 0)} payment${olist.reduce((t, o) => t + o.nOpen, 0) === 1 ? '' : 's'} open` : ''}${qs ? ` · search “${qs}”` : ''}</span><b>${show === 'paid' ? `${usd(olist.reduce((t, o) => t + o.paid, 0))} paid` : `${usd(olist.reduce((t, o) => t + o.left, 0))} left to pay`}</b></div>`
              : html`<p class="fn-empty">${qs ? `No orders match “${qs}”.` : show === 'paid' ? 'No fully paid orders yet.' : 'No open orders with a payment schedule.'}</p>`}` : html`
            <div class="fn-top"><nav class="fn-tabs" aria-label="Queue">${TABS.map(([k, l]) => html`<a href="${`${BASE}?${new URLSearchParams(Object.fromEntries(Object.entries({ tab: k, q: qs }).filter(([, v]) => v)))}`}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l}${k === 'paid' ? '' : html` <span>${lists[k].length}</span>`}</a>`)}</nav>
              <div class="fn-tools">${tab === 'paid' ? html`<form method="get" action="${BASE}" class="fn-month"><input type="hidden" name="tab" value="paid">${qs ? html`<input type="hidden" name="q" value="${qs}">` : ''}<select name="month" data-autosubmit aria-label="Month">${months.map((m) => html`<option value="${m}" ${m === month ? raw('selected') : ''}>${monthName(m)}</option>`)}</select></form>` : ''}${searchForm}${viewSw}</div></div>
            ${list.length ? html`<div class="fn-head"><span>${tab === 'paid' ? 'Paid' : 'Due'}</span><span>Supplier</span><span>Installment</span><span>Docs</span><span class="r">${tab === 'paid' ? 'Amount' : 'To pay'}</span></div>${list.map(row)}
              ${tab !== 'paid' ? html`<div class="fn-tot"><span>${list.length} payment${list.length === 1 ? '' : 's'}${qs ? ` · search “${qs}”` : ''}</span><b>${usd(sum(list))}</b></div>` : html`<div class="fn-tot"><span>${list.length} payment${list.length === 1 ? '' : 's'} in ${monthName(month)}${qs ? ` · search “${qs}”` : ''}</span><b>${usd(sum(list, 'paid'))}</b></div>`}`
              : html`<p class="fn-empty">${qs ? `Nothing matches “${qs}” here.` : tab === 'paid' ? `Nothing paid in ${monthName(month)}.` : tab === 'docs' ? 'Every open payment has its documents.' : tab === 'week' ? 'Nothing due this week.' : 'Nothing due in the next 30 days.'}</p>`}`}
            <p class="fn-leg">${['ok', 'warn', 'miss', 'off'].map((s) => html`<span><i class="fn-chip ${s}"></i>${{ ok: 'on file', warn: 'PO not marked signed', miss: 'missing', off: 'not needed yet' }[s]}</span>`)}<a href="/admin/finance/inspections" class="fn-ins">Inspection invoices →</a></p>
          </section>
          ${sel ? await panel(req, sel, today) : ''}
        </div>`,
    }));
  }));

  async function panel(req, r, today) {
    const sup = await db.get('suppliers', r.supplier_id).catch(() => null) || {};
    const d = r.docs; const paid = r.status === 'paid' || r.left <= 0;
    const back = String(req.url);
    const canBank = ST.can(role(req), 'bank');
    const sched = (await PM.list(db)).rows.filter((x) => x.supplier_id === r.supplier_id && PL.normPo(x.po) === PL.normPo(r.po)).sort((a, b) => a.no - b.no);
    const docRow = (k) => { const s = FN.chip(d, k); const files = d[k];
      return html`<div class="fn-doc ${s}"><span class="fn-chip ${s}">${FN.SHORT[k]}</span><span class="fn-dn"><b>${FN.DOCS[k]}</b>${files.length ? files.map((f) => html`<span class="fn-df">${fileA(f)}${k === 'PO' ? (f.signed ? html`<em class="ok">signed</em>` : html`<em>not marked signed</em>`) : ''}</span>`) : html`<small>${s === 'off' ? 'not needed for this payment' : 'not received yet'}</small>`}</span></div>`; };
    const log = [...(r.log || [])].reverse().slice(0, 12);
    return html`<aside class="card fn-panel" aria-label="Payment">
      <div class="fn-ph"><div><small>${r.supplier} · PO ${r.po}</small><b>${usd(paid ? r.paid : r.left)}</b></div>
        ${paid ? html`<span class="cp-tag ok">Paid</span>` : r.d && r.d < today ? html`<span class="cp-tag bad">${dueTxt(r, today)}</span>` : html`<span class="cp-tag">${r.d ? `due ${PL.short(r.d)}` : 'date tbc'}</span>`}</div>
      <dl class="fn-dl">
        <dt>Installment</dt><dd>${r.no} of ${r.of_n || r.no} — ${r.describe}</dd>
        <dt>Due</dt><dd>${r.d ? html`${PL.short(r.d)} ${r.d.slice(0, 4)} <span class="sub">${r.fixed ? 'fixed' : 'estimated, moves with the shipment'}</span>` : 'not known yet'}</dd>
        <dt>Basis</dt><dd>${r.why} <span class="sub">· ${usd(r.amount)} from ${r.from}</span></dd>
        <dt>Terms</dt><dd>${r.terms || '—'}<div class="fn-sched">${sched.map((x) => { const xd = PM.effectiveDue(x); const done = x.status === 'paid' || x.left <= 0; const late = !done && xd && xd < today;
          return html`<span class="${x.id === r.id ? 'me' : ''} ${done ? 'paid' : ''}">${x.no}. ${x.describe} · ${usd(x.amount)} <em class="fn-st ${done ? 'ok' : late ? 'bad' : ''}">${done ? '✓ paid' : x.paid > 0 ? `${usd(x.left)} open` : late ? `not paid · due ${PL.short(xd)}` : xd ? `due ${PL.short(xd)}` : 'date tbc'}</em>${x.id !== r.id && !done ? html` <a class="link small" href="${`${BASE}?id=${x.id}`}">open</a>` : ''}</span>`; })}</div></dd>
        ${r.paid > 0 && !paid ? html`<dt>Paid so far</dt><dd>${usd(r.paid)} of ${usd(r.amount)}</dd>` : ''}
      </dl>
      ${(() => { const before = sched.filter((x) => x.no < r.no && x.status !== 'paid' && x.left > 0); return !paid && before.length ? html`<div class="fn-warn"><b>${before.map((x) => `Installment ${x.no} (${x.describe}, ${usd(x.left)})`).join(' and ')} ${before.length === 1 ? "isn't" : "aren't"} marked paid.</b> Pay ${before.length === 1 ? 'it' : 'them'} first, or if already paid, <a href="${`${BASE}?id=${before[0].id}`}">mark ${before.length === 1 ? 'it' : 'them'} paid</a> so this list stays right.</div>` : ''; })()}
      <h3 class="fn-h">Documents to verify ${d.ok ? html`<span class="cp-tag ok">complete</span>` : d.missing.length ? html`<span class="cp-tag bad">${d.missing.length} missing</span>` : html`<span class="cp-tag warn">check PO</span>`}</h3>
      ${['PO', 'BL', 'AN'].filter((k) => d.need.includes(k) || d[k].length).map(docRow)}
      ${canBank ? html`<h3 class="fn-h">Pay to</h3>${FN.hasBank(sup) ? html`<dl class="fn-dl fn-bank">${FN.BANK.map(([k, l]) => (sup[k] ? html`<dt>${l}</dt><dd>${k === 'bank_account' ? html`<span class="fn-mono" id="${`acct-${r.id}`}">${FN.mask(sup[k])}</span> <button type="button" class="link small" data-reveal="${`${BASE}/bank/${sup.id}`}" data-reveal-to="${`acct-${r.id}`}">show</button>` : html`<span class="${k === 'bank_swift' ? 'fn-mono' : ''}">${sup[k]}</span>`}</dd>` : ''))}</dl>` : html`<p class="sub">No bank details on file for ${r.supplier}. ${ST.can(role(req), 'settings') || role(req) === 'director' ? html`<a href="/admin/suppliers/${r.supplier_id}#bank">Add them on the supplier page →</a>` : 'Ask Lulyboo below.'}</p>`}` : ''}
      ${paid ? '' : html`<h3 class="fn-h">Mark paid</h3>
        <form method="post" action="${BASE}/${r.id}/paid" enctype="multipart/form-data" class="fn-form" data-busy>
          <input type="hidden" name="back" value="${back}">
          <label>Date paid <input type="date" name="date" value="${today}" max="${today}" required></label>
          <label>Amount USD <input name="amount" inputmode="decimal" value="${r.left.toFixed(2)}" required></label>
          <label class="span2">Bank reference <input name="ref" placeholder="TT / transfer number"></label>
          <div class="span2 fn-slip"><span class="fn-slip-l">Bank slip ${role(req) === 'accountant' ? '' : html`<span class="sub">(optional)</span>`}</span><div class="mdrop small" data-filebox data-max="1"><div class="mdrop-box"><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp" title="" aria-label="Bank slip" ${role(req) === 'accountant' ? raw('required') : ''}><span class="dz-main" data-main>Drop the bank slip, paste (⌘V) or <u>choose</u></span><span class="dz-hint">PDF or screenshot</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div></div>
          <div class="span2 fn-fa"><span class="sub">Less than the full amount? The rest stays open.</span><button class="btn small">Mark paid</button></div>
        </form>`}
      <details class="fn-ask" ${req.query.ask ? raw('open') : ''}><summary class="link small">Ask Lulyboo a question</summary>
        <form method="post" action="${BASE}/${r.id}/ask" class="fn-askf"><input type="hidden" name="back" value="${back}"><textarea name="text" rows="2" maxlength="1000" required placeholder="e.g. The B/L shows a different amount — pay the full 20%?"></textarea><button class="btn small ghost">Send</button></form></details>
      <h3 class="fn-h">History</h3>
      <ul class="fn-log">${(r.paid_files || []).map((f, i) => html`<li><span>📎</span><span>${fileA({ name: f.name, url: `${BASE}/slips/${r.id}/${i}`, type: f.type })} <small>${f.by ? `by ${f.by}` : ''}${f.at ? ` · ${PL.short(String(f.at).slice(0, 10))}` : ''}</small></span></li>`)}
        ${log.map((x) => html`<li><span>${PL.short(String(x.at || '').slice(0, 10))}</span><span>${x.text}</span></li>`)}
        ${!log.length && !(r.paid_files || []).length ? html`<li><span></span><span class="sub">Nothing yet.</span></li>` : ''}</ul>
    </aside>`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  const findRow = async (id) => { const { rows } = await PM.list(db); const r = rows.find((x) => x.id === id); if (!r) throw new HttpError(404, 'Payment not found'); return r; };
  const backTo = (f, id) => (String(f.back || '').startsWith(BASE) ? f.back : `${BASE}?id=${id}`);

  router.post(`${BASE}/:id/paid`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 15 * 1024 * 1024 });
    const r = await findRow(req.params.id);
    const amount = Number(String(f.amount || '').replace(/[^0-9.]/g, '')); if (!(amount > 0)) throw new HttpError(400, 'Enter the amount paid');
    const date = PL.isoDay(f.date) || PL.today();
    const up = Object.values(files || {}).flat().find((x) => x.buffer?.length);
    if (!up && role(req) === 'accountant') { flash(res, 'error', 'Attach the bank slip to mark it paid'); return res.redirect(backTo(f, r.id)); }
    let file = null;
    if (up) { const path = `payments/slips/${r.id}-${Date.now().toString(36)}-${String(up.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`; await db.docs.upload(path, up.buffer, up.type || 'application/octet-stream'); file = { name: up.name, path, type: up.type }; }
    const ref = String(f.ref || '').trim().slice(0, 120);
    const out = await PM.markPaid(db, r, { date, amount, ref, file, by: by(req) });
    if (role(req) === 'accountant') await FN.notifyPaid(db, config, r, { amount, date, ref, by: by(req), slip: file });
    flash(res, 'ok', out.full ? `Paid ${usd(amount)} — ${r.supplier}, PO ${r.po}` : `${usd(amount)} recorded — ${usd(r.amount - out.paid)} still open`);
    res.redirect(out.full ? `${BASE}?tab=paid&id=${r.id}` : backTo(f, r.id));
  }));

  router.post(`${BASE}/:id/ask`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const r = await findRow(req.params.id);
    const text = String(f.text || '').trim().slice(0, 1000); if (!text) throw new HttpError(400, 'Type your question');
    const row = await db.get('po_payments', r.id);
    await db.update('po_payments', { id: r.id }, { log: [...(row.log || []), { at: new Date().toISOString(), text: `Question from ${by(req)}: ${text}` }].slice(-30) });
    await FN.notifyQuestion(db, config, r, { text, by: by(req), email: req.staff?.email || null });
    flash(res, 'ok', 'Sent to Lulyboo — the answer comes by email or Telegram.');
    res.redirect(backTo(f, r.id));
  }));

  router.get(`${BASE}/slips/:id/:i`, G(async (req, res) => {
    const r = await db.get('po_payments', req.params.id).catch(() => null);
    const f = (r?.paid_files || [])[Number(req.params.i)]; if (!f) throw new HttpError(404, 'Slip not found');
    const buf = await db.docs.download(f.path);
    const type = f.type || 'application/octet-stream';
    const inline = req.query.inline === '1' && /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(type);
    const head = { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    res.writeHead(200, head); res.end(buf);
  }));

  // full account number on request (logged)
  const reveal = G(async (req, res) => {
    if (!ST.can(role(req), 'bank')) throw new HttpError(403, 'Not allowed');
    const s = await db.get('suppliers', req.params.sid).catch(() => null); if (!s) throw new HttpError(404, 'Supplier not found');
    await ST.audit(config, 'Viewed bank account', s.name);
    res.json({ account: s.bank_account || '' });
  });
  router.get(`${BASE}/bank/:sid`, reveal);

  // ── Documents per PO ────────────────────────────────────────────────────
  router.get(`${BASE}/docs`, G(async (req, res) => {
    const D = await data();
    if (D.missing) return res.redirect(BASE);
    const { all, today } = D;
    const pos = new Map();
    for (const r of all) { const k = `${r.supplier_id}|${PL.normPo(r.po)}`; if (!pos.has(k)) pos.set(k, { r, rows: [] }); pos.get(k).rows.push(r); }
    const list = [...pos.values()].map((p) => {
      const open = p.rows.filter((x) => x.status !== 'paid' && x.left > 0).sort((a, b) => String(a.d || '9999').localeCompare(String(b.d || '9999')));
      // what the PO needs at its furthest point so far (the next open installment, else the last one)
      const ref = open[0] || p.rows.sort((a, b) => b.no - a.no)[0];
      return { ...p, open, ref, docs: ref.docs, next: open[0] || null };
    }).filter((p) => p.open.length || p.rows.some((x) => String(x.paid_at || '') >= PL.addDays(today, -60)))
      .sort((a, b) => (b.open.length > 0) - (a.open.length > 0) || String(a.next?.d || '9999').localeCompare(String(b.next?.d || '9999')));
    const cell = (p, k) => { const s = FN.chip(p.docs, k); const files = p.docs[k];
      return html`<span class="fn-dc ${s}"><span class="fn-chip ${s}">${FN.SHORT[k]}</span>${files.length ? html`<span class="fn-dcl">${files.slice(0, 3).map((f) => fileA(f))}${files.length > 3 ? html`<small>+${files.length - 3}</small>` : ''}</span>` : html`<small>${s === 'off' ? 'not needed yet' : 'missing'}</small>`}</span>`; };
    res.html(page({
      title: 'Documents', nav: adminNav('finance-docs'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Documents</h2><p class="muted">The signed PO, bill of lading and arrival notice of every PO with payments open (or paid in the last 60 days). Click a file to preview it.</p></div></div>
        <section class="card fn-docs">${list.length ? html`<div class="fn-dh"><span>Supplier · PO</span><span>Signed PO</span><span>Bill of lading</span><span>Arrival notice</span><span>Next payment</span></div>
          ${list.map((p) => html`<div class="fn-dr"><span class="fn-s"><b>${p.r.supplier}</b><small>PO ${p.r.po}</small></span>${cell(p, 'PO')}${cell(p, 'BL')}${cell(p, 'AN')}
            <span class="fn-nx">${p.next ? html`<a href="${`${BASE}?id=${p.next.id}`}">${usd(p.next.left)}</a><small>${p.next.describe} · ${p.next.d ? PL.short(p.next.d) : 'date tbc'}</small>` : html`<span class="cp-tag ok">Paid</span>`}</span></div>`)}`
          : html`<p class="fn-empty">No payments yet.</p>`}</section>`,
    }));
  }));

  // ── Reports ─────────────────────────────────────────────────────────────
  router.get(`${BASE}/reports`, G(async (req, res) => {
    const today = PL.today();
    const reports = await db.list('payment_reports', { order: 'created_at.desc', limit: 26 }).catch(() => []);
    const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(`${today.slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
    res.html(page({
      title: 'Reports', nav: adminNav('finance-reports'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Reports</h2><p class="muted">Weekly payment plans as PDF, and spreadsheets (CSV, opens in Excel) of what was paid and what is still open.</p></div></div>
        <div class="fn-rep">
        <section class="card"><div class="head-row"><h2>Weekly payment plan</h2></div>
          <form method="post" action="${BASE}/reports" class="fn-rf"><label>Week of <input type="date" name="from" value="${PM.weekOf(PL.addDays(today, 7))}"></label><button class="btn small">Make PDF</button></form>
          ${reports.length ? html`<ul class="fn-rl">${reports.map((r) => html`<li><a href="${`${BASE}/reports/${r.id}`}">📄 ${PL.short(r.week_start)} – ${PL.short(r.week_end)} ${String(r.week_end || '').slice(0, 4)}</a><span class="sub">${usd0(r.total)} · ${r.count} payment${r.count === 1 ? '' : 's'}</span></li>`)}</ul>` : html`<p class="sub">No weekly PDFs yet.</p>`}
        </section>
        <section class="card"><div class="head-row"><h2>Exports</h2></div>
          <form method="get" action="${BASE}/export.csv" class="fn-rf"><input type="hidden" name="kind" value="paid"><label>Paid in <select name="month" aria-label="Month">${months.map((m) => html`<option value="${m}">${monthName(m)}</option>`)}</select></label><button class="btn small ghost">Download CSV</button></form>
          <form method="get" action="${BASE}/export.csv" class="fn-rf"><input type="hidden" name="kind" value="open"><span class="fn-rl-t">Open payables <span class="sub">every unpaid installment, with due dates</span></span><button class="btn small ghost">Download CSV</button></form>
        </section></div>`,
    }));
  }));
  router.post(`${BASE}/reports`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const from = PM.weekOf(PL.isoDay(f.from) || PL.addDays(PL.today(), 7));
    const r = await PM.makeReport(db, config, { from, send: false, by: by(req) });
    flash(res, 'ok', `Weekly plan ${PL.short(r.rep.week_start)} – ${PL.short(r.rep.week_end)}: ${r.count} payment(s), ${usd(r.total)}`);
    res.redirect(`${BASE}/reports`);
  }));
  router.get(`${BASE}/reports/:id`, G(async (req, res) => {
    const r = await db.get('payment_reports', req.params.id).catch(() => null); if (!r) throw new HttpError(404, 'Report not found');
    const buf = await db.docs.download(r.path);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${String(r.name || 'payments.pdf').replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
    res.end(buf);
  }));
  router.get(`${BASE}/export.csv`, G(async (req, res) => {
    const D = await data(); if (D.missing) throw new HttpError(400, 'Payments are not set up yet');
    const kind = req.query.kind === 'open' ? 'open' : 'paid';
    let body; let name;
    if (kind === 'paid') {
      const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : D.today.slice(0, 7);
      const rows = D.all.filter((r) => r.paid > 0 && String(r.paid_at || '').startsWith(month)).sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
      body = FN.csv(['Paid on', 'Supplier', 'PO', 'Installment', 'Terms', 'Amount paid (USD)', 'Installment amount (USD)', 'Bank ref', 'Paid by', 'Slip'],
        rows.map((r) => [r.paid_at, r.supplier, r.po, `${r.no} of ${r.of_n || r.no}: ${r.describe}`, r.terms || '', r.paid.toFixed(2), r.amount.toFixed(2), r.paid_ref || '', r.paid_by || '', (r.paid_files || []).map((f) => f.name).join('; ')]));
      name = `Lulyboo paid ${month}.csv`;
    } else {
      const rows = D.open.sort((a, b) => String(a.d || '9999').localeCompare(String(b.d || '9999')));
      body = FN.csv(['Due', 'Date', 'Supplier', 'PO', 'Installment', 'Basis', 'Amount (USD)', 'Paid so far (USD)', 'To pay (USD)', 'Documents missing'],
        rows.map((r) => [r.d || '', r.d ? (r.fixed ? 'fixed' : 'estimated') : 'not known', r.supplier, r.po, `${r.no} of ${r.of_n || r.no}: ${r.describe}`, r.why, r.amount.toFixed(2), r.paid.toFixed(2), r.left.toFixed(2), [...r.docs.missing.map((k) => FN.DOCS[k]), ...(r.docs.unsigned ? ['PO not marked signed'] : [])].join('; ')]));
      name = `Lulyboo open payables ${D.today}.csv`;
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' });
    res.end(body);
  }));

  // ── Supplier bank details (Admin / Director) ───────────────────────────
  router.post('/admin/suppliers/:id/bank', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const s = await db.get('suppliers', req.params.id); if (!s) throw new HttpError(404, 'Supplier not found');
    const patch = Object.fromEntries(FN.BANK.map(([k]) => [k, String(f[k] || '').trim().slice(0, k === 'bank_address' ? 300 : 120) || null]));
    // an empty account field keeps the stored number (the form shows it masked)
    if (!patch.bank_account && f.clear_account !== '1') delete patch.bank_account;
    try { await db.update('suppliers', { id: s.id }, patch); flash(res, 'ok', 'Bank details saved'); }
    catch (e) { flash(res, 'error', /bank_/i.test(e.message) ? SQL_MSG : e.message); }
    res.redirect(`/admin/suppliers/${s.id}#bank`);
  }));
  router.get('/admin/suppliers/:sid/bank', reveal);

  // ── "Signed" tick on a PO file ─────────────────────────────────────────
  router.post('/admin/logistics/planning/files/:id/signed', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const file = await db.get('plan_files', req.params.id); if (!file) throw new HttpError(404, 'Document not found');
    try { await db.update('plan_files', { id: file.id }, { signed: !file.signed }); flash(res, 'ok', file.signed ? `${file.name}: not signed` : `${file.name}: marked signed`); }
    catch (e) { flash(res, 'error', /signed/i.test(e.message) ? SQL_MSG : e.message); }
    const b = String(f.back || ''); res.redirect(b.startsWith('/admin/') ? `${b.split('#')[0]}#docs` : '/admin/logistics/planning?view=docs');
  }));
};
