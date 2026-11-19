'use strict';
// One name per shipment, everywhere (Shipments, planning, forwarders, customs, payments, emails, Telegram).
// It uses the best real identifier known so far:
//   container known (FCL)  → "ZCSU 7687624 · 20′ GP · Yantian → LA"
//   LCL with a house B/L   → "HBL HKAL2611031A · LCL · Yantian → LA"
//   booked                 → "YN0013 · Yantian → LA · 20′ GP"
//   only planned           → "Yantian · sails ~Dec 1 · 20′ GP"
// The old "Container 1" was just a running count per port and is only kept on the planning board for boxes with
// no identifier yet.

const BOX = { '20GP': '20′ GP', '40GP': '40′ GP', '40HQ': '40′ HQ', LCL: 'LCL' };
const day = (v) => (v ? String(v).slice(0, 10) : null);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => (d ? `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : '');
const clean = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCont = (v) => { const t = clean(v); return /^[A-Z]{4}\d{7}$/.test(t) ? `${t.slice(0, 4)} ${t.slice(4)}` : String(v || '').trim(); };
const portName = (code) => { try { return require('./schedules').PORT[code]?.name || code || ''; } catch { return code || ''; } };
const podShort = (pod) => { const p = String(pod || ''); if (!p || /los angeles|long beach|\bLAX\b|\bLGB\b|USLAX|USLGB/i.test(p)) return 'LA'; return p.split(/[,(]/)[0].trim().slice(0, 18); };

/** The identifier alone: container no. (FCL), house B/L (LCL), booking no., or null. */
function shipRef(c) {
  if (!c) return null;
  const f = c.fwd || {};
  const cno = f.container_no || c.container_no;
  if (c.box !== 'LCL' && clean(cno).length >= 6) return fmtCont(cno);
  if (c.box === 'LCL' && f.hbl_no) return `HBL ${f.hbl_no}`;
  if (f.booking_no) return String(f.booking_no).trim();
  if (clean(cno).length >= 6) return fmtCont(cno);
  return null;
}

/** Full name of a container / LCL shipment. `sailing` (optional) gives the planned ETD. */
function shipName(c, { sailing = null } = {}) {
  if (!c) return '';
  const f = c.fwd || {};
  const box = BOX[c.box] || c.box || '';
  const route = `${portName(c.port)} → ${podShort(f.pod)}`;
  const cno = f.container_no || c.container_no;
  if (c.box !== 'LCL' && clean(cno).length >= 6) return `${fmtCont(cno)} · ${box} · ${route}`;
  if (c.box === 'LCL' && f.hbl_no) return `HBL ${f.hbl_no} · LCL · ${route}`;
  if (f.booking_no) return `${String(f.booking_no).trim()} · ${route} · ${box}`;
  const etd = day(f.atd || f.etd || sailing?.etd || (c.sailing && c.sailing.etd) || c.loading_date);
  return `${portName(c.port)} · ${etd ? `sails ~${short(etd)}` : 'not scheduled yet'} · ${box}`;
}

/** Names for many containers at once; two planned boxes with the same name get " #2", " #3". */
function shipNames(list, sailings = {}) {
  const out = {}; const seen = {};
  for (const c of list) {
    let n = shipName(c, { sailing: sailings[c.sailing_id] || null });
    seen[n] = (seen[n] || 0) + 1; if (seen[n] > 1) n = `${n} #${seen[n]}`;
    out[c.id] = n;
  }
  return out;
}

module.exports = { shipName, shipNames, shipRef, fmtCont, BOX };
