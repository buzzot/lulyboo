'use strict';
// Record-only shipments: a shipment kept for its numbers — dates, customs duty, fees, freight, which POs, its
// documents — without tracking. Stored as a plan_containers row with record_only = true:
//   status 'shipped' + delivered_at (so it never shows on Container planning / Load containers / active Shipments),
//   fwd.atd / fwd.ata for the dates, record = { name, pos: [{ sid, po }], duty, fees, freight, entry_no, notes, files }.
//   Customs entries attach to it the normal way (container_id) and count in the customs statistics.
//   No document requests, reminders, broker email, Telegram or payment triggers: PO lines stay where they are unless
//   "also mark these POs' lines as shipped" is ticked.

const PL = require('./planning');
const now = () => new Date().toISOString();
const day = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

/** "310002, PO 610000" → POs known in the portal ({ sid, po }), plus the ones not found. */
async function resolvePos(db, list) {
  const want = [...new Set([].concat(list || []).flatMap((x) => String(x).split(/[\s,;/+&]+/)).map((x) => PL.normPo(x)).filter((x) => /\d{3,}/.test(x)))];
  const lines = await db.list('plan_orders').catch(() => []);
  const found = []; const unknown = [];
  for (const po of want) {
    const l = lines.find((x) => PL.normPo(x.po) === po);
    if (l) found.push({ sid: l.supplier_id, po }); else unknown.push(po);
  }
  return { found, unknown, all: want };
}

/** Create a record. f: { name, atd, ata, duty, fees, freight, entry_no, notes, pos, port, box, mark_shipped, fwd } */
async function create(db, f, { by = null } = {}) {
  const { found, all } = await resolvePos(db, f.pos);
  const atd = day(f.atd); const ata = day(f.ata);
  const fwd = { ...(f.fwd || {}), ...(atd ? { atd } : {}), ...(ata ? { ata, eta: ata, arrived: true } : {}) };
  const c = await db.insert('plan_containers', {
    port: f.port || 'CNYTN', box: ['20GP', '40GP', '40HQ', 'LCL'].includes(f.box) ? f.box : 'LCL', status: 'shipped',
    record_only: true, delivered_at: `${ata || atd || PL.today()}T12:00:00Z`, fwd,
    record: { name: String(f.name || '').trim().slice(0, 120) || null, pos: found, pos_text: all, duty: money(f.duty), fees: money(f.fees), freight: money(f.freight), entry_no: String(f.entry_no || '').trim().slice(0, 40) || null, notes: String(f.notes || '').trim().slice(0, 1000) || null, files: [], by, at: now() },
    created_at: now(), updated_at: now(),
  });
  if (f.mark_shipped) await markShipped(db, found);
  return c;
}

async function update(db, c, f) {
  const { found, all } = await resolvePos(db, f.pos);
  const atd = day(f.atd); const ata = day(f.ata);
  const fwd = { ...(c.fwd || {}), atd: atd || null, ...(ata ? { ata, eta: ata, arrived: true } : { ata: null }) };
  const rec = { ...(c.record || {}), name: String(f.name || '').trim().slice(0, 120) || null, pos: found, pos_text: all, duty: money(f.duty), fees: money(f.fees), freight: money(f.freight), entry_no: String(f.entry_no || '').trim().slice(0, 40) || null, notes: String(f.notes || '').trim().slice(0, 1000) || null };
  // a figure edited by hand no longer comes from its document
  const src = { ...((c.record || {}).src || {}) };
  for (const k of ['duty', 'fees', 'freight', 'entry_no']) if (String((c.record || {})[k] ?? '') !== String(rec[k] ?? '')) delete src[k];
  rec.src = src;
  await db.update('plan_containers', { id: c.id }, { fwd, record: rec, delivered_at: `${ata || atd || day(c.delivered_at) || PL.today()}T12:00:00Z`, updated_at: now() });
  if (f.mark_shipped) await markShipped(db, found);
}

/** The PO lines that are still open become shipped (they stay where they are otherwise). */
async function markShipped(db, pos) {
  const lines = await db.list('plan_orders').catch(() => []);
  for (const l of lines) if (!l.shipped && pos.some((p) => p.sid === l.supplier_id && p.po === PL.normPo(l.po))) await db.update('plan_orders', { id: l.id }, { shipped: true, updated_at: now() }).catch(() => null);
}

async function addFiles(db, c, files, { by = null } = {}) {
  const list = [...((c.record || {}).files || [])];
  for (const u of files) {
    const path = `records/${c.id}/${Date.now().toString(36)}-${String(u.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`;
    await db.docs.upload(path, u.buffer, u.type || 'application/octet-stream');
    list.push({ name: u.name, path, type: u.type || '', by, at: now() });
  }
  await db.update('plan_containers', { id: c.id }, { record: { ...(c.record || {}), files: list }, updated_at: now() });
  return list;
}

/** Prefill a record from a forwarder update's facts. */
function fromUpdate(u) {
  const f = u.facts || {};
  const mr = /PO\s+([\d,\s]+)/i.exec(u.match_reason || '');
  const pos = [...new Set([...(f.pos || []), ...(mr ? mr[1].split(/[,\s]+/) : [])].map((x) => PL.normPo(x)).filter(Boolean))];
  const name = [f.carrier, [f.vessel, f.voyage].filter(Boolean).join(' '), f.mbl_no || f.hbl_no || f.booking_no].filter(Boolean).join(' · ');
  return { name, atd: day(f.atd || f.etd), ata: day(f.ata || f.eta), pos: pos.join(', '), freight: f.ocean_usd ?? '', customs: f.doc_type === 'customs_entry' };
}

module.exports = { create, update, addFiles, markShipped, resolvePos, fromUpdate, money };
