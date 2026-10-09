'use strict';
// Supplier-facing pages under /portal. Requires a signed-in supplier user (see supplier-auth.js).
const { html, raw, fmt, t, m, biText, confirmAttr } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, productFields, photoSection } = require('../views/layout');
const { SUPPLIER_COLUMNS, SUPPLIER_FIELDS, cleanProduct, cleanSupplier } = require('../fields');
const { getCtx, imagesFor } = require('../services');
const { currentSupplierUser, passwordProblem, verifyPassword, hashPassword, startSession, MIN_PASSWORD } = require('../auth');
const { saveProductImages, deleteImages } = require('../images');
const { parseUpload } = require('../importer');

const LOCKED = ['Selected', 'Rejected'];
const MAX_IMAGES = 10;

function nav(active) {
  const b = '/portal';
  return {
    home: b, label: t('Supplier Portal', '供应商平台'), lang: true,
    items: [
      { href: b, label: t('My products', '我的产品'), active: active === 'home' },
      { href: `${b}/products/new`, label: t('Add product', '新增产品'), active: active === 'new' },
      { href: `${b}/import`, label: t('Bulk upload', '批量上传'), active: active === 'import' },
      { href: `${b}/profile`, label: t('Company', '公司信息'), active: active === 'profile' },
      { href: `${b}/account`, label: t('Account', '账号'), active: active === 'account' },
      { href: '/logout', label: t('Sign out', '退出') },
    ],
  };
}
const photosMsg = (n, plus) => (n ? ` (${plus ? '+' : ''}${n} ${n > 1 ? 'photos' : 'photo'})` : '');
const savedMsg = (r, plus) => m(`Saved${photosMsg(r.saved, plus)}`, `已保存${r.saved ? `（${plus ? '新增' : ''}${r.saved} 张图片）` : ''}`) + (r.errors.length ? ' · ' + r.errors.join(' · ') : '');

