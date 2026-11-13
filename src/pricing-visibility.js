'use strict';
// Which products show their pricing to the supplier.
//   · Products the supplier added themselves (their form or their own import): always.
//   · Products Lulyboo added (PO import, packing list, admin import, AI): only when the supplier's
//     "show_pricing" switch is on. Off by default.
// Enforced on the server: hidden fields are never rendered for the supplier, and price fields they
// send for such a product are dropped before saving.

const { PRODUCT_FIELDS } = require('./fields');

const PRICING_KEYS = PRODUCT_FIELDS.filter((f) => f.group === 'pricing').map((f) => f.key);

/** Did the supplier add this product? Older rows without added_by: only their own form counts. */
const addedBySupplier = (p) => (p?.added_by ? p.added_by === 'supplier' : p?.source === 'form');

/** Can this supplier see the pricing of this product? A new product (no id yet) is theirs. */
const supplierSeesPricing = (supplier, p) => !p || !p.id || addedBySupplier(p) || supplier?.show_pricing === true;

const withoutPricing = (row) => Object.fromEntries(Object.entries(row || {}).filter(([k]) => !PRICING_KEYS.includes(k)));

const missingCol = (e, col) => /column|PGRST204/i.test(e?.message || '') && new RegExp(col).test(e?.message || '');

/** Insert product row(s) with added_by; works before the added_by column exists (it is then left out). */
async function insertProduct(db, rows, addedBy) {
  const tag = (r) => ({ ...r, added_by: addedBy });
  try { return await db.insert('products', Array.isArray(rows) ? rows.map(tag) : tag(rows)); }
  catch (e) { if (missingCol(e, 'added_by')) return db.insert('products', rows); throw e; }
}

module.exports = { PRICING_KEYS, addedBySupplier, supplierSeesPricing, withoutPricing, insertProduct };
