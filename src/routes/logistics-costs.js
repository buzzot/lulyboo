'use strict';
// Logistics → Costs & rates: the freight rates every product's landed cost uses, as one compact table.
//   Each rate is compared with your real forwarder quotes (Rate history: same container type, to LA / Long Beach,
//   last 90 days, ocean line only) and with the last market check. Click a row → a dialog edits that one rate.
//   Every rate change is logged on the option (rate_log: who, when, from quote / market / manual).
//   Quick calculator: any carton, nothing saved.

const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const F = require('../fields');
const { MODES, analyzeProduct } = require('../calc');
const S = require('../services');
const Freight = require('../freight');
const AI = require('../ai');
const RH = require('../rate-history');
const ST = require('../staff');
const PL = require('../planning');

const num = (v) => { const n = F.parseNumber(v); return Number.isNaN(n) ? null : n; };
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
const usd = (v, d = 0) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const short = (d) => (d ? PL.short(String(d).slice(0, 10)) : '');
const UNIT = { FCL_20GP: '/ctr', FCL_40GP: '/ctr', FCL_40HQ: '/ctr', LCL: '/W/M', AIR: '/kg', EXPRESS: '/kg' };
const CHIP = { FCL_20GP: ['20GP', ''], FCL_40GP: ['40GP', ''], FCL_40HQ: ['40HQ', ''], LCL: ['LCL', 'lcl'], AIR: ['Air', 'air'], EXPRESS: ['Express', 'air'] };
const money = (v, mode) => (v == null ? '—' : usd(v, !/FCL/.test(mode) && !Number.isInteger(Number(v)) ? 2 : 0));

/** Append to an option's rate log (needs supabase/freight-rates.sql; silently skipped before). */
async function logRate(db, o, { rate, from = 'manual', note = '' }) {
  if (Number(o.rate_usd) === Number(rate)) return;
  const by = ST.current()?.name || null;
  const log = [...(Array.isArray(o.rate_log) ? o.rate_log : []), { at: now(), by, from, old: o.rate_usd != null ? Number(o.rate_usd) : null, new: Number(rate), note: String(note || '').slice(0, 160) }].slice(-30);
  await db.update('logistics_options', { id: o.id }, { rate_log: log }).catch(() => null);
}

/** Validity chip: expired / ends soon / to date / no date. */
function validity(o) {
  const v = o.valid_until ? String(o.valid_until).slice(0, 10) : null;
  if (!v) return ['w', 'no date'];
  const d = Math.round((Date.parse(v) - Date.parse(today())) / 864e5);
  if (d < 0) return ['e', `expired ${short(v)}`];
  if (d <= 7) return ['w', `ends ${short(v)}`];
  return ['ok', `to ${short(v)}`];
}

/** Custom dropdown that sets a hidden input (no system select). */
function ddSel(name, value, opts, { cls = '' } = {}) {
  const cur = opts.find(([v]) => String(v) === String(value ?? '')) || opts[0];
  return html`<details class="dd dd-sel ${cls}" data-dd data-ddsel><summary class="dd-field"><span data-ddsel-label>${cur ? cur[1] : ''}</span><span class="dd-car" aria-hidden="true">▾</span></summary>
    <div class="dd-menu">${opts.map(([v, l]) => html`<button type="button" data-v="${v}" class="${String(v) === String(cur?.[0]) ? 'on' : ''}">${l}</button>`)}</div><input type="hidden" name="${name}" value="${cur ? cur[0] : ''}"></details>`;
}

