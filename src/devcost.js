'use strict';
// Product development costs (moulds, tooling, samples, testing, design) — for statistics only.
// The included cost (paid, plus quoted unless switched off; refunded never) is spread over a planned quantity:
// per unit = total ÷ planned pcs. Each PO for the product (placed, or shipped) absorbs its share, oldest first,
// until the planned quantity is reached; the gross factory price = factory price + per unit while it lasts.
// Nothing here changes supplier invoices or payments.

const PL = require('./planning');

const KINDS = { mould: 'Mould / tooling', samples: 'Samples', testing: 'Testing / certs', design: 'Design', other: 'Other' };
const STATUSES = { quoted: 'Quoted', paid: 'Paid', refunded: 'Refunded' };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const day = (v) => (v ? String(v).slice(0, 10) : null);
const missing = (e) => /product_dev_|dev_plan_units|PGRST20[45]|relation|column/i.test(e?.message || '');

/** POs of this product (plan_orders of the supplier that match it), oldest first: [{ po, date, qty, shipped }] */
function ordersFor(p, lines, prods) {
  const mine = lines.filter((l) => l.supplier_id === p.supplier_id && PL.catalogMatch(l, prods)?.id === p.id);
  const by = new Map();
  for (const l of mine) {
    const k = PL.normPo(l.po); const o = by.get(k) || { po: l.po, date: null, qty: 0, shipped: true };
    o.qty += Number(l.qty) || 0; const d = day(l.created_at); if (d && (!o.date || d < o.date)) o.date = d; if (!l.shipped) o.shipped = false;
    by.set(k, o);
  }
  return [...by.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

/** Everything the tab and the gross price need. */
function summarize(p, costs, orders) {
  const inc = costs.filter((c) => c.status === 'paid' || (c.status === 'quoted' && p.dev_include_quoted !== false));
  const total = r2(inc.reduce((t, c) => t + (Number(c.amount) || 0), 0));
  const paid = r2(costs.filter((c) => c.status === 'paid').reduce((t, c) => t + (Number(c.amount) || 0), 0));
  const quoted = r2(costs.filter((c) => c.status === 'quoted').reduce((t, c) => t + (Number(c.amount) || 0), 0));
  const plan = Number(p.dev_plan_units) > 0 ? Math.round(Number(p.dev_plan_units)) : null;
  const perUnit = plan && total ? total / plan : null;
  const counted = orders.filter((o) => (p.dev_count === 'shipped' ? o.shipped : true));
  let left = plan || 0; const pos = [];
  for (const o of counted) { const u = plan ? Math.min(o.qty, Math.max(0, left)) : 0; left -= u; pos.push({ ...o, units: u, absorbed: perUnit ? r2(u * perUnit) : 0 }); }
  const units = counted.reduce((t, o) => t + o.qty, 0);
  const absorbedUnits = plan ? Math.min(units, plan) : 0;
  const absorbed = perUnit ? Math.min(total, r2(absorbedUnits * perUnit)) : 0;
  const done = !!plan && units >= plan;
  const price = p.unit_price === null || p.unit_price === undefined || p.unit_price === '' ? null : Number(p.unit_price);
  const gross = price !== null && perUnit && !done ? price + perUnit : price;
  return { n: costs.length, total, paid, quoted, plan, perUnit, units, absorbedUnits, absorbed, remaining: r2(total - absorbed), done, price, gross, pos, inc };
}

/** Load costs, milestones and the product's POs. { costs, milestones, orders, s, missing } */
async function load(db, p) {
  let costs = []; let milestones = []; let miss = false;
  try { costs = await db.list('product_dev_costs', { filters: { product_id: p.id }, order: 'cost_date.asc' }); } catch (e) { if (missing(e)) miss = true; else throw e; }
  try { milestones = await db.list('product_dev_milestones', { filters: { product_id: p.id }, order: 'ms_date.asc' }); } catch (e) { if (missing(e)) miss = true; else throw e; }
  const [lines, prods] = await Promise.all([db.list('plan_orders', { filters: { supplier_id: p.supplier_id } }).catch(() => []), db.list('products', { filters: { supplier_id: p.supplier_id } }).catch(() => [])]);
  const orders = ordersFor(p, lines, prods);
  return { costs, milestones, orders, s: summarize(p, costs, orders), missing: miss };
}

module.exports = { KINDS, STATUSES, summarize, ordersFor, load, missing, r2 };
