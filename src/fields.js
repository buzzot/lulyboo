'use strict';
const m = (en, zh) => `⟪${en}⟫⟦${zh}⟧`; // bilingual message (see lib/html.js)
// Single source of truth for product fields: DB column, bilingual labels,
// form input type and the bulk-template column header.

const CATEGORIES = ['Infant/Toddler', 'Pet', 'Home', 'Other'];
const INCOTERMS = ['FOB', 'EXW', 'FCA', 'CIF', 'CFR', 'DDP', 'DAP'];
const CURRENCIES = ['USD', 'CNY', 'EUR', 'HKD', 'VND', 'INR'];
const STATUSES = ['New', 'Reviewing', 'Shortlisted', 'Sample requested', 'Selected', 'Rejected'];
const STORES = ['Ross', 'Burlington', 'TJ Maxx', 'Nordstrom Rack', 'Target', 'Other'];
const CONTAINERS = ['20GP', '40GP', '40HQ'];

// type: text | textarea | number | int | date | select | url
// csv: header used in the bulk upload template (CSV/XLSX row 1)
const PRODUCT_FIELDS = [
  // ── Product
  { key: 'product_name', group: 'product', en: 'Product Name', cn: '产品名称', type: 'text', required: true, csv: 'Product Name' },
  { key: 'supplier_sku', group: 'product', en: 'Item No. / SKU', cn: '货号 / SKU', type: 'text', csv: 'Supplier SKU' },
  { key: 'category', group: 'product', en: 'Category', cn: '类别', type: 'select', options: CATEGORIES, csv: 'Category' },
  { key: 'subcategory', group: 'product', en: 'Subcategory', cn: '子类别', type: 'text', csv: 'Subcategory' },
  { key: 'description', group: 'product', en: 'Description', cn: '产品描述', type: 'textarea', csv: 'Description' },
  { key: 'materials', group: 'product', en: 'Materials', cn: '材质', type: 'text', csv: 'Materials' },
  { key: 'product_size_cm', group: 'product', en: 'Product Size L×W×H (cm)', cn: '产品尺寸 长×宽×高（cm）', type: 'text', csv: 'Product Size L×W×H (cm)' },
  { key: 'unit_net_weight_kg', group: 'product', en: 'Unit Net Weight (kg)', cn: '单件净重（kg）', type: 'number', csv: 'Unit Net Weight (kg)' },
  { key: 'packaging_type', group: 'product', en: 'Packaging Type', cn: '包装方式', type: 'text', csv: 'Packaging Type' },
  { key: 'certifications', group: 'product', en: 'Certifications', cn: '认证（如 CPSIA, ASTM, OEKO-TEX）', type: 'text', csv: 'Certifications' },
  { key: 'hs_code', group: 'product', en: 'HS Code', cn: 'HS 编码', type: 'text', csv: 'HS Code' },
  { key: 'country_of_origin', group: 'product', en: 'Country of Origin', cn: '原产国', type: 'text', csv: 'Country of Origin' },
  { key: 'brand', group: 'product', en: 'Brand (optional)', cn: '品牌（选填）', type: 'text', csv: 'Brand' },
  { key: 'dangerous_goods', group: 'product', en: 'Contains Battery / Magnet / Liquid', cn: '是否含电池 / 磁铁 / 液体', type: 'text', csv: 'Contains Battery / Magnet / Liquid', help: ['No, or describe', '无，或请说明'] },

  // ── Pricing & terms
  { key: 'currency', group: 'pricing', en: 'Currency', cn: '币种', type: 'select', options: CURRENCIES, csv: 'Currency', default: 'USD' },
  { key: 'unit_price', group: 'pricing', en: 'Unit Price', cn: '单价', type: 'number', csv: 'Unit Price' },
  { key: 'incoterm', group: 'pricing', en: 'Incoterm', cn: '贸易术语', type: 'select', options: INCOTERMS, csv: 'Incoterm', default: 'FOB' },
  { key: 'fob_port', group: 'pricing', en: 'FOB Port / Delivery Point', cn: 'FOB 港口 / 交货地点', type: 'text', csv: 'FOB Port / Delivery Point' },
  { key: 'payment_terms', group: 'pricing', en: 'Payment Terms', cn: '付款条款', type: 'text', csv: 'Payment Terms' },
  { key: 'moq', group: 'pricing', en: 'MOQ (units)', cn: '最小起订量（件）', type: 'int', csv: 'MOQ (units)' },
  { key: 'sample_lead_days', group: 'pricing', en: 'Sample Lead Time (days)', cn: '样品交期（天）', type: 'int', csv: 'Sample Lead Time (days)' },
  { key: 'production_lead_days', group: 'pricing', en: 'Production Lead Time (days)', cn: '生产交期（天）', type: 'int', csv: 'Production Lead Time (days)' },
  { key: 'quote_valid_until', group: 'pricing', en: 'Quote Valid Until', cn: '报价有效期至', type: 'date', csv: 'Quote Valid Until' },

  // ── Packing & carton
  { key: 'units_per_inner', group: 'packing', en: 'Units per Inner Pack', cn: '内盒装数（件）', short: ['Inner pack (pcs)', '内盒（件）'], type: 'int', csv: 'Units per Inner Pack' },
  { key: 'units_per_carton', group: 'packing', en: 'Units per Master Carton', cn: '外箱装数（件/箱）', short: ['Master carton (pcs)', '外箱（件）'], type: 'int', csv: 'Units per Master Carton', logistics: true },
  { key: 'carton_l_cm', group: 'packing', en: 'Carton Length (cm)', cn: '外箱长（cm）', short: ['Length (cm)', '长（厘米）'], type: 'number', csv: 'Carton Length (cm)', logistics: true },
  { key: 'carton_w_cm', group: 'packing', en: 'Carton Width (cm)', cn: '外箱宽（cm）', short: ['Width (cm)', '宽（厘米）'], type: 'number', csv: 'Carton Width (cm)', logistics: true },
  { key: 'carton_h_cm', group: 'packing', en: 'Carton Height (cm)', cn: '外箱高（cm）', short: ['Height (cm)', '高（厘米）'], type: 'number', csv: 'Carton Height (cm)', logistics: true },
  { key: 'carton_nw_kg', group: 'packing', en: 'Carton Net Weight (kg)', cn: '外箱净重（kg）', short: ['Net weight (kg)', '净重（千克）'], type: 'number', csv: 'Carton Net Weight (kg)' },
  { key: 'carton_gw_kg', group: 'packing', en: 'Carton Gross Weight (kg)', cn: '外箱毛重（kg）', short: ['Gross weight (kg)', '毛重（千克）'], type: 'number', csv: 'Carton Gross Weight (kg)', logistics: true },
  { key: 'supplier_qty_20gp', group: 'packing', en: 'Qty per 20GP (units, optional)', cn: '20GP 装柜数量（件，选填）', short: ['20GP (pcs)', '20GP（件）'], type: 'int', csv: 'Qty per 20GP (units)' },
  { key: 'supplier_qty_40gp', group: 'packing', en: 'Qty per 40GP (units, optional)', cn: '40GP 装柜数量（件，选填）', short: ['40GP (pcs)', '40GP（件）'], type: 'int', csv: 'Qty per 40GP (units)' },
  { key: 'supplier_qty_40hq', group: 'packing', en: 'Qty per 40HQ (units, optional)', cn: '40HQ 装柜数量（件，选填）', short: ['40HQ (pcs)', '40HQ（件）'], type: 'int', csv: 'Qty per 40HQ (units)' },

  // ── Other
  { key: 'photo_link', group: 'photos', en: 'Photo / Catalog Link', cn: '图片 / 目录链接', type: 'url', csv: 'Photo Link' },
  { key: 'factory_notes', group: 'other', en: 'Factory Notes', cn: '工厂备注', type: 'textarea', csv: 'Factory Notes' },
];

