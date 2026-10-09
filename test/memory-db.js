'use strict';
// In-memory implementation of the db interface in src/db.js, for tests.
const crypto = require('node:crypto');

function createMemoryDb(seed = {}) {
  const tables = {};
  const t = (name) => (tables[name] ||= []);
  const files = new Map();
  for (const [k, rows] of Object.entries(seed)) tables[k] = rows.map((r) => ({ ...r }));

  const match = (row, filters = {}) => Object.entries(filters).every(([col, f]) => {
    const v = row[col];
    if (!Array.isArray(f)) return f === null ? v === null || v === undefined : String(v) === String(f);
    const [op, x] = f;
    switch (op) {
      case 'in': return x.map(String).includes(String(v));
      case 'is': return v === null || v === undefined;
      case 'eq': return String(v) === String(x);
      case 'neq': return String(v) !== String(x);
      case 'lt': return v !== null && v !== undefined && v < x;
      case 'lte': return v !== null && v !== undefined && v <= x;
      case 'gt': return v !== null && v !== undefined && v > x;
      case 'gte': return v !== null && v !== undefined && v >= x;
      case 'cs': return [].concat(x).every((e) => (v || []).includes(e));
      case 'ilike': return new RegExp('^' + String(x).replace(/%/g, '.*') + '$', 'i').test(v || '');
      default: throw new Error('op ' + op);
    }
  });
  const sortRows = (rows, order) => {
    if (!order) return rows;
    const specs = order.split(',').map((s) => { const [c, dir] = s.split('.'); return [c, dir === 'desc' ? -1 : 1]; });
    return [...rows].sort((a, b) => { for (const [c, d] of specs) { if (a[c] < b[c]) return -d; if (a[c] > b[c]) return d; } return 0; });
  };
  const defaults = {
    suppliers: () => ({ crm_status: 'Prospect', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    products: () => ({ status: 'New', is_draft: false, target_stores: [], currency: 'USD', source: 'form', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    supplier_activities: () => ({ done: false, type: 'Note', activity_date: new Date().toISOString().slice(0, 10), created_at: new Date().toISOString() }),
    product_images: () => ({ sort: 0, created_at: new Date().toISOString() }),
    ai_analyses: () => ({ created_at: new Date().toISOString(), product_ids: [] }),
    categories: () => ({ sort: 0 }),
    supplier_users: () => ({ status: 'invited', session_version: 1, created_at: new Date().toISOString() }),
    auth_codes: () => ({ attempts: 0, used: false, created_at: new Date().toISOString() }),
    logistics_options: () => ({ active: true, min_charge_usd: 0, fees_per_shipment_usd: 0, sort: 0 }),
  };

  const db = {
    tables, files,
    async list(table, { filters, order, limit, offset = 0 } = {}) {
      if (table === 'storage_usage') {
        const imgs = t('product_images');
        return [{ image_count: imgs.length, total_bytes: imgs.reduce((a, i) => a + i.bytes, 0) }];
      }
      let rows = sortRows(t(table).filter((r) => match(r, filters)), order);
      rows = rows.slice(offset, limit ? offset + limit : undefined);
      return rows.map((r) => ({ ...r }));
    },
    async get(table, id) { const r = t(table).find((x) => x.id === id); return r ? { ...r } : null; },
    async insert(table, rows) {
      const many = Array.isArray(rows);
      const out = [].concat(rows).map((r) => { const row = { id: crypto.randomUUID(), ...(defaults[table]?.() || {}), ...r }; t(table).push(row); return { ...row }; });
      return many ? out : out[0];
    },
    async update(table, filters, patch) {
      const out = [];
      for (const r of t(table)) if (match(r, filters)) { Object.assign(r, patch); out.push({ ...r }); }
      return out;
    },
    async remove(table, filters) {
      tables[table] = t(table).filter((r) => !match(r, filters));
      if (table === 'products') { const ids = new Set(t('products').map((p) => p.id)); tables.product_images = t('product_images').filter((i) => ids.has(i.product_id)); }
      if (table === 'suppliers') {
        const sids = new Set(t('suppliers').map((s) => s.id));
        tables.products = t('products').filter((p) => sids.has(p.supplier_id));
        const pids = new Set(t('products').map((p) => p.id));
        tables.product_images = t('product_images').filter((i) => pids.has(i.product_id));
      }
    },
    storage: {
      async upload(path, buf) { files.set(path, buf); },
      async signedUrls(paths) { return Object.fromEntries(paths.filter(Boolean).map((p) => [p, `https://x.supabase.co/storage/v1/object/sign/product-images/${p}?token=t`])); },
      async download(path) { return files.get(path); },
      async remove(paths) { for (const p of paths) files.delete(p); },
    },
  };
  return db;
}

function seedDb() {
  const opt40 = crypto.randomUUID();
  return createMemoryDb({
    settings: [{ id: 1, default_logistics_option_id: opt40, default_duty_pct: 0, default_target_margin_pct: 40, insurance_pct: 0.3, fx_to_usd: { USD: 1, CNY: 0.14 } }],
    categories: [
      { id: crypto.randomUUID(), name: 'Infant/Toddler', target_margin_pct: 45, default_duty_pct: 7, sort: 1 },
      { id: crypto.randomUUID(), name: 'Pet', target_margin_pct: 45, sort: 2 },
    ],
    logistics_options: [
      { id: opt40, name: '40HQ FCL', mode: 'FCL_40HQ', rate_usd: 3800, fees_per_shipment_usd: 1500, min_charge_usd: 0, transit_days: 30, active: true, sort: 1 },
      { id: crypto.randomUUID(), name: 'LCL', mode: 'LCL', rate_usd: 95, fees_per_shipment_usd: 650, min_charge_usd: 0, transit_days: 35, active: true, sort: 2 },
      { id: crypto.randomUUID(), name: 'Air', mode: 'AIR', rate_usd: 6.5, fees_per_shipment_usd: 350, min_charge_usd: 0, transit_days: 7, active: true, sort: 3 },
    ],
  });
}

module.exports = { createMemoryDb, seedDb };
