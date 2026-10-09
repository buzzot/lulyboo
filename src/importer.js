'use strict';
const m = (en, zh) => `⟪${en}⟫⟦${zh}⟧`; // bilingual message (see lib/html.js)
// Bulk import: CSV or XLSX in the Lulyboo template layout → clean product rows.
// No external libraries: a small RFC-4180 CSV parser and a minimal XLSX (zip + XML) reader.

const zlib = require('node:zlib');
const { PRODUCT_FIELDS, IGNORED_TEMPLATE_COLUMNS, cleanProduct } = require('./fields');

const MAX_ROWS = 2000;

// ── CSV ───────────────────────────────────────────────────────
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const delim = sniffDelimiter(text);
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows; // keep blank rows so reported row numbers match the file
}
function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const c of first) { if (c === '"') q = !q; else if (!q && c in counts) counts[c]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Decode bytes: UTF-8 (with/without BOM) or UTF-16LE (Excel "Unicode Text"); fall back to GB18030 for Chinese Excel CSVs.
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not utf-8 */ }
  try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('latin1'); }
}

// ── XLSX ──────────────────────────────────────────────────────
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(m('Not a valid .xlsx file', '不是有效的 .xlsx 文件'));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(m('The .xlsx file is damaged', '.xlsx 文件已损坏'));
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    if (method === 0) files[name] = data.toString('utf8');
    else if (method === 8) {
      const out = zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
      files[name] = out.toString('utf8');
    }
  }
  return files;
}
const xmlDecode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e]) return map[e];
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');
function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Read the first worksheet (or the one named "Products") into a 2-D array. */
function parseXlsx(buf) {
  const files = unzip(buf);
  const wb = files['xl/workbook.xml'];
  if (!wb) throw new Error(m('Not a valid .xlsx file', '不是有效的 .xlsx 文件'));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)].map((m) => ({ name: xmlDecode(m[1]), rid: m[2] }));
  const target = sheets.find((s) => /^products?$/i.test(s.name)) || sheets[0];
  const rels = files['xl/_rels/workbook.xml.rels'] || '';
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${target.rid}"`));
  let sheetPath = rel ? rel.match(/Target="([^"]+)"/)[1] : 'worksheets/sheet1.xml';
  sheetPath = sheetPath.replace(/^\/?(xl\/)?/, 'xl/');
  const xml = files[sheetPath];
  if (!xml) throw new Error(m('No worksheet found in the .xlsx file', '.xlsx 文件中没有工作表'));
  const shared = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml'].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const inner = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str' || t === 'e') val = v !== undefined ? xmlDecode(v) : '';
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = Number(v);
      const idx = ref ? colIndex(ref) : row.length;
      row[idx] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    const rn = Number((rm[0].match(/<row\b[^>]*\br="(\d+)"/) || [])[1]) || rows.length + 1;
    while (rows.length < rn - 1) rows.push([]); // keep spreadsheet row numbers
    rows.push(row);
  }
  return rows;
}

// ── Mapping ───────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_()（）/\\.,:：×*·\-]+/g, '');

