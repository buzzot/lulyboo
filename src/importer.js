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
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Read selected zip entries as Buffers. pred(name) decides which entries to inflate. */
function unzipEntries(buf, pred, { maxTotal = 400 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(m('Not a valid .xlsx file', '不是有效的 .xlsx 文件'));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {}; let total = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(m('The .xlsx file is damaged', '.xlsx 文件已损坏'));
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!pred(name)) continue;
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    let out;
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    else continue;
    total += out.length;
    if (total > maxTotal) throw new Error(m('The .xlsx file is too large to read', '.xlsx 文件过大，无法读取'));
    files[name] = out;
  }
  return files;
}
const TEXT_PARTS = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;
function unzip(buf) {
  const raw = unzipEntries(buf, (n) => TEXT_PARTS.test(n));
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.toString('utf8')]));
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

/** Path of the worksheet we import: the one named "Products", else the first. */
function targetSheetPath(files) {
  const wb = files['xl/workbook.xml'];
  if (!wb) throw new Error(m('Not a valid .xlsx file', '不是有效的 .xlsx 文件'));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)].map((mm) => ({ name: xmlDecode(mm[1]), rid: mm[2] }));
  const target = sheets.find((x) => /^products?$/i.test(x.name)) || sheets[0];
  const rels = files['xl/_rels/workbook.xml.rels'] || '';
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((mm) => mm[0]).find((t) => t.includes(`Id="${target.rid}"`));
  const sheetPath = rel ? rel.match(/Target="([^"]+)"/)[1] : 'worksheets/sheet1.xml';
  return sheetPath.replace(/^\/?(xl\/)?/, 'xl/');
}

/** Read the first worksheet (or the one named "Products") into a 2-D array. */
function parseXlsx(buf) {
  const files = unzip(buf);
  const wb = files['xl/workbook.xml'];
  if (!wb) throw new Error(m('Not a valid .xlsx file', '不是有效的 .xlsx 文件'));
  const sheetPath = targetSheetPath(files);
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


// ── Pictures embedded in the workbook ────────────────────────
// Three ways a factory can put a picture "in" a product row, all supported:
//   1. Floating picture (Insert → Picture, then sized over the cell): xl/drawings/*.xml, anchored to cells.
//   2. Excel 365 "Place in Cell" pictures: cell has vm="n" → xl/metadata.xml → xl/richData/*.
//   3. WPS Office pictures in cells: =DISPIMG("ID_…",1) → xl/cellimages.xml.
// Result: [{ row (0-based), col (0-based), y, name, buffer }]
const RASTER = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$/i;
const MAX_SHEET_PICTURES = 500;
const posix = require('node:path').posix;
const attrOf = (tag, name) => { const mm = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return mm ? xmlDecode(mm[1]) : undefined; };
const relMap = (xml) => {
  const out = {};
  for (const mm of String(xml || '').matchAll(/<Relationship\b[^>]*>/g)) { const id = attrOf(mm[0], 'Id'); const tg = attrOf(mm[0], 'Target'); if (id && tg) out[id] = { target: tg, type: attrOf(mm[0], 'Type') || '' }; }
  return out;
};
const resolveTarget = (fromDir, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(fromDir, target)));
const tagNum = (xml, tag) => { const mm = new RegExp(`<(?:\\w+:)?${tag}>\\s*(-?\\d+)\\s*<`).exec(xml); return mm ? Number(mm[1]) : 0; };

