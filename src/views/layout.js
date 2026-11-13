'use strict';
const { html, raw, fmt, t, biText, confirmAttr } = require('../lib/html');
const { PRODUCT_FIELDS, GROUPS, PACKING_ROWS } = require('../fields');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { icon } = require('./icons');
const STAFF = require('../staff');

// Version stamp for CSS/JS: changes whenever those files change, so browsers fetch the new version after a deploy.
const ASSET_V = crypto.createHash('sha1')
  .update(['style.css', 'app.js'].map((f) => { try { return fs.readFileSync(path.join(__dirname, '..', '..', 'public', f)); } catch { return ''; } }).join('|'))
  .digest('hex').slice(0, 10);

// Language comes from the lb_lang cookie (set by the header switch); English by default.
const langOf = (req) => (req && /(?:^|;\s*)lb_lang=zh/.test(req.headers?.cookie || '') ? 'zh' : 'en');

function page({ title, body, nav = null, flash = null, wide = false, req = null, admin = false, lang = true }) {
  const isAdmin = admin || !!nav?.admin;
  const zh = !isAdmin && langOf(req) === 'zh';
  const showSwitch = !isAdmin && lang;
  const sw = showSwitch ? html`<div class="lang-switch" role="group" aria-label="Language / 语言">
    <button type="button" data-lang="en" aria-pressed="${zh ? 'false' : 'true'}">EN</button><button type="button" data-lang="zh" aria-pressed="${zh ? 'true' : 'false'}">中文</button>
  </div>` : '';
  const head = html`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/static/favicon.svg?v=${ASSET_V}" type="image/svg+xml"><link rel="icon" href="/static/favicon-32.png?v=${ASSET_V}" type="image/png" sizes="32x32"><link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png?v=${ASSET_V}">
<title>${title} · Lulyboo</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap">
<link rel="stylesheet" href="/static/style.css?v=${ASSET_V}">
<script src="/static/app.js?v=${ASSET_V}" defer></script>`;
  const flashHtml = flash ? html`<div class="flash ${flash.type}">${biText(flash.msg)}</div>` : '';

  // Supplier portal: sidebar + topbar shell
  if (nav && !isAdmin && req?.supplier) {
    const main = nav.items.filter((i) => !i.out);
    const out = nav.items.find((i) => i.out);
    const co = req.supplier.name || 'Lulyboo';
    const initial = String(co).trim().charAt(0).toUpperCase() || 'L';
    const who = req.user?.name || req.user?.email || '';
    return html`<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}" class="${zh ? 'zh' : ''}"><head>${head}</head><body class="has-shell">
<div class="portal-layout">
  <aside class="portal-sidebar">
    <a class="sb-brand" href="${nav.home}"><span class="sb-logo">L</span><span><b>Lulyboo</b><small>${t('SUPPLIER PORTAL', '供应商平台')}</small></span></a>
    <div class="sb-workspace"><span class="sb-avatar">${initial}</span><span class="sb-co"><b>${co}</b><small>${t('Company account', '公司账号')}</small></span></div>
    <nav class="sb-nav">
      ${main.map((i) => { const n = req.navBadges?.[i.href] || 0; return html`<a href="${i.href}" class="${i.active ? 'on' : ''}">${i.icon ? icon(i.icon, 17) : ''}<span>${i.label}</span>${n ? html`<span class="nav-badge" title="${n} new">${n > 99 ? '99+' : n}</span>` : ''}</a>`; })}
    </nav>
    <div class="sb-foot">
      <div class="sb-user"><span class="sb-avatar sm">${String(who).charAt(0).toUpperCase() || 'U'}</span><span class="sb-co"><b>${req.user?.name || '—'}</b><small>${req.user?.email || ''}</small></span></div>
      ${out ? html`<a class="sb-out" href="${out.href}">${icon('logout', 16)}<span>${out.label}</span></a>` : ''}
    </div>
  </aside>
  <div class="portal-main">
    <header class="topbar">
      <div class="crumbs"><span>${co}</span>${icon('chevronRight', 14)}<b>${nav.items.find((i) => i.active)?.label || title}</b></div>
      ${sw}
    </header>
    <main class="page-content">
      ${flashHtml}
      ${body}
    </main>
  </div>
</div></body></html>`;
  }

  return html`<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}" class="${zh ? 'zh' : ''}"><head>${head}</head><body>
<header class="top"><div class="top-in ${wide ? 'wide' : ''}">
  <a class="brand" href="${nav?.home || '/'}"><span class="sb-logo">L</span> Lulyboo ${nav?.admin ? '' : html`<span>${nav?.label || t('Supplier Portal', '供应商平台')}</span>`}</a>
  ${nav?.groups ? adminMainNav(nav) : nav ? html`<nav>${nav.items.map((i) => html`<a href="${i.href}" class="${i.active ? 'on' : ''}">${i.label}</a>`)}</nav>` : ''}
  ${sw}
  ${isAdmin ? html`<div class="top-right">${nav?.groups ? html`<button type="button" class="qk-btn" data-qk-open aria-label="Quick jump (⌘K)">${icon('search', 15)}<span>Jump to…</span><kbd data-qk-key>⌘K</kbd></button>` : ''}${nav?.settings ? html`<a class="settings-link ${nav.settings.active ? 'on' : ''}" href="${nav.settings.href}" title="Settings">${icon('settings', 16)}<span>Settings</span></a>` : ''}${userMenu()}</div>` : ''}
</div>${isAdmin && nav?.groups ? subNav(nav, wide) : ''}</header>
${isAdmin && nav?.groups ? quickJump(nav) : ''}
<main class="${wide ? 'wide' : ''}">
${flashHtml}
${body}
</main>
</body></html>`;
}