const GROUPS = [
  { id: 'product', en: 'Product', cn: '产品信息' },
  { id: 'pricing', en: 'Pricing & Terms', cn: '价格与条款' },
  { id: 'packing', en: 'Packing & Carton', cn: '包装与外箱' },
  { id: 'other', en: 'Other', cn: '其他' },
];

// Packing section is laid out in rows so related numbers sit side by side.
const PACKING_ROWS = [
  { en: 'Quantity per carton', cn: '装箱数量', keys: ['units_per_inner', 'units_per_carton'] },
  { en: 'Master carton size (cm)', cn: '外箱尺寸（厘米）', keys: ['carton_l_cm', 'carton_w_cm', 'carton_h_cm'], sep: '×' },
  { en: 'Master carton weight (kg)', cn: '外箱重量（千克）', keys: ['carton_nw_kg', 'carton_gw_kg'] },
  { en: 'Units per container (optional)', cn: '装柜数量（选填）', keys: ['supplier_qty_20gp', 'supplier_qty_40gp', 'supplier_qty_40hq'] },
];

// Template-only columns that are not stored on the product row.
const IGNORED_TEMPLATE_COLUMNS = ['Supplier / Factory Name', 'CBM per Carton (auto)'];

const SUPPLIER_FIELDS = [
  { key: 'name', en: 'Factory / Company Name', cn: '工厂 / 公司名称', type: 'text', required: true },
  { key: 'contact_name', en: 'Contact Person', cn: '联系人', type: 'text' },
  { key: 'email', en: 'Email', cn: '邮箱', type: 'text' },
  { key: 'phone', en: 'Phone / WhatsApp / WeChat', cn: '电话 / WhatsApp / 微信', type: 'text' },
  { key: 'website', en: 'Website', cn: '网站', type: 'url' },
  { key: 'address', en: 'Factory Address', cn: '工厂地址', type: 'textarea' },
  { key: 'country', en: 'Country', cn: '国家', type: 'text' },
];

