'use strict';
// Spreadsheet import in two steps: (1) the upload is parsed and shown in a review table with the main fields,
// (2) nothing is saved until the person approves. The uploaded file is held in server memory for a short time
// (not in the database or storage bucket), so an abandoned review leaves nothing behind.
const crypto = require('node:crypto');
const { html, raw, t, m, biText } = require('./lib/html');
const { CATEGORIES, CURRENCIES, PRODUCT_FIELDS, cleanProduct } = require('./fields');
const sharp = require('sharp');
const { parseUpload } = require('./importer');
const { saveProductImages } = require('./images');

const MAX_IMAGES = 10;
const TTL_MS = 30 * 60 * 1000;
const MAX_STAGED_BYTES = 150 * 1024 * 1024;

// Main fields shown (and editable) in the review table.
const EDIT_KEYS = ['product_name', 'category', 'unit_price', 'currency', 'moq', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_gw_kg', 'production_lead_days'];

// Everything else on a product is editable in the pop-up (only changed values are applied).
const EXTRA_FIELDS = PRODUCT_FIELDS.filter((f) => !EDIT_KEYS.includes(f.key) && f.key !== 'photo_link');
const strVal = (v) => (v === null || v === undefined ? '' : String(v));

// ── Staging (in memory) ────────────────────────────────────────
const staged = new Map(); // `${supplierId}:${token}` -> { buffer, name, at }
function sweep(now = Date.now()) {
  for (const [k, v] of staged) if (now - v.at > TTL_MS) staged.delete(k);
  let total = 0; for (const v of staged.values()) total += v.buffer.length;
  for (const [k, v] of staged) { if (total <= MAX_STAGED_BYTES) break; total -= v.buffer.length; staged.delete(k); } // oldest first
}
const stageKey = (supplierId, token) => `${supplierId}:${token}`;
const validToken = (s) => /^[a-f0-9]{24}$/.test(String(s || ''));

// ── Insert ─────────────────────────────────────────────────────
async function insertParsed(db, parsed, supplierId) {
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

/** Parse and insert in one go (no review step). */
async function runImport(db, file, supplierId) {
  let parsed;
  try { parsed = parseUpload(file); } catch (e) { return failed(e.message); }
  return insertParsed(db, parsed, supplierId);
}

const failed = (message) => ({ inserted: 0, skipped: 0, photos: 0, errors: [{ rowNumber: 0, messages: [message] }] });

function importResult(r, base) {
  return html`<section class="card ${r.inserted ? 'ok-card' : 'warn-card'}">
    <h2>${t('Import result', '导入结果')}</h2>
    <p>${t(html`<strong>${r.inserted}</strong> products added${r.photos ? ` · ${r.photos} photos imported` : ''}${r.skipped ? ` · ${r.skipped} example/header rows skipped` : ''}`, html`已添加 <strong>${r.inserted}</strong> 个产品${r.photos ? `，导入 ${r.photos} 张照片` : ''}${r.skipped ? `，跳过 ${r.skipped} 行示例/标题` : ''}`)}</p>
    ${r.unknownColumns?.length ? html`<p class="muted">${t('Columns not recognised (ignored):', '无法识别的列（已忽略）：')} ${r.unknownColumns.join(', ')}</p>` : ''}
    ${r.errors.length ? html`<h3>${t('Rows with problems', '有问题的行')}</h3><ul class="errors">${r.errors.map((e) => html`<li>${e.rowNumber ? html`${t('Row', '第')} ${e.rowNumber}${t('', ' 行')}${e.name ? ` (${e.name})` : ''}: ` : ''}${biText(e.messages.join('; '))}</li>`)}</ul>` : ''}
    ${base ? html`<p><a href="${base}">${t('View my products', '查看我的产品')} →</a></p>` : ''}
  </section>`;
}

// ── Step 1: parse and show the review ──────────────────────────
/**
 * Returns { result } when there is nothing to review (nothing could be read), or { page } with the review form.
 * view = { admin, action }  (action = the import URL; /confirm and /cancel hang off it)
 */
async function startReview(db, file, supplierId, view) {
  let parsed;
  try { parsed = parseUpload(file); } catch (e) { return { result: failed(e.message) }; }
  if (!parsed.products.length) return { result: { inserted: 0, photos: 0, skipped: parsed.skipped, errors: parsed.errors, unknownColumns: parsed.unknownColumns } };
  sweep();
  const token = crypto.randomBytes(12).toString('hex');
  staged.set(stageKey(supplierId, token), { buffer: file.buffer, name: file.name || 'upload', at: Date.now(), parsed, thumbs: new Map() });
  const supplier = await db.get('suppliers', supplierId);
  const values = {}; const selected = new Set();
  const dup = await duplicateRows(db, supplierId, parsed);
  for (const p of parsed.products) {
    values[p.rowNumber] = Object.fromEntries(EDIT_KEYS.map((k) => [k, p.row[k] === null || p.row[k] === undefined ? '' : String(p.row[k])]));
    if (!dup.has(p.rowNumber)) selected.add(p.rowNumber); // possible duplicates start unticked
  }
  return { page: reviewPage({ ...view, token, fileName: file.name, parsed, values, selected, rowErrors: {}, dup, supplierName: supplier?.name || '' }) };
}

async function duplicateRows(db, supplierId, parsed) {
  const existing = (await db.list('products', { filters: { supplier_id: supplierId }, select: 'product_name,archived_at' })).filter((p) => !p.archived_at);
  const have = new Set(existing.map((p) => String(p.product_name || '').trim().toLowerCase()));
  return new Set(parsed.products.filter((p) => have.has(String(p.row.product_name || '').trim().toLowerCase())).map((p) => p.rowNumber));
}

// ── Step 2: apply the person's edits, then insert ──────────────
/**
 * Returns { done: result } after inserting, { page } when something needs fixing, or { expired: true }.
 */
async function finishReview(db, supplierId, fields, view) {
  const token = String(fields.token || '');
  const entry = validToken(token) ? staged.get(stageKey(supplierId, token)) : null;
  if (!entry || Date.now() - entry.at > TTL_MS) { if (entry) staged.delete(stageKey(supplierId, token)); return { expired: true }; }
  let parsed;
  try { parsed = entry.parsed || parseUpload({ name: entry.name, buffer: entry.buffer }); } catch (e) { return { done: failed(e.message) }; }
  const supplier = await db.get('suppliers', supplierId);
  const supplierName = supplier?.name || '';

  const values = {}; const selected = new Set(); const rowErrors = {}; const chosen = []; const extra = {};
  const dup = await duplicateRows(db, supplierId, parsed);
  for (const p of parsed.products) {
    const rn = p.rowNumber;
    values[rn] = Object.fromEntries(EDIT_KEYS.map((k) => {
      const f = fields[`r_${rn}_${k}`];
      return [k, f === undefined ? strVal(p.row[k]) : String(f)];
    }));
    // pop-up fields: only the ones that were changed
    const extraIn = {};
    for (const f of EXTRA_FIELDS) { const v = fields[`x_${rn}_${f.key}`]; if (v !== undefined) { extra[rn] = extra[rn] || {}; extra[rn][f.key] = String(v); if (String(v) !== strVal(p.row[f.key])) extraIn[f.key] = String(v); } }
    if (!fields[`use_${rn}`]) continue;
    selected.add(rn);
    const { patch, errors } = readEdits(values[rn], extraIn);
    if (errors.length) { rowErrors[rn] = errors; continue; }
    chosen.push({ ...p, row: { ...p.row, ...patch } });
  }
  if (!selected.size) return { page: reviewPage({ ...view, token, fileName: entry.name, parsed, values, selected, rowErrors, dup, supplierName, extra, notice: m('Tick at least one product to import.', '请至少勾选一个要导入的产品。') }) };
  if (Object.keys(rowErrors).length) return { page: reviewPage({ ...view, token, fileName: entry.name, parsed, values, selected, rowErrors, dup, supplierName, extra, notice: m('Fix the highlighted rows, then approve again.', '请先修正标红的行，然后再次确认导入。') }) };
  const result = await insertParsed(db, { ...parsed, products: chosen }, supplierId);
  staged.delete(stageKey(supplierId, token));
  return { done: result };
}

function cancelReview(supplierId, token) { if (validToken(token)) staged.delete(stageKey(supplierId, token)); }

/** Validate the edited main fields (strings from the form) into clean column values. */
function readEdits(v, extraIn = {}) {
  const errors = [];
  const name = String(v.product_name || '').trim();
  if (!name) errors.push(m('Product name is required', '请填写产品名称'));
  const category = String(v.category || '').trim();
  if (category && !CATEGORIES.includes(category)) errors.push(m(`Category must be one of: ${CATEGORIES.join(', ')}`, `类别须为：${CATEGORIES.join('、')}`));
  const currency = String(v.currency || '').trim().toUpperCase();
  if (currency && !CURRENCIES.includes(currency)) errors.push(m(`Currency must be one of: ${CURRENCIES.join(', ')}`, `币种须为：${CURRENCIES.join('、')}`));
  const numeric = {};
  for (const k of EDIT_KEYS) if (!['product_name', 'category', 'currency'].includes(k)) numeric[k] = v[k];
  const { row, errors: numErrors } = cleanProduct({ ...numeric, ...extraIn }, { partial: true });
  errors.push(...numErrors);
  const patch = { ...row, product_name: name.slice(0, 500), category: category || null, currency: currency || 'USD' };
  if ('incoterm' in patch && !patch.incoterm) delete patch.incoterm;
  return { patch, errors };
}

// ── Company check ──────────────────────────────────────────────
const LEGAL = /\b(co|company|ltd|limited|inc|corp|corporation|llc|trading|industrial|industry|industries|international|group|manufacturing|mfg)\b|有限公司|股份|公司|工厂|集团/gi;
const nameTokens = (x) => String(x || '').toLowerCase().replace(LEGAL, ' ').replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim().split(/\s+/).filter(Boolean);
/** 'match' | 'mismatch' | 'unknown' (nothing readable in the file). */
function companyMatch(fileName, supplierName) {
  const a = nameTokens(fileName); const b = nameTokens(supplierName);
  if (!a.length) return 'unknown';
  if (!b.length) return 'unknown';
  const ja = a.join(''); const jb = b.join('');
  if (ja === jb || (Math.min(ja.length, jb.length) >= 4 && (ja.includes(jb) || jb.includes(ja)))) return 'match';
  const shared = a.filter((w) => b.includes(w)).length;
  return shared / Math.min(a.length, b.length) >= 0.5 ? 'match' : 'mismatch';
}

// ── Picture previews (served from the staged upload) ───────────
async function reviewImage(supplierId, token, row, index, size) {
  const entry = validToken(token) ? staged.get(stageKey(supplierId, token)) : null;
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  const p = (entry.parsed?.products || []).find((x) => x.rowNumber === Number(row));
  const img = p?.images?.[Number(index)];
  if (!img) return null;
  const px = size === 'full' ? 900 : 160;
  const key = `${row}:${index}:${px}`;
  if (!entry.thumbs) entry.thumbs = new Map();
  if (!entry.thumbs.has(key)) {
    try { entry.thumbs.set(key, await sharp(img.buffer, { failOn: 'none', limitInputPixels: 120_000_000 }).rotate().resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer()); }
    catch { return null; }
  }
  return { buffer: entry.thumbs.get(key), type: 'image/webp' };
}

// ── The review form ────────────────────────────────────────────
function reviewPage({ admin, action, token, fileName, parsed, values, selected, rowErrors, dup, notice, supplierName, extra = {} }) {
  const T = (en, zh) => (admin ? en : t(en, zh));
  const first = parsed.products[0]?.row || {};
  const hd = parsed.header || {}; const tm = parsed.terms || {};
  const today = new Date().toISOString().slice(0, 10);
  const validUntil = tm.quote_valid_until !== undefined ? first.quote_valid_until : null;
  const contact = [hd.contact_name, hd.phone, hd.email, hd.website].filter(Boolean);
  const none = html`<span class="muted">${T('not in file', '文件中未找到')}</span>`;
  const cell = (v) => (v ? html`<b>${String(v)}</b>` : none);
  const cm = companyMatch(hd.company, supplierName);
  const overview = html`<div class="rv-overview">
    <h3>${T('File header', '文件抬头')}</h3>
    <dl class="rv-hd">
      <div><dt>${T('Company name', '公司名称')}</dt><dd>${cell(hd.company)}</dd></div>
      <div><dt>${T('Contact info', '联系方式')}</dt><dd>${contact.length ? html`<b>${contact.join(' · ')}</b>` : none}</dd></div>
      <div class="wide"><dt>${T('Address', '地址')}</dt><dd>${cell(hd.address)}</dd></div>
      <div><dt>${T('Incoterm', '贸易术语')}</dt><dd>${cell(tm.incoterm)}</dd></div>
      <div><dt>${T('Port', '港口')}</dt><dd>${cell(tm.fob_port ?? first.fob_port)}</dd></div>
      <div class="wide"><dt>${T('Payment terms', '付款条款')}</dt><dd>${cell(tm.payment_terms ?? first.payment_terms)}</dd></div>
      <div><dt>${T('Validity', '报价有效期')}</dt><dd>${validUntil ? html`<b>${validUntil}</b>${validUntil < today ? html` <span class="rv-flag">${T('expired', '已过期')}</span>` : ''}` : none}</dd></div>
    </dl>
    ${admin && cm === 'mismatch' ? html`<p class="flash warn" role="alert"><b>${T('Company does not match.', '公司名称不一致。')}</b> ${T(`The file says “${hd.company}”, but you are importing for “${supplierName}”. Check that you chose the right supplier before approving.`, `文件中的公司为“${hd.company}”，但您正在为“${supplierName}”导入。请确认供应商无误后再确认导入。`)}</p>` : ''}
    ${!admin && cm === 'mismatch' ? html`<p class="flash warn" role="alert"><b>${T('Company does not match.', '公司名称不一致。')}</b> ${T(`The file says “${hd.company}”, but your account is “${supplierName}”.`, `文件中的公司为“${hd.company}”，与您的账户“${supplierName}”不一致。`)}</p>` : ''}
    ${cm === 'unknown' && !hd.company ? html`<p class="flash info">${T(`No company name was found in the file, so it could not be checked against “${supplierName}”.`, `文件中未找到公司名称，无法与“${supplierName}”核对。`)}</p>` : ''}
    ${cm === 'match' ? html`<p class="sub rv-ok">✓ ${T('Company name matches', '公司名称一致')} “${supplierName}”</p>` : ''}
  </div>`;
  const flagsFor = (p) => {
    const f = [];
    if (dup.has(p.rowNumber)) f.push(T('Already in the list', '列表中已有'));
    if (!p.row.unit_price) f.push(T('No price', '缺少单价'));
    if (!p.row.units_per_carton || !p.row.carton_l_cm || !p.row.carton_w_cm || !p.row.carton_h_cm || !p.row.carton_gw_kg) f.push(T('Carton info missing', '外箱信息不全'));
    return f;
  };
  const imgUrl = (rn, i, sz) => `${action}/image?token=${token}&row=${rn}&i=${i}${sz ? `&s=${sz}` : ''}`;
  const num = (rn, k, w) => html`<input class="rv-num ${w || ''}" name="r_${rn}_${k}" data-sync="r_${rn}_${k}" value="${values[rn][k]}" inputmode="decimal" aria-label="${k}">`;
  const select = (rn, k, options) => {
    const cur = values[rn][k];
    const opts = options.includes(cur) || !cur ? options : [cur, ...options];
    return html`<select class="rv-sel" name="r_${rn}_${k}" data-sync="r_${rn}_${k}" aria-label="${k}">${k === 'category' ? html`<option value=""${cur ? '' : raw(' selected')}>—</option>` : ''}${opts.map((o) => html`<option${o === cur ? raw(' selected') : ''}>${o}</option>`)}</select>`;
  };
  // pop-up copies of the main fields mirror the table inputs (no name of their own, so nothing is sent twice)
  const mirror = (rn, f) => {
    const cur = values[rn][f.key]; const key = `r_${rn}_${f.key}`;
    if (f.key === 'category' || f.key === 'currency') {
      const options = f.key === 'category' ? CATEGORIES : CURRENCIES;
      const opts = options.includes(cur) || !cur ? options : [cur, ...options];
      return html`<select data-sync="${key}">${f.key === 'category' ? html`<option value=""${cur ? '' : raw(' selected')}>—</option>` : ''}${opts.map((o) => html`<option${o === cur ? raw(' selected') : ''}>${o}</option>`)}</select>`;
    }
    return html`<input data-sync="${key}" value="${cur}">`;
  };
  const extraField = (rn, p, f) => {
    const cur = extra[rn]?.[f.key] !== undefined ? extra[rn][f.key] : strVal(p.row[f.key]);
    const name = `x_${rn}_${f.key}`;
    if (f.type === 'textarea') return html`<textarea name="${name}" rows="3">${cur}</textarea>`;
    if (f.type === 'select') { const opts = (f.options || []).includes(cur) || !cur ? f.options : [cur, ...f.options]; return html`<select name="${name}"><option value=""></option>${opts.map((o) => html`<option${o === cur ? raw(' selected') : ''}>${o}</option>`)}</select>`; }
    return html`<input name="${name}" value="${cur}"${f.type === 'date' ? raw(' placeholder="YYYY-MM-DD"') : ''}>`;
  };
  const dialog = (p) => {
    const rn = p.rowNumber; const imgs = p.images || [];
    const mainFields = EDIT_KEYS.map((k) => PRODUCT_FIELDS.find((f) => f.key === k));
    return html`<dialog class="rv-dialog" id="rv-dlg-${rn}" aria-label="Product details">
      <div class="rv-dlg-head"><h3>${values[rn].product_name || T('Product', '产品')} <span class="muted">· ${T('row', '第')} ${rn}${T('', ' 行')}</span></h3><button type="button" class="btn small ghost" data-rv-close>${T('Done', '完成')}</button></div>
      ${imgs.length ? html`<div class="rv-gallery">${imgs.map((_, i) => html`<a href="${imgUrl(rn, i, 'full')}" target="_blank" rel="noopener"><img src="${imgUrl(rn, i)}" alt="" loading="lazy"></a>`)}</div>` : html`<p class="muted">${T('No picture in the file for this row. Add photos on the product page after importing.', '文件中此行没有图片，导入后可在产品页面添加照片。')}</p>`}
      <div class="rv-dlg-grid">
        ${mainFields.map((f) => html`<label><span class="lbl">${T(f.en, f.cn)}</span>${mirror(rn, f)}</label>`)}
        ${EXTRA_FIELDS.map((f) => html`<label class="${f.type === 'textarea' ? 'span2' : ''}"><span class="lbl">${T(f.en, f.cn)}</span>${extraField(rn, p, f)}</label>`)}
      </div>
      <div class="rv-dlg-foot"><button type="button" class="btn small" data-rv-close>${T('Done', '完成')}</button></div>
    </dialog>`;
  };
  const rows = parsed.products.map((p) => {
    const rn = p.rowNumber; const errs = rowErrors[rn] || []; const on = selected.has(rn);
    const nimg = p.images?.length || 0;
    return html`<tr class="${on ? '' : 'rv-off'} ${errs.length ? 'rv-bad' : ''}">
      <td><input type="checkbox" class="rv-use" name="use_${rn}" value="1"${on ? raw(' checked') : ''} aria-label="Import ${values[rn].product_name}"></td>
      <td class="rv-photo"><button type="button" class="rv-thumb" data-rv-open="rv-dlg-${rn}" title="${T('Open product details', '打开产品详情')}" aria-label="${T('Open product details', '打开产品详情')}">${nimg ? html`<img src="${imgUrl(rn, 0)}" alt="" loading="lazy">${nimg > 1 ? html`<span class="rv-more">+${nimg - 1}</span>` : ''}` : html`<span class="rv-none">${T('No photo', '无图')}</span>`}</button></td>
      <td><input class="rv-name" name="r_${rn}_product_name" data-sync="r_${rn}_product_name" value="${values[rn].product_name}" aria-label="Product name">${flagsFor(p).length ? html`<div class="rv-flags">${flagsFor(p).map((x) => html`<span class="rv-flag">${x}</span>`)}</div>` : ''}</td>
      <td>${select(rn, 'category', CATEGORIES)}</td>
      <td>${num(rn, 'unit_price')}</td><td>${select(rn, 'currency', CURRENCIES)}</td>
      <td>${num(rn, 'moq')}</td><td>${num(rn, 'units_per_carton')}</td>
      <td><div class="rv-dims">${num(rn, 'carton_l_cm', 'sm')}×${num(rn, 'carton_w_cm', 'sm')}×${num(rn, 'carton_h_cm', 'sm')}</div></td>
      <td>${num(rn, 'carton_gw_kg')}</td><td>${num(rn, 'production_lead_days')}</td>
    </tr>${errs.length ? html`<tr class="rv-errrow"><td></td><td colspan="10"><b>${values[rn].product_name}:</b> ${errs.map((e) => html`<div>${biText(e)}</div>`)}</td></tr>` : ''}`;
  });
  const n = selected.size;
  return html`<section class="card import-review" data-import-review>
    <h2>${T('Review before importing', '导入前请核对')}</h2>
    <p>${T(`${parsed.products.length} product${parsed.products.length === 1 ? '' : 's'} found in ${fileName || 'your file'}. Check the main fields, click a picture to see and edit everything about a product, and untick rows you do not want. Nothing is saved until you approve.`, `在 ${fileName || '文件'} 中找到 ${parsed.products.length} 个产品。请核对主要字段，点击图片可查看并编辑产品的全部信息，并取消勾选不需要的行。确认之前不会保存任何内容。`)}</p>
    ${notice ? html`<p class="flash error" role="alert">${biText(notice)}</p>` : ''}
    ${overview}
    ${parsed.errors.length ? html`<div class="rv-problems"><strong>${T('These rows cannot be imported:', '以下行无法导入：')}</strong><ul class="errors">${parsed.errors.map((e) => html`<li>${e.rowNumber ? html`${T('Row', '第')} ${e.rowNumber}${T('', ' 行')}${e.name ? ` (${e.name})` : ''}: ` : ''}${biText(e.messages.join('; '))}</li>`)}</ul></div>` : ''}
    ${parsed.unknownColumns?.length ? html`<p class="muted">${T('Columns not recognised (ignored):', '无法识别的列（已忽略）：')} ${parsed.unknownColumns.join(', ')}</p>` : ''}
    <div class="rv-groupbar"><span class="lbl">${T('Set category for the ticked rows', '为已勾选的行设置类别')}</span>
      <select data-rv-cat aria-label="Category"><option value="">${T('Choose…', '请选择…')}</option>${CATEGORIES.map((c) => html`<option>${c}</option>`)}</select>
      <button type="button" class="btn small" data-rv-cat-apply>${T('Apply', '应用')}</button>
      <button type="button" class="btn small ghost" data-rv-nocat>${T('Tick only rows without a category', '仅勾选未设类别的行')}</button></div>
    <form id="review-form" method="post" action="${action}/confirm" data-review-form>
      <input type="hidden" name="token" value="${token}">
      <div class="table-wrap"><table class="list review-table"><thead><tr>
        <th><input type="checkbox" data-review-all aria-label="Select all"${n === parsed.products.length ? raw(' checked') : ''}></th><th>${T('Photo', '图片')}</th><th>${T('Product', '产品')}</th><th>${T('Category', '类别')}</th><th>${T('Price', '单价')}</th><th>${T('Cur.', '币种')}</th><th>${T('MOQ', '起订量')}</th><th>${T('Pcs / carton', '件/箱')}</th><th>${T('Carton L×W×H cm', '外箱 长×宽×高 cm')}</th><th>${T('Gross kg', '毛重 kg')}</th><th>${T('Prod. days', '交期(天)')}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      ${parsed.products.map(dialog)}
    </form>
    <form id="cancel-form" method="post" action="${action}/cancel"><input type="hidden" name="token" value="${token}"></form>
    <div class="import-actions"><button class="btn" form="review-form" data-approve>${T('Approve & import', '确认并导入')} <span data-count>${n}</span> ${T('products', '个产品')}</button>
      <button class="btn ghost" form="cancel-form">${T('Cancel', '取消')}</button></div>
  </section>`;
}

const expiredResult = () => failed(m('This review expired (files are only kept for 30 minutes). Please upload the file again.', '此次审核已过期（文件仅保留 30 分钟），请重新上传文件。'));

module.exports = { reviewImage, companyMatch, startReview, finishReview, cancelReview, runImport, insertParsed, importResult, expiredResult, readEdits, EDIT_KEYS, _staged: staged };