module.exports = function supplierRoutes(router, { db, config }) {
  // Each handler is wrapped: no valid session → redirect to sign-in.
  const A = (fn) => async (req, res) => {
    const cur = await currentSupplierUser(db, config, req);
    if (!cur) return res.redirect(`/login`);
    req.supplier = cur.supplier;
    req.user = cur.user;
    req.base = '/portal';
    return fn(req, res);
  };
  const NOT_FOUND = m('Product not found', '未找到该产品');
  const LOCKED_MSG = m('This quotation is locked. Contact Lulyboo to change it.', '该报价已锁定，如需修改请联系 Lulyboo。');
  async function ownProduct(req) {
    const p = await db.get('products', req.params.id);
    if (!p || p.supplier_id !== req.supplier.id) throw new HttpError(404, NOT_FOUND);
    return p;
  }
  const strip = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => SUPPLIER_COLUMNS.includes(k)));

  // ── Dashboard
  router.get('/portal', A(async (req, res) => {
    const products = await db.list('products', { filters: { supplier_id: req.supplier.id }, order: 'created_at.desc', select: 'id,product_name,supplier_sku,category,unit_price,currency,moq,created_at,updated_at,status' });
    const imgs = await imagesFor(db, products.map((p) => p.id));
    const urls = await db.storage.signedUrls(products.map((p) => imgs[p.id]?.[0]?.thumb_path));
    res.html(page({
      title: 'My products', nav: nav('home'), flash: takeFlash(req, res), req,
      body: html`
      <section class="head-row">
        <div><h1>${req.supplier.name}</h1><p class="muted">${t('Submit your products and prices to Lulyboo.', '向 Lulyboo 提交您的产品和报价。')}</p></div>
        <div class="actions"><a class="btn" href="${req.base}/products/new">+ ${t('Add product', '新增产品')}</a><a class="btn ghost" href="${req.base}/import">${t('Bulk upload', '批量上传')}</a></div>
      </section>
      ${products.length ? html`<div class="table-wrap"><table class="list">
        <thead><tr><th></th><th>${t('Product', '产品')}</th><th>SKU</th><th>${t('Category', '类别')}</th><th class="r">${t('Price', '单价')}</th><th class="r">MOQ</th><th>${t('Updated', '更新')}</th></tr></thead>
        <tbody>${products.map((p) => html`<tr>
          <td class="thumb-cell">${imgs[p.id]?.[0] ? html`<img src="${urls[imgs[p.id][0].thumb_path] || ''}" alt="">` : html`<span class="noimg">${t('No photo', '无图')}</span>`}</td>
          <td><a href="${req.base}/products/${p.id}">${p.product_name}</a></td>
          <td>${p.supplier_sku || '—'}</td><td>${p.category || '—'}</td>
          <td class="r">${fmt.money(p.unit_price, p.currency)}</td><td class="r">${fmt.num(p.moq)}</td>
          <td>${fmt.date(p.updated_at)}</td></tr>`)}</tbody></table></div>`
        : html`<section class="card empty"><h2>${t('No products yet', '暂无产品')}</h2>
          <p>${t('Add products one at a time with photos, or upload our Excel template with many products at once.', '可逐个添加产品（含图片），或使用 Excel 模板批量上传。')}</p>
          <p><a class="btn" href="${req.base}/products/new">${t('Add product', '新增产品')}</a> <a class="btn ghost" href="/static/Lulyboo_Supplier_Product_Template.xlsx">${t('Download template', '下载模板')}</a></p></section>`}`,
    }));
  }));

  // ── Product form
  function form(req, product, images = [], urls = {}, ctx) {
    const isNew = !product.id;
    const locked = !isNew && LOCKED.includes(product.status);
    return html`
      <h1>${isNew ? t('Add product', '新增产品') : product.product_name}</h1>
      ${locked ? html`<div class="flash info">${biText(LOCKED_MSG)}</div>` : ''}
      <form method="post" enctype="multipart/form-data" action="${isNew ? `${req.base}/products` : `${req.base}/products/${product.id}`}" class="product-form">
        ${photoSection({ images, urls, product, maxImages: MAX_IMAGES, disabled: locked, deleteAction: (im) => `${req.base}/products/${product.id}/images/${im.id}/delete` })}
        ${locked ? html`<fieldset disabled>${productFields(product, { categories: ctx.categoryNames })}</fieldset>` : productFields(product, { categories: ctx.categoryNames })}
        ${locked ? '' : html`<div class="form-actions"><button class="btn" type="submit">${t('Save', '保存')}</button><a class="btn ghost" href="${req.base}">${t('Cancel', '取消')}</a></div>`}
      </form>
      ${!isNew && !locked ? html`<form method="post" action="${req.base}/products/${product.id}/delete"${confirmAttr('Delete this product?', '确定删除该产品？')} class="danger-zone"><button class="link danger">${t('Delete product', '删除产品')}</button></form>` : ''}`;
  }

  router.get('/portal/products/new', A(async (req, res) => {
    const ctx = await getCtx(db);
    res.html(page({ title: 'Add product', nav: nav('new'), req, body: form(req, {}, [], {}, ctx) }));
  }));

  router.post('/portal/products', A(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const { row, errors } = cleanProduct(fields);
    const ctx = await getCtx(db);
    if (errors.length) {
      return res.html(page({ title: 'Add product', nav: nav('new'), req, flash: { type: 'error', msg: errors.join(' · ') }, body: form(req, row, [], {}, ctx) }), 422);
    }
    const product = await db.insert('products', { ...row, supplier_id: req.supplier.id, source: 'form' });
    const r = await saveProductImages(db, { supplierId: req.supplier.id, productId: product.id, files: files.images, maxImages: MAX_IMAGES });
    flash(res, r.errors.length ? 'warn' : 'ok', savedMsg(r, false));
    res.redirect(`${req.base}/products/${product.id}`);
  }));

  router.get('/portal/products/:id', A(async (req, res) => {
    const p = await ownProduct(req);
    const ctx = await getCtx(db);
    const imgs = (await imagesFor(db, [p.id]))[p.id] || [];
    const urls = await db.storage.signedUrls(imgs.flatMap((i) => [i.path, i.thumb_path]));
    res.html(page({ title: p.product_name, nav: nav(''), req, flash: takeFlash(req, res), body: form(req, { ...strip(p), status: p.status }, imgs, urls, ctx) }));
  }));

  router.post('/portal/products/:id', A(async (req, res) => {
    const p = await ownProduct(req);
    if (LOCKED.includes(p.status)) throw new HttpError(403, LOCKED_MSG);
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const { row, errors } = cleanProduct(fields);
    if (errors.length) {
      flash(res, 'error', errors.join(' · '));
      return res.redirect(`${req.base}/products/${p.id}`);
    }
    await db.update('products', { id: p.id }, row);
    const existing = (await imagesFor(db, [p.id]))[p.id] || [];
    const r = await saveProductImages(db, { supplierId: req.supplier.id, productId: p.id, files: files.images, existingCount: existing.length, maxImages: MAX_IMAGES });
    flash(res, r.errors.length ? 'warn' : 'ok', savedMsg(r, true));
    res.redirect(`${req.base}/products/${p.id}`);
  }));

  router.post('/portal/products/:id/delete', A(async (req, res) => {
    const p = await ownProduct(req);
    if (LOCKED.includes(p.status)) throw new HttpError(403, LOCKED_MSG);
    const imgs = (await imagesFor(db, [p.id]))[p.id] || [];
    await deleteImages(db, imgs);
    await db.remove('products', { id: p.id });
    flash(res, 'ok', m('Product deleted', '产品已删除'));
    res.redirect(req.base);
  }));

  router.post('/portal/products/:id/images/:imageId/delete', A(async (req, res) => {
    const p = await ownProduct(req);
    if (LOCKED.includes(p.status)) throw new HttpError(403, LOCKED_MSG);
    const im = await db.get('product_images', req.params.imageId);
    if (im && im.product_id === p.id) await deleteImages(db, [im]);
    flash(res, 'ok', m('Photo deleted', '图片已删除'));
    res.redirect(`${req.base}/products/${p.id}`);
  }));

  // ── Bulk import
  router.get('/portal/import', A(async (req, res) => {
    res.html(page({ title: 'Bulk upload', nav: nav('import'), req, flash: takeFlash(req, res), body: importPage(req.base) }));
  }));

  router.post('/portal/import', A(async (req, res) => {
    const { files } = await parseForm(req, { limitBytes: 15 * 1024 * 1024 });
    const file = files.file?.[0];
    if (!file) { flash(res, 'error', m('Choose a file', '请选择文件')); return res.redirect(`${req.base}/import`); }
    const result = await runImport(db, file, req.supplier.id);
    res.html(page({ title: 'Bulk upload', nav: nav('import'), req, body: html`${importResult(result, req.base)}${importPage(req.base)}` }));
  }));

  // ── Company profile
  router.get('/portal/profile', A(async (req, res) => {
    res.html(page({ title: 'Company', nav: nav('profile'), req, flash: takeFlash(req, res), body: profileForm(req.base, req.supplier) }));
  }));
  router.post('/portal/profile', A(async (req, res) => {
    const { fields } = await parseForm(req);
    const { row, errors } = cleanSupplier(fields);
    if (errors.length) { flash(res, 'error', errors.join(' · ')); return res.redirect(`${req.base}/profile`); }
    await db.update('suppliers', { id: req.supplier.id }, row);
    flash(res, 'ok', m('Saved', '已保存'));
    res.redirect(`${req.base}/profile`);
  }));

  // ── Account: change password
  router.get('/portal/account', A(async (req, res) => {
    res.html(page({
      title: 'Account', nav: nav('account'), req, flash: takeFlash(req, res),
      body: html`<h1>${t('Account', '账号')}</h1>
      <section class="card narrow-left">
        <dl class="kv"><dt>${t('Name', '姓名')}</dt><dd>${req.user.name || '—'}</dd><dt>${t('Login email', '登录邮箱')}</dt><dd>${req.user.email}</dd><dt>${t('Company', '公司')}</dt><dd>${req.supplier.name}</dd></dl>
        <h2 class="mt">${t('Change password', '修改密码')}</h2>
        <form method="post" action="/portal/account" class="stack">
          <label><span class="lbl">${t('Current password', '当前密码')}</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label><span class="lbl">${t(`New password (at least ${MIN_PASSWORD} characters)`, `新密码（至少 ${MIN_PASSWORD} 位）`)}</span><input type="password" name="password" minlength="${MIN_PASSWORD}" required autocomplete="new-password"></label>
          <label><span class="lbl">${t('Confirm new password', '确认新密码')}</span><input type="password" name="password2" minlength="${MIN_PASSWORD}" required autocomplete="new-password"></label>
          <button class="btn">${t('Change password', '修改密码')}</button>
        </form>
        <p class="muted small">${t('Changing the password signs you out on other devices.', '修改密码后，其他设备将自动退出登录。')}</p>
      </section>`,
    }));
  }));
  router.post('/portal/account', A(async (req, res) => {
    const { fields } = await parseForm(req);
    if (!(await verifyPassword(fields.current, req.user.password_hash))) { flash(res, 'error', m('Current password is wrong', '当前密码错误')); return res.redirect('/portal/account'); }
    const err = passwordProblem(fields.password, fields.password2);
    if (err) { flash(res, 'error', err); return res.redirect('/portal/account'); }
    const [u] = await db.update('supplier_users', { id: req.user.id }, { password_hash: await hashPassword(fields.password), session_version: (req.user.session_version || 1) + 1 });
    startSession(res, config, u);
    flash(res, 'ok', m('Password changed', '密码已修改'));
    res.redirect('/portal/account');
  }));
};