function buildHeaderMap() {
  const map = new Map();
  for (const f of PRODUCT_FIELDS) {
    for (const label of [f.csv, f.en, f.cn, f.key]) if (label) map.set(norm(label), f.key);
  }
  // Common alternates from factory quotation sheets
  const alt = {
    'itemno': 'supplier_sku', 'sku': 'supplier_sku', 'itemnosku': 'supplier_sku', '货号': 'supplier_sku',
    'unitpriceusd': 'unit_price', 'price': 'unit_price', 'fobprice': 'unit_price', '单价usd': 'unit_price',
    'material': 'materials', 'productsizecm': 'product_size_cm', 'packingpcsctn': 'units_per_carton', 'pcsctn': 'units_per_carton',
    'cartonsizel': 'carton_l_cm', 'productionleadtimedays': 'production_lead_days', 'qtyper40hqpcs': 'supplier_qty_40hq',
    'casepack': 'units_per_carton', 'moq': 'moq', 'description': 'description', 'factorynotes': 'factory_notes',
    // Lulyboo Factory Quotation Request form (EN / 中文 sheets)
    'productsize': 'product_size_cm', 'packing': 'units_per_carton', 'hscode': 'hs_code', 'qtyper40hq': 'supplier_qty_40hq',
    '货号sku': 'supplier_sku', '产品尺寸cm': 'product_size_cm', '产品描述': 'description', '材质': 'materials', '生产交期天': 'production_lead_days',
    '包装方式': 'packaging_type', '装箱数件箱': 'units_per_carton', 'hs编码': 'hs_code', '40hq装柜数量件': 'supplier_qty_40hq', '工厂备注': 'factory_notes',
    // composite columns, split below
    'nwgwkg': '_nw_gw', 'nwgw': '_nw_gw', '净重毛重kg': '_nw_gw',
    'cartonsizelwhcm': '_carton_size', 'cartonsizecm': '_carton_size', 'cartonsize': '_carton_size', '外箱尺寸长宽高cm': '_carton_size',
    // quotation-level terms (label cells above the product table)
    'currency': 'currency', '币种': 'currency', 'incoterm': 'incoterm', '贸易术语': 'incoterm',
    'fobportdeliverypoint': 'fob_port', 'fob港口交货地点': 'fob_port', 'paymentterms': 'payment_terms', '付款条款': 'payment_terms',
    '最小起订量moq': 'moq', 'sampleleadtime': 'sample_lead_days', '样品交期': 'sample_lead_days',
    'productionleadtime': 'production_lead_days', '生产交期': 'production_lead_days',
    'quotationvaliduntil': 'quote_valid_until', '报价有效期至': 'quote_valid_until',
  };
  for (const [k, v] of Object.entries(alt)) if (!map.has(k)) map.set(k, v);
  return map;
}
const HEADER_MAP = buildHeaderMap();
const IGNORED = new Set(IGNORED_TEMPLATE_COLUMNS.map(norm));

/**
 * rows: 2-D array (header row first). Returns { products: [{rowNumber, row}], errors: [{rowNumber, messages}], unknownColumns, skipped }
 */
const TERM_KEYS = new Set(['currency', 'incoterm', 'fob_port', 'payment_terms', 'moq', 'sample_lead_days', 'production_lead_days', 'quote_valid_until']);
const nums = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);

// Quotation-level terms in label/value cells above the table (value to the right or directly below).
function readTerms(rows, headerIdx) {
  const terms = {};
  for (let i = 0; i < headerIdx; i++) {
    rows[i].forEach((cell, c) => {
      const key = HEADER_MAP.get(norm(cell));
      if (!key || !TERM_KEYS.has(key) || terms[key] !== undefined) return;
      const isLabel = (v) => HEADER_MAP.has(norm(v));
      const below = rows[i + 1] && i + 1 < headerIdx ? rows[i + 1][c] : '';
      let val = below !== undefined && String(below).trim() !== '' && !isLabel(below) ? below : '';
      if (val === '') {
        for (let k = c + 1; k < rows[i].length; k++) {
          const v = rows[i][k];
          if (String(v).trim() === '') continue;
          if (!isLabel(v)) val = v;
          break;
        }
      }
      if (String(val).trim() !== '') terms[key] = val;
    });
  }
  // Lenient: "45 days", "1000 pcs", "30-45天" → first number
  for (const k of ['moq', 'sample_lead_days', 'production_lead_days']) {
    if (terms[k] !== undefined && typeof terms[k] !== 'number') { const n = nums(terms[k]); terms[k] = n.length ? n[0] : terms[k]; }
  }
  return terms;
}

