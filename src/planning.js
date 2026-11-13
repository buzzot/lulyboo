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
  description: 'Record every purchase-order line (one per product) in a supplier\'s order report, PO, proforma invoice, packing list, production status table or "goods ready" email, including the packing (pieces per carton, carton size and weight) when shown.',
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
            product: { type: 'string', description: 'Product name without the item number (put that in sku); empty when the document lists only PO numbers' },
            sku: { type: 'string', description: 'SKU / item no. / model / article number of the product, if shown (e.g. "TBT 001"). A line with a SKU is a product line even without a description.' },
            qty: { type: 'number', description: 'Order quantity in pieces' },
            cartons: { type: 'number' },
            cbm: { type: 'number', description: 'Total goods volume in m³ for this line' },
            gross_kg: { type: 'number', description: 'Total gross weight in kg' },
            unit_price: { type: 'number', description: 'Price per piece, from a Cost / Unit price / Price column (not the line amount)' },
            currency: { type: 'string', description: 'Currency of the unit price, e.g. USD' },
            units_per_carton: { type: 'number', description: 'Packing: pieces per export carton (master carton), from a packing list or PO packing spec' },
            carton_l_cm: { type: 'number', description: 'Export carton length in cm (convert mm/inches to cm)' },
            carton_w_cm: { type: 'number', description: 'Export carton width in cm' },
            carton_h_cm: { type: 'number', description: 'Export carton height in cm' },
            carton_gw_kg: { type: 'number', description: 'Gross weight of ONE carton in kg' },
            carton_nw_kg: { type: 'number', description: 'Net weight of ONE carton in kg' },
            ready_date: { type: 'string', description: 'Cargo ready date YYYY-MM-DD; resolve dates without a year (e.g. "25th Nov") to the next such date from today' },
            inspection_date: { type: 'string', description: 'YYYY-MM-DD, or a short note like "to be booked"' },
            production_status: { type: 'string', description: 'e.g. Under production, Ready for shipping' },
            pending_from_lulyboo: { type: 'string', description: 'What the supplier is waiting for from Lulyboo (artwork, approval, deposit…); empty or NA if nothing' },
            order_type: { type: 'string', description: 'New item / Repeat order, if stated' },
            approved_by: { type: 'string' },
            port: { type: 'string', description: 'Port of loading if stated (e.g. Ningbo, Shanghai, Yantian, Nansha)' },
            notes: { type: 'string', description: 'Only a remark about THIS product line (colour, packaging, special instruction). Never payment terms, ship-to, shipment method, incoterm or the line amount — those go in po_terms or are already in other fields. Usually empty.' },
            po_terms: { type: 'string', description: 'Terms that apply to the whole PO, written once and identically on every line of that PO: payment terms, ship-to address, shipment method, incoterm. Short, e.g. "Payment: 30% deposit, 70% against BOL. Ship-to: Bake Warehouse, Irvine, CA. Method: Ocean."' },
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
/**
 * PO-level terms vs line notes. Sentences about payment, ship-to, shipment method or incoterm belong to the whole PO;
 * "Line amount …" is dropped (the Amount column has it). Returns { notes, po_terms }.
 */
