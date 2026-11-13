'use strict';
// Product workspace: header + five tabs (Overview, Costing, Logistics, Review, Documents).
// Everything is rendered from one data load; tabs switch in the browser (public/app.js), so no extra requests.
const { html, raw, fmt } = require('../lib/html');
const { icon } = require('./icons');
const F = require('../fields');
const { statusPill, imageGrid, productFields, fileDrop } = require('./layout');

const none = html`<span class="none">—</span>`;
const has = (x) => x !== null && x !== undefined && String(x).trim() !== '';
const val = (x, suffix = '') => (has(x) ? html`${x}${suffix}` : none);
const spec = (label, v) => html`<div class="sp"><dt>${label}</dt><dd>${v}</dd></div>`;
const chip = (text, cls = '') => html`<span class="tag-chip ${cls}">${text}</span>`;

/** "20.00*13.00*2.00CM cm" → "20.00 × 13.00 × 2.00 cm" */
function normSize(s) {
  if (!has(s)) return null;
  const core = String(s).trim().replace(/\s*cm\s*$/i, '');
  return /^[\d.\s*xX×,]+$/.test(core) ? `${core.replace(/\s*[*xX×]\s*/g, ' × ')} cm` : String(s);
}
const DOC_KINDS = { quotation: 'Supplier quotation', certificate: 'Certificate', test_report: 'Test report', specification: 'Specification', other: 'Other' };
const UPLOAD_KINDS = ['certificate', 'test_report', 'specification', 'other'];
const PREVIEWABLE = /\.(pdf|png|jpe?g|webp|gif|txt)$/i;
const extOf = (n) => ((String(n).match(/\.([a-z0-9]+)$/i) || [])[1] || '').toUpperCase() || 'FILE';

function missingInfo(p) {
  const miss = [];
  const need = (ok, label) => { if (!ok) miss.push(label); };
  need(has(p.description), 'Description'); need(has(p.materials), 'Materials'); need(has(p.product_size_cm), 'Product size');
  need(has(p.unit_net_weight_kg), 'Unit weight'); need(has(p.certifications), 'Certifications'); need(has(p.country_of_origin), 'Country of origin');
  need(has(p.hs_code), 'HS code'); need(has(p.units_per_carton), 'Units per carton');
  need(has(p.carton_l_cm) && has(p.carton_w_cm) && has(p.carton_h_cm), 'Carton size'); need(has(p.carton_gw_kg), 'Carton weight');
  need(has(p.payment_terms), 'Payment terms');
  return miss;
}

/** Small tag on the Pricing & Terms legend: can the supplier see these values? */
function pricingTag(p, supplier) {
  const PV = require('../pricing-visibility');
  if (PV.addedBySupplier(p)) return html`<span class="pa-tag own">Supplier's own product — visible to them</span>`;
  return supplier?.show_pricing
    ? html`<span class="pa-tag vis">Visible to ${supplier.name}</span> <a class="pa-chg" href="/admin/suppliers/${p.supplier_id}#portal-access">change</a>`
    : html`<span class="pa-tag hid">🔒 Hidden from ${supplier?.name || 'the supplier'}</span> <a class="pa-chg" href="/admin/suppliers/${p.supplier_id}#portal-access">change</a>`;
}

