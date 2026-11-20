'use strict';
// Logistics → Freight costs: Overview (history charts, forwarders) · Compare offers (all-in per container) ·
// Quotes (rate history page) · Charges (catalog with internal notes, market checks) · Actual costs (freight invoices).

const { html, raw } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const SCR = require('./schedules');
const PL = require('../planning');
const SC = require('../schedules');
const RH = require('../rate-history');
const FC = require('../freight-costs');
const AI = require('../ai');
const ST = require('../staff');
const { ddSel } = require('./logistics-costs');

const BASE = '/admin/logistics/freight';
const BOXES = ['20GP', '40GP', '40HQ', 'LCL'];
const BOXN = { '20GP': "20' GP", '40GP': "40' GP", '40HQ': "40' HQ", LCL: 'LCL' };
const usd = FC.usd; const r2 = FC.r2;
const short = (d) => (d ? PL.short(String(d).slice(0, 10)) : '');
const now = () => new Date().toISOString();
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
const portN = (c) => SC.PORT[c]?.name || c || '';

/** Sub-navigation shared with the Quotes (rate history) page. */
function subTabs(on) {
  const t = [['overview', `${BASE}?tab=overview`, 'Overview'], ['compare', `${BASE}`, 'Compare offers'], ['quotes', '/admin/logistics/rates', 'Quotes'], ['charges', `${BASE}?tab=charges`, 'Charges'], ['actuals', `${BASE}?tab=actuals`, 'Actual costs']];
  return html`<nav class="fc-st" aria-label="Freight costs">${t.map(([k, href, l]) => html`<a href="${href}" class="${k === on ? 'on' : ''}" ${k === on ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
}

// ── small SVG charts (server-rendered, no script) ─────────────────────────────
const COLS = { ocean: '#1d4f7a', port: '#6f9bc4', customs: '#8fb5d6', trucking: '#d9a200', extra: '#c4574b' };
const LINE = ['#5b4bb5', '#1d6b40', '#c4574b', '#d9a200', '#1d4f7a'];
const mLabel = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
const kfmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
function stackChart(data) {
  const W = 560; const H = 200; const L = 38; const B = 170; const top = 14;
  const max = Math.max(1000, ...data.map((d) => (d.n ? d.ocean + d.port + d.customs + d.trucking + d.extra : 0))) * 1.12;
  const step = (W - L - 10) / data.length; const bw = Math.min(40, step * 0.6);
  const y = (v) => B - (v / max) * (B - top);
  let s = '';
  for (let i = 0; i <= 3; i++) { const v = (max / 3) * i; s += `<line x1="${L}" y1="${y(v)}" x2="${W - 6}" y2="${y(v)}" stroke="#efedea"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="#8a857e">${kfmt(v)}</text>`; }
  data.forEach((d, i) => {
    const x = L + step * i + (step - bw) / 2;
    if (d.n) {
      let acc = 0;
      for (const k of ['ocean', 'port', 'customs', 'trucking', 'extra']) { const v = d[k] || 0; if (!v) continue; s += `<rect x="${x}" y="${y(acc + v)}" width="${bw}" height="${Math.max(0.5, y(acc) - y(acc + v))}" fill="${COLS[k]}" ${d.quoteOnly ? 'fill-opacity="0.55"' : ''}><title>${mLabel(d.m)} · ${FC.GROUPS[k]} ${usd(v, 0)}</title></rect>`; acc += v; }
      s += `<text x="${x + bw / 2}" y="${y(acc) - 4}" text-anchor="middle" font-size="9.5" fill="#5d5852">${kfmt(acc)}${d.n > 1 ? ` ·${d.n}` : ''}</text>`;
    }
    s += `<text x="${x + bw / 2}" y="${B + 14}" text-anchor="middle" font-size="10" fill="#8a857e">${mLabel(d.m)}</text>`;
  });
  return raw(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="All-in cost per container by month">${s}</svg>`);
}
function lineChart(series, months) {
  const W = 440; const H = 200; const L = 38; const B = 170; const top = 14;
  const vals = series.flatMap((x) => x.points).filter((v) => v != null);
  if (!vals.length) return raw('<p class="sub">No priced quotes in these months yet.</p>');
  const lo = Math.min(...vals) * 0.85; const hi = Math.max(...vals) * 1.08;
  const step = (W - L - 14) / Math.max(1, months.length - 1);
  const x = (i) => L + step * i; const y = (v) => B - ((v - lo) / (hi - lo || 1)) * (B - top);
  let s = '';
  for (let i = 0; i <= 3; i++) { const v = lo + ((hi - lo) / 3) * i; s += `<line x1="${L}" y1="${y(v)}" x2="${W - 6}" y2="${y(v)}" stroke="#efedea"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="#8a857e">${kfmt(v)}</text>`; }
  months.forEach((m, i) => { if (months.length <= 8 || i % 2 === 0) s += `<text x="${x(i)}" y="${B + 14}" text-anchor="middle" font-size="10" fill="#8a857e">${mLabel(m)}</text>`; });
  series.forEach((sr, k) => {
    const pts = sr.points.map((v, i) => (v == null ? null : [x(i), y(v)]));
    let seg = []; const flush = () => { if (seg.length > 1) s += `<polyline fill="none" stroke="${LINE[k % LINE.length]}" stroke-width="2.4" points="${seg.map((p) => p.join(',')).join(' ')}"/>`; seg = []; };
    pts.forEach((p) => { if (p) seg.push(p); else flush(); }); flush();
    pts.forEach((p, i) => { if (p) s += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${LINE[k % LINE.length]}"><title>${sr.company} · ${mLabel(months[i])} · ${usd(sr.points[i], 0)}</title></circle>`; });
  });
  return raw(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Ocean rate by forwarder by month">${s}</svg>`);
}