/** Top-right account menu on every admin page: who is signed in, profile, users, audit log, sign out. */
function userMenu() {
  const u = STAFF.current();
  if (!u) return '';
  const initials = String(u.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return html`<details class="user-menu"><summary aria-label="Account menu"><span class="um-av">${initials}</span><span class="um-who"><b>${u.name}</b><small>${STAFF.ROLES[u.role]}</small></span><span class="um-caret" aria-hidden="true"></span></summary>
    <div class="um-pop"><div class="um-head"><b>${u.name}</b><small>${u.email || 'Owner login'}</small></div>
      <a href="/admin/profile">My profile</a>
      ${STAFF.can(u.role, 'users') ? html`<a href="/admin/users">Users &amp; roles</a>` : ''}
      ${STAFF.can(u.role, 'audit') ? html`<a href="/admin/audit">Audit log</a>` : ''}
      <a class="um-out" href="/admin/logout">Sign out</a></div></details>`;
}

/** Grouped main navigation: menus open on hover (desktop) or tap; the group name itself goes to the area's main page. */
function adminMainNav(nav) {
  return html`<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="mainnav">${icon('list', 16)}<span>Menu</span></button>
  <nav class="mainnav" id="mainnav" aria-label="Main">${nav.groups.map((g) => !g.items
    ? html`<a class="nav-link ${g.active ? 'on' : ''}" href="${g.href}" ${g.active ? raw('aria-current="page"') : ''}>${g.label}</a>`
    : html`<div class="nav-group ${g.active ? 'on' : ''}"><a href="${g.href}" class="nav-btn" aria-expanded="false" aria-haspopup="true">${g.label}<span class="um-caret" aria-hidden="true"></span></a>
      <div class="nav-menu">${g.items.map((i) => html`<a href="${i.href}" class="${i.active ? 'on' : ''}" ${i.active ? raw('aria-current="page"') : ''}><span>${i.label}</span>${i.desc ? html`<small>${i.desc}</small>` : ''}</a>`)}</div></div>`)}</nav>`;
}

/** Tabs for every page of the area you are in (one click between e.g. Container planning and Load containers). */
function subNav(nav, wide) {
  const g = nav?.groups?.find((x) => x.active && x.items);
  if (!g) return '';
  return html`<nav class="subnav" aria-label="${g.label}"><div class="subnav-in ${wide ? 'wide' : ''}"><span class="subnav-lbl">${g.label}</span>${g.items.map((i) => html`<a href="${i.href}" class="${i.active ? 'on' : ''}" ${i.active ? raw('aria-current="page"') : ''}>${i.label}</a>`)}</div></nav>`;
}

/** ⌘K quick jump: pages (listed here) + records (fetched from /admin/quick). */
function quickJump(nav) {
  const pages = nav.groups.flatMap((g) => (g.items ? g.items.map((i) => ({ t: i.label, g: g.label, d: i.desc || '', h: i.href })) : [{ t: g.label, g: '', d: '', h: g.href }]));
  if (nav.settings) pages.push({ t: 'Settings', g: '', d: 'Portal settings', h: nav.settings.href });
  return html`<div class="qk-ov" data-qk-ov hidden><div class="qk" role="dialog" aria-modal="true" aria-label="Quick jump">
    <input type="search" class="qk-q" data-qk-q placeholder="Jump to a page, supplier, PO, project, sample…" autocomplete="off" aria-label="Search">
    <ul class="qk-res" data-qk-res role="listbox"></ul>
    <div class="qk-ft"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </div><script type="application/json" data-qk-pages>${raw(JSON.stringify(pages).replace(/</g, '\\u003c'))}</script></div>`;
}

function adminNav(active) {
  const staff = STAFF.current();
  const on = (k) => k === active;
  const group = (label, items) => {
    const list = items.map(([k, href, l, d]) => ({ href, label: l, desc: d, active: on(k) }));
    const act = items.some(([k]) => on(k));
    return list.length === 1 ? { label, href: list[0].href, active: act } : { label, href: list[0].href, items: list, active: act };
  };
  const groups = [
    { label: 'Dashboard', href: '/admin', active: on('dashboard') },
    group('Sourcing', [['suppliers', '/admin/suppliers', 'Suppliers', 'Factories, contacts, CRM status'], ['requests', '/admin/requests', 'RFQs & requests', 'Info requests to suppliers'], ['projects', '/admin/projects', 'Development', 'New product projects'], ['samples', '/admin/samples', 'Samples', 'Sample requests & tracking']]),
    group('Catalog', [['products', '/admin/products', 'Products', 'Supplier products'], ['pricing', '/admin/pricing', 'Pricing', 'Landed cost & margins'], ['categories', '/admin/categories', 'Categories', 'Category list'], ['archive', '/admin/archive', 'Archive', 'Archived products']]),
    group('Orders', [['orders', '/admin/orders', 'Purchase orders', 'All POs'], ['planning', '/admin/logistics/planning', 'Container planning', 'Group POs by ready date'], ['load', '/admin/logistics/planning/load', 'Load containers', 'Fill 20GP / 40GP / 40HQ / LCL'], ['shipping', '/admin/orders/shipping', 'Shipping documents', 'Loading confirmations & docs'], ['orders-import', '/admin/logistics/planning/import', 'Import orders', 'PO / PL with AI']]),
    group('Operations', [['logistics', '/admin/logistics', 'Logistics', 'Shipments & forwarders'], ['crm', '/admin/crm', 'Follow-ups', 'CRM tasks'], ['calendar', '/admin/crm/calendar', 'Calendar', 'Activities & supplier holidays']]),
    group('AI Tools', [['ai', '/admin/ai', 'AI Assistant', 'Ask about your data']]),
  ];
  const showSettings = !staff || STAFF.can(staff.role, 'settings');
  return { home: '/admin', label: 'Admin', groups, settings: showSettings ? { href: '/admin/settings', active: on('settings') } : null, items: groups.flatMap((g) => g.items || [g]), admin: true };
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

/** One number box sized for its value, with a small label in front and the unit inside. */
function unitInput(key, product, opts, { pre = null, unit = '' } = {}) {
  const f = FIELD[key];
  return html`<label class="pcx-u" title="${`${f.en} · ${f.cn}`}">${pre ? html`<small>${pre}</small>` : ''}${input(f, product[f.key], opts)}${unit ? html`<span>${unit}</span>` : ''}</label>`;
}

/** Packing & Carton: compact rows on the left, calculated container fit (with optional overrides) on the right. */
function packingRows(product, opts) {
  const row = (title, hint, body) => html`<div class="pcx-row"><div class="pcx-lbl">${title}${hint ? html`<small>${hint}</small>` : ''}</div><div class="pcx-fields">${body}</div></div>`;
  return html`<div class="pcx">
    <div class="pcx-main">
      ${row(t('Pieces', '装箱数量'), t('inner pack · master carton', '内盒 · 外箱'), html`
        ${unitInput('units_per_inner', product, opts, { pre: t('Inner', '内盒'), unit: t('pcs', '件') })}
        ${unitInput('units_per_carton', product, opts, { pre: t('Carton', '外箱'), unit: t('pcs', '件') })}`)}
      ${row(t('Master carton size', '外箱尺寸'), t('outside L × W × H', '外径 长×宽×高'), html`
        ${unitInput('carton_l_cm', product, opts, { unit: 'L' })}<span class="pcx-x">×</span>
        ${unitInput('carton_w_cm', product, opts, { unit: 'W' })}<span class="pcx-x">×</span>
        ${unitInput('carton_h_cm', product, opts, { unit: 'H' })}<span class="pcx-chip">cm</span><span class="pcx-chip" data-fit-cbm>— m³</span>`)}
      ${row(t('Master carton weight', '外箱重量'), '', html`
        ${unitInput('carton_nw_kg', product, opts, { pre: t('Net', '净重'), unit: 'kg' })}
        ${unitInput('carton_gw_kg', product, opts, { pre: t('Gross', '毛重'), unit: 'kg' })}`)}
    </div>
    <aside class="pcx-fit" data-live-fit>
      <div class="pcx-fit-h"><strong>${t('Container fit', '装柜数量')}</strong><span>${t('calculated', '自动计算')}</span></div>
      <div class="pcx-fit-top"><span class="pcx-box" aria-hidden="true"></span><div><b data-fit-cbm-big>—</b><small data-fit-per>${t('Enter the carton size to see how many fit.', '请输入外箱尺寸，系统将计算装柜数量。')}</small></div></div>
      <table class="pcx-fit-t"><thead><tr><th></th><th>${t('Cartons', '箱数')}</th><th>${t('Units', '件数')}</th><th>${t('Override', '指定')}</th></tr></thead><tbody>
        ${[['20GP', 'supplier_qty_20gp'], ['40GP', 'supplier_qty_40gp'], ['40HQ', 'supplier_qty_40hq']].map(([b, k]) => html`<tr data-fit-row="${b}"><td><b>${b}</b></td><td data-fit-c>—</td><td data-fit-u>—</td><td>${(() => { const f = FIELD[k]; const v = product[k] ?? ''; return html`<input id="f_${k}" name="${k}" type="number" step="1" min="0" inputmode="numeric" value="${v}" placeholder="auto" class="pcx-ov" aria-label="${f.en}">`; })()}</td></tr>`)}
      </tbody></table>
      <p class="pcx-note">${t('By carton size and weight · ⚖ limited by weight. Override only if your loading plan differs.', '按外箱尺寸和重量计算 · ⚖ 受重量限制。实际装柜数量不同时再填写“指定”。')}</p>
    </aside>
  </div>`;
}

function productFields(product = {}, { categories, slot } = {}) {
  return GROUPS.map((g) => groupFields(product, g.id, { categories, slot: g.id === 'product' ? slot : null }));
}

/** One field group (product / pricing / packing / other) as a fieldset. */
/** `slot`: extra cell placed after Subcategory (admin product page: Fill with AI). */
function groupFields(product = {}, groupId, { categories, slot = null } = {}) {
  return [GROUPS.find((x) => x.id === groupId)].map((g) => html`
    <fieldset class="group" data-group="${g.id}">
      <legend>${t(g.en, g.cn)}</legend>
      ${g.id === 'packing' ? packingRows(product, { categories }) : html`<div class="grid">
        ${PRODUCT_FIELDS.filter((f) => f.group === g.id).map((f) => html`
          <label class="${f.type === 'textarea' ? 'span2' : ''}">
            <span class="lbl">${t(f.en, f.cn)}${f.required ? html`<b class="req">*</b>` : ''}</span>
            ${input(f, product[f.key], { categories })}
            ${f.help ? html`<small>${t(f.help[0], f.help[1])}</small>` : ''}
          </label>${slot && f.key === 'subcategory' ? slot : ''}`)}
      </div>`}
    </fieldset>`);
}

// Delete buttons use formaction, so the grid can sit inside another form (nested forms are invalid HTML).
function imageGrid(images, urls, { deleteAction } = {}) {
  if (!images?.length) return '';
  return html`<div class="thumbs">${images.map((im) => html`
    <figure>
      <a href="${urls[im.path] || '#'}" data-preview="${urls[im.path] || urls[im.thumb_path] || ''}" data-type="image" data-gallery="photos"><img src="${urls[im.thumb_path] || ''}" alt="" loading="lazy"></a>
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

// Single-file upload box: drag & drop, click to choose, or paste (a copied file, or spreadsheet cells as CSV).
// Works without JS too (it is still a normal file input). app.js enhances [data-filedrop].
function fileDrop({ name = 'file', accept = '.xlsx,.csv', main, hint, required = true }) {
  return html`<label class="dropzone compact" data-filedrop>
    <input type="file" name="${name}" accept="${accept}" ${required ? raw('required') : ''}>
    <span class="dz-icon" aria-hidden="true">⬆</span>
    <span class="dz-main">${main}</span>
    <span class="dz-hint">${hint}</span>
    <span class="dz-file" data-file hidden></span>
  </label>`;
}

// Small single-file drop box for the business license (photo or PDF). Enhanced by app.js [data-filebox] (drag, drop, paste).
function licenseDrop({ has = false } = {}) {
  return html`<div class="mdrop small" data-filebox data-max="1">
  <div class="mdrop-box"><input type="file" name="license_file" accept=".jpg,.jpeg,.png,.webp,.pdf" aria-label="Business license file">
    <span class="dz-main" data-main>${has ? t('Replace: drop a new photo or PDF, or choose', '更换：拖入新的照片或 PDF，或点击选择') : t('Drop a photo or PDF of the license, or choose', '拖入营业执照照片或 PDF，或点击选择')}</span>
    <span class="dz-hint">JPG, PNG, PDF · ${t('up to 10 MB', '最大 10 MB')}</span></div>
  <ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>`;
}

function errorPage(status, message, req = null) {
  const head = status === 404 ? t('Not found', '页面不存在') : t('Something went wrong', '出现错误');
  return page({ title: `Error ${status}`, req, body: html`<section class="card narrow"><h1>${head}</h1><p>${biText(message)}</p></section>` });
}

module.exports = { licenseDrop, page, adminNav, productFields, groupFields, imageGrid, photoSection, pager, statusPill, fileDrop, errorPage, bi, input };
