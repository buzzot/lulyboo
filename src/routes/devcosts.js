'use strict';
// Product → Development tab: development costs (moulds, tooling, samples, testing, design), milestones and how the
// cost is spread over the planned quantity (gross factory price). Statistics only — no effect on payments.
//   POST /admin/products/:id/dev/costs            add a cost (multipart, files)
//   POST /admin/products/:id/dev/costs/:cid       edit a cost
//   POST /admin/products/:id/dev/costs/:cid/delete (admin)
//   GET  /admin/products/:id/dev/costs/:cid/file/:i
//   POST /admin/products/:id/dev/milestones · /milestones/:mid/delete (admin)
//   POST /admin/products/:id/dev/settings         planned quantity, count from, include quoted

const { html, raw } = require('../lib/html');
const { parseForm, flash, HttpError } = require('../lib/http');
const { guard } = require('./admin');
const { ddSel } = require('./logistics-costs');
const PL = require('../planning');
const DC = require('../devcost');
const ST = require('../staff');

const usd = (v, d = 2) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usd0 = (v) => (Math.round(Number(v || 0) * 100) % 100 ? usd(v) : usd(v, 0));
const unit = (v) => (v == null ? '—' : `$${Number(v) < 0.1 ? Number(v).toFixed(3) : Number(v).toFixed(2)}`);
const num = (v) => Number(v || 0).toLocaleString('en-US');
const short = (d) => (d ? PL.short(String(d).slice(0, 10)) : '');
const day = (v) => { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const amountOf = (v) => { const n = Number(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const BASE = (id) => `/admin/products/${id}/dev`;

/** The Development tab body. data = DC.load(); */
function render(p, data, { canDelete = false } = {}) {
  if (data.missing) return html`<div class="notice warn"><b>One step left</b><p>Run <code>supabase/dev-costs.sql</code> in the Supabase SQL editor to turn on development costs.</p></div>`;
  const { costs, milestones, s } = data; const B = BASE(p.id);
  const pct = s.plan ? Math.min(100, Math.round((s.absorbedUnits / s.plan) * 100)) : 0;
  const tiles = html`<div class="dv-k">
    <div><span>Development cost</span><b>${usd0(s.total)}</b><small>${s.n ? `${s.n} item${s.n === 1 ? '' : 's'} · ${usd0(s.paid)} paid${s.quoted ? ` · ${usd0(s.quoted)} quoted${p.dev_include_quoted === false ? ' (not counted)' : ''}` : ''}` : 'nothing recorded yet'}</small></div>
    <div><span>Allocated per unit</span><b>${s.perUnit ? unit(s.perUnit) : '—'}</b><small>${s.plan ? `${usd0(s.total)} over ${num(s.plan)} pcs planned` : html`<a href="#dv-alloc">set the planned quantity</a>`}</small></div>
    <div><span>Absorbed by orders</span><b>${usd0(s.absorbed)}</b>${s.plan ? html`<div class="dv-bar" aria-hidden="true"><i style="${raw(`width:${pct}%`)}"></i></div><small>${num(s.absorbedUnits)} of ${num(s.plan)} pcs · ${pct}%${s.done ? ' · fully absorbed' : ` · ${usd0(s.remaining)} to go`}</small>` : html`<small>${num(s.units)} pcs ordered so far</small>`}</div>
    <div class="${s.perUnit && !s.done ? 'hl' : ''}"><span>Gross factory price</span><b>${s.gross != null ? unit(s.gross) : '—'}</b><small>${s.price == null ? 'factory price not set' : s.perUnit && !s.done ? `${unit(s.price)} factory + ${unit(s.perUnit)} development` : s.done ? 'development fully absorbed' : 'no development cost spread yet'}</small></div></div>`;

  const kindOpts = Object.entries(DC.KINDS); const stOpts = Object.entries(DC.STATUSES);
  const form = (c, id) => html`<dialog id="${id}" class="rp-modal dv-dlg" aria-labelledby="${`${id}-t`}"><form method="post" action="${c ? `${B}/costs/${c.id}` : `${B}/costs`}" enctype="multipart/form-data" data-busy>
      <div class="rp-top"><h2 id="${`${id}-t`}">${c ? 'Edit cost' : 'Add development cost'}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
      <div class="dv-f">
        <label class="span2">What was it for<input name="title" required maxlength="160" value="${c?.title || ''}" placeholder="e.g. Silicone mould, 2 cavities"></label>
        <label>Type${ddSel('kind', c?.kind || 'mould', kindOpts)}</label>
        <label>Amount USD<input name="amount" inputmode="decimal" required value="${c ? c.amount : ''}" placeholder="2500"></label>
        <label>Date<input type="date" name="cost_date" value="${c?.cost_date ? String(c.cost_date).slice(0, 10) : PL.today()}"></label>
        <label>Status${ddSel('status', c?.status || 'quoted', stOpts)}</label>
        <label>Paid on<input type="date" name="paid_at" value="${c?.paid_at ? String(c.paid_at).slice(0, 10) : ''}"></label>
        <label>Payment reference<input name="pay_ref" maxlength="80" value="${c?.pay_ref || ''}" placeholder="TT / card / invoice no."></label>
        <fieldset class="span2 dv-mould"><legend>Mould details <span class="sub">(optional)</span></legend>
          <label>Owner<input name="mould_owner" maxlength="60" value="${c?.mould_owner || ''}" placeholder="Lulyboo"></label>
          <label>Kept at<input name="mould_location" maxlength="80" value="${c?.mould_location || ''}" placeholder="supplier's factory"></label>
          <label>Refund after (pcs)<input name="refund_after" inputmode="numeric" value="${c?.refund_after || ''}" placeholder="100000"></label></fieldset>
        <label class="span2">Notes<textarea name="notes" rows="2" maxlength="600">${c?.notes || ''}</textarea></label>
        <div class="span2"><span class="dv-fl">Invoice, slip or quote <span class="sub">(optional)</span></span><div class="mdrop small" data-filebox data-max="5"><div class="mdrop-box"><input type="file" name="files" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.docx" title="" aria-label="Files"><span class="dz-main" data-main>Drop files, paste (⌘V) or <u>choose</u></span><span class="dz-hint">PDF, image or Excel</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div></div>
      </div>
      <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">${c ? 'Save' : 'Add cost'}</button></div></form></dialog>`;

  const stTag = (c) => html`<span class="dv-st ${c.status}">${c.status === 'paid' ? `Paid${c.paid_at ? ` ${short(c.paid_at)}` : ''}` : DC.STATUSES[c.status] || c.status}</span>`;
  const counted = (c) => s.inc.includes(c);
  const row = (c) => html`<tr class="${counted(c) ? '' : 'off'}"><td class="dv-d">${short(c.cost_date) || '—'}</td>
      <td><b>${c.title}</b><small>${[c.mould_owner ? `owned by ${c.mould_owner}` : '', c.mould_location ? `kept at ${c.mould_location}` : '', c.refund_after ? `refund after ${num(c.refund_after)} pcs` : '', c.notes || ''].filter(Boolean).join(' · ')}</small></td>
      <td><span class="dv-ty ${c.kind}">${DC.KINDS[c.kind] || 'Other'}</span></td>
      <td>${stTag(c)}<small>${[c.pay_ref || ''].filter(Boolean).join(' · ')}${(c.files || []).map((f, i) => html` <a class="dv-file" href="${`${B}/costs/${c.id}/file/${i}`}" title="${f.name}">📎 ${f.name.length > 18 ? `${f.name.slice(0, 16)}…` : f.name}</a>`)}</small></td>
      <td class="r">${usd0(c.amount)}</td><td class="r">${counted(c) && s.plan ? unit(Number(c.amount) / s.plan) : '—'}</td>
      <td class="dv-act"><button type="button" class="link small" data-open-dialog="${`dv-e-${c.id}`}">Edit</button>${canDelete ? html`<span class="dc-x" data-armbox><button type="button" class="bd-del" data-arm title="Delete" aria-label="${`Delete ${c.title}`}">×</button><button type="submit" class="bd-yes" form="${`dv-del-${c.id}`}">Delete</button></span><form id="${`dv-del-${c.id}`}" method="post" action="${`${B}/costs/${c.id}/delete`}" hidden></form>` : ''}${form(c, `dv-e-${c.id}`)}</td></tr>`;
  const costsCard = html`<section class="card flush dv-card"><div class="dv-ch"><h3>Cost items</h3><button type="button" class="btn small" data-open-dialog="dv-add">＋ Add cost</button></div>
    ${costs.length ? html`<div class="table-wrap"><table class="dv-t"><thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Status</th><th class="r">Amount</th><th class="r">Per unit</th><th></th></tr></thead>
      <tbody>${costs.map(row)}<tr class="dv-tot"><td></td><td>Total counted</td><td></td><td></td><td class="r">${usd0(s.total)}</td><td class="r">${s.perUnit ? unit(s.perUnit) : '—'}</td><td></td></tr></tbody></table></div>`
      : html`<p class="dv-empty">No development costs yet. Add moulds, tooling, samples, lab tests or design fees paid for this product.</p>`}${form(null, 'dv-add')}</section>`;

  // milestones: costs + manual steps + POs (with what they absorbed), by date
  const ev = [
    ...costs.map((c) => ({ d: day(String(c.paid_at || c.cost_date || '').slice(0, 10)), cls: c.status === 'paid' ? 'done' : 'next', t: `${c.title} · ${usd0(c.amount)}`, sub: c.status === 'paid' ? 'paid' : c.status === 'refunded' ? 'refunded' : 'quoted' })),
    ...milestones.map((m) => ({ d: day(String(m.ms_date).slice(0, 10)), cls: m.ms_date && String(m.ms_date).slice(0, 10) <= PL.today() ? 'done' : 'next', t: m.title, sub: m.note || '', id: m.id })),
    ...s.pos.map((o) => ({ d: o.date, cls: 'po', t: `PO ${o.po} · ${num(o.qty)} pcs`, sub: s.perUnit ? (o.absorbed ? `absorbed ${usd0(o.absorbed)}` : 'after the planned quantity — nothing absorbed') : '' })),
  ].sort((a, b) => String(a.d || '9').localeCompare(String(b.d || '9')));
  const msCard = html`<section class="card flush dv-card"><div class="dv-ch"><h3>Development milestones</h3><button type="button" class="btn small ghost" data-open-dialog="dv-ms">＋ Milestone</button></div>
    ${ev.length ? html`<ul class="dv-tl">${ev.map((e) => html`<li class="${e.cls}"><b class="d">${e.d ? short(e.d) : '—'}</b> ${e.t}${e.id && canDelete ? html`<span class="dc-x" data-armbox><button type="button" class="bd-del" data-arm title="Delete" aria-label="Delete milestone">×</button><button type="submit" class="bd-yes" form="${`dv-md-${e.id}`}">Delete</button></span><form id="${`dv-md-${e.id}`}" method="post" action="${`${B}/milestones/${e.id}/delete`}" hidden></form>` : ''}${e.sub ? html`<small>${e.sub}</small>` : ''}</li>`)}</ul>`
      : html`<p class="dv-empty">Samples, approvals and lab tests you add here appear on a timeline with the costs and the POs.</p>`}
    <dialog id="dv-ms" class="rp-modal" aria-labelledby="dv-ms-t"><form method="post" action="${`${B}/milestones`}" data-busy>
      <div class="rp-top"><h2 id="dv-ms-t">Add milestone</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
      <div class="dv-f"><label>Date<input type="date" name="ms_date" required value="${PL.today()}"></label><label>What happened<input name="title" required maxlength="160" placeholder="e.g. T1 samples received"></label>
        <label class="span2">Note <span class="sub">(optional)</span><input name="note" maxlength="300" placeholder="e.g. handle too hard — changes requested"></label></div>
      <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn">Add</button></div></form></dialog></section>`;

  const alloc = html`<section class="card flush dv-card" id="dv-alloc"><div class="dv-ch"><h3>Allocation</h3></div><form method="post" action="${`${B}/settings`}" class="dv-al">
      <label class="row"><span>Spread development cost over</span><span class="dv-in"><input name="dev_plan_units" inputmode="numeric" value="${p.dev_plan_units || ''}" placeholder="20000" aria-label="Planned quantity"> pcs</span></label>
      <label class="row"><span>Count units from</span>${ddSel('dev_count', p.dev_count === 'shipped' ? 'shipped' : 'placed', [['placed', 'POs placed'], ['shipped', 'POs shipped']])}</label>
      <label class="row"><span>Count quoted (not paid) costs</span>${ddSel('dev_include_quoted', p.dev_include_quoted === false ? 'no' : 'yes', [['yes', 'Yes'], ['no', 'No — paid only']])}</label>
      <div class="row"><span></span><button class="btn small">Save</button></div>
      <p class="note">For statistics only: the gross price shows next to the factory price on the product. It doesn't change what the supplier invoices or what Accountant pays. Once the planned quantity is ordered, the development cost is fully absorbed and the gross price returns to the factory price.</p></form></section>`;
  return html`<div class="dv">${tiles}${costsCard}<div class="dv-2">${msCard}${alloc}</div></div>`;
}

module.exports = function devcosts(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || ST.current()?.name || 'Owner';
  const prod = async (req) => {
    if (!ST.seesLanded(ST.current()?.role)) throw new HttpError(403, 'Not available for your role');
    const p = await db.get('products', req.params.id).catch(() => null); if (!p) throw new HttpError(404, 'Product not found'); return p;
  };
  const back = (res, p) => res.redirect(`/admin/products/${p.id}#development`);
  const fromForm = (f) => ({
    title: String(f.title || '').trim().slice(0, 160), kind: DC.KINDS[f.kind] ? f.kind : 'other', status: DC.STATUSES[f.status] ? f.status : 'quoted',
    amount: amountOf(f.amount), cost_date: day(f.cost_date), paid_at: day(f.paid_at), pay_ref: String(f.pay_ref || '').trim().slice(0, 80) || null,
    notes: String(f.notes || '').trim().slice(0, 600) || null, mould_owner: String(f.mould_owner || '').trim().slice(0, 60) || null,
    mould_location: String(f.mould_location || '').trim().slice(0, 80) || null, refund_after: Number(String(f.refund_after || '').replace(/[,\s]/g, '')) > 0 ? Math.round(Number(String(f.refund_after).replace(/[,\s]/g, ''))) : null,
  });
  async function store(p, files) {
    const out = [];
    for (const up of [].concat(files?.files || []).filter((x) => x?.buffer?.length).slice(0, 5)) {
      const path = `products/${p.id}/dev/${Date.now().toString(36)}-${String(up.name).replace(/[^\w.\-]+/g, '_').slice(-80)}`;
      await db.docs.upload(path, up.buffer, up.type || 'application/octet-stream'); out.push({ name: up.name, path, type: up.type || null, size: up.buffer.length });
    }
    return out;
  }
  const check = (row) => { if (!row.title) throw new HttpError(400, 'Say what the cost was for'); if (row.amount === null) throw new HttpError(400, 'Enter the amount in USD'); if (row.status === 'paid' && !row.paid_at) row.paid_at = row.cost_date || PL.today(); };

  router.post('/admin/products/:id/dev/costs', G(async (req, res) => {
    const p = await prod(req); const { fields, files } = await parseForm(req, { limitBytes: 25 * 1024 * 1024 });
    const row = fromForm(fields); check(row);
    await db.insert('product_dev_costs', { ...row, product_id: p.id, supplier_id: p.supplier_id, files: await store(p, files), created_by: by(req) });
    flash(res, 'ok', `Added: ${row.title} · ${usd0(row.amount)}`); back(res, p);
  }));
  router.post('/admin/products/:id/dev/costs/:cid', G(async (req, res) => {
    const p = await prod(req); const c = await db.get('product_dev_costs', req.params.cid).catch(() => null); if (!c || c.product_id !== p.id) throw new HttpError(404, 'Cost not found');
    const { fields, files } = await parseForm(req, { limitBytes: 25 * 1024 * 1024 });
    const row = fromForm(fields); check(row);
    await db.update('product_dev_costs', { id: c.id }, { ...row, files: [...(c.files || []), ...await store(p, files)], updated_at: new Date().toISOString() });
    flash(res, 'ok', 'Saved'); back(res, p);
  }));
  router.post('/admin/products/:id/dev/costs/:cid/delete', G(async (req, res) => {
    const p = await prod(req); if (!ST.can(ST.current()?.role, 'delete')) throw new HttpError(403, 'Only an admin can delete');
    const c = await db.get('product_dev_costs', req.params.cid).catch(() => null); if (!c || c.product_id !== p.id) throw new HttpError(404, 'Cost not found');
    if ((c.files || []).length) await db.docs.remove(c.files.map((f) => f.path)).catch(() => null);
    await db.remove('product_dev_costs', { id: c.id }); flash(res, 'ok', `Deleted: ${c.title}`); back(res, p);
  }));
  router.get('/admin/products/:id/dev/costs/:cid/file/:i', G(async (req, res) => {
    const p = await prod(req); const c = await db.get('product_dev_costs', req.params.cid).catch(() => null); if (!c || c.product_id !== p.id) throw new HttpError(404, 'Cost not found');
    const f = (c.files || [])[Number(req.params.i)]; if (!f) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(f.path); const type = f.type || 'application/octet-stream';
    const inline = /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(type);
    const head = { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (inline) Object.assign(head, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
    res.writeHead(200, head); res.end(buf);
  }));
  router.post('/admin/products/:id/dev/milestones', G(async (req, res) => {
    const p = await prod(req); const { fields: f } = await parseForm(req);
    const d = day(f.ms_date); const title = String(f.title || '').trim().slice(0, 160);
    if (!d || !title) throw new HttpError(400, 'Enter a date and what happened');
    await db.insert('product_dev_milestones', { product_id: p.id, ms_date: d, title, note: String(f.note || '').trim().slice(0, 300) || null, created_by: by(req) });
    flash(res, 'ok', 'Milestone added'); back(res, p);
  }));
  router.post('/admin/products/:id/dev/milestones/:mid/delete', G(async (req, res) => {
    const p = await prod(req); if (!ST.can(ST.current()?.role, 'delete')) throw new HttpError(403, 'Only an admin can delete');
    const m = await db.get('product_dev_milestones', req.params.mid).catch(() => null); if (!m || m.product_id !== p.id) throw new HttpError(404, 'Milestone not found');
    await db.remove('product_dev_milestones', { id: m.id }); flash(res, 'ok', 'Milestone deleted'); back(res, p);
  }));
  router.post('/admin/products/:id/dev/settings', G(async (req, res) => {
    const p = await prod(req); const { fields: f } = await parseForm(req);
    const n = Number(String(f.dev_plan_units || '').replace(/[,\s]/g, ''));
    await db.update('products', { id: p.id }, { dev_plan_units: n > 0 ? Math.round(n) : null, dev_count: f.dev_count === 'shipped' ? 'shipped' : 'placed', dev_include_quoted: f.dev_include_quoted !== 'no' });
    flash(res, 'ok', n > 0 ? `Development cost spread over ${num(Math.round(n))} pcs` : 'Planned quantity cleared'); back(res, p);
  }));
};
module.exports.render = render;
