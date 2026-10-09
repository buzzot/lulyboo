'use strict';
const { html } = require('../lib/html');

// names: { productId: { name, supplier } } to label product ids in results
function renderAnalysis(an, names = {}) {
  const r = an.result || {};
  const label = (id) => {
    const n = names[id] || (r._names || {})[id];
    return n ? html`<a href="/admin/products/${id}">${n.name}</a> <span class="sub">${n.supplier || ''}</span>` : html`<a href="/admin/products/${id}">product</a>`;
  };
  const list = (xs) => (xs?.length ? html`<ul>${xs.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p class="muted">None.</p>`);
  const foot = html`<p class="sub">${an.model || ''}${an.input_tokens ? ` · ${an.input_tokens + (an.output_tokens || 0)} tokens` : ''} · AI output: verify facts, HS codes and duty rates before acting.</p>`;

  switch (an.kind) {
    case 'product_review':
      return html`<div class="ai">
        <p><span class="pill verdict-${String(r.verdict || '').toLowerCase()}">${r.verdict}</span> ${r.summary}</p>
        ${r.data_issues?.length ? html`<h4>Data issues</h4><ul>${r.data_issues.map((d) => html`<li><span class="sev ${d.severity}">${d.severity}</span> ${d.field ? html`<b>${d.field}:</b> ` : ''}${d.issue}</li>`)}</ul>` : ''}
        ${r.hs_duty ? html`<h4>HS code & duty</h4><p>${r.hs_duty.suggested_hs_code ? html`<b>${r.hs_duty.suggested_hs_code}</b> · ` : ''}${r.hs_duty.note}</p>` : ''}
        ${r.pricing ? html`<h4>Pricing</h4><p>${r.pricing.wholesale_low_usd ? html`Wholesale <b>$${r.pricing.wholesale_low_usd}–$${r.pricing.wholesale_high_usd}</b>` : ''}${r.pricing.retail_usd ? html` · retail ~<b>$${r.pricing.retail_usd}</b>` : ''}</p><p>${r.pricing.rationale}</p>` : ''}
        <h4>Risks</h4>${list(r.risks)}
        <h4>Questions for the factory</h4>${list(r.questions_for_factory)}
        ${foot}</div>`;
    case 'similar':
      return html`<div class="ai"><p>${r.summary}</p>
        ${r.matches?.length ? html`<table class="list compact"><thead><tr><th>Product</th><th>Match</th><th>Why</th><th>Differences</th><th>Price</th></tr></thead><tbody>
          ${r.matches.map((m) => html`<tr><td>${label(m.product_id)}</td><td>${m.match_type}</td><td>${m.reason}</td><td>${list(m.key_differences)}</td><td>${m.price_note}</td></tr>`)}</tbody></table>` : html`<p class="muted">No comparable products from other suppliers yet.</p>`}
        ${r.matches?.length ? html`<p><a class="btn small ghost" href="/admin/compare?ids=${[...an.product_ids.slice(0, 1), ...r.matches.map((m) => m.product_id)].slice(0, 8).join(',')}">Open side-by-side</a></p>` : ''}
        <p><b>Recommendation:</b> ${r.recommendation}</p>${foot}</div>`;
    case 'compare':
      return html`<div class="ai"><p>${r.summary}</p>
        ${r.best_value_product_id ? html`<p><b>Best value:</b> ${label(r.best_value_product_id)}</p>` : ''}
        <div class="cmp-grid">${(r.per_product || []).map((pp) => html`<div class="cmp"><h4>${label(pp.product_id)}</h4><b class="pos">Strengths</b>${list(pp.strengths)}<b class="neg">Weaknesses</b>${list(pp.weaknesses)}</div>`)}</div>
        <h4>Why prices differ</h4>${list(r.price_differences)}
        <h4>Negotiation points</h4>${list(r.negotiation_points)}
        <p><b>Recommendation:</b> ${r.recommendation}</p>${foot}</div>`;
    case 'category_match':
      return html`<div class="ai"><p>${r.summary}</p>
        ${(r.groups || []).map((g) => html`<div class="group-card"><h4>${g.label} <span class="pill">${g.match_type}</span></h4>
          <ul>${g.product_ids.map((id) => html`<li>${label(id)}${id === g.best_value_product_id ? html` <span class="pill s-selected">best value</span>` : ''}</li>`)}</ul>
          <p>${g.price_spread_note}</p>
          <a class="btn small ghost" href="/admin/compare?ids=${g.product_ids.slice(0, 8).join(',')}">Compare side-by-side</a></div>`)}
        ${foot}</div>`;
    default:
      return html`<pre>${JSON.stringify(r, null, 2)}</pre>`;
  }
}

module.exports = { renderAnalysis };
