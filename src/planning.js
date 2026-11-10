'use strict';
// Container planning: open purchase-order lines (from supplier reports, POs and "goods ready" emails, read by AI),
// grouped by loading port and week, with a suggested container mix per group.

const AI = require('./ai');
const SC = require('./schedules');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

// Usable volume per container (CBM), as normally loaded with cartons.
const BOXES = [
  { code: '40HQ', cap: 65, nominal: 76 },
  { code: '40GP', cap: 55, nominal: 67 },
  { code: '20GP', cap: 25, nominal: 33 },
];
const LCL_MAX = 15;

/** Suggested container mix for a volume: e.g. 131 → ["40HQ","40HQ","LCL"]. */
function suggest(cbm) {
  let left = Math.max(0, Number(cbm) || 0);
  const out = [];
  if (left <= 0) return { boxes: [], text: '—', fill: 0 };
  while (left > 65) { out.push('40HQ'); left -= 65; }
  if (left > 0) {
    if (left <= LCL_MAX && out.length) out.push('LCL');
    else if (left <= LCL_MAX) out.push('LCL');
    else if (left <= 25) out.push('20GP');
    else if (left <= 55) out.push('40GP');
    else out.push('40HQ');
  }
  const cap = out.reduce((a, b) => a + (BOXES.find((x) => x.code === b)?.cap || 0), 0);
  const counts = {};
  for (const b of out) counts[b] = (counts[b] || 0) + 1;
  const text = Object.entries(counts).map(([k, n]) => (k === 'LCL' ? `LCL ${Math.round(left * 10) / 10} m³` : `${n} × ${k}`)).join(' + ');
  return { boxes: out, text, fill: cap ? Math.min(100, Math.round((Number(cbm) - (out.includes('LCL') ? left : 0)) / cap * 100)) : 0, lcl: out.includes('LCL') };
}

// ── dates and weeks ──────────────────────────────────────────────────────────
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' });
const isoDay = (v) => { if (!v) return null; const s = String(v).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
function weekStart(day) { const d = new Date(`${day}T12:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
function isoWeek(day) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7); }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (day) => { if (!day) return '—'; const d = new Date(`${day}T12:00:00Z`); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function weekLabel(ws) { const we = addDays(ws, 6); return { wk: `Wk ${isoWeek(ws)}`, dates: `${short(ws)}–${ws.slice(5, 7) === we.slice(5, 7) ? Number(we.slice(8)) : short(we)}` }; }

// ── state of one order line ─────────────────────────────────────────────────
const NA = /^(n\/?a|none|no|nil|-|—|ok|0)?$/i;
function state(o, day = today()) {
  if (o.shipped) return 'shipped';
  const pending = String(o.pending_from_us || '').trim();
  if (pending && !NA.test(pending)) return 'waiting';
  const ready = /ready|finished|complete|done|packed/i.test(o.production_status || '');
  if (o.ready_date && o.ready_date < day) return 'overdue';
  if (ready) return 'ready';
  return 'production';
}
const STATE = {
  overdue: { label: 'Ready, not shipped', color: '#b4473b', tag: 'late' },
  waiting: { label: 'Waiting on Lulyboo', color: '#d07a1e', tag: 'wait' },
  ready: { label: 'Ready', color: '#2f8a63', tag: 'ok' },
  production: { label: 'In production', color: '#8d9692', tag: 'plan' },
  shipped: { label: 'Shipped', color: '#b9c0bc', tag: 'done' },
};

// ── AI reading ──────────────────────────────────────────────────────────────
const TOOL = {
  name: 'record_orders',
  description: 'Record every purchase-order line in a supplier\'s order report, PO, production status table or "goods ready" email.',
  input_schema: {
    type: 'object',
    properties: {
      supplier_name: { type: 'string', description: 'Supplier / factory named in the document, if any' },
      orders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            po: { type: 'string', description: 'PO number exactly as written, e.g. PO200013' },
            product: { type: 'string', description: 'Product description; empty when the document lists only PO numbers' },
            sku: { type: 'string', description: 'Item / model number if shown' },
            qty: { type: 'number', description: 'Order quantity in pieces' },
            cartons: { type: 'number' },
            cbm: { type: 'number', description: 'Total goods volume in m³ for this line' },
            gross_kg: { type: 'number', description: 'Total gross weight in kg' },
            ready_date: { type: 'string', description: 'Cargo ready date YYYY-MM-DD; resolve dates without a year (e.g. "25th Nov") to the next such date from today' },
            inspection_date: { type: 'string', description: 'YYYY-MM-DD, or a short note like "to be booked"' },
            production_status: { type: 'string', description: 'e.g. Under production, Ready for shipping' },
            pending_from_lulyboo: { type: 'string', description: 'What the supplier is waiting for from Lulyboo (artwork, approval, deposit…); empty or NA if nothing' },
            order_type: { type: 'string', description: 'New item / Repeat order, if stated' },
            approved_by: { type: 'string' },
            port: { type: 'string', description: 'Port of loading if stated (e.g. Ningbo, Shanghai, Yantian, Nansha)' },
            notes: { type: 'string' },
          },
          required: ['po'],
        },
      },
    },
    required: ['orders'],
  },
};
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function tableText(rows) {
  return rows.map((r, i) => { const c = r.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()); while (c.length && !c[c.length - 1]) c.pop(); return c.some(Boolean) ? `R${i + 1}: ${c.join(' | ')}` : null; })
    .filter(Boolean).slice(0, 1500).join('\n').slice(0, 180000);
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const txt = (v, n = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };

/** Read one file / pasted text with AI → clean order lines. */
async function readOrders({ name = 'document', buffer = null, text = '' }) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const content = []; let table = '';
  const n = String(name).toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (buffer) {
    if (MIME[ext] === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
    else if (MIME[ext]) content.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext], data: buffer.toString('base64') } });
    else if (/\.(xlsx|xlsm)$/.test(n) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) table = tableText(parseXlsx(buffer));
    else table = tableText(parseCsv(decodeText(buffer)));
  }
  content.push({ type: 'text', text: `Today is ${today()}. Record every purchase-order line.${table ? `\n\n${table}` : ''}${text ? `\n\n${String(text).slice(0, 60000)}` : ''}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 16000 });
  const orders = (Array.isArray(result?.orders) ? result.orders : []).map((o) => {
    const insp = isoDay(o.inspection_date);
    const port = txt(o.port, 60);
    return {
      po: txt(o.po, 60), product: txt(o.product, 300), sku: txt(o.sku, 80), qty: num(o.qty), cartons: num(o.cartons), cbm: num(o.cbm), gross_kg: num(o.gross_kg),
      ready_date: isoDay(o.ready_date), inspection_date: insp, inspection_note: insp ? null : txt(o.inspection_date, 80),
      production_status: txt(o.production_status, 120), pending_from_us: txt(o.pending_from_lulyboo, 200), order_type: txt(o.order_type, 60), approved_by: txt(o.approved_by, 60),
      port_text: port, port: SC.portCode(port), notes: txt(o.notes, 500),
    };
  }).filter((o) => o.po);
  return { orders, supplierName: txt(result?.supplier_name, 120) };
}