function splitComposite(input) {
  if (input._carton_size !== undefined) {
    const n = nums(input._carton_size);
    if (n.length >= 3) { input.carton_l_cm ??= n[0]; input.carton_w_cm ??= n[1]; input.carton_h_cm ??= n[2]; }
    delete input._carton_size;
  }
  if (input._nw_gw !== undefined) {
    const n = typeof input._nw_gw === 'number' ? [input._nw_gw] : nums(input._nw_gw);
    if (n.length >= 2) { input.carton_nw_kg ??= n[0]; input.carton_gw_kg ??= n[1]; } else if (n.length === 1) input.carton_gw_kg ??= n[0];
    delete input._nw_gw;
  }
  for (const k of ['moq', 'sample_lead_days', 'production_lead_days', 'units_per_carton', 'supplier_qty_40hq']) {
    if (typeof input[k] === 'string' && /\d/.test(input[k]) && Number.isNaN(Number(input[k].replace(/,/g, '')))) input[k] = nums(input[k].replace(/,/g, ''))[0];
  }
}

function mapRows(rows) {
  // Header row: first row (within the first 30) that maps ≥ 3 known columns and has a name or description column.
  let headerIdx = -1; let colKeys = [];
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const keys = rows[i].map((h) => HEADER_MAP.get(norm(h)) || null);
    const table = keys.filter((k) => k && !TERM_KEYS.has(k));
    if (table.length >= 3 && (keys.includes('product_name') || (keys.includes('description') && keys.includes('unit_price')))) { headerIdx = i; colKeys = keys; break; }
  }
  if (headerIdx < 0) {
    return { products: [], errors: [{ rowNumber: 1, messages: [m('Could not find the header row. Use the Lulyboo template (the first row must include "Product Name").', '找不到标题行。请使用 Lulyboo 模板（第一行须包含 “Product Name”）。')] }], unknownColumns: [], skipped: 0 };
  }
  const terms = readTerms(rows, headerIdx);
  const unknownColumns = rows[headerIdx]
    .filter((h, i) => String(h).trim() && !colKeys[i] && !IGNORED.has(norm(h)) && !/picture|image|photo|图片/i.test(h))
    .map(String);

  const products = []; const errors = []; let skipped = 0;
  const cnHeaders = new Set(PRODUCT_FIELDS.map((f) => norm(f.cn)));
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNumber = i + 1;
    // Skip a second (Chinese) header row and the template example row
    const matchesCn = r.filter((v) => cnHeaders.has(norm(v))).length;
    if (matchesCn >= 3) { skipped++; continue; }
    const input = {};
    colKeys.forEach((k, c) => { if (k && r[c] !== undefined && String(r[c]).trim() !== '' && !/^(insert image|插入图片)$/i.test(String(r[c]).trim())) input[k] = r[c]; });
    if (!Object.keys(input).length) continue;
    if (/^(general factory notes|工厂综合备注|prepared by|填写人|yellow cells|黄色单元格)/i.test(String(r.find((v) => String(v).trim()) || ''))) continue;
    splitComposite(input);
    for (const [k, v] of Object.entries(terms)) if (input[k] === undefined) input[k] = v;
    if (!input.product_name) {
      const d = input.description ? String(input.description).split(/[\n,;，；]/)[0].trim() : '';
      if (d) input.product_name = d.slice(0, 120);
    }
    if (/^\s*(example|示例|例)\s*[:：]/i.test(String(input.product_name || ''))) { skipped++; continue; }
    if (products.length + errors.length >= MAX_ROWS) { errors.push({ rowNumber, messages: [m(`Only the first ${MAX_ROWS} rows are imported per file`, `每个文件最多导入 ${MAX_ROWS} 行`)] }); break; }
    const { row, errors: errs } = cleanProduct(input);
    if (errs.length) errors.push({ rowNumber, messages: errs, name: input.product_name });
    else products.push({ rowNumber, row });
  }
  return { products, errors, unknownColumns, skipped };
}

function parseUpload(file) {
  const name = (file.name || '').toLowerCase();
  const isZip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  if (name.endsWith('.xlsx') || isZip) return mapRows(parseXlsx(file.buffer));
  if (name.endsWith('.xls')) throw new Error(m('Old .xls format is not supported. Save as .xlsx or CSV UTF-8.', '不支持旧版 .xls 格式，请另存为 .xlsx 或 CSV UTF-8。'));
  return mapRows(parseCsv(decodeText(file.buffer)));
}

module.exports = { parseCsv, parseXlsx, mapRows, parseUpload, decodeText };
