'use strict';
// Admin: login, dashboard, products, compare, suppliers (CRM).
const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash, sign, unsign } = require('../lib/http');
const { page, adminNav, productFields, imageGrid, photoSection, pager, statusPill } = require('../views/layout');
const F = require('../fields');
const { analyzeProduct } = require('../calc');
const S = require('../services');
const { saveProductImages, deleteImages } = require('../images');
const { runImport, importResult } = require('./supplier');
const { renderAnalysis } = require('../views/ai');
const A = require('../auth');
const { createInvite, INVITE_DAYS } = require('./supplier-auth');

const CRM_STATUSES = ['Prospect', 'Contacted', 'Quoting', 'Active', 'On hold', 'Blocked'];
const ACTIVITY_TYPES = ['Call', 'Email', 'WeChat/WhatsApp', 'Meeting', 'Factory visit', 'Sample', 'Quote', 'Note'];
const PER_PAGE = 50;
const today = () => new Date().toISOString().slice(0, 10);
const avg = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))); return v.length ? v.reduce((a, b) => a + Number(b), 0) / v.length : null; };

const usitcLink = (code) => `https://hts.usitc.gov/search?query=${encodeURIComponent(String(code || '').replace(/\D/g, ''))}`;
/** "How is duty decided?" help: a ? button that opens a short dialog. Used on the product duty panel and the Pricing page. */
function dutyHelp() {
  return html`<button type="button" class="btn ghost small help-btn" data-open-dialog="duty-help" aria-haspopup="dialog">? How duty is calculated</button>
  <dialog id="duty-help" class="help-dialog">
    <div class="help-head"><h2>How duty &amp; tariffs are calculated</h2><button type="button" class="btn ghost small" data-close-dialog aria-label="Close">✕</button></div>
    <ol class="help-steps">
      <li><strong>HTS code.</strong> Admin-entered code → else the supplier's HS code → else AI suggests one from the product name, materials and category.</li>
      <li><strong>Base duty.</strong> Read from the US tariff schedule (hts.usitc.gov), "General" column of that code's line. “Free” = 0%. Rates like “6.8¢/kg + 10%”: only the % part is counted (flagged).</li>
      <li><strong>China additional tariffs</strong> (Section 301 etc., Chapter 99 headings 9903.xx.xx). Added only if the AI confirms they apply to this code <em>and</em> the rate comes from USITC data or web research. Unconfirmed ones are shown but <em>not</em> counted.</li>
      <li><strong>Blanket China tariff.</strong> A % you enter in Settings for measures that apply to all Chinese goods. Added to every China-made product (origin China or blank) unless it has a manual duty. Keep it at 0 if AI web research already counts the same measure.</li>
      <li><strong>Total duty</strong> = base + confirmed additional tariffs + blanket China tariff. Percentages are applied to the factory price (FOB value).</li>
      <li><strong>Rate used in landed cost</strong>, first one that exists:<br>① Admin manual override (replaces everything, tariff included) → ② AI / USITC total → ③ Category default → ④ Global default (Settings).</li>
      <li><strong>Also added to landed cost:</strong> MPF 0.3464%, HMF 0.125% (ocean only) and insurance. DDP price: duty is not added; CIF: insurance is not added.</li>
    </ol>
    <h3>Quick check by hand</h3>
    <ol class="help-steps">
      <li>Open the code on <a href="https://hts.usitc.gov/" target="_blank" rel="noopener">hts.usitc.gov</a>: compare the General rate and read the footnotes for 9903 references.</li>
      <li>Check China tariff rates on <a href="https://ustr.gov/issue-areas/enforcement/section-301-investigations/tariff-actions" target="_blank" rel="noopener">USTR Section 301 actions</a>. Other measures (e.g. IEEPA) change often, so confirm the current rate on cbp.gov or with your broker.</li>
      <li>Unsure which code fits? Search similar past rulings on <a href="https://rulings.cbp.gov/" target="_blank" rel="noopener">CBP CROSS</a>.</li>
      <li>Disagree with the result? Use <strong>② Test a different duty rate</strong> to see the effect, then <strong>Apply as manual override</strong>.</li>
    </ol>
    <p class="sub">AI results are a starting point, not customs advice. A wrong HTS code gives a wrong rate, so confirm the code first.</p>
  </dialog>`;
}

/** Read-only summary of everything the supplier submitted, grouped as text blocks beside the photos. */
function productDetails({ p, imgs, urls }) {
  const val = (x, suffix = '') => (x === null || x === undefined || String(x).trim() === '' ? html`<span class="none">—</span>` : html`${x}${suffix}`);
  const row = (label, x, suffix) => html`<dt>${label}</dt><dd>${val(x, suffix)}</dd>`;
  const dims = [p.carton_l_cm, p.carton_w_cm, p.carton_h_cm];
  const carton = dims.every((d) => d !== null && d !== undefined) ? `${dims.join(' × ')} cm` : null;
  const hero = imgs[0];
  return html`<section class="card pd" id="details">
    <div class="pd-grid">
      <div class="pd-photos">
        ${hero ? html`<a class="pd-hero" href="${urls[hero.path]}" target="_blank" rel="noopener"><img src="${urls[hero.path] || urls[hero.thumb_path]}" alt="${p.product_name}"></a>
          ${imgs.length > 1 ? html`<div class="pd-thumbs">${imgs.slice(1, 9).map((im) => html`<a href="${urls[im.path]}" target="_blank" rel="noopener"><img src="${urls[im.thumb_path]}" alt="" loading="lazy"></a>`)}${imgs.length > 9 ? html`<span class="sub">+${imgs.length - 9} more below</span>` : ''}</div>` : ''}`
          : html`<div class="pd-hero empty">No photo yet</div>`}
        ${p.photo_link ? html`<p class="sub"><a href="${p.photo_link}" target="_blank" rel="noopener noreferrer">Supplier photo / catalog link ↗</a></p>` : ''}
      </div>
      <div class="pd-blocks">
        <div class="pd-block pd-wide"><h3>Product</h3>
          <p class="pd-desc">${p.description ? p.description : html`<span class="none">No description given</span>`}</p>
          <dl class="kv">
            ${row('Materials', p.materials)}
            ${row('Product size (L×W×H)', p.product_size_cm, ' cm')}
            ${row('Unit net weight', p.unit_net_weight_kg, ' kg')}
            ${row('Packaging', p.packaging_type)}
            ${row('Certifications', p.certifications)}
            ${row('Battery / magnet / liquid', p.dangerous_goods)}
            ${row('HS code (supplier)', p.hs_code)}
            ${row('Country of origin', p.country_of_origin)}
            ${row('Brand', p.brand)}
          </dl></div>
        <div class="pd-block"><h3>Price &amp; terms</h3>
          <dl class="kv">
            ${row('Unit price', p.unit_price === null || p.unit_price === undefined ? null : fmt.money(p.unit_price, p.currency))}
            ${row('Incoterm', [p.incoterm, p.fob_port].filter(Boolean).join(' · '))}
            ${row('MOQ', p.moq === null || p.moq === undefined ? null : fmt.num(p.moq), ' units')}
            ${row('Payment', p.payment_terms)}
            ${row('Sample lead time', p.sample_lead_days, ' days')}
            ${row('Production lead time', p.production_lead_days, ' days')}
            ${row('Quote valid until', p.quote_valid_until ? fmt.date(p.quote_valid_until) : null)}
          </dl></div>
        <div class="pd-block"><h3>Packing</h3>
          <dl class="kv">
            ${row('Units per carton', p.units_per_carton)}
            ${row('Units per inner pack', p.units_per_inner)}
            ${row('Master carton size', carton)}
            ${row('Carton weight (net / gross)', p.carton_nw_kg !== null && p.carton_nw_kg !== undefined || p.carton_gw_kg !== null && p.carton_gw_kg !== undefined ? `${p.carton_nw_kg ?? '—'} / ${p.carton_gw_kg ?? '—'} kg` : null)}
            ${row('Supplier says per container', [p.supplier_qty_20gp && `20GP ${fmt.num(p.supplier_qty_20gp)}`, p.supplier_qty_40gp && `40GP ${fmt.num(p.supplier_qty_40gp)}`, p.supplier_qty_40hq && `40HQ ${fmt.num(p.supplier_qty_40hq)}`].filter(Boolean).join(' · '))}
          </dl></div>
        ${p.factory_notes ? html`<div class="pd-block pd-wide"><h3>Factory notes</h3><p class="pd-desc">${p.factory_notes}</p></div>` : ''}
      </div>
    </div>
  </section>`;
}

