'use strict';
const crypto = require('node:crypto');
const { analyzeProduct } = require('./calc');

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

// Small TTL cache for settings / categories / logistics options and supplier token lookups.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
const invalidate = (prefix = '') => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

async function getCtx(db) {
  return cached('ctx', 30_000, async () => {
    const [settingsRows, categories, options] = await Promise.all([
      db.list('settings', { filters: { id: 1 }, limit: 1 }),
      db.list('categories', { order: 'sort.asc,name.asc' }),
      db.list('logistics_options', { order: 'sort.asc,name.asc' }),
    ]);
    const settings = settingsRows[0] || { fx_to_usd: { USD: 1 } };
    return { settings, categories, options, categoryNames: categories.map((c) => c.name) };
  });
}

async function imagesFor(db, productIds) {
  const map = {};
  if (!productIds.length) return map;
  for (let i = 0; i < productIds.length; i += 150) {
    const rows = await db.list('product_images', { filters: { product_id: ['in', productIds.slice(i, i + 150)] }, order: 'sort.asc,created_at.asc' });
    for (const r of rows) (map[r.product_id] ||= []).push(r);
  }
  return map;
}

/** All products with supplier names and analysis. Fine for thousands of rows. */
async function loadAnalyzed(db, { filters = {}, includeDrafts = false } = {}) {
  if (!includeDrafts) filters = { ...filters, is_draft: false };
  const [ctx, products, suppliers] = await Promise.all([
    getCtx(db),
    db.list('products', { filters, order: 'created_at.desc' }),
    db.list('suppliers', { select: 'id,name,crm_status,rating,country' }),
  ]);
  const supById = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const items = products.map((p) => {
    p.supplier_name = supById[p.supplier_id]?.name || '—';
    return { product: p, analysis: analyzeProduct(p, ctx) };
  });
  return { ctx, items, suppliers, supById };
}

module.exports = { hashToken, newToken, getCtx, imagesFor, loadAnalyzed, invalidate };