const TERM_RE = /^(payment( terms?)?|terms( of payment)?|deposit|balance|ship[\s-]?to|deliver(y)?( to| address| terms)?|ship(ping|ment)? (method|via|mode|terms)|ship via|incoterms?|fob|exw|cif|ddp|freight( terms)?|consignee|bill to)\b/i;
const DROP_RE = /^(line )?(amount|total|subtotal)\b/i;
function splitTerms(notes, terms = null) {
  const sent = (t) => String(t || '').split(/(?<=[.;])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  const keep = []; const t = sent(terms);
  for (const x of sent(notes)) { if (DROP_RE.test(x)) continue; if (TERM_RE.test(x)) { if (!t.some((y) => y.toLowerCase() === x.toLowerCase())) t.push(x); } else keep.push(x); }
  return { notes: keep.join(' ') || null, po_terms: t.filter((x) => !DROP_RE.test(x)).join(' ') || null };
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const txt = (v, n = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };

/** Read one file / pasted text with AI → clean order lines. */
async function readOrders({ name = 'document', buffer = null, text = '', hint = '', defaultPo = '' }) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const content = []; let table = '';
  const n = String(name).toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (buffer) {
    if (MIME[ext] === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
    else if (MIME[ext]) content.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext], data: buffer.toString('base64') } });
    else if (/\.(xlsx|xlsm)$/.test(n) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) table = tableText(parseXlsx(buffer));
    else table = tableText(parseCsv(decodeText(buffer)));
  }
  content.push({ type: 'text', text: `Today is ${today()}. Record every purchase-order line, one per product.${hint ? ` ${hint}` : ''}${table ? `\n\n${table}` : ''}${text ? `\n\n${String(text).slice(0, 60000)}` : ''}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 16000 });
  const orders = (Array.isArray(result?.orders) ? result.orders : []).map((o) => {
    const insp = isoDay(o.inspection_date);
    const port = txt(o.port, 60);
    return {
      po: txt(o.po, 60), product: txt(o.product, 300), sku: txt(o.sku, 80), qty: num(o.qty), cartons: num(o.cartons), cbm: num(o.cbm), gross_kg: num(o.gross_kg),
      ready_date: isoDay(o.ready_date), inspection_date: insp, inspection_note: insp ? null : txt(o.inspection_date, 80),
      production_status: txt(o.production_status, 120), pending_from_us: txt(o.pending_from_lulyboo, 200), order_type: txt(o.order_type, 60), approved_by: txt(o.approved_by, 60),
      port_text: port, port: SC.portCode(port), ...splitTerms(txt(o.notes, 500), txt(o.po_terms, 500)),
      unit_price: num(o.unit_price), currency: txt(o.currency, 8),
      units_per_carton: num(o.units_per_carton), carton_l_cm: num(o.carton_l_cm), carton_w_cm: num(o.carton_w_cm), carton_h_cm: num(o.carton_h_cm), carton_gw_kg: num(o.carton_gw_kg), carton_nw_kg: num(o.carton_nw_kg),
    };
  }).map((o) => (o.po || !defaultPo ? o : { ...o, po: defaultPo })).filter((o) => o.po).map((o) => ({ ...o, product: cleanName(o.product, o.sku) || o.sku || null }));
  return { orders, supplierName: txt(result?.supplier_name, 120) };
}

// ── match against what is already saved ─────────────────────────────────────
/** PO numbers compared without punctuation and without a leading "PO": "PO 900018" = "PO900018" = "900018". */
const normPo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^PO(?=\d)/, '');
const normSku = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normProd = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PACK = ['units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_gw_kg'];
const PRICE = ['unit_price', 'currency'];
const FIELDS = ['product', 'sku', 'qty', 'cartons', 'cbm', 'gross_kg', ...PACK, ...PRICE, 'ready_date', 'inspection_date', 'inspection_note', 'production_status', 'pending_from_us', 'order_type', 'approved_by', 'port', 'port_text', 'notes', 'po_terms'];
const LABEL = { unit_price: 'Cost', qty: 'Qty', cbm: 'CBM', cartons: 'Cartons', gross_kg: 'Weight', units_per_carton: 'Pcs/carton', carton_l_cm: 'Carton L', carton_w_cm: 'Carton W', carton_h_cm: 'Carton H', carton_gw_kg: 'Carton kg', ready_date: 'Ready', inspection_date: 'Inspection', production_status: 'Status', pending_from_us: 'Pending', port: 'Port' };

/** For each incoming line: the existing rows it updates and what changes. */
function diff(incoming, existing) {
  return incoming.map((o) => {
    const same = existing.filter((e) => normPo(e.po) === normPo(o.po) && !e.shipped);
    let targets = o.product ? same.filter((e) => normProd(e.product) === normProd(o.product)) : same;
    let fuzzy = false;
    if (o.product && !targets.length) {
      // same item under another name (PO vs packing list): match by SKU, then by one name containing the other
      const named = same.filter((e) => e.product);
      const bySku = o.sku ? named.filter((e) => e.sku && normSku(e.sku) === normSku(o.sku)) : [];
      const byName = named.filter((e) => { const a = normProd(e.product), b = normProd(o.product); return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a)); });
      targets = bySku.length === 1 ? bySku : byName.length === 1 ? byName : [];
      // keep the name we have, unless ours is just the same name with the item number in front ("BSTS 001 - Silicone straps")
      fuzzy = targets.length > 0 && !targets.every((t) => normProd(cleanName(t.product, t.sku || o.sku)) === normProd(o.product));
    }
    if (!targets.length) return { ...o, change: 'new', changes: [] };
    const changes = [];
    if (o.product && !fuzzy && targets[0].product && targets[0].product !== o.product) changes.push({ field: 'Product', from: targets[0].product, to: o.product });
    for (const k of Object.keys(LABEL)) {
      const nv = o[k]; if (nv === null || nv === undefined || nv === '') continue;
      const ov = targets[0][k];
      if (String(ov ?? '') !== String(nv)) changes.push({ field: LABEL[k], from: k.endsWith('_date') ? short(ov) : ov ?? '—', to: k.endsWith('_date') ? short(nv) : nv });
    }
    return { ...o, change: changes.length ? 'updated' : 'same', changes, targetIds: targets.map((t) => t.id), keepName: fuzzy };
  });
}

/** Save reviewed lines: update matched rows (only fields that came in), insert the rest. */
async function save(db, supplierId, lines, { batch, sourceName }) {
  for (const o of lines) if (!o.product && o.sku) o.product = o.sku;   // a SKU makes it a product line, never "(whole PO)"
  await namesFromCatalog(db, supplierId, lines);
  const existing = await db.list('plan_orders', { filters: { supplier_id: supplierId } });
  const d = diff(lines, existing);
  const now = new Date().toISOString();
  let added = 0; let updated = 0;
  // columns added later (cost, packing): if the database doesn't have them yet, save without them
  let skip = [];
  const strip = (row) => {
    const r = { ...row };
    if (skip.includes('po_terms') && r.po_terms) r.notes = [r.notes, r.po_terms].filter(Boolean).join(' '); // older database: terms stay in notes (shown once on the PO page)
    return Object.fromEntries(Object.entries(r).filter(([k]) => !skip.includes(k)));
  };
  const write = async (fn, row) => {
    for (let i = 0; ; i++) {
      try { return await fn(strip(row)); }
      catch (e) {
        if (i > 2 || !/column|PGRST204/i.test(e.message || '')) throw e;
        const col = ((e.message || '').match(/'([a-z_]+)' column/) || [])[1];
        skip = [...new Set([...skip, ...(col ? [col] : ['po_terms', ...PACK, ...PRICE])])];
      }
    }
  };
  for (const o of d) {
    const vals = {};
    for (const k of FIELDS) if (o[k] !== null && o[k] !== undefined && o[k] !== '') vals[k] = o[k];
    if (o.change === 'new') {
      const twin = existing.find((e) => normPo(e.po) === normPo(o.po));   // keep the PO number as we already write it ("PO900018", not "900018")
      await write((r) => db.insert('plan_orders', r), { supplier_id: supplierId, po: twin ? twin.po : o.po, ...vals, cbm_estimated: !!o.cbm_estimated, batch, source_name: sourceName, created_at: now, updated_at: now }); added++;
    }
    else if (o.change === 'updated') {
      const keep = o.product ? (o.keepName ? Object.fromEntries(Object.entries(vals).filter(([k]) => !['product', 'sku'].includes(k))) : vals) : Object.fromEntries(Object.entries(vals).filter(([k]) => !['product', 'sku', 'qty', 'cartons', 'cbm', 'gross_kg', ...PACK, ...PRICE].includes(k)));
      if (keep.cbm !== undefined) keep.cbm_estimated = !!o.cbm_estimated;
      for (const id of o.targetIds) await write((r) => db.update('plan_orders', { id }, r), { ...keep, updated_at: now, source_name: sourceName }); updated++;
    }
  }
  const pos = [...new Set(lines.map((o) => normPo(o.po)))];
  await mergePlaceholders(db, supplierId, pos);
  const vol = await fillVolumes(db, supplierId);
  const created = await addToCatalog(db, supplierId, lines.filter((o) => o.product && d.find((x) => x === o || (x.po === o.po && x.product === o.product))?.keepName !== true));
  const catalog = await packingToCatalog(db, supplierId, lines);
  return { added, updated, same: d.filter((x) => x.change === 'same').length, volumes: vol, catalog, products: created.added, productNames: created.names };
}

/** Fill CBM from the supplier's products (carton size × cartons) when the document gave none. */
// ── packing → volume ────────────────────────────────────────────────────────
const hasPack = (x) => !!(num(x?.carton_l_cm) && num(x?.carton_w_cm) && num(x?.carton_h_cm));
const sameItem = (a, b) => (a.sku && (b.sku || b.supplier_sku) && normSku(a.sku) === normSku(b.sku || b.supplier_sku)) || (a.product && (b.product || b.product_name) && normProd(a.product) === normProd(b.product || b.product_name));
const looseItem = (a, b) => { const x = normProd(a.product), y = normProd(b.product || b.product_name); return x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x)); };
const packOf = (x) => Object.fromEntries(PACK.map((k) => [k, num(x[k])]));

/** Cartons, m³ and gross kg from order quantity and carton packing. */
function volumeFrom(qty, pack, cartons = null) {
  const l = num(pack.carton_l_cm), w = num(pack.carton_w_cm), h = num(pack.carton_h_cm), per = num(pack.units_per_carton), gw = num(pack.carton_gw_kg);
  if (!l || !w || !h) return null;
  const ctns = num(cartons) || (num(qty) && per ? Math.ceil(num(qty) / per) : null);
  if (!ctns) return null;
  return { cartons: ctns, cbm: Math.round((l * w * h) / 1e6 * ctns * 100) / 100, gross_kg: gw ? Math.round(gw * ctns * 10) / 10 : null };
}

/** Standard packing for a line: its own, else the same item on an earlier PO, else the catalog product. */
/**
 * Carton packing written as text (product description, notes, packaging): "Carton size: 60*40*35cm", "Meas 600x400x350mm",
 * "36pcs/ctn", "G.W.: 12.5kg", "外箱尺寸 60*40*35", "毛重 12.5kg". Dimensions count only next to a carton word, so a
 * product size ("18 x 18 x 3.9 cm") is not taken for the carton. Returns the fields found (may be partial) or null.
 */
function packingFromText(...texts) {
  const t = texts.filter(Boolean).join('\n').replace(/[×*Xx✕]/g, 'x').replace(/，/g, ',').replace(/：/g, ':');
  if (!t.trim()) return null;
  const out = {};
  const KW = /(master\s*carton|outer\s*carton|export\s*carton|carton|ctn|cartons|meas(?:urement)?|外箱|箱规|纸箱|外箱尺寸)/i;
  const dimRe = /(\d+(?:\.\d+)?)\s*(cm|mm|in(?:ch(?:es)?)?|")?\s*x\s*(\d+(?:\.\d+)?)\s*(cm|mm|in(?:ch(?:es)?)?|")?\s*x\s*(\d+(?:\.\d+)?)\s*(cm|mm|in(?:ch(?:es)?)?|"|厘米|毫米)?/gi;
  let m;
  while ((m = dimRe.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    if (!KW.test(before) || /product|item\s*size|产品尺寸/i.test(before.slice(-20))) continue;
    const unit = (m[6] || m[4] || m[2] || 'cm').toLowerCase();
    const k = /mm|毫米/.test(unit) ? 0.1 : /in|"/.test(unit) ? 2.54 : 1;
    const [l, w, h] = [m[1], m[3], m[5]].map((x) => Math.round(Number(x) * k * 10) / 10);
    if (l > 5 && w > 5 && h > 3 && l < 250 && w < 250 && h < 250) { Object.assign(out, { carton_l_cm: l, carton_w_cm: w, carton_h_cm: h }); break; }
  }
  const pcs = t.match(/(\d{1,5})\s*(?:pcs|pc|units?|sets?|pairs?|件|只|个|套)\s*(?:\/|per|each|a|in\s+one|\/\s*one)\s*(?:master\s*|outer\s*|export\s*)?(?:ctns?|cartons?|箱)/i)
    || t.match(/(?:pcs|qty|quantity|units?)\s*(?:\/|per)\s*(?:ctn|carton)\s*[:=]?\s*(\d{1,5})/i) || t.match(/装箱数[^\d]{0,6}(\d{1,5})/);
  if (pcs) out.units_per_carton = Number(pcs[1]);
  const gw = t.match(/(?:G\.?\s*W\.?|gross\s*(?:weight|wt\.?)?|毛重)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kgs?|千克|公斤)?/i);
  if (gw) out.carton_gw_kg = Number(gw[1]);
  const nw = t.match(/(?:N\.?\s*W\.?|net\s*(?:weight|wt\.?)|净重)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kgs?|千克|公斤)?/i);
  if (nw && !/unit|per\s*(?:pc|piece|unit)/i.test(t.slice(Math.max(0, nw.index - 15), nw.index))) out.carton_nw_kg = Number(nw[1]);
  return Object.keys(out).length ? out : null;
}

/** The catalog product's packing: its carton fields, completed from what its description / notes say. */
function productPack(p) {
  const own = packOf(p);
  if (hasPack(p) && own.units_per_carton && own.carton_gw_kg) return { pack: own, fromText: null };
  const txt = packingFromText(p.description, p.factory_notes, p.packaging_type);
  if (!txt) return hasPack(p) ? { pack: own, fromText: null } : null;
  const pack = { ...own }; const filled = {};
  for (const [k, v] of Object.entries(txt)) if (pack[k] == null) { pack[k] = v; filled[k] = v; }
  return hasPack(pack) ? { pack, fromText: Object.keys(filled).length ? filled : null } : null;
}

function findPacking(o, history, prods) {
  const r = findPackingRaw(o, history, prods);
  if (!r || r.from === 'line') return r;
  // the line's own numbers (e.g. pcs/carton printed on the PO) win over the standard packing
  const own = Object.fromEntries(Object.entries(packOf(o)).filter(([, v]) => v != null));
  return { ...r, pack: { ...r.pack, ...own } };
}

function findPackingRaw(o, history, prods) {
  if (hasPack(o)) return { pack: packOf(o), from: 'line' };
  const h = history.filter((x) => x.id !== o.id && hasPack(x) && sameItem(o, x)).sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
  if (h) return { pack: packOf(h), from: 'history' };
  const withPack = prods.map((x) => ({ x, pp: productPack(x) })).filter((y) => y.pp);
  const hit = withPack.find((y) => sameItem(o, y.x)) || withPack.filter((y) => looseItem(o, y.x)).reduce((a, y, i, all) => (all.length === 1 ? y : null), null);
  if (hit) return { pack: hit.pp.pack, from: 'catalog', product: hit.x, fromText: hit.pp.fromText };
  return null;
}

/**
 * For every open line of a supplier: take the standard packing (own / earlier PO / catalog) and, when the volume
 * was not given by the supplier, calculate cartons, m³ and gross kg from the order quantity. Returns lines updated.
 */
async function fillVolumes(db, supplierId) {
  const all = await db.list('plan_orders', { filters: { supplier_id: supplierId } }).catch(() => []);
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => []);
  let n = 0;
  for (const o of all) {
    if (o.shipped || !o.product) continue;
    const given = num(o.cbm) && !o.cbm_estimated;
    const f = findPacking(o, all, prods); if (!f) continue;
    if (f.fromText && f.product && !f.product._packSaved) {
      // carton data that was only written in the product's description: store it in the product's carton fields too
      const fill = Object.fromEntries(Object.entries(f.fromText).filter(([k]) => num(f.product[k]) == null));
      if (Object.keys(fill).length) await db.update('products', { id: f.product.id }, { ...fill, updated_at: new Date().toISOString() }).catch(() => null);
      Object.assign(f.product, fill); f.product._packSaved = true;
    }
    const patch = {};
    if (f.from !== 'line') for (const k of PACK) if (f.pack[k] != null && num(o[k]) == null) patch[k] = f.pack[k];
    if (!given) {
      const v = volumeFrom(o.qty, { ...packOf(o), ...patch }, o.cbm_estimated ? null : o.cartons);
      if (v && (num(o.cbm) !== v.cbm || num(o.cartons) !== v.cartons)) Object.assign(patch, { cbm: v.cbm, cartons: v.cartons, cbm_estimated: true, ...(v.gross_kg && !num(o.gross_kg) || o.cbm_estimated ? { gross_kg: v.gross_kg } : {}) });
    }
    if (Object.keys(patch).length) { await db.update('plan_orders', { id: o.id }, { ...patch, updated_at: new Date().toISOString() }); n++; }
  }
  return n;
}

/** A PO that now has product lines: copy dates/port/status/container from its "(whole PO)" line, then drop that line. */
async function mergePlaceholders(db, supplierId, pos) {
  if (!pos.length) return 0;
  const all = await db.list('plan_orders', { filters: { supplier_id: supplierId } }).catch(() => []);
  const SHARED = ['ready_date', 'inspection_date', 'inspection_note', 'production_status', 'pending_from_us', 'order_type', 'approved_by', 'port', 'port_text', 'container_id', 'notes'];
  let n = 0;
  for (const po of pos) {
    const ls = all.filter((x) => normPo(x.po) === po && !x.shipped);
    const ph = ls.filter((x) => !x.product); const real = ls.filter((x) => x.product);
    if (!ph.length || !real.length) continue;
    for (const r of real) {
      const patch = {};
      for (const k of SHARED) if ((r[k] === null || r[k] === undefined || r[k] === '') && ph[0][k] !== null && ph[0][k] !== undefined && ph[0][k] !== '') patch[k] = ph[0][k];
      if (Object.keys(patch).length) await db.update('plan_orders', { id: r.id }, { ...patch, updated_at: new Date().toISOString() });
    }
    for (const x of ph) { await db.remove('plan_orders', { id: x.id }); n++; }
  }
  return n;
}

/** Same item: same supplier SKU, or the same product name once item numbers are taken off. */
function sameLineItem(a, b) {
  if (a.sku && b.sku) return normSku(a.sku) === normSku(b.sku);
  const sku = a.sku || b.sku;
  return normProd(cleanName(a.product, sku)) === normProd(cleanName(b.product, sku));
}

/** Groups of open lines that are the same item on the same PO of the same supplier (e.g. "900018" and "PO900018"). */
function duplicateGroups(lines) {
  const byPo = new Map();
  for (const o of lines) {
    if (o.shipped || !o.product) continue;
    const k = `${o.supplier_id}|${normPo(o.po)}`;
    if (!byPo.has(k)) byPo.set(k, []);
    byPo.get(k).push(o);
  }
  const groups = [];
  for (const ls of byPo.values()) {
    const used = new Set();
    for (const o of ls) {
      if (used.has(o.id)) continue;
      const g = ls.filter((x) => !used.has(x.id) && (x === o || sameLineItem(o, x)));
      g.forEach((x) => used.add(x.id));
      if (g.length > 1) groups.push(g);
    }
  }
  return groups;
}

/**
 * Merge duplicate lines: keep the oldest line (its PO spelling, container, history), fill its empty fields from the
 * others, take the clean product name and the newest cost / quantity, then delete the others. Returns lines removed.
 */
async function mergeDuplicates(db, supplierId = null) {
  const all = await db.list('plan_orders', supplierId ? { filters: { supplier_id: supplierId } } : {}).catch(() => []);
  let removed = 0;
  for (const g of duplicateGroups(all)) {
    const byAge = [...g].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const keep = byAge.find((x) => x.container_id) || byAge[0];
    const others = g.filter((x) => x.id !== keep.id);
    const newest = [...g].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    const patch = {};
    const empty = (v) => v === null || v === undefined || v === '';
    for (const k of [...FIELDS, 'ready_date', 'inspection_date', 'inspection_note', 'production_status', 'pending_from_us', 'port', 'port_text', 'container_id', 'notes']) {
      if (!empty(keep[k])) continue;
      const v = newest.find((x) => !empty(x[k])); if (v) patch[k] = v[k];
    }
    for (const k of ['unit_price', 'currency', 'qty']) { const v = newest.find((x) => !empty(x[k])); if (v && String(v[k]) !== String(keep[k] ?? '')) patch[k] = v[k]; }
    const clean = g.map((x) => cleanName(x.product, x.sku || keep.sku)).sort((a, b) => a.length - b.length)[0];
    if (clean && clean !== keep.product) patch.product = clean;
    if (Object.keys(patch).length) await db.update('plan_orders', { id: keep.id }, { ...patch, updated_at: new Date().toISOString() }).catch(() => db.update('plan_orders', { id: keep.id }, Object.fromEntries(Object.entries(patch).filter(([k]) => ![...PACK, ...PRICE].includes(k)))));
    for (const x of others) { await db.remove('plan_orders', { id: x.id }); removed++; }
  }
  return removed;
}

/** "BSTS 001 - Silicone straps set of three" with SKU "BSTS 001" → "Silicone straps set of three". */
function cleanName(name, sku) {
  const n = String(name || '').trim(); if (!n || !sku) return n || null;
  const k = String(sku).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s\-_]+/g, '[\\s\\-_]*');
  const out = n.replace(new RegExp(`^\\s*${k}\\s*[-–:|/,.]?\\s*`, 'i'), '').trim();
  return out.length >= 3 ? out : n;
}

/** Catalog product for a PO line: same supplier SKU, else same name, else the one product whose name contains the other. */
function catalogMatch(o, prods) {
  return prods.find((p) => o.sku && p.supplier_sku && normSku(o.sku) === normSku(p.supplier_sku))
    || prods.find((p) => normProd(p.product_name) === normProd(o.product))
    || prods.filter((p) => looseItem(o, p)).reduce((a, x, i, all) => (all.length === 1 ? x : null), null);
}

/**
 * Products read from a PO / PI / packing list / order report that the supplier's product list does not have yet
 * are added to it (status "Selected" — we ordered them), with SKU, unit price and packing. Returns { added, names }.
 */
async function addToCatalog(db, supplierId, lines, { source = 'po' } = {}) {
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => null);
  if (!prods) return { added: 0, names: [] };
  const names = [];
  const stored = await db.list('plan_orders', { filters: { supplier_id: supplierId } }).catch(() => []);
  for (const line of lines) {
    if (!line.product) continue;
    const have = catalogMatch(line, prods);
    if (have) {
      if (num(line.unit_price) && !num(have.unit_price)) { await db.update('products', { id: have.id }, { unit_price: num(line.unit_price), currency: (line.currency || have.currency || 'USD').toUpperCase().slice(0, 8), updated_at: new Date().toISOString() }).catch(() => null); have.unit_price = num(line.unit_price); }
      continue;
    }
    const saved = stored.find((x) => normPo(x.po) === normPo(line.po) && normProd(x.product) === normProd(line.product));
    const o = { ...(saved || {}), ...Object.fromEntries(Object.entries(line).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
    const port = o.port && SC.PORT[o.port] ? SC.PORT[o.port].name : o.port_text || null;
    const row = {
      supplier_id: supplierId, product_name: String(o.product).slice(0, 300), supplier_sku: o.sku || null,
      unit_price: num(o.unit_price), currency: (o.currency || 'USD').toUpperCase().slice(0, 8), fob_port: port,
      units_per_carton: num(o.units_per_carton), carton_l_cm: num(o.carton_l_cm), carton_w_cm: num(o.carton_w_cm), carton_h_cm: num(o.carton_h_cm), carton_gw_kg: num(o.carton_gw_kg), carton_nw_kg: num(o.carton_nw_kg),
      status: 'Selected', source, is_draft: false, factory_notes: `Added from ${o.po}`,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    try { const p = await db.insert('products', row); prods.push(p); names.push(p.product_name); } catch { /* catalog is optional for planning */ }
  }
  return { added: names.length, names };
}

/**
 * Packing read from a document goes to the catalog product: single-carton size, pcs per carton, gross and net weight.
 * From a packing list (o.fromPackingList) it replaces what the product had, with a note of the old values;
 * from other documents it only fills a product that has no packing yet.
 */
async function packingToCatalog(db, supplierId, lines) {
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => []);
  let n = 0; const done = new Set();
  for (const o of lines.filter((x) => hasPack(x) || (x.fromPackingList && (num(x.units_per_carton) || num(x.carton_gw_kg))))) {
    const p = catalogMatch(o, prods);
    if (!p || done.has(p.id)) continue;
    const incoming = { units_per_carton: num(o.units_per_carton), carton_l_cm: num(o.carton_l_cm), carton_w_cm: num(o.carton_w_cm), carton_h_cm: num(o.carton_h_cm), carton_gw_kg: num(o.carton_gw_kg), carton_nw_kg: num(o.carton_nw_kg) };
    const patch = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (v == null) continue;
      if (num(p[k]) == null || (o.fromPackingList && num(p[k]) !== v)) patch[k] = v;
    }
    if (!Object.keys(patch).length) continue;
    const old = Object.keys(patch).filter((k) => num(p[k]) != null);
    if (old.length) {
      const was = (k) => num(p[k]);
      const desc = [old.includes('carton_l_cm') || old.includes('carton_w_cm') || old.includes('carton_h_cm') ? `${was('carton_l_cm')}×${was('carton_w_cm')}×${was('carton_h_cm')} cm` : null, old.includes('units_per_carton') ? `${was('units_per_carton')} pcs/ctn` : null, old.includes('carton_gw_kg') ? `GW ${was('carton_gw_kg')} kg` : null, old.includes('carton_nw_kg') ? `NW ${was('carton_nw_kg')} kg` : null].filter(Boolean).join(', ');
      patch.factory_notes = [p.factory_notes, `${today()}: packing updated from the packing list of ${o.po} (was ${desc}).`].filter(Boolean).join('\n').slice(-4000);
    }
    await db.update('products', { id: p.id }, { ...patch, updated_at: new Date().toISOString() }).catch(() => null);
    Object.assign(p, patch); done.add(p.id); n++;
  }
  return n;
}

/** Lines known only by SKU ("TBT 001") take the product name from the supplier's product list when it has that SKU. */
async function namesFromCatalog(db, supplierId, lines) {
  if (!supplierId || !lines.some((o) => o.sku && (!o.product || normSku(o.product) === normSku(o.sku)))) return lines;
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => []);
  for (const o of lines) {
    if (!o.sku) continue;
    if (o.product && normSku(o.product) !== normSku(o.sku)) continue;
    const p = prods.find((x) => x.supplier_sku && normSku(x.supplier_sku) === normSku(o.sku));
    o.product = p?.product_name || o.product || o.sku;
  }
  return lines;
}

/** For the review screen: fill m³ of lines that have none, from their own / earlier / catalog packing. */
async function estimateCbm(db, supplierId, lines) {
  await namesFromCatalog(db, supplierId, lines);
  const prods = await db.list('products', { filters: { supplier_id: supplierId } }).catch(() => []);
  const history = await db.list('plan_orders', { filters: { supplier_id: supplierId } }).catch(() => []);
  for (const o of lines) {
    if (o.cbm || !o.product) continue;
    const f = findPacking(o, history, prods); if (!f) continue;
    const v = volumeFrom(o.qty, f.pack, o.cartons); if (!v) continue;
    o.cbm = v.cbm; o.cartons = v.cartons; o.cbm_estimated = true;
    if (!o.gross_kg && v.gross_kg) o.gross_kg = v.gross_kg;
    if (f.from !== 'line') for (const k of PACK) if (o[k] == null && f.pack[k] != null) o[k] = f.pack[k];
  }
  return lines;
}

// ── documents (POs, order reports, packing lists…) ──────────────────────────
const DOC_KINDS = ['PO', 'Order report', 'Production status', 'Packing list', 'Invoice', 'Bill of lading', 'Warehouse receipt', 'Loading photos', 'Other'];
const FILE_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', eml: 'message/rfc822', msg: 'application/vnd.ms-outlook' };
const guessKind = (name, pos = []) => (/packing/i.test(name) ? 'Packing list' : /invoice|\bci\b|\bpi\b/i.test(name) ? 'Invoice' : /status/i.test(name) ? 'Production status' : pos.length === 1 && /po/i.test(name) ? 'PO' : 'Order report');
/** Store files in the documents bucket and record them, linked to the POs they cover. */
async function storeFiles(db, supplierId, files, { pos = [], kind = null, batch = null, by = null, shipmentId = null } = {}) {
  const saved = []; const errors = []; const skipped = [];
  const existing = await db.list('plan_files', { filters: { supplier_id: supplierId } }).catch(() => []);
  for (const f of files) {
    if (!f.buffer?.length) continue;
    // the same file uploaded again (same name and size): keep the first copy, just link any new PO numbers
    const dupe = existing.find((x) => x.name === String(f.name).slice(0, 200) && Number(x.size) === f.buffer.length);
    if (f.buffer.length > 25 * 1024 * 1024) { errors.push(`${f.name}: larger than 25 MB`); continue; }
    if (dupe) { const merged = [...new Set([...(dupe.pos || []), ...(f.pos || pos).map((x) => String(x).trim()).filter(Boolean)])].slice(0, 200); await db.update('plan_files', { id: dupe.id }, { pos: merged, ...(shipmentId && !dupe.shipment_id ? { shipment_id: shipmentId } : {}) }); dupe.pos = merged; skipped.push(f.name); continue; }
    const ext = (String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
    const path = `planning/${supplierId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    const type = FILE_MIME[ext] || f.type || 'application/octet-stream';
    try { await db.docs.upload(path, f.buffer, type); }
    catch (e) { errors.push(`${f.name}: could not be stored`); continue; }
    const list = [...new Set((f.pos || pos).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);
    saved.push(await db.insert('plan_files', { supplier_id: supplierId, name: String(f.name).slice(0, 200), path, size: f.buffer.length, content_type: type, kind: kind || guessKind(f.name, list), pos: list, batch, uploaded_by: by, ...(shipmentId ? { shipment_id: shipmentId } : {}), created_at: new Date().toISOString() }));
  }
  return { saved, errors, skipped };
}

module.exports = { splitTerms, DOC_KINDS, storeFiles, guessKind, BOXES, suggest, today, isoDay, weekStart, isoWeek, weekLabel, short, addDays, state, STATE, readOrders, diff, save, estimateCbm, normPo, TOOL, FIELDS, PACK, PRICE, packingFromText, namesFromCatalog, fillVolumes, duplicateGroups, mergeDuplicates, addToCatalog, catalogMatch, cleanName, volumeFrom, mergePlaceholders, packingToCatalog };
