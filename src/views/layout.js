'use strict';
const { html, raw, fmt, t, biText, confirmAttr } = require('../lib/html');
const { PRODUCT_FIELDS, GROUPS, PACKING_ROWS } = require('../fields');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Version stamp for CSS/JS: changes whenever those files change, so browsers fetch the new version after a deploy.
const ASSET_V = crypto.createHash('sha1')
  .update(['style.css', 'app.js'].map((f) => { try { return fs.readFileSync(path.join(__dirname, '..', '..', 'public', f)); } catch { return ''; } }).join('|'))
  .digest('hex').slice(0, 10);

// Language comes from the lb_lang cookie (set by the header switch); English by default.
const langOf = (req) => (req && /(?:^|;\s*)lb_lang=zh/.test(req.headers?.cookie || '') ? 'zh' : 'en');

function page({ title, body, nav = null, flash = null, wide = false, req = null, admin = false }) {
  const isAdmin = admin || !!nav?.admin;
  const zh = !isAdmin && langOf(req) === 'zh';
  const showSwitch = !isAdmin;
  return html`<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}" class="${zh ? 'zh' : ''}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Lulyboo</title>
<link rel="stylesheet" href="/static/style.css?v=${ASSET_V}">
<script src="/static/app.js?v=${ASSET_V}" defer></script>
</head><body>
<header class="top"><div class="top-in ${wide ? 'wide' : ''}">
  <a class="brand" href="${nav?.home || '/'}">Lulyboo <span>${nav?.label || t('Supplier Portal', '供应商平台')}</span></a>
  ${nav ? html`<nav>${nav.items.map((i) => html`<a href="${i.href}" class="${i.active ? 'on' : ''}">${i.label}</a>`)}</nav>` : ''}
  ${showSwitch ? html`<div class="lang-switch" role="group" aria-label="Language / 语言">
    <button type="button" data-lang="en" aria-pressed="${zh ? 'false' : 'true'}">EN</button><button type="button" data-lang="zh" aria-pressed="${zh ? 'true' : 'false'}">中文</button>
  </div>` : ''}
</div></header>
<main class="${wide ? 'wide' : ''}">
${flash ? html`<div class="flash ${flash.type}">${biText(flash.msg)}</div>` : ''}
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
  return { home: '/admin', label: 'Admin', items, admin: true };
}

const bi = (f) => t(f.en, f.cn);

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
      <div class="row-title">${t(row.en, row.cn)}</div>
      <div class="row-inputs cols-${row.keys.length}">
        ${row.keys.map((k, i) => { const f = FIELD[k]; return html`
          ${row.sep && i > 0 ? html`<span class="sep">${row.sep}</span>` : ''}
          <label>
            <span class="lbl">${f.short ? t(f.short[0], f.short[1]) : t(f.en, f.cn)}</span>
            ${input(f, product[f.key], opts)}
          </label>`; })}
      </div>
    </div>`);
}

function productFields(product = {}, { categories } = {}) {
  return GROUPS.map((g) => html`
    <fieldset class="group">
      <legend>${t(g.en, g.cn)}</legend>
      ${g.id === 'packing' ? packingRows(product, { categories }) : html`<div class="grid">
        ${PRODUCT_FIELDS.filter((f) => f.group === g.id).map((f) => html`
          <label class="${f.type === 'textarea' ? 'span2' : ''}">
            <span class="lbl">${t(f.en, f.cn)}${f.required ? html`<b class="req">*</b>` : ''}</span>
            ${input(f, product[f.key], { categories })}
            ${f.help ? html`<small>${t(f.help[0], f.help[1])}</small>` : ''}
          </label>`)}
      </div>`}
      ${g.id === 'packing' ? html`<div class="calc-box" data-live-fit>
        <strong>${t('Container fit (calculated)', '装柜数量（自动计算）')}</strong>
        <div class="live-fit"></div>
      </div>` : ''}
    </fieldset>`);
}

// Delete buttons use formaction, so the grid can sit inside another form (nested forms are invalid HTML).
function imageGrid(images, urls, { deleteAction } = {}) {
  if (!images?.length) return '';
  return html`<div class="thumbs">${images.map((im) => html`
    <figure>
      <a href="${urls[im.path] || '#'}" target="_blank" rel="noopener"><img src="${urls[im.thumb_path] || ''}" alt="" loading="lazy"></a>
      ${deleteAction ? html`<button class="link danger" type="submit" formaction="${deleteAction(im)}" formmethod="post" formenctype="application/x-www-form-urlencoded" formnovalidate${confirmAttr('Delete this photo?', '确定删除该图片？')}>${t('Delete', '删除')}</button>` : ''}
    </figure>`)}</div>`;
}

/** Photos block: drag & drop / choose / paste first, link as the fallback. Must sit inside a multipart form. */
function photoSection({ images = [], urls = {}, deleteAction = null, product = {}, maxImages = 10, disabled = false }) {
  const linkField = PRODUCT_FIELDS.find((f) => f.key === 'photo_link');
  const left = Math.max(0, maxImages - images.length);
  return html`<fieldset class="group photos" ${disabled ? raw('disabled') : ''}>
    <legend>${t('Photos', '产品图片')}</legend>
    ${imageGrid(images, urls, { deleteAction: disabled ? null : deleteAction })}
    ${left > 0 ? html`
    <label class="dropzone" data-dropzone data-max="${left}">
      <input type="file" name="images" accept="image/*" multiple>
      <span class="dz-icon" aria-hidden="true">⬆</span>
      <span class="dz-main">${t(raw('Drag &amp; drop photos here, or <u>choose files</u>'), raw('将图片拖到此处，或<u>点击选择文件</u>'))}</span>
      <span class="dz-hint">${t(`JPG, PNG or WebP · up to ${left} more · max 20 MB each · you can also paste (Ctrl/⌘+V)`, `JPG、PNG 或 WebP · 最多再上传 ${left} 张 · 每张不超过 20 MB · 也可直接粘贴（Ctrl/⌘+V）`)}</span>
    </label>
    <div class="dz-previews" data-previews></div>` : html`<p class="muted">${t(`Maximum ${maxImages} photos reached. Delete one to add another.`, `已达 ${maxImages} 张图片上限，请删除后再添加。`)}</p>`}
    <div class="photo-link">
      <span class="lbl">${t('No photos to upload? Add a link instead', '没有图片可上传？请填写图片或产品目录链接')}</span>
      ${input(linkField, product.photo_link)}
      <small>${t('Google Drive, Dropbox, Alibaba product page, WeTransfer…', '百度网盘、阿里巴巴产品页、微云、Google Drive 等')}</small>
    </div>
  </fieldset>`;
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

function errorPage(status, message, req = null) {
  const head = status === 404 ? t('Not found', '页面不存在') : t('Something went wrong', '出现错误');
  return page({ title: `Error ${status}`, req, body: html`<section class="card narrow"><h1>${head}</h1><p>${biText(message)}</p></section>` });
}

module.exports = { page, adminNav, productFields, imageGrid, photoSection, pager, statusPill, errorPage, bi, input };
