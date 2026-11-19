'use strict';
// Per-PO shipping documents: every PO in a shipment needs its own commercial invoice (CI) and packing list (PL),
// above all when the container carries goods from several suppliers.
//   A supplier file counts for a PO when that PO is linked to it (a file naming several POs counts for each), or
//   when it came in on the shipping-document request that covers the PO.
//   A proforma invoice (PI) is not a CI. A combined "PI & PL" sheet counts as the packing list only.
//   Once the container is shipped, anything missing is an alert, and can be requested from the supplier(s) by
//   email through each PO's shipping-document request (its LBS code, follow-ups, AI filing of the reply).

const PL = require('./planning');

// letters-only boundaries: "PI_MTY", "CI&PL", "PL-500024" all count
const tok = (t) => new RegExp(`(?<![A-Za-z])${t}(?![A-Za-z])`);
const isPL = (f) => /packing/i.test(f.kind || '') || tok('P\\.?L').test(f.name || '') || /packing/i.test(f.name || '');
const isPI = (f) => /proforma/i.test(f.kind || '') || tok('P\\.?I').test(f.name || '') || /proforma|pro-forma/i.test(f.name || '');
const isCI = (f) => tok('C\\.?I').test(f.name || '') || /commercial/i.test(f.name || '');
const isInvoiceKind = (f) => /invoice/i.test(f.kind || '') || isCI(f) || /invoice/i.test(f.name || '');
/** 'CI' | 'PI' | 'PL' | 'PIPL' (combined: counts as PL) | null */
function classify(f) {
  const pl = isPL(f); const pi = isPI(f);
  // "CL&PL" is a common typo for CI&PL: next to a packing list it counts as the commercial invoice
  if (pl && !pi && tok('CL').test(f.name || '')) return 'CIPL';
  if (pl && (pi || isCI(f) || /invoice/i.test(f.name || ''))) return isCI(f) && !pi ? 'CIPL' : 'PIPL';
  if (pl) return 'PL';
  if (pi) return 'PI';
  if (isInvoiceKind(f)) return 'CI';
  return null;
}
const LABEL = { CI: 'commercial invoice', PL: 'packing list' };
const ASK = {
  CI: (po) => `Commercial invoice for PO ${po} (the final invoice, not the proforma)`,
  PL: (po) => `Packing list for PO ${po} (cartons, pieces, gross weight and CBM)`,
  BL: (po) => `Bill of lading for PO ${po} (draft or final)`,
  WR: (po) => `Warehouse receipt for PO ${po}`,
  PH: (po) => `Loading photos for PO ${po} (door open, and door closed with the seal)`,
};
/** What can be asked for in the per-PO request dialog. */
const KINDS = [['CI', 'Commercial invoice'], ['PL', 'Packing list'], ['BL', 'Bill of lading'], ['WR', 'Warehouse receipt'], ['PH', 'Loading photos']];

/**
 * The document state of each PO in a container. Pass preloaded rows (lines, files, scs, sups) to avoid queries
 * when checking many containers.
 */
async function check(db, c, pre = {}) {
  const lines = (pre.lines || await db.list('plan_orders').catch(() => [])).filter((l) => l.container_id === c.id);
  const scs = (pre.scs || await db.list('ship_confirmations').catch(() => [])).filter((s) => s.status !== 'cancelled');
  const files = pre.files || await db.list('plan_files').catch(() => []);
  const sups = pre.sups || Object.fromEntries((await db.list('suppliers', { select: 'id,name,email' }).catch(() => [])).map((s) => [s.id, s]));
  const map = new Map();
  for (const l of lines) { const k = `${l.supplier_id}|${PL.normPo(l.po)}`; if (!map.has(k)) map.set(k, { sid: l.supplier_id, supplier: sups[l.supplier_id]?.name || 'Supplier', email: sups[l.supplier_id]?.email || '', po: l.po, lines: [] }); map.get(k).lines.push(l); }
  const pos = [...map.values()].map((p) => {
    const mineSc = scs.filter((s) => s.supplier_id === p.sid && (s.pos || []).some((x) => PL.normPo(x) === PL.normPo(p.po)));
    const scIds = new Set(mineSc.map((s) => s.id));
    const fs = files.filter((f) => f.supplier_id === p.sid && ((f.pos || []).some((x) => PL.normPo(x) === PL.normPo(p.po)) || (scIds.has(f.shipment_id) && !(f.pos || []).length)));
    const ci = []; const pl = []; const pi = [];
    for (const f of fs) { const t = classify(f); if (t === 'CI') ci.push(f); else if (t === 'PL' || t === 'PIPL') pl.push(f); else if (t === 'CIPL') { ci.push(f); pl.push(f); } else if (t === 'PI') pi.push(f); }
    const missing = [...(ci.length ? [] : ['CI']), ...(pl.length ? [] : ['PL'])];
    const sc = mineSc.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
    const asked = mineSc.flatMap((s) => (s.log || []).filter((x) => /Follow-up|Request sent|Reminder|Asked for/i.test(x.text || '')).map((x) => x.at)).sort().pop() || null;
    return { ...p, ci, pl, pi, missing, sc, asked };
  }).sort((a, b) => a.supplier.localeCompare(b.supplier) || String(a.po).localeCompare(String(b.po)));
  const f = c.fwd || {};
  const shipped = c.status === 'shipped' || !!f.atd || !!c.delivered_at;
  const open = pos.filter((p) => p.missing.length);
  return { pos, open, shipped, alert: shipped && !c.delivered_at && open.length > 0, suppliers: [...new Set(open.map((p) => p.sid))] };
}

