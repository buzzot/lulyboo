'use strict';
// Product development projects.
//   Admin  /admin/projects ...   create a project (spec + files), invite suppliers, answer questions, compare quotes, milestones
//   Portal /portal/projects ...  each supplier sees ONLY its own invitation: spec, files, its own thread, its own quote
// Suppliers never see other suppliers, the internal target price/MOQ, internal notes or internal files.

const { html, raw, fmt, t, m, biText, confirmAttr } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const { currentSupplierUser } = require('../auth');
const ST = require('../staff');
const F = require('../fields');
const P = require('../projects');

const num = (x) => { if (x === undefined || x === null || String(x).trim() === '') return null; const n = Number(String(x).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const int = (x) => { const n = num(x); return n === null ? null : Math.round(n); };
const str = (x, max = 4000) => { const s = String(x ?? '').replace(/\r/g, '').trim().slice(0, max); return s || null; };
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const pillCls = (s) => ({ Quoted: 's-reviewing', Selected: 's-selected', Declined: 's-closed', Closed: 's-closed', Sample: 's-reviewing', Questions: 's-new', Invited: '', Viewed: '' }[s] ?? '');
const serve = (res, buf, name, type, inline) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', inline && P.INLINE_OK.test(name) ? (P.MIME[P.extOf(name)] || type || 'application/octet-stream') : (type || 'application/octet-stream'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (inline && P.INLINE_OK.test(name)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', `${inline && P.INLINE_OK.test(name) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(buf);
};
const FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.step,.stp,.igs,.iges,.dxf,.dwg,.ai,.stl,.pptx';
// Multi-file upload box: drag & drop, click to choose, or paste (screenshots / copied files). Still a plain file input without JS.
const multiFile = (name = 'files', { describe = false } = {}) => html`<div class="mdrop" data-filebox${describe ? raw(' data-describe') : ''}>
  <div class="mdrop-box"><input type="file" name="${name}" multiple accept="${FILE_ACCEPT}" aria-label="Choose files">
    <span class="dz-icon" aria-hidden="true">⬆</span>
    <span class="dz-main" data-main>${t('Drag & drop files here, paste a screenshot, or choose files', '将文件拖到此处、粘贴截图，或点击选择文件')}</span>
    <span class="dz-hint">${t('PDF, STEP, DXF, images, Office files · up to 20 MB each', 'PDF、STEP、DXF、图片、Office 文件 · 每个最大 20 MB')}</span>
  </div>
  ${describe ? html`<input type="hidden" name="meta" value="[]" data-meta>` : ''}
  <ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>`;
const COUNTRY = { cn: 'China', chn: 'China', china: 'China', prc: 'China', us: 'USA', usa: 'USA', vn: 'Vietnam', vietnam: 'Vietnam', in: 'India', india: 'India', tw: 'Taiwan', taiwan: 'Taiwan', hk: 'Hong Kong', 'hong kong': 'Hong Kong', th: 'Thailand', thailand: 'Thailand', kr: 'South Korea', mx: 'Mexico', tr: 'Turkey' };
const countryName = (c) => (c ? COUNTRY[String(c).trim().toLowerCase()] || String(c).trim() : '');
const initials = (n) => String(n || '?').replace(/\(.*?\)/g, '').split(/[\s,.-]+/).filter((w) => /^[a-z0-9]/i.test(w) && !/^(co|ltd|inc|llc|the)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const THUMB_OK = /\.(png|jpe?g|webp|gif)$/i;
const kindIcon = (k) => ({ drawing: '📐', image: '🖼️', spec: '📄', certificate: '✅', other: '📎' }[k] || '📎');
const attLinks = (list, hrefOf) => (list?.length ? html`<ul class="att">${list.map((a, i) => html`<li><a href="${hrefOf(i)}">${a.name}</a> <span class="sub">${bytes(a.size)}</span>${P.INLINE_OK.test(a.name) ? html` · <a href="${hrefOf(i)}?inline=1" target="_blank" rel="noopener">${t('Preview', '预览')}</a>` : ''}</li>`)}</ul>` : '');

function quoteCards(q, project, { admin = false } = {}) {
  if (!q) return html`<p class="d-empty">${admin ? 'No quote yet.' : t('You have not submitted a quote yet.', '您尚未提交报价。')}</p>`;
  const tiers = (q.tiers || []);
  const row = (en, zh, v) => (v === null || v === undefined || v === '' ? '' : html`<div class="sp"><dt>${admin ? en : t(en, zh)}</dt><dd>${v}</dd></div>`);
  const cur = q.currency || 'USD';
  return html`<dl class="specs q-spec">
    ${tiers.map((x, i) => row(`Price tier ${i + 1}`, `阶梯价 ${i + 1}`, html`<b>${fmt.money(x.price, cur)}</b> <span class="sub">${admin ? 'at' : t('at', '数量')} ${fmt.num(x.qty)}+ ${admin ? 'pcs' : t('pcs', '件')}</span>`))}
    ${row('Incoterm', '贸易术语', q.incoterm)}${row('Tooling cost', '模具费', q.tooling_cost !== null ? fmt.money(q.tooling_cost, cur) : null)}${row('Tooling lead time', '模具周期', q.tooling_lead_days ? `${q.tooling_lead_days} d` : null)}
    ${row('MOQ', '起订量', q.moq ? fmt.num(q.moq) : null)}${row('Sample cost', '样品费', q.sample_cost !== null ? fmt.money(q.sample_cost, cur) : null)}${row('Sample lead time', '样品周期', q.sample_lead_days ? `${q.sample_lead_days} d` : null)}
    ${row('Production lead time', '生产周期', q.production_lead_days ? `${q.production_lead_days} d` : null)}${row('Quote valid until', '报价有效期', q.validity_date ? fmt.date(q.validity_date) : null)}
    ${row('Payment terms', '付款条款', q.payment_terms)}${row('Material quoted', '报价材质', q.material_notes)}
    ${(q.custom || []).map((c) => row(c.label, c.label, c.value))}
  </dl>${q.notes ? html`<p class="pd-desc">${q.notes}</p>` : ''}`;
}

module.exports = function projectRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const A = (fn) => async (req, res) => {
    const cur = await currentSupplierUser(db, config, req);
    if (!cur) return res.redirect('/login');
    req.supplier = cur.supplier; req.user = cur.user; req.base = '/portal';
    return fn(req, res);
  };
  const now = () => new Date().toISOString();
  const maxBytes = config.maxUploadBytes || 20 * 1024 * 1024;
  const link = (invId) => `${config.publicUrl}/portal/projects/${invId}`;

  async function loadProject(id) { const p = await db.get('dev_projects', id); if (!p) throw new HttpError(404, 'Project not found'); return p; }
  async function loadInv(projectId, invId) {
    const inv = await db.get('dev_invitations', invId);
    if (!inv || inv.project_id !== projectId) throw new HttpError(404, 'Invitation not found');
    return inv;
  }
  const latestQuote = async (invId) => (await db.list('dev_quotes', { filters: { invitation_id: invId }, order: 'revision.desc', limit: 1 }))[0] || null;

  // ═════════════════════════ ADMIN ═════════════════════════
  router.get('/admin/projects', G(async (req, res) => {
    const [projects, invs, quotes, miles, suppliers] = await Promise.all([db.list('dev_projects', { order: 'created_at.desc' }), db.list('dev_invitations'), db.list('dev_quotes'), db.list('dev_milestones', { filters: { done_at: null } }), db.list('suppliers', { select: 'id,name' })]);
    const q = String(req.query.q || '').toLowerCase(); const st = req.query.status || '';
    const shown = projects.filter((p) => (!st || p.status === st) && (!q || `${p.ref} ${p.name} ${p.category || ''}`.toLowerCase().includes(q)));
    res.html(page({
      title: 'Development projects', nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><div><h1>Development projects</h1><p class="muted small">Create a product, send the spec to several suppliers, follow their questions and quotes.</p></div><a class="btn" href="#new-project" data-open-hash>+ New project</a></div>
      <form class="filters" method="get"><input type="search" name="q" placeholder="Search projects" value="${req.query.q || ''}"><select name="status"><option value="">All statuses</option>${P.PROJECT_STATUSES.map((s) => html`<option ${st === s ? raw('selected') : ''}>${s}</option>`)}</select><button class="btn small">Filter</button></form>
      ${shown.length ? html`<div class="table-wrap"><table class="list dp-table"><thead><tr><th>Project</th><th>Status</th><th>Suppliers</th><th>Quotes</th><th>Next milestone</th></tr></thead><tbody>
        ${shown.map((p) => { const pi = invs.filter((i) => i.project_id === p.id); const quoted = pi.filter((i) => quotes.some((x) => x.invitation_id === i.id)).length; const nm = miles.filter((x) => x.project_id === p.id && x.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
          return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}">${p.name}</a><div class="sub">${p.ref}${p.category ? ` · ${p.category}` : ''} · spec v${p.current_version}</div></td>
          <td><span class="pill ${p.status === 'Completed' ? 's-selected' : p.status === 'Draft' ? '' : 's-reviewing'}">${p.status}</span></td>
          <td>${pi.length ? html`${pi.length} invited${pi.some((i) => i.status === 'Questions') ? html`<div class="sub neg">${pi.filter((i) => i.status === 'Questions').length} with questions</div>` : ''}` : html`<span class="none">—</span>`}</td>
          <td>${pi.length ? `${quoted} of ${pi.length}` : html`<span class="none">—</span>`}</td>
          <td>${nm ? html`<span class="${nm.due_date < P.today() ? 'neg' : ''}">${fmt.date(nm.due_date)}</span><div class="sub">${nm.title}</div>` : html`<span class="none">—</span>`}</td></tr>`; })}</tbody></table></div>` : html`<div class="card empty-state"><p><b>${projects.length ? 'No projects match.' : 'No development projects yet.'}</b></p><p class="muted">Start with a name and a short description. You add requirements, drawings and suppliers next.</p></div>`}
      <details class="card fold" id="new-project" ${projects.length ? '' : raw('open')}><summary><h2 class="inline">New project</h2></summary>
        <form method="post" action="/admin/projects" class="fields"><label class="frow"><span>Product name</span><input name="name" required maxlength="160" placeholder="e.g. Cat water fountain v1"></label>
          <label class="frow"><span>Category</span><input name="category" maxlength="80" placeholder="e.g. Pet"></label>
          <label class="frow top"><span>Short description</span><textarea name="summary" rows="3" placeholder="What is it, who is it for?"></textarea></label>
          <div class="form-actions"><button class="btn">Create project</button></div></form></details>`,
    }));
  }));

  router.post('/admin/projects', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const name = str(fields.name, 160); if (!name) { flash(res, 'error', 'Enter a product name'); return res.redirect('/admin/projects'); }
    const p = await db.insert('dev_projects', { ref: await P.nextRef(db), name, category: str(fields.category, 80), summary: str(fields.summary), status: 'Draft', current_version: 1, extra_fields: [], created_at: now(), updated_at: now() });
    await db.insert('dev_spec_versions', { project_id: p.id, version: 1, change_note: 'First version', snapshot: {}, created_at: now() });
    flash(res, 'ok', `Project ${p.ref} created. Add the requirements and files, then invite suppliers.`);
    res.redirect(`/admin/projects/${p.id}`);
  }));

  const TABS = [['spec', 'Spec'], ['files', 'Files'], ['suppliers', 'Suppliers'], ['quotes', 'Compare quotes'], ['milestones', 'Milestones']];
  router.get('/admin/projects/:id', G(async (req, res) => {
    const p = await loadProject(req.params.id);
    const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : 'spec';
    const [invs, files, versions, miles, suppliers, allQuotes, msgs] = await Promise.all([
      db.list('dev_invitations', { filters: { project_id: p.id }, order: 'created_at.asc' }), db.list('dev_files', { filters: { project_id: p.id }, order: 'created_at.asc' }),
      db.list('dev_spec_versions', { filters: { project_id: p.id }, order: 'version.desc' }), db.list('dev_milestones', { filters: { project_id: p.id }, order: 'sort.asc,due_date.asc' }),
      db.list('suppliers', { select: 'id,name,country,email,active', order: 'name.asc' }), db.list('dev_quotes', { order: 'revision.desc' }), db.list('dev_messages', { order: 'created_at.desc' }),
    ]);
    const sname = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
    const invIds = new Set(invs.map((i) => i.id));
    const quotesBy = {}; for (const q of allQuotes) if (invIds.has(q.invitation_id) && !quotesBy[q.invitation_id]) quotesBy[q.invitation_id] = q;
    const lastMsg = {}; for (const x of msgs) if (invIds.has(x.invitation_id) && !lastMsg[x.invitation_id]) lastMsg[x.invitation_id] = x;
    const canDelete = ST.can(ST.current()?.role, 'delete');
    const tabHref = (k) => `/admin/projects/${p.id}?tab=${k}`;
    const header = html`<nav class="crumb"><a href="/admin/projects">Development</a><span>›</span><b>${p.name}</b></nav>
      <div class="head-row"><div><h1>${p.name}</h1><ul class="pp-meta"><li>${p.ref}</li>${p.category ? html`<li>${p.category}</li>` : ''}<li><span class="pill s-reviewing">${p.status}</span></li><li>Spec v${p.current_version}</li><li>${invs.length} supplier${invs.length === 1 ? '' : 's'} invited</li></ul></div>
      <div class="actions">${canDelete ? html`<form method="post" action="/admin/projects/${p.id}/delete" data-confirm="Delete this project, its files, threads and quotes? This cannot be undone."><button class="btn small ghost danger">Delete project</button></form>` : ''}</div></div>
      <nav class="dp-tabs" aria-label="Project sections">${TABS.map(([k, l]) => html`<a href="${tabHref(k)}" class="${tab === k ? 'cur' : ''}">${l}${k === 'suppliers' && invs.length ? html` <b>${invs.length}</b>` : ''}${k === 'files' && files.length ? html` <b>${files.length}</b>` : ''}</a>`)}</nav>`;

    let body;
    if (tab === 'spec') {
      const extra = (p.extra_fields || []).map((f) => f.label).join('\n');
      body = html`<form method="post" action="/admin/projects/${p.id}" class="dp-grid" data-guard>
        <section class="card"><h2 class="sec">What suppliers see</h2><div class="fields">
          <label class="frow"><span>Product name</span><input name="name" value="${p.name}" required></label>
          <label class="frow"><span>Category</span><input name="category" value="${p.category || ''}"></label>
          <label class="frow top"><span>Summary</span><textarea name="summary" rows="3">${p.summary || ''}</textarea></label>
          <label class="frow top"><span>Requirements</span><textarea name="requirements" rows="9" placeholder="Materials, dimensions and tolerances, colours, functions, packaging, labelling, quantity expectations…">${p.requirements || ''}</textarea></label>
          <label class="frow top"><span>Certifications / standards</span><textarea name="certifications" rows="3" placeholder="e.g. ASTM F963, CPSIA, 16 CFR 1250 (one per line)">${p.certifications || ''}</textarea></label>
          <label class="frow top"><span>Extra quote questions</span><textarea name="extra_fields" rows="3" placeholder="One per line, e.g. Motor warranty period&#10;Recycled material %">${extra}</textarea></label>
          <p class="sub fl-note">The quote form always asks for price tiers, tooling, MOQ, sample and production lead times, validity, payment terms and material. Questions added here appear as extra fields.</p></div></section>
        <aside class="dp-side"><section class="card"><h2 class="sec">Internal only</h2><div class="fields">
          <label class="frow"><span>Status</span><select name="status">${P.PROJECT_STATUSES.map((s) => html`<option ${s === p.status ? raw('selected') : ''}>${s}</option>`)}</select></label>
          <label class="frow"><span>Target price</span><span class="inp-unit"><input name="target_price_usd" type="number" step="0.01" min="0" value="${p.target_price_usd ?? ''}"><i>USD</i></span></label>
          <label class="frow"><span>Target MOQ</span><span class="inp-unit"><input name="target_moq" type="number" step="1" min="0" value="${p.target_moq ?? ''}"><i>pcs</i></span></label>
          <label class="frow top"><span>Notes</span><textarea name="internal_notes" rows="4">${p.internal_notes || ''}</textarea></label></div>
          <p class="sub">Never shown to suppliers.</p></section>
          <section class="card"><h2 class="sec">NDA</h2><div class="fields"><label class="chk"><input type="checkbox" name="nda_required" value="1" ${p.nda_required ? raw('checked') : ''}> Suppliers must accept an NDA before seeing the spec and files</label>
          <label class="frow top"><span>NDA text</span><textarea name="nda_text" rows="5" placeholder="Leave empty for the standard confidentiality wording.">${p.nda_text || ''}</textarea></label></div></section>
          <div class="form-actions"><button class="btn" data-save>Save</button><span class="dirty-note" data-dirty-note hidden>Unsaved changes</span></div></aside></form>
        <section class="card"><h2 class="sec">Spec versions</h2><p class="sub">Currently v${p.current_version}. Publishing a new version tells every active supplier what changed; they confirm it before quoting again.</p>
          <form method="post" action="/admin/projects/${p.id}/publish" class="inline-form mt"><input name="change_note" required maxlength="500" placeholder="What changed in v${p.current_version + 1}? e.g. Wall thickness 2.0 mm, new drawing rev B" style="flex:1 1 360px">
            <label class="chk"><input type="checkbox" name="notify" value="1" checked> Email suppliers</label><button class="btn small">Publish v${p.current_version + 1}</button></form>
          <ul class="feed">${versions.map((v) => html`<li><span class="date">${fmt.date(v.created_at)}</span><b>v${v.version}</b> ${v.change_note || ''}</li>`)}</ul></section>`;
    } else if (tab === 'files') {
      const titles = P.fileTitles(files);
      const groups = P.KIND_ORDER.map((k) => [k, files.filter((f) => f.kind === k)]).filter(([, l]) => l.length);
      const row = (f) => html`<li class="fl-row">
          <div class="fl-thumb">${THUMB_OK.test(f.name) ? html`<img src="/admin/dev-files/${f.id}?inline=1" alt="" loading="lazy">` : html`<span aria-hidden="true">${kindIcon(f.kind)}</span>`}</div>
          <div class="fl-main"><div class="fl-title" title="${f.name}">${titles.get(f.id)}${f.controlling ? html` <span class="pill s-selected">Controlling</span>` : ''}${f.internal ? html` <span class="pill s-closed">Internal only</span>` : ''}</div>
            <div class="fl-meta">${P.extOf(f.name).slice(1).toUpperCase()} · ${bytes(f.bytes)} · added in v${f.version}${f.internal ? '' : ' · visible to suppliers'}</div></div>
          <div class="fl-act">${P.INLINE_OK.test(f.name) ? html`<a href="/admin/dev-files/${f.id}?inline=1" target="_blank" rel="noopener">Preview</a>` : ''}<a href="/admin/dev-files/${f.id}">Download</a><button type="button" class="link" data-fl-toggle>Edit</button>
            <form class="inline" method="post" action="/admin/projects/${p.id}/files/${f.id}/delete" data-confirm="Remove this file?"><button class="link danger">Remove</button></form></div>
          <form class="fl-edit" method="post" action="/admin/projects/${p.id}/files/${f.id}/update" hidden>
            <label class="frow"><span>Description</span><input name="label" maxlength="120" value="${f.label || ''}" placeholder="What is this file? e.g. Housing – 2D drawing rev B"></label>
            <label class="frow"><span>Type</span><select name="kind">${Object.entries(P.FILE_KINDS).map(([k, l]) => html`<option value="${k}" ${k === f.kind ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <div class="fl-checks"><label class="chk"><input type="checkbox" name="controlling" value="1" ${f.controlling ? raw('checked') : ''}> Controlling drawing</label><label class="chk"><input type="checkbox" name="internal" value="1" ${f.internal ? raw('checked') : ''}> Internal only (hide from suppliers)</label></div>
            <div class="form-actions"><button class="btn small">Save</button><button type="button" class="link" data-fl-toggle>Cancel</button></div></form></li>`;
      body = html`<section class="card"><div class="fl-head"><h2 class="sec">Files <span class="count">${files.length}</span></h2><span class="muted small">Added in spec v${p.current_version}. Suppliers see the description, not the file name.</span></div>
        ${files.length ? groups.map(([k, list]) => html`<div class="fl-group"><h3>${P.FILE_GROUPS[k][0]} <span class="count">${list.length}</span></h3><ul class="fl">${list.map(row)}</ul></div>`) : html`<p class="d-empty">No files yet. Add drawings (PDF, STEP, DXF…), reference images and specs, and say what each one is.</p>`}</section>
        <section class="card"><h2 class="sec">Add files</h2>
        <form method="post" enctype="multipart/form-data" action="/admin/projects/${p.id}/files" class="doc-upload" data-upload>${multiFile('files', { describe: true })}
          <div class="form-actions"><button class="btn" data-upload-btn disabled>Upload</button><span class="muted small">Describe each file so suppliers know what it is. PDF, images, Office, ZIP, STEP/STP, IGES, DXF, DWG, AI, STL · 20 MB each.</span></div></form></section>`;
    } else if (tab === 'suppliers') {
      const invited = new Set(invs.map((i) => i.supplier_id));
      const pickList = suppliers.filter((x) => x.active !== false || invited.has(x.id));
      body = html`<section class="card"><h2 class="sec">Invited suppliers</h2>
        ${invs.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>Supplier</th><th>Status</th><th>Spec</th><th>Quote</th><th>Last message</th><th></th></tr></thead><tbody>
          ${invs.map((i) => { const q = quotesBy[i.id]; const lm = lastMsg[i.id]; return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}/suppliers/${i.id}">${sname[i.supplier_id] || 'Supplier'}</a>${p.nda_required ? html`<div class="sub">${i.nda_accepted_at ? `NDA accepted ${fmt.date(i.nda_accepted_at)}` : html`<span class="neg">NDA not accepted</span>`}</div>` : ''}</td>
            <td><span class="pill ${pillCls(i.status)}">${i.status}</span></td><td>${i.ack_version >= p.current_version ? html`v${i.ack_version} confirmed` : html`<span class="neg">v${p.current_version} not confirmed</span>`}</td>
            <td>${q ? html`${fmt.money(q.tiers?.[0]?.price, q.currency)}<div class="sub">rev ${q.revision}${q.spec_version < p.current_version ? ` · on v${q.spec_version}` : ''}</div>` : html`<span class="none">—</span>`}</td>
            <td>${lm ? html`<span class="sub">${lm.direction === 'supplier' ? 'Supplier' : 'You'} · ${fmt.date(lm.created_at)}</span>` : html`<span class="none">—</span>`}</td><td class="r"><a class="btn ghost small" href="/admin/projects/${p.id}/suppliers/${i.id}">Open thread</a></td></tr>`; })}</tbody></table></div>` : html`<p class="d-empty">No suppliers invited yet.</p>`}</section>
        <section class="card"><h2 class="sec">Invite suppliers</h2>
          <form method="post" action="/admin/projects/${p.id}/invite" class="fields inv-form" data-invite>
            <div class="frow top"><span>Suppliers</span><div class="pick-sel">
              <div class="pick-chips" data-picked></div>
              <p class="sub" data-pick-none>No suppliers selected yet.</p>
              <button type="button" class="btn ghost small" data-pick-open>+ Choose suppliers</button></div></div>
            <dialog class="pick-dlg" data-pick-dlg aria-label="Choose suppliers">
              <div class="pick-head"><div class="pick-title"><h3>Choose suppliers</h3><button type="button" class="pick-x" data-pick-done aria-label="Close">×</button></div>
                <input type="search" class="pick-q" placeholder="Search by name, country or email" autocomplete="off" data-pick-q>
                <div class="pick-bar"><label class="chk"><input type="checkbox" data-pick-all> Select all shown</label><span class="sub" data-pick-count></span></div></div>
              <ul class="pick-list">${pickList.map((s) => html`<li${invited.has(s.id) ? raw(' class="is-invited"') : ''}><label><input type="checkbox" ${invited.has(s.id) ? raw('disabled') : raw('name="supplier_ids"')} value="${s.id}" data-name="${s.name}" data-q="${[s.name, s.country, countryName(s.country), s.email].filter(Boolean).join(' ').toLowerCase()}">
                <span class="pk-av" aria-hidden="true">${initials(s.name)}</span><span class="pk-main"><b>${s.name}</b><span class="sub">${[countryName(s.country), s.email].filter(Boolean).join(' · ')}</span></span>${invited.has(s.id) ? html`<span class="pill">Invited</span>` : ''}</label></li>`)}</ul>
              <p class="pick-empty" data-pick-empty hidden>No suppliers match your search.</p>
              <div class="pick-foot"><button type="button" class="link" data-pick-clear>Clear selection</button><button type="button" class="btn" data-pick-done>Done</button></div>
            </dialog>
            <label class="frow top"><span>Message</span><textarea name="message" rows="3" placeholder="Short note to the supplier (optional)"></textarea></label>
            <label class="chk"><input type="checkbox" name="send_email" value="1" checked> Email the invitation now</label>
            <div class="form-actions"><button class="btn" data-invite-btn>Invite selected</button><span class="muted small">Each supplier gets its own private thread. They cannot see each other.${p.status === 'Draft' ? ' The project moves to Sourcing.' : ''}</span></div></form></section>`;
    } else if (tab === 'quotes') {
      const rows = invs.map((i) => ({ i, q: quotesBy[i.id] })).filter((x) => x.q);
      const labels = [...new Set(rows.flatMap((x) => (x.q.custom || []).map((c) => c.label)))];
      const best = (fn, low = true) => { const v = rows.map((x) => fn(x.q)).filter((n) => n !== null && n !== undefined); return v.length > 1 ? (low ? Math.min(...v) : Math.max(...v)) : null; };
      const p1 = (q) => (q.tiers?.[0]?.price ?? null); const bp = best(p1); const bt = best((q) => q.tooling_cost); const bl = best((q) => q.production_lead_days);
      const cell = (v, b, show) => html`<td class="r ${b !== null && v === b ? 'best' : ''}">${v === null || v === undefined ? html`<span class="none">—</span>` : show}</td>`;
      body = html`<section class="card"><h2 class="sec">Quote comparison</h2><p class="sub">Latest quote from each supplier. Best values are highlighted. Prices are in each supplier's own currency.${p.target_price_usd ? ` Your target: ${fmt.money(p.target_price_usd)}.` : ''}</p>
        ${rows.length ? html`<div class="table-wrap"><table class="list compact cmp"><thead><tr><th>Supplier</th><th class="r">Unit price (tier 1)</th><th class="r">vs target</th><th class="r">Tooling</th><th class="r">MOQ</th><th class="r">Sample</th><th class="r">Sample lead</th><th class="r">Production lead</th><th>Valid until</th><th>Spec</th>${labels.map((l) => html`<th>${l}</th>`)}</tr></thead><tbody>
          ${rows.map(({ i, q }) => { const pr = p1(q); const vs = p.target_price_usd && pr && (q.currency || 'USD') === 'USD' ? ((pr - p.target_price_usd) / p.target_price_usd) * 100 : null; return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}/suppliers/${i.id}">${sname[i.supplier_id]}</a><div class="sub"><span class="pill ${pillCls(i.status)}">${i.status}</span> rev ${q.revision}</div></td>
            ${cell(pr, bp, html`<b>${fmt.money(pr, q.currency)}</b>${q.incoterm ? html`<div class="sub">${q.incoterm}</div>` : ''}`)}<td class="r ${vs !== null && vs > 0 ? 'neg' : ''}">${vs === null ? html`<span class="none">—</span>` : `${vs > 0 ? '+' : ''}${vs.toFixed(1)}%`}</td>
            ${cell(q.tooling_cost, bt, fmt.money(q.tooling_cost, q.currency))}<td class="r">${q.moq ? fmt.num(q.moq) : html`<span class="none">—</span>`}</td><td class="r">${q.sample_cost !== null && q.sample_cost !== undefined ? fmt.money(q.sample_cost, q.currency) : html`<span class="none">—</span>`}</td><td class="r">${q.sample_lead_days ? `${q.sample_lead_days} d` : html`<span class="none">—</span>`}</td>
            ${cell(q.production_lead_days, bl, `${q.production_lead_days} d`)}<td>${q.validity_date ? fmt.date(q.validity_date) : html`<span class="none">—</span>`}${q.validity_date && q.validity_date < P.today() ? html` <span class="neg">expired</span>` : ''}</td><td>${q.spec_version < p.current_version ? html`<span class="neg">v${q.spec_version}</span>` : `v${q.spec_version}`}</td>
            ${labels.map((l) => html`<td>${(q.custom || []).find((c) => c.label === l)?.value || html`<span class="none">—</span>`}</td>`)}</tr>`; })}</tbody></table></div>` : html`<p class="d-empty">No quotes have been submitted yet.</p>`}</section>`;
    } else {
      const day = P.today();
      body = html`<section class="card"><div class="sec-row"><h2 class="sec">Milestones</h2><form method="post" action="/admin/projects/${p.id}/milestones/standard" data-confirm="Add the standard development milestones, dated from today?"><button class="btn ghost small">Add standard plan</button></form></div>
        <p class="sub">You get an email (and Telegram, if set up) ${'{N}'.replace('{N}', 'N')} days before each due date, then once a day while it is overdue.</p>
        ${miles.length ? html`<div class="table-wrap"><table class="list compact"><thead><tr><th></th><th>Milestone</th><th>Applies to</th><th>Due</th><th>Remind</th><th></th></tr></thead><tbody>
          ${miles.map((x) => { const over = !x.done_at && x.due_date && x.due_date < day; const soon = !x.done_at && x.due_date && !over && P.addDays(x.due_date, -(x.remind_days ?? 2)) <= day; return html`<tr class="${x.done_at ? 'done' : ''}"><td><form method="post" action="/admin/projects/${p.id}/milestones/${x.id}/toggle"><button class="chk-btn" title="${x.done_at ? 'Reopen' : 'Mark done'}" aria-label="${x.done_at ? 'Reopen' : 'Mark done'}">${x.done_at ? '☑' : '☐'}</button></form></td>
            <td>${x.title}</td><td>${x.invitation_id ? sname[invs.find((i) => i.id === x.invitation_id)?.supplier_id] || 'Supplier' : 'Whole project'}</td>
            <td class="${over ? 'neg' : soon ? 'warn-text' : ''}">${x.due_date ? fmt.date(x.due_date) : html`<span class="none">no date</span>`}${over ? ' · overdue' : soon ? ' · due soon' : ''}${x.done_at ? html`<div class="sub">done ${fmt.date(x.done_at)}</div>` : ''}</td><td>${x.remind_days} d before</td>
            <td class="r"><form class="inline" method="post" action="/admin/projects/${p.id}/milestones/${x.id}/delete" data-confirm="Delete this milestone?"><button class="link danger">Delete</button></form></td></tr>`; })}</tbody></table></div>` : html`<p class="d-empty">No milestones yet.</p>`}
        <form method="post" action="/admin/projects/${p.id}/milestones" class="ms-form"><label><span class="lbl">Milestone</span><input name="title" required maxlength="160" placeholder="e.g. First samples received"></label>
          <label><span class="lbl">Due date</span><input type="date" name="due_date"></label>
          <label><span class="lbl">Supplier (optional)</span><select name="invitation_id"><option value="">Whole project</option>${invs.map((i) => html`<option value="${i.id}">${sname[i.supplier_id]}</option>`)}</select></label>
          <label><span class="lbl">Remind</span><span class="inp-unit"><input name="remind_days" type="number" min="0" max="60" value="2"><i>days before</i></span></label>
          <div><button class="btn small">Add milestone</button></div></form></section>`;
    }
    res.html(page({ title: p.name, nav: adminNav('projects'), flash: takeFlash(req, res), wide: true, body: html`${header}${body}` }));
  }));

  router.post('/admin/projects/:id', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req);
    const extra = String(f.extra_fields || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).map((l) => ({ key: P.slug(l), label: l.slice(0, 120) }));
    const patch = { name: str(f.name, 160) || p.name, category: str(f.category, 80), summary: str(f.summary), requirements: str(f.requirements, 12000), certifications: str(f.certifications), extra_fields: extra, nda_required: f.nda_required === '1', nda_text: str(f.nda_text, 8000), updated_at: now() };
    if ('status' in f) { if (P.PROJECT_STATUSES.includes(f.status)) patch.status = f.status; patch.target_price_usd = num(f.target_price_usd); patch.target_moq = int(f.target_moq); patch.internal_notes = str(f.internal_notes); }
    await db.update('dev_projects', { id: p.id }, patch);
    flash(res, 'ok', 'Saved. Suppliers see the changes now. Publish a new version if the change matters for quotes.');
    res.redirect(`/admin/projects/${p.id}?tab=spec`);
  }));

  router.post('/admin/projects/:id/publish', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req);
    const note = str(f.change_note, 500); if (!note) { flash(res, 'error', 'Describe what changed'); return res.redirect(`/admin/projects/${p.id}?tab=spec`); }
    const v = p.current_version + 1;
    await db.insert('dev_spec_versions', { project_id: p.id, version: v, change_note: note, snapshot: { summary: p.summary, requirements: p.requirements, certifications: p.certifications }, created_at: now() });
    await db.update('dev_projects', { id: p.id }, { current_version: v, updated_at: now() });
    let sent = 0;
    if (f.notify === '1') {
      const invs = (await db.list('dev_invitations', { filters: { project_id: p.id } })).filter((i) => !['Declined', 'Closed'].includes(i.status));
      for (const i of invs) { const s = await db.get('suppliers', i.supplier_id); if (s && await P.notifySupplier(config, db, s, { subject: `[Lulyboo ${p.ref}] Spec updated to v${v} · 规格已更新至 v${v}`, en: `The specification for "${p.name}" was updated to v${v}.\nWhat changed: ${note}\nPlease review it and confirm in the portal.`, zh: `“${p.name}”的规格已更新至 v${v}。\n变更内容：${note}\n请在平台中查看并确认。`, link: link(i.id), email: { ref: p.ref, project: p.name, title: [`Specification updated to v${v}`, `规格已更新至 v${v}`], lead: ['The specification of this project has changed:', '以下项目的规格已更新：'], noteLabel: ['What changed', '变更内容'], note, points: [['Please review the new version and confirm it in the portal.', '请查看新版本并在平台中确认。'], ['If your quote is affected, submit a revised quote.', '如报价受影响，请提交修订报价。']], button: ['Review and confirm', '查看并确认'] } })) sent++; }
    }
    flash(res, 'ok', `Spec v${v} published${sent ? ` and ${sent} supplier(s) emailed` : ''}.`);
    res.redirect(`/admin/projects/${p.id}?tab=spec`);
  }));

  router.post('/admin/projects/:id/delete', G(async (req, res) => {
    const p = await loadProject(req.params.id);
    const files = await db.list('dev_files', { filters: { project_id: p.id } });
    const msgs = await db.list('dev_messages'); const invIds = new Set((await db.list('dev_invitations', { filters: { project_id: p.id } })).map((i) => i.id));
    const paths = [...files.map((x) => x.path), ...msgs.filter((x) => invIds.has(x.invitation_id)).flatMap((x) => (x.attachments || []).map((a) => a.path))];
    await db.docs.remove(paths.filter(Boolean)).catch(() => {});
    await db.remove('dev_projects', { id: p.id });
    flash(res, 'ok', 'Project deleted'); res.redirect('/admin/projects');
  }));

  // `label` (the plain-language description) needs the dev_files.label column; until the SQL is run, files still save without it.
  const saveFile = async (row) => { try { return await db.insert('dev_files', row); } catch (e) { if (/label/i.test(String(e.message)) && 'label' in row) { const { label, ...rest } = row; return db.insert('dev_files', rest); } throw e; } };
  router.post('/admin/projects/:id/files', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 5 });
    const r = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, 'files'), maxBytes });
    let meta = []; try { meta = JSON.parse(f.meta || '[]'); if (!Array.isArray(meta)) meta = []; } catch { meta = []; }
    for (const a of r.saved) {
      const m = meta[a.i] || { kind: f.kind, controlling: f.controlling === '1', internal: f.internal === '1' }; const kind = P.FILE_KINDS[m.kind] ? m.kind : P.guessKind(a.name);
      await saveFile({ project_id: p.id, name: a.name, kind, label: str(m.label, 120) || null, mime: a.mime, bytes: a.size, path: a.path, version: p.current_version, controlling: !!m.controlling && kind === 'drawing', internal: !!m.internal, created_at: now() });
    }
    flash(res, r.errors.length ? 'warn' : 'ok', r.saved.length ? `${r.saved.length} file(s) added${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}` : (r.errors.join(' · ') || 'Choose at least one file'));
    res.redirect(`/admin/projects/${p.id}?tab=files`);
  }));
  router.post('/admin/projects/:id/files/:fid/update', G(async (req, res) => {
    const f = await db.get('dev_files', req.params.fid); const { fields: b } = await parseForm(req);
    if (f && f.project_id === req.params.id) {
      const kind = P.FILE_KINDS[b.kind] ? b.kind : f.kind;
      const patch = { kind, label: str(b.label, 120) || null, controlling: b.controlling === '1' && kind === 'drawing', internal: b.internal === '1' };
      try { await db.update('dev_files', { id: f.id }, patch); } catch (e) { if (!/label/i.test(String(e.message))) throw e; const { label, ...rest } = patch; await db.update('dev_files', { id: f.id }, rest); }
      flash(res, 'ok', 'File updated');
    }
    res.redirect(`/admin/projects/${req.params.id}?tab=files`);
  }));
  router.post('/admin/projects/:id/files/:fid/delete', G(async (req, res) => {
    const f = await db.get('dev_files', req.params.fid);
    if (f && f.project_id === req.params.id) { await db.docs.remove([f.path]).catch(() => {}); await db.remove('dev_files', { id: f.id }); flash(res, 'ok', 'File removed'); }
    res.redirect(`/admin/projects/${req.params.id}?tab=files`);
  }));
  router.get('/admin/dev-files/att/:msgId/:idx', G(async (req, res) => {
    const msg = await db.get('dev_messages', req.params.msgId); const a = msg?.attachments?.[Number(req.params.idx)];
    if (!a) throw new HttpError(404, 'File not found'); serve(res, await db.docs.download(a.path), a.name, a.mime, req.query.inline === '1');
  }));
  router.get('/admin/dev-files/quote/:quoteId/:idx', G(async (req, res) => {
    const q = await db.get('dev_quotes', req.params.quoteId); const a = q?.attachments?.[Number(req.params.idx)];
    if (!a) throw new HttpError(404, 'File not found'); serve(res, await db.docs.download(a.path), a.name, a.mime, req.query.inline === '1');
  }));
  router.get('/admin/dev-files/:fid', G(async (req, res) => {
    const f = await db.get('dev_files', req.params.fid); if (!f) throw new HttpError(404, 'File not found');
    serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
  }));

  router.post('/admin/projects/:id/invite', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req);
    const ids = [].concat(f.supplier_ids || []).filter(Boolean); if (!ids.length) { flash(res, 'warn', 'Tick at least one supplier'); return res.redirect(`/admin/projects/${p.id}?tab=suppliers`); }
    const have = new Set((await db.list('dev_invitations', { filters: { project_id: p.id } })).map((i) => i.supplier_id)); let n = 0; let mailed = 0;
    for (const sid of ids) {
      if (have.has(sid)) continue; const s = await db.get('suppliers', sid); if (!s) continue;
      const inv = await db.insert('dev_invitations', { project_id: p.id, supplier_id: sid, status: 'Invited', message: str(f.message, 2000), ack_version: p.current_version, created_at: now(), updated_at: now() }); n++;
      if (f.send_email === '1' && await P.notifySupplier(config, db, s, { subject: `[Lulyboo ${p.ref}] New development project · 新开发项目: ${p.name}`, en: `You are invited to quote on a new development project: "${p.name}".${f.message ? `\n\n${str(f.message, 2000)}` : ''}\n\nPlease review the specification and drawings, ask questions if anything is unclear, and submit your quote in the portal.${p.nda_required ? '\nThis project requires you to accept a confidentiality agreement first.' : ''}`, zh: `邀请您为新开发项目“${p.name}”报价。${f.message ? `\n\n${str(f.message, 2000)}` : ''}\n\n请查看规格和图纸，如有疑问请提问，并在平台中提交报价。${p.nda_required ? '\n此项目需要您先接受保密协议。' : ''}`, link: link(inv.id), email: { ref: p.ref, project: p.name, title: ['New development project', '新开发项目'], lead: ['You are invited to quote on a new development project:', '邀请您为以下新开发项目报价：'], noteLabel: ['Message from Lulyboo', 'Lulyboo 留言'], note: str(f.message, 2000), points: [...(p.nda_required ? [['First accept the confidentiality agreement (NDA) in the portal.', '请先在平台中接受保密协议（NDA）。']] : []), ['Review the specification, drawings and files.', '查看规格、图纸和文件。'], ['Ask questions in the project thread if anything is unclear.', '如有疑问，请在项目对话中提问。'], ['Submit your quote in the portal.', '在平台中提交报价。']], button: ['Open project', '打开项目'] } })) mailed++;
    }
    if (n && p.status === 'Draft') await db.update('dev_projects', { id: p.id }, { status: 'Sourcing', updated_at: now() });
    flash(res, 'ok', n ? `${n} supplier(s) invited${mailed ? `, ${mailed} emailed` : (f.send_email === '1' ? '. Email could not be sent: check Resend settings.' : '')}.` : 'Nothing to invite');
    res.redirect(`/admin/projects/${p.id}?tab=suppliers`);
  }));

  router.get('/admin/projects/:id/suppliers/:invId', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId);
    const [s, msgs, quotes] = await Promise.all([db.get('suppliers', inv.supplier_id), db.list('dev_messages', { filters: { invitation_id: inv.id }, order: 'created_at.asc' }), db.list('dev_quotes', { filters: { invitation_id: inv.id }, order: 'revision.desc' })]);
    res.html(page({
      title: `${s?.name} · ${p.name}`, nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/projects">Development</a><span>›</span><a href="/admin/projects/${p.id}?tab=suppliers">${p.name}</a><span>›</span><b>${s?.name}</b></nav>
      <div class="head-row"><div><h1>${s?.name}</h1><ul class="pp-meta"><li><span class="pill ${pillCls(inv.status)}">${inv.status}</span></li><li>${p.ref}</li><li>Confirmed spec v${inv.ack_version} of v${p.current_version}</li>${p.nda_required ? html`<li>${inv.nda_accepted_at ? `NDA accepted ${fmt.date(inv.nda_accepted_at)} by ${inv.nda_accepted_by || ''}` : 'NDA not accepted'}</li>` : ''}<li><a href="/admin/suppliers/${s?.id}">Supplier profile</a></li></ul></div>
        <form method="post" action="/admin/projects/${p.id}/suppliers/${inv.id}/status" class="inline-form"><select name="status" aria-label="Status">${P.INV_STATUSES.map((x) => html`<option ${x === inv.status ? raw('selected') : ''}>${x}</option>`)}</select><button class="btn small ghost">Set status</button></form></div>
      <div class="dp-thread"><section class="card"><h2 class="sec">Conversation</h2>
        <div class="msgs">${msgs.length ? msgs.map((x) => html`<article class="msg ${x.direction}"><header><b>${x.direction === 'supplier' ? (x.author || s?.name) : (x.author || 'Lulyboo')}</b><span class="sub">${fmt.date(x.created_at)}</span></header><p>${x.body}</p>${attLinks(x.attachments, (i) => `/admin/dev-files/att/${x.id}/${i}`)}</article>`) : html`<p class="d-empty">No messages yet.</p>`}</div>
        <form method="post" enctype="multipart/form-data" action="/admin/projects/${p.id}/suppliers/${inv.id}/message" class="fields mt"><label class="frow top"><span>Reply</span><textarea name="body" rows="4" required placeholder="Ask for more information or answer a question. The supplier is emailed."></textarea></label>
          <label class="frow"><span>Attach</span>${multiFile('files')}</label><label class="chk"><input type="checkbox" name="notify" value="1" checked> Email the supplier</label><div class="form-actions"><button class="btn">Send</button></div></form></section>
        <aside class="dp-side"><section class="card"><h2 class="sec">Latest quote${quotes[0] ? html` <span class="sub">rev ${quotes[0].revision} · ${fmt.date(quotes[0].created_at)}${quotes[0].spec_version < p.current_version ? ` · on spec v${quotes[0].spec_version}` : ''}</span>` : ''}</h2>${quoteCards(quotes[0], p, { admin: true })}${quotes[0] ? attLinks(quotes[0].attachments, (i) => `/admin/dev-files/quote/${quotes[0].id}/${i}`) : ''}
          ${quotes.length > 1 ? html`<details class="fold mt"><summary><b>Earlier revisions (${quotes.length - 1})</b></summary>${quotes.slice(1).map((q) => html`<h3 class="sec2">Rev ${q.revision} · ${fmt.date(q.created_at)}</h3>${quoteCards(q, p, { admin: true })}`)}</details>` : ''}</section></aside></div>`,
    }));
  }));
  router.post('/admin/projects/:id/suppliers/:invId/status', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const { fields: f } = await parseForm(req);
    if (P.INV_STATUSES.includes(f.status)) await db.update('dev_invitations', { id: inv.id }, { status: f.status, updated_at: now() });
    flash(res, 'ok', 'Status updated'); res.redirect(`/admin/projects/${p.id}/suppliers/${inv.id}`);
  }));
  router.post('/admin/projects/:id/suppliers/:invId/message', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 5 });
    const body = str(f.body, 6000); if (!body) { flash(res, 'error', 'Write a message'); return res.redirect(`/admin/projects/${p.id}/suppliers/${inv.id}`); }
    const r = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, 'files'), maxBytes });
    await db.insert('dev_messages', { invitation_id: inv.id, direction: 'admin', author: ST.current()?.name || 'Lulyboo', body, attachments: r.saved, created_at: now() });
    await db.update('dev_invitations', { id: inv.id }, { updated_at: now() });
    const s = await db.get('suppliers', inv.supplier_id); let mailed = false;
    if (f.notify === '1' && s) mailed = await P.notifySupplier(config, db, s, { subject: `[Lulyboo ${p.ref}] New message · 新消息: ${p.name}`, en: `New message about "${p.name}":\n\n${body}${r.saved.length ? `\n\n(${r.saved.length} attachment(s) in the portal)` : ''}`, zh: `关于“${p.name}”的新消息：\n\n${body}${r.saved.length ? `\n\n（平台中有 ${r.saved.length} 个附件）` : ''}`, link: link(inv.id), email: { ref: p.ref, project: p.name, title: ['New message from Lulyboo', 'Lulyboo 新消息'], lead: ['You have a new message about this project:', '关于以下项目，您有一条新消息：'], noteLabel: ['Message', '消息内容'], note: body, points: r.saved.length ? [[`${r.saved.length} attachment(s) are waiting in the portal.`, `平台中有 ${r.saved.length} 个附件。`]] : [], button: ['Reply in the portal', '在平台中回复'] } });
    flash(res, r.errors.length ? 'warn' : 'ok', `Message sent${mailed ? ' and supplier emailed' : ''}${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}`);
    res.redirect(`/admin/projects/${p.id}/suppliers/${inv.id}`);
  }));

  // Milestones
  const back = (res, id) => res.redirect(`/admin/projects/${id}?tab=milestones`);
  router.post('/admin/projects/:id/milestones', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req); const title = str(f.title, 160);
    if (title) { const n = (await db.list('dev_milestones', { filters: { project_id: p.id } })).length; await db.insert('dev_milestones', { project_id: p.id, invitation_id: f.invitation_id || null, title, due_date: /^\d{4}-\d{2}-\d{2}$/.test(f.due_date || '') ? f.due_date : null, remind_days: Math.min(60, Math.max(0, int(f.remind_days) ?? 2)), sort: n, created_at: now() }); flash(res, 'ok', 'Milestone added'); }
    back(res, p.id);
  }));
  router.post('/admin/projects/:id/milestones/standard', G(async (req, res) => {
    const p = await loadProject(req.params.id); const n = (await db.list('dev_milestones', { filters: { project_id: p.id } })).length; const d = P.today();
    for (const [i, [title, days]] of P.STD_MILESTONES.entries()) await db.insert('dev_milestones', { project_id: p.id, title, due_date: P.addDays(d, days), remind_days: 2, sort: n + i, created_at: now() });
    flash(res, 'ok', 'Standard plan added. Adjust the dates to your timeline.'); back(res, p.id);
  }));
  router.post('/admin/projects/:id/milestones/:mid/toggle', G(async (req, res) => {
    const x = await db.get('dev_milestones', req.params.mid);
    if (x && x.project_id === req.params.id) await db.update('dev_milestones', { id: x.id }, { done_at: x.done_at ? null : now(), reminded_at: null, overdue_notice_on: null });
    back(res, req.params.id);
  }));
  router.post('/admin/projects/:id/milestones/:mid/delete', G(async (req, res) => {
    const x = await db.get('dev_milestones', req.params.mid); if (x && x.project_id === req.params.id) await db.remove('dev_milestones', { id: x.id }); back(res, req.params.id);
  }));

  // ═════════════════════════ SUPPLIER PORTAL ═════════════════════════
  const NA = m('Project not found', '未找到该项目');
  async function ownInv(req) {
    const inv = await db.get('dev_invitations', req.params.invId);
    if (!inv || inv.supplier_id !== req.supplier.id) throw new HttpError(404, NA);
    const p = await db.get('dev_projects', inv.project_id); if (!p) throw new HttpError(404, NA);
    return { inv, p };
  }
  const nav = () => require('./supplier').nav('projects');
  const ndaGate = (p, inv) => p.nda_required && !inv.nda_accepted_at;

  router.get('/portal/projects', A(async (req, res) => {
    const invs = (await db.list('dev_invitations', { filters: { supplier_id: req.supplier.id }, order: 'created_at.desc' })).filter((i) => i.status !== 'Closed');
    const projects = Object.fromEntries((await db.list('dev_projects')).filter((p) => invs.some((i) => i.project_id === p.id)).map((p) => [p.id, p]));
    const quoted = new Set((await db.list('dev_quotes')).map((q) => q.invitation_id));
    res.html(page({ title: 'Development projects', nav: nav(), flash: takeFlash(req, res), req,
      body: html`<h1>${t('Development projects', '开发项目')}</h1><p class="muted">${t('Products Lulyboo invites you to quote on. Open a project to see the specification, ask questions and submit your quote.', 'Lulyboo 邀请您报价的产品。打开项目可查看规格、提问并提交报价。')}</p>
      ${invs.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>${t('Project', '项目')}</th><th>${t('Status', '状态')}</th><th>${t('Action needed', '待办')}</th></tr></thead><tbody>${invs.map((i) => { const p = projects[i.project_id]; if (!p) return ''; const need = ndaGate(p, i) ? t('Accept the NDA', '请接受保密协议') : i.ack_version < p.current_version ? t(`Confirm spec v${p.current_version}`, `请确认规格 v${p.current_version}`) : !quoted.has(i.id) && !['Declined'].includes(i.status) ? t('Submit your quote', '请提交报价') : '';
        return html`<tr><td><a class="sp-name" href="/portal/projects/${i.id}">${p.name}</a><div class="sub">${p.ref}${p.category ? ` · ${p.category}` : ''}</div></td><td><span class="pill ${pillCls(i.status)}">${i.status === 'Quoted' ? t('Quoted', '已报价') : i.status === 'Declined' ? t('Declined', '已婉拒') : i.status === 'Selected' ? t('Selected', '已选中') : i.status === 'Sample' ? t('Sampling', '样品中') : t('Open', '进行中')}</span></td><td>${need ? html`<span class="neg">${need}</span>` : html`<span class="none">—</span>`}</td></tr>`; })}</tbody></table></div>` : html`<div class="card empty-state"><p><b>${t('No projects yet', '暂无项目')}</b></p><p class="muted">${t('When Lulyboo invites you to a development project it appears here.', 'Lulyboo 邀请您参与开发项目后，将显示在此处。')}</p></div>`}` }));
  }));

  router.get('/portal/projects/:invId', A(async (req, res) => {
    const { inv, p } = await ownInv(req);
    if (ndaGate(p, inv)) {
      return res.html(page({ title: p.name, nav: nav(), flash: takeFlash(req, res), req, body: html`<h1>${p.name}</h1>
        <section class="card"><h2 class="sec">${t('Confidentiality agreement', '保密协议')}</h2><p class="muted">${t('Please accept before viewing the specification and drawings.', '查看规格和图纸前，请先接受以下条款。')}</p>
          <div class="nda-box">${p.nda_text || html`${t('The specification, drawings, samples and any related information for this project are confidential and belong to Lulyboo. You agree to use them only to prepare a quotation and to produce for Lulyboo, not to share them with third parties, and not to make products from them for anyone else.', '本项目的规格、图纸、样品及相关信息均属保密信息，归 Lulyboo 所有。您同意仅将其用于报价及为 Lulyboo 生产，不向第三方披露，也不为他人据此生产产品。')}`}</div>
          <form method="post" action="/portal/projects/${inv.id}/nda" class="mt"><label class="chk"><input type="checkbox" name="agree" value="1" required> ${t('I have authority to accept this on behalf of my company and I agree.', '我有权代表公司接受，并同意以上条款。')}</label><div class="form-actions"><button class="btn">${t('Accept and continue', '接受并继续')}</button></div></form></section>` }));
    }
    if (!inv.viewed_at) await db.update('dev_invitations', { id: inv.id }, { viewed_at: now(), status: inv.status === 'Invited' ? 'Viewed' : inv.status });
    const [files, versions, msgs, quotes] = await Promise.all([db.list('dev_files', { filters: { project_id: p.id }, order: 'created_at.asc' }), db.list('dev_spec_versions', { filters: { project_id: p.id }, order: 'version.desc' }), db.list('dev_messages', { filters: { invitation_id: inv.id }, order: 'created_at.asc' }), db.list('dev_quotes', { filters: { invitation_id: inv.id }, order: 'revision.desc' })]);
    const vis = files.filter((x) => !x.internal); const supTitles = P.fileTitles(vis, true); const q = quotes[0]; const locked = ['Declined', 'Selected', 'Closed'].includes(inv.status);
    const needAck = inv.ack_version < p.current_version;
    const val = (k) => (q ? q[k] ?? '' : '');
    res.html(page({ title: p.name, nav: nav(), flash: takeFlash(req, res), req, wide: true,
      body: html`<nav class="crumb"><a href="/portal/projects">${t('Development projects', '开发项目')}</a><span>›</span><b>${p.name}</b></nav>
      <div class="head-row"><div><h1>${p.name}</h1><ul class="pp-meta"><li>${p.ref}</li>${p.category ? html`<li>${p.category}</li>` : ''}<li>${t('Spec', '规格')} v${p.current_version}</li><li><span class="pill ${pillCls(inv.status)}">${inv.status}</span></li></ul></div></div>
      ${needAck ? html`<div class="flash warn"><b>${t(`The specification was updated to v${p.current_version}.`, `规格已更新至 v${p.current_version}。`)}</b> ${versions[0]?.change_note || ''}
        <form method="post" action="/portal/projects/${inv.id}/ack" class="inline"><button class="btn small">${t('I have reviewed it', '我已查看')}</button></form></div>` : ''}
      ${inv.message ? html`<div class="notice info"><b>${t('Message from Lulyboo', '来自 Lulyboo 的留言')}</b><p>${inv.message}</p></div>` : ''}
      <div class="dp-thread">
        <div class="dp-main">
          <section class="card"><h2 class="sec">${t('Specification', '规格要求')}</h2>${p.summary ? html`<p class="pd-desc">${p.summary}</p>` : ''}
            ${p.requirements ? html`<h3 class="sec2">${t('Requirements', '要求')}</h3><p class="pd-desc pre">${p.requirements}</p>` : ''}
            ${p.certifications ? html`<h3 class="sec2">${t('Certifications / standards', '认证 / 标准')}</h3><p class="pd-desc pre">${p.certifications}</p>` : ''}
            ${versions.length > 1 ? html`<details class="fold mt"><summary><b>${t('Change history', '变更记录')}</b></summary><ul class="feed">${versions.map((v) => html`<li><span class="date">${fmt.date(v.created_at)}</span><b>v${v.version}</b> ${v.change_note || ''}</li>`)}</ul></details>` : ''}</section>
          <section class="card"><h2 class="sec">${t('Files', '文件')} <span class="count">${vis.length}</span></h2>${vis.length ? html`<ul class="fl">${vis.map((f) => html`<li class="fl-row"><div class="fl-thumb">${THUMB_OK.test(f.name) ? html`<img src="/portal/projects/${inv.id}/files/${f.id}?inline=1" alt="" loading="lazy">` : html`<span aria-hidden="true">${kindIcon(f.kind)}</span>`}</div><div class="fl-main"><div class="fl-title">${supTitles.get(f.id)}${f.controlling ? html` <span class="pill s-selected">${t('Controlling drawing', '主图纸')}</span>` : ''}</div><div class="fl-meta">${t(P.FILE_KINDS[f.kind] || f.kind, P.FILE_KINDS_ZH[f.kind] || f.kind)} · ${P.extOf(f.name).slice(1).toUpperCase()} · ${bytes(f.bytes)} · v${f.version}</div></div><div class="fl-act">${P.INLINE_OK.test(f.name) ? html`<a href="/portal/projects/${inv.id}/files/${f.id}?inline=1" target="_blank" rel="noopener">${t('Preview', '预览')}</a>` : ''}<a href="/portal/projects/${inv.id}/files/${f.id}">${t('Download', '下载')}</a></div></li>`)}</ul>` : html`<p class="d-empty">${t('No files yet.', '暂无文件。')}</p>`}</section>
          <section class="card"><h2 class="sec">${t('Questions & answers', '问答')}</h2>
            <div class="msgs">${msgs.length ? msgs.map((x) => html`<article class="msg ${x.direction}"><header><b>${x.direction === 'supplier' ? t('You', '您') : 'Lulyboo'}</b><span class="sub">${fmt.date(x.created_at)}</span></header><p>${x.body}</p>${attLinks(x.attachments, (i) => `/portal/projects/${inv.id}/att/${x.id}/${i}`)}</article>`) : html`<p class="d-empty">${t('Ask Lulyboo anything that is unclear.', '如有不清楚之处，请随时向 Lulyboo 提问。')}</p>`}</div>
            ${locked ? '' : html`<form method="post" enctype="multipart/form-data" action="/portal/projects/${inv.id}/message" class="fields mt"><label class="frow top"><span>${t('Message', '留言')}</span><textarea name="body" rows="3" required></textarea></label><label class="frow"><span>${t('Attach', '附件')}</span>${multiFile('files')}</label><div class="form-actions"><button class="btn">${t('Send', '发送')}</button></div></form>`}</section>
        </div>
        <aside class="dp-side"><section class="card" id="quote"><h2 class="sec">${t('Your quote', '您的报价')}${q ? html` <span class="sub">rev ${q.revision} · ${fmt.date(q.created_at)}</span>` : ''}</h2>
          ${q ? quoteCards(q, p) : ''}${q ? attLinks(q.attachments, (i) => `/portal/projects/${inv.id}/quote-att/${q.id}/${i}`) : ''}
          ${locked ? html`<p class="muted">${inv.status === 'Declined' ? t('You declined this project.', '您已婉拒此项目。') : t('This project is closed for new quotes.', '此项目已不再接受新报价。')}</p>` : html`
          <details class="fold mt" ${q ? '' : raw('open')}><summary><b>${q ? t('Submit a revised quote', '提交修订报价') : t('Submit your quote', '提交报价')}</b></summary>
            <form method="post" enctype="multipart/form-data" action="/portal/projects/${inv.id}/quote" class="fields q-form">
              <div class="q-row"><label><span class="lbl">${t('Currency', '币种')}</span><select name="currency">${F.CURRENCIES.map((c) => html`<option ${c === (q?.currency || 'USD') ? raw('selected') : ''}>${c}</option>`)}</select></label>
                <label><span class="lbl">${t('Incoterm', '贸易术语')}</span><select name="incoterm">${F.INCOTERMS.map((c) => html`<option ${c === (q?.incoterm || 'FOB') ? raw('selected') : ''}>${c}</option>`)}</select></label></div>
              <p class="lbl">${t('Unit price by quantity', '按数量的单价')}</p>
              ${[0, 1, 2].map((n) => html`<div class="q-row"><label><span class="lbl">${t('Quantity', '数量')} ${n + 1}</span><span class="inp-unit"><input name="qty${n}" type="number" min="1" step="1" value="${q?.tiers?.[n]?.qty ?? ''}" ${n === 0 ? raw('required') : ''}><i>${t('pcs', '件')}</i></span></label><label><span class="lbl">${t('Unit price', '单价')} ${n + 1}</span><span class="inp-unit"><input name="price${n}" type="number" min="0" step="0.0001" value="${q?.tiers?.[n]?.price ?? ''}" ${n === 0 ? raw('required') : ''}><i>${t('each', '每件')}</i></span></label></div>`)}
              <div class="q-row"><label><span class="lbl">${t('Tooling cost', '模具费')}</span><span class="inp-unit"><input name="tooling_cost" type="number" min="0" step="0.01" value="${val('tooling_cost')}"></span></label><label><span class="lbl">${t('Tooling lead time', '模具周期')}</span><span class="inp-unit"><input name="tooling_lead_days" type="number" min="0" value="${val('tooling_lead_days')}"><i>${t('days', '天')}</i></span></label></div>
              <div class="q-row"><label><span class="lbl">MOQ</span><span class="inp-unit"><input name="moq" type="number" min="0" value="${val('moq')}"><i>${t('pcs', '件')}</i></span></label><label><span class="lbl">${t('Production lead time', '生产周期')}</span><span class="inp-unit"><input name="production_lead_days" type="number" min="0" value="${val('production_lead_days')}"><i>${t('days', '天')}</i></span></label></div>
              <div class="q-row"><label><span class="lbl">${t('Sample cost', '样品费')}</span><span class="inp-unit"><input name="sample_cost" type="number" min="0" step="0.01" value="${val('sample_cost')}"></span></label><label><span class="lbl">${t('Sample lead time', '样品周期')}</span><span class="inp-unit"><input name="sample_lead_days" type="number" min="0" value="${val('sample_lead_days')}"><i>${t('days', '天')}</i></span></label></div>
              <div class="q-row"><label><span class="lbl">${t('Quote valid until', '报价有效期至')}</span><input type="date" name="validity_date" value="${val('validity_date')}"></label><label><span class="lbl">${t('Payment terms', '付款条款')}</span><input name="payment_terms" value="${val('payment_terms')}" placeholder="30% deposit, 70% before shipment"></label></div>
              <label><span class="lbl">${t('Material quoted', '报价所用材质')}</span><input name="material_notes" value="${val('material_notes')}"></label>
              ${(p.extra_fields || []).map((x) => html`<label><span class="lbl">${x.label}</span><input name="x_${x.key}" value="${(q?.custom || []).find((c) => c.label === x.label)?.value || ''}"></label>`)}
              <label><span class="lbl">${t('Notes, assumptions, suggested changes (DFM)', '备注、假设、改进建议（DFM）')}</span><textarea name="notes" rows="4">${val('notes')}</textarea></label>
              <label><span class="lbl">${t('Attach your own quotation or files', '附上您自己的报价单或文件')}</span>${multiFile('files')}</label>
              <div class="form-actions"><button class="btn">${q ? t('Submit revised quote', '提交修订报价') : t('Submit quote', '提交报价')}</button></div></form></details>
          <form method="post" action="/portal/projects/${inv.id}/decline" class="mt"${confirmAttr('Decline this project? Lulyboo will be told you will not quote.', '婉拒此项目？Lulyboo 将收到您不报价的通知。')}><button class="link danger">${t('Decline this project', '婉拒此项目')}</button></form>`}</section></aside></div>` }));
  }));

  const toDetail = (res, id) => res.redirect(`/portal/projects/${id}`);
  router.post('/portal/projects/:invId/nda', A(async (req, res) => {
    const { inv } = await ownInv(req); const { fields: f } = await parseForm(req);
    if (f.agree === '1' && !inv.nda_accepted_at) await db.update('dev_invitations', { id: inv.id }, { nda_accepted_at: now(), nda_accepted_by: req.user?.email || null, updated_at: now() });
    toDetail(res, inv.id);
  }));
  router.post('/portal/projects/:invId/ack', A(async (req, res) => {
    const { inv, p } = await ownInv(req); await db.update('dev_invitations', { id: inv.id }, { ack_version: p.current_version, updated_at: now() });
    await notifyAdmin(p, inv, `confirmed spec v${p.current_version}`); toDetail(res, inv.id);
  }));
  const notifyAdmin = async (p, inv, what, extra = '') => { const s = await db.get('suppliers', inv.supplier_id); await P.notifyOwner(config, `[${p.ref}] ${s?.name || 'Supplier'} ${what}`, `${s?.name || 'A supplier'} ${what} on "${p.name}".${extra ? `\n\n${extra}` : ''}\n\n${config.publicUrl}/admin/projects/${p.id}/suppliers/${inv.id}`); };

  router.get('/portal/projects/:invId/files/:fid', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv)) throw new HttpError(403, NA);
    const f = await db.get('dev_files', req.params.fid); if (!f || f.project_id !== p.id || f.internal) throw new HttpError(404, NA);
    serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
  }));
  router.get('/portal/projects/:invId/att/:msgId/:idx', A(async (req, res) => {
    const { inv } = await ownInv(req); const msg = await db.get('dev_messages', req.params.msgId); const a = msg?.invitation_id === inv.id ? msg.attachments?.[Number(req.params.idx)] : null;
    if (!a) throw new HttpError(404, NA); serve(res, await db.docs.download(a.path), a.name, a.mime, req.query.inline === '1');
  }));
  router.get('/portal/projects/:invId/quote-att/:quoteId/:idx', A(async (req, res) => {
    const { inv } = await ownInv(req); const q = await db.get('dev_quotes', req.params.quoteId); const a = q?.invitation_id === inv.id ? q.attachments?.[Number(req.params.idx)] : null;
    if (!a) throw new HttpError(404, NA); serve(res, await db.docs.download(a.path), a.name, a.mime, req.query.inline === '1');
  }));

  router.post('/portal/projects/:invId/message', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv)) throw new HttpError(403, NA);
    const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 5 }); const body = str(f.body, 6000);
    if (!body) { flash(res, 'error', m('Write a message first', '请先填写留言')); return toDetail(res, inv.id); }
    const r = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, 'files'), maxBytes });
    await db.insert('dev_messages', { invitation_id: inv.id, direction: 'supplier', author: req.user?.name || req.user?.email || null, body, attachments: r.saved, created_at: now() });
    await db.update('dev_invitations', { id: inv.id }, { status: ['Invited', 'Viewed'].includes(inv.status) ? 'Questions' : inv.status, updated_at: now() });
    await notifyAdmin(p, inv, 'sent a message', body);
    flash(res, r.errors.length ? 'warn' : 'ok', m('Message sent', '留言已发送') + (r.errors.length ? ' · ' + r.errors.join(' · ') : '')); toDetail(res, inv.id);
  }));

  router.post('/portal/projects/:invId/quote', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv) || ['Declined', 'Selected', 'Closed'].includes(inv.status)) throw new HttpError(403, NA);
    const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 5 });
    const tiers = [0, 1, 2].map((n) => ({ qty: int(f[`qty${n}`]), price: num(f[`price${n}`]) })).filter((x) => x.qty && x.price !== null && x.price >= 0);
    if (!tiers.length) { flash(res, 'error', m('Enter at least one quantity and unit price', '请至少填写一个数量及单价')); return toDetail(res, inv.id); }
    const r = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, 'files'), maxBytes });
    const prev = await latestQuote(inv.id);
    const custom = (p.extra_fields || []).map((x) => ({ label: x.label, value: str(f[`x_${x.key}`], 500) })).filter((c) => c.value);
    await db.insert('dev_quotes', { invitation_id: inv.id, revision: (prev?.revision || 0) + 1, spec_version: p.current_version, currency: F.CURRENCIES.includes(f.currency) ? f.currency : 'USD', incoterm: F.INCOTERMS.includes(f.incoterm) ? f.incoterm : null, tiers,
      tooling_cost: num(f.tooling_cost), tooling_lead_days: int(f.tooling_lead_days), moq: int(f.moq), sample_cost: num(f.sample_cost), sample_lead_days: int(f.sample_lead_days), production_lead_days: int(f.production_lead_days),
      validity_date: /^\d{4}-\d{2}-\d{2}$/.test(f.validity_date || '') ? f.validity_date : null, payment_terms: str(f.payment_terms, 300), material_notes: str(f.material_notes, 300), custom, notes: str(f.notes, 4000), attachments: r.saved.length ? r.saved : (prev?.attachments || []), created_at: now() });
    await db.update('dev_invitations', { id: inv.id }, { status: inv.status === 'Sample' ? 'Sample' : 'Quoted', ack_version: p.current_version, updated_at: now() });
    await notifyAdmin(p, inv, prev ? `submitted a revised quote (rev ${prev.revision + 1})` : 'submitted a quote', `Unit price ${tiers[0].price} ${f.currency || 'USD'} at ${tiers[0].qty}+ pcs`);
    flash(res, r.errors.length ? 'warn' : 'ok', m('Quote submitted. Thank you!', '报价已提交，谢谢！') + (r.errors.length ? ' · ' + r.errors.join(' · ') : '')); toDetail(res, inv.id);
  }));
  router.post('/portal/projects/:invId/decline', A(async (req, res) => {
    const { inv, p } = await ownInv(req); await db.update('dev_invitations', { id: inv.id }, { status: 'Declined', updated_at: now() });
    await db.insert('dev_messages', { invitation_id: inv.id, direction: 'supplier', author: req.user?.name || req.user?.email || null, body: '(Declined to quote)', attachments: [], created_at: now() });
    await notifyAdmin(p, inv, 'declined to quote'); flash(res, 'ok', m('You have declined this project.', '您已婉拒此项目。')); toDetail(res, inv.id);
  }));
};
