'use strict';
// Admin: categories, logistics (options + calculator), pricing, AI, settings, CSV export.
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav, statusPill } = require('../views/layout');
const { renderAnalysis } = require('../views/ai');
const F = require('../fields');
const { MODES, analyzeProduct } = require('../calc');
const S = require('../services');
const Duty = require('../duty');
const Freight = require('../freight');
const AI = require('../ai');
const { guard, applyFilters, filterBar, dutyHelp } = require('./admin');

const num = (v) => { const n = F.parseNumber(v); return Number.isNaN(n) ? null : n; };
const csvCell = (v) => { if (v === null || v === undefined) return ''; const s = Array.isArray(v) ? v.join('; ') : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

module.exports = function toolRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  // ── Categories
  router.get('/admin/categories', G(async (req, res) => {
    const [ctx, products] = await Promise.all([S.getCtx(db), db.list('products', { select: 'id,category' })]);
    const count = (n) => products.filter((p) => p.category === n).length;
    const orphan = [...new Set(products.map((p) => p.category).filter((c) => c && !ctx.categoryNames.includes(c)))];
    res.html(page({
      title: 'Categories', nav: adminNav('categories'), flash: takeFlash(req, res), wide: true,
      body: html`<h1>Categories</h1>
      <p class="muted">Default duty % and HS code apply to products without their own. Target margin drives the suggested wholesale price. Check duty rates on <a href="https://hts.usitc.gov" target="_blank" rel="noopener">hts.usitc.gov</a>, plus any Section 301 tariff for China-origin goods.</p>
      <form method="post" action="/admin/categories"><div class="table-wrap"><table class="list edit">
        <thead><tr><th>Name</th><th>Default HS code</th><th>Default duty %</th><th>Target margin %</th><th>Notes</th><th>Order</th><th class="r">Products</th><th>Delete</th></tr></thead>
        <tbody>${ctx.categories.map((c) => html`<tr>
          <td><input name="name_${c.id}" value="${c.name}" required></td>
          <td><input name="hs_${c.id}" value="${c.default_hs_code || ''}" size="10"></td>
          <td><input name="duty_${c.id}" type="number" step="0.01" min="0" value="${c.default_duty_pct ?? ''}"></td>
          <td><input name="margin_${c.id}" type="number" step="0.1" min="0" max="95" value="${c.target_margin_pct ?? ''}"></td>
          <td><input name="notes_${c.id}" value="${c.notes || ''}"></td>
          <td><input name="sort_${c.id}" type="number" step="1" value="${c.sort}" class="tiny"></td>
          <td class="r">${count(c.name)}</td>
          <td>${count(c.name) ? '' : html`<input type="checkbox" name="del" value="${c.id}">`}</td></tr>`)}
          <tr class="new"><td><input name="name_new" placeholder="New category"></td><td><input name="hs_new" size="10"></td><td><input name="duty_new" type="number" step="0.01" min="0"></td><td><input name="margin_new" type="number" step="0.1" min="0" max="95"></td><td><input name="notes_new"></td><td><input name="sort_new" type="number" class="tiny" value="${ctx.categories.length + 1}"></td><td></td><td></td></tr>
        </tbody></table></div><div class="form-actions"><button class="btn">Save categories</button></div></form>
      ${orphan.length ? html`<p class="muted">Used by products but not in this list: ${orphan.join(', ')}</p>` : ''}`,
    }));
  }));

  router.post('/admin/categories', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ctx = await S.getCtx(db);
    const del = new Set([].concat(fields.del || []));
    for (const c of ctx.categories) {
      if (del.has(c.id)) { await db.remove('categories', { id: c.id }); continue; }
      const name = String(fields[`name_${c.id}`] || '').trim();
      if (!name) continue;
      const patch = { name, default_hs_code: fields[`hs_${c.id}`] || null, default_duty_pct: num(fields[`duty_${c.id}`]), target_margin_pct: num(fields[`margin_${c.id}`]), notes: fields[`notes_${c.id}`] || null, sort: Math.round(num(fields[`sort_${c.id}`]) || 0) };
      await db.update('categories', { id: c.id }, patch);
      if (name !== c.name) await db.update('products', { category: c.name }, { category: name });
    }
    const newName = String(fields.name_new || '').trim();
    if (newName && !ctx.categoryNames.includes(newName)) {
      await db.insert('categories', { name: newName, default_hs_code: fields.hs_new || null, default_duty_pct: num(fields.duty_new), target_margin_pct: num(fields.margin_new), notes: fields.notes_new || null, sort: Math.round(num(fields.sort_new) || 0) });
    }
    S.invalidate('ctx');
    flash(res, 'ok', 'Categories saved');
    res.redirect('/admin/categories');
  }));

  // ── Logistics
  router.get('/admin/logistics', G(async (req, res) => {
    const ctx = await S.getCtx(db);
    const q = req.query;
    let calc = null;
    if (q.l && q.w && q.h && q.upc) {
      const p = {
        id: 'calc', units_per_carton: num(q.upc), carton_l_cm: num(q.l), carton_w_cm: num(q.w), carton_h_cm: num(q.h), carton_gw_kg: num(q.gw),
        unit_price: num(q.price), currency: q.currency || 'USD', incoterm: 'FOB', planned_qty: num(q.qty), moq: num(q.qty), duty_rate_pct: num(q.duty), category: q.category || null,
      };
      calc = analyzeProduct(p, ctx);
    }
    const modeOpts = Object.entries(MODES);
    res.html(page({
      title: 'Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true,
      body: html`<h1>Logistics</h1>
      <section class="card"><h2>Quick calculator</h2>
        <form method="get" class="calc-form">
          <label><span class="lbl">Carton L (cm)</span><input name="l" type="number" step="any" value="${q.l || ''}" required></label>
          <label><span class="lbl">W (cm)</span><input name="w" type="number" step="any" value="${q.w || ''}" required></label>
          <label><span class="lbl">H (cm)</span><input name="h" type="number" step="any" value="${q.h || ''}" required></label>
          <label><span class="lbl">Gross kg / carton</span><input name="gw" type="number" step="any" value="${q.gw || ''}"></label>
          <label><span class="lbl">Units / carton</span><input name="upc" type="number" step="1" value="${q.upc || ''}" required></label>
          <label><span class="lbl">Order qty</span><input name="qty" type="number" step="1" value="${q.qty || ''}" placeholder="full container"></label>
          <label><span class="lbl">Unit price</span><input name="price" type="number" step="any" value="${q.price || ''}"></label>
          <label><span class="lbl">Currency</span><select name="currency">${F.CURRENCIES.map((c) => html`<option ${c === (q.currency || 'USD') ? raw('selected') : ''}>${c}</option>`)}</select></label>
          <label><span class="lbl">Category</span><select name="category"><option value="">—</option>${ctx.categoryNames.map((c) => html`<option ${c === q.category ? raw('selected') : ''}>${c}</option>`)}</select></label>
          <label><span class="lbl">Duty %</span><input name="duty" type="number" step="any" value="${q.duty || ''}" placeholder="category"></label>
          <div><button class="btn">Calculate</button></div>
        </form>
        ${calc ? html`
          <div class="fits">${['20GP', '40GP', '40HQ'].map((c) => { const f = calc.fits[c]; return html`<div class="fit"><b>${c}</b>${f ? html`<span>${fmt.num(f.cartons)} cartons</span><span>${fmt.num(f.units)} units</span><small>limited by ${f.limitedBy} · ${f.fillPct}% full · ${f.orientation.join('×')}</small>` : '—'}</div>`; })}
            <div class="fit"><b>Carton</b><span>${calc.carton_cbm} CBM</span><span>${calc.unit_cbm} CBM/unit</span></div></div>
          <table class="list compact"><thead><tr><th>Option</th><th class="r">Freight total</th><th class="r">Freight / unit</th><th class="r">Landed / unit</th><th>Notes</th></tr></thead>
          <tbody>${calc.scenarios.map((s) => html`<tr><td>${s.name}</td><td class="r">${fmt.money(s.freight_total)}</td><td class="r">${fmt.money(s.freight_per_unit)}</td><td class="r"><b>${fmt.money(s.landed_cost)}</b></td><td class="sub">${s.notes.join(' · ')}</td></tr>`)}</tbody></table>
          ${calc.pricing.suggested_wholesale ? html`<p>Suggested wholesale at ${calc.pricing.target_margin_pct}% margin: <b>${fmt.money(calc.pricing.suggested_wholesale)}</b></p>` : ''}` : ''}
      </section>

      <section class="card"><h2>Freight options & rates</h2>
        <p class="muted">The rates loaded at setup are examples only. Replace them with your forwarder's current quotes. Fees per shipment cover the customs broker, drayage, port and terminal charges. The calculation also adds US customs fees (MPF 0.3464% + HMF 0.125% for ocean).</p>
        <form method="post" action="/admin/logistics"><div class="table-wrap"><table class="list edit">
          <thead><tr><th>Name</th><th>Mode</th><th>Origin</th><th>Destination</th><th>Rate (USD)</th><th>Min charge</th><th>Fees / shipment</th><th>Transit days</th><th>Valid until</th><th>Active</th><th>Default</th><th>Delete</th></tr></thead>
          <tbody>${ctx.options.map((o) => html`<tr>
            <td><input name="name_${o.id}" value="${o.name}" required></td>
            <td><select name="mode_${o.id}">${modeOpts.map(([k, m]) => html`<option value="${k}" ${k === o.mode ? raw('selected') : ''}>${m.label}</option>`)}</select><div class="sub">${MODES[o.mode]?.unit}</div></td>
            <td><input name="origin_${o.id}" value="${o.origin || ''}"></td><td><input name="dest_${o.id}" value="${o.destination || ''}"></td>
            <td><input name="rate_${o.id}" type="number" step="0.01" min="0" value="${o.rate_usd}" required>
              ${Freight.MODE_INFO[o.mode] ? html`<div><button class="btn ghost small" type="submit" formaction="/admin/logistics/${o.id}/check-rate" formmethod="post" formnovalidate data-busy ${AI.enabled() ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Check market rate</button></div>` : ''}
              ${o.notes ? html`<div class="sub">${o.notes}</div>` : ''}</td>
            <td><input name="min_${o.id}" type="number" step="0.01" min="0" value="${o.min_charge_usd}"></td>
            <td><input name="fees_${o.id}" type="number" step="0.01" min="0" value="${o.fees_per_shipment_usd}"></td>
            <td><input name="days_${o.id}" type="number" step="1" min="0" value="${o.transit_days ?? ''}" class="tiny"></td>
            <td><input name="valid_${o.id}" type="date" value="${o.valid_until || ''}"></td>
            <td><input type="checkbox" name="active" value="${o.id}" ${o.active !== false ? raw('checked') : ''}></td>
            <td><input type="radio" name="default" value="${o.id}" ${o.id === ctx.settings.default_logistics_option_id ? raw('checked') : ''}></td>
            <td><input type="checkbox" name="del" value="${o.id}"></td></tr>`)}
            <tr class="new"><td><input name="name_new" placeholder="New option"></td>
              <td><select name="mode_new">${modeOpts.map(([k, m]) => html`<option value="${k}">${m.label}</option>`)}</select></td>
              <td><input name="origin_new"></td><td><input name="dest_new"></td><td><input name="rate_new" type="number" step="0.01" min="0"></td>
              <td><input name="min_new" type="number" step="0.01" min="0"></td><td><input name="fees_new" type="number" step="0.01" min="0"></td>
              <td><input name="days_new" type="number" class="tiny"></td><td><input name="valid_new" type="date"></td><td></td><td></td><td></td></tr>
          </tbody></table></div><div class="form-actions"><button class="btn">Save logistics options</button></div></form>
      </section>`,
    }));
  }));

  // Market-rate check: AI finds the current benchmark online and PROPOSES a rate; nothing changes until the admin confirms.
  router.post('/admin/logistics/:id/check-rate', G(async (req, res) => {
    needAi();
    await parseForm(req, { limitBytes: 1_000_000 }).catch(() => null);
    const o = await db.get('logistics_options', req.params.id);
    if (!o) throw new HttpError(404, 'Option not found');
    let r;
    try { r = await Freight.researchRate(o); } catch (e) {
      console.error('Freight rate check failed:', e.message);
      flash(res, 'error', `Market rate check failed: ${e.message}`);
      return res.redirect('/admin/logistics');
    }
    const safe = (u) => /^https?:\/\//i.test(u);
    res.html(page({
      title: 'Market rate check', nav: adminNav('logistics'), flash: takeFlash(req, res),
      body: html`<h1>Market rate check</h1>
      <section class="card">
        <h2>${o.name}</h2>
        <dl class="kv">
          <dt>Current rate in portal</dt><dd>${fmt.money(r.current_rate_usd)} <span class="sub">${r.unit}</span></dd>
          <dt class="strong">Proposed rate</dt><dd class="strong">${r.rate_usd === null ? 'No usable figure found' : html`${fmt.money(r.rate_usd)} ${r.change_pct !== null ? html`<span class="${r.change_pct > 0 ? 'neg' : 'pos'}">${r.change_pct > 0 ? '+' : ''}${r.change_pct}%</span>` : ''}`} <span class="pill ${r.confidence === 'high' ? 's-selected' : r.confidence === 'low' ? 's-rejected' : 's-reviewing'}">${r.confidence} confidence</span></dd>
          ${r.low_usd !== null && r.low_usd !== undefined && r.high_usd !== null && r.high_usd !== undefined ? html`<dt>Range found</dt><dd>${fmt.money(r.low_usd)} – ${fmt.money(r.high_usd)}</dd>` : ''}
          <dt>Basis</dt><dd>${r.basis}${r.as_of ? ` · as of ${r.as_of}` : ''}${r.lane ? ` · ${r.lane}` : ''}</dd>
          ${r.includes_fees ? html`<dt>Includes</dt><dd>${r.includes_fees}</dd>` : ''}
        </dl>
        <p>${r.explanation}</p>
        ${r.warnings.length ? html`<div class="flash warn"><strong>Check before applying:</strong><ul class="plain">${r.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
        ${r.sources.length ? html`<p><strong>Sources</strong></p><ul class="plain">${r.sources.filter((x) => safe(x.url)).map((x) => html`<li><a href="${x.url}" target="_blank" rel="noopener noreferrer">${x.title}</a> <span class="sub">${x.url}</span></li>`)}</ul>` : ''}
        ${r.rate_usd === null ? html`<div class="flash warn"><strong>No usable figure found.</strong> Index sites are often hidden from search. You can look it up yourself and type it into the Rate field on the Logistics page: <a href="https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/world-container-index-assessed-by-drewry" target="_blank" rel="noopener noreferrer">Drewry WCI</a> · <a href="https://fbx.freightos.com/" target="_blank" rel="noopener noreferrer">Freightos FBX</a>, or ask your forwarder. Read what the search found below.</div>` : ''}
        <details ${r.rate_usd === null ? raw('open') : ''}><summary>Research notes</summary><p class="muted" style="white-space:pre-wrap">${r.notes_text}</p></details>
        <div class="form-actions">
          ${r.rate_usd !== null && r.rate_usd > 0 ? html`<form method="post" action="/admin/logistics/${o.id}/apply-rate" class="inline-form">
            <label><span class="lbl">Rate to apply (USD, ${r.unit}): edit if your forwarder quoted differently</span><input name="rate" type="number" step="0.01" min="0.01" value="${r.rate_usd}" required></label>
            <input type="hidden" name="source" value="${(r.sources[0]?.title || r.basis || '').slice(0, 120)}">
            <input type="hidden" name="as_of" value="${r.as_of || ''}">
            <button class="btn">Confirm &amp; update rate</button></form>` : ''}
          <a class="btn ghost" href="/admin/logistics">Cancel: keep current rate</a>
        </div>
      </section>`,
    }));
  }));

  router.post('/admin/logistics/:id/apply-rate', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const rate = num(fields.rate);
    const o = await db.get('logistics_options', req.params.id);
    if (!o) throw new HttpError(404, 'Option not found');
    if (rate === null || !(rate > 0) || rate > 100000) { flash(res, 'error', 'Enter a valid rate'); return res.redirect('/admin/logistics'); }
    const today = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const note = `Rate ${o.rate_usd} → ${rate} confirmed ${today} from market check (${String(fields.source || 'web').slice(0, 120)}${fields.as_of ? `, as of ${String(fields.as_of).slice(0, 40)}` : ''})`;
    await db.update('logistics_options', { id: o.id }, { rate_usd: rate, valid_until: until, notes: note });
    S.invalidate('ctx');
    flash(res, 'ok', `${o.name}: rate updated to ${rate} (valid until ${until}). Costs on all products now use it.`);
    res.redirect('/admin/logistics');
  }));

  router.post('/admin/logistics', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ctx = await S.getCtx(db);
    const del = new Set([].concat(fields.del || []));
    const active = new Set([].concat(fields.active || []));
    for (const o of ctx.options) {
      if (del.has(o.id)) { await db.update('products', { logistics_option_id: o.id }, { logistics_option_id: null }); await db.remove('logistics_options', { id: o.id }); continue; }
      const mode = MODES[fields[`mode_${o.id}`]] ? fields[`mode_${o.id}`] : o.mode;
      await db.update('logistics_options', { id: o.id }, {
        name: String(fields[`name_${o.id}`] || o.name).trim(), mode, origin: fields[`origin_${o.id}`] || null, destination: fields[`dest_${o.id}`] || null,
        rate_usd: num(fields[`rate_${o.id}`]) ?? 0, min_charge_usd: num(fields[`min_${o.id}`]) ?? 0, fees_per_shipment_usd: num(fields[`fees_${o.id}`]) ?? 0,
        transit_days: num(fields[`days_${o.id}`]), valid_until: fields[`valid_${o.id}`] || null, active: active.has(o.id),
      });
    }
    if (String(fields.name_new || '').trim() && num(fields.rate_new) !== null) {
      await db.insert('logistics_options', {
        name: fields.name_new.trim(), mode: MODES[fields.mode_new] ? fields.mode_new : 'FCL_40HQ', origin: fields.origin_new || null, destination: fields.dest_new || null,
        rate_usd: num(fields.rate_new), min_charge_usd: num(fields.min_new) ?? 0, fees_per_shipment_usd: num(fields.fees_new) ?? 0,
        transit_days: num(fields.days_new), valid_until: fields.valid_new || null, sort: ctx.options.length + 1,
      });
    }
    const def = fields.default && !del.has(fields.default) ? fields.default : null;
    await db.update('settings', { id: 1 }, { default_logistics_option_id: def });
    S.invalidate('ctx');
    flash(res, 'ok', 'Logistics options saved');
    res.redirect('/admin/logistics');
  }));

  // ── Pricing
  const chinaOrigin = (p) => { const o = String(p.country_of_origin || '').trim().toLowerCase(); return !o || ['china', 'cn', 'prc', "people's republic of china", '中国'].includes(o); };
  const needsDutyResearch = (p) => chinaOrigin(p) && !p.duty_ai_checked_at && (p.duty_rate_pct === null || p.duty_rate_pct === undefined) && !p.is_draft;

  router.post('/admin/pricing/research-duty', G(async (req, res) => {
    needAi();
    const { items } = await S.loadAnalyzed(db);
    const todo = items.map((i) => i.product).filter(needsDutyResearch).slice(0, 6);
    let ok = 0; const failed = [];
    for (let i = 0; i < todo.length; i += 2) {
      await Promise.all(todo.slice(i, i + 2).map(async (p) => {
        try { const r = await Duty.researchDuty(p); await db.update('products', { id: p.id }, Duty.productPatch(r)); ok++; }
        catch (e) { console.error('Duty research failed for', p.id, e.message); failed.push(`${p.product_name || p.id}: ${e.message}`); }
      }));
    }
    flash(res, failed.length ? 'warn' : 'ok', `Duty & China tariff checked for ${ok} product(s).${failed.length ? ` Failed: ${failed.slice(0, 3).join(' | ')}` : ''} Review each result on the product page.`);
    res.redirect('/admin/pricing');
  }));

  router.get('/admin/pricing', G(async (req, res) => {
    const { ctx, items, suppliers } = await S.loadAnalyzed(db);
    const q = { sort: 'margin', ...req.query };
    const list = applyFilters(items, q).slice(0, 300);
    const pendingResearch = items.filter(({ product: p }) => needsDutyResearch(p));
    res.html(page({
      title: 'Pricing', nav: adminNav('pricing'), flash: takeFlash(req, res), wide: true,
      body: html`<h1>Pricing</h1>
      <p class="muted">Landed cost uses each product's costing option (or the default). Suggested wholesale = landed ÷ (1 − category target margin). Edit wholesale/retail and save all at once. For products made in China, the duty and any additional China tariff (Section 301 etc.) are read from the US tariff schedule (USITC) by AI and included in landed cost; a manual duty on the product page always wins.</p>
      <p>${dutyHelp()}</p>
      ${pendingResearch.length ? html`<form method="post" action="/admin/pricing/research-duty" class="inline"><button class="btn">Research duty &amp; China tariff (${pendingResearch.length} product${pendingResearch.length === 1 ? '' : 's'} not checked)</button> <span class="sub">Checks up to 6 at a time with AI. Press again for the rest.</span></form>` : ''}
      ${filterBar(q, ctx, suppliers, '/admin/pricing')}
      <form method="post" action="/admin/pricing"><div class="table-wrap"><table class="list edit">
        <thead><tr><th>Product</th><th class="r">Price USD</th><th class="r">Freight</th><th class="r">Duty</th><th class="r">China tariff</th><th class="r">Fees+ins.</th><th class="r">Landed</th><th class="r">Cheapest option</th><th class="r">Target</th><th class="r">Sugg. wholesale</th><th>Our wholesale</th><th class="r">Our margin</th><th>Retail</th><th class="r">Retailer margin</th><th>Status</th></tr></thead>
        <tbody>${list.map(({ product: p, analysis: a }) => html`<tr>
          <td><a href="/admin/products/${p.id}">${p.product_name}</a><div class="sub">${p.supplier_name} · ${p.category || '—'}</div></td>
          <td class="r">${fmt.money(a.unit_price_usd)}</td>
          <td class="r">${fmt.money(a.primary?.freight_per_unit)}<div class="sub">${a.primary?.mode_label || ''}</div></td>
          <td class="r">${fmt.money(a.primary?.duty_per_unit)}<div class="sub">${a.base_duty_pct}% · ${a.duty_source}</div></td>
          <td class="r">${a.tariff_pct ? html`${fmt.money(a.primary?.tariff_per_unit)}<div class="sub">${a.tariff_pct}%${a.blanket_tariff_pct ? ` (${a.blanket_tariff_pct}% blanket)` : ''}</div>` : chinaOrigin(p) ? (p.duty_ai_checked_at || p.duty_rate_pct !== null && p.duty_rate_pct !== undefined ? (a.tariff_pct ? html`${fmt.money(a.primary?.tariff_per_unit)}<div class="sub">${a.tariff_pct}%</div>` : html`<span class="sub">${a.duty_source === 'manual' ? 'in manual duty' : 'none'}</span>`) : html`<span class="sub warn-text">not researched</span>`) : html`<span class="sub">n/a</span>`}</td>
          <td class="r">${fmt.money(a.primary ? (a.primary.customs_fees_per_unit || 0) + (a.primary.insurance_per_unit || 0) : null)}</td>
          <td class="r"><b>${fmt.money(a.landed_cost)}</b></td>
          <td class="r">${a.cheapest && a.cheapest.option_id !== a.primary?.option_id ? html`${fmt.money(a.cheapest.landed_cost)}<div class="sub">${a.cheapest.mode_label}</div>` : html`<span class="sub">same</span>`}</td>
          <td class="r">${a.pricing.target_margin_pct}%</td>
          <td class="r">${fmt.money(a.pricing.suggested_wholesale)}</td>
          <td><input name="wh_${p.id}" type="number" step="0.01" min="0" value="${p.our_wholesale_usd ?? ''}" placeholder="${a.pricing.suggested_wholesale ?? ''}" class="money"></td>
          <td class="r ${a.margin_pct !== null && a.margin_pct < a.pricing.target_margin_pct ? 'neg' : 'pos'}">${fmt.pct(a.margin_pct)}</td>
          <td><input name="rt_${p.id}" type="number" step="0.01" min="0" value="${p.our_retail_usd ?? ''}" placeholder="${p.suggested_retail_usd ?? ''}" class="money"></td>
          <td class="r">${a.pricing.retailer_margin_pct !== undefined ? fmt.pct(a.pricing.retailer_margin_pct) : '—'}</td>
          <td>${statusPill(p.status)}</td></tr>`)}</tbody></table></div>
        <input type="hidden" name="ids" value="${list.map((i) => i.product.id).join(',')}">
        <div class="form-actions"><button class="btn">Save prices</button> <button class="btn ghost" name="fill" value="1">Fill empty wholesale with suggested</button></div>
      </form>`,
    }));
  }));

  router.post('/admin/pricing', G(async (req, res) => {
    const { fields } = await parseForm(req, { limitBytes: 2_000_000 });
    const ids = String(fields.ids || '').split(',').filter(Boolean);
    const { items } = await S.loadAnalyzed(db, { filters: { id: ['in', ids] } });
    let changed = 0;
    for (const { product: p, analysis: a } of items) {
      let wh = num(fields[`wh_${p.id}`]);
      const rt = num(fields[`rt_${p.id}`]);
      if (fields.fill && wh === null && a.pricing.suggested_wholesale) wh = a.pricing.suggested_wholesale;
      const cur = (v) => (v === null || v === undefined ? null : Number(v));
      if (wh !== cur(p.our_wholesale_usd) || rt !== cur(p.our_retail_usd)) {
        await db.update('products', { id: p.id }, { our_wholesale_usd: wh, our_retail_usd: rt });
        changed++;
      }
    }
    flash(res, 'ok', `${changed} product price(s) updated`);
    const back = req.headers.referer && req.headers.referer.includes('/admin/pricing') ? new URL(req.headers.referer).search : '';
    res.redirect(`/admin/pricing${back}`);
  }));

  // ── AI
  async function coverImages(ids) {
    const out = {};
    if (process.env.AI_INCLUDE_IMAGES === 'false') return out;
    const imgs = await S.imagesFor(db, ids);
    await Promise.all(ids.map(async (id) => {
      const t = imgs[id]?.[0]?.thumb_path;
      if (t) { try { out[id] = await db.storage.download(t); } catch { /* skip */ } }
    }));
    return out;
  }
  const namesOf = (items) => Object.fromEntries(items.map(({ product: p }) => [p.id, { name: p.product_name, supplier: p.supplier_name }]));
  async function save(kind, { title, productIds, category, run, names }) {
    const result = { ...run.result, _names: names };
    return db.insert('ai_analyses', {
      kind, title, product_ids: productIds, category: category || null, model: run.model, result,
      input_tokens: run.usage.input_tokens || null, output_tokens: run.usage.output_tokens || null,
    });
  }
  function needAi() { if (!AI.enabled()) throw new HttpError(400, 'AI is not configured. Add ANTHROPIC_API_KEY in Railway variables.'); }

  // ── Duty & HTS (USITC + AI); manual override and test mode live in admin.js / calc.js
  router.post('/admin/products/:id/duty/research', G(async (req, res) => {
    needAi();
    const { fields } = await parseForm(req);
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    try {
      const r = await Duty.researchDuty(p, { hts: fields.hts });
      await db.update('products', { id: p.id }, Duty.productPatch(r));
      flash(res, r.total_pct === null ? 'warn' : 'ok', r.total_pct === null ? 'HTS found but no percentage rate could be read: enter the duty manually.' : `Duty researched: ${r.total_pct}% for ${r.hts_code}. Review the notes below.`);
    } catch (e) {
      console.error('Duty research failed:', e.message);
      flash(res, 'error', `Duty research failed: ${e.message}`);
    }
    res.redirect(`/admin/products/${p.id}#duty`);
  }));
  router.post('/admin/products/:id/duty/apply-override', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const n = F.parseNumber(fields.duty);
    if (n === null || Number.isNaN(n) || n < 0 || n > 500) { flash(res, 'error', 'Enter a duty % between 0 and 500'); return res.redirect(`/admin/products/${req.params.id}#duty`); }
    await db.update('products', { id: req.params.id }, { duty_rate_pct: n });
    flash(res, 'ok', `Manual duty override set to ${n}%`);
    res.redirect(`/admin/products/${req.params.id}#duty`);
  }));
  router.post('/admin/products/:id/duty/clear-override', G(async (req, res) => {
    await db.update('products', { id: req.params.id }, { duty_rate_pct: null });
    flash(res, 'ok', 'Manual override cleared');
    res.redirect(`/admin/products/${req.params.id}#duty`);
  }));

  router.post('/admin/products/:id/ai-review', G(async (req, res) => {
    needAi();
    const { items, ctx } = await S.loadAnalyzed(db, { filters: { id: req.params.id } });
    const it = items[0];
    if (!it) throw new HttpError(404, 'Product not found');
    const imgs = await coverImages([it.product.id]);
    const run = await AI.reviewProduct({ product: it.product, analysis: it.analysis, supplierName: it.product.supplier_name, category: ctx.categories.find((c) => c.name === it.product.category), image: imgs[it.product.id] });
    await save('product_review', { title: `Review: ${it.product.product_name}`, productIds: [it.product.id], category: it.product.category, run, names: namesOf(items) });
    flash(res, 'ok', 'AI review ready (see AI analyses below)');
    res.redirect(`/admin/products/${it.product.id}`);
  }));

  router.post('/admin/products/:id/ai-similar', G(async (req, res) => {
    needAi();
    const { items } = await S.loadAnalyzed(db);
    const target = items.find((i) => i.product.id === req.params.id);
    if (!target) throw new HttpError(404, 'Product not found');
    const cands = AI.rankCandidates(target.product, items.map((i) => i.product), { limit: 12 });
    if (!cands.length) { flash(res, 'warn', 'No products from other suppliers look similar yet'); return res.redirect(`/admin/products/${target.product.id}`); }
    const candItems = cands.map((p) => items.find((i) => i.product.id === p.id));
    const imgs = await coverImages([target.product.id, ...cands.slice(0, 7).map((p) => p.id)]);
    const run = await AI.findSimilar({ target: target.product, targetAnalysis: target.analysis, candidates: candItems, images: imgs });
    await save('similar', { title: `Similar to: ${target.product.product_name}`, productIds: [target.product.id, ...(run.result.matches || []).map((m) => m.product_id).filter((id) => candItems.some((c) => c.product.id === id))], category: target.product.category, run, names: namesOf([target, ...candItems]) });
    flash(res, 'ok', `AI checked ${cands.length} candidates from other suppliers`);
    res.redirect(`/admin/products/${target.product.id}`);
  }));

  router.post('/admin/ai/compare', G(async (req, res) => {
    needAi();
    await parseForm(req, { limitBytes: 1_000_000 }).catch(() => null);
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 8);
    if (ids.length < 2) { flash(res, 'warn', 'Select 2–8 products to compare'); return res.redirect('/admin/products'); }
    const { items } = await S.loadAnalyzed(db, { filters: { id: ['in', ids] } });
    const imgs = await coverImages(ids);
    const run = await AI.compareProducts({ items, images: imgs });
    const an = await save('compare', { title: `Compare: ${items.map((i) => i.product.product_name).join(' vs ').slice(0, 200)}`, productIds: ids, run, names: namesOf(items) });
    res.redirect(`/admin/ai/${an.id}`);
  }));

  router.post('/admin/ai/category', G(async (req, res) => {
    needAi();
    const { fields } = await parseForm(req);
    const category = String(fields.category || '');
    const { items } = await S.loadAnalyzed(db, { filters: { category } });
    const pool = items.filter((i) => i.product.status !== 'Rejected').slice(0, 80);
    if (new Set(pool.map((i) => i.product.supplier_id)).size < 2) { flash(res, 'warn', 'Need products from at least 2 suppliers in this category'); return res.redirect('/admin/ai'); }
    const run = await AI.matchCategory({ category, items: pool });
    const ids = [...new Set((run.result.groups || []).flatMap((g) => g.product_ids))].filter((id) => pool.some((i) => i.product.id === id));
    const an = await save('category_match', { title: `Matches in ${category}`, productIds: ids, category, run, names: namesOf(pool) });
    res.redirect(`/admin/ai/${an.id}`);
  }));

  router.get('/admin/ai', G(async (req, res) => {
    const [ctx, analyses] = await Promise.all([S.getCtx(db), db.list('ai_analyses', { order: 'created_at.desc', limit: 100, select: 'id,kind,title,created_at,model,input_tokens,output_tokens' })]);
    res.html(page({
      title: 'AI', nav: adminNav('ai'), flash: takeFlash(req, res), wide: true,
      body: html`<h1>AI analysis</h1>
      ${AI.enabled() ? html`<p class="muted">Model: <code>${AI.model()}</code>. Calculations are done by the system; AI reviews, matches and explains. Verify HS codes and duty before acting.</p>`
        : html`<div class="flash warn">AI is off. Add <code>ANTHROPIC_API_KEY</code> (and optionally <code>ANTHROPIC_MODEL</code>) in Railway → Variables.</div>`}
      <div class="cols">
        <section class="card"><h2>Match products across suppliers</h2>
          <p>Groups the same or equivalent items from different factories in a category and explains the price spread.</p>
          <form method="post" action="/admin/ai/category" class="inline-form"><select name="category">${ctx.categoryNames.map((c) => html`<option>${c}</option>`)}</select><button class="btn" data-busy ${AI.enabled() ? '' : 'disabled'}>Run</button></form></section>
        <section class="card"><h2>Other AI tools</h2><ul>
          <li><b>AI review</b> and <b>Find similar</b>: on any product page.</li>
          <li><b>AI compare</b>: select 2–8 products in <a href="/admin/products">Products</a>.</li></ul></section>
      </div>
      <section class="card"><h2>History</h2>
        <table class="list compact"><thead><tr><th>When</th><th>Type</th><th>Title</th><th class="r">Tokens</th></tr></thead>
        <tbody>${analyses.map((a) => html`<tr><td>${fmt.date(a.created_at)}</td><td>${a.kind.replace('_', ' ')}</td><td><a href="/admin/ai/${a.id}">${a.title || a.kind}</a></td><td class="r">${fmt.num((a.input_tokens || 0) + (a.output_tokens || 0))}</td></tr>`)}</tbody></table></section>`,
    }));
  }));

  router.get('/admin/ai/:id', G(async (req, res) => {
    const an = await db.get('ai_analyses', req.params.id);
    if (!an) throw new HttpError(404, 'Analysis not found');
    res.html(page({ title: an.title || 'AI analysis', nav: adminNav('ai'), wide: true, body: html`<h1>${an.title || an.kind}</h1><p class="muted">${fmt.date(an.created_at)}</p><section class="card">${renderAnalysis(an)}</section>` }));
  }));

  // ── Settings
  router.get('/admin/settings', G(async (req, res) => {
    const [ctx, usageRows] = await Promise.all([S.getCtx(db), db.list('storage_usage', { limit: 1 })]);
    const s = ctx.settings;
    const usage = usageRows[0] || { image_count: 0, total_bytes: 0 };
    const avgPerImage = usage.image_count ? usage.total_bytes / usage.image_count : 300 * 1024;
    const capacity = Math.floor((config.storagePlanGb * 1024 ** 3) / avgPerImage);
    res.html(page({
      title: 'Settings', nav: adminNav('settings'), flash: takeFlash(req, res),
      body: html`<h1>Settings</h1>
      <form method="post" action="/admin/settings" class="card">
        <h2>Costing defaults</h2>
        <div class="grid">
          <label><span class="lbl">Default duty % (if category has none)</span><input name="default_duty_pct" type="number" step="0.01" min="0" value="${s.default_duty_pct}"></label>
          <label><span class="lbl">Default target margin %</span><input name="default_target_margin_pct" type="number" step="0.1" min="0" max="95" value="${s.default_target_margin_pct}"></label>
          <label><span class="lbl">Blanket extra tariff % on China-made goods</span><input name="china_extra_tariff_pct" type="number" step="0.01" min="0" max="500" value="${s.china_extra_tariff_pct ?? 0}"></label>
          <p class="sub" style="grid-column:1/-1;margin:0">Added to every China-made product's landed cost (country of origin China or blank), except products with a manual duty. Use it for measures that apply to all Chinese goods (check the current rate on cbp.gov or with your broker). If AI web research already counts the same measure, leave this at 0 to avoid double counting.</p>
          <label><span class="lbl">Cargo insurance % of goods value</span><input name="insurance_pct" type="number" step="0.01" min="0" value="${s.insurance_pct}"></label>
        </div>
        <h2>Exchange rates (1 unit → USD)</h2>
        <div class="grid">${Object.entries(s.fx_to_usd || {}).map(([c, r]) => html`<label><span class="lbl">${c}</span><input name="fx_${c}" type="number" step="any" min="0" value="${r}" ${c === 'USD' ? 'readonly' : ''}></label>`)}
          <label><span class="lbl">Add currency (code=rate)</span><input name="fx_new" placeholder="GBP=1.27"></label></div>
        <p class="muted">Update the rates when you finalise orders; quotes in other currencies are converted with them.</p>
        <div class="form-actions"><button class="btn">Save settings</button></div>
      </form>
      <section class="card" id="storage"><h2>Image storage</h2>
        <dl class="kv"><dt>Photos stored</dt><dd>${fmt.num(usage.image_count)}</dd><dt>Space used</dt><dd>${fmt.bytes(usage.total_bytes)} of ${config.storagePlanGb} GB plan</dd>
          <dt>Average per photo</dt><dd>${fmt.bytes(avgPerImage)} (full size + thumbnail)</dd><dt>Room for about</dt><dd>${fmt.num(capacity)} photos</dd></dl>
        <p class="muted">Uploads are converted to WebP (≤1600 px plus a 400 px thumbnail) and originals are discarded. Set <code>STORAGE_PLAN_GB</code> to match your Supabase plan (Free = 1, Pro = 100).</p>
      </section>`,
    }));
  }));

  router.post('/admin/settings', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ctx = await S.getCtx(db);
    const fx = { ...(ctx.settings.fx_to_usd || {}), USD: 1 };
    for (const c of Object.keys(fx)) { const v = num(fields[`fx_${c}`]); if (c !== 'USD' && v !== null && v > 0) fx[c] = v; }
    const m = String(fields.fx_new || '').match(/^\s*([A-Za-z]{3})\s*=\s*([\d.]+)\s*$/);
    if (m && Number(m[2]) > 0) fx[m[1].toUpperCase()] = Number(m[2]);
    await db.update('settings', { id: 1 }, {
      default_duty_pct: num(fields.default_duty_pct) ?? 0, default_target_margin_pct: Math.min(95, num(fields.default_target_margin_pct) ?? 40),
      insurance_pct: num(fields.insurance_pct) ?? 0,
      ...((num(fields.china_extra_tariff_pct) ?? 0) !== Number(ctx.settings.china_extra_tariff_pct ?? 0) ? { china_extra_tariff_pct: Math.min(500, num(fields.china_extra_tariff_pct) ?? 0) } : {}),
      fx_to_usd: fx, updated_at: new Date().toISOString(),
    });
    S.invalidate('ctx');
    flash(res, 'ok', 'Settings saved');
    res.redirect('/admin/settings');
  }));

  // ── CSV export
  router.get('/admin/export.csv', G(async (req, res) => {
    const { items } = await S.loadAnalyzed(db);
    const list = applyFilters(items, req.query);
    const cols = [
      ['Supplier', (p) => p.supplier_name], ...F.PRODUCT_FIELDS.map((f) => [f.csv, (p) => p[f.key]]),
      ['Status', (p) => p.status], ['Target Stores', (p) => p.target_stores], ['Score', (p) => p.score],
      ['Unit Price USD', (p, a) => a.unit_price_usd], ['Carton CBM', (p, a) => a.carton_cbm], ['Unit CBM', (p, a) => a.unit_cbm],
      ['Units/20GP', (p, a) => a.fits['20GP']?.units], ['Units/40GP', (p, a) => a.fits['40GP']?.units], ['Units/40HQ', (p, a) => a.fits['40HQ']?.units],
      ['Costing Option', (p, a) => a.primary?.name], ['Freight/Unit', (p, a) => a.primary?.freight_per_unit], ['Duty %', (p, a) => a.duty_pct],
      ['Landed Cost', (p, a) => a.landed_cost], ['Target Margin %', (p, a) => a.pricing.target_margin_pct], ['Suggested Wholesale', (p, a) => a.pricing.suggested_wholesale],
      ['Our Wholesale', (p) => p.our_wholesale_usd], ['Our Retail', (p) => p.our_retail_usd], ['Our Margin %', (p, a) => a.margin_pct],
      ['Issues', (p, a) => a.issues], ['Review Notes', (p) => p.review_notes], ['Created', (p) => p.created_at],
    ];
    const lines = [cols.map((c) => csvCell(c[0])).join(',')];
    for (const { product: p, analysis: a } of list) lines.push(cols.map((c) => csvCell(c[1](p, a))).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lulyboo-products-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.end('﻿' + lines.join('\r\n'));
  }));
};