function rateFields(o, { isDef = false, prefix = '' } = {}) {
  const modeOpts = Object.entries(MODES).map(([k, m]) => [k, m.label]);
  return html`<div class="lr-g">
    <label class="w2"><span class="lbl">Name</span><input name="name" value="${o.name || ''}" placeholder="e.g. China → LA/LB · 40HQ FCL" required></label>
    <label><span class="lbl">Mode</span>${ddSel('mode', o.mode || 'FCL_40HQ', modeOpts)}</label>
    <label class="lr-sw"><span class="lbl">Default for products without their own</span><span class="tgl"><input type="checkbox" name="default" value="1" ${isDef ? raw('checked') : ''}><i></i> Default</span></label>
    <label><span class="lbl">Origin</span><input name="origin" value="${o.origin || ''}" placeholder="Ningbo / Shenzhen"></label>
    <label><span class="lbl">Destination</span><input name="dest" value="${o.destination || ''}" placeholder="Los Angeles / Long Beach"></label>
    <label><span class="lbl">${/AIR|EXPRESS/.test(o.mode || '') ? 'Air rate' : 'Ocean rate'}</span><span class="inp-unit"><input name="rate" type="number" step="0.01" min="0" value="${o.rate_usd ?? ''}" required><i>USD ${MODES[o.mode]?.unit || ''}</i></span></label>
    <label><span class="lbl">Fees / shipment</span><span class="inp-unit"><input name="fees" type="number" step="0.01" min="0" value="${o.fees_per_shipment_usd ?? ''}"><i>USD</i></span></label>
    <label><span class="lbl">Transit</span><span class="inp-unit"><input name="days" type="number" step="1" min="0" value="${o.transit_days ?? ''}"><i>days</i></span></label>
    <label><span class="lbl">Valid until</span><input name="valid" type="date" value="${o.valid_until ? String(o.valid_until).slice(0, 10) : ''}"></label>
    <label><span class="lbl">Min charge</span><span class="inp-unit"><input name="min" type="number" step="0.01" min="0" value="${o.min_charge_usd ?? ''}"><i>USD</i></span></label>
    <label class="lr-sw"><span class="lbl">Status</span><span class="tgl"><input type="checkbox" name="active" value="1" ${o.active !== false ? raw('checked') : ''}><i></i> Active</span></label>
  </div>`;
}

const FROM = { manual: 'edited', quote: 'from your quotes', market: 'market check' };

