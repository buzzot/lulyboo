'use strict';
// Suppliers list: per supplier, what is ongoing now (open POs, development projects, samples) and the one next
// thing to do (the most overdue / soonest item from POs, inspections, shipping documents, development questions,
// samples and CRM follow-ups). Read-only: nothing new to enter.

const PL = require('./planning');

const day = (v) => (v ? String(v).slice(0, 10) : null);
const addDays = (d, n) => PL.addDays(d, n);
const short = (d) => (d ? PL.short(day(d)) : '');

/** { bySupplier: Map(id → { pos, dev, samples, items, next, waiting, lastAt }), today } */
async function build(db, { today = PL.today() } = {}) {
  const L = (t, o) => db.list(t, o).catch(() => []);
  const [orders, invs, projects, msgs, samples, insps, scs, acts] = await Promise.all([
    L('plan_orders'), L('dev_invitations'), L('dev_projects'), L('dev_messages', { order: 'created_at.asc' }), L('samples'), L('inspections'), L('ship_confirmations'),
    L('supplier_activities', { select: 'supplier_id,activity_date', order: 'activity_date.desc' }),
  ]);
  const open = await require('./crm').openItems(db).catch(() => []);
  const SM = require('./samples');
  const soon = addDays(today, 7);
  const out = new Map();
  const get = (id) => { if (!out.has(id)) out.set(id, { pos: [], dev: [], samples: [], items: [], waiting: false, lastAt: null }); return out.get(id); };
  const item = (sid, o) => { if (!sid) return; const lvl = o.level || (o.date && o.date < today ? 'late' : o.date && o.date <= soon ? 'soon' : ''); get(sid).items.push({ ...o, level: lvl }); };
  const seen = (sid, at) => { if (!sid || !at) return; const g = get(sid); if (!g.lastAt || String(at) > String(g.lastAt)) g.lastAt = String(at); };

  // open POs (not shipped)
  const poMap = new Map();
  for (const l of orders) {
    if (l.shipped) continue;
    const k = `${l.supplier_id}|${PL.normPo(l.po)}`;
    const p = poMap.get(k) || { supplier_id: l.supplier_id, po: l.po, ready: null, pending: null };
    const rd = day(l.ready_date); if (rd && (!p.ready || rd < p.ready)) p.ready = rd;
    if (l.pending_from_us && !p.pending) p.pending = String(l.pending_from_us).slice(0, 80);
    poMap.set(k, p); seen(l.supplier_id, l.updated_at);
  }
  for (const p of poMap.values()) {
    get(p.supplier_id).pos.push(p);
    if (p.pending) { get(p.supplier_id).waiting = true; item(p.supplier_id, { kind: 'reply', label: 'Reply to supplier', sub: `PO ${p.po} · waiting for: ${p.pending}`, date: today, level: 'late', href: `/admin/orders/view?supplier=${p.supplier_id}&po=${encodeURIComponent(p.po)}` }); }
    else if (p.ready) item(p.supplier_id, { kind: 'ready', label: p.ready < today ? `Ready since ${short(p.ready)}` : `PO ready ${short(p.ready)}`, sub: `PO ${p.po}`, date: p.ready, level: p.ready <= addDays(today, 14) ? 'soon' : '', href: `/admin/orders/view?supplier=${p.supplier_id}&po=${encodeURIComponent(p.po)}` });
  }
  for (const s of out.values()) s.pos.sort((a, b) => String(a.ready || '9').localeCompare(String(b.ready || '9')));

  // development
  for (const i of invs) {
    if (['Declined', 'Closed'].includes(i.status)) continue;
    const pj = projects.find((p) => p.id === i.project_id); if (!pj || ['Completed', 'Cancelled'].includes(pj.status)) continue;
    const ms = msgs.filter((m) => m.invitation_id === i.id); const last = ms[ms.length - 1];
    const href = `/admin/projects/${pj.id}/suppliers/${i.id}`;
    get(i.supplier_id).dev.push({ name: pj.name, status: i.status, href, question: last?.direction === 'supplier' });
    seen(i.supplier_id, last?.created_at || i.updated_at);
    if (last?.direction === 'supplier') { get(i.supplier_id).waiting = true; item(i.supplier_id, { kind: 'reply', label: 'Reply to question', sub: `${pj.name} · since ${short(last.created_at)}`, date: day(last.created_at), level: 'late', href }); }
    else if (['Invited', 'Viewed'].includes(i.status)) item(i.supplier_id, { kind: 'wait', label: 'Waiting for quote', sub: `${pj.name} · invited ${short(i.created_at)}`, date: null, level: '', href });
  }
  // samples
  for (const s of samples) {
    if (SM.CLOSED.includes(s.status)) continue;
    const href = `/admin/samples/${s.id}`; seen(s.supplier_id, s.updated_at || s.created_at);
    if (['Requested', 'Confirmed'].includes(s.status)) { get(s.supplier_id).samples.push({ text: `Sample due ${s.due_ship_date ? short(s.due_ship_date) : 'date to confirm'}`, href }); if (s.due_ship_date) item(s.supplier_id, { kind: 'sample', label: `Sample due ${short(s.due_ship_date)}`, sub: s.title, date: day(s.due_ship_date), href }); }
    else if (['Delivered', 'Revise'].includes(s.status)) { get(s.supplier_id).samples.push({ text: s.status === 'Revise' ? 'Sample · revise' : 'Sample received · to review', href }); if (s.status === 'Delivered') item(s.supplier_id, { kind: 'sample', label: 'Review sample', sub: s.title, date: today, level: 'soon', href }); }
    else get(s.supplier_id).samples.push({ text: `Sample · ${String(s.status).toLowerCase()}`, href });
  }
  // inspections
  for (const x of insps) {
    const href = `/admin/orders/inspections/${x.id}`; const d = day(x.inspection_date); const pos = (x.pos || []).join(', ');
    if (x.status === 'todo') item(x.supplier_id, { kind: 'insp', label: 'Book inspection', sub: `PO ${pos}${d ? ` · by ${short(d)}` : ''}`, date: d ? addDays(d, -7) : today, href: `/admin/orders/inspections/new?id=${x.id}` });
    else if (['requested', 'scheduled', 'confirmed'].includes(x.status) && d && d >= addDays(today, -1)) item(x.supplier_id, { kind: 'insp', label: `Inspection ${short(d)}`, sub: `PO ${pos}`, date: d, href });
    else if (x.status === 'report') item(x.supplier_id, { kind: 'insp', label: 'Review inspection report', sub: `PO ${pos}`, date: today, level: 'soon', href });
    else if (x.status === 'failed') item(x.supplier_id, { kind: 'insp', label: 'Inspection failed', sub: `PO ${pos}`, date: today, level: 'late', href });
  }
  // shipping documents
  for (const c of scs) {
    const pos = (c.pos || []).join(', '); const href = '/admin/orders/shipping';
    if (c.status === 'sent' && (c.new_date || c.due_date) && day(c.new_date || c.due_date) < today) item(c.supplier_id, { kind: 'docs', label: 'Shipping docs missing', sub: `PO ${pos} · loaded ${short(c.new_date || c.due_date)}`, date: day(c.new_date || c.due_date), level: 'late', href });
    else if (c.status === 'received') item(c.supplier_id, { kind: 'docs', label: 'Shipping docs to review', sub: `PO ${pos}`, date: today, level: 'soon', href });
  }
  // CRM follow-ups (earliest open one)
  const fu = new Map(); for (const i of open) if (i.supplier_id && i.due_date && !fu.has(i.supplier_id)) fu.set(i.supplier_id, i);
  for (const sp of await L('suppliers', { select: 'id,next_follow_up' })) { const d = day(sp.next_follow_up); if (d && (!fu.has(sp.id) || d < day(fu.get(sp.id).due_date))) fu.set(sp.id, { due_date: d, title: '' }); }   // the older single date field
  for (const [sid, i] of fu) item(sid, { kind: 'followup', label: `Follow up · ${short(i.due_date)}`, sub: i.title ? String(i.title).slice(0, 70) : '', date: day(i.due_date), href: `/admin/suppliers/${sid}` });
  for (const a of acts) seen(a.supplier_id, a.activity_date);

  const rank = (x) => (x.level === 'late' ? 0 : x.level === 'soon' ? 1 : 2);
  for (const g of out.values()) {
    g.items.sort((a, b) => rank(a) - rank(b) || String(a.date || '9').localeCompare(String(b.date || '9')));
    g.next = g.items[0] || null;
  }
  return { bySupplier: out, today, followups: fu };
}

/** "today", "2d ago", "3w ago", "4mo ago" */
function ago(d, today = PL.today()) {
  if (!d) return '—';
  const n = Math.round((Date.parse(today) - Date.parse(String(d).slice(0, 10))) / 864e5);
  if (n <= 0) return 'today'; if (n === 1) return 'yesterday'; if (n < 14) return `${n}d ago`; if (n < 60) return `${Math.round(n / 7)}w ago`; if (n < 365) return `${Math.round(n / 30)}mo ago`; return `${Math.round(n / 365)}y ago`;
}

module.exports = { build, ago };
