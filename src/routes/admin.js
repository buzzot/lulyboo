'use strict';
// Admin: login, dashboard, products, compare, suppliers (CRM).
const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash, sign, unsign } = require('../lib/http');
const { icon } = require('../views/icons');
const { page, adminNav, productFields, imageGrid, photoSection, pager, statusPill, fileDrop, licenseDrop } = require('../views/layout');
const LIC = require('../license');
const F = require('../fields');
const { analyzeProduct } = require('../calc');
const S = require('../services');
const { saveProductImages, deleteImages } = require('../images');
const IR = require('../import-review');
const { importResult } = IR;
const { renderAnalysis } = require('../views/ai');
const { renderWorkspace } = require('../views/product-workspace');
const AI = require('../ai');
const DOC_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const A = require('../auth');
const { createInvite, INVITE_DAYS } = require('./supplier-auth');

// Product name without a leading copy of its SKU ("PA602 Pet bowl…" → "Pet bowl…").
function skuless(p) {
  const name = String(p.product_name || ''), sku = String(p.supplier_sku || '').trim();
  if (!sku || !name.toLowerCase().startsWith(sku.toLowerCase())) return name;
  return name.slice(sku.length).replace(/^[\s\-–—:·|/]+/, '') || name;
}

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
  const row = (label, x, suffix) => html`<div class="sp"><dt>${label}</dt><dd>${val(x, suffix)}</dd></div>`;
  const hero = imgs[0];
  const desc = p.description ? String(p.description).replace(/\r/g, '').replace(/\n[ \t]*\n+/g, '\n').trim() : '';
  const long = desc.split('\n').length > 5 || desc.length > 420;
  return html`<section class="card pd" id="details">
    <div class="pd-grid">
      <div class="pd-photos">
        ${hero ? html`<a class="pd-hero" href="${urls[hero.path]}" data-preview="${urls[hero.path] || urls[hero.thumb_path]}" data-type="image" data-gallery="product"><img src="${urls[hero.path] || urls[hero.thumb_path]}" alt="${p.product_name}"></a>
          ${imgs.length > 1 ? html`<div class="pd-thumbs">${imgs.slice(1, 5).map((im) => html`<a href="${urls[im.path]}" data-preview="${urls[im.path] || urls[im.thumb_path]}" data-type="image" data-gallery="product"><img src="${urls[im.thumb_path]}" alt="" loading="lazy"></a>`)}${imgs.length > 5 ? html`<span class="pd-more">+${imgs.length - 5}</span>` : ''}</div>` : ''}`
          : html`<div class="pd-hero empty">No photo yet</div>`}
        ${p.photo_link ? html`<p class="sub"><a href="${p.photo_link}" target="_blank" rel="noopener noreferrer">Supplier photo / catalog link ↗</a></p>` : ''}
      </div>
      <div class="pd-info">
        <h2 class="sec">Product</h2>
        ${desc ? html`<div class="pd-desc ${long ? 'clamp' : ''}" data-clamp>${desc}</div>${long ? html`<button type="button" class="link small" data-clamp-toggle aria-expanded="false">Show full description</button>` : ''}` : html`<p class="none">No description given</p>`}
        <dl class="specs">
          ${row('Materials', p.materials)}
          ${row('Product size (L×W×H)', p.product_size_cm, ' cm')}
          ${row('Unit net weight', p.unit_net_weight_kg, ' kg')}
          ${row('Packaging', p.packaging_type)}
          ${row('Certifications', p.certifications)}
          ${row('Battery / magnet / liquid', p.dangerous_goods)}
          ${row('HS code (supplier)', p.hs_code)}
          ${row('Country of origin', p.country_of_origin)}
          ${row('Brand', p.brand)}
        </dl>
        ${p.factory_notes ? html`<h3 class="sec2">Factory notes</h3><p class="pd-desc">${p.factory_notes}</p>` : ''}
      </div>
    </div>
  </section>`;
}

function termsAndPacking({ p }) {
  const val = (x, suffix = '') => (x === null || x === undefined || String(x).trim() === '' ? html`<span class="none">—</span>` : html`${x}${suffix}`);
  const row = (label, x, suffix) => html`<div class="sp"><dt>${label}</dt><dd>${val(x, suffix)}</dd></div>`;
  const dims = [p.carton_l_cm, p.carton_w_cm, p.carton_h_cm];
  const carton = dims.every((d) => d !== null && d !== undefined) ? `${dims.join(' × ')} cm` : null;
  const has = (x) => x !== null && x !== undefined;
  return html`<section class="card"><div class="two-col">
    <div><h2 class="sec">Price &amp; terms</h2><dl class="specs one">
      ${row('Unit price', has(p.unit_price) ? fmt.money(p.unit_price, p.currency) : null)}
      ${row('Incoterm', [p.incoterm, p.fob_port].filter(Boolean).join(' · '))}
      ${row('MOQ', has(p.moq) ? fmt.num(p.moq) : null, ' units')}
      ${row('Payment', p.payment_terms)}
      ${row('Sample lead time', p.sample_lead_days, ' days')}
      ${row('Production lead time', p.production_lead_days, ' days')}
      ${row('Quote valid until', p.quote_valid_until ? fmt.date(p.quote_valid_until) : null)}
    </dl></div>
    <div><h2 class="sec">Packing</h2><dl class="specs one">
      ${row('Units per carton', p.units_per_carton)}
      ${row('Units per inner pack', p.units_per_inner)}
      ${row('Master carton size', carton)}
      ${row('Carton weight (net / gross)', has(p.carton_nw_kg) || has(p.carton_gw_kg) ? `${p.carton_nw_kg ?? '—'} / ${p.carton_gw_kg ?? '—'} kg` : null)}
      ${row('Supplier says per container', [p.supplier_qty_20gp && `20GP ${fmt.num(p.supplier_qty_20gp)}`, p.supplier_qty_40gp && `40GP ${fmt.num(p.supplier_qty_40gp)}`, p.supplier_qty_40hq && `40HQ ${fmt.num(p.supplier_qty_40hq)}`].filter(Boolean).join(' · '))}
    </dl></div></div></section>`;
}

function dutyPanel({ p, a, testDuty, aiOn }) {
  const d = p.duty_ai_detail || null;
  const manual = p.duty_rate_pct !== null && p.duty_rate_pct !== undefined;
  const code = p.hts_verified_code || p.hs_code || '';
  return html`<details class="card fold duty-card" id="duty" ${testDuty !== null || !d ? raw('open') : ''}>
    <summary><h2 class="inline">Duty &amp; HTS</h2> <span class="pill ${a.duty_source === 'manual' ? 's-reviewing' : a.duty_source === 'AI / USITC' ? 's-selected' : ''}">using ${a.duty_pct}% · ${a.duty_source}</span></summary>
    <div class="dt-top">
      <ul class="dt-meta"><li><span>Supplier HS code</span> <b>${p.hs_code || '—'}</b></li><li><span>Origin</span> <b>${p.country_of_origin || 'not given (China assumed)'}</b></li><li><span>Source</span> <b>US tariff schedule (USITC), read by AI</b></li><li class="dt-note">A manual override always wins</li></ul>
      ${dutyHelp()}
    </div>
    <div class="dt-tools">
      <form method="post" action="/admin/products/${p.id}/duty/research" class="dt-tool">
        <div class="dt-head"><span class="dt-num">1</span><div><b>Verify HTS code</b><small>The tariff code, e.g. 9503.00.00.73. AI checks it against the USITC schedule.</small></div></div>
        <div class="dt-row"><input name="hts" value="${code}" placeholder="e.g. 9503.00.00.73" inputmode="text" autocomplete="off" aria-label="HTS code to verify">
          <button class="btn" data-busy ${aiOn ? '' : raw('disabled title="Add ANTHROPIC_API_KEY in Railway"')}>Check with USITC + AI</button>
          ${code ? html`<a class="btn ghost" target="_blank" rel="noopener" href="${usitcLink(code)}">Open USITC ↗</a>` : ''}</div>
      </form>
      <form method="get" action="/admin/products/${p.id}#duty" class="dt-tool">
        <div class="dt-head"><span class="dt-num">2</span><div><b>Test a different duty rate</b><small>Type a percentage, not an HTS code. What-if only, nothing is saved.</small></div></div>
        <div class="dt-row"><span class="inp-unit"><input name="test_duty" type="number" step="0.01" min="0" max="500" value="${testDuty ?? ''}" placeholder="e.g. ${a.duty_pct}" aria-label="Duty rate in percent"><i>%</i></span>
          <button class="btn ghost">Test</button></div>
      </form>
    </div>
    ${manual ? html`<form method="post" action="/admin/products/${p.id}/duty/clear-override" class="dt-bar"><span>Manual override <b>${p.duty_rate_pct}%</b> is active.</span> <button class="btn ghost small">Clear override${p.duty_ai_pct !== null && p.duty_ai_pct !== undefined ? ` (back to AI ${p.duty_ai_pct}%)` : ''}</button></form>` : ''}
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
    ` : html`<p class="dt-empty">Not researched yet. Confirm the code in step 1 and press “Check with USITC + AI”.</p>`}
  </details>`;
}

// ── Auth ──────────────────────────────────────────────────────
const ST = require('../staff');
function guard(config, fn) {
  return async (req, res) => {
    const staff = await ST.currentStaff(config, req);
    if (!staff) return res.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`);
    const path = String(req.url).split('?')[0];
    if (staff.must_change && !/^\/admin\/(profile|logout)/.test(path)) return res.redirect('/admin/profile?force=1');
    const why = ST.deny(staff.role, req.method, path);
    if (why) throw new HttpError(403, why);
    req.staff = staff;
    return ST.runAs(staff, async () => {
      const out = await fn(req, res);
      if (req.method === 'POST' && res.statusCode < 400) { const label = ST.autoLabel(path); if (label) await ST.audit(config, label, path); }
      return out;
    });
  };
}


