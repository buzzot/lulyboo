'use strict';
// Spreadsheet import in two steps: (1) the upload is parsed and shown in a review table with the main fields,
// (2) nothing is saved until the person approves. The uploaded file is held in server memory for a short time
// (not in the database or storage bucket), so an abandoned review leaves nothing behind.
const crypto = require('node:crypto');
const { html, raw, t, m, biText } = require('./lib/html');
const { CATEGORIES, CURRENCIES, cleanProduct } = require('./fields');
const { parseUpload } = require('./importer');
const { saveProductImages } = require('./images');

const MAX_IMAGES = 10;
const TTL_MS = 30 * 60 * 1000;
const MAX_STAGED_BYTES = 150 * 1024 * 1024;

// Main fields shown (and editable) in the review table.
const EDIT_KEYS = ['product_name', 'category', 'unit_price', 'currency', 'moq', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_gw_kg', 'production_lead_days'];

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
  staged.set(stageKey(supplierId, token), { buffer: file.buffer, name: file.name || 'upload', at: Date.now() });
  const values = {}; const selected = new Set();
  const dup = await duplicateRows(db, supplierId, parsed);
  for (const p of parsed.products) {
    values[p.rowNumber] = Object.fromEntries(EDIT_KEYS.map((k) => [k, p.row[k] === null || p.row[k] === undefined ? '' : String(p.row[k])]));
    if (!dup.has(p.rowNumber)) selected.add(p.rowNumber); // possible duplicates start unticked
  }
  return { page: reviewPage({ ...view, token, fileName: file.name, parsed, values, selected, rowErrors: {}, dup }) };
}

async function duplicateRows(db, supplierId, parsed) {
  const existing = await db.list('products', { filters: { supplier_id: supplierId }, select: 'product_name' });
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
  try { parsed = parseUpload({ name: entry.name, buffer: entry.buffer }); } catch (e) { return { done: failed(e.message) }; }

  const values = {}; const selected = new Set(); const rowErrors = {}; const chosen = [];
  const dup = await duplicateRows(db, supplierId, parsed);
  for (const p of parsed.products) {
    const rn = p.rowNumber;
    values[rn] = Object.fromEntries(EDIT_KEYS.map((k) => {
      const f = fields[`r_${rn}_${k}`];
      return [k, f === undefined ? (p.row[k] === null || p.row[k] === undefined ? '' : String(p.row[k])) : String(f)];
    }));
    if (!fields[`use_${rn}`]) continue;
    selected.add(rn);
    const { patch, errors } = readEdits(values[rn]);
    if (errors.length) { rowErrors[rn] = errors; continue; }
    chosen.push({ ...p, row: { ...p.row, ...patch } });
  }
  if (!selected.size) return { page: reviewPage({ ...view, token, fileName: entry.name, parsed, values, selected, rowErrors, dup, notice: m('Tick at least one product to import.', '请至少勾选一个要导入的产品。') }) };
  if (Object.keys(rowErrors).length) return { page: reviewPage({ ...view, token, fileName: entry.name, parsed, values, selected, rowErrors, dup, notice: m('Fix the highlighted rows, then approve again.', '请先修正标红的行，然后再次确认导入。') }) };
  const result = await insertParsed(db, { ...parsed, products: chosen }, supplierId);
  staged.delete(stageKey(supplierId, token));
  return { done: result };
}

function cancelReview(supplierId, token) { if (validToken(token)) staged.delete(stageKey(supplierId, token)); }

/** Validate the edited main fields (strings from the form) into clean column values. */
function readEdits(v) {
  const errors = [];
  const name = String(v.product_name || '').trim();
  if (!name) errors.push(m('Product name is required', '请填写产品名称'));
  const category = String(v.category || '').trim();
  if (category && !CATEGORIES.includes(category)) errors.push(m(`Category must be one of: ${CATEGORIES.join(', ')}`, `类别须为：${CATEGORIES.join('、')}`));
  const currency = String(v.currency || '').trim().toUpperCase();
  if (currency && !CURRENCIES.includes(currency)) errors.push(m(`Currency must be one of: ${CURRENCIES.join(', ')}`, `币种须为：${CURRENCIES.join('、')}`));
  const numeric = {};
  for (const k of EDIT_KEYS) if (!['product_name', 'category', 'currency'].includes(k)) numeric[k] = v[k];
  const { row, errors: numErrors } = cleanProduct({ ...numeric }, { partial: true });
  errors.push(...numErrors);
  return { patch: { ...row, product_name: name.slice(0, 500), category: category || null, currency: currency || 'USD' }, errors };
}