function extractXlsxImages(buf) {
  const entries = unzipEntries(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|metadata\.xml|cellimages\.xml|_rels\/cellimages\.xml\.rels|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.rels|drawings\/[^/]+\.xml|drawings\/_rels\/[^/]+\.rels|richData\/[^/]+\.xml|richData\/_rels\/[^/]+\.rels|media\/[^/]+)$/.test(n));
  const text = (n) => (entries[n] ? entries[n].toString('utf8') : '');
  const sheetPath = targetSheetPath({ 'xl/workbook.xml': text('xl/workbook.xml'), 'xl/_rels/workbook.xml.rels': text('xl/_rels/workbook.xml.rels') });
  const sheet = text(sheetPath);
  if (!sheet) return { pictures: [], unsupported: 0 };
  const pictures = []; let unsupported = 0;
  const media = (path, meta) => {
    if (!path || !entries[path]) return;
    if (!RASTER.test(path)) { unsupported++; return; }
    if (pictures.length < MAX_SHEET_PICTURES) pictures.push({ ...meta, name: posix.basename(path), buffer: entries[path] });
  };

  // Row geometry (EMU) for floating pictures
  const defH = Number((/<sheetFormatPr\b[^>]*\bdefaultRowHeight="([\d.]+)"/.exec(sheet) || [])[1]) || 15;
  const heights = new Map();
  for (const rm of sheet.matchAll(/<row\b[^>]*>/g)) {
    const r = Number(attrOf(rm[0], 'r')); const ht = Number(attrOf(rm[0], 'ht'));
    if (r && ht) heights.set(r - 1, ht * 12700);
  }
  const rowH = (i) => heights.get(i) ?? defH * 12700;
  const rowTop = (i) => { let y = 0; for (let k = 0; k < i; k++) y += rowH(k); return y; };
  const rowAt = (y) => { let k = 0; while (k < 20000 && y >= rowH(k)) { y -= rowH(k); k++; } return k; };

  // 1) Floating pictures
  const sheetDir = posix.dirname(sheetPath);
  const sheetRels = relMap(text(`${sheetDir}/_rels/${posix.basename(sheetPath)}.rels`));
  for (const rel of Object.values(sheetRels)) {
    if (!/\/drawing$/.test(rel.type)) continue;
    const dPath = resolveTarget(sheetDir, rel.target);
    const dRels = relMap(text(`${posix.dirname(dPath)}/_rels/${posix.basename(dPath)}.rels`));
    for (const am of text(dPath).matchAll(/<(?:\w+:)?(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g)) {
      const body = am[2];
      if (!/<(?:\w+:)?pic\b/.test(body)) continue;
      const embed = (/<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/.exec(body) || [])[1];
      const from = /<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/.exec(body);
      if (!embed || !from || !dRels[embed]) continue;
      const fRow = tagNum(from[1], 'row'), fCol = tagNum(from[1], 'col');
      const top = rowTop(fRow) + tagNum(from[1], 'rowOff');
      let bottom = top;
      if (am[1] === 'twoCellAnchor') {
        const to = /<(?:\w+:)?to>([\s\S]*?)<\/(?:\w+:)?to>/.exec(body);
        if (to) bottom = rowTop(tagNum(to[1], 'row')) + tagNum(to[1], 'rowOff');
      } else {
        const ext = /<(?:\w+:)?ext\b[^>]*\bcy="(\d+)"/.exec(body);
        if (ext) bottom = top + Number(ext[1]);
      }
      const y = Math.max(top, (top + bottom) / 2);
      media(resolveTarget(posix.dirname(dPath), dRels[embed].target), { row: rowAt(y), col: fCol, y });
    }
  }

  // Cells that hold pictures (2 and 3)
  const cells = [];
  for (const cm of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /\br="([A-Z]+)(\d+)"/.exec(cm[1]);
    if (!ref) continue;
    const vm = (/\bvm="(\d+)"/.exec(cm[1]) || [])[1];
    const dispimg = /DISPIMG\(\s*(?:&quot;|")(ID_[A-Za-z0-9]+)(?:&quot;|")/.exec(cm[2] || '');
    if (vm || dispimg) cells.push({ col: colIndex(ref[1] + '1'), row: Number(ref[2]) - 1, vm: vm ? Number(vm) : 0, dispimg: dispimg ? dispimg[1] : null });
  }

  // 2) Excel "Place in Cell": vm → metadata.xml → rich value → richValueRel → media
  if (cells.some((c) => c.vm)) {
    const meta = text('xl/metadata.xml');
    const fut = /<futureMetadata\b[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/.exec(meta);
    const futureRvb = fut ? [...fut[1].matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map((b) => Number((/<(?:\w+:)?rvb\b[^>]*\bi="(\d+)"/.exec(b[1]) || [])[1])) : [];
    const vmeta = /<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/.exec(meta);
    const valueBks = vmeta ? [...vmeta[1].matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map((b) => Number((/<rc\b[^>]*\bv="(\d+)"/.exec(b[1]) || [])[1])) : [];
    const structs = [...text('xl/richData/rdrichvaluestructure.xml').matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/g)]
      .map((b) => [...b[1].matchAll(/<k\b[^>]*\bn="([^"]*)"/g)].map((k) => k[1]));
    const rvs = [...text('xl/richData/rdrichvalue.xml').matchAll(/<rv\b([^>]*)>([\s\S]*?)<\/rv>/g)]
      .map((b) => ({ s: Number(attrOf(b[1], 's')) || 0, v: [...b[2].matchAll(/<v\b[^>]*>([\s\S]*?)<\/v>/g)].map((x) => x[1]) }));
    const relIds = [...text('xl/richData/richValueRel.xml').matchAll(/<rel\b[^>]*\br:id="([^"]+)"/g)].map((x) => x[1]);
    const rvRels = relMap(text('xl/richData/_rels/richValueRel.xml.rels'));
    for (const c of cells.filter((x) => x.vm)) {
      const rv = rvs[futureRvb[valueBks[c.vm - 1]]];
      if (!rv) continue;
      const keyIdx = (structs[rv.s] || []).findIndex((k) => /LocalImageIdentifier/i.test(k));
      const relIdx = Number(rv.v[keyIdx < 0 ? 0 : keyIdx]);
      const rel = rvRels[relIds[relIdx]];
      if (rel) media(resolveTarget('xl/richData', rel.target), { row: c.row, col: c.col, y: 0 });
    }
  }

  // 3) WPS =DISPIMG("ID_…")
  if (cells.some((c) => c.dispimg)) {
    const ci = text('xl/cellimages.xml');
    const ciRels = relMap(text('xl/_rels/cellimages.xml.rels'));
    const byId = {};
    for (const pm of ci.matchAll(/<(?:\w+:)?pic\b[\s\S]*?<\/(?:\w+:)?pic>/g)) {
      const id = (/<(?:\w+:)?cNvPr\b[^>]*\bname="([^"]+)"/.exec(pm[0]) || [])[1];
      const emb = (/<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/.exec(pm[0]) || [])[1];
      if (id && emb && ciRels[emb]) byId[id] = ciRels[emb].target;
    }
    for (const c of cells.filter((x) => x.dispimg)) if (byId[c.dispimg]) media(resolveTarget('xl', byId[c.dispimg]), { row: c.row, col: c.col, y: 0 });
  }
  pictures.sort((a, b) => a.row - b.row || a.col - b.col || a.y - b.y);
  return { pictures, unsupported };
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
    'casepack': 'units_per_carton', 'moq': 'moq', 'description': 'description', 'brand': 'brand', '品牌': 'brand', 'factorynotes': 'factory_notes',
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
const TERM_KEYS = new Set(['currency', 'incoterm', 'fob_port', 'payment_terms', 'moq', 'sample_lead_days', 'production_lead_days', 'quote_valid_until', 'country_of_origin']);
// Header-block labels may be bilingual ("Currency\n币种"): try as-is, then with the Chinese part removed.
const stripCjk = (v) => String(v || '').replace(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g, ' ');
const keyOfLabel = (v) => HEADER_MAP.get(norm(v)) || HEADER_MAP.get(norm(String(v || '').split('\n')[0])) || HEADER_MAP.get(norm(stripCjk(v))) || null;
const nums = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);

// Quotation-level terms in label/value cells above the table (value to the right or directly below).
function readTerms(rows, headerIdx) {
  const terms = {};
  for (let i = 0; i < headerIdx; i++) {
    rows[i].forEach((cell, c) => {
      const key = keyOfLabel(cell);
      if (!key || !TERM_KEYS.has(key) || terms[key] !== undefined) return;
      const isLabel = (v) => !!keyOfLabel(v) || /[\u3400-\u9fff]/.test(String(v)) && /\n/.test(String(v));
      // Value to the right of the label (Lulyboo template, quotation form); otherwise directly below.
      let val = '';
      for (let k = c + 1; k < rows[i].length; k++) {
        const v = rows[i][k];
        if (String(v).trim() === '') continue;
        if (!isLabel(v)) val = v;
        break;
      }
      if (val === '') {
        const below = rows[i + 1] && i + 1 < headerIdx ? rows[i + 1][c] : '';
        if (below !== undefined && String(below).trim() !== '' && !isLabel(below)) val = below;
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
    if (table.length >= 2 && keys.filter(Boolean).length >= 3 && (keys.includes('product_name') || (keys.includes('description') && keys.includes('unit_price')))) { headerIdx = i; colKeys = keys; break; }
  }
  if (headerIdx < 0) {
    return { products: [], errors: [{ rowNumber: 1, messages: [m('Could not find the header row. Use the Lulyboo template (the first row must include "Product Name").', '找不到标题行。请使用 Lulyboo 模板（第一行须包含 “Product Name”）。')] }], unknownColumns: [], skipped: 0 };
  }
  const terms = readTerms(rows, headerIdx);
  const unknownColumns = rows[headerIdx]
    .filter((h, i) => String(h).trim() && !colKeys[i] && !IGNORED.has(norm(h)) && !/picture|image|photo|图片|照片/i.test(h))
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

/** Attach pictures found in the workbook to the product rows they sit on (rowNumber = spreadsheet row). */
function attachPictures(res, buf) {
  res.photosFound = 0; res.photosUnmatched = 0; res.photosUnsupported = 0;
  if (!res.products.length) return;
  let found;
  try { found = extractXlsxImages(buf); } catch { return; } // pictures are optional: never fail the import over them
  res.photosUnsupported = found.unsupported;
  const byRow = new Map();
  for (const pic of found.pictures) { const k = pic.row + 1; (byRow.get(k) || byRow.set(k, []).get(k)).push(pic); }
  const first = Math.min(...res.products.map((p) => p.rowNumber));
  for (const p of res.products) {
    const pics = byRow.get(p.rowNumber) || [];
    if (pics.length) p.images = pics.map((x, i) => ({ name: `row${p.rowNumber}-${i + 1}-${x.name}`, type: '', buffer: x.buffer }));
    res.photosFound += pics.length; byRow.delete(p.rowNumber);
  }
  for (const [k, list] of byRow) if (k > first) res.photosUnmatched += list.length; // pictures placed outside any product row
}

function parseUpload(file) {
  const name = (file.name || '').toLowerCase();
  const isZip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  if (name.endsWith('.xlsx') || isZip) {
    const res = mapRows(parseXlsx(file.buffer));
    attachPictures(res, file.buffer);
    return res;
  }
  if (name.endsWith('.xls')) throw new Error(m('Old .xls format is not supported. Save as .xlsx or CSV UTF-8.', '不支持旧版 .xls 格式，请另存为 .xlsx 或 CSV UTF-8。'));
  return mapRows(parseCsv(decodeText(file.buffer)));
}

module.exports = { parseCsv, parseXlsx, extractXlsxImages, mapRows, parseUpload, decodeText };