function profileForm(base, s) {
  return html`<h1>${t('Company details', '公司信息')}</h1>
  <form method="post" action="${base}/profile" class="card"><div class="grid two">
    ${SUPPLIER_FIELDS.map((f) => html`<label class="${f.type === 'textarea' ? 'span2' : ''}"><span class="lbl">${t(f.en, f.cn)}${f.required ? html`<b class="req">*</b>` : ''}</span>
      ${f.type === 'textarea' ? html`<textarea name="${f.key}" rows="2">${s[f.key] || ''}</textarea>` : html`<input name="${f.key}" value="${s[f.key] || ''}" ${f.required ? raw('required') : ''} ${f.type === 'url' ? raw('inputmode="url" autocapitalize="off" spellcheck="false" placeholder="www.example.com"') : ''}>`}</label>`)}
  </div><div class="form-actions"><button class="btn">${t('Save', '保存')}</button></div></form>`;
}

function importPage(base) {
  return html`<h1>${t('Bulk upload', '批量上传')}</h1>
  <section class="card">
    <ol class="steps">
      <li>${t('Download the template:', '下载模板：')} <a href="/static/Lulyboo_Supplier_Product_Template.xlsx">Excel (.xlsx)</a> · <a href="/static/Lulyboo_Supplier_Product_Template.csv">CSV</a></li>
      <li>${t('Fill in one row per product. Keep the header rows.', '每个产品填写一行，请保留标题行。')}</li>
      <li>${t('Upload the file below, then open each product to add photos.', '上传文件后，再逐个产品添加图片。')}</li>
    </ol>
    <form method="post" enctype="multipart/form-data" action="${base}/import" class="inline-form">
      <input type="file" name="file" accept=".xlsx,.csv,text/csv" required>
      <button class="btn">${t('Upload', '上传')}</button>
    </form>
  </section>`;
}

