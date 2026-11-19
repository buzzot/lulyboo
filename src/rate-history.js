'use strict';
// Freight rate history: a permanent copy of every priced forwarder quote, for comparing forwarders and prices.
// Quotes live on containers (plan_quotes) and go when a container is deleted or re-planned; this copy stays.
// Copied when AI reads a reply, when you edit or choose a quote, before a container is deleted, and once for
// older quotes (syncAll). Volume and weight are taken when the quote is first copied — what you asked for.
// Comparing like for like: same lane (loading port → LA / Long Beach or other), same container type; LCL per W/M.

const PL = require('./planning');
const SC = require('./schedules');
const Q = require('./quotes');

const now = () => new Date().toISOString();
const LALB = ['USLAX', 'USLGB'];
const portName = (c) => SC.PORT[c]?.name || c || '';
const podName = (c) => (!c || c === 'LALB' ? 'Los Angeles / Long Beach' : portName(c));
const laneOf = (r) => `${r.pol}>${r.pod || 'LALB'}`;
const laneName = (k) => { const [a, b] = String(k).split('>'); return `${portName(a)} → ${podName(b)}`; };
const missingTable = (e) => /freight_quotes|PGRST20[45]|relation/i.test(e?.message || '');
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** The price fields copied from a quote (updated on every sync). */
function priceFields(q) {
  return {
    company: q.company || null, forwarder_id: q.forwarder_id || null, code: q.code,
    quoted_on: String(q.replied_at || q.updated_at || q.created_at || now()).slice(0, 10),
    currency: q.currency || 'USD', ocean_usd: q.ocean_usd ?? null, total_usd: q.total_usd ?? q.ocean_usd ?? null,
    charges: Array.isArray(q.charges) ? q.charges : [], carrier: q.carrier || null, vessel: q.vessel || null,
    etd: q.etd || null, eta: q.eta || null, transit_days: q.transit_days ?? null, valid_until: q.valid_until || null, free_days: q.free_days ?? null,
    reply_hours: q.sent_at && q.replied_at ? Math.max(0, Math.round((Date.parse(q.replied_at) - Date.parse(q.sent_at)) / 36e5)) : null,
    chosen: q.status === 'chosen',
  };
}

/** Copy one quote (insert or update). Quotes without a price are skipped. */
async function sync(db, q, { container = null } = {}) {
  if (!q || (q.total_usd == null && q.ocean_usd == null)) return null;
  const have = (await db.list('freight_quotes', { filters: { quote_id: q.id }, limit: 1 }))[0];
  const p = priceFields(q);
  if (have) {
    const wm = have.wm;
    await db.update('freight_quotes', { id: have.id }, { ...p, per_wm: have.box === 'LCL' && wm ? r2(p.total_usd / wm) : null, updated_at: now() });
    return have.id;
  }
  const c = container || await db.get('plan_containers', q.container_id).catch(() => null);
  const lines = c ? await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => []) : [];
  const cbm = r2(lines.reduce((s, l) => s + (Number(l.cbm) || 0), 0)) || null;
  const kg = lines.every((l) => Number(l.gross_kg) > 0) && lines.length ? Math.round(lines.reduce((s, l) => s + Number(l.gross_kg), 0)) : null;
  const sail = c?.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
  const pod = sail?.destination && !LALB.includes(sail.destination) ? sail.destination : 'LALB';
  const box = c?.box || '40GP';
  const wm = box === 'LCL' && cbm ? r2(kg ? Q.freightTons(cbm, kg) : cbm) : null;
  const row = await db.insert('freight_quotes', {
    quote_id: q.id, container_id: c?.id || null, pol: c?.port || 'CN', pod, box, cbm, kg, wm,
    ...p, per_wm: wm && p.total_usd != null ? r2(p.total_usd / wm) : null, excluded: false, created_at: now(), updated_at: now(),
  });
  return row.id;
}

/** A booking confirmation's rate goes into the history too (one row per container + booking number). */
async function recordBooking(db, c, fwd) {
  if (!fwd || !(Number(fwd.ocean_usd) > 0)) return null;
  try {
    // the chosen quote is already in the history — the booking only adds a rate quoted outside the portal
    const qs = await db.list('plan_quotes', { filters: { container_id: c.id } }).catch(() => []);
    if (qs.some((q) => q.status === 'chosen' && (q.total_usd != null || q.ocean_usd != null))) return null;
    const code = fwd.booking_no || 'booking';
    const have = (await db.list('freight_quotes', { filters: { container_id: c.id } })).find((r) => !r.quote_id && r.code === code);
    const lines = await db.list('plan_orders', { filters: { container_id: c.id } }).catch(() => []);
    const cbm = r2(lines.reduce((s, l) => s + (Number(l.cbm) || 0), 0)) || null;
    const kg = lines.length && lines.every((l) => Number(l.gross_kg) > 0) ? Math.round(lines.reduce((s, l) => s + Number(l.gross_kg), 0)) : null;
    const wm = c.box === 'LCL' && cbm ? r2(kg ? Q.freightTons(cbm, kg) : cbm) : null;
    const days = String(fwd.transit || '').match(/\d+/g);
    const row = {
      company: fwd.forwarder || null, code, quoted_on: String(fwd.updated_at || now()).slice(0, 10), currency: 'USD',
      ocean_usd: Number(fwd.ocean_usd), total_usd: Number(fwd.ocean_usd), carrier: fwd.carrier || null, vessel: [fwd.vessel, fwd.voyage].filter(Boolean).join(' ') || null,
      etd: fwd.etd || null, eta: fwd.eta || null, transit_days: days ? Math.max(...days.map(Number)) : null, valid_until: fwd.rate_valid || null,
      chosen: true, per_wm: wm ? r2(Number(fwd.ocean_usd) / wm) : null, updated_at: now(),
    };
    if (have) { await db.update('freight_quotes', { id: have.id }, row); return have.id; }
    const sail = c.sailing_id ? await db.get('sailings', c.sailing_id).catch(() => null) : null;
    const ins = await db.insert('freight_quotes', { ...row, quote_id: null, container_id: c.id, pol: c.port, pod: sail?.destination && !LALB.includes(sail.destination) ? sail.destination : 'LALB', box: c.box || '40GP', cbm, kg, wm, excluded: false, created_at: now() });
    return ins.id;
  } catch (e) { if (missingTable(e)) return null; throw e; }
}