function dutyPanel({ p, a, testDuty, aiOn }) {
  const d = p.duty_ai_detail || null;
  const manual = p.duty_rate_pct !== null && p.duty_rate_pct !== undefined;
  const code = p.hts_verified_code || p.hs_code || '';
  return html`<section class="card duty-card" id="duty">
    <h2>Duty &amp; HTS <span class="pill ${a.duty_source === 'manual' ? 's-reviewing' : a.duty_source === 'AI / USITC' ? 's-selected' : ''}">using ${a.duty_pct}% · ${a.duty_source}</span></h2>
    <p class="muted">${dutyHelp()}</p>
    <p class="muted">Main source: US tariff schedule (USITC) read by AI. A manual override always wins. Supplier's HS code: <strong>${p.hs_code || '—'}</strong> · Origin: <strong>${p.country_of_origin || 'not given (China assumed)'}</strong></p>
    <form method="post" action="/admin/products/${p.id}/duty/research" class="inline-form">
      <label><span class="lbl">① HTS code to verify (the tariff code, e.g. 9503.00.00.73)</span><input name="hts" value="${code}" placeholder="e.g. 9503.00.00.73" inputmode="text" autocomplete="off"></label>
      <button class="btn" data-busy ${aiOn ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Check with USITC + AI</button>
      ${code ? html`<a class="btn ghost" target="_blank" rel="noopener" href="${usitcLink(code)}">Open on hts.usitc.gov ↗</a>` : ''}
    </form>
    ${d ? html`
      <dl class="kv duty-kv">
        <dt>HTS line</dt><dd><strong>${d.hts_code}</strong> <span class="sub">${d.hts_description || ''}</span></dd>
        <dt>Base rate (USITC)</dt><dd>${d.base_rate_pct === null ? 'not readable' : `${d.base_rate_pct}%`} <span class="sub">“${d.general_rate_text || ''}”</span></dd>
        ${(d.additional || []).length ? html`<dt>Additional measures</dt><dd><ul class="plain">${d.additional.map((x) => html`<li>${x.counted ? '✔' : '○'} ${x.label}${x.heading ? ` (${x.heading})` : ''}: <strong>${x.rate_pct === null ? 'rate unknown' : `+${x.rate_pct}%`}</strong> <span class="sub">${x.counted ? 'counted' : x.applies ? 'applies but NOT counted' : 'does not apply'} · ${x.basis}${x.note ? ` · ${x.note}` : ''}</span></li>`)}</ul></dd>` : ''}
        <dt class="strong">AI total</dt><dd class="strong">${d.total_pct === null ? '—' : `${d.total_pct}%`} <span class="pill ${d.confidence === 'high' ? 's-selected' : d.confidence === 'low' ? 's-rejected' : 's-reviewing'}">${d.confidence} confidence</span> <span class="sub">checked ${fmt.date(d.checked_at)}${d.web_research_used ? ' · with web research' : ''}</span></dd>
      </dl>
      <p>${d.summary || ''}</p>
      ${d.classification_note ? html`<p class="muted">${d.classification_note}</p>` : ''}
      ${(d.review_flags || []).length ? html`<div class="flash warn"><strong>Verify:</strong><ul class="plain">${d.review_flags.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
      ${(d.alternatives || []).length ? html`<details><summary>Other tariff lines considered (${d.alternatives.length})</summary><ul class="plain">${d.alternatives.map((x) => html`<li><strong>${x.htsno}</strong> ${x.general} <span class="sub">${x.description}</span></li>`)}</ul></details>` : ''}
    ` : html`<p class="muted">Not researched yet. Enter or confirm the HTS code in box ① above and press “Check with USITC + AI”.</p>`}
    <div class="duty-actions">
      <form method="get" action="/admin/products/${p.id}#duty" class="inline-form">
        <label><span class="lbl">② Test a different duty RATE in % (what-if, not saved): type a percentage, not an HTS code</span><input name="test_duty" type="number" step="0.01" min="0" max="500" value="${testDuty ?? ''}" placeholder="e.g. ${a.duty_pct}"></label>
        <button class="btn ghost">Test</button>
      </form>
      ${manual ? html`<form method="post" action="/admin/products/${p.id}/duty/clear-override" class="inline-form"><span class="sub">Manual override ${p.duty_rate_pct}% is active.</span> <button class="btn ghost small">Clear override${p.duty_ai_pct !== null && p.duty_ai_pct !== undefined ? ` (back to AI ${p.duty_ai_pct}%)` : ''}</button></form>` : ''}
    </div>
  </section>`;
}

// ── Auth ──────────────────────────────────────────────────────
const loginAttempts = new Map();
function isAdmin(req, config) {
  const v = unsign(req.cookies.lb_admin, config.sessionSecret);
  if (!v) return false;
  const [who, exp] = v.split(':');
  return who === 'admin' && Number(exp) > Date.now();
}
function guard(config, fn) {
  return async (req, res) => {
    if (!isAdmin(req, config)) return res.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`);
    return fn(req, res);
  };
}

// ── Shared filter logic ───────────────────────────────────────
function applyFilters(items, q) {
  let out = items;
  if (q.status) out = out.filter((i) => i.product.status === q.status);
  if (q.category) out = out.filter((i) => (i.product.category || '') === q.category);
  if (q.supplier) out = out.filter((i) => i.product.supplier_id === q.supplier);
  if (q.store) out = out.filter((i) => (i.product.target_stores || []).includes(q.store));
  if (q.issues === '1') out = out.filter((i) => i.analysis.issues.length);
  if (q.q) {
    const t = q.q.toLowerCase();
    out = out.filter(({ product: p }) => [p.product_name, p.supplier_sku, p.subcategory, p.materials, p.supplier_name, p.description].some((v) => v && String(v).toLowerCase().includes(t)));
  }
  const by = {
    newest: (a, b) => String(b.product.created_at).localeCompare(String(a.product.created_at)),
    landed: (a, b) => (a.analysis.landed_cost ?? Infinity) - (b.analysis.landed_cost ?? Infinity),
    margin: (a, b) => (b.analysis.margin_pct ?? -Infinity) - (a.analysis.margin_pct ?? -Infinity),
    price: (a, b) => (a.analysis.unit_price_usd ?? Infinity) - (b.analysis.unit_price_usd ?? Infinity),
    score: (a, b) => (b.product.score ?? 0) - (a.product.score ?? 0),
    moq: (a, b) => (a.product.moq ?? Infinity) - (b.product.moq ?? Infinity),
  };
  return [...out].sort(by[q.sort] || by.newest);
}

function filterBar(q, ctx, suppliers, action = '/admin/products') {
  const sel = (name, opts, label) => html`<select name="${name}"><option value="">${label}</option>${opts.map(([v, l]) => html`<option value="${v}" ${q[name] === v ? raw('selected') : ''}>${l}</option>`)}</select>`;
  return html`<form class="filters" method="get" action="${action}">
    <input type="search" name="q" placeholder="Search name, SKU, material, supplier" value="${q.q || ''}">
    ${sel('category', ctx.categoryNames.map((c) => [c, c]), 'All categories')}
    ${sel('status', F.STATUSES.map((s) => [s, s]), 'All statuses')}
    ${sel('supplier', suppliers.map((s) => [s.id, s.name]).sort((a, b) => a[1].localeCompare(b[1])), 'All suppliers')}
    ${sel('store', F.STORES.map((s) => [s, s]), 'Any store')}
    ${sel('sort', [['newest', 'Newest'], ['landed', 'Landed cost ↑'], ['margin', 'Margin ↓'], ['price', 'Factory price ↑'], ['score', 'Score ↓'], ['moq', 'MOQ ↑']], 'Sort')}
    <label class="chk"><input type="checkbox" name="issues" value="1" ${q.issues === '1' ? raw('checked') : ''}> Has issues</label>
    <button class="btn small">Apply</button>
  </form>`;
}

