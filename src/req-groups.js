'use strict';
// RFQs & requests grouped by request: the same RFQ sent to several suppliers is one group (same title, or nearly —
// "…with handles, splash guard" and "…with handles and splash guard" are one request). Info requests that are not
// RFQs are a group of their own. Each member: the supplier, its status, the last reply and how long it has waited.

const STOP = new Set(['rfq', 'a', 'an', 'the', 'and', 'with', 'for', 'of', 'to', 'in', 'on', 'at', 're', 'fw', 'fwd', 'quote', 'please']);
const words = (s) => new Set(String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/lb-\d+/g, ' ').replace(/[^a-z0-9$.]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
/** Title shown once: the subject without "RFQ:" and the LB- reference. */
const titleOf = (r) => String(r.subject || '').replace(/\[[^\]]*LB-\d+[^\]]*\]/gi, '').replace(/\bLB-\d+\b/gi, '').replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').replace(/^\s*RFQ\s*[:：-]\s*/i, '').replace(/\s+/g, ' ').trim() || 'Request';
const DONE = ['Complete', 'Closed'];
const day = (v) => String(v || '').slice(0, 10);
const daysSince = (iso, today) => Math.max(0, Math.round((Date.parse(today) - Date.parse(day(iso))) / 864e5));

/** rows: info_requests; msgs: info_request_messages; names: { supplierId: name }. Returns groups, most urgent first. */
function group(rows, msgs, names, { today = new Date().toISOString().slice(0, 10), infoTitle = (r) => titleOf(r) } = {}) {
  const byReq = new Map(); for (const m of msgs) { if (!byReq.has(m.request_id)) byReq.set(m.request_id, []); byReq.get(m.request_id).push(m); }
  const groups = [];
  for (const r of rows.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const ms = (byReq.get(r.id) || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const ins = ms.filter((m) => m.direction === 'in'); const last = ins[ins.length - 1] || null;
    const replied = !!last || ['Replied', 'Complete'].includes(r.status);
    const waited = daysSince(r.created_at, today);
    const mem = { r, supplier: names[r.supplier_id] || 'Supplier', last, replied, done: DONE.includes(r.status), waited, late: !replied && !DONE.includes(r.status) && waited >= 14,
      reply: last ? (last.ai?.headline || String(last.body || '').replace(/\s+/g, ' ').trim().slice(0, 110)) : null, repliedAt: last?.created_at || null, outFirst: ms.find((m) => m.direction === 'out') || null };
    const isRfq = r.kind === 'rfq' || /^\s*rfq\b/i.test(r.subject || '');
    const w = words(titleOf(r));
    const g = isRfq ? groups.find((x) => x.rfq && (x.title.toLowerCase() === titleOf(r).toLowerCase() || jaccard(x.w, w) >= 0.75)) : null;
    if (g) g.members.push(mem);
    else groups.push({ id: r.id, rfq: isRfq, title: isRfq ? titleOf(r) : infoTitle(r), w, kind: isRfq ? `RFQ${r.channel ? ` · ${r.channel}` : ''}` : 'Request', members: [mem] });
  }
  for (const g of groups) {
    const m = g.members;
    g.n = m.length; g.replied = m.filter((x) => x.replied).length; g.waiting = m.filter((x) => !x.replied && !x.done);
    g.open = m.some((x) => !x.done); g.late = m.some((x) => x.late);
    g.first = day(m[0].r.created_at); g.lastSent = day(m[m.length - 1].r.created_at);
    g.latest = m.map((x) => x.repliedAt || x.r.updated_at || x.r.created_at).sort().pop();
    m.sort((a, b) => (b.replied - a.replied) || String(b.repliedAt || '').localeCompare(String(a.repliedAt || '')) || a.supplier.localeCompare(b.supplier));
  }
  // needing action first (late, then waiting), then the newest
  return groups.sort((a, b) => (b.open - a.open) || (b.late - a.late) || String(b.lastSent).localeCompare(String(a.lastSent)));
}

/** Facts from each supplier's latest reply (AI summary), side by side: { labels, cols: [{ mem, facts: {label: value} }] }. */
function compare(g) {
  const cols = g.members.filter((x) => x.last).map((x) => ({ mem: x, facts: Object.fromEntries((x.last.ai?.facts || []).map((f) => [String(f.label || '').trim(), String(f.value || '').trim()]).filter(([k, v]) => k && v)) }));
  const count = new Map(); for (const c of cols) for (const k of Object.keys(c.facts)) count.set(k.toLowerCase(), (count.get(k.toLowerCase()) || 0) + 1);
  const labels = []; const seen = new Set();
  for (const c of cols) for (const k of Object.keys(c.facts)) { const lk = k.toLowerCase(); if (!seen.has(lk)) { seen.add(lk); labels.push(k); } }
  labels.sort((a, b) => (count.get(b.toLowerCase()) - count.get(a.toLowerCase())));
  const val = (c, label) => { const k = Object.keys(c.facts).find((x) => x.toLowerCase() === label.toLowerCase()); return k ? c.facts[k] : null; };
  return { labels: labels.slice(0, 20), cols, val };
}

module.exports = { group, compare, titleOf, words, jaccard };
