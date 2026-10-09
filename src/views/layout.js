'use strict';
const { html, raw, fmt } = require('../lib/html');
const { PRODUCT_FIELDS, GROUPS, PACKING_ROWS } = require('../fields');

function page({ title, body, nav = null, flash = null, wide = false }) {
  return html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Lulyboo</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head><body>
<header class="top"><div class="top-in ${wide ? 'wide' : ''}">
  <a class="brand" href="${nav?.home || '/'}">Lulyboo <span>${nav?.label || 'Supplier Portal'}</span></a>
  ${nav ? html`<nav>${nav.items.map((i) => html`<a href="${i.href}" class="${i.active ? 'on' : ''}">${i.label}</a>`)}</nav>` : ''}
</div></header>
<main class="${wide ? 'wide' : ''}">
${flash ? html`<div class="flash ${flash.type}">${flash.msg}</div>` : ''}
${body}
</main>
</body></html>`;
}

function adminNav(active) {
  const items = [
    ['dashboard', '/admin', 'Dashboard'],
    ['products', '/admin/products', 'Products'],
    ['suppliers', '/admin/suppliers', 'Suppliers'],
    ['categories', '/admin/categories', 'Categories'],
    ['logistics', '/admin/logistics', 'Logistics'],
    ['pricing', '/admin/pricing', 'Pricing'],
    ['ai', '/admin/ai', 'AI'],
    ['settings', '/admin/settings', 'Settings'],
  ].map(([k, href, label]) => ({ href, label, active: k === active }));
  items.push({ href: '/admin/logout', label: 'Log out' });
  return { home: '/admin', label: 'Admin', items };
}

const bi = (f) => html`${f.en}<span class="cn">${f.cn}</span>`;

function input(f, value, { categories } = {}) {
  const v = value === null || value === undefined ? '' : value;
  const req = f.required ? raw(' required') : '';
  const id = `f_${f.key}`;
  switch (f.type) {
    case 'textarea': return html`<textarea id="${id}" name="${f.key}" rows="3"${req}>${v}</textarea>`;
    case 'number': return html`<input id="${id}" name="${f.key}" type="number" step="any" min="0" inputmode="decimal" value="${v}"${req}>`;
    case 'int': return html`<input id="${id}" name="${f.key}" type="number" step="1" min="0" inputmode="numeric" value="${v}"${req}>`;
    case 'date': return html`<input id="${id}" name="${f.key}" type="date" value="${v ? String(v).slice(0, 10) : ''}"${req}>`;
    case 'url': return html`<input id="${id}" name="${f.key}" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="www.example.com" value="${v}"${req}>`;
    case 'select': {
      const opts = f.key === 'category' && categories?.length ? categories : f.options;
      const list = v && !opts.includes(v) ? [...opts, v] : opts;
      return html`<select id="${id}" name="${f.key}"${req}>
        ${f.key === 'category' ? html`<option value="">—</option>` : ''}
        ${list.map((o) => html`<option ${o === (v || f.default) ? raw('selected') : ''}>${o}</option>`)}
      </select>`;
    }
    default: return html`<input id="${id}" name="${f.key}" type="text" value="${v}"${req}>`;
  }
}

/** The bilingual product form body (supplier fields only). */
const FIELD = Object.fromEntries(PRODUCT_FIELDS.map((f) => [f.key, f]));

function packingRows(product, opts) {
  return PACKING_ROWS.map((row) => html`
    <div class="field-row">
      <div class="row-title">${row.en}<span class="cn">${row.cn}</span></div>
      <div class="row-inputs cols-${row.keys.length}">
        ${row.keys.map((k, i) => { const f = FIELD[k]; return html`
          ${row.sep && i > 0 ? html`<span class="sep">${row.sep}</span>` : ''}
          <label>
            <span class="lbl">${f.short ? f.short[0] : f.en}<span class="cn">${f.short ? f.short[1] : f.cn}</span></span>
            ${input(f, product[f.key], opts)}
          </label>`; })}
      </div>
    </div>`);
}

function productFields(product = {}, { categories } = {}) {
  return GROUPS.map((g) => html`
    <fieldset class="group">
      <legend>${g.en}<span class="cn">${g.cn}</span></legend>
      ${g.id === 'packing' ? packingRows(product, { categories }) : html`<div class="grid">
        ${PRODUCT_FIELDS.filter((f) => f.group === g.id).map((f) => html`
          <label class="${f.type === 'textarea' ? 'span2' : ''}">
            <span class="lbl">${f.en}${f.required ? html`<b class="req">*</b>` : ''}<span class="cn">${f.cn}</span></span>
            ${input(f, product[f.key], { categories })}
            ${f.help ? html`<small>${f.help}</small>` : ''}
          </label>`)}
      </div>`}
      ${g.id === 'packing' ? html`<div class="calc-box" data-live-fit>
        <strong>Container fit (auto)</strong><span class="cn">装柜数量（自动计算）</span>
        <div class="live-fit">Enter carton size and units per carton to see how many fit.</div>
      </div>` : ''}
    </fieldset>`);
}

function imageGrid(images, urls, { deleteAction } = {}) {
  if (!images?.length) return html`<p class="muted">No photos yet.</p>`;
  return html`<div class="thumbs">${images.map((im) => html`
    <figure>
      <a href="${urls[im.path] || '#'}" target="_blank" rel="noopener"><img src="${urls[im.thumb_path] || ''}" alt="" loading="lazy"></a>
      ${deleteAction ? html`<form method="post" action="${deleteAction(im)}" data-confirm="Delete this photo?"><button class="link danger" type="submit">Delete</button></form>` : ''}
    </figure>`)}</div>`;
}

function pager({ total, page, perPage, baseQuery }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return '';
  const link = (p) => { const q = new URLSearchParams(baseQuery); q.set('page', p); return `?${q}`; };
  return html`<div class="pager">
    ${page > 1 ? html`<a href="${link(page - 1)}">← Prev</a>` : ''}
    <span>Page ${page} of ${pages} · ${fmt.num(total)} items</span>
    ${page < pages ? html`<a href="${link(page + 1)}">Next →</a>` : ''}
  </div>`;
}

const statusPill = (s) => html`<span class="pill s-${String(s || '').toLowerCase().replace(/\s+/g, '-')}">${s}</span>`;

function errorPage(status, message) {
  return page({ title: `Error ${status}`, body: html`<section class="card narrow"><h1>${status === 404 ? 'Not found' : 'Something went wrong'}</h1><p>${message}</p></section>` });
}

module.exports = { page, adminNav, productFields, imageGrid, pager, statusPill, errorPage, bi, input };