function importResult(r, base) {
  return html`<section class="card ${r.inserted ? 'ok-card' : 'warn-card'}">
    <h2>${t('Import result', '导入结果')}</h2>
    <p>${t(html`<strong>${r.inserted}</strong> products added${r.skipped ? ` · ${r.skipped} example/header rows skipped` : ''}`, html`已添加 <strong>${r.inserted}</strong> 个产品${r.skipped ? `，跳过 ${r.skipped} 行示例/标题` : ''}`)}</p>
    ${r.unknownColumns?.length ? html`<p class="muted">${t('Columns not recognised (ignored):', '无法识别的列（已忽略）：')} ${r.unknownColumns.join(', ')}</p>` : ''}
    ${r.errors.length ? html`<h3>${t('Rows with problems', '有问题的行')}</h3><ul class="errors">${r.errors.map((e) => html`<li>${t('Row', '第')} ${e.rowNumber}${t('', ' 行')}${e.name ? ` (${e.name})` : ''}: ${biText(e.messages.join('; '))}</li>`)}</ul>` : ''}
    ${base ? html`<p><a href="${base}">${t('View my products', '查看我的产品')} →</a></p>` : ''}
  </section>`;
}

async function runImport(db, file, supplierId) {
  let parsed;
  try { parsed = parseUpload(file); } catch (e) { return { inserted: 0, skipped: 0, errors: [{ rowNumber: 0, messages: [e.message] }] }; }
  let inserted = 0;
  const rows = parsed.products.map((p) => ({ ...p.row, supplier_id: supplierId, source: 'import' }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.insert('products', chunk);
    inserted += chunk.length;
  }
  return { inserted, skipped: parsed.skipped, errors: parsed.errors, unknownColumns: parsed.unknownColumns };
}

module.exports.runImport = runImport;
module.exports.importResult = importResult;