module.exports = function adminRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  // ── Login
  router.get('/admin/login', async (req, res) => {
    if (!config.adminPassword) return res.html(page({ title: 'Admin', admin: true, body: html`<section class="card narrow"><h1>Admin not configured</h1><p>Set the <code>ADMIN_PASSWORD</code> environment variable and restart.</p></section>` }), 503);
    res.html(page({
      title: 'Admin login', admin: true, flash: takeFlash(req, res),
      body: html`<section class="card narrow"><h1>Admin login</h1>
      <form method="post" action="/admin/login"><input type="hidden" name="next" value="${req.query.next || '/admin'}">
      <label><span class="lbl">Password</span><input type="password" name="password" autofocus required></label>
      <div class="form-actions"><button class="btn">Log in</button></div></form></section>`,
    }));
  });
  router.post('/admin/login', async (req, res) => {
    const ip = req.socket.remoteAddress || 'x';
    const rec = loginAttempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - rec.t > 15 * 60_000) { rec.n = 0; rec.t = Date.now(); }
    if (rec.n >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { fields } = await parseForm(req);
    const a = crypto.createHash('sha256').update(String(fields.password || '')).digest();
    const b = crypto.createHash('sha256').update(String(config.adminPassword || '')).digest();
    if (!config.adminPassword || !crypto.timingSafeEqual(a, b)) {
      rec.n++; loginAttempts.set(ip, rec);
      flash(res, 'error', 'Wrong password');
      return res.redirect('/admin/login');
    }
    loginAttempts.delete(ip);
    const days = 14;
    res.setCookie('lb_admin', sign(`admin:${Date.now() + days * 86400_000}`, config.sessionSecret), { maxAge: days * 86400 });
    const next = String(fields.next || '/admin');
    res.redirect(next.startsWith('/admin') ? next : '/admin');
  });
  router.get('/admin/logout', async (req, res) => { res.setCookie('lb_admin', '', { maxAge: 0 }); res.redirect('/admin/login'); });

  // ── Dashboard
  router.get('/admin', G(async (req, res) => {
    const [{ ctx, items, suppliers }, activities, usageRows, supFull] = await Promise.all([
      S.loadAnalyzed(db),
      db.list('supplier_activities', { filters: { done: false, follow_up_date: ['lte', today()] }, order: 'follow_up_date.asc' }),
      db.list('storage_usage', { limit: 1 }),
      db.list('suppliers', { order: 'name.asc' }),
    ]);
    const usage = usageRows[0] || { image_count: 0, total_bytes: 0 };
    const supName = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
    const count = (st) => items.filter((i) => i.product.status === st).length;
    const pipeline = ['Shortlisted', 'Sample requested', 'Selected'].reduce((a, s) => a + count(s), 0);
    const followUps = [
      ...activities.map((a) => ({ date: a.follow_up_date, supplier_id: a.supplier_id, text: a.summary })),
      ...supFull.filter((s) => s.next_follow_up && s.next_follow_up <= today()).map((s) => ({ date: s.next_follow_up, supplier_id: s.id, text: 'Follow up' })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const cats = [...new Set([...ctx.categoryNames, ...items.map((i) => i.product.category || 'Uncategorized')])];
    const catRows = cats.map((c) => {
      const its = items.filter((i) => (i.product.category || 'Uncategorized') === c);
      return {
        c, n: its.length, sup: new Set(its.map((i) => i.product.supplier_id)).size,
        landed: avg(its.map((i) => i.analysis.landed_cost)), margin: avg(its.map((i) => i.analysis.margin_pct)),
        short: its.filter((i) => ['Shortlisted', 'Sample requested', 'Selected'].includes(i.product.status)).length,
        fresh: its.filter((i) => i.product.status === 'New').length,
      };
    }).filter((r) => r.n || ctx.categoryNames.includes(r.c));
    const maxN = Math.max(1, ...catRows.map((r) => r.n));

    const supRows = supFull.map((s) => {
      const its = items.filter((i) => i.product.supplier_id === s.id);
      return { s, n: its.length, margin: avg(its.map((i) => i.analysis.margin_pct)), short: its.filter((i) => ['Shortlisted', 'Sample requested', 'Selected'].includes(i.product.status)).length };
    }).sort((a, b) => b.n - a.n).slice(0, 12);
    const storagePlanGb = config.storagePlanGb;
    const usedPct = Math.min(100, (usage.total_bytes / (storagePlanGb * 1024 ** 3)) * 100);
    const recent = items.slice(0, 8);
    const withIssues = items.filter((i) => i.analysis.issues.length).length;

    res.html(page({
      title: 'Dashboard', nav: adminNav('dashboard'), flash: takeFlash(req, res), wide: true,
      body: html`
      <h1>Dashboard</h1>
      <div class="kpis">
        <a class="kpi" href="/admin/suppliers"><b>${fmt.num(suppliers.length)}</b><span>Suppliers</span><small>${supFull.filter((s) => s.crm_status === 'Active').length} active</small></a>
        <a class="kpi" href="/admin/products"><b>${fmt.num(items.length)}</b><span>Products</span><small>${withIssues} with data issues</small></a>
        <a class="kpi accent" href="/admin/products?status=New"><b>${fmt.num(count('New'))}</b><span>New to review</span></a>
        <a class="kpi" href="/admin/products?status=Shortlisted"><b>${fmt.num(pipeline)}</b><span>Shortlisted → Selected</span><small>${count('Selected')} selected</small></a>
        <a class="kpi ${followUps.length ? 'warn' : ''}" href="/admin/suppliers?followup=1"><b>${followUps.length}</b><span>Follow-ups due</span></a>
        <a class="kpi" href="/admin/settings#storage"><b>${fmt.bytes(usage.total_bytes)}</b><span>Image storage</span><small>${fmt.num(usage.image_count)} photos · ${usedPct.toFixed(1)}% of ${storagePlanGb} GB</small></a>
      </div>

      <div class="cols">
        <section class="card">
          <h2>By category</h2>
          <div class="table-wrap"><table class="list compact"><thead><tr><th>Category</th><th class="r">Products</th><th></th><th class="r">Suppliers</th><th class="r">New</th><th class="r">Shortlisted+</th><th class="r">Avg landed</th><th class="r">Avg margin</th></tr></thead>
          <tbody>${catRows.map((r) => html`<tr>
            <td><a href="/admin/products?category=${encodeURIComponent(r.c)}">${r.c}</a></td><td class="r">${r.n}</td>
            <td class="bar-cell"><span class="bar" style="width:${Math.round((r.n / maxN) * 100)}%"></span></td>
            <td class="r">${r.sup}</td><td class="r">${r.fresh}</td><td class="r">${r.short}</td>
            <td class="r">${fmt.money(r.landed)}</td><td class="r">${fmt.pct(r.margin)}</td></tr>`)}</tbody></table></div>
        </section>
        <section class="card">
          <h2>Follow-ups due</h2>
          ${followUps.length ? html`<ul class="feed">${followUps.slice(0, 10).map((f) => html`<li><span class="date ${f.date < today() ? 'late' : ''}">${fmt.date(f.date)}</span> <a href="/admin/suppliers/${f.supplier_id}">${supName[f.supplier_id] || 'Supplier'}</a>: ${f.text}</li>`)}</ul>` : html`<p class="muted">Nothing due.</p>`}
        </section>
      </div>

      <div class="cols">
        <section class="card">
          <h2>Suppliers</h2>
          <div class="table-wrap"><table class="list compact"><thead><tr><th>Supplier</th><th>Status</th><th class="r">Products</th><th class="r">Shortlisted+</th><th class="r">Avg margin</th><th>Rating</th></tr></thead>
          <tbody>${supRows.map((r) => html`<tr><td><a href="/admin/suppliers/${r.s.id}">${r.s.name}</a></td><td>${r.s.crm_status}</td><td class="r">${r.n}</td><td class="r">${r.short}</td><td class="r">${fmt.pct(r.margin)}</td><td>${r.s.rating ? '★'.repeat(r.s.rating) : '—'}</td></tr>`)}</tbody></table></div>
          <p><a href="/admin/suppliers">All suppliers →</a></p>
        </section>
        <section class="card">
          <h2>Latest submissions</h2>
          <table class="list compact"><tbody>${recent.map(({ product: p, analysis: a }) => html`<tr>
            <td><a href="/admin/products/${p.id}">${p.product_name}</a><div class="sub">${p.supplier_name} · ${fmt.date(p.created_at)}</div></td>
            <td class="r">${fmt.money(a.landed_cost)}<div class="sub">landed</div></td><td>${statusPill(p.status)}</td></tr>`)}</tbody></table>
          <p><a href="/admin/products">All products →</a></p>
        </section>
      </div>`,
    }));
  }));

  // ── Products list
  router.get('/admin/products', G(async (req, res) => {
    const { ctx, items, suppliers } = await S.loadAnalyzed(db);
    const filtered = applyFilters(items, req.query);
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const slice = filtered.slice((pageNo - 1) * PER_PAGE, pageNo * PER_PAGE);
    const imgs = await S.imagesFor(db, slice.map((i) => i.product.id));
    const urls = await db.storage.signedUrls(slice.map((i) => imgs[i.product.id]?.[0]?.thumb_path));
    const exportQ = new URLSearchParams(Object.entries(req.query).filter(([k]) => k !== 'page'));
    res.html(page({
      title: 'Products', nav: adminNav('products'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="head-row"><h1>Products</h1><div class="actions"><a class="btn ghost small" href="/admin/export.csv?${exportQ}">Export CSV</a></div></div>
      ${filterBar(req.query, ctx, suppliers)}
      <form method="post" action="/admin/products/bulk" id="bulk">
      <div class="bulkbar">
        <span data-selcount>0 selected</span>
        <select name="status"><option value="">Set status…</option>${F.STATUSES.map((s) => html`<option>${s}</option>`)}</select>
        <button class="btn small" name="action" value="status">Apply</button>
        <button class="btn small ghost" name="action" value="compare">Compare</button>
        <button class="btn small ghost" name="action" value="ai_compare" data-busy>AI compare</button>
      </div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th><input type="checkbox" data-checkall></th><th></th><th>Product</th><th>Category</th><th class="r">Factory price</th><th class="r">Landed</th><th class="r">Sugg. wholesale</th><th class="r">Margin</th><th class="r">MOQ</th><th class="r">Units/40HQ</th><th>Status</th><th>Score</th></tr></thead>
        <tbody>${slice.map(({ product: p, analysis: a }) => html`<tr>
          <td><input type="checkbox" name="ids" value="${p.id}"></td>
          <td class="thumb-cell">${imgs[p.id]?.[0] ? html`<img src="${urls[imgs[p.id][0].thumb_path] || ''}" alt="" loading="lazy">` : html`<span class="noimg">—</span>`}</td>
          <td><a href="/admin/products/${p.id}">${p.product_name}</a>${a.issues.length ? html` <span class="warn-dot" title="${a.issues.join('\n')}">${a.issues.length}</span>` : ''}
            <div class="sub"><a href="/admin/suppliers/${p.supplier_id}">${p.supplier_name}</a>${p.supplier_sku ? ` · ${p.supplier_sku}` : ''}</div></td>
          <td>${p.category || '—'}<div class="sub">${p.subcategory || ''}</div></td>
          <td class="r">${fmt.money(p.unit_price, p.currency)}${p.currency !== 'USD' && a.unit_price_usd !== null ? html`<div class="sub">${fmt.money(a.unit_price_usd)}</div>` : ''}<div class="sub">${p.incoterm || ''}</div></td>
          <td class="r"><b>${fmt.money(a.landed_cost)}</b><div class="sub">${a.primary?.mode_label || ''}</div></td>
          <td class="r">${fmt.money(a.pricing.suggested_wholesale)}<div class="sub">@${a.pricing.target_margin_pct}%</div></td>
          <td class="r ${a.margin_pct !== null && a.margin_pct < a.pricing.target_margin_pct ? 'neg' : ''}">${fmt.pct(a.margin_pct)}</td>
          <td class="r">${fmt.num(p.moq)}</td>
          <td class="r">${fmt.num(a.fits['40HQ']?.units)}</td>
          <td>${statusPill(p.status)}</td><td>${p.score ? '★'.repeat(p.score) : ''}</td></tr>`)}</tbody>
      </table></div></form>
      ${filtered.length ? '' : html`<p class="muted">No products match.</p>`}
      ${pager({ total: filtered.length, page: pageNo, perPage: PER_PAGE, baseQuery: exportQ })}`,
    }));
  }));

  router.post('/admin/products/bulk', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ids = [].concat(fields.ids || []);
    const back = /^\/admin\/[\w\/-]*$/.test(String(fields.back || '')) ? fields.back : '/admin/products';
    if (!ids.length) { flash(res, 'warn', 'Select at least one product'); return res.redirect(back); }
    if (fields.action === 'status') {
      if (!F.STATUSES.includes(fields.status)) { flash(res, 'warn', 'Choose a status'); return res.redirect(back); }
      await db.update('products', { id: ['in', ids] }, { status: fields.status });
      flash(res, 'ok', `${ids.length} product(s) set to ${fields.status}`);
      return res.redirect(back);
    }
    if (fields.action === 'compare') return res.redirect(`/admin/compare?ids=${ids.slice(0, 8).join(',')}`);
    if (fields.action === 'ai_compare') return res.redirect(`/admin/ai/compare?ids=${ids.slice(0, 8).join(',')}`, 307);
    res.redirect(back);
  }));

  // ── Compare (table)
  router.get('/admin/compare', G(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 8);
    const ctx = await S.getCtx(db);
    const prods = (await db.list('products', { filters: { id: ['in', ids] } }));
    const sups = await db.list('suppliers', { filters: { id: ['in', [...new Set(prods.map((p) => p.supplier_id))]] }, select: 'id,name' });
    const supName = Object.fromEntries(sups.map((s) => [s.id, s.name]));
    const items = ids.map((id) => prods.find((p) => p.id === id)).filter(Boolean).map((p) => ({ p, a: analyzeProduct(p, ctx) }));
    const imgs = await S.imagesFor(db, ids);
    const urls = await db.storage.signedUrls(items.map(({ p }) => imgs[p.id]?.[0]?.thumb_path));
    if (!items.length) { flash(res, 'warn', 'Select products to compare'); return res.redirect('/admin/products'); }
    const minLanded = Math.min(...items.map((i) => i.a.landed_cost ?? Infinity));
    const rows = [
      ['Supplier', ({ p }) => supName[p.supplier_id]],
      ['Category', ({ p }) => [p.category, p.subcategory].filter(Boolean).join(' / ')],
      ['Materials', ({ p }) => p.materials], ['Size (cm)', ({ p }) => p.product_size_cm], ['Packaging', ({ p }) => p.packaging_type],
      ['Certifications', ({ p }) => p.certifications],
      ['Factory price', ({ p }) => fmt.money(p.unit_price, p.currency) + ' ' + (p.incoterm || '')],
      ['Price USD', ({ a }) => fmt.money(a.unit_price_usd)],
      ['Landed cost', ({ a }) => html`<b class="${a.landed_cost === minLanded ? 'best' : ''}">${fmt.money(a.landed_cost)}</b>`],
      ['Freight / unit', ({ a }) => fmt.money(a.primary?.freight_per_unit)],
      ['Duty %', ({ a }) => `${a.duty_pct}%`],
      ['Sugg. wholesale', ({ a }) => fmt.money(a.pricing.suggested_wholesale)],
      ['Our margin', ({ a }) => fmt.pct(a.margin_pct)],
      ['MOQ', ({ p }) => fmt.num(p.moq)], ['Lead time (days)', ({ p }) => fmt.num(p.production_lead_days)],
      ['Units / carton', ({ p }) => fmt.num(p.units_per_carton)], ['Units / 40HQ', ({ a }) => fmt.num(a.fits['40HQ']?.units)],
      ['Unit CBM', ({ a }) => a.unit_cbm ?? '—'], ['Payment', ({ p }) => p.payment_terms],
      ['Issues', ({ a }) => a.issues.length ? html`<ul class="tight">${a.issues.map((i) => html`<li>${i}</li>`)}</ul>` : '—'],
    ];
    res.html(page({
      title: 'Compare', nav: adminNav('products'), wide: true,
      body: html`<div class="head-row"><h1>Compare ${items.length} products</h1>
        <form method="post" action="/admin/ai/compare?ids=${ids.join(',')}"><button class="btn" data-busy ${items.length < 2 ? 'disabled' : ''}>AI compare</button></form></div>
      <div class="table-wrap"><table class="list compare">
        <thead><tr><th></th>${items.map(({ p }) => html`<th>${imgs[p.id]?.[0] ? html`<img src="${urls[imgs[p.id][0].thumb_path]}" alt="">` : ''}<a href="/admin/products/${p.id}">${p.product_name}</a></th>`)}</tr></thead>
        <tbody>${rows.map(([label, fn]) => html`<tr><th>${label}</th>${items.map((it) => html`<td>${fn(it) ?? '—'}</td>`)}</tr>`)}</tbody>
      </table></div>`,
    }));
  }));

  // ── Product detail
  router.get('/admin/products/:id', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const [ctx, supplier, imgsMap, analyses] = await Promise.all([
      S.getCtx(db), db.get('suppliers', p.supplier_id), S.imagesFor(db, [p.id]),
      db.list('ai_analyses', { filters: { product_ids: ['cs', [p.id]] }, order: 'created_at.desc', limit: 10 }),
    ]);
    p.supplier_name = supplier?.name;
    // Test mode: ?test_duty=12.5 re-costs the product with that duty, nothing is saved.
    const tdRaw = F.parseNumber(req.query.test_duty);
    const testDuty = req.query.test_duty !== undefined && req.query.test_duty !== '' && tdRaw !== null && !Number.isNaN(tdRaw) && tdRaw >= 0 && tdRaw <= 500 ? tdRaw : null;
    const realA = analyzeProduct(p, ctx);
    const a = testDuty !== null ? analyzeProduct({ ...p, duty_rate_pct: testDuty }, ctx) : realA;
    if (testDuty !== null) a.duty_source = 'TEST';
    const imgs = imgsMap[p.id] || [];
    const urls = await db.storage.signedUrls(imgs.flatMap((i) => [i.path, i.thumb_path]));
    const activeOpts = ctx.options.filter((o) => o.active !== false);
    const v = (x) => (x === null || x === undefined ? '' : x);

    res.html(page({
      title: p.product_name, nav: adminNav('products'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="head-row"><div><h1>${p.product_name} ${statusPill(p.status)}</h1>
        <p class="muted"><a href="/admin/suppliers/${p.supplier_id}">${supplier?.name}</a>${p.supplier_sku ? ` · SKU ${p.supplier_sku}` : ''} · ${p.category || 'No category'}${p.subcategory ? ` / ${p.subcategory}` : ''} · submitted ${fmt.date(p.created_at)}</p></div>
        <div class="actions">
          <form method="post" action="/admin/products/${p.id}/ai-review"><button class="btn" data-busy>AI review</button></form>
          <form method="post" action="/admin/products/${p.id}/ai-similar"><button class="btn ghost" data-busy>Find similar (AI)</button></form>
        </div></div>

      ${testDuty !== null ? html`<div class="flash warn test-banner"><strong>TEST MODE</strong> — costs below use a duty of <strong>${testDuty}%</strong>. Nothing is saved. Real landed cost: ${fmt.money(realA.landed_cost)} at ${realA.duty_pct}% (${realA.duty_source}).
        <form method="post" action="/admin/products/${p.id}/duty/apply-override" class="inline"><input type="hidden" name="duty" value="${testDuty}"><button class="btn small">Apply ${testDuty}% as manual override</button></form>
        <a class="btn ghost small" href="/admin/products/${p.id}">Exit test mode</a></div>` : ''}
      ${a.issues.length ? html`<div class="flash warn"><strong>Check:</strong> ${a.issues.join(' · ')}</div>` : ''}

      ${productDetails({ p, imgs, urls })}

      <div class="cols">
        <section class="card">
          <h2>Pricing</h2>
          <dl class="kv">
            <dt>Factory price</dt><dd>${fmt.money(p.unit_price, p.currency)} ${p.incoterm || ''} ${p.fob_port || ''}</dd>
            ${p.currency !== 'USD' ? html`<dt>In USD</dt><dd>${fmt.money(a.unit_price_usd)} <span class="sub">@ ${ctx.settings.fx_to_usd?.[p.currency] ?? '?'}</span></dd>` : ''}
            <dt>Freight / unit</dt><dd>${fmt.money(a.primary?.freight_per_unit)} <span class="sub">${a.primary?.name || ''}</span></dd>
            <dt>Duty</dt><dd>${fmt.money(a.primary?.duty_per_unit)} <span class="sub">${a.base_duty_pct}% (${a.duty_source})</span></dd>
            ${a.tariff_pct ? html`<dt>China tariff</dt><dd>${fmt.money(a.primary?.tariff_per_unit)} <span class="sub">${a.tariff_pct}%${a.blanket_tariff_pct ? ` (incl. ${a.blanket_tariff_pct}% blanket from Settings)` : ' (Section 301 / other)'}</span></dd>`
              : (!p.country_of_origin || /^(china|cn|prc|中国)$/i.test(String(p.country_of_origin).trim())) ? html`<dt>China tariff</dt><dd>${a.duty_source === 'manual' ? html`<span class="sub">included in the manual duty</span>` : p.duty_ai_checked_at ? html`$0.00 <span class="sub">none found</span>` : html`<a href="#duty" class="warn-text">Not researched yet: not in landed cost. Run “Check with USITC + AI” below.</a>`}</dd>` : ''}
            <dt>Customs fees + insurance</dt><dd>${fmt.money((a.primary?.customs_fees_per_unit ?? 0) + (a.primary?.insurance_per_unit ?? 0))}</dd>
            <dt class="strong">Landed cost</dt><dd class="strong">${fmt.money(a.landed_cost)}</dd>
            <dt>Target margin</dt><dd>${a.pricing.target_margin_pct}%</dd>
            <dt>Suggested wholesale</dt><dd>${fmt.money(a.pricing.suggested_wholesale)}</dd>
            <dt>Our wholesale</dt><dd>${fmt.money(p.our_wholesale_usd)} ${a.margin_pct !== null ? html`<span class="${a.margin_pct < a.pricing.target_margin_pct ? 'neg' : 'pos'}">${fmt.pct(a.margin_pct)} margin</span>` : ''}</dd>
            <dt>Retail</dt><dd>${fmt.money(p.our_retail_usd ?? p.suggested_retail_usd)} ${a.pricing.retailer_margin_pct !== undefined ? html`<span class="sub">retailer margin ${fmt.pct(a.pricing.retailer_margin_pct)}</span>` : ''}</dd>
          </dl>
        </section>
        <section class="card">
          <h2>Review</h2>
          <form method="post" action="/admin/products/${p.id}/review" class="grid">
            <label><span class="lbl">Status</span><select name="status">${F.STATUSES.map((s) => html`<option ${s === p.status ? raw('selected') : ''}>${s}</option>`)}</select></label>
            <label><span class="lbl">Score</span><select name="score"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}" ${p.score === n ? raw('selected') : ''}>${'★'.repeat(n)}</option>`)}</select></label>
            <label><span class="lbl">Our wholesale (USD)</span><input name="our_wholesale_usd" type="number" step="0.01" min="0" value="${v(p.our_wholesale_usd)}" placeholder="${v(a.pricing.suggested_wholesale)}"></label>
            <label><span class="lbl">Our retail (USD)</span><input name="our_retail_usd" type="number" step="0.01" min="0" value="${v(p.our_retail_usd)}"></label>
            <label><span class="lbl">Planned order qty</span><input name="planned_qty" type="number" step="1" min="0" value="${v(p.planned_qty)}" placeholder="MOQ ${v(p.moq)}"></label>
            <label><span class="lbl">Duty % override</span><input name="duty_rate_pct" type="number" step="0.01" min="0" value="${v(p.duty_rate_pct)}" placeholder="${a.duty_pct}"></label>
            <label class="span2"><span class="lbl">Costing logistics option</span><select name="logistics_option_id"><option value="">Default (${activeOpts.find((o) => o.id === ctx.settings.default_logistics_option_id)?.name || 'first available'})</option>
              ${activeOpts.map((o) => html`<option value="${o.id}" ${o.id === p.logistics_option_id ? raw('selected') : ''}>${o.name}</option>`)}</select></label>
            <fieldset class="span2 stores"><span class="lbl">Target stores</span>${F.STORES.map((s) => html`<label class="chk"><input type="checkbox" name="target_stores" value="${s}" ${(p.target_stores || []).includes(s) ? raw('checked') : ''}> ${s}</label>`)}</fieldset>
            <label class="span2"><span class="lbl">Notes</span><textarea name="review_notes" rows="3">${p.review_notes || ''}</textarea></label>
            <div class="span2"><button class="btn">Save review</button></div>
          </form>
        </section>
      </div>


      ${dutyPanel({ p, a: realA, testDuty, aiOn: !!process.env.ANTHROPIC_API_KEY })}
      <section class="card">
        <h2>Logistics options</h2>
        <div class="table-wrap"><table class="list compact">
          <thead><tr><th>Option</th><th class="r">Shipment qty</th><th class="r">Freight total</th><th class="r">Freight / unit</th><th class="r">Landed / unit</th><th class="r">Transit</th><th>Notes</th></tr></thead>
          <tbody>${a.scenarios.map((s) => html`<tr class="${s.option_id === a.primary?.option_id ? 'hl' : ''}">
            <td>${s.name}${s.option_id === a.primary?.option_id ? html` <span class="pill">costing</span>` : ''}${s.option_id === a.cheapest?.option_id ? html` <span class="pill s-selected">cheapest</span>` : ''}</td>
            <td class="r">${fmt.num(s.shipment_qty)}${s.containers ? html`<div class="sub">${s.containers} ctr</div>` : s.shipment_cbm ? html`<div class="sub">${s.shipment_cbm} CBM</div>` : ''}</td>
            <td class="r">${fmt.money(s.freight_total)}</td><td class="r">${fmt.money(s.freight_per_unit)}</td>
            <td class="r"><b>${fmt.money(s.landed_cost)}</b></td><td class="r">${s.transit_days ? `${s.transit_days} d` : '—'}</td>
            <td class="sub">${s.notes.join(' · ')}</td></tr>`)}</tbody></table></div>
        <h3>Container fit</h3>
        <div class="fits">${['20GP', '40GP', '40HQ'].map((c) => { const f = a.fits[c]; return html`<div class="fit"><b>${c}</b>${f ? html`<span>${fmt.num(f.cartons)} cartons</span><span>${fmt.num(f.units)} units</span><small>limited by ${f.limitedBy} · ${f.fillPct}% full · carton ${f.orientation.join('×')}</small>` : html`<span class="muted">needs carton size</span>`}</div>`; })}
          <div class="fit"><b>Carton</b><span>${a.carton_cbm ?? '—'} CBM</span><span>${a.unit_cbm ?? '—'} CBM/unit</span><small>MOQ = ${a.moq_cartons ?? '—'} cartons · ${a.moq_cbm ?? '—'} CBM</small></div></div>
      </section>

      <section class="card">
        <h2>Manage photos</h2>
        ${imgs.length ? html`<form method="post">${imageGrid(imgs, urls, { deleteAction: (im) => `/admin/products/${p.id}/images/${im.id}/delete` })}</form>` : html`<p class="muted">No photos yet.</p>`}
        ${p.photo_link ? html`<p>Supplier link: <a href="${p.photo_link}" target="_blank" rel="noopener noreferrer">${p.photo_link}</a></p>` : ''}
      </section>

      ${analyses.length ? html`<section class="card"><h2>AI analyses</h2>
        ${analyses.map((an) => html`<details ${an === analyses[0] ? raw('open') : ''}><summary>${an.title || an.kind} · ${fmt.date(an.created_at)}</summary>${renderAnalysis(an, {})}</details>`)}</section>` : ''}

      <details class="card"><summary><h2 class="inline">Supplier data (edit)</h2></summary>
        <form method="post" enctype="multipart/form-data" action="/admin/products/${p.id}/edit" class="product-form">
          ${photoSection({ images: [], product: p, maxImages: 20 })}
          ${productFields(p, { categories: ctx.categoryNames })}
          <div class="form-actions"><button class="btn">Save product</button></div>
        </form>
        <form method="post" action="/admin/products/${p.id}/delete" data-confirm="Delete this product and its photos?" class="danger-zone"><button class="link danger">Delete product</button></form>
      </details>`,
    }));
  }));

  router.post('/admin/products/:id/review', G(async (req, res) => {
    const { fields } = await parseForm(req);
    if (!('target_stores' in fields)) fields.target_stores = [];
    const { row, errors } = F.cleanReview(fields);
    const n = F.parseNumber(fields.planned_qty);
    row.planned_qty = Number.isNaN(n) || n === null ? null : Math.round(n);
    row.logistics_option_id = fields.logistics_option_id || null;
    if (errors.length) { flash(res, 'error', errors.join(' · ')); return res.redirect(`/admin/products/${req.params.id}`); }
    await db.update('products', { id: req.params.id }, row);
    flash(res, 'ok', 'Review saved');
    res.redirect(`/admin/products/${req.params.id}`);
  }));

  router.post('/admin/products/:id/edit', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const { row, errors } = F.cleanProduct(fields);
    if (errors.length) { flash(res, 'error', errors.join(' · ')); return res.redirect(`/admin/products/${p.id}`); }
    await db.update('products', { id: p.id }, row);
    const existing = (await S.imagesFor(db, [p.id]))[p.id] || [];
    const r = await saveProductImages(db, { supplierId: p.supplier_id, productId: p.id, files: files.images, existingCount: existing.length, maxImages: 20 });
    flash(res, r.errors.length ? 'warn' : 'ok', `Product saved${r.saved ? ` (+${r.saved} photos)` : ''}${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}`);
    res.redirect(`/admin/products/${p.id}`);
  }));

  router.post('/admin/products/:id/delete', G(async (req, res) => {
    const imgs = (await S.imagesFor(db, [req.params.id]))[req.params.id] || [];
    await deleteImages(db, imgs);
    await db.remove('products', { id: req.params.id });
    flash(res, 'ok', 'Product deleted');
    res.redirect('/admin/products');
  }));

  router.post('/admin/products/:id/images/:imageId/delete', G(async (req, res) => {
    const im = await db.get('product_images', req.params.imageId);
    if (im && im.product_id === req.params.id) await deleteImages(db, [im]);
    flash(res, 'ok', 'Photo deleted');
    res.redirect(`/admin/products/${req.params.id}`);
  }));

  // ── Suppliers (CRM)
  router.get('/admin/suppliers', G(async (req, res) => {
    const [suppliers, products, acts] = await Promise.all([
      db.list('suppliers', { order: 'name.asc' }),
      db.list('products', { select: 'id,supplier_id,status' }),
      db.list('supplier_activities', { select: 'supplier_id,activity_date,follow_up_date,done', order: 'activity_date.desc' }),
    ]);
    const users = await db.list('supplier_users', { select: 'supplier_id,status' });
    const portal = (s) => {
      if (!s.active) return 'Off';
      const us = users.filter((u) => u.supplier_id === s.id);
      const act = us.filter((u) => u.status === 'active').length;
      return act ? `${act} user${act > 1 ? 's' : ''}` : us.some((u) => u.status === 'invited') ? 'Invited' : '—';
    };
    let list = suppliers;
    if (req.query.crm) list = list.filter((s) => s.crm_status === req.query.crm);
    if (req.query.q) { const t = req.query.q.toLowerCase(); list = list.filter((s) => [s.name, s.contact_name, s.email, s.country, s.categories_supplied].some((v) => v && v.toLowerCase().includes(t))); }
    const due = (s) => s.next_follow_up && s.next_follow_up <= today() || acts.some((a) => a.supplier_id === s.id && !a.done && a.follow_up_date && a.follow_up_date <= today());
    if (req.query.followup === '1') list = list.filter(due);
    const lastAct = (id) => acts.find((a) => a.supplier_id === id)?.activity_date;
    res.html(page({
      title: 'Suppliers', nav: adminNav('suppliers'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="head-row"><h1>Suppliers</h1></div>
      <form class="filters" method="get"><input type="search" name="q" placeholder="Search name, contact, country" value="${req.query.q || ''}">
        <select name="crm"><option value="">All statuses</option>${CRM_STATUSES.map((s) => html`<option ${req.query.crm === s ? raw('selected') : ''}>${s}</option>`)}</select>
        <label class="chk"><input type="checkbox" name="followup" value="1" ${req.query.followup === '1' ? raw('checked') : ''}> Follow-up due</label>
        <button class="btn small">Filter</button></form>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>Supplier</th><th>Contact</th><th>Country</th><th>Status</th><th>Rating</th><th class="r">Products</th><th class="r">Shortlisted+</th><th>Last activity</th><th>Next follow-up</th><th>Portal</th></tr></thead>
        <tbody>${list.map((s) => { const ps = products.filter((p) => p.supplier_id === s.id); return html`<tr>
          <td><a href="/admin/suppliers/${s.id}">${s.name}</a><div class="sub">${s.categories_supplied || ''}</div></td>
          <td>${s.contact_name || '—'}<div class="sub">${s.email || ''}</div></td><td>${s.country || '—'}</td>
          <td>${s.crm_status}</td><td>${s.rating ? '★'.repeat(s.rating) : '—'}</td>
          <td class="r">${ps.length}</td><td class="r">${ps.filter((p) => ['Shortlisted', 'Sample requested', 'Selected'].includes(p.status)).length}</td>
          <td>${fmt.date(lastAct(s.id))}</td><td class="${due(s) ? 'neg' : ''}">${fmt.date(s.next_follow_up)}</td>
          <td>${portal(s)}</td></tr>`; })}</tbody></table></div>
      <details class="card" ${suppliers.length ? '' : raw('open')}><summary><h2 class="inline">+ Add supplier</h2></summary>
        <p class="muted">The supplier receives an invitation link. They verify this email with a 6-digit code, fill in their company details and create a password. This email becomes their login.</p>
        <form method="post" action="/admin/suppliers" class="grid">
          <label><span class="lbl">Contact email (login)<b class="req">*</b></span><input type="email" name="invite_email" required></label>
          <label><span class="lbl">Company name (optional)</span><input name="name" placeholder="Filled in by supplier at registration"></label>
          <label><span class="lbl">Contact person (optional)</span><input name="contact_name"></label>
          <label><span class="lbl">CRM status</span><select name="crm_status">${CRM_STATUSES.map((s) => html`<option ${s === 'Contacted' ? raw('selected') : ''}>${s}</option>`)}</select></label>
          <label class="chk span2"><input type="checkbox" name="send_email" value="1" checked> Email the invitation now (valid ${INVITE_DAYS} days)</label>
          <div class="span2"><button class="btn">Add supplier &amp; invite</button></div>
        </form></details>`,
    }));
  }));

  function crmFields(fields) {
    const { row, errors } = F.cleanSupplier(fields);
    if ('crm_status' in fields) { if (CRM_STATUSES.includes(fields.crm_status)) row.crm_status = fields.crm_status; }
    if ('rating' in fields) { const n = Number(fields.rating); row.rating = n >= 1 && n <= 5 ? n : null; }
    if ('categories_supplied' in fields) row.categories_supplied = String(fields.categories_supplied || '').trim() || null;
    if ('notes' in fields) row.notes = String(fields.notes || '').trim() || null;
    if ('next_follow_up' in fields) row.next_follow_up = fields.next_follow_up || null;
    return { row, errors };
  }

  const linkFlash = (res, email, r) => flash(res, 'link', `${r.emailed ? `Invitation emailed to ${email}.` : `Invitation created for ${email}. Email is not configured: send this link yourself.`}|||${r.link}`);
  async function emailTaken(email) { return (await db.list('supplier_users', { filters: { email }, limit: 1 })).length > 0; }

  router.post('/admin/suppliers', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const email = A.normEmail(fields.invite_email);
    if (!A.validEmail(email)) { flash(res, 'error', 'Enter a valid email'); return res.redirect('/admin/suppliers'); }
    if (await emailTaken(email)) { flash(res, 'error', `${email} already has a portal account`); return res.redirect('/admin/suppliers'); }
    const s = await db.insert('suppliers', {
      name: String(fields.name || '').trim() || `Pending: ${email}`, email, contact_name: String(fields.contact_name || '').trim() || null,
      crm_status: CRM_STATUSES.includes(fields.crm_status) ? fields.crm_status : 'Contacted',
    });
    const u = await db.insert('supplier_users', { supplier_id: s.id, email, status: 'invited' });
    const r = await createInvite(db, config, u, { send: !!fields.send_email, companyName: fields.name });
    linkFlash(res, email, r);
    res.redirect(`/admin/suppliers/${s.id}`);
  }));

  router.get('/admin/suppliers/:id', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const [{ items }, acts, users, reqs] = await Promise.all([
      S.loadAnalyzed(db, { filters: { supplier_id: s.id } }),
      db.list('supplier_activities', { filters: { supplier_id: s.id }, order: 'activity_date.desc,created_at.desc' }),
      db.list('supplier_users', { filters: { supplier_id: s.id }, order: 'created_at.asc' }),
      db.list('info_requests', { filters: { supplier_id: s.id }, order: 'created_at.desc', limit: 20 }),
    ]);
    const fl = takeFlash(req, res);
    const imgs = await S.imagesFor(db, items.map(({ product: p }) => p.id));
    const urls = await db.storage.signedUrls(items.map(({ product: p }) => imgs[p.id]?.[0]?.thumb_path));
    res.html(page({
      title: s.name, nav: adminNav('suppliers'), wide: true,
      flash: fl && fl.type !== 'link' ? fl : null,
      body: html`
      ${fl?.type === 'link' ? html`<div class="flash invite"><strong>${fl.msg.split('|||')[0]}</strong> The link is shown only once.<input class="copy" readonly value="${fl.msg.split('|||')[1] || ''}" data-copy><button class="btn small" type="button" data-copybtn>Copy</button></div>` : ''}
      <div class="head-row"><div><h1>${s.name}</h1><p class="muted">${s.crm_status}${s.country ? ` · ${s.country}` : ''}${s.rating ? ` · ${'★'.repeat(s.rating)}` : ''}${s.registered_at ? ` · registered ${fmt.date(s.registered_at)}` : ' · not registered yet'}</p></div>
        <div class="actions">
          <form method="post" action="/admin/suppliers/${s.id}/toggle" data-confirm="${s.active ? 'Block portal access for all users of this supplier?' : 'Allow portal access again?'}"><button class="btn small ghost">${s.active ? 'Block portal access' : 'Allow portal access'}</button></form>
        </div></div>
      ${s.active ? '' : html`<div class="flash warn">Portal access is blocked for this supplier.</div>`}
      <section class="card"><h2>Portal users</h2>
        <div class="table-wrap"><table class="list compact"><thead><tr><th>Email (login)</th><th>Name</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr><td>${u.email}</td><td>${u.name || '—'}</td>
          <td>${u.status === 'invited' ? html`Invited <span class="sub">${u.invite_expires_at && new Date(u.invite_expires_at) < new Date() ? '(expired)' : `until ${fmt.date(u.invite_expires_at)}`}</span>` : u.status === 'active' ? 'Active' : html`<span class="neg">Disabled</span>`}</td>
          <td>${fmt.date(u.last_login_at)}</td>
          <td class="actions">
            ${u.status === 'invited' ? html`<form method="post" action="/admin/supplier-users/${u.id}/invite"><button class="btn small ghost">Resend invitation</button></form>` : ''}
            ${u.status !== 'invited' ? html`<form method="post" action="/admin/supplier-users/${u.id}/toggle" data-confirm="${u.status === 'active' ? 'Disable this login? They will be signed out.' : 'Enable this login?'}"><button class="link ${u.status === 'active' ? 'danger' : ''}">${u.status === 'active' ? 'Disable' : 'Enable'}</button></form>` : ''}
          </td></tr>`)}</tbody></table></div>
        <form method="post" action="/admin/suppliers/${s.id}/users" class="inline-form mt">
          <input type="email" name="invite_email" placeholder="colleague@factory.com" required style="max-width:280px">
          <label class="chk"><input type="checkbox" name="send_email" value="1" checked> Email it</label>
          <button class="btn small">Invite another user</button></form>
      </section>
      <div class="cols">
        <section class="card"><h2>Details</h2>
          <form method="post" action="/admin/suppliers/${s.id}" class="grid">
            ${F.SUPPLIER_FIELDS.map((f) => html`<label class="${f.type === 'textarea' ? 'span2' : ''}"><span class="lbl">${f.en}</span>${f.type === 'textarea' ? html`<textarea name="${f.key}" rows="2">${s[f.key] || ''}</textarea>` : html`<input name="${f.key}" value="${s[f.key] || ''}" ${f.required ? 'required' : ''}>`}</label>`)}
            <label><span class="lbl">CRM status</span><select name="crm_status">${CRM_STATUSES.map((c) => html`<option ${c === s.crm_status ? raw('selected') : ''}>${c}</option>`)}</select></label>
            <label><span class="lbl">Rating</span><select name="rating"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}" ${s.rating === n ? raw('selected') : ''}>${'★'.repeat(n)}</option>`)}</select></label>
            <label><span class="lbl">Categories supplied</span><input name="categories_supplied" value="${s.categories_supplied || ''}"></label>
            <label><span class="lbl">Next follow-up</span><input type="date" name="next_follow_up" value="${s.next_follow_up || ''}"></label>
            <label class="span2"><span class="lbl">Notes</span><textarea name="notes" rows="3">${s.notes || ''}</textarea></label>
            <div class="span2"><button class="btn">Save</button></div>
          </form></section>
        <section class="card"><h2>Activity</h2>
          <form method="post" action="/admin/suppliers/${s.id}/activities" class="grid">
            <label><span class="lbl">Date</span><input type="date" name="activity_date" value="${today()}"></label>
            <label><span class="lbl">Type</span><select name="type">${ACTIVITY_TYPES.map((t) => html`<option>${t}</option>`)}</select></label>
            <label class="span2"><span class="lbl">Summary</span><textarea name="summary" rows="2" required></textarea></label>
            <label><span class="lbl">Follow up on</span><input type="date" name="follow_up_date"></label>
            <div><button class="btn small">Log activity</button></div>
          </form>
          <ul class="feed">${acts.map((a) => html`<li class="${a.done ? 'done' : ''}"><span class="date">${fmt.date(a.activity_date)}</span> <b>${a.type}</b>: ${a.summary}
            ${a.follow_up_date ? html`<span class="sub ${!a.done && a.follow_up_date <= today() ? 'neg' : ''}">follow up ${fmt.date(a.follow_up_date)}</span>` : ''}
            ${a.follow_up_date && !a.done ? html`<form method="post" action="/admin/activities/${a.id}/done" class="inline"><button class="link">Mark done</button></form>` : ''}</li>`)}</ul>
        </section>
      </div>
      <section class="card"><div class="head-row"><h2>Products (${items.length})</h2>
        <div class="actions"><a class="btn small ghost" href="/admin/products?supplier=${s.id}">Open in product list</a></div></div>
        ${reqs.length ? html`<p class="sub">Requests: ${reqs.map((r) => html`<a href="/admin/requests/${r.id}">${r.ref}</a> (${r.status}) `)}</p>` : ''}
        <form method="post" action="/admin/suppliers/${s.id}/request">
        <input type="hidden" name="back" value="/admin/suppliers/${s.id}">
        <div class="bulkbar"><span data-selcount>0 selected</span>
          <select name="status" aria-label="Set status"><option value="">Set status…</option>${F.STATUSES.map((st) => html`<option>${st}</option>`)}</select>
          <button class="btn small" name="action" value="status" formaction="/admin/products/bulk">Apply</button>
          <button class="btn small ghost" title="Ask the supplier for a dieline, checklist, samples…">Request information</button></div>
        <table class="list compact"><thead><tr><th><input type="checkbox" data-checkall aria-label="Select all"></th><th></th><th>Product</th><th>Category</th><th class="r">Price</th><th class="r">Landed</th><th>Status</th></tr></thead>
        <tbody>${items.map(({ product: p, analysis: a }) => html`<tr><td><input type="checkbox" name="ids" value="${p.id}"></td><td class="thumb-cell"><a href="/admin/products/${p.id}" tabindex="-1">${imgs[p.id]?.[0] && urls[imgs[p.id][0].thumb_path] ? html`<img src="${urls[imgs[p.id][0].thumb_path]}" alt="" loading="lazy">` : html`<span class="noimg" title="No photo yet"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg></span>`}</a></td><td><a href="/admin/products/${p.id}">${p.product_name}</a></td><td>${p.category || '—'}</td><td class="r">${fmt.money(p.unit_price, p.currency)}</td><td class="r">${fmt.money(a.landed_cost)}</td><td>${statusPill(p.status)}</td></tr>`)}</tbody></table></form>
        <h3>Import products for this supplier</h3>
        <form method="post" enctype="multipart/form-data" action="/admin/suppliers/${s.id}/import" class="inline-form"><input type="file" name="file" accept=".xlsx,.csv" required><button class="btn small">Import</button>
          <a href="/static/Lulyboo_Supplier_Product_Template.xlsx">Template</a></form>
      </section>
      <form method="post" action="/admin/suppliers/${s.id}/delete" data-confirm="Delete this supplier, ALL its products, photos and activity? This cannot be undone." class="danger-zone"><button class="link danger">Delete supplier</button></form>`,
    }));
  }));

  router.post('/admin/suppliers/:id', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const { row, errors } = crmFields(fields);
    if (errors.length) { flash(res, 'error', errors.join(' · ')); return res.redirect(`/admin/suppliers/${req.params.id}`); }
    await db.update('suppliers', { id: req.params.id }, row);
    flash(res, 'ok', 'Saved');
    res.redirect(`/admin/suppliers/${req.params.id}`);
  }));
  router.post('/admin/suppliers/:id/users', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const { fields } = await parseForm(req);
    const email = A.normEmail(fields.invite_email);
    if (!A.validEmail(email)) { flash(res, 'error', 'Enter a valid email'); return res.redirect(`/admin/suppliers/${s.id}`); }
    if (await emailTaken(email)) { flash(res, 'error', `${email} already has a portal account`); return res.redirect(`/admin/suppliers/${s.id}`); }
    const u = await db.insert('supplier_users', { supplier_id: s.id, email, status: 'invited' });
    linkFlash(res, email, await createInvite(db, config, u, { send: !!fields.send_email, companyName: s.registered_at ? s.name : null }));
    res.redirect(`/admin/suppliers/${s.id}`);
  }));
  router.post('/admin/supplier-users/:uid/invite', G(async (req, res) => {
    const u = await db.get('supplier_users', req.params.uid);
    if (!u || u.status !== 'invited') throw new HttpError(404, 'Invitation not found');
    const s = await db.get('suppliers', u.supplier_id);
    linkFlash(res, u.email, await createInvite(db, config, u, { send: true, companyName: s?.registered_at ? s.name : null }));
    res.redirect(`/admin/suppliers/${u.supplier_id}`);
  }));
  router.post('/admin/supplier-users/:uid/toggle', G(async (req, res) => {
    const u = await db.get('supplier_users', req.params.uid);
    if (!u || u.status === 'invited') throw new HttpError(404, 'User not found');
    const disable = u.status === 'active';
    await db.update('supplier_users', { id: u.id }, { status: disable ? 'disabled' : 'active', session_version: (u.session_version || 1) + 1 });
    flash(res, 'ok', disable ? `${u.email} disabled and signed out` : `${u.email} enabled`);
    res.redirect(`/admin/suppliers/${u.supplier_id}`);
  }));
  router.post('/admin/suppliers/:id/toggle', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    await db.update('suppliers', { id: s.id }, { active: !s.active });
    flash(res, 'ok', s.active ? 'Portal access blocked' : 'Portal access allowed');
    res.redirect(`/admin/suppliers/${s.id}`);
  }));
  router.post('/admin/suppliers/:id/delete', G(async (req, res) => {
    const prods = await db.list('products', { filters: { supplier_id: req.params.id }, select: 'id' });
    const imgs = await S.imagesFor(db, prods.map((p) => p.id));
    await deleteImages(db, Object.values(imgs).flat());
    await db.remove('suppliers', { id: req.params.id });
    flash(res, 'ok', 'Supplier deleted');
    res.redirect('/admin/suppliers');
  }));
  router.post('/admin/suppliers/:id/activities', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const summary = String(fields.summary || '').trim();
    if (!summary) { flash(res, 'error', 'Summary is required'); return res.redirect(`/admin/suppliers/${req.params.id}`); }
    await db.insert('supplier_activities', {
      supplier_id: req.params.id, summary: summary.slice(0, 5000),
      type: ACTIVITY_TYPES.includes(fields.type) ? fields.type : 'Note',
      activity_date: fields.activity_date || today(), follow_up_date: fields.follow_up_date || null,
    });
    flash(res, 'ok', 'Activity logged');
    res.redirect(`/admin/suppliers/${req.params.id}`);
  }));
  router.post('/admin/activities/:id/done', G(async (req, res) => {
    const a = await db.get('supplier_activities', req.params.id);
    if (!a) throw new HttpError(404, 'Not found');
    await db.update('supplier_activities', { id: a.id }, { done: true });
    res.redirect(`/admin/suppliers/${a.supplier_id}`);
  }));
  router.post('/admin/suppliers/:id/import', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const { files } = await parseForm(req, { limitBytes: 15 * 1024 * 1024 });
    const file = files.file?.[0];
    if (!file) { flash(res, 'error', 'Choose a file'); return res.redirect(`/admin/suppliers/${s.id}`); }
    const result = await runImport(db, file, s.id);
    res.html(page({ title: 'Import', nav: adminNav('suppliers'), body: html`<h1>Import for ${s.name}</h1>${importResult(result, null)}<p><a href="/admin/suppliers/${s.id}">← Back to ${s.name}</a></p>` }));
  }));
};

module.exports.guard = guard;
module.exports.applyFilters = applyFilters;
module.exports.filterBar = filterBar;
module.exports.dutyHelp = dutyHelp;