module.exports = function logisticsCosts(router, { db, G, AIG, needAi, friendlyAi }) {
  const quotes = async () => { try { return await db.list('freight_quotes', { order: 'quoted_on.desc' }); } catch { return []; } };

  router.get('/admin/logistics', G(async (req, res) => {
    const ctx = await S.getCtx(db);
    const SCR = require('./schedules');
    const q = req.query;
    const defId = ctx.settings.default_logistics_option_id;
    const fq = await quotes();
    const prods = await db.list('products').catch(() => []);
    const rows = ctx.options.map((o) => ({ o, isDef: o.id === defId, st: RH.quoteStats(fq, o), v: validity(o), used: prods.filter((p) => p.logistics_option_id === o.id).length }));
    const far = rows.filter((r) => r.o.active !== false && r.st && r.st.n >= 2 && Math.abs(r.st.gap_pct) > 25).length;
    const expired = rows.filter((r) => r.o.active !== false && r.v[0] === 'e').length;
    const noDate = rows.filter((r) => r.o.active !== false && !r.o.valid_until).length;
    const checkable = rows.filter((r) => Freight.MODE_INFO[r.o.mode] && r.o.active !== false).length;

    // ── Quick calculator (GET, nothing saved). Carton as "60 x 40 x 45" or l / w / h.
    const dims = String(q.dims || '').split(/[x×*,\s]+/).map(num).filter((x) => x > 0);
    const [L, W, H] = dims.length === 3 ? dims : [num(q.l), num(q.w), num(q.h)];
    let calc = null; let dutyNote = '';
    if (L && W && H && num(q.upc)) {
      let duty = num(q.duty);
      const hts = String(q.hts || '').replace(/\D/g, '');
      if (duty === null && hts.length >= 6) {
        try {
          const r = await require('../hts-classify').rateOf(hts, {});
          if (r.base != null) { const extra = Number(ctx.settings.china_extra_tariff_pct) || 0; duty = Math.round((r.total + extra) * 10) / 10; dutyNote = `Duty ${duty}% from HTS ${r.hts}: ${[`${r.base}% base`, ...r.extras.map((x) => `${x.rate}% ${x.label}`), extra ? `${extra}% China extra (Settings)` : ''].filter(Boolean).join(' + ')}.`; }
          else dutyNote = `HTS ${r.hts}: no rate found in the US schedule — category duty used.`;
        } catch { dutyNote = 'HTS lookup failed — category duty used.'; }
      }
      calc = analyzeProduct({ id: 'calc', units_per_carton: num(q.upc), carton_l_cm: L, carton_w_cm: W, carton_h_cm: H, carton_gw_kg: num(q.gw), unit_price: num(q.price), currency: q.currency || 'USD', incoterm: 'FOB', planned_qty: num(q.qty), moq: num(q.qty), duty_rate_pct: duty, category: q.category || null }, ctx);
    }
    const dimsVal = q.dims || (q.l && q.w && q.h ? `${q.l} × ${q.w} × ${q.h}` : '');
    const catOpts = [['', 'None'], ...ctx.categoryNames.map((c) => [c, c])];
    const curOpts = F.CURRENCIES.map((c) => [c, c]);

    const row = ({ o, isDef, st, v }) => {
      const [chip, cc] = CHIP[o.mode] || [o.mode, ''];
      const gap = st && st.gap_pct != null ? st.gap_pct : null;
      const off = gap != null && st.n >= 2 && Math.abs(gap) > 25;
      const mk = o.market && typeof o.market === 'object' ? o.market : null;
      const open = raw(`data-open-dialog="lr-${o.id}"`);
      return html`<tr class="${o.active === false ? 'off' : ''}">
        <td class="lr-st"><form method="post" action="/admin/logistics/rate/${o.id}/default"><button class="lr-star ${isDef ? 'on' : ''}" title="${isDef ? 'Default rate' : 'Make this the default rate'}" aria-label="${isDef ? 'Default rate' : `Make ${o.name} the default`}" ${isDef ? raw('disabled') : ''}>${isDef ? '★' : '☆'}</button></form></td>
        <td ${open}><span class="lr-m ${cc}">${chip}</span></td>
        <td ${open} class="lr-ln"><b>${[o.origin, o.destination].filter(Boolean).join(' → ') || o.name}</b>${o.active === false ? html` <span class="lr-c">inactive</span>` : ''}<div class="sub">${o.name}</div></td>
        <td ${open} class="r nw"><span class="lr-big">${money(o.rate_usd, o.mode)}</span> <span class="sub">${UNIT[o.mode] || ''}</span></td>
        <td ${open} class="r nw">${usd(o.fees_per_shipment_usd)}</td>
        <td ${open} class="r nw">${o.transit_days != null ? `${o.transit_days}d` : '—'}</td>
        <td class="lr-q">${st ? html`<div>median <b>${money(st.median, o.mode)}</b>${st.unit === '/W/M' ? '/W/M' : ''} · ${st.n} quote${st.n === 1 ? '' : 's'}</div>
          ${off ? html`<form method="post" action="/admin/logistics/rate/${o.id}/use-quotes" class="lr-use"><span class="${gap > 0 ? 'up' : 'dn'}">rate is ${gap > 0 ? '+' : ''}${gap}%</span> · <button class="link">Use ${money(st.median, o.mode)}</button></form>`
            : gap != null ? html`<div class="dn">${Math.abs(gap) <= 10 ? `within ${Math.abs(gap)}% ✓` : `${gap > 0 ? '+' : ''}${gap}%${st.n < 2 ? ' · 1 quote' : ''}`}</div>` : ''}`
          : html`<span class="sub">${RH.BOX_OF[o.mode] ? 'no quotes yet' : '—'}</span>`}</td>
        <td ${open} class="lr-mk">${mk && mk.rate != null ? html`<div class="nw">${money(mk.rate, o.mode)}</div><div class="sub">${short(mk.at)}${mk.confidence ? ` · ${mk.confidence}` : ''}</div>` : mk ? html`<span class="sub">no figure · ${short(mk.at)}</span>` : html`<span class="sub">never</span>`}</td>
        <td ${open}><span class="lr-c ${v[0]}">${v[1]}</span></td>
        <td class="r"><button type="button" class="lr-dots" data-open-dialog="lr-${o.id}" aria-label="${`Edit ${o.name}`}">⋯</button></td></tr>`;
    };

    const dialog = ({ o, isDef, st, used }) => {
      const log = (Array.isArray(o.rate_log) ? o.rate_log : []).slice().reverse();
      return html`<dialog id="lr-${o.id}" class="rp-modal lr-dlg" aria-labelledby="lr-t-${o.id}"><form method="post" action="/admin/logistics/rate/${o.id}" data-busy>
        <h2 id="lr-t-${o.id}"><span class="lr-m ${(CHIP[o.mode] || [])[1] || ''}">${(CHIP[o.mode] || [o.mode])[0]}</span> ${[o.origin, o.destination].filter(Boolean).join(' → ') || o.name} ${isDef ? html`<span class="lr-c ok">Default</span>` : ''}</h2>
        <p class="sub">${isDef ? 'Used by every product without its own freight option' : `Chosen on ${used} product${used === 1 ? '' : 's'}`}${log[0] ? ` · last changed ${short(log[0].at)}${log[0].by ? ` by ${String(log[0].by).split(' ')[0]}` : ''}` : ''}</p>
        ${st ? html`<div class="lr-qbox"><b>Your quotes, last 90 days:</b> median ${money(st.median, o.mode)}${st.unit === '/W/M' ? '/W/M' : ''} ocean (${st.n} quote${st.n === 1 ? '' : 's'}${st.n > 1 ? `: ${money(st.low, o.mode)} – ${money(st.high, o.mode)}` : ''}), latest ${short(st.latest.on)}${st.latest.company ? ` from ${st.latest.company}` : ''}${st.latest.valid_until ? `, valid to ${short(st.latest.valid_until)}` : ''}.
          ${Number(o.rate_usd) !== st.median ? html`<button type="submit" class="link" formaction="/admin/logistics/rate/${o.id}/use-quotes" formnovalidate>Use ${money(st.median, o.mode)}${st.latest.valid_until ? ` · valid to ${short(st.latest.valid_until)}` : ''}</button>` : ''}</div>`
          : RH.BOX_OF[o.mode] ? html`<p class="sub">No forwarder quotes for ${RH.BOX_OF[o.mode]} to LA / Long Beach in the last 90 days. Quotes from Load containers → request for quotation land in <a href="/admin/logistics/rates">Rate history</a> and show here.</p>` : ''}
        ${rateFields(o, { isDef })}
        ${log.length ? html`<div class="lr-log"><b>Rate changes</b>${log.slice(0, 6).map((x) => html`<div><span>${short(x.at)}${x.by ? ` · ${String(x.by).split(' ')[0]}` : ''} · ${FROM[x.from] || x.from}${x.note ? ` · ${x.note}` : ''}</span><span class="nw">${x.old != null ? `${money(x.old, o.mode)} → ` : ''}<b>${money(x.new, o.mode)}</b></span></div>`)}</div>`
          : o.notes ? html`<p class="sub lr-log">${o.notes}</p>` : ''}
        <div class="lr-acts" data-armbox>
          ${Freight.MODE_INFO[o.mode] ? html`<button class="btn ghost small" type="submit" formaction="/admin/logistics/${o.id}/check-rate" formnovalidate ${AI.enabled() ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Check market rate</button>` : ''}
          <span class="r"><button type="button" class="bd-del lr-del" data-arm>Delete</button><button type="submit" class="bd-yes" form="lr-del-${o.id}">✓ Delete this rate</button>
          <button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Save</button></span></div>
      </form></dialog><form id="lr-del-${o.id}" method="post" action="/admin/logistics/rate/${o.id}/delete" hidden></form>`;
    };

    res.html(page({
      title: 'Costs & rates', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true,
      body: html`${SCR.logisticsTabs('costs')}${await SCR.nextSailings(db)}
      <section class="card lr" id="rates"><div class="lr-h"><h2>Freight rates</h2><span class="sub">used for every product's landed cost</span>
        <span class="lr-sum">${expired ? html`<span class="lr-c e">${expired} expired</span>` : ''}${far ? html`<span class="lr-c w">${far} far from your quotes</span>` : ''}${noDate ? html`<span class="lr-c w">${noDate} no expiry date</span>` : ''}</span>
        <span class="r">${checkable ? html`<form method="post" action="/admin/logistics/check-all" data-busy class="inline"><button class="btn ghost small" ${AI.enabled() ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Check all market rates</button></form>` : ''}<button type="button" class="btn small" data-open-dialog="lr-new">+ Add rate</button></span></div>
        <div class="table-wrap"><table class="list lr-t"><thead><tr><th></th><th>Mode</th><th>Lane</th><th class="r">Rate</th><th class="r">Fees / shipment</th><th class="r">Transit</th><th>Your quotes · 90 days</th><th>Market check</th><th>Valid</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(row) : html`<tr><td colspan="10" class="sub">No freight rates yet — add one.</td></tr>`}</tbody></table></div>
        <p class="sub lr-foot">Rate = the freight line of a quote (ocean or air). Fees / shipment = broker, drayage, port and terminal. US customs fees (MPF 0.3464% + HMF 0.125% for ocean) and duty are added per product. An expired rate still prices products, flagged on each product.</p>
      </section>
      ${rows.map(dialog)}
      <dialog id="lr-new" class="rp-modal lr-dlg" aria-labelledby="lr-new-t"><form method="post" action="/admin/logistics/rate/new" data-busy>
        <h2 id="lr-new-t">Add a freight rate</h2>${rateFields({ mode: 'FCL_40HQ', active: true, destination: 'Los Angeles / Long Beach' }, {})}
        <div class="lr-acts"><span class="r"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Add rate</button></span></div></form></dialog>

      <section class="card lr-calc" id="calc"><div class="lr-h"><h2>Quick calculator</h2><span class="sub">any carton, nothing saved · uses the rates above</span></div>
        <form method="get" action="/admin/logistics#calc" class="lr-cf">
          <label class="w15"><span class="lbl">Carton L × W × H</span><span class="inp-unit"><input name="dims" value="${dimsVal}" placeholder="60 x 40 x 45" required><i>cm</i></span></label>
          <label><span class="lbl">Gross weight</span><span class="inp-unit"><input name="gw" type="number" step="any" value="${q.gw || ''}"><i>kg</i></span></label>
          <label><span class="lbl">Units / carton</span><span class="inp-unit"><input name="upc" type="number" step="1" value="${q.upc || ''}" required><i>pcs</i></span></label>
          <label><span class="lbl">Order qty</span><span class="inp-unit"><input name="qty" type="number" step="1" value="${q.qty || ''}" placeholder="full container"><i>pcs</i></span></label>
          <label><span class="lbl">Unit price</span><span class="inp-unit lr-pr"><input name="price" type="number" step="any" value="${q.price || ''}">${ddSel('currency', q.currency || 'USD', curOpts, { cls: 'mini' })}</span></label>
          <label><span class="lbl">Category</span>${ddSel('category', q.category || '', catOpts)}</label>
          <label><span class="lbl">Duty</span><span class="inp-unit"><input name="duty" type="number" step="any" value="${q.duty || ''}" placeholder="category"><i>%</i></span></label>
          <label><span class="lbl">HTS <em>optional</em></span><input name="hts" value="${q.hts || ''}" placeholder="3922.20"></label>
          <span class="lr-go"><button class="btn">Calculate</button>${calc ? html`<a class="link small" href="/admin/logistics#calc">Clear</a>` : ''}</span>
        </form>
        ${calc ? html`${dutyNote ? html`<p class="sub">${dutyNote}</p>` : ''}<div class="lr-res">
          ${['20GP', '40GP', '40HQ'].map((c) => { const f = calc.fits[c]; return html`<div><small>${c}</small>${f ? html`<b>${fmt.num(f.cartons)} ctns</b><small>${fmt.num(f.units)} units · ${f.fillPct}% full · by ${f.limitedBy}</small>` : html`<b>—</b>`}</div>`; })}
          <div><small>Carton</small><b>${calc.carton_cbm} CBM</b><small>${calc.unit_cbm} CBM/unit</small></div>
          <div class="lr-rt"><table class="list compact"><thead><tr><th>Option</th><th class="r">Freight/pc</th><th class="r">Landed/pc</th></tr></thead><tbody>
            ${calc.scenarios.map((s) => html`<tr title="${s.notes.join(' · ')}"><td>${s.option_id === defId ? '★ ' : ''}${s.name}</td><td class="r">${fmt.money(s.freight_per_unit)}</td><td class="r"><b>${fmt.money(s.landed_cost)}</b></td></tr>`)}</tbody></table></div>
        </div>${calc.pricing.suggested_wholesale ? html`<p class="sub">Suggested wholesale at ${calc.pricing.target_margin_pct}% margin: <b>${fmt.money(calc.pricing.suggested_wholesale)}</b> · duty ${calc.duty_pct}% (${calc.duty_source})</p>` : ''}` : ''}
      </section>`,
    }));
  }));

  const getO = async (id) => { const o = await db.get('logistics_options', id).catch(() => null); if (!o) throw new HttpError(404, 'Freight rate not found'); return o; };
  const patchOf = (f, o = {}) => ({
    name: String(f.name || o.name || '').trim().slice(0, 120) || 'Freight rate', mode: MODES[f.mode] ? f.mode : (o.mode || 'FCL_40HQ'),
    origin: String(f.origin || '').trim() || null, destination: String(f.dest || '').trim() || null,
    rate_usd: num(f.rate) ?? 0, min_charge_usd: num(f.min) ?? 0, fees_per_shipment_usd: num(f.fees) ?? 0,
    transit_days: num(f.days), valid_until: /^\d{4}-\d{2}-\d{2}$/.test(f.valid || '') ? f.valid : null, active: f.active === '1',
  });
  const setDefault = async (id, on, cur) => { if (on && cur !== id) await db.update('settings', { id: 1 }, { default_logistics_option_id: id }); else if (!on && cur === id) await db.update('settings', { id: 1 }, { default_logistics_option_id: null }); };

  router.post('/admin/logistics/check-all', AIG(async (req, res) => {
    needAi();
    const ctx = await S.getCtx(db);
    const list = ctx.options.filter((o) => o.active !== false && Freight.MODE_INFO[o.mode]);
    const out = await Promise.all(list.map(async (o) => {
      try {
        const r = await Freight.researchRate(o);
        await db.update('logistics_options', { id: o.id }, { market: { rate: r.rate_usd, low: r.low_usd ?? null, high: r.high_usd ?? null, at: now(), as_of: r.as_of || null, basis: String(r.basis || '').slice(0, 160), confidence: r.confidence || null, source: String(r.sources?.[0]?.title || '').slice(0, 120) } }).catch(() => null);
        return r.rate_usd != null ? `${(CHIP[o.mode] || [o.name])[0]} ${money(r.rate_usd, o.mode)}` : `${(CHIP[o.mode] || [o.name])[0]} no figure`;
      } catch (e) { return `${(CHIP[o.mode] || [o.name])[0]} failed (${friendlyAi(e.message).slice(0, 60)})`; }
    }));
    S.invalidate('ctx');
    flash(res, 'ok', `Market check: ${out.join(' · ')}. Nothing changed — open a rate to apply.`);
    res.redirect('/admin/logistics#rates');
  }));

  router.post('/admin/logistics/rate/new', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ctx = await S.getCtx(db);
    if (num(fields.rate) === null) { flash(res, 'error', 'Enter a rate'); return res.redirect('/admin/logistics#rates'); }
    const row = { ...patchOf(fields), active: true, sort: ctx.options.length + 1 };
    // rate_log needs supabase/freight-rates.sql: add without it until then
    const o = await db.insert('logistics_options', { ...row, rate_log: [{ at: now(), by: ST.current()?.name || null, from: 'manual', old: null, new: num(fields.rate), note: 'added' }] }).catch(() => db.insert('logistics_options', row));
    await setDefault(o.id, fields.default === '1', ctx.settings.default_logistics_option_id);
    S.invalidate('ctx');
    flash(res, 'ok', `${o.name} added`);
    res.redirect('/admin/logistics#rates');
  }));

  router.post('/admin/logistics/rate/:id', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const o = await getO(req.params.id); const ctx = await S.getCtx(db);
    const p = patchOf(fields, o);
    await db.update('logistics_options', { id: o.id }, p);
    await logRate(db, o, { rate: p.rate_usd, from: 'manual' });
    await setDefault(o.id, fields.default === '1', ctx.settings.default_logistics_option_id);
    S.invalidate('ctx');
    flash(res, 'ok', `${p.name} saved${Number(o.rate_usd) !== p.rate_usd ? ` — rate ${money(o.rate_usd, p.mode)} → ${money(p.rate_usd, p.mode)}; product costs updated` : ''}`);
    res.redirect('/admin/logistics#rates');
  }));

  router.post('/admin/logistics/rate/:id/default', G(async (req, res) => {
    const o = await getO(req.params.id);
    await db.update('settings', { id: 1 }, { default_logistics_option_id: o.id });
    S.invalidate('ctx');
    flash(res, 'ok', `${o.name} is now the default rate`);
    res.redirect('/admin/logistics#rates');
  }));

  router.post('/admin/logistics/rate/:id/use-quotes', G(async (req, res) => {
    const o = await getO(req.params.id);
    const st = RH.quoteStats(await quotes(), o);
    if (!st) { flash(res, 'error', 'No quotes to use for this rate'); return res.redirect('/admin/logistics#rates'); }
    const until = st.latest.valid_until && st.latest.valid_until >= today() ? st.latest.valid_until : new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    await db.update('logistics_options', { id: o.id }, { rate_usd: st.median, valid_until: until, notes: `Rate ${o.rate_usd} → ${st.median} from your quotes (median of ${st.n}, ${today()})` });
    await logRate(db, o, { rate: st.median, from: 'quote', note: `median of ${st.n}` });
    S.invalidate('ctx');
    flash(res, 'ok', `${o.name}: ${money(o.rate_usd, o.mode)} → ${money(st.median, o.mode)} (median of ${st.n} quote${st.n === 1 ? '' : 's'}), valid to ${short(until)}. Product costs updated.`);
    res.redirect('/admin/logistics#rates');
  }));

  router.post('/admin/logistics/rate/:id/delete', G(async (req, res) => {
    const o = await getO(req.params.id); const ctx = await S.getCtx(db);
    await db.update('products', { logistics_option_id: o.id }, { logistics_option_id: null });
    if (ctx.settings.default_logistics_option_id === o.id) await db.update('settings', { id: 1 }, { default_logistics_option_id: null });
    await db.remove('logistics_options', { id: o.id });
    S.invalidate('ctx');
    flash(res, 'ok', `${o.name} deleted`);
    res.redirect('/admin/logistics#rates');
  }));
};
module.exports.logRate = logRate;
module.exports.validity = validity;
