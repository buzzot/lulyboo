'use strict';
// Spreadsheet import in two steps: (1) the upload is parsed and shown in a review table with the main fields,
// (2) nothing is saved until the person approves. The uploaded file is held in server memory for a short time
// (not in the database or storage bucket), so an abandoned review leaves nothing behind.
const crypto = require('node:crypto');
const { html, raw, t, m, biText } = require('./lib/html');
const { CATEGORIES, CURRENCIES, PRODUCT_FIELDS, cleanProduct } = require('./fields');
const sharp = require('sharp');
const AI = require('./ai');
const { CONTAINERS } = require('./calc');
const { parseUpload, parseXlsx, parseCsv, decodeText } = require('./importer');
const { attachPictures } = require('./importer');
const { saveProductImages } = require('./images');

const MAX_IMAGES = 10;
const TTL_MS = 30 * 60 * 1000;
const MAX_STAGED_BYTES = 150 * 1024 * 1024;

// Main fields shown (and editable) in the review table.
const EDIT_KEYS = ['product_name', 'category', 'unit_price', 'currency', 'moq', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_gw_kg', 'production_lead_days'];

// Everything else on a product is editable in the pop-up (only changed values are applied).
const EXTRA_FIELDS = PRODUCT_FIELDS.filter((f) => !EDIT_KEYS.includes(f.key));
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
const DOC_MIME = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8', '.xls': 'application/vnd.ms-excel' };
/** Keep the uploaded quotation so it can be opened later. Returns the document row, or null (with a note in `errors`) if it could not be saved. */
async function saveSourceFile(db, supplierId, source, errors) {
  if (!source || !source.buffer || !source.buffer.length) return null;
  const name = String(source.name || 'quotation').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150) || 'quotation';
  const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const id = crypto.randomUUID(); const path = `${supplierId}/${id}${ext}`;
  try {
    await db.docs.upload(path, source.buffer, DOC_MIME[ext] || 'application/octet-stream');
    try {
      return await db.insert('supplier_documents', { id, supplier_id: supplierId, name, mime: DOC_MIME[ext] || null, bytes: source.buffer.length, path, kind: 'quotation' });
    } catch (e) { await db.docs.remove([path]).catch(() => {}); throw e; }
  } catch (e) {
    errors.push({ rowNumber: 0, messages: [m('The original file could not be saved for later (run the latest supabase/schema.sql to enable this). The products were imported.', '无法保存原始文件（请运行最新的 supabase/schema.sql）。产品已导入。')] });
    return null;
  }
}

