'use strict';
// Split a PO line by quantity (whole cartons) into linked parts, and merge parts back.
//   Root = the original line (split_of null, split_no 1 once split). Parts: split_of = root id, split_no 2, 3…
//   Quantity, cartons, m³ and kg divide by cartons; without carton data by pieces (m³ then marked estimated).
//   Parts that end up in the same place (same container, or both not loaded) join again automatically.

const now = () => new Date().toISOString();
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const num = (v) => (v == null || v === '' ? null : Number(v));
const COPY_SKIP = new Set(['id', 'created_at', 'updated_at', 'container_id', 'split_of', 'split_no', 'shipped']);
const rootOf = (l) => l.split_of || l.id;

async function partsOf(db, l) {
  const root = rootOf(l);
  const all = await db.list('plan_orders', { filters: { supplier_id: l.supplier_id } }).catch(() => []);
  return all.filter((x) => x.id === root || x.split_of === root).sort((a, b) => (a.split_no || 1) - (b.split_no || 1));
}

/** Amounts for a part of `keep` cartons (or pieces when the line has no carton count). */
function divide(l, keep) {
  const ctn = num(l.cartons); const qty = num(l.qty); const cbm = num(l.cbm); const kg = num(l.gross_kg); const upc = num(l.units_per_carton);
  const byCtn = ctn > 1;
  const whole = byCtn ? ctn : qty;
  if (!(whole > 1)) throw Object.assign(new Error('This line has only one carton / piece — nothing to split'), { status: 400 });
  const k = Math.round(Number(keep));
  if (!(k >= 1 && k < whole)) throw Object.assign(new Error(`Keep between 1 and ${whole - 1} ${byCtn ? 'cartons' : 'pcs'}`), { status: 400 });
  const ratio = k / whole;
  const keepQty = qty == null ? null : byCtn ? (upc > 0 && upc * ctn === qty ? k * upc : Math.max(1, Math.min(qty - 1, Math.round(qty * ratio)))) : k;
  const a = {
    cartons: byCtn ? k : ctn != null ? Math.max(0, Math.round(ctn * ratio)) || null : null,
    qty: keepQty, cbm: cbm == null ? null : r2(cbm * ratio), gross_kg: kg == null ? null : r1(kg * ratio),
  };
  const b = {
    cartons: ctn == null ? null : ctn - (a.cartons || 0) || null,
    qty: qty == null ? null : qty - keepQty, cbm: cbm == null ? null : r2(cbm - a.cbm), gross_kg: kg == null ? null : r1(kg - a.gross_kg),
  };
  return { byCtn, a, b, estimated: !byCtn && cbm != null };
}

/** Split line `l`: it keeps `keep` cartons (or pcs); a new part with the rest goes to `toContainer` (null = not loaded). */
async function split(db, l, keep, { toContainer = null, by = null } = {}) {
  if (l.shipped) throw Object.assign(new Error('This line has shipped'), { status: 400 });
  const d = divide(l, keep);
  const root = rootOf(l);
  const parts = await partsOf(db, l);
  const next = Math.max(1, ...parts.map((p) => p.split_no || 1)) + 1;
  const copy = {}; for (const [k, v] of Object.entries(l)) if (!COPY_SKIP.has(k)) copy[k] = v;
  const est = d.estimated || !!l.cbm_estimated;
  await db.update('plan_orders', { id: l.id }, { ...d.a, split_no: l.split_no || 1, cbm_estimated: est, updated_at: now() });
  const row = await db.insert('plan_orders', { ...copy, ...d.b, cbm_estimated: est, split_of: root, split_no: next, container_id: toContainer, shipped: false, notes: [l.notes, `Split from ${l.po}${by ? ` by ${by}` : ''} ${now().slice(0, 10)}`].filter(Boolean).join(' · ').slice(0, 2000), created_at: now(), updated_at: now() });
  return { kept: { ...l, ...d.a, split_no: l.split_no || 1, cbm_estimated: est }, part: row };
}

/** Join parts that sit in the same place. Returns ids removed and the surviving line per place. */
async function settle(db, l) {
  const parts = (await partsOf(db, l)).filter((p) => !p.shipped);
  if (parts.length < 2) return { removed: [], kept: [] };
  const byPlace = new Map();
  for (const p of parts) { const k = p.container_id || ''; if (!byPlace.has(k)) byPlace.set(k, []); byPlace.get(k).push(p); }
  const removed = []; const kept = [];
  for (const group of byPlace.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;   // lowest part number survives (the root when it's there)
    const sum = (k) => (group.some((p) => p[k] != null) ? group.reduce((s, p) => s + (Number(p[k]) || 0), 0) : null);
    const patch = { qty: sum('qty'), cartons: sum('cartons'), cbm: sum('cbm') == null ? null : r2(sum('cbm')), gross_kg: sum('gross_kg') == null ? null : r1(sum('gross_kg')), cbm_estimated: group.some((p) => p.cbm_estimated), updated_at: now() };
    await db.update('plan_orders', { id: keep.id }, patch);
    for (const p of rest) { await db.remove('plan_orders', { id: p.id }); removed.push(p.id); }
    kept.push({ ...keep, ...patch });
  }
  // a single remaining line is whole again
  const left = (await partsOf(db, l)).filter((p) => !p.shipped);
  const shippedParts = (await partsOf(db, l)).filter((p) => p.shipped);
  if (left.length === 1 && !shippedParts.length) {
    const only = left[0];
    if (only.id === rootOf(only)) await db.update('plan_orders', { id: only.id }, { split_no: null });
  }
  return { removed, kept };
}

/** Merge a part back into the other open parts of the same line (joins them wherever the other part is). */
async function mergeBack(db, l) {
  const parts = (await partsOf(db, l)).filter((p) => !p.shipped);
  const others = parts.filter((p) => p.id !== l.id);
  if (!others.length) throw Object.assign(new Error('Nothing to merge with'), { status: 400 });
  const target = others[0];
  await db.update('plan_orders', { id: l.id }, { container_id: target.container_id || null, updated_at: now() });
  return settle(db, { ...l, container_id: target.container_id || null });
}

module.exports = { divide, split, settle, mergeBack, partsOf, rootOf };