// ── Business license card (supplier detail page): a short summary; full text folded away.
function licenseCard(s) {
  const id = s.id; const info = s.license_info || null; const code = LIC.normalizeNo(s.business_license_no);
  const ck = code && LIC.looksChinese(s) ? LIC.checkUSCC(code) : null;
  const fileUrl = `/admin/suppliers/${id}/license-file`; const isImg = /\.(jpe?g|png|webp)$/i.test(s.business_license_path || '');
  const lic = info?.license || {}; const reg = info?.registry || null;
  const finds = info ? LIC.findings(s, info.license, reg, ck) : (ck ? LIC.findings(s, null, null, ck) : []);
  const bad = finds.some((f) => f.level === 'bad'); const warn = finds.some((f) => f.level === 'warn');
  const verdict = info ? (bad ? html`<span class="pill lic-bad">Mismatch</span>` : warn ? html`<span class="pill s-new">Needs review</span>` : html`<span class="pill s-selected">Verified by AI</span>`) : '';
  const short = (x, n) => { const v = String(x || '').trim(); return v.length > n ? `${v.slice(0, n).replace(/[\s,;]+\S*$/, '')}…` : v; };
  const age = (d) => { const t = Date.parse(d); if (!t) return ''; const y = (Date.now() - t) / 3.156e10; return y >= 1 ? ` · ${y.toFixed(y < 10 ? 1 : 0)} yrs` : ' · under 1 yr'; };
  const est = lic.established_date || reg?.established_date;
  const facts = [
    ['Legal representative', lic.legal_representative || reg?.legal_representative],
    ['Registered capital', short((lic.registered_capital_en || reg?.registered_capital_en || '').replace(/\s*\(.*?\)/g, ''), 40)],
    ['Established', est ? `${est}${age(est)}` : ''],
    ['Company type', short((lic.company_type_en || reg?.company_type_en || '').replace(/\s*\(.*?\)/g, ''), 40)],
    ['Location', lic.address_short_en || String(lic.address_en || reg?.address_en || '').split(',').map((x) => x.trim()).filter(Boolean).slice(-3).join(', ')],
    ['Registry', reg ? (reg.found ? short(reg.registry_status_en || 'Found', 40) : 'Not found') : ''],
    ['What they do', lic.scope_summary_en || short(lic.business_scope_en || reg?.business_scope_en, 110)],
  ].filter(([, v]) => v);
  const sym = { ok: '✓', warn: '!', bad: '✕' };
  const thumb = s.business_license_path ? html`<button type="button" class="att-face lic-thumb" data-preview="${fileUrl}?inline=1" data-type="${isImg ? 'image' : 'doc'}" data-dl="${fileUrl}" aria-label="View license">${isImg ? html`<img src="${fileUrl}?inline=1" alt="">` : html`<span class="att-ic">📄</span><span class="att-ext">PDF</span>`}<span class="att-zoom" aria-hidden="true">${icon('search', 14)}</span></button>` : html`<div class="lic-thumb lic-none">No file</div>`;
  const form = html`<form method="post" enctype="multipart/form-data" action="/admin/suppliers/${id}/license" class="lic-form">
      <label><span class="lbl">License number / credit code</span><input name="business_license_no" value="${s.business_license_no || ''}" maxlength="40" autocomplete="off" spellcheck="false" placeholder="e.g. 91320000MA1XXXXXXX (18 characters)"></label>
      <div><span class="lbl">${s.business_license_path ? 'Replace file' : 'License photo or PDF'}</span>${licenseDrop({ has: !!s.business_license_path })}</div>
      <div class="form-actions"><button class="btn small">Save license</button>${s.business_license_path ? html`<button class="link danger" formaction="/admin/suppliers/${id}/license/remove" formnovalidate data-confirm="Remove the license file?">Remove file</button>` : ''}</div>
    </form>`;
  const links = LIC.officialLinks(s);
  return html`<section class="card lic-card"><div class="head-row"><h2>Business license</h2>${verdict}</div>
    ${code || s.business_license_path ? html`<div class="lic-top">${thumb}
      <div class="lic-sum">
        ${lic.name_en || lic.name_original ? html`<div class="lic-name">${lic.name_en || lic.name_original}${lic.name_en && lic.name_original ? html`<span>${lic.name_original}</span>` : ''}</div>` : ''}
        ${code ? html`<div class="lic-code"><code>${code}</code>${ck ? html`<span class="${ck.valid ? 'ok' : 'bad'}">${ck.valid ? `✓ valid${ck.province ? ` · ${ck.province}` : ''}` : '✕ invalid code'}</span>` : ''}</div>` : ''}
        ${facts.length ? html`<dl class="lic-facts">${facts.map(([k, v]) => html`<div class="${k === 'What they do' ? 'wide' : ''}"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
      </div></div>` : html`<p class="muted">No license yet. Add the number and a photo, or ask the supplier to add it on their Company page.</p>`}
    ${finds.length ? html`<ul class="lic-checks">${finds.map((f) => html`<li class="${f.level}"><span aria-hidden="true">${sym[f.level]}</span>${f.text}</li>`)}</ul>` : ''}
    <div class="lic-bar">
      <form method="post" action="/admin/suppliers/${id}/license/check" class="inline"><button class="btn small ghost" data-busy ${code || s.business_license_path ? '' : raw('disabled')}>${icon('sparkles', 15)} ${info ? 'Check again' : 'Check with AI'}</button></form>
      ${links.length ? html`<span class="sub">Verify: ${links.map((l, i) => html`${i ? ' · ' : ''}<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label.replace(' (official)', '')}</a>`)}</span>` : ''}
    </div>
    ${info ? html`<details class="lic-more"><summary>Full license details</summary>
      <dl class="lic-full">
        ${lic.name_original ? html`<dt>Name (original)</dt><dd>${lic.name_original}</dd>` : ''}
        ${lic.address_en ? html`<dt>Address</dt><dd>${lic.address_en}${lic.address_original ? html`<div class="sub">${lic.address_original}</div>` : ''}</dd>` : ''}
        ${lic.business_term_en ? html`<dt>Business term</dt><dd>${lic.business_term_en}</dd>` : ''}
        ${lic.issuing_authority_en ? html`<dt>Issued by</dt><dd>${lic.issuing_authority_en}${lic.issue_date ? ` · ${lic.issue_date}` : ''}</dd>` : ''}
        ${reg?.found && reg.paid_in_capital_en ? html`<dt>Paid-in capital</dt><dd>${reg.paid_in_capital_en}</dd>` : ''}
        ${reg?.found && reg.insured_employees ? html`<dt>Insured employees</dt><dd>${reg.insured_employees}</dd>` : ''}
        ${lic.business_scope_en || reg?.business_scope_en ? html`<dt>Business scope</dt><dd class="scope">${lic.business_scope_en || reg.business_scope_en}</dd>` : ''}
        ${lic.legibility_notes ? html`<dt>Image notes</dt><dd>${lic.legibility_notes}</dd>` : ''}
        ${reg?.found && reg.sources?.length ? html`<dt>Sources</dt><dd>${reg.sources.map((x, i) => html`${i ? ' · ' : ''}<a href="${x.url}" target="_blank" rel="noopener noreferrer">${x.title || x.url}</a>`)}</dd>` : ''}
      </dl></details>` : ''}
    <details class="lic-edit" ${code || s.business_license_path ? '' : raw('open')}><summary>${code || s.business_license_path ? 'Edit number or replace file' : 'Add license'}</summary>${form}</details>
    ${info ? html`<p class="sub lic-foot">Checked ${fmt.date(info.checked_at)} by AI · can be wrong, confirm on the official register.${info.errors?.length ? html` <span class="neg">${info.errors.map((e) => short(e, 120)).join(' · ')}</span>` : ''}</p>` : ''}
  </section>`;
}

// ── Shared filter logic ───────────────────────────────────────
function sendFile(res, buffer, name, type, inline = false) {
  res.statusCode = 200;
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (inline) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', /pdf/i.test(type || '') || /\.pdf$/i.test(name) ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  }
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
}
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

// ── Duplicates: same supplier + same product name (ignoring case and extra spaces) ──
const normName = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
function dupInfo(items) {
  const groups = new Map();
  for (const { product: p } of items) {
    const n = normName(p.product_name); if (!n) continue;
    const k = `${p.supplier_id}|${n}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(p);
  }
  const byId = new Map(); const list = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    // The oldest copy is the one to keep; the rest are "extra".
    const sorted = [...arr].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    sorted.forEach((p, i) => byId.set(p.id, { count: arr.length, extra: i > 0 }));
    list.push({ name: arr[0].product_name, supplier: arr[0].supplier_name, count: arr.length });
  }
  list.sort((a, b) => b.count - a.count);
  return { byId, groups: list };
}
function dupAlert(info, { link = '', withSupplier = false } = {}) {
  if (!info.groups.length) return '';
  const n = info.byId.size; const g = info.groups.length;
  return html`<div class="flash warn dup-alert" role="alert"><b>Possible duplicates:</b> ${n} products share a name with another product from the same supplier (${g} group${g === 1 ? '' : 's'}). Check them first: ticking the extra copies keeps the oldest of each group, then you can Archive or Delete the ticked ones.
    <div class="dup-list">${info.groups.slice(0, 5).map((x) => html`<span class="dup-chip">${x.name}${withSupplier && x.supplier ? ` · ${x.supplier}` : ''} ×${x.count}</span>`)}${g > 5 ? html` <span class="sub">+${g - 5} more</span>` : ''}</div>
    <div class="dup-actions"><button type="button" class="btn small" data-select-dups>Tick the extra copies</button>${link ? html` <a class="btn small ghost" href="${link}">Show only duplicates</a>` : ''}</div></div>`;
}
const dupPill = (info, id) => { const d = info.byId.get(id); return d ? html` <span class="pill s-dup" title="Same name as ${d.count - 1} other product(s) from this supplier">Duplicate ×${d.count}</span>` : ''; };
// Archive / delete buttons for the bulk bars. `formaction` is needed where the surrounding form posts elsewhere.
const archiveButtons = (formaction = '') => html`<button class="btn small ghost" name="action" value="archive" ${formaction ? raw(`formaction="${formaction}"`) : ''} title="Hide from the lists. You can restore it from the Archive.">Archive</button>
  ${ST.can(ST.current()?.role, 'delete') ? html`<button class="btn small danger-btn" name="action" value="delete" ${formaction ? raw(`formaction="${formaction}"`) : ''} data-confirm="Delete {n} selected product(s) and their photos? This cannot be undone. (Archive keeps them.)">Delete</button>` : ''}`;

// Issues that mean required data is absent (as opposed to warnings about the data that is there)
const isMissingData = (msg) => /^(No unit price|No exchange rate|Missing )/.test(msg);

function applyFilters(items, q, dup = null) {
  let out = items;
  if (q.dupes === '1' && dup) out = out.filter((i) => dup.byId.has(i.product.id));
  if (q.status) out = out.filter((i) => i.product.status === q.status);
  if (q.category) out = out.filter((i) => (i.product.category || '') === q.category);
  if (q.supplier) out = out.filter((i) => i.product.supplier_id === q.supplier);
  if (q.store) out = out.filter((i) => (i.product.target_stores || []).includes(q.store));
  if (q.uncategorized === '1') out = out.filter((i) => !i.product.category);
  if (q.issues === '1') out = out.filter((i) => i.analysis.issues.length);
  if (q.issues === 'missing') out = out.filter((i) => i.analysis.issues.some(isMissingData));
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
    archived: (a, b) => String(b.product.archived_at).localeCompare(String(a.product.archived_at)),
    name: (a, b) => `${a.product.supplier_id}|${normName(a.product.product_name)}`.localeCompare(`${b.product.supplier_id}|${normName(b.product.product_name)}`),
  };
  return [...out].sort(by[q.sort] || (q.dupes === '1' ? by.name : by.newest));
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

  // ── Login (staff username/email + password; empty username = the owner password from ADMIN_PASSWORD)
  router.get('/admin/login', async (req, res) => {
    res.html(page({
      title: 'Admin login', admin: true, flash: takeFlash(req, res),
      body: html`<section class="card narrow"><h1>Team login</h1>
      <form method="post" action="/admin/login"><input type="hidden" name="next" value="${req.query.next || '/admin'}">
      <label><span class="lbl">Username or email</span><input type="text" name="username" autocomplete="username" autocapitalize="off" autofocus></label>
      <label><span class="lbl">Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <div class="form-actions"><button class="btn">Log in</button> <a class="muted small" href="/admin/forgot">Forgot password?</a></div>
      <p class="muted small">Owner login: leave the username empty and use the owner password.</p></form></section>`,
    }));
  });
  const loginAttempts = new Map();
  router.post('/admin/login', async (req, res) => {
    const ip = req.socket.remoteAddress || 'x';
    const rec = loginAttempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - rec.t > 15 * 60_000) { rec.n = 0; rec.t = Date.now(); }
    if (rec.n >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { fields } = await parseForm(req);
    const ident = String(fields.username || '').trim().toLowerCase();
    const next = String(fields.next || '/admin');
    const dest = next.startsWith('/admin') ? next : '/admin';
    const fail = async (why) => { rec.n++; loginAttempts.set(ip, rec); await ST.audit(config, 'Failed login', `${ident || 'owner'} (${why})`, { name: ident || 'owner' }); flash(res, 'error', 'Wrong username or password'); return res.redirect('/admin/login'); };
    if (!ident || ident === 'owner') {
      const a = crypto.createHash('sha256').update(String(fields.password || '')).digest();
      const b = crypto.createHash('sha256').update(String(config.adminPassword || '')).digest();
      if (!config.adminPassword || !crypto.timingSafeEqual(a, b)) return fail('owner');
      loginAttempts.delete(ip);
      ST.startOwnerSession(res, config);
      await ST.audit(config, 'Signed in', 'owner password', { owner: true });
      return res.redirect(dest);
    }
    let user = null;
    try { user = (await db.list('staff_users')).find((u) => u.username === ident || String(u.email).toLowerCase() === ident) || null; } catch { /* table not created yet */ }
    const ok = user && user.status === 'active' ? await A.verifyPassword(fields.password, user.password_hash) : (await A.verifyPassword(fields.password, 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')), false);
    if (!ok) return fail(user ? user.status : 'unknown');
    loginAttempts.delete(ip);
    await db.update('staff_users', { id: user.id }, { last_login: new Date().toISOString() });
    ST.startSession(res, config, user);
    await ST.audit(config, 'Signed in', '', user);
    return res.redirect(user.must_change ? '/admin/profile?force=1' : dest);
  });
  router.get('/admin/logout', async (req, res) => { res.setCookie('lb_admin', '', { maxAge: 0 }); res.redirect('/admin/login'); });

  // ── Dashboard: what needs attention, pipeline, follow-ups, categories, latest submissions, sourcing activity
  router.get('/admin', G(async (req, res) => {
    const problems = [];
    const safe = async (what, p, fallback) => { try { return await p; } catch (e) { console.error(`Dashboard ${what}:`, e.message); problems.push(what); return fallback; } };
    const C = require('../crm');
    const todayStr = C.localNow().date;
    const [analysed, suppliers, followItems, reqRows, acts] = await Promise.all([
      S.loadAnalyzed(db),
      safe('suppliers', db.list('suppliers', { order: 'name.asc' }), []),
      safe('follow-ups', C.openItems(db), []),
      safe('requests', db.list('info_requests', { order: 'created_at.desc' }), []),
      safe('supplier activity', db.list('supplier_activities', { order: 'created_at.desc', limit: 6 }), []),
    ]);
    const { ctx, items } = analysed;
    const supName = Object.fromEntries(suppliers.map((x) => [x.id, x.name]));
    const nStatus = (st) => items.filter((i) => i.product.status === st).length;

    // Follow-ups, grouped Overdue / Today / Upcoming (next 7 days)
    const weekEnd = C.addDays(todayStr, 7);
    const overdue = followItems.filter((i) => i.due_date < todayStr);
    const dueToday = followItems.filter((i) => i.due_date === todayStr);
    const upcoming = followItems.filter((i) => i.due_date > todayStr && i.due_date <= weekEnd);
    const followShown = [...overdue, ...dueToday, ...upcoming].slice(0, 6);
    const reqRef = Object.fromEntries(reqRows.map((r) => [r.id, r.ref]));

    // Counts for the attention list (each underlying issue is counted once)
    const awaitingReview = nStatus('New');
    const missingData = items.filter((i) => i.analysis.issues.some(isMissingData)).length;
    const withIssues = items.filter((i) => i.analysis.issues.length).length;
    const uncategorized = items.filter((i) => !i.product.category).length;
    const samples = nStatus('Sample requested');
    const awaitingReply = reqRows.filter((r) => r.status === 'Sent').length;
    const attention = [
      { label: 'Products awaiting review', n: awaitingReview, href: '/admin/products?status=New', tone: 'info' },
      { label: 'Overdue follow-ups', n: overdue.length, href: '/admin/crm', tone: 'danger' },
      { label: 'Products missing required data', n: missingData, href: '/admin/products?issues=missing', tone: 'warn' },
      { label: 'Uncategorized products', n: uncategorized, href: '/admin/products?uncategorized=1', tone: 'warn' },
      { label: 'RFQs and requests awaiting a reply', n: awaitingReply, href: '/admin/requests?status=Sent', tone: 'info' },
      { label: 'Sample requests outstanding', n: samples, href: '/admin/products?status=Sample%20requested', tone: 'info' },
    ];
    const attentionOpen = attention.filter((a) => a.n > 0).length;

    // Pipeline
    const stages = F.STATUSES.filter((x) => x !== 'Rejected');
    const pipeTotal = stages.reduce((n, st) => n + nStatus(st), 0);
    const rejected = nStatus('Rejected');

    // Suppliers by status
    const byStatus = {};
    for (const x of suppliers) byStatus[x.crm_status || 'Other'] = (byStatus[x.crm_status || 'Other'] || 0) + 1;
    const statusLine = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ');

    // Categories
    const catCount = {};
    for (const i of items) { const c = i.product.category || ''; catCount[c] = (catCount[c] || 0) + 1; }
    const catRows = Object.entries(catCount).filter(([c]) => c).sort((a, b) => b[1] - a[1]);
    const catShown = catRows.slice(0, 6);
    const catMax = Math.max(1, ...Object.values(catCount));

    // Latest submissions (date range applies here only)
    const range = ['7', '30', '90'].includes(req.query.range) ? Number(req.query.range) : 0;
    const since = range ? new Date(Date.now() - range * 86400_000).toISOString() : '';
    const recent = items.filter((i) => !since || String(i.product.created_at) >= since).slice(0, 6);
    let thumbUrls = {}; let thumbOf = {};
    if (recent.length) {
      const imgs = await safe('photos', S.imagesFor(db, recent.map((i) => i.product.id)), {});
      for (const i of recent) thumbOf[i.product.id] = imgs[i.product.id]?.[0]?.thumb_path || null;
      thumbUrls = await safe('photos', db.storage.signedUrls(Object.values(thumbOf).filter(Boolean)), {});
    }

    // Sourcing activity
    const supWithOpenReq = {};
    for (const r of reqRows.filter((x) => x.status === 'Sent')) supWithOpenReq[r.supplier_id] = (supWithOpenReq[r.supplier_id] || 0) + 1;
    const sampleBy = {};
    for (const i of items.filter((x) => x.product.status === 'Sample requested')) sampleBy[i.product.supplier_id] = (sampleBy[i.product.supplier_id] || 0) + 1;
    const followBy = {};
    for (const f of [...overdue, ...dueToday]) if (f.supplier_id) followBy[f.supplier_id] = (followBy[f.supplier_id] || 0) + 1;
    const sourcing = [
      { label: 'Awaiting a reply', sub: 'RFQs and requests sent', map: supWithOpenReq, href: (id) => `/admin/requests?status=Sent` },
      { label: 'Samples requested', sub: 'products', map: sampleBy, href: (id) => `/admin/products?supplier=${id}&status=Sample%20requested` },
      { label: 'Follow-up needed', sub: 'due or overdue', map: followBy, href: (id) => `/admin/suppliers/${id}#next-actions` },
    ].map((c) => ({ ...c, rows: Object.entries(c.map).sort((a, b) => b[1] - a[1]).slice(0, 4), total: Object.values(c.map).reduce((a, b) => a + b, 0) }));

    const dueLabel = (d) => {
      const days = Math.round((new Date(d + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z')) / 86400_000);
      if (days < 0) return { text: `${-days}d overdue`, cls: 'danger' };
      if (days === 0) return { text: 'Today', cls: 'warn' };
      return { text: days === 1 ? 'Tomorrow' : `in ${days}d`, cls: '' };
    };
    const staff = req.staff;
    const rangeLabel = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' }[range] || 'All time';
    const empty = (msg) => html`<p class="d-empty">${msg}</p>`;
    const followGroup = (label, list, cls) => list.length ? html`<li class="fu-group ${cls}">${label} <b>${list.length}</b></li>${list.filter((x) => followShown.includes(x)).map((f) => {
      const due = dueLabel(f.due_date);
      const doneUrl = f.kind === 'task' ? `/admin/crm/tasks/${f.id}/done` : `/admin/activities/${f.id}/done`;
      return html`<li class="fu-row"><div class="fu-main"><span class="trunc" title="${f.title}">${f.title}</span>
        <small class="trunc">${f.supplier_id ? html`<a href="/admin/suppliers/${f.supplier_id}" title="${supName[f.supplier_id] || ''}">${supName[f.supplier_id] || 'Supplier'}</a>` : 'General'}${f.request_id && reqRef[f.request_id] ? html` · <a href="/admin/requests/${f.request_id}">${reqRef[f.request_id]}</a>` : ''}</small></div>
        <span class="fu-date">${fmt.date(f.due_date)}</span><span class="d-pill ${due.cls}">${due.text}</span>
        <form method="post" action="${doneUrl}"><input type="hidden" name="back" value="/admin"><button class="d-btn" title="Mark as done" aria-label="Mark ${f.title} as done">✓ Done</button></form></li>`;
    })}` : '';

    res.html(page({
      title: 'Dashboard', nav: adminNav('dashboard'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="d-head"><div><h1>Dashboard</h1><p class="muted">Product development &amp; sourcing overview</p></div>
        <div class="d-tools">
          <form method="get" action="/admin" class="d-range"><label><span class="sr-only">Date range for latest submissions</span>
            <select name="range" data-autosubmit aria-label="Date range for latest submissions">${[['', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, l]) => html`<option value="${v}" ${String(range || '') === v ? raw('selected') : ''}>${l}</option>`)}</select></label></form>
          <label class="d-newrfq"><span class="sr-only">New RFQ: choose a supplier</span>
            <select data-goto aria-label="New RFQ: choose a supplier"><option value="">＋ New RFQ…</option>${suppliers.filter((x) => x.active !== false).map((x) => html`<option value="/admin/suppliers/${x.id}/request">${x.name}</option>`)}</select></label>
        </div></div>
      ${problems.length ? html`<p class="d-warnbar" role="status">Some information could not be loaded (${[...new Set(problems)].join(', ')}). The rest of the dashboard is correct.</p>` : ''}

      <div class="d-kpis">
        <a class="d-kpi ${awaitingReview ? 'accent' : ''}" href="/admin/products?status=New"><span>Awaiting review</span><b>${fmt.num(awaitingReview)}</b><small>Products with status New</small></a>
        <a class="d-kpi ${overdue.length ? 'danger' : dueToday.length ? 'warn' : ''}" href="/admin/crm"><span>Follow-ups due</span><b>${fmt.num(overdue.length + dueToday.length)}</b><small>${overdue.length ? html`<em class="t-danger">${overdue.length} overdue</em> · ` : ''}${dueToday.length} today</small></a>
        <a class="d-kpi" href="/admin/products"><span>Total products</span><b>${fmt.num(items.length)}</b><small>${withIssues ? `${withIssues} with data issues` : 'No data issues'}</small></a>
        <a class="d-kpi" href="/admin/suppliers"><span>Suppliers</span><b>${fmt.num(suppliers.length)}</b><small>${statusLine || 'None yet'}</small></a>
      </div>

      <div class="d-grid">
        <section class="d-card d-6"><div class="d-title"><h2>Needs attention</h2><span class="muted small">${attentionOpen ? `${attentionOpen} open` : 'All clear'}</span></div>
          <ul class="d-attn">${attention.map((a) => html`<li><a href="${a.href}" class="${a.n ? a.tone : 'zero'}"><span class="a-dot" aria-hidden="true"></span><span class="a-label">${a.label}</span><b>${fmt.num(a.n)}</b><span class="a-go" aria-hidden="true">›</span></a></li>`)}</ul></section>

        <section class="d-card d-6"><div class="d-title"><h2>Product pipeline</h2><a class="d-link" href="/admin/products">All products</a></div>
          ${pipeTotal ? html`<div class="d-pipebar" role="img" aria-label="Products by stage">${stages.map((st) => nStatus(st) ? html`<span class="seg st-${st.toLowerCase().replace(/\s+/g, '-')}" style="flex:${nStatus(st)}" title="${st}: ${nStatus(st)}"></span>` : '')}</div>` : ''}
          <ol class="d-pipe">${stages.map((st) => html`<li><a href="/admin/products?status=${encodeURIComponent(st)}" class="${nStatus(st) ? '' : 'zero'}"><span class="dot st-${st.toLowerCase().replace(/\s+/g, '-')}" aria-hidden="true"></span><b>${nStatus(st)}</b><span>${st}</span></a></li>`)}</ol>
          <p class="d-foot">${rejected ? html`<a href="/admin/products?status=Rejected">${rejected} rejected</a>` : 'No rejected products'} · ${pipeTotal} in the pipeline</p></section>

        <section class="d-card d-12"><div class="d-title"><h2>Follow-ups</h2><a class="d-link" href="/admin/crm">View all${followItems.length ? ` (${followItems.length})` : ''}</a></div>
          ${followShown.length ? html`<ul class="d-fu">${followGroup('Overdue', overdue, 'danger')}${followGroup('Today', dueToday, 'warn')}${followGroup('Upcoming · next 7 days', upcoming, '')}</ul>
            ${followItems.length > followShown.length ? html`<p class="d-foot">Showing ${followShown.length} of ${followItems.length} open. <a href="/admin/crm">View all</a></p>` : ''}` : empty('Nothing due in the next 7 days.')}</section>

        <section class="d-card d-6"><div class="d-title"><h2>Product categories</h2><a class="d-link" href="/admin/categories">View all categories</a></div>
          ${catShown.length || uncategorized ? html`<ul class="d-cats">${catShown.map(([c, n]) => html`<li><a href="/admin/products?category=${encodeURIComponent(c)}"><span class="trunc" title="${c}">${c}</span><b>${n}</b><span class="d-meter"><i style="width:${Math.max(4, Math.round(n / catMax * 100))}%"></i></span></a></li>`)}
            ${uncategorized ? html`<li class="uncat"><a href="/admin/products?uncategorized=1"><span class="trunc">Uncategorized</span><b>${uncategorized}</b><span class="d-meter"><i style="width:${Math.max(4, Math.round(uncategorized / catMax * 100))}%"></i></span></a></li>` : ''}</ul>
            ${catRows.length > catShown.length ? html`<p class="d-foot">+${catRows.length - catShown.length} more categories</p>` : ''}` : empty('No products in a category yet.')}</section>

        <section class="d-card d-6"><div class="d-title"><h2>Recent submissions</h2><a class="d-link" href="/admin/products">All products</a></div>
          ${recent.length ? html`<ul class="d-recent">${recent.map(({ product: p, analysis: a }) => html`<li><a class="r-img" href="/admin/products/${p.id}" tabindex="-1" aria-hidden="true">${thumbUrls[thumbOf[p.id]] ? html`<img src="${thumbUrls[thumbOf[p.id]]}" alt="" loading="lazy">` : html`<span class="r-ph">${icon('package', 18)}</span>`}</a>
            <div class="r-main"><a class="trunc" href="/admin/products/${p.id}" title="${p.product_name}">${p.product_name}</a><small class="trunc">${p.supplier_name} · ${fmt.date(p.created_at)}</small></div>
            <span class="r-cost">${a.landed_cost !== null && a.landed_cost !== undefined ? fmt.money(a.landed_cost) : '—'}<small>landed</small></span>${statusPill(p.status)}</li>`)}</ul>` : empty(range ? `No submissions in the ${rangeLabel.toLowerCase()}.` : 'No products submitted yet.')}</section>

        <section class="d-card d-12"><div class="d-title"><h2>Supplier activity</h2><a class="d-link" href="/admin/suppliers">View all suppliers</a></div>
          <div class="d-src">${sourcing.map((c) => html`<div class="src-col"><h3>${c.label} <b>${c.total}</b></h3>
            ${c.rows.length ? html`<ul>${c.rows.map(([id, n]) => html`<li><a class="trunc" href="${c.href(id)}" title="${supName[id] || ''}">${supName[id] || 'Supplier'}</a><span>${n}</span></li>`)}</ul>` : html`<p class="d-empty small">None</p>`}</div>`)}
            <div class="src-col"><h3>Recent activity</h3>${acts.length ? html`<ul>${acts.slice(0, 4).map((a) => html`<li><a class="trunc" href="/admin/suppliers/${a.supplier_id}" title="${a.summary || ''}">${supName[a.supplier_id] || 'Supplier'} · ${a.summary || a.type}</a><span>${fmt.date(a.activity_date || a.created_at)}</span></li>`)}</ul>` : html`<p class="d-empty small">No activity logged yet</p>`}</div></div></section>
      </div>`,
    }));
  }));

  // ── Products list
  router.get('/admin/products', G(async (req, res) => {
    const { ctx, items, suppliers, archivedCount } = await S.loadAnalyzed(db);
    const dup = dupInfo(items);
    const filtered = applyFilters(items, req.query, dup);
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const slice = filtered.slice((pageNo - 1) * PER_PAGE, pageNo * PER_PAGE);
    const imgs = await S.imagesFor(db, slice.map((i) => i.product.id));
    const urls = await db.storage.signedUrls(slice.map((i) => imgs[i.product.id]?.[0]?.thumb_path));
    const exportQ = new URLSearchParams(Object.entries(req.query).filter(([k]) => k !== 'page'));
    res.html(page({
      title: 'Products', nav: adminNav('products'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="head-row"><h1>Products</h1><div class="actions"><a class="btn ghost small" href="/admin/archive">Archive${archivedCount ? ` (${archivedCount})` : ''}</a><a class="btn ghost small" href="/admin/export.csv?${exportQ}">Export CSV</a></div></div>
      ${dupAlert(dup, { link: req.query.dupes === '1' ? '' : '/admin/products?dupes=1', withSupplier: true })}${req.query.dupes === '1' ? html`<p class="sub">Showing duplicates only. <a href="/admin/products">Show all products</a></p>` : ''}
      ${filterBar(req.query, ctx, suppliers)}
      <form method="post" action="/admin/products/bulk" id="bulk">
      <div class="bulkbar">
        <span data-selcount>0 selected</span>
        <select name="status"><option value="">Set status…</option>${F.STATUSES.map((s) => html`<option>${s}</option>`)}</select>
        <button class="btn small" name="action" value="status">Apply</button>
        <button class="btn small ghost" name="action" value="compare">Compare</button>
        <button class="btn small ghost" name="action" value="ai_compare" data-busy>AI compare</button>
        ${archiveButtons()}
      </div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th><input type="checkbox" data-checkall></th><th></th><th>Product</th><th>Category</th><th class="r">Factory price</th><th class="r">Landed</th><th class="r">Sugg. wholesale</th><th class="r">Margin</th><th class="r">MOQ</th><th class="r">Units/40HQ</th><th>Status</th><th>Score</th></tr></thead>
        <tbody>${slice.map(({ product: p, analysis: a }) => html`<tr>
          <td><input type="checkbox" name="ids" value="${p.id}" ${dup.byId.get(p.id)?.extra ? raw('data-dupextra') : ''}></td>
          <td class="thumb-cell">${imgs[p.id]?.[0] ? html`<img src="${urls[imgs[p.id][0].thumb_path] || ''}" alt="" loading="lazy">` : html`<span class="noimg">—</span>`}</td>
          <td><a href="/admin/products/${p.id}">${p.product_name}</a>${dupPill(dup, p.id)}${a.issues.length ? html` <span class="warn-dot" title="${a.issues.join('\n')}">${a.issues.length}</span>` : ''}
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
    const ids = [].concat(fields.ids || []).map(String).filter((id) => /^[\w-]{1,64}$/.test(id));
    const back = /^\/admin\/[\w\/-]*$/.test(String(fields.back || '')) ? fields.back : fields.action === 'unarchive' ? '/admin/archive' : '/admin/products';
    if (!ids.length) { flash(res, 'warn', 'Select at least one product'); return res.redirect(back); }
    if (fields.action === 'archive' || fields.action === 'unarchive') {
      const on = fields.action === 'archive';
      try { await db.update('products', { id: ['in', ids] }, { archived_at: on ? new Date().toISOString() : null }); } catch (e) {
        if (/archived_at/.test(String(e.message))) { flash(res, 'error', 'Archive needs a one-time database update: run the "archived_at" lines at the end of supabase/schema.sql in Supabase, then try again.'); return res.redirect(back); }
        throw e;
      }
      S.invalidate?.();
      flash(res, 'ok', on ? `${ids.length} product(s) archived. They are hidden from the lists; find them under Archive.` : `${ids.length} product(s) restored.`);
      return res.redirect(back);
    }
    if (fields.action === 'delete' && !ST.can(req.staff.role, 'delete')) { flash(res, 'error', 'Only an Admin can delete. Use Archive instead.'); return res.redirect(back); }
    if (fields.action === 'delete') {
      const imgs = Object.values(await S.imagesFor(db, ids)).flat();
      await deleteImages(db, imgs);
      await db.remove('products', { id: ['in', ids] });
      S.invalidate?.();
      flash(res, 'ok', `${ids.length} product(s) deleted`);
      return res.redirect(back);
    }
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

  // ── Archive
  router.get('/admin/archive', G(async (req, res) => {
    const { ctx, items, suppliers } = await S.loadAnalyzed(db, { archived: 'only' });
    const q = { ...req.query, sort: req.query.sort || 'archived' };
    const filtered = applyFilters(items, q);
    const imgs = await S.imagesFor(db, filtered.map(({ product: p }) => p.id));
    const urls = await db.storage.signedUrls(filtered.map(({ product: p }) => imgs[p.id]?.[0]?.thumb_path));
    const supOpts = suppliers.filter((x) => items.some(({ product: p }) => p.supplier_id === x.id));
    res.html(page({
      title: 'Archive', nav: adminNav('products'), flash: takeFlash(req, res), wide: true,
      body: html`
      <div class="head-row"><div><h1>Archive (${items.length})</h1><p class="muted">Archived products are hidden from the product lists, comparisons and the supplier's portal. Restore them any time.</p></div>
        <div class="actions"><a class="btn ghost small" href="/admin/products">Back to products</a></div></div>
      <form method="get" class="filters"><select name="supplier" aria-label="Supplier"><option value="">All suppliers</option>${supOpts.map((x) => html`<option value="${x.id}" ${req.query.supplier === x.id ? raw('selected') : ''}>${x.name}</option>`)}</select>
        <input type="search" name="q" value="${req.query.q || ''}" placeholder="Search"><button class="btn small ghost">Filter</button></form>
      <form method="post" action="/admin/products/bulk"><input type="hidden" name="back" value="/admin/archive">
        <div class="bulkbar"><span data-selcount>0 selected</span>
          <button class="btn small" name="action" value="unarchive">Restore</button>
          <button class="btn small danger-btn" name="action" value="delete" data-confirm="Delete {n} selected product(s) and their photos permanently? This cannot be undone.">Delete</button></div>
        ${filtered.length ? html`<div class="table-wrap"><table class="list compact"><thead><tr><th><input type="checkbox" data-checkall aria-label="Select all"></th><th></th><th>Product</th><th>Supplier</th><th>Category</th><th class="r">Price</th><th>Archived</th></tr></thead>
        <tbody>${filtered.map(({ product: p }) => html`<tr><td><input type="checkbox" name="ids" value="${p.id}"></td>
          <td class="thumb-cell">${imgs[p.id]?.[0] && urls[imgs[p.id][0].thumb_path] ? html`<img src="${urls[imgs[p.id][0].thumb_path]}" alt="" loading="lazy">` : html`<span class="noimg">—</span>`}</td>
          <td><a href="/admin/products/${p.id}">${p.product_name}</a></td><td>${p.supplier_name || '—'}</td><td>${p.category || '—'}</td>
          <td class="r">${fmt.money(p.unit_price, p.currency)}</td><td>${fmt.date(p.archived_at)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing archived.</p>`}
      </form>`,
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
    const srcDoc = p.source_document_id ? await db.get('supplier_documents', p.source_document_id).catch(() => null) : null;
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

    const canDelete = ST.can(ST.current()?.role, 'delete');
    const docs = await db.list('supplier_documents', { filters: { product_id: p.id }, order: 'created_at.desc' }).then((r) => ({ ok: true, r })).catch(() => ({ ok: false, r: [] }));
    res.html(page({
      title: p.product_name, nav: adminNav('products'), flash: takeFlash(req, res), wide: true,
      body: renderWorkspace({ p, a, realA, ctx, supplier, imgs, urls, srcDoc, docs: docs.r, docsReady: docs.ok, analyses, activeOpts, testDuty, canDelete, renderAnalysis,
        dutyHtml: dutyPanel({ p, a: realA, testDuty, aiOn: !!process.env.ANTHROPIC_API_KEY }) }),
    }));
  }));

  // Photos, descriptions and documents on the product workspace
  const back = (res, id, tab) => res.redirect(`/admin/products/${id}#${tab}`);
  router.post('/admin/products/:id/photos', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const { files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const existing = (await S.imagesFor(db, [p.id]))[p.id] || [];
    const r = await saveProductImages(db, { supplierId: p.supplier_id, productId: p.id, files: files.images, existingCount: existing.length, maxImages: 20 });
    flash(res, r.errors.length ? 'warn' : 'ok', r.saved ? `${r.saved} photo(s) added${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}` : (r.errors.join(' · ') || 'No photo selected'));
    back(res, p.id, 'documents');
  }));
  router.post('/admin/products/:id/photos/:imageId/primary', G(async (req, res) => {
    const imgs = (await S.imagesFor(db, [req.params.id]))[req.params.id] || [];
    const pick = imgs.find((i) => i.id === req.params.imageId);
    if (pick) {
      const order = [pick, ...imgs.filter((i) => i.id !== pick.id)];
      for (let i = 0; i < order.length; i++) if (order[i].sort !== i) await db.update('product_images', { id: order[i].id }, { sort: i });
      flash(res, 'ok', 'Main photo updated');
    }
    back(res, req.params.id, 'documents');
  }));
  router.post('/admin/products/:id/ai-describe', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) return res.json({ ok: false, error: 'Product not found' }, 404);
    if (!AI.enabled()) return res.json({ ok: false, error: 'AI is not enabled (ANTHROPIC_API_KEY is not set).' }, 503);
    if (!String(p.description || '').trim()) return res.json({ ok: false, error: 'There is no description to clean up.' }, 400);
    let image = null;
    try { const im = ((await S.imagesFor(db, [p.id]))[p.id] || [])[0]; if (im) image = await db.storage.download(im.path); } catch { /* optional */ }
    try {
      const out = await AI.cleanDescription({ text: p.description, fields: { name: p.product_name, materials: p.materials, size: p.product_size_cm }, image });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.json({ ok: false, error: /401|authentication/i.test(e.message) ? 'The AI key was rejected. Check ANTHROPIC_API_KEY in Railway.' : 'AI could not process this description right now.' }, 502);
    }
  }));
  router.post('/admin/products/:id/description', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const text = String(fields.description || '').trim().slice(0, 6000);
    if (!text) flash(res, 'error', 'Description cannot be empty');
    else { await db.update('products', { id: req.params.id }, { description: text }); flash(res, 'ok', 'Description updated'); }
    back(res, req.params.id, 'overview');
  }));
  router.post('/admin/products/:id/documents', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const f = files.file && (Array.isArray(files.file) ? files.file[0] : files.file);
    const kind = ['certificate', 'test_report', 'specification', 'other'].includes(fields.kind) ? fields.kind : 'other';
    if (!f || !f.buffer || !f.buffer.length) { flash(res, 'error', 'Choose a file to upload'); return back(res, p.id, 'documents'); }
    const name = String(f.name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150);
    const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    if (!/^\.(pdf|png|jpe?g|webp|docx?|xlsx?|csv|txt|zip)$/.test(ext)) { flash(res, 'error', 'This file type is not allowed'); return back(res, p.id, 'documents'); }
    const id = crypto.randomUUID(); const path = `${p.supplier_id}/${id}${ext}`;
    try {
      await db.docs.upload(path, f.buffer, DOC_TYPES[ext] || 'application/octet-stream');
      try { await db.insert('supplier_documents', { id, supplier_id: p.supplier_id, product_id: p.id, name, mime: DOC_TYPES[ext] || null, bytes: f.buffer.length, path, kind }); }
      catch (e) { await db.docs.remove([path]).catch(() => {}); throw e; }
      flash(res, 'ok', `${name} uploaded`);
    } catch { flash(res, 'error', 'The file could not be saved. Run the latest supabase/schema.sql in Supabase and try again.'); }
    back(res, p.id, 'documents');
  }));
  // Fill the product form from a file with AI: returns what was read; the popup lets the user pick fields; nothing is saved here
  // except (optionally) the file itself, which goes to the product's Documents.
  router.post('/admin/products/:id/ai-fill', G(async (req, res) => {
    const p = await db.get('products', req.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const AI = require('../ai');
    if (!AI.enabled()) return res.json({ ok: false, error: 'AI is not set up (ANTHROPIC_API_KEY).' }, 400);
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const f = files.file && (Array.isArray(files.file) ? files.file[0] : files.file);
    if (!f?.buffer?.length) return res.json({ ok: false, error: 'Choose a file' }, 400);
    const name = String(f.name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150);
    const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    if (!/^\.(pdf|png|jpe?g|webp|xlsx|xlsm|xls|csv)$/.test(ext)) return res.json({ ok: false, error: 'Use a PDF, photo (JPG/PNG), Excel or CSV file' }, 400);
    const { PRODUCT_FIELDS, CATEGORIES, cleanProduct } = require('../fields');
    const { sheetText } = require('../import-review');
    const { parseXlsx, parseCsv, decodeText } = require('../importer');
    const supplier = await db.get('suppliers', p.supplier_id).catch(() => null);
    let table = null; let doc = null;
    if (/\.(pdf|png|jpe?g|webp)$/.test(ext)) doc = { buffer: f.buffer, mime: { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] };
    else { try { table = sheetText(ext === '.csv' ? parseCsv(decodeText(f.buffer)) : parseXlsx(f.buffer)); } catch { return res.json({ ok: false, error: 'This spreadsheet could not be opened' }, 400); } }
    let r;
    try { r = await AI.extractProducts({ table, file: doc, supplierName: supplier?.name || '', categories: CATEGORIES }); }
    catch (e) { return res.json({ ok: false, error: `AI could not read the file: ${String(e.message).slice(0, 160)}` }, 502); }
    const keys = PRODUCT_FIELDS.filter((x) => x.group !== 'photos').map((x) => x.key);
    const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const products = (r.products || []).slice(0, 60).map((x) => {
      const input = { currency: r.currency, incoterm: r.incoterm, fob_port: r.fob_port, payment_terms: r.payment_terms, quote_valid_until: r.quote_valid_until, ...x };
      if (input.product_size_cm !== undefined && input.product_size_cm !== null) input.product_size_cm = String(input.product_size_cm);
      for (const k of Object.keys(input)) if (input[k] === undefined || input[k] === null || input[k] === '') delete input[k];
      let row = {};
      try { row = cleanProduct(input, { partial: true }).row || {}; } catch { row = {}; }
      const values = {};
      for (const k of keys) { const v = row[k] ?? input[k]; if (v !== undefined && v !== null && v !== '') values[k] = v; }
      return { label: [x.supplier_sku, x.product_name].filter(Boolean).join(' · ') || 'Product', values };
    }).filter((x) => Object.keys(x.values).length);
    // which product in the file is this one: same SKU, else a name that contains the other, else the only one
    let best = products.findIndex((x) => p.supplier_sku && x.values.supplier_sku && norm(x.values.supplier_sku) === norm(p.supplier_sku));
    if (best < 0) { const n = norm(p.product_name); const hits = products.map((x, i) => [i, norm(x.values.product_name)]).filter(([, m]) => n.length > 3 && m.length > 3 && (m.includes(n) || n.includes(m))); if (hits.length === 1) best = hits[0][0]; }
    if (best < 0 && products.length === 1) best = 0;
    let stored = null;
    if (fields.keep === '1' && products.length) {
      const id = crypto.randomUUID(); const path = `${p.supplier_id}/${id}${ext}`;
      try {
        await db.docs.upload(path, f.buffer, DOC_TYPES[ext] || 'application/octet-stream');
        await db.insert('supplier_documents', { id, supplier_id: p.supplier_id, product_id: p.id, name, mime: DOC_TYPES[ext] || null, bytes: f.buffer.length, path, kind: 'specification' });
        stored = name;
      } catch { /* the fill still works without the stored copy */ }
    }
    const labels = Object.fromEntries(PRODUCT_FIELDS.filter((x) => keys.includes(x.key)).map((x) => [x.key, [x.en, x.cn, x.group]]));
    res.json({ ok: true, products, best, labels, docType: r.document_type || '', stored, model: r.model || '' });
  }));

  router.post('/admin/products/:id/documents/:docId/delete', G(async (req, res) => {
    const d = await db.get('supplier_documents', req.params.docId);
    if (d && d.product_id === req.params.id) {
      await db.docs.remove([d.path]).catch(() => {});
      await db.remove('supplier_documents', { id: d.id });
      flash(res, 'ok', 'File deleted');
    }
    back(res, req.params.id, 'documents');
  }));

  router.post('/admin/products/:id/review', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const section = fields.section || 'all';
    if ((section === 'all' || fields.stores_present) && !('target_stores' in fields)) fields.target_stores = [];
    const { row, errors } = F.cleanReview(fields);
    if (section === 'all' || section === 'costing') {
      const n = F.parseNumber(fields.planned_qty);
      if ('planned_qty' in fields) row.planned_qty = Number.isNaN(n) || n === null ? null : Math.round(n);
      if ('logistics_option_id' in fields) row.logistics_option_id = fields.logistics_option_id || null;
    }
    if (errors.length) { flash(res, 'error', errors.join(' · ')); return back(res, req.params.id, section === 'costing' ? 'costing' : 'review'); }
    await db.update('products', { id: req.params.id }, row);
    flash(res, 'ok', section === 'costing' ? 'Costing saved' : 'Review saved');
    back(res, req.params.id, section === 'costing' ? 'costing' : 'review');
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
    let [suppliers, products, acts] = await Promise.all([
      db.list('suppliers', { order: 'name.asc' }),
      db.list('products', { select: 'id,supplier_id,status,archived_at' }),
      db.list('supplier_activities', { select: 'supplier_id,activity_date,follow_up_date,done', order: 'activity_date.desc' }),
    ]);
    products = products.filter((p) => !p.archived_at);
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
    // Next follow-up = the earliest open item from "Schedule a follow-up" (older activity follow-ups and the old date field still count).
    const open = await require('../crm').openItems(db).catch(() => []);
    const nextOf = {}; for (const i of open) if (i.supplier_id && i.due_date && !nextOf[i.supplier_id]) nextOf[i.supplier_id] = i.due_date;
    const nextFu = (s) => [nextOf[s.id], s.next_follow_up].filter(Boolean).sort()[0] || null;
    const due = (s) => { const d = nextFu(s); return !!d && d <= today(); };
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
          <td><a href="/admin/suppliers/${s.id}">${s.name}</a>${s.needs_review ? html` <span class="pill s-new">Review</span>` : ''}<div class="sub">${s.categories_supplied || ''}</div></td>
          <td>${s.contact_name || '—'}<div class="sub">${s.email || ''}</div></td><td>${s.country || '—'}</td>
          <td>${s.crm_status}</td><td>${s.rating ? '★'.repeat(s.rating) : '—'}</td>
          <td class="r">${ps.length}</td><td class="r">${ps.filter((p) => ['Shortlisted', 'Sample requested', 'Selected'].includes(p.status)).length}</td>
          <td>${fmt.date(lastAct(s.id))}</td><td class="${due(s) ? 'neg' : ''}">${fmt.date(nextFu(s))}</td>
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

  const linkFlash = (res, email, r) => flash(res, 'link', `${r.emailed ? `Invitation emailed to ${email}.` : r.emailError ? `Email to ${email} was NOT sent: ${r.emailError}. The new invitation link works, copy it and send it yourself.` : `Invitation created for ${email}. Email is not configured: send this link yourself.`}|||${r.link}`);
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
    const [{ items, archivedCount }, acts, users, reqs] = await Promise.all([
      S.loadAnalyzed(db, { filters: { supplier_id: s.id } }),
      db.list('supplier_activities', { filters: { supplier_id: s.id }, order: 'activity_date.desc,created_at.desc' }),
      db.list('supplier_users', { filters: { supplier_id: s.id }, order: 'created_at.asc' }),
      db.list('info_requests', { filters: { supplier_id: s.id }, order: 'created_at.desc', limit: 20 }),
    ]);
    const fl = takeFlash(req, res);
    const dup = dupInfo(items);
    const docs = await db.list('supplier_documents', { filters: { supplier_id: s.id }, order: 'created_at.desc' }).catch(() => []);
    const imgs = await S.imagesFor(db, items.map(({ product: p }) => p.id));
    const urls = await db.storage.signedUrls(items.map(({ product: p }) => imgs[p.id]?.[0]?.thumb_path));
    const hasSku = items.some(({ product: p }) => p.supplier_sku);
    res.html(page({
      title: s.name, nav: adminNav('suppliers'), wide: true,
      flash: fl && fl.type !== 'link' ? fl : null,
      body: html`
      ${fl?.type === 'link' ? html`<div class="flash invite"><strong>${fl.msg.split('|||')[0]}</strong> The link is shown only once.<input class="copy" readonly value="${fl.msg.split('|||')[1] || ''}" data-copy><button class="btn small" type="button" data-copybtn>Copy</button></div>` : ''}
      ${s.needs_review ? html`<div class="flash warn"><b>Created automatically</b> from an RFQ logged by Hermes. Check the details, then <form method="post" action="/admin/suppliers/${s.id}/approve" class="inline"><button class="link">mark as reviewed</button></form>.</div>` : ''}
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
            <label class="span2"><span class="lbl">Notes</span><textarea name="notes" rows="3">${s.notes || ''}</textarea></label>
            <div class="span2"><button class="btn">Save</button></div>
          </form></section>
        ${await router.crmWidget?.(s.id, `/admin/suppliers/${s.id}`)}
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
      ${licenseCard(s)}
      <section class="card"><div class="head-row"><h2>Products (${items.length})</h2>
        <div class="actions"><a class="btn small ghost" href="/admin/archive?supplier=${s.id}">Archive${archivedCount ? ` (${archivedCount})` : ''}</a><a class="btn small ghost" href="/admin/products?supplier=${s.id}">Open in product list</a></div></div>
        ${dupAlert(dup)}
        ${reqs.length ? html`<p class="sub">Requests: ${reqs.map((r) => html`<a href="/admin/requests/${r.id}">${r.ref}</a> (${r.status}) `)}</p>` : ''}
        <form method="post" action="/admin/suppliers/${s.id}/request">
        <input type="hidden" name="back" value="/admin/suppliers/${s.id}">
        <div class="bulkbar"><span data-selcount>0 selected</span>
          <select name="status" aria-label="Set status"><option value="">Set status…</option>${F.STATUSES.map((st) => html`<option>${st}</option>`)}</select>
          <button class="btn small" name="action" value="status" formaction="/admin/products/bulk">Apply</button>
          <button class="btn small ghost" title="Ask the supplier for a dieline, checklist, samples…">Request information</button>
          ${archiveButtons('/admin/products/bulk')}</div>
        <table class="list compact"><thead><tr><th><input type="checkbox" data-checkall aria-label="Select all"></th><th></th>${hasSku ? html`<th>SKU</th>` : ''}<th>Product</th><th>Category</th><th class="r">Price</th><th class="r">Landed</th><th>Status</th></tr></thead>
        <tbody>${items.map(({ product: p, analysis: a }) => html`<tr><td><input type="checkbox" name="ids" value="${p.id}" ${dup.byId.get(p.id)?.extra ? raw('data-dupextra') : ''}></td><td class="thumb-cell"><a href="/admin/products/${p.id}" tabindex="-1">${imgs[p.id]?.[0] && urls[imgs[p.id][0].thumb_path] ? html`<img src="${urls[imgs[p.id][0].thumb_path]}" alt="" loading="lazy">` : html`<span class="noimg" title="No photo yet"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg></span>`}</a></td>${hasSku ? html`<td class="sku-cell">${p.supplier_sku || '—'}</td>` : ''}<td><a href="/admin/products/${p.id}">${skuless(p)}</a>${dupPill(dup, p.id)}</td><td>${p.category || '—'}</td><td class="r">${fmt.money(p.unit_price, p.currency)}</td><td class="r">${fmt.money(a.landed_cost)}</td><td>${statusPill(p.status)}</td></tr>`)}</tbody></table></form>
        <h3>Import products for this supplier</h3>
        <form method="post" enctype="multipart/form-data" action="/admin/suppliers/${s.id}/import" class="import-form">
          ${fileDrop({ accept: '.xlsx,.csv,.pdf,.png,.jpg,.jpeg,.webp', main: raw('Drag &amp; drop a product list here, or <u>choose a file</u>'), hint: 'Our template, or any supplier layout: price list, proforma invoice, quotation (.xlsx, .csv, PDF or a photo). Non-standard files are read by AI · max 15 MB' })}
          <div class="import-actions"><button class="btn small">Import</button><label class="chk small"><input type="checkbox" name="ai" value="1"> Always read with AI</label>
            <a href="/static/Lulyboo_Supplier_Product_Template.xlsx">Template</a> · <a href="/static/Lulyboo_Factory_Quotation_Request_2026.xlsx">Quotation form</a></div></form>
      </section>
      ${docs.length ? html`<section class="card"><h2>Documents</h2>
        <ul class="doc-list">${docs.map((d) => html`<li><span class="doc-ic">▤</span><a href="/admin/documents/${d.id}" download>${d.name}</a><span class="sub">${fmt.date(d.created_at)} · ${fmtBytes(d.bytes)} · ${items.filter(({ product: p }) => p.source_document_id === d.id).length} products</span>
          ${ST.can(ST.current()?.role, 'delete') ? html`<form method="post" action="/admin/documents/${d.id}/delete" data-confirm="Delete this file? The products imported from it are kept." class="inline"><button class="link danger">Delete</button></form>` : ''}</li>`)}</ul></section>` : ''}
      ${ST.can(ST.current()?.role, 'delete') ? html`<form method="post" action="/admin/suppliers/${s.id}/delete" data-confirm="Delete this supplier, ALL its products, photos and activity? This cannot be undone." class="danger-zone"><button class="link danger">Delete supplier</button></form>` : ''}`,
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
  // ── Business license: save number/file, serve file, AI check
  const licErr = (e) => (/business_license|license_info|license_checked/i.test(String(e.message)) ? 'Run the business-license SQL in Supabase first (new supplier columns are missing).' : e.message);
  router.post('/admin/suppliers/:id/license', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id); if (!s) throw new HttpError(404, 'Supplier not found');
    const { fields, files } = await parseForm(req, { limitBytes: LIC.MAX_LICENSE_BYTES + 1024 * 1024 });
    const no = LIC.normalizeNo(fields.business_license_no);
    const st = await LIC.storeLicense(db, s.id, [].concat(files?.license_file || [])[0]);
    if (st.error) { flash(res, 'error', st.error); return res.redirect(`/admin/suppliers/${s.id}`); }
    const patch = { business_license_no: no };
    if (st.saved) { patch.business_license_path = st.saved.path; patch.business_license_name = st.saved.name; }
    if (no !== (s.business_license_no || null) || st.saved) { patch.license_info = null; patch.license_checked_at = null; }
    try { await db.update('suppliers', { id: s.id }, patch); } catch (e) { flash(res, 'error', licErr(e)); return res.redirect(`/admin/suppliers/${s.id}`); }
    if (st.saved && s.business_license_path) await db.docs.remove([s.business_license_path]).catch(() => {});
    const ck = no && LIC.looksChinese({ ...s, business_license_no: no }) ? LIC.checkUSCC(no) : null;
    flash(res, ck && !ck.valid ? 'warn' : 'ok', ck && !ck.valid ? `Saved, but the credit code looks wrong: ${ck.reason}` : 'Business license saved');
    res.redirect(`/admin/suppliers/${s.id}`);
  }));
  router.post('/admin/suppliers/:id/license/remove', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id); if (!s) throw new HttpError(404, 'Supplier not found');
    if (s.business_license_path) { await db.docs.remove([s.business_license_path]).catch(() => {}); await db.update('suppliers', { id: s.id }, { business_license_path: null, business_license_name: null, license_info: null, license_checked_at: null }); }
    flash(res, 'ok', 'License file removed'); res.redirect(`/admin/suppliers/${s.id}`);
  }));
  router.get('/admin/suppliers/:id/license-file', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id); if (!s?.business_license_path) throw new HttpError(404, 'No license file');
    const ext = LIC.extOf(s.business_license_path);
    sendFile(res, await db.docs.download(s.business_license_path), s.business_license_name || `business-license${ext}`, LIC.LICENSE_MIME[ext], req.query.inline === '1');
  }));
  router.post('/admin/suppliers/:id/license/check', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id); if (!s) throw new HttpError(404, 'Supplier not found');
    if (!AI.enabled()) { flash(res, 'error', 'AI is not configured: set ANTHROPIC_API_KEY in Railway'); return res.redirect(`/admin/suppliers/${s.id}`); }
    if (!s.business_license_no && !s.business_license_path) { flash(res, 'error', 'Add the license number or upload the license first'); return res.redirect(`/admin/suppliers/${s.id}`); }
    try {
      const info = await LIC.runCheck({ db, supplier: s });
      await db.update('suppliers', { id: s.id }, { license_info: info, license_checked_at: info.checked_at });
      flash(res, info.verdict === 'ok' ? 'ok' : 'warn', info.verdict === 'ok' ? 'License checked: data matches' : info.verdict === 'review' ? 'License checked: some points need your review' : 'License checked: could not confirm the company');
    } catch (e) { flash(res, 'error', `License check failed: ${licErr(e)}`); }
    res.redirect(`/admin/suppliers/${s.id}`);
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
  // ── Source files of imports
  router.get('/admin/documents/:id', G(async (req, res) => {
    if (!/^[\w-]{1,64}$/.test(req.params.id)) throw new HttpError(404, 'File not found');
    const d = await db.get('supplier_documents', req.params.id);
    if (!d) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(d.path);
    if (!buf) throw new HttpError(404, 'The stored file is missing');
    const okInline = req.query.inline === '1' && /\.(pdf|png|jpe?g|webp|gif|txt)$/i.test(d.name);
    sendFile(res, buf, d.name, okInline ? (DOC_TYPES[(d.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()] || d.mime) : d.mime, okInline);
  }));
  router.post('/admin/documents/:id/delete', G(async (req, res) => {
    const d = await db.get('supplier_documents', req.params.id);
    if (!d) throw new HttpError(404, 'File not found');
    await db.docs.remove([d.path]).catch(() => {});
    await db.remove('supplier_documents', { id: d.id });
    flash(res, 'ok', `${d.name} deleted. Products imported from it are kept.`);
    res.redirect(`/admin/suppliers/${d.supplier_id}`);
  }));
  router.post('/admin/suppliers/:id/delete', G(async (req, res) => {
    const docs = await db.list('supplier_documents', { filters: { supplier_id: req.params.id }, select: 'path' }).catch(() => []);
    if (docs.length) await db.docs.remove(docs.map((x) => x.path)).catch(() => {});
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
    const { fields } = await parseForm(req).catch(() => ({ fields: {} }));
    res.redirect(/^\/admin\/[\w\/?=&.-]*$/.test(fields.back || '') ? fields.back : `/admin/suppliers/${a.supplier_id}`);
  }));
  router.post('/admin/suppliers/:id/import', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const { files, fields: ff } = await parseForm(req, { limitBytes: 16 * 1024 * 1024 });
    const file = files.file?.[0];
    if (!file) { flash(res, 'error', 'Choose a file'); return res.redirect(`/admin/suppliers/${s.id}`); }
    // Step 1: read the file and show the main fields for checking. Nothing is saved until you approve.
    const r = await IR.startReview(db, file, s.id, { admin: true, action: `/admin/suppliers/${s.id}/import` }, { ai: ff?.ai === '1' });
    res.html(page({ title: 'Import', nav: adminNav('suppliers'), body: html`<h1>Import for ${s.name}</h1>${r.page ? r.page : importResult(r.result, null)}<p><a href="/admin/suppliers/${s.id}">← Back to ${s.name}</a></p>` }));
  }));
  router.post('/admin/suppliers/:id/import/confirm', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const { fields } = await parseForm(req, { limitBytes: 4 * 1024 * 1024 });
    const r = await IR.finishReview(db, s.id, fields, { admin: true, action: `/admin/suppliers/${s.id}/import` });
    const body = r.page ? r.page : importResult(r.expired ? IR.expiredResult() : r.done, null);
    res.html(page({ title: 'Import', nav: adminNav('suppliers'), body: html`<h1>Import for ${s.name}</h1>${body}<p><a href="/admin/suppliers/${s.id}">← Back to ${s.name}</a></p>` }));
  }));
  router.get('/admin/suppliers/:id/import/source', G(async (req, res) => {
    const f = IR.stagedSource(req.params.id, String(req.query.token || ''));
    if (!f) throw new HttpError(404, 'This review expired. Upload the file again.');
    sendFile(res, f.buffer, f.name, f.type);
  }));
  router.post('/admin/suppliers/:id/import/ai-describe', G(async (req, res) => {
    const { fields } = await parseForm(req, { limitBytes: 64 * 1024 });
    const r = await IR.aiDescribe(req.params.id, fields);
    res.json(r.body, r.status);
  }));
  router.get('/admin/suppliers/:id/import/image', G(async (req, res) => {
    const im = await IR.reviewImage(req.params.id, String(req.query.token || ''), req.query.row, req.query.i, req.query.s);
    if (!im) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', im.type); res.setHeader('Cache-Control', 'private, max-age=600'); res.end(im.buffer);
  }));
  router.post('/admin/suppliers/:id/import/cancel', G(async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (!s) throw new HttpError(404, 'Supplier not found');
    const { fields } = await parseForm(req);
    IR.cancelReview(s.id, fields.token);
    flash(res, 'info', 'Import cancelled. Nothing was saved.');
    res.redirect(`/admin/suppliers/${s.id}`);
  }));
};

module.exports.guard = guard;
module.exports.applyFilters = applyFilters;
module.exports.filterBar = filterBar;
module.exports.dutyHelp = dutyHelp;