async function insertParsed(db, parsed, supplierId, source = null) {
  let inserted = 0; let photos = 0;
  const errors = [...parsed.errors];
  const doc = await saveSourceFile(db, supplierId, source, errors);
  const rows = parsed.products.map((p) => ({ ...p.row, supplier_id: supplierId, source: 'import', ...(doc ? { source_document_id: doc.id } : {}) }));
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
  return insertParsed(db, parsed, supplierId, { name: file.name, buffer: file.buffer });
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

// ── AI reading for files that are not in the Lulyboo layout (proforma invoices, price lists, PDFs, photos)
const AI_FILE = /\.(pdf|png|jpe?g|webp)$/i;
const MIME_OF = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function sheetText(rows) {
  const out = []; let size = 0;
  rows.forEach((r, i) => {
    const cells = r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).map((c) => (/^=DISPIMG\(/i.test(c) ? '[picture]' : c.slice(0, 300)));
    if (!cells.some(Boolean)) return;
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    const line = `R${i + 1}: ${cells.join(' | ')}`; size += line.length;
    if (size < 150000 && out.length < 600) out.push(line);
  });
  return out.join('\n');
}
async function aiParse(file, supplierName) {
  const name = String(file.name || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const isXlsx = name.endsWith('.xlsx') || (file.buffer[0] === 0x50 && file.buffer[1] === 0x4b);
  let table = null; let doc = null;
  if (AI_FILE.test(name)) doc = { buffer: file.buffer, mime: MIME_OF[ext] };
  else table = sheetText(isXlsx ? parseXlsx(file.buffer) : parseCsv(decodeText(file.buffer)));
  const r = await AI.extractProducts({ table, file: doc, supplierName, categories: CATEGORIES });
  const products = []; const errors = []; const used = new Set();
  (r.products || []).slice(0, 300).forEach((x, i) => {
    let rn = Number.isInteger(x.source_row) && x.source_row > 0 && table ? x.source_row : 100000 + i;
    if (used.has(rn)) rn = 200000 + i; used.add(rn); // two variants on one line keep separate review rows
    const input = { currency: r.currency, incoterm: r.incoterm, fob_port: r.fob_port, payment_terms: r.payment_terms };
    for (const [k, v] of Object.entries(x)) if (k !== 'source_row' && v !== null && v !== undefined && v !== '') input[k] = v;
    for (const k of Object.keys(input)) if (input[k] === undefined || input[k] === null || input[k] === '') delete input[k];
    if (input.product_size_cm !== undefined) input.product_size_cm = String(input.product_size_cm);
    const { row, errors: errs } = cleanProduct(input);
    if (errs.length) errors.push({ rowNumber: rn, messages: errs, name: input.product_name });
    else products.push({ rowNumber: rn, row });
  });
  const sup = r.supplier || {};
  const header = Object.fromEntries(['company', 'address', 'contact_name', 'phone', 'email', 'website'].filter((k) => sup[k]).map((k) => [k, String(sup[k]).slice(0, 300)]));
  const terms = Object.fromEntries(['incoterm', 'fob_port', 'payment_terms', 'quote_valid_until'].filter((k) => r[k]).map((k) => [k, String(r[k]).slice(0, 200)]));
  const parsed = { products, errors, unknownColumns: [], skipped: (r.skipped || []).length, header, terms, ai: { model: r.model, documentType: r.document_type || '', skippedLines: r.skipped || [] } };
  if (isXlsx && !AI_FILE.test(name)) { try { attachPictures(parsed, file.buffer); } catch { /* pictures are optional */ } }
  return parsed;
}

async function startReview(db, file, supplierId, view, { ai = false } = {}) {
  let parsed = null; let stdError = null;
  const aiFile = AI_FILE.test(String(file.name || ''));
  if (!aiFile && !ai) { try { parsed = parseUpload(file); } catch (e) { stdError = e.message; } }
  // Not the Lulyboo layout (no products found, or most rows failed): let AI read it. Admin only.
  const weak = !parsed || !parsed.products.length || parsed.errors.length > parsed.products.length;
  if (view.admin && (ai || aiFile || weak)) {
    if (!AI.enabled()) { if (aiFile || ai || !parsed) return { result: failed('This file is not in the Lulyboo layout and AI reading is not enabled (set ANTHROPIC_API_KEY).') }; }
    else {
      try {
        const supplier0 = await db.get('suppliers', supplierId);
        const viaAi = await aiParse(file, supplier0?.name || '');
        if (viaAi.products.length || !parsed) parsed = viaAi;
      } catch (e) { if (!parsed) return { result: failed(`AI could not read this file: ${String(e.message).slice(0, 200)}`) }; }
    }
  }
  if (!parsed) return { result: failed(stdError || 'Could not read this file') };
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
  const result = await insertParsed(db, { ...parsed, products: chosen }, supplierId, { name: entry.name, buffer: entry.buffer });
  staged.delete(stageKey(supplierId, token));
  return { done: result };
}

/** Optional AI clean-up of one row's description (and specs found in it / on its picture). Only for a staged upload that belongs to this supplier. */
async function aiDescribe(supplierId, fields) {
  const token = String(fields.token || '');
  const entry = validToken(token) ? staged.get(stageKey(supplierId, token)) : null;
  if (!entry || Date.now() - entry.at > TTL_MS) return { status: 410, body: { ok: false, error: 'This review expired. Upload the file again.' } };
  if (!AI.enabled()) return { status: 503, body: { ok: false, error: 'AI is not enabled (ANTHROPIC_API_KEY is not set).' } };
  const text = String(fields.text || '').trim();
  if (!text) return { status: 400, body: { ok: false, error: 'There is no description to clean up.' } };
  let image = null;
  try { const im = await reviewImage(supplierId, token, fields.row, 0, 'full'); if (im) image = im.buffer; } catch { /* picture is optional */ }
  try {
    const known = { name: String(fields.name || '').slice(0, 200), materials: String(fields.materials || '').slice(0, 200), size: String(fields.size || '').slice(0, 100) };
    return { status: 200, body: { ok: true, ...(await AI.cleanDescription({ text, fields: known, image })) } };
  } catch (e) {
    return { status: 502, body: { ok: false, error: /401|authentication/i.test(e.message) ? 'The AI key was rejected. Check ANTHROPIC_API_KEY in Railway.' : 'AI could not process this description right now.' } };
  }
}

/** The uploaded file, while it is still waiting for approval. */
function stagedSource(supplierId, token) {
  const entry = validToken(token) ? staged.get(stageKey(supplierId, token)) : null;
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  const ext = (String(entry.name).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  return { name: entry.name, buffer: entry.buffer, type: DOC_MIME[ext] || 'application/octet-stream' };
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
  const none = html`<span class="rv-na">${T('Not in file', '文件中未找到')}</span>`;
  const cm = companyMatch(hd.company, supplierName);
  // "+86 183…/183…" lists the same number twice: split on / , ; and drop repeats
  const seenPh = new Set();
  const phones = String(hd.phone || '').split(/\s*[\/,;，；]\s*/).map((x) => x.trim()).filter((x) => { const k = x.replace(/\D/g, '').slice(-9) || x; if (!x || seenPh.has(k)) return false; seenPh.add(k); return true; });
  const link = (v, href) => (v ? html`<a href="${href}" target="_blank" rel="noopener">${v}</a>` : none);
  const web = hd.website ? (/^https?:\/\//i.test(hd.website) ? hd.website : `https://${hd.website}`) : '';
  const field = (label, body, cls = '') => html`<div class="rv-f ${cls}"><dt>${label}</dt><dd>${body}</dd></div>`;
  const val = (v) => (v ? String(v) : none);
  const badge = cm === 'match' ? html`<span class="rv-badge ok">✓ ${T('Matches', '一致')} “${supplierName}”</span>`
    : cm === 'mismatch' ? html`<span class="rv-badge bad">⚠ ${T('Does not match', '不一致')} “${supplierName}”</span>`
    : html`<span class="rv-badge">${T('Not checked', '未核对')}</span>`;
  const overview = html`<div class="rv-overview">
    <div class="rv-ov-head"><h3>${T('File header', '文件抬头')}</h3>${badge}</div>
    <div class="rv-ov-cols">
      <section class="rv-ov-col">
        <h4>${T('Supplier', '供应商')}</h4>
        <dl>
          ${field(T('Company name', '公司名称'), hd.company ? html`<span class="rv-company">${hd.company}</span>` : none, 'full')}
          ${field(T('Address', '地址'), val(hd.address), 'full')}
          ${field(T('Contact person', '联系人'), val(hd.contact_name))}
          ${field(T('Phone', '电话'), phones.length ? html`${phones.map((x, i) => html`${i ? html`<br>` : ''}${x}`)}` : none)}
          ${field(T('Email', '邮箱'), link(hd.email, `mailto:${hd.email}`))}
          ${field(T('Website', '网站'), link(hd.website, web))}
        </dl>
      </section>
      <section class="rv-ov-col">
        <h4>${T('Commercial terms', '商务条款')}</h4>
        <dl>
          ${field(T('Incoterm', '贸易术语'), val(tm.incoterm))}
          ${field(T('Port', '港口'), val(tm.fob_port ?? first.fob_port))}
          ${field(T('Payment terms', '付款条款'), val(tm.payment_terms ?? first.payment_terms), 'full')}
          ${field(T('Validity', '报价有效期'), validUntil ? html`${validUntil}${validUntil < today ? html` <span class="rv-flag">${T('expired', '已过期')}</span>` : ''}` : none)}
        </dl>
      </section>
    </div>
    ${cm === 'mismatch' ? html`<p class="rv-alert" role="alert"><b>${T('Company does not match.', '公司名称不一致。')}</b> ${admin ? T(`The file says “${hd.company}”, but you are importing for “${supplierName}”. Check that you chose the right supplier before approving.`, '') : T(`The file says “${hd.company}”, but your account is “${supplierName}”.`, `文件中的公司为“${hd.company}”，与您的账户“${supplierName}”不一致。`)}</p>` : ''}
    ${cm === 'unknown' && !hd.company ? html`<p class="rv-note">${T(`No company name was found in the file, so it could not be checked against “${supplierName}”.`, `文件中未找到公司名称，无法与“${supplierName}”核对。`)}</p>` : ''}
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
  // ── Pop-up (12-column grid). Units sit inside the field; where a unit is selectable the value is
  // converted on screen and the stored value stays in cm / kg / days.
  const UNITS = {
    len: { list: ['cm', 'in', 'mm'], f: { cm: 1, in: 0.393701, mm: 10 } },
    wt: { list: ['kg', 'lb', 'g'], f: { kg: 1, lb: 2.204623, g: 1000 } },
    time: { list: ['days', 'weeks'], f: { days: 1, weeks: 1 / 7 } },
  };
  const FILE_LEVEL = ['incoterm', 'fob_port', 'payment_terms', 'quote_valid_until']; // shown in the file header already
  const fileLevel = FILE_LEVEL.filter((k) => tm[k] !== undefined);
  const LABEL = {
    unit_price: ['Unit price', '单价'], moq: ['MOQ', '起订量'], production_lead_days: ['Production lead time', '生产交期'], sample_lead_days: ['Sample lead time', '样品交期'],
    units_per_inner: ['Units per inner pack', '内盒装数'], units_per_carton: ['Units per carton', '外箱装数'], carton_nw_kg: ['Net weight', '净重'], carton_gw_kg: ['Gross weight', '毛重'],
    unit_net_weight_kg: ['Unit net weight', '单件净重'], supplier_qty_20gp: ['Qty per 20GP', '20GP 装柜数量'], supplier_qty_40gp: ['Qty per 40GP', '40GP 装柜数量'], supplier_qty_40hq: ['Qty per 40HQ', '40HQ 装柜数量'],
    product_size_cm: ['Product size L×W×H (cm)', '产品尺寸 长×宽×高（cm）'], photo_link: ['Photo / catalog link', '图片 / 目录链接'],
  };
  const SUBS = {
    product: [[['product_name'], 6], [['supplier_sku'], 3], [['category'], 3], [['subcategory'], 3], [['materials'], 6], [['brand'], 3]],
    price: [[['unit_price'], 3, 'price'], [['moq'], 3, 'pcs'], [['production_lead_days'], 3, 'time'], [['sample_lead_days'], 3, 'time'], [['incoterm'], 3], [['fob_port'], 3], [['quote_valid_until'], 3], [['payment_terms'], 12]],
    inner: [[['units_per_inner'], 3, 'pcs']],
    carton: [[['units_per_carton'], 3, 'pcs'], [['carton_l_cm', 'carton_w_cm', 'carton_h_cm'], 5, 'len', ['Carton size L × W × H', '外箱尺寸 长×宽×高']], [['carton_nw_kg'], 2, 'wt'], [['carton_gw_kg'], 2, 'wt']],
    container: [[['supplier_qty_20gp', 'supplier_qty_40gp', 'supplier_qty_40hq'], 6, 'pcs', ['Supplier qty per container 20GP / 40GP / 40HQ', '供应商提供的每柜数量 20GP / 40GP / 40HQ']]],
    physical: [[['product_size_cm'], 6], [['unit_net_weight_kg'], 3, 'wt'], [['packaging_type'], 3]],
    compliance: [[['hs_code'], 3], [['country_of_origin'], 3], [['certifications'], 6], [['dangerous_goods'], 12]],
    more: [[['factory_notes'], 12], [['photo_link'], 12]],
  };
  const placedKeys = new Set(Object.values(SUBS).flatMap((l) => l.flatMap(([ks]) => ks)).concat(['description', 'currency']));
  const leftovers = [...EDIT_KEYS, ...EXTRA_FIELDS.map((f) => f.key)].filter((k) => !placedKeys.has(k));
  const fieldOf = (k) => PRODUCT_FIELDS.find((x) => x.key === k);
  const labelOf = (k) => { const f = fieldOf(k); return LABEL[k] ? T(LABEL[k][0], LABEL[k][1]) : T(f.en, f.cn); };
  const aiOn = AI.enabled();
  const total = parsed.products.length;

  const dialog = (p, idx) => {
    const rn = p.rowNumber; const imgs = p.images || [];
    const prev = parsed.products[idx - 1]; const next = parsed.products[idx + 1];
    const curVal = (k) => (EDIT_KEYS.includes(k) ? values[rn][k] : (extra[rn]?.[k] !== undefined ? extra[rn][k] : strVal(p.row[k])));
    // The value that is submitted: the table input for the main fields, a hidden input for the others.
    const canon = (k) => (EDIT_KEYS.includes(k) ? { sel: `input[data-sync="r_${rn}_${k}"]`, hidden: '' } : { sel: `input[name="x_${rn}_${k}"]`, hidden: html`<input type="hidden" name="x_${rn}_${k}" value="${curVal(k)}">` });
    const control = (k) => { const f = fieldOf(k); return EDIT_KEYS.includes(k) ? mirror(rn, f) : extraField(rn, p, f); };
    const entry = ([keys, span, unit, label]) => {
      if (keys.some((k) => FILE_LEVEL.includes(k) && fileLevel.includes(k))) return '';
      if (keys.some((k) => !fieldOf(k))) return '';
      const lab = label ? T(label[0], label[1]) : labelOf(keys[0]);
      let inner;
      if (unit === 'price') inner = html`<div class="rv-unit">${mirror(rn, fieldOf('unit_price'))}${mirror(rn, fieldOf('currency'))}</div>`;
      else if (unit === 'pcs' && keys.length > 1) inner = html`<div class="rv-unit">${keys.map((k, i) => html`${i ? html`<span class="rv-x">/</span>` : ''}<input name="x_${rn}_${k}" value="${curVal(k)}" placeholder="${k.replace(/^supplier_qty_/, '').toUpperCase()}" inputmode="numeric" aria-label="${labelOf(k)}">`)}<span class="rv-u">${T('pcs', '件')}</span></div>`;
      else if (unit === 'pcs') inner = html`<div class="rv-unit">${control(keys[0])}<span class="rv-u">${T('pcs', '件')}</span></div>`;
      else if (UNITS[unit]) {
        const U = UNITS[unit]; const cs = keys.map(canon);
        inner = html`<div class="rv-unit" data-unit-group data-unit="${U.list[0]}" data-factors="${JSON.stringify(U.f)}" data-canon="${cs.map((c) => c.sel).join('|')}">
          ${keys.map((k, i) => html`${i ? html`<span class="rv-x">×</span>` : ''}<input class="rv-disp" inputmode="decimal" value="${curVal(k)}" aria-label="${labelOf(k)}">`)}
          ${cs.map((c) => c.hidden)}
          <select class="rv-u-sel" aria-label="Unit">${U.list.map((u) => html`<option${u === U.list[0] ? raw(' selected') : ''}>${u}</option>`)}</select></div>`;
      } else inner = control(keys[0]);
      return html`<label class="c${span}"><span class="lbl">${lab}</span>${inner}</label>`;
    };
    const grid = (key, extraKeys) => html`<div class="rv-grid">${(SUBS[key] || []).map(entry)}${(extraKeys || []).map((k) => entry([[k], 6]))}</div>`;
    const sec = (title, body, opts = {}) => html`<fieldset class="rv-sec ${opts.cls || ''}"><legend>${title}${opts.badge ? html` <span class="rv-sec-badge" data-calc-badge hidden></span>` : ''}</legend>${body}</fieldset>`;
    const sub = (title, body) => html`<div class="rv-sub"><h5>${title}</h5>${body}</div>`;
    const descVal = curVal('description');
    const doc = [];
    if (fileName) doc.push(html`<li><span class="rv-doc-ic">▤</span><a class="rv-doc-name" href="${action}/source?token=${token}" title="${T('Download', '下载')} ${fileName}" download>${fileName}</a><span class="rv-doc-tag">${T('Source file · will be saved with the import', '源文件 · 导入时一并保存')}</span></li>`);
    if (imgs.length) doc.push(html`<li><span class="rv-doc-ic">▣</span><span class="rv-doc-name">${imgs.length} ${T(imgs.length === 1 ? 'picture' : 'pictures', '张图片')}</span><span class="rv-doc-tag">${T('From file', '来自文件')}</span></li>`);
    if (p.row.photo_link) doc.push(html`<li><span class="rv-doc-ic">↗</span><a class="rv-doc-name" href="${p.row.photo_link}" target="_blank" rel="noopener">${p.row.photo_link}</a><span class="rv-doc-tag">${T('Link', '链接')}</span></li>`);
    return html`<dialog class="rv-dialog" id="rv-dlg-${rn}" data-rn="${rn}" aria-label="Product details">
      <header class="rv-dlg-head">
        <div class="rv-dlg-title"><h3 data-rv-title>${values[rn].product_name || T('Product', '产品')}</h3>
          <div class="rv-dlg-meta"><span class="rv-chip" data-rv-sku-chip${curVal('supplier_sku') ? '' : raw(' hidden')}>${T('SKU', '货号')} <b data-rv-sku>${curVal('supplier_sku')}</b></span><span class="rv-chip">${T('Row', '第')} <b>${idx + 1}</b> / ${total}</span></div></div>
        <div class="rv-dlg-nav">
          <button type="button" class="btn small ghost rv-navbtn" data-rv-nav="${prev ? `rv-dlg-${prev.rowNumber}` : ''}" ${prev ? '' : raw('disabled')} aria-label="${T('Previous product', '上一个')}" title="${T('Previous product', '上一个')}">‹</button>
          <button type="button" class="btn small ghost rv-navbtn" data-rv-nav="${next ? `rv-dlg-${next.rowNumber}` : ''}" ${next ? '' : raw('disabled')} aria-label="${T('Next product', '下一个')}" title="${T('Next product', '下一个')}">›</button>
          <button type="button" class="btn" data-rv-close>${T('Done', '完成')}</button></div>
      </header>
      <div class="rv-dlg-body">
        <aside class="rv-dlg-media">
          ${imgs.length ? html`<a class="rv-hero" data-rv-hero href="${imgUrl(rn, 0, 'full')}" target="_blank" rel="noopener" title="${T('Open full size', '查看大图')}"><img src="${imgUrl(rn, 0, 'full')}" alt="" loading="lazy"></a>
            ${imgs.length > 1 ? html`<div class="rv-strip">${imgs.map((_, i) => html`<button type="button" class="${i ? '' : 'on'}" data-rv-pic="${imgUrl(rn, i, 'full')}" aria-label="${T('Picture', '图片')} ${i + 1}"><img src="${imgUrl(rn, i)}" alt="" loading="lazy"></button>`)}</div>` : ''}`
            : html`<div class="rv-hero empty">${T('No picture in the file for this row. Add photos on the product page after importing.', '文件中此行没有图片，导入后可在产品页面添加照片。')}</div>`}
          ${doc.length ? html`<h5 class="rv-side-h">${T('Documents', '文档')}</h5><ul class="rv-docs">${doc}</ul>` : ''}
        </aside>
        <div class="rv-dlg-form">
          ${sec(T('Product', '产品'), html`${grid('product')}
            <div class="rv-desc">
              <div class="rv-desc-head"><span class="lbl">${T('Description', '产品描述')}</span>
                <span class="rv-desc-tools"><button type="button" class="rv-linkbtn" data-rv-expand>${T('Expand', '展开')}</button>
                  <button type="button" class="rv-linkbtn rv-ai" data-rv-ai data-rn="${rn}" ${aiOn ? '' : raw('disabled title="AI is not enabled (add ANTHROPIC_API_KEY)"')}>✦ ${T('Clean up with AI', 'AI 整理')}</button></span></div>
              <textarea name="x_${rn}_description" data-autosize rows="3">${descVal}</textarea>
              <div class="rv-ai-out" data-rv-ai-out hidden></div>
            </div>`)}
          ${sec(T('Price & terms', '价格与条款'), html`${fileLevel.length ? html`<p class="rv-hint">${T('Incoterm, port, payment terms and validity are set once in the file header and apply to every product.', '贸易术语、港口、付款条款和有效期在文件抬头统一设置，适用于所有产品。')}</p>` : ''}${grid('price')}`)}
          ${sec(T('Packing & container', '包装与装柜'), html`
            ${sub(T('Inner packing', '内包装'), grid('inner'))}
            ${sub(T('Master carton', '外箱'), grid('carton'))}
            ${sub(T('Container loading', '装柜'), html`${grid('container')}
              <div class="rv-calc" data-calc data-rn="${rn}"></div>`)}`, { badge: true, cls: 'rv-sec-pack' })}
          ${sec(T('Physical specifications', '物理规格'), grid('physical'))}
          ${sec(T('Compliance', '合规信息'), grid('compliance'))}
          <details class="rv-sec rv-more"><summary>${T('More details (optional)', '更多信息（选填）')}</summary>${grid('more', leftovers)}</details>
        </div>
      </div>
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
  return html`<section class="card import-review" data-import-review data-action="${action}" data-containers="${JSON.stringify(CONTAINERS)}">
    <h2>${T('Review before importing', '导入前请核对')}</h2>
    <p>${T(`${parsed.products.length} product${parsed.products.length === 1 ? '' : 's'} found in ${fileName || 'your file'}. Check the main fields, click a picture to see and edit everything about a product, and untick rows you do not want. Nothing is saved until you approve.`, `在 ${fileName || '文件'} 中找到 ${parsed.products.length} 个产品。请核对主要字段，点击图片可查看并编辑产品的全部信息，并取消勾选不需要的行。确认之前不会保存任何内容。`)}</p>
    ${notice ? html`<p class="flash error" role="alert">${biText(notice)}</p>` : ''}
    ${parsed.ai ? html`<div class="flash ok ai-read"><b>✦ Read by AI${parsed.ai.documentType ? ` from a ${parsed.ai.documentType}` : ''}.</b> This file is not in the Lulyboo layout, so AI found ${parsed.products.length} product${parsed.products.length === 1 ? '' : 's'}${parsed.ai.skippedLines.length ? ` and left out: ${parsed.ai.skippedLines.slice(0, 4).join('; ')}` : ''}. Check names, prices and cartons before approving.</div>` : ''}
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
      ${parsed.products.map((p, i) => dialog(p, i))}
    </form>
    <form id="cancel-form" method="post" action="${action}/cancel"><input type="hidden" name="token" value="${token}"></form>
    <div class="import-actions"><button class="btn" form="review-form" data-approve>${T('Approve & import', '确认并导入')} <span data-count>${n}</span> ${T('products', '个产品')}</button>
      <button class="btn ghost" form="cancel-form">${T('Cancel', '取消')}</button></div>
  </section>`;
}

const expiredResult = () => failed(m('This review expired (files are only kept for 30 minutes). Please upload the file again.', '此次审核已过期（文件仅保留 30 分钟），请重新上传文件。'));

module.exports = { stagedSource, aiDescribe, reviewImage, companyMatch, startReview, finishReview, cancelReview, runImport, insertParsed, importResult, expiredResult, readEdits, EDIT_KEYS, _staged: staged };