/** Copy all quotes of a container (after choosing — the others change too — and before it is deleted). */
async function syncContainer(db, containerId) {
  try {
    const c = await db.get('plan_containers', containerId).catch(() => null);
    for (const q of await db.list('plan_quotes', { filters: { container_id: containerId } }).catch(() => [])) await sync(db, q, { container: c });
  } catch (e) { if (!missingTable(e)) console.error('Rate history sync failed:', e.message); }
}
async function syncQuote(db, quoteId) {
  try { await sync(db, await db.get('plan_quotes', quoteId)); } catch (e) { if (!missingTable(e)) console.error('Rate history sync failed:', e.message); }
}

/** Copy priced quotes that aren't in the history yet (older quotes; safety net). */
async function syncAll(db) {
  const have = new Set((await db.list('freight_quotes')).map((r) => r.quote_id));
  for (const q of await db.list('plan_quotes').catch(() => [])) if (!have.has(q.id) && (q.total_usd != null || q.ocean_usd != null)) await sync(db, q).catch(() => null);
}

/** The price compared: all-in or ocean; LCL per W/M. */
function priceOf(r, basis = 'allin') {
  const v = basis === 'ocean' ? r.ocean_usd : r.total_usd;
  if (v == null) return null;
  if (r.box === 'LCL') return r.wm ? r2(Number(v) / r.wm) : null;
  return Number(v);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** A request round = one container's quotes. */
function rounds(rows) {
  const by = new Map();
  for (const r of rows) { const k = r.container_id || `q-${r.quote_id}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.entries()].map(([k, rs]) => ({ key: k, rows: rs, on: rs.map((r) => r.quoted_on).sort()[0] })).sort((a, b) => b.on.localeCompare(a.on));
}

/** Per forwarder on one lane + type: quotes, median, times cheapest in its round, won, reply hours, transit. */
function forwarderStats(rows, basis = 'allin') {
  const cheapest = new Set();
  for (const rd of rounds(rows)) {
    const priced = rd.rows.map((r) => [r, priceOf(r, basis)]).filter(([, v]) => v != null);
    if (priced.length < 2) continue;
    const lo = Math.min(...priced.map(([, v]) => v));
    for (const [r, v] of priced) if (v === lo) cheapest.add(r.id);
  }
  const by = new Map();
  for (const r of rows) { const k = r.forwarder_id || r.company; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.values()].map((rs) => {
    const ps = rs.map((r) => priceOf(r, basis)).filter((v) => v != null);
    const rh = rs.map((r) => r.reply_hours).filter((v) => v != null);
    const td = rs.map((r) => r.transit_days).filter((v) => v != null);
    const last = [...rs].sort((a, b) => b.quoted_on.localeCompare(a.quoted_on))[0];
    return { company: rs[0].company, n: rs.length, median: median(ps), last: priceOf(last, basis), lastOn: last.quoted_on, cheapest: rs.filter((r) => cheapest.has(r.id)).length, won: rs.filter((r) => r.chosen).length, reply: median(rh), transit: median(td) };
  }).sort((a, b) => (a.median ?? 1e12) - (b.median ?? 1e12));
}

/**
 * Your quotes for a saved freight rate (Costs & rates): same container type, to LA / Long Beach, last `days` days,
 * ocean line only (local charges are the rate's "fees / shipment"). LCL per W/M. Returns null when there are none.
 */
const BOX_OF = { FCL_20GP: '20GP', FCL_40GP: '40GP', FCL_40HQ: '40HQ', LCL: 'LCL' };
function quoteStats(rows, option, { days = 90, today = new Date().toISOString().slice(0, 10) } = {}) {
  const box = BOX_OF[option.mode]; if (!box) return null;
  const since = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  const pick = (rows || []).filter((r) => !r.excluded && r.box === box && (r.pod || 'LALB') === 'LALB' && String(r.quoted_on || '') >= since)
    .map((r) => ({ r, v: box === 'LCL' ? (r.ocean_usd != null && r.wm ? r.ocean_usd / r.wm : null) : (r.ocean_usd ?? null) }))
    .filter((x) => x.v != null && x.v > 0);
  if (!pick.length) return null;
  const vals = pick.map((x) => x.v);
  const med = r2(median(vals));
  const latest = pick.sort((a, b) => String(b.r.quoted_on).localeCompare(String(a.r.quoted_on)))[0].r;
  const rate = Number(option.rate_usd) || 0;
  return { n: pick.length, median: med, low: r2(Math.min(...vals)), high: r2(Math.max(...vals)), gap_pct: rate ? Math.round(((rate - med) / med) * 100) : null,
    latest: { company: latest.company || '', on: latest.quoted_on, valid_until: latest.valid_until || null }, unit: box === 'LCL' ? '/W/M' : '/ctr' };
}

module.exports = { quoteStats, BOX_OF, recordBooking, sync, syncContainer, syncQuote, syncAll, priceOf, median, rounds, forwarderStats, laneOf, laneName, podName, missingTable };