function renderWorkspace(c) {
  const { p, a, realA, ctx, supplier, imgs, urls, srcDoc, docs, docsReady, analyses, activeOpts, testDuty, canDelete, dutyHtml, renderAnalysis } = c;
  const v = (x) => (x === null || x === undefined ? '' : x);
  const stars = p.score ? '★'.repeat(p.score) + '☆'.repeat(5 - p.score) : '';
  const money = (x) => (x === null || x === undefined ? '—' : fmt.money(x));
  const fit = a.fits || {};
  const miss = missingInfo(p);
  const dutyVerified = a.duty_source === 'AI / USITC' || a.duty_source === 'manual';
  const isChina = !p.country_of_origin || /^(china|cn|prc|中国)$/i.test(String(p.country_of_origin).trim());
  const wholesale = p.our_wholesale_usd ?? a.pricing.suggested_wholesale;
  const markup = a.landed_cost && wholesale ? ((wholesale - a.landed_cost) / a.landed_cost) * 100 : null;
  const retail = p.our_retail_usd ?? p.suggested_retail_usd;
  const desc = has(p.description) ? String(p.description).replace(/\r/g, '').replace(/\n[ \t]*\n+/g, '\n').trim() : '';
  const longDesc = desc.split('\n').length > 4 || desc.length > 360;
  const hero = imgs[0];
  const tab = (id, label, badge) => html`<button type="button" role="tab" class="pw-tab" id="tabbtn-${id}" data-tab="${id}" aria-controls="tab-${id}" aria-selected="false">${label}${badge ? html`<span class="tab-badge ${badge.warn ? 'warn' : ''}">${badge.text}</span>` : ''}</button>`;
  const status = (kind, text) => html`<span class="est ${kind}">${text}</span>`;
  const costRow = (label, value, note, st) => html`<div class="pr"><dt>${label}${st || ''}</dt><dd>${value}${note ? html` <span class="sub">${note}</span>` : ''}</dd></div>`;
  const dirty = html`<span class="dirty-note" data-dirty-note hidden>Unsaved changes</span>`;

  // ── Header ────────────────────────────────────────────────
  const header = html`<div class="pw-head" data-pw-head>
    <nav class="crumb" aria-label="Breadcrumb"><a href="/admin/products">Products</a><span>›</span><a href="/admin/suppliers/${p.supplier_id}">${supplier?.name || 'Supplier'}</a></nav>
    <div class="pw-top">
      <div class="pp-title"><h1>${p.product_name}</h1>${statusPill(p.status)}${stars ? html`<span class="stars" title="Score ${p.score} of 5">${stars}</span>` : ''}${p.archived_at ? html`<span class="pill s-closed">Archived</span>` : ''}</div>
      <div class="pp-actions">
        <form method="post" action="/admin/products/${p.id}/ai-similar" data-go-tab="review"><button class="btn ghost small" data-busy>Find similar</button></form>
        <form method="post" action="/admin/products/${p.id}/ai-review" data-go-tab="review"><button class="btn small" data-busy>AI review</button></form>
        <details class="more-menu"><summary class="btn ghost small icon-only" aria-label="More actions">${icon('more', 16)}</summary>
          <div class="mm-pop">
            <a href="#edit" data-open-edit>Edit supplier data</a> · <a href="#edit" data-open-edit data-aifill-open>Fill from a file with AI</a>
            <form method="post" action="/admin/products/bulk" data-confirm="${p.archived_at ? 'Restore this product from the archive?' : 'Archive this product? It is hidden from the lists and the supplier portal. You can restore it later.'}"><input type="hidden" name="ids" value="${p.id}"><input type="hidden" name="back" value="/admin/products/${p.id}"><button name="action" value="${p.archived_at ? 'unarchive' : 'archive'}">${p.archived_at ? 'Restore from archive' : 'Archive'}</button></form>
            ${canDelete ? html`<form method="post" action="/admin/products/${p.id}/delete" data-confirm="Delete this product and its photos? This cannot be undone."><button class="danger">Delete product</button></form>` : ''}
          </div></details>
      </div>
    </div>
    <ul class="pp-meta">
      <li><a href="/admin/suppliers/${p.supplier_id}">${supplier?.name}</a></li>
      ${p.supplier_sku ? html`<li><span>SKU</span> ${p.supplier_sku}</li>` : ''}
      <li>${p.category || 'No category'}${p.subcategory ? ` / ${p.subcategory}` : ''}</li>
      <li><span>Submitted</span> ${fmt.date(p.created_at)}</li>
      ${srcDoc ? html`<li><a href="/admin/documents/${srcDoc.id}" download title="Original quotation file: ${srcDoc.name}" class="src-chip">${icon('download', 13)}<span class="trunc">Source file: ${srcDoc.name}</span></a></li>` : ''}
    </ul>
    <div class="pw-tabs" role="tablist" aria-label="Product sections">
      ${tab('overview', 'Overview', a.issues.length || miss.length ? { text: a.issues.length + miss.length, warn: true } : null)}${tab('costing', 'Costing')}${tab('logistics', 'Logistics')}${tab('review', 'Review')}${tab('documents', 'Documents', { text: imgs.length + docs.length + (srcDoc ? 1 : 0) })}
    </div>
  </div>`;

  const banners = html`${testDuty !== null ? html`<div class="flash warn test-banner"><strong>TEST MODE</strong> — costs use a duty of <strong>${testDuty}%</strong>. Nothing is saved. Real landed cost: ${fmt.money(realA.landed_cost)} at ${realA.duty_pct}% (${realA.duty_source}).
      <form method="post" action="/admin/products/${p.id}/duty/apply-override" class="inline"><input type="hidden" name="duty" value="${testDuty}"><button class="btn small">Apply ${testDuty}% as manual override</button></form>
      <a class="btn ghost small" href="/admin/products/${p.id}#costing">Exit test mode</a></div>` : ''}
    ${p.archived_at ? html`<div class="flash info">This product is archived and hidden from the product lists and the supplier's portal. <a href="/admin/archive">Open the Archive</a></div>` : ''}`;

  // ── Overview ──────────────────────────────────────────────
  const overview = html`<section class="pw-panel" role="tabpanel" id="tab-overview" aria-labelledby="tabbtn-overview" data-panel="overview">
    <div class="ov-grid">
      <div class="card ov-gallery">
        ${hero ? html`<a class="pd-hero" href="${urls[hero.path]}" data-preview="${urls[hero.path] || urls[hero.thumb_path]}" data-type="image" data-gallery="product"><img src="${urls[hero.path] || urls[hero.thumb_path]}" alt="${p.product_name}"></a>
          ${imgs.length > 1 ? html`<div class="pd-thumbs">${imgs.slice(1, 5).map((im) => html`<a href="${urls[im.path]}" data-preview="${urls[im.path] || urls[im.thumb_path]}" data-type="image" data-gallery="product"><img src="${urls[im.thumb_path]}" alt="" loading="lazy"></a>`)}${imgs.length > 5 ? html`<a class="pd-more" href="#documents" data-goto-tab="documents">+${imgs.length - 5}</a>` : ''}</div>` : ''}`
          : html`<div class="pd-hero empty">No photo yet<br><a href="#documents" data-goto-tab="documents">Add photos</a></div>`}
        ${p.photo_link ? html`<p class="sub"><a href="${p.photo_link}" target="_blank" rel="noopener noreferrer">Supplier photo / catalog link ↗</a></p>` : ''}
      </div>
      <div class="ov-main">
        <div class="facts">
          <div class="fact"><span>Factory price</span><b>${has(p.unit_price) ? fmt.money(p.unit_price, p.currency) : '—'}</b><small>${[p.incoterm, p.fob_port].filter(Boolean).join(' · ') || 'Incoterm not given'}</small></div>
          <div class="fact strong"><span>Landed estimate ${dutyVerified ? status('ok', 'duty verified') : status('est', 'estimate')}</span><b>${money(a.landed_cost)}</b><small>${a.primary?.name || 'No logistics option'}</small></div>
          <div class="fact"><span>MOQ</span><b>${has(p.moq) ? fmt.num(p.moq) : '—'}</b><small>${a.moq_cartons ? `${a.moq_cartons} cartons` : 'units'}</small></div>
          <div class="fact"><span>Lead time</span><b>${has(p.production_lead_days) ? `${p.production_lead_days} d` : '—'}</b><small>${has(p.sample_lead_days) ? `samples ${p.sample_lead_days} d` : 'production'}</small></div>
        </div>
        ${a.issues.length || miss.length ? html`<div class="notices">
          ${a.issues.length ? html`<div class="notice warn"><b>${a.issues.length} ${a.issues.length === 1 ? 'check' : 'checks'}</b><ul>${a.issues.map((i) => html`<li>${i}</li>`)}</ul></div>` : ''}
          ${miss.length ? html`<div class="notice info"><b>Missing information</b><div class="chips-line">${miss.map((m) => chip(m))}</div><a href="#edit" data-open-edit class="small">Fill in supplier data</a></div>` : ''}</div>` : ''}
        <div class="card sum">
          <div class="sum-head"><h2 class="sec">Summary</h2><div class="sum-tools"><button type="button" class="btn ghost small" data-ai-describe data-url="/admin/products/${p.id}/ai-describe" ${desc ? '' : raw('disabled')}>✨ Clean up with AI</button><a class="btn ghost small" href="#edit" data-open-edit>Edit details</a></div></div>
          ${desc ? html`<div class="pd-desc ${longDesc ? 'clamp' : ''}" data-clamp>${desc}</div>${longDesc ? html`<button type="button" class="link small" data-clamp-toggle aria-expanded="false">Show original description</button>` : ''}` : html`<p class="none">No description given</p>`}
          <div class="ai-box" data-ai-box hidden>
            <div class="ai-head"><b>AI suggestion</b><small>Review and edit before applying. Nothing changes until you press Apply.</small></div>
            <form method="post" action="/admin/products/${p.id}/description"><textarea name="description" rows="6" data-ai-text aria-label="Suggested description"></textarea>
              <div class="ai-actions"><button class="btn small">Apply to description</button><button type="button" class="btn ghost small" data-ai-discard>Discard</button></div></form>
          </div>
          <p class="ai-msg" data-ai-msg role="status" hidden></p>
          <dl class="specs">
            ${spec('Materials', val(p.materials))}${spec('Product size (L × W × H)', has(p.product_size_cm) ? normSize(p.product_size_cm) : none)}
            ${spec('Unit net weight', val(p.unit_net_weight_kg, ' kg'))}${spec('Packaging', val(p.packaging_type))}
            ${spec('Certifications', val(p.certifications))}${spec('Battery / magnet / liquid', val(p.dangerous_goods))}
            ${spec('HS code (supplier)', val(p.hs_code))}${spec('Country of origin', val(p.country_of_origin))}
            ${spec('Brand', val(p.brand))}${spec('Payment terms', val(p.payment_terms))}
          </dl>
          ${p.factory_notes ? html`<h3 class="sec2">Factory notes</h3><p class="pd-desc">${p.factory_notes}</p>` : ''}
        </div>
      </div>
    </div>
    <details class="card fold" id="edit"><summary><h2 class="inline">Edit supplier data</h2><span class="muted small">Change what the supplier submitted. Photos and files are in Documents.</span></summary>
      <dialog class="rp-modal aifill-dlg" data-aifill-dlg aria-labelledby="aifill-t"><form method="dialog" data-aifill-form>
        <div class="rp-top"><h2 id="aifill-t">Check what AI read</h2><button type="button" class="icon-btn" data-aifill-close aria-label="Close">×</button></div>
        <p class="sub rp-ctx" data-aifill-ctx></p>
        <label class="aifill-pick" data-aifill-pickwrap hidden>Product in this file <select data-aifill-pick></select></label>
        <div class="aifill-bar"><span class="sub" data-aifill-count></span><span><button type="button" class="link small" data-aifill-all>Select all</button> · <button type="button" class="link small" data-aifill-none>None</button></span></div>
        <div class="table-wrap aifill-scroll"><table class="list aifill-t"><thead><tr><th></th><th>Field</th><th>Now</th><th>From the file</th></tr></thead><tbody data-aifill-rows></tbody></table></div>
        <div class="rp-actions"><button type="button" class="btn" data-aifill-apply>Apply to form</button><button type="button" class="btn ghost" data-aifill-close>Cancel</button><span class="sub">Nothing is saved until you click Save product.</span></div>
      </form></dialog>
      <form method="post" enctype="multipart/form-data" action="/admin/products/${p.id}/edit" class="product-form" data-guard>
        <label class="photo-link-field"><span class="lbl">Supplier photo / catalog link</span><input name="photo_link" value="${p.photo_link || ''}" placeholder="https://"></label>
        ${productFields(p, { categories: ctx.categoryNames, notes: { pricing: pricingTag(p, supplier) }, slot: html`<div class="aifill aifill-cell" data-aifill="/admin/products/${p.id}/ai-fill">
          <span class="lbl">Fill with AI</span>
          <div class="pk-ai aifill-z" data-aifill-drop>
            <span class="pk-ai-ic" aria-hidden="true">✦</span>
            <textarea rows="1" class="pk-ai-in" data-aifill-text aria-label="Fill with AI: paste a screenshot or text, or drop a file" placeholder="Paste or drop a file" title="Paste a screenshot or text (⌘V), or drop a spec sheet, PI, quotation or packing list"></textarea>
            <button type="button" class="pk-ai-b pk-ai-go" data-aifill-read hidden>Read</button>
            <button type="button" class="pk-ai-b" data-aifill-choose title="Choose a file — spec sheet, PI, quotation, packing list or photo">File</button>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xlsm,.csv" hidden data-aifill-file>
            <span class="pk-ai-over" aria-hidden="true">Drop it here</span>
          </div>
          <label class="aifill-keep" title="Keep the file in this product's Documents"><input type="checkbox" data-aifill-keep checked> Save the file to Documents</label>
          <p class="aifill-status" data-aifill-status role="status" aria-live="polite"></p>
        </div>` })}
        <div class="form-actions"><button class="btn" data-save>Save product</button>${dirty}</div>
      </form>
    </details>
  </section>`;

  // ── Costing ───────────────────────────────────────────────
  const chinaRow = a.tariff_pct
    ? costRow('China tariff', fmt.money(a.primary?.tariff_per_unit), `${a.tariff_pct}%${a.blanket_tariff_pct ? ` (incl. ${a.blanket_tariff_pct}% blanket from Settings)` : ''}`, status('ok', 'AI / USITC'))
    : isChina ? costRow('China tariff', a.duty_source === 'manual' ? html`<span class="sub">included in the manual duty</span>` : p.duty_ai_checked_at ? '$0.00' : html`<a href="#duty" class="warn-text" data-goto-tab="costing">Not researched</a>`, '', a.duty_source === 'manual' ? status('ok', 'manual') : p.duty_ai_checked_at ? status('ok', 'checked') : status('warn', 'not in landed cost')) : '';
  const costing = html`<section class="pw-panel" role="tabpanel" id="tab-costing" aria-labelledby="tabbtn-costing" data-panel="costing" hidden>
    <div class="legend"><span>Figures are labelled:</span>${status('quote', 'supplier quote')}${status('ok', 'verified')}${status('est', 'estimate')}${status('warn', 'not verified')}</div>
    <div class="cs-grid">
      <section class="card"><h2 class="sec">Landed cost per unit</h2>
        <dl class="pricing">
          ${costRow('Factory price', `${fmt.money(p.unit_price, p.currency)} ${p.incoterm || ''} ${p.fob_port || ''}`.trim(), p.currency !== 'USD' ? `${fmt.money(a.unit_price_usd)} @ ${ctx.settings.fx_to_usd?.[p.currency] ?? '?'}` : '', status('quote', 'supplier quote'))}
          ${costRow('Freight', fmt.money(a.primary?.freight_per_unit), a.primary?.name || '', status('est', 'estimate'))}
          ${costRow('Duty', fmt.money(a.primary?.duty_per_unit), `${a.base_duty_pct}% (${a.duty_source})`, dutyVerified ? status('ok', a.duty_source === 'manual' ? 'manual' : 'verified') : status('est', 'default'))}
          ${chinaRow}
          ${costRow('Customs fees + insurance', fmt.money((a.primary?.customs_fees_per_unit ?? 0) + (a.primary?.insurance_per_unit ?? 0)), '', status('est', 'estimate'))}
          <div class="pr total"><dt>Landed cost</dt><dd>${fmt.money(a.landed_cost)}</dd></div>
        </dl>
        <p class="sub">${dutyVerified ? 'Duty is verified.' : 'Duty is a default, not verified for this product.'} Freight and fees come from your rate cards and settings.</p>
      </section>
      <div class="cs-side">
        <section class="card"><h2 class="sec">Margin &amp; prices</h2>
          <dl class="pricing">
            ${costRow('Target margin', `${a.pricing.target_margin_pct}%`)}
            ${costRow('Suggested wholesale', fmt.money(a.pricing.suggested_wholesale))}
            ${costRow('Our wholesale', fmt.money(p.our_wholesale_usd), has(p.our_wholesale_usd) ? '' : 'not set')}
            ${costRow('Margin', a.margin_pct !== null ? html`<span class="${a.margin_pct < a.pricing.target_margin_pct ? 'neg' : 'pos'}">${fmt.pct(a.margin_pct)}</span>` : '—', a.margin_pct !== null ? `target ${a.pricing.target_margin_pct}%` : '')}
            ${costRow('Markup on landed', markup !== null ? fmt.pct(markup) : '—', has(p.our_wholesale_usd) ? '' : 'at suggested wholesale')}
            ${costRow('Retail', fmt.money(retail), a.pricing.retailer_margin_pct !== undefined ? `retailer margin ${fmt.pct(a.pricing.retailer_margin_pct)}` : '')}
          </dl></section>
        <section class="card"><h2 class="sec">Pricing inputs</h2>
          <form method="post" action="/admin/products/${p.id}/review" class="fields" data-guard>
            <input type="hidden" name="section" value="costing">
            <label class="frow"><span>Our wholesale</span><span class="inp-unit"><input name="our_wholesale_usd" type="number" step="0.01" min="0" value="${v(p.our_wholesale_usd)}" placeholder="${v(a.pricing.suggested_wholesale)}"><i>USD</i></span></label>
            <label class="frow"><span>Our retail</span><span class="inp-unit"><input name="our_retail_usd" type="number" step="0.01" min="0" value="${v(p.our_retail_usd)}"><i>USD</i></span></label>
            <label class="frow"><span>Planned order qty</span><span class="inp-unit"><input name="planned_qty" type="number" step="1" min="0" value="${v(p.planned_qty)}" placeholder="MOQ ${v(p.moq)}"><i>units</i></span></label>
            <label class="frow"><span>Duty % override</span><span class="inp-unit"><input name="duty_rate_pct" type="number" step="0.01" min="0" value="${v(p.duty_rate_pct)}" placeholder="${a.duty_pct}"><i>%</i></span></label>
            <label class="frow"><span>Logistics scenario</span><select name="logistics_option_id"><option value="">Default (${activeOpts.find((o) => o.id === ctx.settings.default_logistics_option_id)?.name || 'first available'})</option>
              ${activeOpts.map((o) => html`<option value="${o.id}" ${o.id === p.logistics_option_id ? raw('selected') : ''}>${o.name}</option>`)}</select></label>
            <div class="form-actions"><button class="btn small" data-save>Save costing</button>${dirty}</div>
          </form></section>
      </div>
    </div>
    <details class="card fold advanced" id="advanced"><summary><h2 class="inline">Advanced: duty &amp; HTS research, what-if</h2><span class="muted small">Check the tariff code, test a duty rate</span></summary>
      ${dutyHtml}
    </details>
  </section>`;

  // ── Logistics ─────────────────────────────────────────────
  const dims = [p.carton_l_cm, p.carton_w_cm, p.carton_h_cm];
  const carton = dims.every(has) ? `${dims.join(' × ')} cm` : null;
  const statedKey = { '20GP': 'supplier_qty_20gp', '40GP': 'supplier_qty_40gp', '40HQ': 'supplier_qty_40hq' };
  const logistics = html`<section class="pw-panel" role="tabpanel" id="tab-logistics" aria-labelledby="tabbtn-logistics" data-panel="logistics" hidden>
    <div class="lg-grid">
      <section class="card"><h2 class="sec">Packing</h2>
        <dl class="specs one">
          ${spec('Units per carton', val(p.units_per_carton))}${spec('Units per inner pack', val(p.units_per_inner))}
          ${spec('Master carton size', carton || none)}${spec('Carton weight (net / gross)', has(p.carton_nw_kg) || has(p.carton_gw_kg) ? `${p.carton_nw_kg ?? '—'} / ${p.carton_gw_kg ?? '—'} kg` : none)}
          ${spec('Carton volume', a.carton_cbm ? `${a.carton_cbm} CBM` : none)}${spec('Volume per unit', a.unit_cbm ? `${a.unit_cbm} CBM` : none)}
          ${spec('MOQ in cartons', a.moq_cartons ? `${a.moq_cartons} cartons · ${a.moq_cbm ?? '—'} CBM` : none)}
        </dl></section>
      <section class="card"><h2 class="sec">Container capacity</h2>
        <div class="table-wrap"><table class="list compact cap">
          <thead><tr><th>Container</th><th class="r">Calculated</th><th class="r">Supplier says</th><th class="r">Fill</th><th>Check</th></tr></thead>
          <tbody>${['20GP', '40GP', '40HQ'].map((cn) => { const f = fit[cn]; const stated = p[statedKey[cn]]; const diff = f && has(stated) && f.units ? Math.round(((stated - f.units) / f.units) * 100) : null;
            return html`<tr><td><b>${cn}</b></td><td class="r">${f ? html`${fmt.num(f.units)}<div class="sub">${fmt.num(f.cartons)} cartons</div>` : html`<span class="muted">needs carton size</span>`}</td>
              <td class="r">${has(stated) ? fmt.num(stated) : none}</td><td class="r">${f ? `${f.fillPct}%` : '—'}</td>
              <td>${diff === null ? '' : Math.abs(diff) > 5 ? html`<span class="est warn">${diff > 0 ? '+' : ''}${diff}% vs calculated</span>` : html`<span class="est ok">matches</span>`}</td></tr>`; })}</tbody></table></div>
        <p class="sub"><b>Calculated</b> = our own carton-fit calculation. <b>Supplier says</b> = the figure in the quotation. They are never mixed.</p>
        <details class="fit-details"><summary>Container fit details</summary>
          <ul class="plain">${['20GP', '40GP', '40HQ'].map((cn) => { const f = fit[cn]; return f ? html`<li><b>${cn}</b>: ${fmt.num(f.cartons)} cartons, limited by ${f.limitedBy}, carton orientation ${f.orientation.join(' × ')} cm</li>` : html`<li><b>${cn}</b>: needs carton size</li>`; })}</ul></details>
      </section>
    </div>
    <section class="card"><div class="sec-row"><h2 class="sec">Shipping scenarios</h2><a class="small" href="/admin/logistics">Edit rates in Logistics</a></div>
      <div class="table-wrap"><table class="list compact">
        <thead><tr><th>Option</th><th class="r">Shipment qty</th><th class="r">Freight total</th><th class="r">Freight / unit</th><th class="r">Landed / unit</th><th class="r">Transit</th></tr></thead>
        <tbody>${a.scenarios.map((s) => html`<tr class="${s.option_id === a.primary?.option_id ? 'hl' : ''}">
          <td>${s.name}${s.option_id === a.primary?.option_id ? html` <span class="pill">costing</span>` : ''}${s.option_id === a.cheapest?.option_id ? html` <span class="pill s-selected">cheapest</span>` : ''}${s.notes.length ? html`<div class="sub">${s.notes.join(' · ')}</div>` : ''}</td>
          <td class="r">${fmt.num(s.shipment_qty)}${s.containers ? html`<div class="sub">${s.containers} ctr</div>` : s.shipment_cbm ? html`<div class="sub">${s.shipment_cbm} CBM</div>` : ''}</td>
          <td class="r">${fmt.money(s.freight_total)}</td><td class="r">${fmt.money(s.freight_per_unit)}</td>
          <td class="r"><b>${fmt.money(s.landed_cost)}</b></td><td class="r">${s.transit_days ? `${s.transit_days} d` : '—'}</td></tr>`)}</tbody></table></div>
      <p class="sub">The highlighted row is used for the landed cost. Change it in Costing.</p>
    </section>
  </section>`;

  // ── Review ────────────────────────────────────────────────
  const quick = (statusName, label, cls) => html`<form method="post" action="/admin/products/${p.id}/review"><input type="hidden" name="section" value="review"><input type="hidden" name="status" value="${statusName}"><button class="btn ${cls} small" ${p.status === statusName ? raw('disabled') : ''}>${label}</button></form>`;
  const review = html`<section class="pw-panel" role="tabpanel" id="tab-review" aria-labelledby="tabbtn-review" data-panel="review" hidden>
    <div class="rv-grid">
      <section class="card"><h2 class="sec">Your review</h2>
        <div class="quick"><span class="muted small">Quick actions</span>${quick('Shortlisted', 'Shortlist', '')}${quick('Rejected', 'Reject', 'ghost')}<a class="btn ghost small" href="/admin/suppliers/${p.supplier_id}/request">Request more information</a></div>
        <form method="post" action="/admin/products/${p.id}/review" class="fields" data-guard>
          <input type="hidden" name="section" value="review"><input type="hidden" name="stores_present" value="1">
          <label class="frow"><span>Status</span><select name="status">${F.STATUSES.map((s) => html`<option ${s === p.status ? raw('selected') : ''}>${s}</option>`)}</select></label>
          <label class="frow"><span>Score</span><select name="score"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}" ${p.score === n ? raw('selected') : ''}>${'★'.repeat(n)}</option>`)}</select></label>
          <div class="frow stores" role="group" aria-labelledby="lbl-stores"><span id="lbl-stores">Target stores</span><div class="store-picks">${F.STORES.map((s) => html`<label class="store-pick"><input type="checkbox" name="target_stores" value="${s}" ${(p.target_stores || []).includes(s) ? raw('checked') : ''}><span><i aria-hidden="true"></i>${s}</span></label>`)}</div></div>
          <label class="frow top"><span>Reviewer notes</span><textarea name="review_notes" rows="5">${p.review_notes || ''}</textarea></label>
          <div class="form-actions"><button class="btn" data-save>Save review</button>${dirty}</div>
        </form></section>
      <aside class="card"><h2 class="sec">Summary (read-only)</h2>
        <dl class="specs one">
          ${spec('Factory price', has(p.unit_price) ? fmt.money(p.unit_price, p.currency) : none)}
          ${spec('Landed estimate', html`${money(a.landed_cost)} ${dutyVerified ? status('ok', 'duty verified') : status('est', 'estimate')}`)}
          ${spec('Suggested wholesale', money(a.pricing.suggested_wholesale))}
          ${spec('Our wholesale', has(p.our_wholesale_usd) ? fmt.money(p.our_wholesale_usd) : none)}
          ${spec('Margin', a.margin_pct !== null ? html`<span class="${a.margin_pct < a.pricing.target_margin_pct ? 'neg' : 'pos'}">${fmt.pct(a.margin_pct)}</span> <span class="sub">target ${a.pricing.target_margin_pct}%</span>` : none)}
          ${spec('MOQ', has(p.moq) ? `${fmt.num(p.moq)} units` : none)}
          ${spec('Per 40HQ', fit['40HQ'] ? fmt.num(fit['40HQ'].units) : none)}
          ${spec('Certifications', val(p.certifications))}
        </dl>
        <p class="sub">Pricing is edited in the Costing tab and supplier data in Overview, so each figure has one place to change.</p></aside>
    </div>
    ${analyses.length ? html`<section class="card"><h2 class="sec">AI analyses</h2>
      ${analyses.map((an) => html`<details ${an === analyses[0] ? raw('open') : ''}><summary>${an.title || an.kind} · ${fmt.date(an.created_at)}</summary>${renderAnalysis(an, {})}</details>`)}</section>` : ''}
  </section>`;

  // ── Documents ─────────────────────────────────────────────
  const docRow = (d, { source = false } = {}) => html`<tr><td><span class="trunc" title="${d.name}">${d.name}</span></td><td>${source ? 'Imported source file' : DOC_KINDS[d.kind] || d.kind}</td><td>${extOf(d.name)}</td><td class="r">${fmt.bytes(d.bytes)}</td><td>${fmt.date(d.created_at)}</td>
    <td class="r nowrap">${PREVIEWABLE.test(d.name) ? html`<a href="/admin/documents/${d.id}?inline=1" data-preview="/admin/documents/${d.id}?inline=1" data-dl="/admin/documents/${d.id}" data-type="${/\.(png|jpe?g|webp|gif)$/i.test(d.name) ? 'image' : 'doc'}">Preview</a> · ` : ''}<a href="/admin/documents/${d.id}" download>Download</a>${!source && canDelete ? html` · <form class="inline" method="post" action="/admin/products/${p.id}/documents/${d.id}/delete" data-confirm="Delete this file?"><button class="link danger">Delete</button></form>` : ''}</td></tr>`;
  const docTable = (rows, opts) => html`<div class="table-wrap"><table class="list compact docs"><thead><tr><th>File</th><th>Category</th><th>Type</th><th class="r">Size</th><th>Added</th><th></th></tr></thead><tbody>${rows.map((d) => docRow(d, opts))}</tbody></table></div>`;
  const photoMax = Math.max(0, 20 - imgs.length);
  const documents = html`<section class="pw-panel" role="tabpanel" id="tab-documents" aria-labelledby="tabbtn-documents" data-panel="documents" hidden>
    <section class="card"><h2 class="sec">Supplier quotation (source)</h2>
      ${srcDoc ? docTable([srcDoc], { source: true }) : html`<p class="d-empty">This product was not imported from a file, so there is no source file. Files you upload below are kept with it.</p>`}
      ${srcDoc ? html`<p class="sub">Provenance: imported from this file on ${fmt.date(p.created_at)}.</p>` : ''}</section>
    <section class="card"><div class="sec-row"><h2 class="sec">Photos (${imgs.length})</h2>${imgs.length > 1 ? html`<span class="sub">The first photo is the main image.</span>` : ''}</div>
      ${imgs.length ? html`<div class="ph-grid">${imgs.map((im, i) => html`<figure class="ph"><a href="${urls[im.path]}" data-preview="${urls[im.path] || urls[im.thumb_path]}" data-type="image" data-gallery="product"><img src="${urls[im.thumb_path]}" alt="" loading="lazy"></a>
        ${i === 0 ? html`<span class="ph-main">Main</span>` : ''}
        <figcaption><span>${im.width && im.height ? `${im.width}×${im.height}` : ''}</span><span>${i > 0 ? html`<form class="inline" method="post" action="/admin/products/${p.id}/photos/${im.id}/primary"><button class="link">Make main</button></form> · ` : ''}<form class="inline" method="post" action="/admin/products/${p.id}/images/${im.id}/delete" data-confirm="Delete this photo?"><button class="link danger">Delete</button></form></span></figcaption></figure>`)}</div>` : html`<p class="d-empty">No photos yet.</p>`}
      ${photoMax > 0 ? html`<form method="post" enctype="multipart/form-data" action="/admin/products/${p.id}/photos">
        <label class="dropzone compact" data-dropzone data-max="${photoMax}"><input type="file" name="images" accept="image/*" multiple><span class="dz-icon" aria-hidden="true">⬆</span>
          <span class="dz-main">Drag &amp; drop photos here, or <u>choose files</u></span><span class="dz-hint">JPG, PNG or WebP · up to ${photoMax} more · 20 MB each · you can also paste (Ctrl/⌘+V)</span></label>
        <div class="dz-previews" data-previews></div><div class="form-actions"><button class="btn small">Upload photos</button></div></form>` : html`<p class="muted small">Maximum 20 photos reached.</p>`}
    </section>
    <section class="card"><h2 class="sec">Certificates, test reports &amp; other files</h2>
      ${docs.length ? docTable(docs) : html`<p class="d-empty">No certificates or other files yet.</p>`}
      ${docsReady ? html`<form method="post" enctype="multipart/form-data" action="/admin/products/${p.id}/documents" class="doc-upload">
        <label class="frow"><span>Category</span><select name="kind">${UPLOAD_KINDS.map((k) => html`<option value="${k}">${DOC_KINDS[k]}</option>`)}</select></label>
        ${fileDrop({ accept: '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip', main: raw('Drag &amp; drop a file here, or <u>choose a file</u>'), hint: 'PDF, image, Word, Excel, CSV, text or ZIP · max 20 MB' })}
        <div class="form-actions"><button class="btn small">Upload file</button></div></form>` : html`<p class="notice warn small">File uploads need one database update. Run the latest <code>supabase/schema.sql</code> (the "product documents" section) in Supabase, then reload.</p>`}
    </section>
  </section>`;

  return html`${header}${banners}<div class="pw-body" data-pw data-product="${p.id}">${overview}${costing}${logistics}${review}${documents}</div>`;
}

module.exports = { renderWorkspace, normSize, DOC_KINDS, UPLOAD_KINDS };