// ── match against what is already saved ─────────────────────────────────────
const normPo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normProd = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const FIELDS = ['product', 'sku', 'qty', 'cartons', 'cbm', 'gross_kg', 'ready_date', 'inspection_date', 'inspection_note', 'production_status', 'pending_from_us', 'order_type', 'approved_by', 'port', 'port_text', 'notes'];
const LABEL = { qty: 'Qty', cbm: 'CBM', cartons: 'Cartons', gross_kg: 'Weight', ready_date: 'Ready', inspection_date: 'Inspection', production_status: 'Status', pending_from_us: 'Pending', port: 'Port' };

/** For each incoming line: the existing rows it updates and what changes. */
function diff(incoming, existing) {
  return incoming.map((o) => {
    const same = existing.filter((e) => normPo(e.po) === normPo(o.po) && !e.shipped);
    const targets = o.product ? same.filter((e) => normProd(e.product) === normProd(o.product)) : same;
    if (!targets.length) return { ...o, change: 'new', changes: [] };
    const changes = [];
    for (const k of Object.keys(LABEL)) {
      const nv = o[k]; if (nv === null || nv === undefined || nv === '') continue;
      const ov = targets[0][k];
      if (String(ov ?? '') !== String(nv)) changes.push({ field: LABEL[k], from: k.endsWith('_date') ? short(ov) : ov ?? '—', to: k.endsWith('_date') ? short(nv) : nv });
    }
    return { ...o, change: changes.length ? 'updated' : 'same', changes, targetIds: targets.map((t) => t.id) };
  });
}

/** Save reviewed lines: update matched rows (only fields that came in), insert the rest. */
async function save(db, supplierId, lines, { batch, sourceName }) {
  const existing = await db.list('plan_orders', { filters: { supplier_id: supplierId } });
  const d = diff(lines, existing);
  const now = new Date().toISOString();
  let added = 0; let updated = 0;
  for (const o of d) {
    const vals = {};
    for (const k of FIELDS) if (o[k] !== null && o[k] !== undefined && o[k] !== '') vals[k] = o[k];
    if (o.change === 'new') { await db.insert('plan_orders', { supplier_id: supplierId, po: o.po, ...vals, cbm_estimated: !!o.cbm_estimated, batch, source_name: sourceName, created_at: now, updated_at: now }); added++; }
    else if (o.change === 'updated') { for (const id of o.targetIds) await db.update('plan_orders', { id }, { ...(o.product ? vals : Object.fromEntries(Object.entries(vals).filter(([k]) => !['product', 'sku', 'qty', 'cartons', 'cbm', 'gross_kg'].includes(k)))), updated_at: now, source_name: sourceName }); updated++; }
  }
  return { added, updated, same: d.filter((x) => x.change === 'same').length };
}

/** Fill CBM from the supplier's products (carton size × cartons) when the document gave none. */
async function estimateCbm(db, supplierId, lines) {
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => []);
  for (const o of lines) {
    if (o.cbm || !o.product) continue;
    const p = prods.find((x) => normProd(x.product_name).includes(normProd(o.product)) || normProd(o.product).includes(normProd(x.product_name)));
    if (!p) continue;
    const l = num(p.carton_l_cm), w = num(p.carton_w_cm), h = num(p.carton_h_cm);
    const perCtn = num(p.units_per_carton);
    if (!l || !w || !h) continue;
    const ctnCbm = (l * w * h) / 1e6;
    const cartons = o.cartons || (o.qty && perCtn ? Math.ceil(o.qty / perCtn) : null);
    if (cartons) { o.cbm = Math.round(ctnCbm * cartons * 100) / 100; o.cartons = cartons; o.cbm_estimated = true; }
  }
  return lines;
}

module.exports = { BOXES, suggest, today, isoDay, weekStart, isoWeek, weekLabel, short, addDays, state, STATE, readOrders, diff, save, estimateCbm, normPo, TOOL, FIELDS };
