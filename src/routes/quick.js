'use strict';
// ⌘K quick jump: find suppliers, POs, development projects, samples, RFQs and products by a few letters.

const { guard } = require('./admin');

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/[^a-z0-9一-鿿]/g, '');

module.exports = function quickRoutes(router, { db, config }) {
  router.get('/admin/quick', guard(config, async (req, res) => {
    const q = norm(req.query.q).slice(0, 80);
    if (q.length < 2) return res.json({ results: [] });
    const qs = squash(q); // "po 4512" also matches "PO-4512"
    const hit = (...xs) => xs.some((x) => { const v = norm(x); return v && (v.includes(q) || (qs.length >= 2 && squash(v).includes(qs))); });
    const safe = (p) => p.catch(() => []);
    const [sups, orders, projects, samples, reqs, prods] = await Promise.all([
      safe(db.list('suppliers', { select: 'id,name,email,crm_status,archived_at', order: 'name.asc' })),
      safe(db.list('plan_orders', { select: 'supplier_id,po,product,sku,qty' })),
      safe(db.list('dev_projects', { select: 'id,ref,name,status', order: 'created_at.desc' })),
      safe(db.list('samples', { select: 'id,ref,title,status,supplier_id', order: 'created_at.desc' })),
      safe(db.list('info_requests', { select: 'id,ref,subject,status,supplier_id', order: 'created_at.desc' })),
      safe(db.list('products', { select: 'id,product_name,supplier_sku,supplier_id,archived_at', order: 'created_at.desc' })),
    ]);
    const name = Object.fromEntries(sups.map((s) => [s.id, s.name]));
    const out = [];
    const add = (type, title, sub, href) => out.push({ type, title, sub, href });
    sups.filter((s) => hit(s.name, s.email)).slice(0, 6).forEach((s) => add('Supplier', s.name, [s.crm_status, s.archived_at ? 'archived' : ''].filter(Boolean).join(' · '), `/admin/suppliers/${s.id}`));
    const pos = new Map();
    for (const o of orders) {
      if (!o.po) continue;
      const k = `${o.supplier_id}|${squash(o.po)}`;
      if (!pos.has(k)) pos.set(k, { po: o.po, supplier_id: o.supplier_id, lines: [] });
      pos.get(k).lines.push(o);
    }
    [...pos.values()].filter((p) => hit(p.po, `po ${p.po}`, name[p.supplier_id], ...p.lines.flatMap((l) => [l.product, l.sku]))).slice(0, 6)
      .forEach((p) => add('PO', `${/^po/i.test(p.po) ? '' : 'PO '}${p.po} · ${name[p.supplier_id] || 'Supplier'}`, `${p.lines.length} line${p.lines.length === 1 ? '' : 's'}${p.lines[0]?.product ? ` · ${String(p.lines[0].product).slice(0, 50)}` : ''}`, `/admin/orders/view?supplier=${encodeURIComponent(p.supplier_id)}&po=${encodeURIComponent(p.po)}`));
    projects.filter((p) => hit(p.ref, p.name)).slice(0, 5).forEach((p) => add('Project', `${p.ref} ${p.name}`, p.status, `/admin/projects/${p.id}`));
    samples.filter((x) => hit(x.ref, x.title, name[x.supplier_id])).slice(0, 5).forEach((x) => add('Sample', `${x.ref} ${x.title}`, [name[x.supplier_id], x.status].filter(Boolean).join(' · '), `/admin/samples/${x.id}`));
    reqs.filter((x) => hit(x.ref, x.subject, name[x.supplier_id])).slice(0, 4).forEach((x) => add('RFQ', `${x.ref} ${x.subject}`, [name[x.supplier_id], x.status].filter(Boolean).join(' · '), `/admin/requests/${x.id}`));
    prods.filter((x) => !x.archived_at && hit(x.product_name, x.supplier_sku)).slice(0, 5).forEach((x) => add('Product', x.product_name, [name[x.supplier_id], x.supplier_sku].filter(Boolean).join(' · '), `/admin/products/${x.id}`));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ results: out });
  }));
};
