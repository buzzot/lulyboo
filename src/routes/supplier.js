'use strict';
// Supplier-facing pages under /portal. Requires a signed-in supplier user (see supplier-auth.js).
const { html, raw, fmt, t, m, biText, confirmAttr } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { icon } = require('../views/icons');
const { page, productFields, groupFields, photoSection } = require('../views/layout');
const { SUPPLIER_COLUMNS, SUPPLIER_FIELDS, cleanProduct, cleanSupplier } = require('../fields');
const { getCtx, imagesFor } = require('../services');
const { currentSupplierUser, passwordProblem, verifyPassword, hashPassword, startSession, MIN_PASSWORD } = require('../auth');
const { saveProductImages, deleteImages } = require('../images');
const { parseUpload } = require('../importer');
const ai = require('../ai');

const LOCKED = ['Selected', 'Rejected'];
const MAX_IMAGES = 10;

function nav(active) {
  const b = '/portal';
  return {
    home: b, label: t('Supplier Portal', '供应商平台'), lang: true,
    items: [
      { href: b, icon: 'package', label: t('My products', '我的产品'), active: active === 'home' },
      { href: `${b}/products/new`, icon: 'plus', label: t('Add product', '新增产品'), active: active === 'new' },
      { href: `${b}/import`, icon: 'upload', label: t('Bulk upload', '批量上传'), active: active === 'import' },
      { href: `${b}/profile`, icon: 'building', label: t('Company', '公司信息'), active: active === 'profile' },
      { href: `${b}/account`, icon: 'user', label: t('Account', '账号'), active: active === 'account' },
      { href: '/logout', out: true, label: t('Sign out', '退出') },
    ],
  };
}
const photosMsg = (n, plus) => (n ? ` (${plus ? '+' : ''}${n} ${n > 1 ? 'photos' : 'photo'})` : '');
const draftMsg = (r) => m(`Draft saved${photosMsg(r.saved)}. Finish and submit it when ready.`, `草稿已保存${r.saved ? `（${r.saved} 张图片）` : ''}，完成后请提交审核。`) + (r.errors.length ? ' · ' + r.errors.join(' · ') : '');
const submittedMsg = (r) => m(`Submitted for review${photosMsg(r.saved)}. Thank you!`, `已提交审核${r.saved ? `（${r.saved} 张图片）` : ''}，谢谢！`) + (r.errors.length ? ' · ' + r.errors.join(' · ') : '');
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

  // ── Dashboard: product catalog (stats, status tabs, search, category filter)
  const COMPLETE_KEYS = ['product_name', 'category', 'description', 'materials', 'unit_price', 'moq', 'production_lead_days', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_gw_kg'];
  const stateOf = (p) => (p.is_draft ? 'draft' : p.status === 'Selected' ? 'selected' : p.status === 'Rejected' ? 'closed' : p.status === 'New' || !p.status ? 'submitted' : 'review');
  const STATE_LABEL = { draft: ['Draft', '草稿'], submitted: ['Submitted', '已提交'], review: ['Under review', '审核中'], selected: ['Selected', '已选中'], closed: ['Closed', '已关闭'] };
  const stateIcon = { draft: 'filePen', submitted: 'check', review: 'clock', selected: 'checkCheck', closed: 'x' };
  const badge = (st) => html`<span class="status-badge st-${st}">${icon(stateIcon[st], 12)}${t(STATE_LABEL[st][0], STATE_LABEL[st][1])}</span>`;
  const pctOf = (p, nImgs) => Math.round(((COMPLETE_KEYS.filter((k) => p[k] !== null && p[k] !== undefined && String(p[k]).trim() !== '').length + (nImgs || p.photo_link ? 1 : 0)) / (COMPLETE_KEYS.length + 1)) * 100);

  router.get('/portal', A(async (req, res) => {
    const all = await db.list('products', { filters: { supplier_id: req.supplier.id }, order: 'created_at.desc' });
    const imgs = await imagesFor(db, all.map((p) => p.id));
    const rows = all.map((p) => ({ ...p, st: stateOf(p), pct: pctOf(p, imgs[p.id]?.length) }));
    const count = (k) => rows.filter((r) => r.st === k).length;
    const tab = ['draft', 'submitted', 'review', 'selected'].includes(req.query.status) ? req.query.status : 'all';
    const q = String(req.query.q || '').trim().toLowerCase();
    const cat = String(req.query.category || '');
    const shown = rows.filter((r) => (tab === 'all' || r.st === tab) && (!cat || r.category === cat) && (!q || `${r.product_name} ${r.supplier_sku || ''} ${r.category || ''}`.toLowerCase().includes(q)));
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    const urls = await db.storage.signedUrls(shown.map((p) => imgs[p.id]?.[0]?.thumb_path));
    const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length) : 0;
    const tabHref = (k) => { const u = new URLSearchParams(); if (k !== 'all') u.set('status', k); if (q) u.set('q', q); if (cat) u.set('category', cat); const x = u.toString(); return `${req.base}${x ? `?${x}` : ''}`; };
    const TABS = [['all', 'All', '全部', rows.length], ['draft', 'Drafts', '草稿', count('draft')], ['submitted', 'Submitted', '已提交', count('submitted')], ['review', 'Under review', '审核中', count('review')], ['selected', 'Selected', '已选中', count('selected')]];
    res.html(page({
      title: 'My products', nav: nav('home'), flash: takeFlash(req, res), req,
      body: html`
      <div class="page-heading">
        <div><div class="eyebrow">${t('Product catalog', '产品目录')}</div><h1>${t('My products', '我的产品')}</h1>
          <p class="muted">${t('Submit your products and prices to Lulyboo.', '向 Lulyboo 提交您的产品和报价。')}</p></div>
        <div class="actions"><a class="btn ghost" href="${req.base}/import">${icon('upload', 16)}${t('Bulk upload', '批量上传')}</a><a class="btn" href="${req.base}/products/new">${icon('plus', 16)}${t('Add product', '新增产品')}</a></div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-ico">${icon('package', 18)}</span><div><b>${rows.length}</b><small>${t('Total products', '产品总数')}</small></div></div>
        <div class="stat-card"><span class="stat-ico amber">${icon('filePen', 18)}</span><div><b>${count('draft')}</b><small>${t('Drafts', '草稿')}</small></div></div>
        <div class="stat-card"><span class="stat-ico blue">${icon('clock', 18)}</span><div><b>${count('submitted') + count('review')}</b><small>${t('Submitted / in review', '已提交 / 审核中')}</small></div></div>
        <div class="stat-card"><span class="stat-ico green">${icon('checkCheck', 18)}</span><div><b>${count('selected')}</b><small>${t('Selected by Lulyboo', '已被选中')}</small></div></div>
      </div>
      ${rows.length ? html`
      <section class="catalog-section">
        <div class="catalog-tabs">${TABS.map(([k, en, zh, n]) => html`<a href="${tabHref(k)}" class="${tab === k ? 'on' : ''}">${t(en, zh)}<em>${n}</em></a>`)}</div>
        <form class="catalog-tools" method="get" action="${req.base}">
          ${tab !== 'all' ? html`<input type="hidden" name="status" value="${tab}">` : ''}
          <label class="search">${icon('search', 16)}<input type="search" name="q" value="${req.query.q || ''}" placeholder="Search name or SKU…" aria-label="Search"></label>
          <select name="category" aria-label="Category" data-autosubmit><option value="">${'All categories'}</option>${cats.map((c) => html`<option ${c === cat ? raw('selected') : ''}>${c}</option>`)}</select>
          <button class="btn ghost small" type="submit">${t('Search', '搜索')}</button>
          <span class="avg">${t('Avg. completeness', '平均完整度')} <b>${avg}%</b></span>
        </form>
        ${shown.length ? html`<div class="table-wrap"><table class="list product-table">
          <thead><tr><th></th><th>${t('Product', '产品')}</th><th>${t('Category', '类别')}</th><th class="r">${t('Price', '单价')}</th><th class="r">MOQ</th><th>${t('Status', '状态')}</th><th>${t('Completeness', '完整度')}</th><th>${t('Updated', '更新')}</th></tr></thead>
          <tbody>${shown.map((p) => html`<tr>
            <td class="thumb-cell">${imgs[p.id]?.[0] ? html`<img src="${urls[imgs[p.id][0].thumb_path] || ''}" alt="">` : html`<span class="noimg">${icon('camera', 18)}</span>`}</td>
            <td><a class="pname" href="${req.base}/products/${p.id}">${p.product_name}</a><div class="sub">${p.supplier_sku || ''}</div></td>
            <td>${p.category || '—'}</td>
            <td class="r">${fmt.money(p.unit_price, p.currency)}</td><td class="r">${fmt.num(p.moq)}</td>
            <td>${badge(p.st)}</td>
            <td><div class="meter" title="${p.pct}%"><i style="width:${p.pct}%"></i></div><span class="sub">${p.pct}%</span></td>
            <td>${fmt.date(p.updated_at)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="empty-sm">${t('No products match this filter.', '没有符合条件的产品。')}</div>`}
      </section>`
        : html`<section class="card empty">${icon('package', 30)}<h2>${t('No products yet', '暂无产品')}</h2>
          <p>${t('Add products one at a time with photos, or upload our Excel template with many products at once.', '可逐个添加产品（含图片），或使用 Excel 模板批量上传。')}</p>
          <p><a class="btn" href="${req.base}/products/new">${icon('plus', 16)}${t('Add product', '新增产品')}</a> <a class="btn ghost" href="/static/Lulyboo_Supplier_Product_Template.xlsx">${icon('download', 16)}${t('Download template', '下载模板')}</a></p></section>`}`,
    }));
  }));

  // ── Product form: 5-step wizard (Photos → Product → Pricing → Packing → Review).
  // Without JavaScript all steps show one after another; with it, one step at a time.
  const ICON = {
    photos: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    product: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    pricing: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6M12 6.5v11"/>',
    packing: '<path d="M8.5 6.5 12 4.5l3.5 2v4L12 12.5l-3.5-2zM4.5 13l3.5-2 3.5 2v4L8 19l-3.5-2zM12.5 13l3.5-2 3.5 2v4L16 19l-3.5-2z"/>',
    review: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const svg = (k) => raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`);
  const STEPS = [
    { id: 'photos', en: 'Photos', zh: '图片' },
    { id: 'product', en: 'Product', zh: '产品信息' },
    { id: 'pricing', en: 'Pricing & terms', zh: '价格与条款' },
    { id: 'packing', en: 'Packing & carton', zh: '包装与外箱' },
    { id: 'review', en: 'Review', zh: '确认提交' },
  ];

  function form(req, product, images = [], urls = {}, ctx, startStep = 0) {
    const isNew = !product.id;
    const locked = !isNew && LOCKED.includes(product.status);
    const isDraft = isNew || product.is_draft;
    const opts = { categories: ctx.categoryNames };
    const action = isNew ? `${req.base}/products` : `${req.base}/products/${product.id}`;
    const step = Math.min(Math.max(Number(startStep) || 0, 0), STEPS.length - 1);
    const heading = html`<div class="wiz-head">
        <div><div class="eyebrow">${isNew ? t('New catalog entry', '新增产品') : isDraft ? t('Draft', '草稿') : t('Submitted product', '已提交的产品')}</div>
        <h1>${isNew ? t('Add product', '新增产品') : product.product_name}</h1></div>
        <a class="wiz-close" href="${req.base}" aria-label="Close">×</a></div>`;

    if (locked) {
      return html`${heading}<div class="flash info">${biText(LOCKED_MSG)}</div>
        <form class="product-form"><fieldset disabled>
          ${photoSection({ images, urls, product, maxImages: MAX_IMAGES, disabled: true })}
          ${productFields(product, opts)}
        </fieldset></form>`;
    }

    return html`${heading}
      <form method="post" enctype="multipart/form-data" action="${action}" class="product-form wizard" data-wizard data-start="${step}">
        <input type="hidden" name="step" value="${step}" data-step-input>
        <nav class="stepper" aria-label="Steps">
          ${STEPS.map((s, i) => html`<button type="button" class="step-tab" data-goto="${i}">
            <span class="step-ico">${svg(s.id)}</span><span class="step-check" aria-hidden="true">✓</span>
            <span class="step-name">${t(s.en, s.zh)}</span></button>`)}
        </nav>

        <section class="wstep" data-step="0" aria-label="Photos">
          ${photoSection({ images, urls, product, maxImages: MAX_IMAGES, deleteAction: (im) => `${req.base}/products/${product.id}/images/${im.id}/delete` })}
        </section>
        <section class="wstep" data-step="1">${groupFields(product, 'product', opts)}
          <button type="button" class="btn ghost sm ai-btn" data-ai="describe" hidden>${icon('filePen', 14)} <span class="i-en">Draft with AI</span><span class="i-zh">AI 生成描述</span></button></section>
        <section class="wstep" data-step="2">${groupFields(product, 'pricing', opts)}</section>
        <section class="wstep" data-step="3">${groupFields(product, 'packing', opts)}</section>
        <section class="wstep" data-step="4">
          ${groupFields(product, 'other', opts)}
          <div class="review-box" data-review data-photos="${images.length}">
            <h2>${t('Ready for review?', '准备好提交了吗？')}</h2>
            <ul class="checklist" data-checklist></ul>
            <div class="ai-check"><button type="button" class="link" data-ai="check" hidden><span class="i-en">Check with AI ↗</span><span class="i-zh">AI 检查 ↗</span></button><ul class="checklist" data-ai-result></ul></div>
            <dl class="summary">
              <div><dt>${t('Product', '产品')}</dt><dd data-sum="product_name">—</dd></div>
              <div><dt>${t('Category', '类别')}</dt><dd data-sum="category">—</dd></div>
              <div><dt>${t('Price', '价格')}</dt><dd data-sum="price">—</dd></div>
              <div><dt>${t('MOQ', '起订量')}</dt><dd data-sum="moq">—</dd></div>
              <div><dt>${t('Master carton', '外箱')}</dt><dd data-sum="carton">—</dd></div>
              <div><dt>${t('Photos', '图片')}</dt><dd data-sum="photos">${images.length}</dd></div>
            </dl>
          </div>
        </section>

        <div class="wiz-foot">
          ${isDraft
            ? html`<button class="btn ghost" type="submit" name="action" value="draft" formnovalidate>${t('Save draft', '保存草稿')}</button>`
            : html`<button class="btn ghost" type="submit" name="action" value="save">${t('Save changes', '保存修改')}</button>`}
          <span class="spacer"></span>
          <button class="btn ghost" type="button" data-back>‹ ${t('Back', '上一步')}</button>
          <button class="btn" type="button" data-next>${t('Continue', '继续')} ›</button>
          <button class="btn" type="submit" name="action" value="${isDraft ? 'submit' : 'save'}" data-finish>${isDraft ? t('Submit for review', '提交审核') : t('Save changes', '保存修改')}</button>
        </div>
      </form>
      ${!isNew ? html`<form method="post" action="${req.base}/products/${product.id}/delete"${confirmAttr('Delete this product?', '确定删除该产品？')} class="danger-zone"><button class="link danger">${t('Delete product', '删除产品')}</button></form>` : ''}`;
  }

  // Draft saves don't need a name yet; everything else does.
  function cleanForAction(fields) {
    const action = ['draft', 'submit', 'save'].includes(fields.action) ? fields.action : 'save';
    const { row, errors } = cleanProduct(fields);
    let errs = errors;
    if (action === 'draft') {
      errs = errors.filter((e) => !/is required/.test(e));
      if (!row.product_name) row.product_name = 'Untitled draft';
    }
    return { action, row, errors: errs };
  }
  const stepOf = (fields) => Math.min(Math.max(Number(fields.step) || 0, 0), 4);

  // AI helpers used by the wizard ("Draft with AI", "Check with AI"). Per-user hourly cap.
  const aiHits = new Map();
  function aiGate(req) {
    if (!ai.enabled()) throw new HttpError(503, m('AI is not enabled yet.', 'AI 功能尚未启用。'));
    const k = req.user.id, now = Date.now();
    const arr = (aiHits.get(k) || []).filter((x) => now - x < 3600_000);
    if (arr.length >= 30) throw new HttpError(429, m('Too many AI requests. Try again later.', 'AI 请求过多，请稍后再试。'));
    arr.push(now); aiHits.set(k, arr);
  }
  const AI_KEYS = ['product_name', 'supplier_sku', 'category', 'subcategory', 'description', 'materials', 'product_size_cm', 'unit_net_weight_kg', 'packaging_type', 'certifications', 'hs_code', 'country_of_origin', 'brand', 'currency', 'unit_price', 'incoterm', 'moq', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_nw_kg', 'carton_gw_kg'];
  const aiFields = (f) => Object.fromEntries(AI_KEYS.filter((k) => f[k] && String(f[k]).trim()).map((k) => [k, String(f[k]).slice(0, 500)]));
  router.post('/portal/ai/:what', A(async (req, res) => {
    const f = (await parseForm(req, { limitBytes: 200_000 }).catch(() => ({ fields: {} }))).fields;
    const fields = aiFields(f);
    try {
      aiGate(req);
      if (req.params.what === 'describe') {
        if (!fields.product_name) throw new HttpError(400, m('Enter a product name first.', '请先填写产品名称。'));
        return res.json({ ok: true, description: await ai.draftDescription({ fields }) });
      }
      if (req.params.what === 'check') { const r = await ai.checkListing({ fields, photos: Number(f.photos) || 0 }); return res.json({ ok: true, issues: r.issues }); }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('AI helper failed:', e.message);
      const st = e instanceof HttpError ? e.status : 502;
      return res.json({ ok: false, message: e instanceof HttpError ? e.message : m('AI is unavailable right now. Please try again.', 'AI 暂时不可用，请稍后重试。') }, st);
    }
    throw new HttpError(404, 'Not found');
  }));

  router.get('/portal/products/new', A(async (req, res) => {
    const ctx = await getCtx(db);
    res.html(page({ title: 'Add product', nav: nav('new'), req, body: form(req, {}, [], {}, ctx, 0) }));
  }));

  router.post('/portal/products', A(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const { action, row, errors } = cleanForAction(fields);
    const ctx = await getCtx(db);
    if (errors.length) {
      return res.html(page({ title: 'Add product', nav: nav('new'), req, flash: { type: 'error', msg: errors.join(' · ') }, body: form(req, row, [], {}, ctx, stepOf(fields)) }), 422);
    }
    const draft = action === 'draft';
    const product = await db.insert('products', { ...row, supplier_id: req.supplier.id, source: 'form', is_draft: draft, submitted_at: draft ? null : new Date().toISOString() });
    const r = await saveProductImages(db, { supplierId: req.supplier.id, productId: product.id, files: files.images, maxImages: MAX_IMAGES });
    flash(res, r.errors.length ? 'warn' : 'ok', draft ? draftMsg(r) : submittedMsg(r));
    res.redirect(draft ? `${req.base}/products/${product.id}?step=${stepOf(fields)}` : req.base);
  }));

  router.get('/portal/products/:id', A(async (req, res) => {
    const p = await ownProduct(req);
    const ctx = await getCtx(db);
    const imgs = (await imagesFor(db, [p.id]))[p.id] || [];
    const urls = await db.storage.signedUrls(imgs.flatMap((i) => [i.path, i.thumb_path]));
    res.html(page({ title: p.product_name, nav: nav(''), req, flash: takeFlash(req, res), body: form(req, { ...strip(p), status: p.status }, imgs, urls, ctx, req.query.step) }));
  }));

  router.post('/portal/products/:id', A(async (req, res) => {
    const p = await ownProduct(req);
    if (LOCKED.includes(p.status)) throw new HttpError(403, LOCKED_MSG);
    const { fields, files } = await parseForm(req, { limitBytes: config.maxUploadBytes });
    const { action, row, errors } = cleanForAction(fields);
    if (errors.length) {
      flash(res, 'error', errors.join(' · '));
      return res.redirect(`${req.base}/products/${p.id}?step=${stepOf(fields)}`);
    }
    // A submitted product never goes back to draft; a draft becomes submitted on "Submit for review".
    const patch = { ...row };
    if (p.is_draft && action === 'submit') { patch.is_draft = false; patch.submitted_at = new Date().toISOString(); }
    await db.update('products', { id: p.id }, patch);
    const existing = (await imagesFor(db, [p.id]))[p.id] || [];
    const r = await saveProductImages(db, { supplierId: req.supplier.id, productId: p.id, files: files.images, existingCount: existing.length, maxImages: MAX_IMAGES });
    const submitted = p.is_draft && action === 'submit';
    flash(res, r.errors.length ? 'warn' : 'ok', submitted ? submittedMsg(r) : action === 'draft' ? draftMsg(r) : savedMsg(r, true));
    res.redirect(submitted ? req.base : `${req.base}/products/${p.id}?step=${stepOf(fields)}`);
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
      <li>${t('Download the template:', '下载模板：')} <a href="/static/Lulyboo_Supplier_Product_Template.xlsx">Lulyboo_Supplier_Product_Template.xlsx</a></li>
      <li>${t('Or use the Factory Quotation Request form (also accepted):', '也可使用工厂报价申请表（同样支持）：')} <a href="/static/Lulyboo_Factory_Quotation_Request_2026.xlsx">Lulyboo_Factory_Quotation_Request_2026.xlsx</a></li>
      <li>${t('Fill in your factory details and terms once at the top, then one row per product.', '在顶部填写一次工厂信息和条款，然后每个产品填写一行。')}</li>
      <li>${t('Put each product photo in the Photo column of its row (Excel: Insert → Pictures → Place in Cell). Upload the .xlsx below: products and photos are imported together.', '请把每个产品的照片放在该行的“照片”列（Excel：插入 → 图片 → 放入单元格）。在下方上传 .xlsx 文件，产品和照片会一起导入。')}</li>
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
    <p>${t(html`<strong>${r.inserted}</strong> products added${r.photos ? ` · ${r.photos} photos imported` : ''}${r.skipped ? ` · ${r.skipped} example/header rows skipped` : ''}`, html`已添加 <strong>${r.inserted}</strong> 个产品${r.photos ? `，导入 ${r.photos} 张照片` : ''}${r.skipped ? `，跳过 ${r.skipped} 行示例/标题` : ''}`)}</p>
    ${r.unknownColumns?.length ? html`<p class="muted">${t('Columns not recognised (ignored):', '无法识别的列（已忽略）：')} ${r.unknownColumns.join(', ')}</p>` : ''}
    ${r.errors.length ? html`<h3>${t('Rows with problems', '有问题的行')}</h3><ul class="errors">${r.errors.map((e) => html`<li>${e.rowNumber ? html`${t('Row', '第')} ${e.rowNumber}${t('', ' 行')}${e.name ? ` (${e.name})` : ''}: ` : ''}${biText(e.messages.join('; '))}</li>`)}</ul>` : ''}
    ${base ? html`<p><a href="${base}">${t('View my products', '查看我的产品')} →</a></p>` : ''}
  </section>`;
}

async function runImport(db, file, supplierId) {
  let parsed;
  try { parsed = parseUpload(file); } catch (e) { return { inserted: 0, skipped: 0, photos: 0, errors: [{ rowNumber: 0, messages: [e.message] }] }; }
  let inserted = 0; let photos = 0;
  const errors = [...parsed.errors];
  const rows = parsed.products.map((p) => ({ ...p.row, supplier_id: supplierId, source: 'import' }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const saved = await db.insert('products', chunk);
    inserted += chunk.length;
    // Pictures that were embedded in the spreadsheet row go with the product they sit on.
    for (let k = 0; k < chunk.length; k++) {
      const src = parsed.products[i + k];
      if (!src.images || !src.images.length || !saved[k]) continue;
      try {
        const r = await saveProductImages(db, { supplierId, productId: saved[k].id, files: src.images, maxImages: MAX_IMAGES });
        photos += r.saved;
        if (r.errors.length) errors.push({ rowNumber: src.rowNumber, name: src.row.product_name, messages: r.errors });
      } catch (e) {
        errors.push({ rowNumber: src.rowNumber, name: src.row.product_name, messages: [m('Photos could not be saved. Add them on the product page.', '照片保存失败，请在产品页面重新添加。')] });
      }
    }
  }
  if (parsed.photosUnmatched) errors.push({ rowNumber: 0, messages: [m(`${parsed.photosUnmatched} picture(s) were not on a product row and were ignored.`, `有 ${parsed.photosUnmatched} 张图片不在产品行内，已忽略。`)] });
  if (parsed.photosUnsupported) errors.push({ rowNumber: 0, messages: [m(`${parsed.photosUnsupported} picture(s) are in an unsupported format (e.g. EMF/WMF) and were ignored. Use JPG or PNG.`, `有 ${parsed.photosUnsupported} 张图片格式不受支持（如 EMF/WMF），已忽略。请使用 JPG 或 PNG。`)] });
  return { inserted, photos, skipped: parsed.skipped, errors, unknownColumns: parsed.unknownColumns };
}

module.exports.runImport = runImport;
module.exports.importResult = importResult;