module.exports = function freightRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  async function loadAll() {
    const { rows: types, missing } = await FC.catalog(db);
    let offers = [];
    try { await RH.syncAll(db); offers = await db.list('freight_quotes', { order: 'quoted_on.desc' }); } catch (e) { if (!RH.missingTable(e)) throw e; }
    const acts = await FC.actuals(db, types);
    const typ = FC.typicals(types, offers.filter((o) => !o.excluded && String(o.quoted_on) >= PL.addDays(PL.today(), -365)), acts);
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0] || {};
    return { types, missing, offers, acts, typ, st };
  }
  const missingNote = html`<div class="flash flash-warn">Run <b>supabase/freight-costs.sql</b> in Supabase first (charge list, offers added from files, actual costs).</div>`;

  router.get(BASE, G(async (req, res) => {
    const tab = ['overview', 'charges', 'actuals'].includes(req.query.tab) ? req.query.tab : 'compare';
    const data = await loadAll();
    const body = tab === 'overview' ? await overview(req, data) : tab === 'charges' ? await charges(req, data) : tab === 'actuals' ? await actualsTab(req, data) : await compare(req, data);
    res.html(page({ title: 'Freight costs', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, body: html`${SCR.logisticsTabs('rates')}${subTabs(tab)}${data.missing ? missingNote : ''}${body}` }));
  }));

  /** A charge name that explains itself on hover / focus: the saved note, or AI writes one on first hover and saves it. */
  const tipName = (t) => html`<span class="fc-tip" tabindex="0" data-fc-tip="${t.id}" ${t.note ? '' : raw('data-fc-fetch')}>${t.name}<span class="fc-tip-box" hidden><b>${t.name}</b> <span class="sub">${FC.UNITS[t.unit] || ''} · ${FC.WHEN[t.when_applies] || 'always'}</span><span class="fc-tip-t">${t.note || ''}</span></span></span>`;

  // ── Compare offers ────────────────────────────────────────────────────────
  async function compare(req, { types, offers, typ, st }) {
    const q = req.query;
    const conts = (await db.list('plan_containers').catch(() => [])).filter((c) => !c.record_only && !['shipped'].includes(c.status));
    const lines = await db.list('plan_orders').catch(() => []);
    const SN = require('../shipname');
    const info = (c) => { const ls = lines.filter((l) => l.container_id === c.id); return { cbm: r2(ls.reduce((a, l) => a + (Number(l.cbm) || 0), 0)), ready: ls.map((l) => l.ready_date).filter(Boolean).sort().pop() || null, n: ls.length }; };
    const c = conts.find((x) => x.id === q.c) || null;
    const box = c ? c.box : BOXES.includes(q.box) ? q.box : '40HQ';
    const ci = c ? info(c) : { cbm: num(q.cbm), ready: null };
    const nLines = Math.max(1, Math.min(40, Math.round(num(q.lines) || 3)));
    const to = String(q.to || st.delivery_address || FC.DEFAULT_ADDRESS).slice(0, 200);
    const today = PL.today();
    // this container's offers, plus unlinked offers that are still valid (a quote without a validity date counts for 14 days)
    const live = (o) => (o.valid_until ? o.valid_until >= today : o.quoted_on >= PL.addDays(today, -14));
    const inScope = (o) => o.box === box && (c ? (o.container_id === c.id || (!o.container_id && live(o))) : live(o));
    const hidden = offers.filter((o) => o.excluded && inScope(o)).slice(0, 12);
    let list = offers.filter((o) => !o.excluded && inScope(o));
    list = list.map((o) => ({ o, id: o.id, a: FC.allIn(o, types, typ, { lines: nLines }) })).filter((x) => x.o.ocean_usd != null);
    list.sort((x, y) => (y.o.chosen ? 1 : 0) - (x.o.chosen ? 1 : 0) || x.a.total - y.a.total);
    const shown = list.slice(0, 4);
    const tyO = FC.typicalOffer(offers.filter((o) => !o.excluded), box);
    const tyA = FC.allIn(tyO, types, typ, { lines: nLines });
    const best = shown.length ? shown.reduce((b, x) => (x.a.total < b.a.total ? x : b), shown[0]) : null;
    const contOpts = [['', `Any ${BOXN[box]} (no container)`], ...conts.filter((x) => x.box !== 'LCL').map((x) => [x.id, `${SN.shipName(x)}`])];
    const cols = [...shown, { o: tyO, a: tyA, typical: true }];
    const at = (o) => (o.eta ? PL.addDays(o.eta, FC.DOOR_DAYS) : null);
    const cut = (o) => { if (!ci.ready) return o.cutoff ? short(o.cutoff) : '—'; if (!o.cutoff) return o.etd ? html`<span class="lr-c w">no cut-off given</span>` : html`<span class="lr-c w">sailing not given</span>`; const d = Math.round((Date.parse(o.cutoff) - Date.parse(ci.ready)) / 864e5); return html`${short(o.cutoff)} · ${d >= 0 ? html`<span class="lr-c ok">${d} day${d === 1 ? '' : 's'} after ready ✓</span>` : html`<span class="lr-c e">${-d} days before ready ✗</span>`}`; };
    const cell = (x, f) => (x.typical ? html`<td class="fc-ty">${f(x)}</td>` : html`<td class="${best && x.id === best.id && shown.length > 1 ? 'fc-best' : ''}">${f(x)}</td>`);
    const amt = (r) => (!r ? html`<span class="sub">—</span>` : r.amount == null ? html`<span class="fc-miss">${r.how === 'quoted_if' ? r.detail : 'unknown'}</span>` : html`<span class="${r.how === 'est' ? 'fc-est' : ''}" title="${r.detail}">${usd(r.amount)}</span>`);
    const always = types.filter((t) => (t.when_applies || 'always') === 'always');
    const ifs = types.filter((t) => t.when_applies === 'if_needed' && cols.some((x) => x.a.rows.some((r) => r.code === t.code)));
    const others = [...new Set(shown.flatMap((x) => x.a.other.map((y) => y.name)))];
    const fwds = await db.list('forwarders').catch(() => []);
    const emailOf = (o) => (fwds.find((f) => f.id === o.forwarder_id) || fwds.find((f) => o.company && String(f.company).toLowerCase() === String(o.company).toLowerCase()))?.email || '';
    const mailDlg = (x) => {
      if (!x.a.missing.length) return '';
      const o = x.o;
      const body = ['Hello,', '', `Thank you for your quotation${o.ref ? ` ${o.ref}` : ''} for 1 × ${BOXN[box]} ${o.pol ? portN(o.pol) : 'China'} → Los Angeles / Long Beach.`, '',
        `To compare it with other offers, could you please confirm these destination charges (USD) for delivery to ${to}:`, ...x.a.missing.map((m) => `  • ${m}`), '',
        'and any other charges that may apply (chassis split, pre-pull, storage, waiting time).', '', 'Thank you,', 'Lulyboo'].join('\n');
      return html`<dialog id="fc-mail-${o.id}" class="rp-modal hc-dlg" data-mail aria-labelledby="fc-mt-${o.id}"><form method="dialog"><h2 id="fc-mt-${o.id}">Ask ${o.company || 'the forwarder'} for the missing charges</h2>
        <label class="cu-mail-f">To<input type="email" value="${emailOf(o)}" placeholder="name@forwarder.com" data-hm="to"></label>
        <label class="cu-mail-f">Subject<input value="${`Destination charges — 1 × ${BOXN[box]} to LA/LB${o.ref ? ` (${o.ref})` : ''}`}" data-hm="subject"></label>
        <label class="cu-mail-f">Message<textarea rows="12" data-hm="body">${body}</textarea></label>
        <div class="hc-acts"><span class="sub">Opens in your mail app.</span><span class="r"><button type="button" class="btn ghost" data-close-dialog>Close</button><button type="button" class="btn ghost" data-hm-copy>Copy</button><button type="button" class="btn" data-hm-open>Open in mail</button></span></div></form></dialog>`;
    };
    const confirmed = (o) => !!(o.etd && o.eta);
    const rec = (() => {
      if (shown.length < 2 || !best) return null;
      const second = shown.filter((x) => x.id !== best.id).reduce((b, x) => (!b || x.a.total < b.a.total ? x : b), null);
      const diff = r2(second.a.total - best.a.total);
      const bits = [`<b>${best.o.company || 'This offer'} is ${usd(diff, 0)} cheaper all-in</b>`];
      if (confirmed(best.o)) bits.push(`with a dated sailing (${[best.o.carrier, `${short(best.o.etd)} → ${short(best.o.eta)}`].filter(Boolean).join(', ')})`);
      const fast = shown.filter((x) => x.o.eta).sort((a, b) => a.o.eta.localeCompare(b.o.eta))[0];
      const note = [];
      if (fast && fast.id !== best.id) note.push(`${fast.o.company} arrives first (${short(fast.o.eta)})`);
      if (!confirmed(best.o)) note.push('its sailing is not dated yet');
      if (best.a.missing.length) note.push(`${best.a.missing.length} of its charges are estimated — confirm before booking`);
      return raw(`${bits.join(' ')}.${note.length ? ` ${note.join('; ')}.` : ''}`);
    })();
    const fwOpts = [['', 'Forwarder (read from the file)'], ...fwds.map((f) => [f.id, f.company])];

    return html`<section class="card fc">
      <form method="get" action="${BASE}" class="fc-sel">
        <label><span class="lbl">Container</span>${ddSel('c', c?.id || '', contOpts)}</label>
        ${c ? html`<input type="hidden" name="box" value="${box}">` : html`<label><span class="lbl">Type</span>${ddSel('box', box, BOXES.filter((b) => b !== 'LCL').map((b) => [b, BOXN[b]]))}</label>`}
        <label><span class="lbl">HTS lines</span><input name="lines" type="number" min="1" max="40" value="${nLines}"></label>
        <label class="w2"><span class="lbl">Deliver to <em>drayage</em></span><input name="to" value="${to}"></label>
        <button class="btn ghost small">Update</button>
      </form>
      <div class="fc-h"><h2>Compare offers</h2><span class="lr-m">${box}</span><span class="sub">${c ? `${SN.shipName(c)}${ci.ready ? ` · cargo ready ${short(ci.ready)}` : ''}${ci.cbm ? ` · ${ci.cbm} CBM` : ''}` : `valid ${BOXN[box]} offers to LA/LB`} · ${nLines} HTS line${nLines === 1 ? '' : 's'}</span>
        <span class="r"><button type="button" class="btn small" data-open-dialog="fc-add">+ Add offer</button></span></div>
      ${(st.delivery_address || FC.DEFAULT_ADDRESS) !== to ? html`<form method="post" action="${BASE}/address" class="fc-addr"><input type="hidden" name="address" value="${to}"><span class="sub">Delivering to a different address than your default (${st.delivery_address || FC.DEFAULT_ADDRESS}).</span> <button class="link small">Make it the default</button></form>` : ''}
      ${shown.length ? html`<div class="table-wrap"><table class="fc-cmp"><thead><tr><th></th>${cols.map((x) => (x.typical ? html`<th class="fc-ty"><b>Your typical</b><div class="sub">median of ${x.o.n} quote${x.o.n === 1 ? '' : 's'} (90 days) · your charges</div></th>`
        : html`<th class="${best && x.id === best.id && shown.length > 1 ? 'fc-best' : ''}"><b>${x.o.company || 'Forwarder'}</b>${best && x.id === best.id && shown.length > 1 ? html` <span class="lr-c ok">best all-in</span>` : ''}${x.o.chosen ? html` <span class="lr-c v">chosen</span>` : ''}
            <div class="fc-qd">Quoted ${short(x.o.quoted_on)}${x.o.valid_until ? html` · <span class="${x.o.valid_until < today ? 'fc-up' : ''}">valid to ${short(x.o.valid_until)}</span>` : ' · no validity date'}</div>
            <div class="sub">${[x.o.source && x.o.source !== 'rfq' ? (x.o.source === 'email' ? 'Pasted email' : x.o.source === 'image' ? 'Screenshot' : 'PDF') : 'RFQ reply', x.o.ref].filter(Boolean).join(' · ')}</div></th>`))}</tr></thead><tbody>
        <tr class="grp"><td colspan="${cols.length + 1}">Schedule</td></tr>
        <tr><td class="k">Carrier · ETD → ETA</td>${cols.map((x) => cell(x, (y) => (y.typical ? '—' : html`${y.o.carrier || html`<span class="fc-est">carrier TBD</span>`}${y.o.etd || y.o.eta ? html` · ${short(y.o.etd) || '?'} → ${short(y.o.eta) || '?'}${y.o.transit_days ? ` · ${y.o.transit_days}d` : ''}` : ''}`)))}</tr>
        <tr><td class="k">Cut-off vs cargo ready</td>${cols.map((x) => cell(x, (y) => (y.typical ? '—' : cut(y.o))))}</tr>
        <tr><td class="k">At your warehouse</td>${cols.map((x) => cell(x, (y) => (y.typical ? '—' : at(y.o) ? html`<b>~${short(at(y.o))}</b> <span class="sub">ETA + ${FC.DOOR_DAYS} days</span>` : '—')))}</tr>
        ${cols.some((x) => x.o.delivery_to) ? html`<tr><td class="k">Drayage quoted to</td>${cols.map((x) => cell(x, (y) => (y.typical || !y.o.delivery_to ? '—' : html`<span class="${!to.toLowerCase().includes(String(y.o.delivery_to).toLowerCase().split(/[ ,]/)[0]) ? 'fc-est' : ''}">${y.o.delivery_to}</span>`)))}</tr>` : ''}
        <tr class="grp"><td colspan="${cols.length + 1}">Ocean</td></tr>
        <tr><td class="k">Ocean freight</td>${cols.map((x) => cell(x, (y) => html`<span class="m">${usd(y.a.ocean)}</span>`))}</tr>
        <tr class="grp"><td colspan="${cols.length + 1}">Destination — always</td></tr>
        ${always.map((t) => html`<tr><td class="k">${tipName(t)}${t.unit === 'line' ? html` <span class="sub">× ${nLines}</span>` : t.unit === 'pct_drayage' ? html` <span class="sub">% of drayage</span>` : t.unit === 'day' && t.min_qty ? html` <span class="sub">min ${t.min_qty} days</span>` : ''}</td>${cols.map((x) => cell(x, (y) => amt(y.a.rows.find((r) => r.code === t.code))))}</tr>`)}
        ${others.length ? html`<tr class="grp"><td colspan="${cols.length + 1}">Other quoted charges</td></tr>${others.map((n) => html`<tr><td class="k">${n} <a class="sub" href="${BASE}?tab=charges&add=${encodeURIComponent(n)}#new">add to charges</a></td>${cols.map((x) => cell(x, (y) => { const v = y.a.other.find((z) => z.name === n); return v ? usd(v.amount) : html`<span class="sub">—</span>`; }))}</tr>`)}` : ''}
        ${ifs.length ? html`<tr class="grp"><td colspan="${cols.length + 1}">If needed${Object.values(typ).some((v) => v.freq != null) ? ' — expected from your invoices' : ' — not in the total until you have 3+ invoiced containers'}</td></tr>
          ${ifs.map((t) => html`<tr><td class="k">${tipName(t)}${typ[t.code]?.freq != null ? html` <span class="sub">on ${Math.round(typ[t.code].freq * 100)}% of containers</span>` : ''}</td>${cols.map((x) => cell(x, (y) => { const r = y.a.rows.find((z) => z.code === t.code); return !r ? html`<span class="sub">—</span>` : r.how === 'expected' ? html`<span title="${r.detail}">${usd(r.amount)}</span> <span class="sub">${r.detail}</span>` : html`<span class="sub">${r.detail}</span>`; }))}</tr>`)}` : ''}
        <tr class="tot"><td>All-in per container</td>${cols.map((x) => cell(x, (y) => html`<span class="m">${usd(y.a.total)}</span>${y.a.unknown.length ? html`<div class="fc-miss">+ ${y.a.unknown.length} unknown</div>` : ''}`))}</tr>
        ${ci.cbm ? html`<tr><td class="k">per CBM · vs typical</td>${cols.map((x) => cell(x, (y) => html`${usd(y.a.total / ci.cbm)}${!y.typical && tyA.total ? html` · <span class="${y.a.total <= tyA.total ? 'fc-dn' : 'fc-up'}">${y.a.total <= tyA.total ? '−' : '+'}${Math.abs(Math.round(((y.a.total - tyA.total) / tyA.total) * 1000) / 10)}%</span>` : ''}`))}</tr>`
          : html`<tr><td class="k">vs typical</td>${cols.map((x) => cell(x, (y) => (y.typical || !tyA.total ? '' : html`<span class="${y.a.total <= tyA.total ? 'fc-dn' : 'fc-up'}">${y.a.total <= tyA.total ? '−' : '+'}${usd(Math.abs(y.a.total - tyA.total), 0)}</span>`)))}</tr>`}
        <tr class="fc-acts"><td></td>${cols.map((x) => cell(x, (y) => (y.typical ? '' : html`${(y.o.files || []).length ? html`<a class="btn ghost small" href="${BASE}/offers/${y.o.id}/files/0" data-preview="${BASE}/offers/${y.o.id}/files/0?inline=1" data-type="${/image\//.test(y.o.files[0].type || '') ? 'image' : 'doc'}" data-dl="${BASE}/offers/${y.o.id}/files/0">Open</a>` : ''}
          ${y.a.missing.length ? html`<button type="button" class="btn ghost small" data-open-dialog="fc-mail-${y.o.id}">Ask for ${y.a.missing.length} missing</button>` : ''}
          ${y.o.chosen ? html`<form method="post" action="${BASE}/offers/${y.o.id}/unchoose" class="inline"><input type="hidden" name="c" value="${c?.id || ''}"><button class="btn ghost small" title="Undo the choice">Unchoose</button></form>`
            : html`<form method="post" action="${BASE}/offers/${y.o.id}/choose" class="inline"><input type="hidden" name="c" value="${c?.id || ''}"><button class="btn small">Choose</button></form>`}
          <form method="post" action="${BASE}/offers/${y.o.id}/exclude" class="inline"><input type="hidden" name="c" value="${c?.id || ''}"><button class="link small" title="Take it out of this comparison — nothing is deleted, you can show it again below">Hide</button></form>`)))}</tr>
      </tbody></table></div>
      ${shown.some((x) => x.a.missing.length) ? html`<div class="fc-note">⚠ Amounts in amber were not quoted and are estimated from your typical (other quotes, then your invoices). Hover a figure to see how it was worked out.</div>` : ''}
      ${rec ? html`<div class="fc-rec">✓ <span>${rec}</span></div>` : ''}
      ${list.length > 4 ? html`<p class="sub">${list.length - 4} more offer${list.length - 4 === 1 ? '' : 's'} — hide some to compare them.</p>` : ''}
      ${hidden.length ? html`<div class="fc-hid"><span class="sub">Hidden:</span> ${hidden.map((o) => html`<form method="post" action="${BASE}/offers/${o.id}/include" class="inline"><input type="hidden" name="c" value="${c?.id || ''}"><span>${o.company || 'Forwarder'} · ${short(o.quoted_on)}${o.ocean_usd != null ? ` · ${usd(o.ocean_usd, 0)}` : ''}</span> <button class="link small">show</button></form>`)}</div>` : ''}`
      : html`<p class="sub fc-empty">No offers for ${BOXN[box]}${c ? ' on this container' : ''} yet. Add one from a PDF, a screenshot or a pasted email — or ask forwarders from <a href="/admin/logistics/planning/load">Load containers</a>.</p>`}
    </section>
    ${shown.map(mailDlg)}
    <dialog id="fc-add" class="rp-modal lr-dlg" aria-labelledby="fc-add-t"><form method="post" action="${BASE}/offers" enctype="multipart/form-data" data-busy>
      <h2 id="fc-add-t">Add an offer</h2><p class="sub">AI reads the ocean rate, schedule, validity and every charge line. Nothing is sent.</p>
      <div class="fc-mailin">✉ Or forward the quote email to <b>${require('../quotes').quoteAddress()}</b> <button type="button" class="link small" data-copy-text="${require('../quotes').quoteAddress()}">copy</button> — it appears here as an offer (attachments and the email text are read).</div>
      <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" title="" aria-label="Offer file"><span class="dz-main" data-main>Drop the PDF or screenshot here, paste (⌘V) or <u>choose</u></span><span class="dz-hint">quotation PDF · email screenshot</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
      <label class="fc-f"><span class="lbl">…or paste the email text</span><textarea name="text" rows="5" placeholder="Carrier: ONE - $5850 · ETD Dec 4 · ETA Dec 18 · ISF $50 …"></textarea></label>
      <div class="lr-g"><label><span class="lbl">Forwarder</span>${ddSel('forwarder', '', fwOpts)}</label><label><span class="lbl">For</span>${ddSel('c', c?.id || '', contOpts)}</label></div>
      <input type="hidden" name="box" value="${box}">
      <div class="lr-acts"><span class="r"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn" ${AI.enabled() ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Read offer</button></span></div></form></dialog>`;
  }

  // ── Charges ───────────────────────────────────────────────────────────────
  async function charges(req, { types, typ }) {
    const unitOpts = Object.entries(FC.UNITS); const grpOpts = Object.entries(FC.GROUPS).filter(([k]) => k !== 'ocean'); const whenOpts = Object.entries(FC.WHEN);
    const form = (t) => html`<div class="lr-g">
      <label class="w2"><span class="lbl">Name</span><input name="name" value="${t.name || ''}" required></label>
      <label><span class="lbl">Group</span>${ddSel('grp', t.grp || 'trucking', grpOpts)}</label><label><span class="lbl">When</span>${ddSel('when', t.when_applies || 'always', whenOpts)}</label>
      <label><span class="lbl">Unit</span>${ddSel('unit', t.unit || 'container', unitOpts)}</label><label><span class="lbl">Default rate <em>when no quotes</em></span><span class="inp-unit"><input name="rate" type="number" step="0.01" min="0" value="${t.rate_usd ?? ''}"><i>${t.unit === 'pct_drayage' ? '%' : 'USD'}</i></span></label>
      <label><span class="lbl">Minimum qty</span><input name="min" type="number" step="0.5" min="0" value="${t.min_qty ?? ''}" placeholder="e.g. 2 days"></label><label><span class="lbl">Free qty</span><input name="free" type="number" step="0.5" min="0" value="${t.free_qty ?? ''}" placeholder="e.g. 2 hours"></label>
      <label class="w2"><span class="lbl">Other names <em>on quotes and invoices, comma-separated</em></span><input name="aliases" value="${(t.aliases || []).join(', ')}"></label>
      <label class="w2"><span class="lbl">Internal note <em>what it is · when it applies · how to keep it low</em></span><textarea name="note" rows="5">${t.note || ''}</textarea></label></div>`;
    const mk = (t) => (t.market && t.market.at ? (t.market.found ? `${t.market.low != null ? usd(t.market.low, t.market.low < 100 ? 2 : 0) : ''}${t.market.high != null ? `–${usd(t.market.high, t.market.high < 100 ? 2 : 0)}` : ''} · ${short(t.market.at)}` : `not published · ${short(t.market.at)}`) : 'never');
    const stale = types.filter((t) => !t.market?.at || t.market.at < PL.addDays(PL.today(), -30)).length;
    const row = (t) => { const y = typ[t.code] || {}; const op = raw(`data-open-dialog="ch-${t.id}"`);
      return html`<tr><td ${op}><b>${t.name}</b><div class="sub">${FC.GROUPS[t.grp] || ''}</div></td><td ${op}>${FC.UNITS[t.unit] || t.unit}${t.min_qty ? ` · min ${t.min_qty}` : ''}${t.free_qty ? ` · ${t.free_qty} free` : ''}</td>
        <td ${op}><span class="lr-c ${t.when_applies === 'if_needed' ? 'w' : ''}">${FC.WHEN[t.when_applies] || 'always'}${t.when_applies === 'if_needed' && y.freq != null ? ` · ${Math.round(y.freq * 100)}%` : ''}</span></td>
        <td ${op} class="r">${y.rate != null ? (t.unit === 'pct_drayage' ? `${r2(y.rate)}%` : usd(y.rate)) : '—'}<div class="sub">${y.rateFrom === 'quotes' ? `${y.nQuoted} quote${y.nQuoted === 1 ? '' : 's'}` : y.rateFrom || ''}</div></td>
        <td ${op} class="r">${y.low != null ? ((f) => (y.low === y.high ? f(y.low) : `${f(y.low)}–${f(y.high)}`))(t.unit === 'pct_drayage' ? (v) => `${r2(v)}%` : (v) => usd(v)) : '—'}</td>
        <td ${op} class="r">${y.actual != null ? usd(y.actual) : '—'}<div class="sub">${y.nActual ? `${y.nActual} container${y.nActual === 1 ? '' : 's'}` : ''}</div></td>
        <td ${op} class="sub">${mk(t)}</td><td class="r"><button type="button" class="lr-dots" data-open-dialog="ch-${t.id}" aria-label="${`Edit ${t.name}`}">⋯</button></td></tr>`; };
    const dlg = (t) => html`<dialog id="ch-${t.id}" class="rp-modal lr-dlg" aria-labelledby="ch-t-${t.id}"><form method="post" action="${BASE}/charges/${t.id}" data-busy>
      <h2 id="ch-t-${t.id}">${t.name} <span class="lr-c">${FC.WHEN[t.when_applies] || 'always'}</span>${t.note_draft ? html` <span class="lr-c v">draft note — edit</span>` : ''}</h2>
      ${t.market?.at ? html`<div class="lr-qbox"><b>Market check ${short(t.market.at)}:</b> ${t.market.summary}${(t.market.sources || []).length ? html` <span class="sub">${t.market.sources.slice(0, 3).map((s, i) => html`${i ? ' · ' : ''}<a href="${s.url}" target="_blank" rel="noopener">${String(s.title).slice(0, 40)}</a>`)}</span>` : ''}</div>` : ''}
      ${form(t)}
      <div class="lr-acts" data-armbox>${AI.enabled() ? html`<button class="btn ghost small" formaction="${BASE}/charges/${t.id}/note" formnovalidate>✦ Draft note with AI</button><button class="btn ghost small" formaction="${BASE}/charges/${t.id}/market" formnovalidate>Check market price (web)</button>` : ''}
        <span class="r"><button type="button" class="bd-del lr-del" data-arm>Delete</button><button type="submit" class="bd-yes" form="ch-del-${t.id}">✓ Delete charge</button><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save</button></span></div>
    </form></dialog><form id="ch-del-${t.id}" method="post" action="${BASE}/charges/${t.id}/delete" hidden></form>`;
    const addName = String(req.query.add || '').slice(0, 60);
    return html`<section class="card fc"><div class="fc-h"><h2>Charges</h2><span class="sub">${types.length} charges · typical from your quotes (last 12 months) and freight invoices</span>
        <span class="r">${AI.enabled() && stale ? html`<form method="post" action="${BASE}/charges/market-all" data-busy class="inline"><button class="btn ghost small">Check market prices (AI) · ${Math.min(6, stale)}</button></form>` : ''}<button type="button" class="btn small" data-open-dialog="ch-new">+ Add charge</button></span></div>
      <div class="table-wrap"><table class="list lr-t"><thead><tr><th>Charge</th><th>Unit</th><th>When</th><th class="r">Typical rate</th><th class="r">Range quoted</th><th class="r">Actual / container</th><th>Market check</th><th></th></tr></thead>
      <tbody>${types.map(row)}</tbody></table></div>
      <p class="sub">“If needed” charges count in the comparison as amount × how often they appeared on your invoices (once 3+ containers have invoices). Click a charge for its internal note.</p></section>
      ${types.map(dlg)}
      <dialog id="ch-new" class="rp-modal lr-dlg" ${addName ? raw('data-autoopen') : ''} aria-labelledby="ch-new-t"><form method="post" action="${BASE}/charges/new" data-busy><h2 id="ch-new-t">Add a charge</h2>${form({ name: addName, aliases: addName ? [addName.toLowerCase()] : [] })}
        <div class="lr-acts"><span class="r"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Add charge</button></span></div></form></dialog>`;
  }

  // ── Actual costs ──────────────────────────────────────────────────────────
  async function actualsTab(req, { types, acts }) {
    const conts = await db.list('plan_containers').catch(() => []);
    const SN = require('../shipname');
    const byC = new Map(); for (const a of acts) byC.set(a.container_id, [...(byC.get(a.container_id) || []), a]);
    const tName = (code) => types.find((t) => t.code === code)?.name;
    const groups = [...byC].map(([cid, list]) => ({ cid, list, c: conts.find((x) => x.id === cid), total: r2(list.reduce((s, a) => s + a.total, 0)), date: list.map((a) => a.date).filter(Boolean).sort().pop() })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const contOpts = [['', 'Choose the shipment'], ...conts.filter((x) => x.status === 'shipped' || x.record_only || x.status === 'booked').map((x) => [x.id, SN.shipName(x)])];
    return html`<section class="card fc"><div class="fc-h"><h2>Actual costs</h2><span class="sub">freight invoices, split into your charges · from record documents and invoices added here</span>
        <span class="r"><button type="button" class="btn small" data-open-dialog="fa-add">+ Add invoice</button></span></div>
      ${groups.length ? groups.map((g) => html`<div class="fa-c"><div class="fa-h"><b>${g.c ? html`<a href="/admin/orders/shipments/${g.cid}">${SN.shipName(g.c)}</a>` : 'Shipment'}</b>${g.c?.box ? html` <span class="lr-m">${g.c.box}</span>` : ''}<span class="sub">${short(g.date)}</span><span class="r fa-t">${usd(g.total)}</span></div>
          ${g.list.map((a) => html`<div class="fa-i"><div class="sub">${[a.company, a.invoice_no ? `Invoice ${a.invoice_no}` : '', a.src === 'record' ? 'from the record' : 'added here'].filter(Boolean).join(' · ')}${a.id && a.file ? html` · <a href="${BASE}/actuals/${a.id}/files/0" data-preview="${BASE}/actuals/${a.id}/files/0?inline=1" data-type="${/image\//.test(a.file.type || '') ? 'image' : 'doc'}" data-dl="${BASE}/actuals/${a.id}/files/0">Open</a>` : a.src === 'record' && a.container_id ? html` · <a href="/admin/orders/shipments/${a.container_id}#docs">Open in record</a>` : ''}${a.id ? html` · <form method="post" action="${BASE}/actuals/${a.id}/delete" class="inline" data-confirm="Remove this invoice?"><button class="link small">remove</button></form>` : ''}</div>
            <div class="fa-ls">${a.lines.map((l) => html`<span class="fa-l ${l.ocean ? 'oc' : l.type ? '' : 'un'}" title="${l.type ? tName(l.type) : l.ocean ? 'Ocean freight' : 'Not in your charges'}">${l.name} <b>${usd(l.usd)}</b>${!l.ocean && !l.type ? html` <a href="${BASE}?tab=charges&add=${encodeURIComponent(l.name)}#new">+ add</a>` : ''}</span>`)}</div></div>`)}</div>`)
        : html`<p class="sub fc-empty">No freight invoices yet. Invoices dropped on a record-only shipment are read automatically; add others here.</p>`}
    </section>
    <dialog id="fa-add" class="rp-modal lr-dlg" aria-labelledby="fa-add-t"><form method="post" action="${BASE}/actuals" enctype="multipart/form-data" data-busy><h2 id="fa-add-t">Add a freight invoice</h2><p class="sub">AI reads the charge lines and matches them to your charges.</p>
      <label><span class="lbl">Shipment</span>${ddSel('c', '', contOpts)}</label>
      <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp" required title="" aria-label="Invoice file"><span class="dz-main" data-main>Drop the invoice here, paste (⌘V) or <u>choose</u></span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
      <div class="lr-acts"><span class="r"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn" ${AI.enabled() ? '' : raw('disabled')}>Read invoice</button></span></div></form></dialog>`;
  }

  // ── Overview ──────────────────────────────────────────────────────────────
  async function overview(req, { types, offers, acts, typ }) {
    const box = BOXES.includes(req.query.box) ? req.query.box : '40HQ';
    const months = FC.lastMonths(Number(req.query.m) === 6 ? 6 : 12);
    const conts = await db.list('plan_containers').catch(() => []);
    const ma = FC.monthlyAllIn(acts, offers.filter((o) => !o.excluded), types, typ, box, months);
    const ob = FC.oceanByForwarder(offers, box, months);
    const ex = FC.extrasTop(acts, types, months.slice(-6));
    const ft = FC.forwarderTable(offers.filter((o) => String(o.quoted_on) >= months[0]), acts, types, typ, conts, box);
    const maxEx = Math.max(1, ...ex.list.map((x) => x.v));
    return html`<div class="fc-bx">${BOXES.filter((b) => b !== 'LCL').map((b) => html`<a class="${b === box ? 'on' : ''}" href="${BASE}?tab=overview&box=${b}">${BOXN[b]}</a>`)}<span class="sub">to LA / Long Beach · last 12 months</span></div>
    <div class="fc-g3">
      <section class="card"><div class="fc-h"><h3>All-in per container, by month</h3><span class="r sub">invoices · pale = chosen quote only</span></div>${stackChart(ma)}
        <div class="fc-leg">${Object.entries(COLS).map(([k, c]) => html`<span><i style="${`background:${c}`}"></i>${FC.GROUPS[k]}</span>`)}</div></section>
      <section class="card"><div class="fc-h"><h3>Ocean ${BOXN[box]} by forwarder</h3><span class="r sub">quoted · median per month</span></div>${lineChart(ob, months)}
        <div class="fc-leg">${ob.map((s, i) => html`<span><i style="${`background:${LINE[i % LINE.length]}`}"></i>${s.company} · ${s.n}</span>`)}</div></section>
      <section class="card"><div class="fc-h"><h3>Extras, last 6 months</h3><span class="r sub">actual, from invoices</span></div>
        ${ex.list.length ? html`<table class="fc-ex">${ex.list.slice(0, 7).map((x) => html`<tr><td>${x.name}</td><td class="fc-bar"><i style="${`width:${Math.round((x.v / maxEx) * 100)}%`}"></i></td><td class="r">${usd(x.v, 0)}</td></tr>`)}</table>
          <p class="sub">${usd(ex.sum, 0)} extras on ${ex.n} container${ex.n === 1 ? '' : 's'} = <b>${usd(ex.per, 0)} per container</b> on top of the quote</p>` : html`<p class="sub">No “if needed” charges on your invoices yet.</p>`}</section>
    </div>
    <section class="card"><div class="fc-h"><h3>Forwarders</h3><span class="r sub">${BOXN[box]} · last 12 months · all-in quoted uses your charges for anything not quoted</span></div>
      ${ft.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>Forwarder</th><th class="r">Quotes</th><th class="r">Booked</th><th class="r">Avg ocean</th><th class="r">Avg all-in quoted</th><th class="r">Avg actual</th><th class="r">Actual vs quote</th><th class="r">Reply time</th><th class="r">On-time ETA</th></tr></thead><tbody>
        ${ft.map((f, i) => html`<tr><td><i class="fc-dot" style="${`background:${LINE[ob.findIndex((s) => s.company === f.company) >= 0 ? ob.findIndex((s) => s.company === f.company) : i] || '#999'}`}"></i><b>${f.company}</b></td><td class="r">${f.quotes}</td><td class="r">${f.booked}</td><td class="r">${usd(f.oceanAvg, 0)}</td><td class="r">${usd(f.allinAvg, 0)}</td><td class="r">${usd(f.actualAvg, 0)}</td>
          <td class="r">${f.variance != null ? html`<span class="lr-c ${f.variance > 3 ? 'e' : f.variance > 0 ? 'w' : 'ok'}">${f.variance > 0 ? '+' : ''}${f.variance}%</span>` : '—'}</td><td class="r">${f.replyMed != null ? (f.replyMed < 24 ? `${Math.round(f.replyMed)} h` : `${Math.round(f.replyMed / 24)} d`) : '—'}</td><td class="r">${f.withAta ? `${f.onTime} / ${f.withAta}` : '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="sub">No quotes yet.</p>`}
    </section>`;
  }

  // ── actions ───────────────────────────────────────────────────────────────
  const back = (res, c, box) => res.redirect(`${BASE}${c ? `?c=${encodeURIComponent(c)}` : box ? `?box=${box}` : ''}`);

  router.post(`${BASE}/address`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const st = (await db.list('settings', { limit: 1 }).catch(() => []))[0];
    await db.update('settings', { id: st?.id ?? 1 }, { delivery_address: String(f.address || '').trim().slice(0, 200) || null }).catch(() => null);
    flash(res, 'ok', 'Default delivery address saved'); res.redirect(BASE);
  }));

  router.post(`${BASE}/offers`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 30 * 1024 * 1024 });
    const ups = [].concat(files.file || []).filter((x) => x && x.buffer?.length);
    if (!ups.length && !String(f.text || '').trim()) { flash(res, 'error', 'Drop a file or paste the email'); return back(res, f.c, f.box); }
    const c = f.c ? await db.get('plan_containers', f.c).catch(() => null) : null;
    let o;
    try { o = await FC.readOffer({ files: ups.map((u) => ({ name: u.filename || u.name, type: u.contentType || u.type, buffer: u.buffer })), text: f.text, box: c?.box || f.box }); }
    catch (e) { flash(res, 'error', `Couldn't read the offer: ${String(e.message).slice(0, 160)}`); return back(res, f.c, f.box); }
    const fw = f.forwarder ? await db.get('forwarders', f.forwarder).catch(() => null) : null;
    let row;
    const src = ups.length ? (ups.some((u) => /pdf/i.test(`${u.type || ''} ${u.name || ''}`)) ? 'pdf' : 'image') : 'email';
    try { row = await FC.saveOffer(db, o, { files: ups.map((u) => ({ name: u.filename || u.name, type: u.contentType || u.type, buffer: u.buffer })), container: c, forwarder: fw, source: src }); }
    catch (e) { flash(res, 'error', FC.missingTable(e) ? 'Run supabase/freight-costs.sql in Supabase first.' : `Couldn't save: ${e.message}`); return back(res, f.c, c?.box || o.box); }
    flash(res, 'ok', `${row.company}: ${o.ocean_usd != null ? usd(o.ocean_usd, 0) : 'no ocean rate found'} ocean + ${o.charges.length} charge line${o.charges.length === 1 ? '' : 's'} read`);
    res.redirect(`${BASE}${c ? `?c=${c.id}` : `?box=${row.box}`}`);
  }));

  // a stored file, shown in the page's preview (same-origin frame allowed, like the other document links) or downloaded
  async function sendFile(req, res, x) {
    if (!x) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(x.path);
    const type = x.type || (/\.pdf$/i.test(x.name) ? 'application/pdf' : 'application/octet-stream');
    const inline = !!req.query.inline && /pdf|image\//.test(type);
    const head = { 'Content-Type': type, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(x.name).replace(/[^\w.\- ]+/g, '_')}"`, 'Cache-Control': 'private, max-age=300' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    for (const [k, v] of Object.entries(head)) res.setHeader(k, v);
    res.end(buf);
  }
  router.get(`${BASE}/offers/:id/files/:i`, G(async (req, res) => {
    const o = await db.get('freight_quotes', req.params.id).catch(() => null);
    await sendFile(req, res, (o?.files || [])[Number(req.params.i)]);
  }));
  router.get(`${BASE}/actuals/:id/files/:i`, G(async (req, res) => {
    const a = await db.get('freight_actuals', req.params.id).catch(() => null);
    await sendFile(req, res, (a?.files || [])[Number(req.params.i)]);
  }));

  router.post(`${BASE}/offers/:id/choose`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const o = await db.get('freight_quotes', req.params.id).catch(() => null); if (!o) throw new HttpError(404, 'Offer not found');
    const cid = o.container_id || f.c || null;
    if (o.quote_id) {
      const q = await db.get('plan_quotes', o.quote_id).catch(() => null);
      if (q) { for (const x of await db.list('plan_quotes', { filters: { container_id: q.container_id } })) if (x.id !== q.id && x.status === 'chosen') await db.update('plan_quotes', { id: x.id }, { status: x.replied_at ? 'replied' : 'sent', updated_at: now() }); await db.update('plan_quotes', { id: q.id }, { status: 'chosen', updated_at: now() }); await RH.syncContainer(db, q.container_id); }
    }
    if (cid) for (const x of await db.list('freight_quotes', { filters: { container_id: cid } }).catch(() => [])) if (x.id !== o.id && x.chosen && !x.quote_id) await db.update('freight_quotes', { id: x.id }, { chosen: false, updated_at: now() });
    await db.update('freight_quotes', { id: o.id }, { chosen: true, container_id: cid, updated_at: now() });
    flash(res, 'ok', `${o.company} chosen${cid ? ' for this container' : ''}`); back(res, cid, o.box);
  }));

  router.post(`${BASE}/offers/:id/exclude`, G(async (req, res) => {
    const { fields: f } = await parseForm(req).catch(() => ({ fields: {} }));
    const o = await db.get('freight_quotes', req.params.id).catch(() => null); if (!o) throw new HttpError(404, 'Offer not found');
    await db.update('freight_quotes', { id: o.id }, { excluded: true, updated_at: now() });
    flash(res, 'ok', `${o.company} (${short(o.quoted_on)}) hidden — “show” at the bottom brings it back`); back(res, f.c || o.container_id, o.box);
  }));
  router.post(`${BASE}/offers/:id/include`, G(async (req, res) => {
    const { fields: f } = await parseForm(req).catch(() => ({ fields: {} }));
    const o = await db.get('freight_quotes', req.params.id).catch(() => null); if (!o) throw new HttpError(404, 'Offer not found');
    await db.update('freight_quotes', { id: o.id }, { excluded: false, updated_at: now() });
    flash(res, 'ok', `${o.company} (${short(o.quoted_on)}) is back in the comparison`); back(res, f.c || o.container_id, o.box);
  }));
  router.post(`${BASE}/offers/:id/unchoose`, G(async (req, res) => {
    const { fields: f } = await parseForm(req).catch(() => ({ fields: {} }));
    const o = await db.get('freight_quotes', req.params.id).catch(() => null); if (!o) throw new HttpError(404, 'Offer not found');
    if (o.quote_id) { const q = await db.get('plan_quotes', o.quote_id).catch(() => null); if (q && q.status === 'chosen') { await db.update('plan_quotes', { id: q.id }, { status: q.replied_at ? 'replied' : 'sent', updated_at: now() }); await RH.syncContainer(db, q.container_id); } }
    await db.update('freight_quotes', { id: o.id }, { chosen: false, updated_at: now() });
    flash(res, 'ok', `${o.company} is no longer the chosen offer`); back(res, f.c || o.container_id, o.box);
  }));

  // charges
  const chPatch = (f) => ({ name: String(f.name || '').trim().slice(0, 60) || 'Charge', grp: FC.GROUPS[f.grp] ? f.grp : 'trucking', unit: FC.UNITS[f.unit] ? f.unit : 'container', when_applies: FC.WHEN[f.when] ? f.when : 'always',
    rate_usd: num(f.rate), min_qty: num(f.min), free_qty: num(f.free), aliases: String(f.aliases || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 12), note: String(f.note || '').trim().slice(0, 1500) || null });
  const getT = async (id) => { const t = await db.get('charge_types', id).catch(() => null); if (!t) throw new HttpError(404, 'Charge not found'); return t; };
  router.post(`${BASE}/charges/new`, G(async (req, res) => {
    const { fields: f } = await parseForm(req); const p = chPatch(f);
    const n = (await db.list('charge_types').catch(() => [])).length;
    await db.insert('charge_types', { ...p, code: `c${Date.now().toString(36)}`, sort: n + 1, note_draft: false, created_at: now() });
    flash(res, 'ok', `${p.name} added`); res.redirect(`${BASE}?tab=charges`);
  }));
  router.post(`${BASE}/charges/market-all`, G(async (req, res) => {
    if (!AI.enabled()) throw new HttpError(400, 'AI is off');
    const { rows } = await FC.catalog(db);
    const todo = rows.filter((t) => !t.market?.at || t.market.at < PL.addDays(PL.today(), -30)).slice(0, 6);
    const out = await Promise.all(todo.map(async (t) => { try { const m = await FC.marketCheck(t); await db.update('charge_types', { id: t.id }, { market: m }); return `${t.name}: ${m.found ? `${m.low ?? '?'}–${m.high ?? '?'}` : 'not published'}`; } catch (e) { return `${t.name}: failed`; } }));
    flash(res, 'ok', `Market check — ${out.join(' · ')}`); res.redirect(`${BASE}?tab=charges`);
  }));
  router.post(`${BASE}/charges/:id`, G(async (req, res) => {
    const { fields: f } = await parseForm(req); const t = await getT(req.params.id); const p = chPatch(f);
    await db.update('charge_types', { id: t.id }, { ...p, note_draft: t.note_draft && p.note === t.note });
    flash(res, 'ok', `${p.name} saved`); res.redirect(`${BASE}?tab=charges`);
  }));
  router.post(`${BASE}/charges/:id/note`, G(async (req, res) => {
    await parseForm(req).catch(() => null); const t = await getT(req.params.id);
    try { const d = await FC.draftNote(t); await db.update('charge_types', { id: t.id }, { note: d.note, note_draft: true, aliases: [...new Set([...(t.aliases || []), ...d.aliases])].slice(0, 12) }); flash(res, 'ok', `${t.name}: note drafted — check it`); }
    catch (e) { flash(res, 'error', `Couldn't draft: ${String(e.message).slice(0, 120)}`); }
    res.redirect(`${BASE}?tab=charges`);
  }));
  router.post(`${BASE}/charges/:id/market`, G(async (req, res) => {
    await parseForm(req).catch(() => null); const t = await getT(req.params.id);
    try { const m = await FC.marketCheck(t); await db.update('charge_types', { id: t.id }, { market: m }); flash(res, 'ok', `${t.name}: ${m.summary}`); }
    catch (e) { flash(res, 'error', `Market check failed: ${String(e.message).slice(0, 140)}`); }
    res.redirect(`${BASE}?tab=charges`);
  }));
  router.post(`${BASE}/charges/:id/explain`, G(async (req, res) => {
    const t = await getT(req.params.id);
    if (t.note) return res.json({ note: t.note, saved: true });
    if (!AI.enabled()) return res.json({ note: 'No explanation yet — add one under Charges.', saved: false });
    try {
      const d = await FC.draftNote(t);
      await db.update('charge_types', { id: t.id }, { note: d.note, note_draft: true, aliases: [...new Set([...(t.aliases || []), ...d.aliases])].slice(0, 12) });
      return res.json({ note: d.note, saved: true, ai: true });
    } catch (e) { return res.json({ note: `Couldn't get an explanation right now (${String(e.message).slice(0, 80)}).`, saved: false }); }
  }));
  router.post(`${BASE}/charges/:id/delete`, G(async (req, res) => {
    const t = await getT(req.params.id); await db.remove('charge_types', { id: t.id });
    flash(res, 'ok', `${t.name} deleted`); res.redirect(`${BASE}?tab=charges`);
  }));

  // actual costs
  router.post(`${BASE}/actuals`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 30 * 1024 * 1024 });
    const u = [].concat(files.file || [])[0]; if (!u?.buffer?.length) throw new HttpError(400, 'Choose the invoice');
    const c = f.c ? await db.get('plan_containers', f.c).catch(() => null) : null;
    const name = u.filename || u.name || 'invoice.pdf';
    let ai;
    try { ai = await require('../record-docs').readFile({ name, type: u.contentType || u.type, buffer: u.buffer }); }
    catch (e) { flash(res, 'error', `Couldn't read it: ${String(e.message).slice(0, 140)}`); return res.redirect(`${BASE}?tab=actuals`); }
    const fx = ai.facts || {};
    const lines = [...(fx.ocean_usd ? [{ name: 'Ocean freight', usd: fx.ocean_usd, ocean: true }] : []), ...(fx.charges || []).map((l) => ({ name: l.name, usd: l.usd }))];
    const path = `freight-actuals/${Date.now().toString(36)}-${String(name).replace(/[^\w.\-]+/g, '_').slice(-80)}`;
    await db.docs.upload(path, u.buffer, u.contentType || u.type || 'application/octet-stream').catch(() => null);
    try { await db.insert('freight_actuals', { container_id: c?.id || null, box: c?.box || null, label: c ? null : name, company: fx.issuer || null, invoice_no: fx.doc_no || null, invoice_date: fx.due_date || PL.today(), lines, files: [{ name, path, type: u.contentType || u.type || '' }], created_by: ST.current()?.name || null, created_at: now() }); }
    catch (e) { flash(res, 'error', FC.missingTable(e) ? 'Run supabase/freight-costs.sql in Supabase first.' : e.message); return res.redirect(`${BASE}?tab=actuals`); }
    flash(res, lines.length ? 'ok' : 'warn', lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'} read · ${usd(lines.reduce((s, l) => s + (Number(l.usd) || 0), 0))}` : `Read as ${ai.label}, but no charge lines found`);
    res.redirect(`${BASE}?tab=actuals`);
  }));
  router.post(`${BASE}/actuals/:id/delete`, G(async (req, res) => {
    await db.remove('freight_actuals', { id: req.params.id }).catch(() => null);
    flash(res, 'ok', 'Invoice removed'); res.redirect(`${BASE}?tab=actuals`);
  }));
};
module.exports.subTabs = subTabs;