// ── The review form ────────────────────────────────────────────
function reviewPage({ admin, action, token, fileName, parsed, values, selected, rowErrors, dup, notice }) {
  const T = (en, zh) => (admin ? en : t(en, zh));
  const first = parsed.products[0]?.row || {};
  const terms = [['Incoterm', '贸易术语', first.incoterm], ['Port', '港口', first.fob_port], ['Payment', '付款', first.payment_terms], ['Quote valid until', '报价有效期至', first.quote_valid_until]].filter((x) => x[2]);
  const flagsFor = (p) => {
    const f = [];
    if (dup.has(p.rowNumber)) f.push(T('Already in the list', '列表中已有'));
    if (!p.row.unit_price) f.push(T('No price', '缺少单价'));
    if (!p.row.units_per_carton || !p.row.carton_l_cm || !p.row.carton_w_cm || !p.row.carton_h_cm || !p.row.carton_gw_kg) f.push(T('Carton info missing', '外箱信息不全'));
    return f;
  };
  const num = (rn, k, w) => html`<input class="rv-num ${w || ''}" name="r_${rn}_${k}" value="${values[rn][k]}" inputmode="decimal" aria-label="${k}">`;
  const select = (rn, k, options) => {
    const cur = values[rn][k];
    const opts = options.includes(cur) || !cur ? options : [cur, ...options];
    return html`<select class="rv-sel" name="r_${rn}_${k}" aria-label="${k}">${k === 'category' ? html`<option value=""${cur ? '' : raw(' selected')}>—</option>` : ''}${opts.map((o) => html`<option${o === cur ? raw(' selected') : ''}>${o}</option>`)}</select>`;
  };
  const rows = parsed.products.map((p) => {
    const rn = p.rowNumber; const errs = rowErrors[rn] || []; const on = selected.has(rn);
    return html`<tr class="${on ? '' : 'rv-off'} ${errs.length ? 'rv-bad' : ''}">
      <td><input type="checkbox" class="rv-use" name="use_${rn}" value="1"${on ? raw(' checked') : ''} aria-label="Import row ${rn}"></td>
      <td class="muted">${rn}</td>
      <td><input class="rv-name" name="r_${rn}_product_name" value="${values[rn].product_name}" aria-label="Product name">${flagsFor(p).length ? html`<div class="rv-flags">${flagsFor(p).map((x) => html`<span class="rv-flag">${x}</span>`)}</div>` : ''}</td>
      <td>${select(rn, 'category', CATEGORIES)}</td>
      <td>${num(rn, 'unit_price')}</td><td>${select(rn, 'currency', CURRENCIES)}</td>
      <td>${num(rn, 'moq')}</td><td>${num(rn, 'units_per_carton')}</td>
      <td><div class="rv-dims">${num(rn, 'carton_l_cm', 'sm')}×${num(rn, 'carton_w_cm', 'sm')}×${num(rn, 'carton_h_cm', 'sm')}</div></td>
      <td>${num(rn, 'carton_gw_kg')}</td><td>${num(rn, 'production_lead_days')}</td>
      <td class="rv-photos">${p.images?.length ? `📷 ${p.images.length}` : '—'}</td>
    </tr>${errs.length ? html`<tr class="rv-errrow"><td></td><td colspan="11">${errs.map((e) => html`<div>${biText(e)}</div>`)}</td></tr>` : ''}`;
  });
  const n = selected.size;
  return html`<section class="card import-review" data-import-review>
    <h2>${T('Review before importing', '导入前请核对')}</h2>
    <p>${T(`${parsed.products.length} product${parsed.products.length === 1 ? '' : 's'} found in ${fileName || 'your file'}. Check the main fields, fix anything that looks wrong and untick rows you do not want. Nothing is saved until you approve.`, `在 ${fileName || '文件'} 中找到 ${parsed.products.length} 个产品。请核对主要字段，修改有误的内容，并取消勾选不需要的行。确认之前不会保存任何内容。`)}</p>
    ${notice ? html`<p class="flash error" role="alert">${biText(notice)}</p>` : ''}
    ${terms.length ? html`<p class="rv-terms">${T('Terms read from the file (applied to every product):', '从文件读取的条款（适用于所有产品）：')} ${terms.map(([en, zh, v], i) => html`${i ? ' · ' : ''}<span class="muted">${T(en, zh)}</span> <b>${String(v)}</b>`)}</p>` : ''}
    ${parsed.errors.length ? html`<div class="rv-problems"><strong>${T('These rows cannot be imported:', '以下行无法导入：')}</strong><ul class="errors">${parsed.errors.map((e) => html`<li>${e.rowNumber ? html`${T('Row', '第')} ${e.rowNumber}${T('', ' 行')}${e.name ? ` (${e.name})` : ''}: ` : ''}${biText(e.messages.join('; '))}</li>`)}</ul></div>` : ''}
    ${parsed.unknownColumns?.length ? html`<p class="muted">${T('Columns not recognised (ignored):', '无法识别的列（已忽略）：')} ${parsed.unknownColumns.join(', ')}</p>` : ''}
    <form id="review-form" method="post" action="${action}/confirm" data-review-form>
      <input type="hidden" name="token" value="${token}">
      <div class="table-wrap"><table class="list review-table"><thead><tr>
        <th><input type="checkbox" data-review-all aria-label="Select all"${n === parsed.products.length ? raw(' checked') : ''}></th><th>${T('Row', '行')}</th><th>${T('Product', '产品')}</th><th>${T('Category', '类别')}</th><th>${T('Price', '单价')}</th><th>${T('Cur.', '币种')}</th><th>${T('MOQ', '起订量')}</th><th>${T('Pcs / carton', '件/箱')}</th><th>${T('Carton L×W×H cm', '外箱 长×宽×高 cm')}</th><th>${T('Gross kg', '毛重 kg')}</th><th>${T('Prod. days', '交期(天)')}</th><th>${T('Photos', '照片')}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </form>
    <form id="cancel-form" method="post" action="${action}/cancel"><input type="hidden" name="token" value="${token}"></form>
    <div class="import-actions"><button class="btn" form="review-form" data-approve>${T('Approve & import', '确认并导入')} <span data-count>${n}</span> ${T('products', '个产品')}</button>
      <button class="btn ghost" form="cancel-form">${T('Cancel', '取消')}</button></div>
  </section>`;
}

const expiredResult = () => failed(m('This review expired (files are only kept for 30 minutes). Please upload the file again.', '此次审核已过期（文件仅保留 30 分钟），请重新上传文件。'));

module.exports = { startReview, finishReview, cancelReview, runImport, insertParsed, importResult, expiredResult, readEdits, EDIT_KEYS, _staged: staged };