const REVIEW_FIELDS = ['status', 'target_stores', 'our_wholesale_usd', 'our_retail_usd', 'duty_rate_pct', 'score', 'review_notes'];

const SUPPLIER_COLUMNS = ['id', 'supplier_id', 'created_at', 'updated_at', 'source', 'is_draft', 'submitted_at', ...PRODUCT_FIELDS.map((f) => f.key)];

// ── Value parsing ──────────────────────────────────────────────

function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim().replace(/[,\s$¥￥€]/g, '').replace(/(usd|rmb|cny)$/i, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function excelSerialToISO(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000); // 25569 = days from 1899-12-30 to 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? NaN : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelSerialToISO(v) : NaN;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s));
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // US style M/D/YYYY
  if (m) return iso(+m[3], +m[1], +m[2]);
  return NaN;
}
function iso(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return dt.toISOString().slice(0, 10);
}

/**
 * Convert raw input values (form strings or spreadsheet cells) into a clean row.
 * Returns { row, errors[] }. Unknown keys are ignored. Empty values become null.
 */
function cleanProduct(input, { partial = false } = {}) {
  const row = {};
  const errors = [];
  for (const f of PRODUCT_FIELDS) {
    if (!(f.key in input)) {
      // Full rows always carry every column (PostgREST bulk inserts need identical keys).
      if (!partial) row[f.key] = f.default ?? null;
      continue;
    }
    let v = input[f.key];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      if (f.type === 'number' || f.type === 'int') {
        const n = parseNumber(v);
        if (Number.isNaN(n) || (n !== null && n < 0)) { errors.push(m(`${f.en}: "${input[f.key]}" is not a valid number`, `${f.cn}：“${input[f.key]}”不是有效数字`)); v = null; }
        else v = f.type === 'int' && n !== null ? Math.round(n) : n;
      } else if (f.type === 'date') {
        const d = parseDate(v);
        if (Number.isNaN(d)) { errors.push(m(`${f.en}: "${input[f.key]}" is not a valid date (use YYYY-MM-DD)`, `${f.cn}：“${input[f.key]}”不是有效日期（格式 YYYY-MM-DD）`)); v = null; }
        else v = d;
      } else {
        v = String(v).slice(0, f.type === 'textarea' ? 5000 : 500);
        if (f.type === 'url' && !/^https?:\/\//i.test(v)) v = `https://${v}`;
        if (f.type === 'select' && f.key === 'currency') v = v.toUpperCase();
        if (f.type === 'select' && f.key === 'incoterm') v = v.toUpperCase();
      }
    }
    if (v === null && f.default && !partial) v = f.default;
    row[f.key] = v;
  }
  for (const f of PRODUCT_FIELDS) {
    if (f.required && !partial && !row[f.key]) errors.push(m(`${f.en} is required`, `请填写${f.cn}`));
  }
  return { row, errors };
}

function cleanSupplier(input) {
  const row = {};
  const errors = [];
  for (const f of SUPPLIER_FIELDS) {
    let v = input[f.key];
    v = typeof v === 'string' ? v.trim().slice(0, 1000) : null;
    if (v && f.type === 'url' && !/^https?:\/\//i.test(v)) v = `https://${v}`;
    row[f.key] = v || null;
    if (f.required && !row[f.key]) errors.push(m(`${f.en} is required`, `请填写${f.cn}`));
  }
  return { row, errors };
}

function cleanReview(input) {
  const row = {};
  const errors = [];
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) errors.push('Invalid status'); else row.status = input.status;
  }
  if ('target_stores' in input) {
    const arr = [].concat(input.target_stores || []).filter((s) => STORES.includes(s));
    row.target_stores = [...new Set(arr)];
  }
  for (const k of ['our_wholesale_usd', 'our_retail_usd', 'duty_rate_pct']) {
    if (k in input) {
      const n = parseNumber(input[k]);
      if (Number.isNaN(n) || (n !== null && n < 0)) errors.push(`${k}: invalid number`); else row[k] = n;
    }
  }
  if ('score' in input) {
    const n = parseNumber(input.score);
    if (n === null) row.score = null;
    else if (!Number.isInteger(n) || n < 1 || n > 5) errors.push('Score must be 1–5');
    else row.score = n;
  }
  if ('review_notes' in input) row.review_notes = String(input.review_notes || '').trim().slice(0, 5000) || null;
  return { row, errors };
}

module.exports = {
  PRODUCT_FIELDS, GROUPS, PACKING_ROWS, SUPPLIER_FIELDS, REVIEW_FIELDS, SUPPLIER_COLUMNS, IGNORED_TEMPLATE_COLUMNS,
  CATEGORIES, INCOTERMS, CURRENCIES, STATUSES, STORES, CONTAINERS,
  parseNumber, parseDate, cleanProduct, cleanSupplier, cleanReview,
};