/**
 * Email the suppliers: items = [{sid, po, kind: 'CI'|'PL'|'BL'|'WR'|'PH'|'OTHER', text?}]. One email per supplier,
 * through its PO's request. By default only missing CI / PL are asked; `any` (the per-PO dialog) sends what was ticked.
 */
async function request(db, config, c, items, { by = null, any = false, note = '' } = {}) {
  const SD = require('./shipdocs');
  const st = await check(db, c);
  const bySup = new Map();
  for (const it of items) {
    const p = st.pos.find((x) => x.sid === it.sid && PL.normPo(x.po) === PL.normPo(it.po)); if (!p) continue;
    if (it.kind === 'OTHER' ? !any || !String(it.text || '').trim() : !ASK[it.kind] || (!any && !p.missing.includes(it.kind))) continue;
    if (!bySup.has(p.sid)) bySup.set(p.sid, []); bySup.get(p.sid).push({ p, kind: it.kind, text: String(it.text || '').trim().slice(0, 300) });
  }
  const sent = []; const failed = [];
  for (const [sid, list] of bySup) {
    const name = list[0].p.supplier;
    try {
      let sc = list.map((x) => x.p.sc).find(Boolean) || null;
      if (!sc) sc = await SD.createFor(db, { supplierId: sid, po: list[0].p.po });
      if (sc && !sc.id) sc = (await db.list('ship_confirmations', { filters: { supplier_id: sid } })).find((x) => x.status !== 'cancelled' && (x.pos || []).some((q) => PL.normPo(q) === PL.normPo(list[0].p.po)));
      if (!sc) throw new Error('no shipping-document request for this PO');
      const asks = list.map((x) => (x.kind === 'OTHER' ? x.text : ASK[x.kind](x.p.po)));
      const perPo = list.some((x) => x.kind === 'CI' || x.kind === 'PL');
      const pos = [...new Set(list.map((x) => x.p.po))];
      const kind = ['received', 'complete', 'sent'].includes(sc.status) ? 'missing' : 'request';
      const sailed = c.fwd?.atd ? ` sailed on ${PL.short(String(c.fwd.atd).slice(0, 10))}` : ' has shipped';
      const eta = c.fwd?.ata || c.fwd?.eta ? ` (ETA ${PL.short(String(c.fwd.ata || c.fwd.eta).slice(0, 10))})` : '';
      await SD.sendRequest(db, config, sc, { kind, by, edits: {
        subject: `Shipping documents needed – PO ${pos.join(', ')}`,
        intro: `Our shipment with PO ${pos.join(', ')}${sailed}${eta}.${perPo ? ' Our customs broker needs a separate commercial invoice and packing list for each PO.' : ''} Please reply to this email with the documents below attached.${String(note || '').trim() ? `\n\n${String(note).trim().slice(0, 1000)}` : ''}`,
        items: asks, received: false,
      } });
      const fresh = await db.get('ship_confirmations', sc.id).catch(() => sc);
      await db.update('ship_confirmations', { id: sc.id }, { log: [...(fresh.log || []), { at: new Date().toISOString(), text: `Asked for ${list.map((x) => `${x.kind === 'OTHER' ? x.text : x.kind} ${x.p.po}`).join(', ')}${by ? ` (${by})` : ''}` }].slice(-60) }).catch(() => null);
      sent.push(name);
    } catch (e) { failed.push(`${name}: ${e.message}`); }
  }
  return { sent, failed };
}

module.exports = { classify, check, request, LABEL, ASK, KINDS };
