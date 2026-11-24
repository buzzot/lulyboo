'use strict';
// Product development projects.
//   Admin  /admin/projects ...   create a project (spec + files), invite suppliers, answer questions, compare quotes, milestones
//   Portal /portal/projects ...  each supplier sees ONLY its own invitation: spec, files, its own thread, its own quote
// Suppliers never see other suppliers, the internal target price/MOQ, internal notes or internal files.

const { html, raw, fmt, t, m, biText, confirmAttr } = require('../lib/html');
const { icon } = require('../views/icons');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const DE = require('../dev-email');
const { currentSupplierUser } = require('../auth');
const ST = require('../staff');
const F = require('../fields');
const P = require('../projects');
const DM = require('../dev-manual');
const DD = require('../dev-draft');
const CK = require('../checklists');
const { ddSel } = require('./logistics-costs');
const { serveFile: serveCk } = require('./category-checklists');

const num = (x) => { if (x === undefined || x === null || String(x).trim() === '') return null; const n = Number(String(x).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const int = (x) => { const n = num(x); return n === null ? null : Math.round(n); };
const str = (x, max = 4000) => { const s = String(x ?? '').replace(/\r/g, '').trim().slice(0, max); return s || null; };
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const pillCls = (s) => ({ Quoted: 's-reviewing', Selected: 's-selected', Declined: 's-closed', Closed: 's-closed', Sample: 's-reviewing', Questions: 's-new', Invited: '', Viewed: '' }[s] ?? '');
const serve = (res, buf, name, type, inline) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', inline && P.INLINE_OK.test(name) ? (P.MIME[P.extOf(name)] || type || 'application/octet-stream') : (type || 'application/octet-stream'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (inline && P.INLINE_OK.test(name)) {
    // Previews open inside the portal's popup, so same-origin framing is allowed. PDFs need the browser's viewer (no sandbox); other types stay sandboxed.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', /\.pdf$/i.test(name) ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  }
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
// Message time: rendered in California time on the server, then switched to the viewer's own time zone by public/app.js.
const when = (iso) => { if (!iso) return ''; let txt = iso; try { txt = new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' }); } catch {} return html`<time class="sub" datetime="${iso}" data-local>${txt}</time>`; };
const THUMB_OK = /\.(png|jpe?g|webp|gif)$/i;
const kindIcon = (k) => ({ drawing: '📐', image: '🖼️', spec: '📄', certificate: '✅', other: '📎' }[k] || '📎');
// Attachments as tiles: a thumbnail (images) or file-type icon, size, and a download button. No file names.
// Click a previewable tile to open it in a popup (public/app.js [data-preview]); others download.
// Email messages: what the writer asked or promised, and the original email folded away.
const emailExtras = (x) => {
  if (!['email', 'manual'].includes(x.source) || !x.email) return '';
  const e = x.email; const q = e.questions || []; const c = e.commitments || [];
  const orig = x.source === 'manual' ? (e.summarized && e.text ? html`<details class="em-orig"><summary>Original message${e.language && e.language !== 'English' ? ` (${e.language})` : ''}</summary><pre>${e.text}</pre></details>` : '') : null;
  const saved = e.quote_id ? html`<p class="mq-saved">✓ Saved as latest quote${e.quote_line ? ` · ${e.quote_line}` : ''}</p>` : '';
  if (orig !== null) return html`${q.length || c.length ? html`<ul class="em-points">${q.map((v) => html`<li><span class="em-tag q">Question</span>${v}</li>`)}${c.map((v) => html`<li><span class="em-tag c">Commitment</span>${v}</li>`)}</ul>` : ''}${orig}${saved}`;
  return html`${q.length || c.length ? html`<ul class="em-points">${q.map((v) => html`<li><span class="em-tag q">Question</span>${v}</li>`)}${c.map((v) => html`<li><span class="em-tag c">Commitment</span>${v}</li>`)}</ul>` : ''}
    ${e.text ? html`<details class="em-orig"><summary>Original email${e.language && e.language !== 'English' ? ` (${e.language})` : ''}</summary><div class="em-meta">${e.from || ''}${e.subject ? html` · ${e.subject}` : ''}</div><pre>${e.text}</pre></details>` : ''}`;
};
const attLinks = (list, hrefOf) => {
  if (!list?.length) return '';
  if (!list.some((a) => a.cat)) return attTiles(list.map((a, i) => [a, i]), hrefOf);
  const groups = [...DM.CAT_ORDER, null].map((c) => [c, list.map((a, i) => [a, i]).filter(([a]) => (c ? a.cat === c : !DM.CATS[a.cat]))]).filter(([, l]) => l.length);
  return html`<div class="att-groups">${groups.map(([c, l]) => html`<div class="att-group"><h4>${c ? html`<span aria-hidden="true">${DM.CATS[c][2]}</span> ${t(DM.CATS[c][0], DM.CATS[c][1])}` : t('Other files', '其他文件')}</h4>${attTiles(l, hrefOf)}</div>`)}</div>`;
};
const attTiles = (pairs, hrefOf) => html`<ul class="att-tiles">${pairs.map(([a, i]) => {
  const href = hrefOf(i); const ext = P.extOf(a.name).slice(1).toUpperCase() || 'FILE'; const img = THUMB_OK.test(a.name); const prev = P.INLINE_OK.test(a.name);
  const face = img ? html`<img src="${href}?inline=1" alt="" loading="lazy">` : html`<span class="att-ic">${kindIcon(P.guessKind(a.name))}</span><span class="att-ext">${ext}</span>`;
  return html`<li class="att-tile">${prev ? html`<button type="button" class="att-face" data-preview="${href}?inline=1" data-type="${img ? 'image' : 'doc'}" data-dl="${href}" aria-label="${ext} attachment">${face}<span class="att-zoom" aria-hidden="true">${icon('search', 14)}</span></button>` : html`<a class="att-face" href="${href}" aria-label="Download ${ext} attachment">${face}</a>`}
    <div class="att-meta"><span>${ext} · ${bytes(a.size)}</span><a class="att-dl" href="${href}" title="Download · 下载" aria-label="Download">${icon('download', 15)}</a></div></li>`; })}</ul>`;
const via = (x) => (x.source === 'manual' ? (DM.CHANNELS[x.email?.channel] || DM.CHANNELS.other) : null);

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

const nowLocal = () => { try { return new Date().toLocaleString('sv-SE', { timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' }).slice(0, 16).replace(' ', 'T'); } catch { return new Date().toISOString().slice(0, 16); } };
/** Lulyboo records a supplier reply that came another way: who, when, how, the message and categorised files. */
function manualForm(p, inv, contacts, open) {
  const zone = (c) => { const [en, , ic, hint] = DM.CATS[c]; return html`<div class="mrz" data-filebox data-mrz><div class="mdrop-box"><input type="file" name="f_${c}" multiple accept="${FILE_ACCEPT}" aria-label="${en}">
    <span class="mrz-h"><span class="mrz-ic" aria-hidden="true">${ic}</span><span><b>${en}</b><small>${hint}</small></span></span><span class="mrz-add" data-main>+ Drop, choose${c === 'image' ? ' or paste ⌘V' : ''}</span></div>
    <ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>`; };
  const people = contacts.filter((u) => u.status !== 'disabled');
  return html`<form method="post" enctype="multipart/form-data" action="/admin/projects/${p.id}/suppliers/${inv.id}/log" class="mr-form mt" data-rpane="log" data-mr-form ${open ? '' : raw('hidden')}>
    <div class="mr-row">
      <label class="mr-f">From<select name="from" data-mr-from>${people.map((u) => html`<option value="${u.name || u.email}">${u.name ? `${u.name} · ${u.email}` : u.email}</option>`)}<option value="">${people.length ? 'Other person…' : 'Someone at the factory'}</option></select><input name="from_other" placeholder="Name" data-mr-other ${people.length ? raw('hidden') : ''}></label>
      <label class="mr-f">Received<input type="datetime-local" name="received" value="${nowLocal()}" data-mr-when><input type="hidden" name="received_iso" data-mr-iso></label>
      <label class="mr-f">Came by<select name="channel">${Object.entries(DM.CHANNELS).map(([k, v]) => html`<option value="${k}">${v[2]} ${v[0]}</option>`)}</select></label>
    </div>
    <label class="mr-f">Message<textarea name="body" rows="5" placeholder="Paste what the supplier wrote, or your call notes. Chinese is fine."></textarea></label>
    <div class="mr-zones">${DM.CAT_ORDER.map(zone)}</div>
    <div class="mr-opts">
      <label class="chk"><input type="checkbox" name="ai" value="1" checked> Summarize with AI <span class="sub">— bullet points, questions and commitments, same as emails</span></label>
      <label class="chk"><input type="checkbox" name="quote" value="1" checked> Read the price and save it as the latest quote <span class="sub">— from the Pricing files or the message; you check the numbers first</span></label>
    </div>
    <div class="form-actions mr-act"><button class="btn">Add to conversation</button><span class="sub">Nothing is emailed — this only records the supplier's reply</span></div>
  </form>`;
}
/** Popup: AI drafts an email to the supplier (request or follow-up) from the project and thread; you edit, then use it as the reply. */
function aiDraftDialog(p, inv) {
  return html`<dialog class="rp-modal ad-dlg" data-ad-dlg data-url="/admin/projects/${p.id}/suppliers/${inv.id}/draft" aria-labelledby="ad-t">
    <div class="rp-top"><h2 id="ad-t">✦ Draft an email with AI</h2><button type="button" class="icon-btn" data-ad-close aria-label="Close">×</button></div>
    <div class="ad-body">
      <div class="ad-sec"><span class="ad-lbl">What for</span><div class="ad-chips" role="radiogroup" aria-label="Purpose">${Object.entries(DD.PURPOSES).map(([k, v], i) => html`<label class="ad-chip"><input type="radio" name="ad_purpose" value="${k}" ${i === 0 ? raw('checked') : ''}><span>${v[0]}</span></label>`)}</div></div>
      <div class="ad-sec"><span class="ad-lbl">Tone</span><div class="ad-chips" role="radiogroup" aria-label="Tone">${[['friendly', 'Friendly'], ['firm', 'Firm, with a deadline'], ['short', 'Short']].map(([k, l], i) => html`<label class="ad-chip"><input type="radio" name="ad_tone" value="${k}" ${i === 0 ? raw('checked') : ''}><span>${l}</span></label>`)}</div></div>
      <label class="mr-f"><span>Anything to include <span class="sub">(optional)</span></span><textarea rows="2" data-ad-notes placeholder="e.g. Need the quote by Friday · ask for the ear mold cost separately · we prefer UV printing"></textarea></label>
      <div class="ad-row"><label class="chk"><input type="checkbox" data-ad-zh> Add a Chinese translation under the English</label><button type="button" class="btn" data-ad-go>✦ Write draft</button></div>
      <p class="hol-status" data-ad-status role="status" aria-live="polite"></p>
      <div class="ad-out" data-ad-out hidden>
        <div class="ad-pending" data-ad-pending hidden><b>Still open with this supplier</b><ul></ul></div>
        <label class="mr-f"><span>Draft <span class="sub">— edit freely</span></span><textarea rows="12" data-ad-text></textarea></label>
        <div class="rp-actions"><button type="button" class="btn" data-ad-use>Use as reply</button><button type="button" class="btn ghost" data-ad-go>↻ Write again</button><button type="button" class="btn ghost" data-ad-copy>Copy</button><span class="sub">Nothing is sent until you click Send.</span></div>
      </div>
    </div>
  </dialog>`;
}
/** AI-read quote from a manual reply, shown as a form to check before it becomes the latest quote. */
function quoteCheck(p, inv, msg) {
  const q = msg.email.quote_draft; const tiers = [0, 1, 2].map((i) => q.tiers?.[i] || {});
  const inp = (name, label, v, attrs = '') => html`<label class="mr-f">${label}<input name="${name}" value="${v ?? ''}" ${raw(attrs)}></label>`;
  return html`<section class="mq-card" id="quote-check"><div class="head-row"><h3>💲 Check the quote AI read from ${msg.author || 'the supplier'}'s reply</h3><span class="sub">Nothing is saved until you click Save</span></div>
    <form method="post" action="/admin/projects/${p.id}/suppliers/${inv.id}/quote" class="mq-form"><input type="hidden" name="msg" value="${msg.id}">
      <div class="mq-tiers">${tiers.map((t, i) => html`<div class="mq-tier"><span>Tier ${i + 1}</span>${inp(`qty${i}`, 'Qty', t.qty, 'inputmode="numeric"')}${inp(`price${i}`, 'Unit price', t.price, 'inputmode="decimal"')}</div>`)}</div>
      <div class="mq-grid">
        <label class="mr-f">Currency<select name="currency">${F.CURRENCIES.map((c) => html`<option ${c === q.currency ? raw('selected') : ''}>${c}</option>`)}</select></label>
        <label class="mr-f">Incoterm<select name="incoterm"><option value="">—</option>${F.INCOTERMS.map((c) => html`<option ${c === q.incoterm ? raw('selected') : ''}>${c}</option>`)}</select></label>
        ${inp('tooling_cost', 'Tooling / molds', q.tooling_cost, 'inputmode="decimal"')}${inp('tooling_lead_days', 'Tooling days', q.tooling_lead_days, 'inputmode="numeric"')}
        ${inp('moq', 'MOQ', q.moq, 'inputmode="numeric"')}${inp('sample_cost', 'Sample cost', q.sample_cost, 'inputmode="decimal"')}${inp('sample_lead_days', 'Sample days', q.sample_lead_days, 'inputmode="numeric"')}${inp('production_lead_days', 'Production days', q.production_lead_days, 'inputmode="numeric"')}
        ${inp('payment_terms', 'Payment terms', q.payment_terms)}${inp('material_notes', 'Material quoted', q.material_notes)}<label class="mr-f">Valid until<input type="date" name="validity_date" value="${q.validity_date || ''}"></label>
      </div>
      <label class="mr-f">Notes<textarea name="notes" rows="2">${q.notes || ''}</textarea></label>
      <div class="form-actions"><button class="btn">Save as latest quote</button><a class="btn ghost" href="/admin/projects/${p.id}/suppliers/${inv.id}">Not now</a></div>
    </form></section>`;
}

module.exports = function projectRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const A = (fn) => async (req, res) => {
    const cur = await currentSupplierUser(db, config, req);
    if (!cur) return res.redirect('/login');
    req.supplier = cur.supplier; req.user = cur.user; req.base = '/portal';
    req.navBadges = await require('../samples').supplierBadges(db, cur.supplier.id);
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
  // ── Spec versions: suppliers see the last PUBLISHED state; saved edits are a draft until "Publish vN".
  // Before anyone is invited (or when every invitation is closed) edits are live: the current version just follows them.
  const activeInvs = (invs) => invs.filter((i) => !['Declined', 'Closed'].includes(i.status));
  const stateOf = (v) => v?.snapshot?.state || null;
  async function published(p, files, invs) {
    files = files || await db.list('dev_files', { filters: { project_id: p.id }, order: 'created_at.asc' });
    invs = invs || await db.list('dev_invitations', { filters: { project_id: p.id } });
    const v = (await db.list('dev_spec_versions', { filters: { project_id: p.id }, order: 'version.desc', limit: 1 }))[0]; const cur = CK.specState(p, files);
    if (!v) return cur;
    if (!stateOf(v) || !activeInvs(invs).length) {
      if (JSON.stringify(stateOf(v)) !== JSON.stringify(cur)) await db.update('dev_spec_versions', { id: v.id }, { snapshot: { ...(v.snapshot || {}), state: cur } });
      return cur;
    }
    return stateOf(v);
  }
  const extraOf = (pub) => (pub.extra || []).map((l) => ({ key: P.slug(l), label: l }));
  const chgItem = (i) => (i.t === 'add' ? html`<ins>+ ${i.text}</ins>` : i.t === 'del' ? html`<del>${i.text}</del>` : html`${i.before ? `${i.before} ` : ''}${i.old ? html`<del>${i.old}</del> → ` : ''}<ins>${i.new}</ins>${i.after ? ` ${i.after}` : ''}`);
  const chgList = (changes, max = 4) => html`<ul class="vd-chg">${changes.map((c) => html`<li><b>${c.label}</b><span>${c.items.slice(0, max).map((i, n) => html`${n ? ' · ' : ''}${chgItem(i)}`)}${c.items.length > max ? html` <span class="sub">+${c.items.length - max} more</span>` : ''}</span></li>`)}</ul>`;
  function versionBar(p, versions, invs, changes, sname) {
    const act = activeInvs(invs); const cur = versions.find((v) => v.version === p.current_version) || versions[0];
    if (changes.length) {
      const n = p.current_version + 1;
      return html`<div class="vdraft"><h3><span class="vd-tag">Draft v${n}</span> Unpublished changes · suppliers still see v${p.current_version}</h3>
        ${chgList(changes)}
        <div class="vd-row"><form method="post" action="/admin/projects/${p.id}/publish" class="vd-pub"><input name="change_note" required maxlength="500" value="${CK.autoNote(changes)}" aria-label="What changed">
          <label class="chk"><input type="checkbox" name="notify" value="1" checked> Email ${act.length} supplier${act.length === 1 ? '' : 's'}</label><button class="btn small">Publish v${n}</button></form>
          <form method="post" action="/admin/projects/${p.id}/discard" data-confirm="Discard the draft and go back to what suppliers see in v${p.current_version}?"><button class="link">Discard draft</button></form></div>
        <p class="sub">The note is written from the changes, edit it if you like. Target price, status and internal notes never create a version.</p></div>`;
    }
    const conf = act.filter((i) => i.ack_version >= p.current_version);
    return html`<div class="vbar"><span class="vb-v">v${p.current_version}</span><span class="vb-m">${cur ? html`Published ${fmt.date(cur.created_at)} · ${cur.change_note || ''}` : ''}</span>
      ${act.length ? html`<span class="${conf.length === act.length ? 'vb-ok' : 'vb-wn'}"><span class="vb-dots" aria-hidden="true">${act.map((i) => html`<i class="${i.ack_version >= p.current_version ? '' : 'o'}" title="${sname[i.supplier_id] || ''}"></i>`)}</span>${conf.length} of ${act.length} supplier${act.length === 1 ? '' : 's'} confirmed</span>` : html`<span class="vb-m">Not sent yet · edits are live until you invite suppliers</span>`}
      <span class="vb-fill"></span><a href="/admin/projects/${p.id}/versions">History</a></div>`;
  }

  const latestQuote = async (invId) => (await db.list('dev_quotes', { filters: { invitation_id: invId }, order: 'revision.desc', limit: 1 }))[0] || null;

  const catOpts = (cats) => [['', 'Choose a category…'], ...cats.map((c) => [c.id, html`${c.name}${(c.checklist || []).length ? html` <span class="sub">· ${c.checklist.length} questions</span>` : ''}`])];
  // category_id from the dropdown (or a category name, for API/old forms)
  async function pickCategory(f) {
    const cats = await db.list('categories');
    if (f.category_id) return cats.find((c) => c.id === f.category_id) || null;
    const n = String(f.category || '').trim().toLowerCase(); return n ? cats.find((c) => c.name.toLowerCase() === n) || null : null;
  }

  const { typeTag, reqTag } = require('./category-checklists');
  const docCell = (st) => html`<td><b class="${!st.reqLeft.length ? 'pos' : st.done ? '' : 'neg'}">${st.done} / ${st.total}</b><div class="sub">${st.reqLeft.length ? `${st.reqLeft.length} required left` : 'All required answered'} · files ${st.files.ready}/${st.files.total}</div></td>`;
  const fileLinks = (r, url) => r.files.map((f, n) => html`<a class="dk-file" href="${url(r, n)}" ${P.INLINE_OK.test(f.name) ? raw(`data-preview="${url(r, n)}?inline=1" data-type="${THUMB_OK.test(f.name) ? 'image' : 'doc'}" data-dl="${url(r, n)}"`) : ''}>${icon('download', 14)} ${f.name}</a>`);
  // Supplier thread: its checklist answers by section, with the files.
  function docsCard(p, inv, pub) {
    if (!pub.checklist?.length) return '';
    const st = CK.docStatus(pub.checklist, inv.doc_answers); const url = (r, n) => `/admin/projects/${p.id}/suppliers/${inv.id}/docs/${r.key}/${n}`;
    return html`<section class="card"><h2 class="sec">Factory checklist <span class="count">${st.done} / ${st.total}</span></h2>
      <p class="sub">${st.reqLeft.length ? html`<span class="neg">${st.reqLeft.length} required left</span>` : 'All required questions answered'} · files ${st.files.ready} / ${st.files.total}</p>
      ${st.sections.map((s) => html`<details class="ck-sec"><summary><b>${s.title}</b> <span class="count">${s.done} / ${s.rows.length}</span></summary>
        <dl class="ans-list">${s.rows.map((r) => html`<div class="${r.done ? '' : r.req === 'required' ? 'miss' : 'open'}"><dt>${r.name}</dt><dd>${r.done ? html`${CK.answerText(r, r.a)} ${fileLinks(r, url)}` : html`<span class="none">${r.req === 'required' ? 'Required · not answered' : '—'}</span>`}</dd></div>`)}</dl></details>`)}</section>`;
  }
  // Compare quotes: every supplier side by side, question by question.
  function checklistCompare(p, pub, invs, sname) {
    if (!pub.checklist?.length || !invs.length) return '';
    const sts = invs.map((i) => ({ i, st: CK.docStatus(pub.checklist, i.doc_answers) }));
    const url = (inv) => (r, n) => `/admin/projects/${p.id}/suppliers/${inv.id}/docs/${r.key}/${n}`;
    return html`<section class="card"><h2 class="sec">Factory checklist answers</h2>
      <div class="table-wrap"><table class="list compact cmp ck-cmp"><thead><tr><th>Question</th>${sts.map(({ i }) => html`<th><a href="/admin/projects/${p.id}/suppliers/${i.id}">${sname[i.supplier_id] || 'Supplier'}</a></th>`)}</tr></thead><tbody>
        <tr class="ck-tot"><td><b>Answered</b></td>${sts.map(({ st }) => docCell(st))}</tr></tbody>
        ${CK.sections(CK.normItems(pub.checklist)).map((s) => html`<tbody class="ck-grp"><tr><th colspan="${sts.length + 1}">${s.title}</th></tr>${s.rows.map((it) => html`<tr><td>${it.name}${it.req === 'required' ? html` <span class="rq rq-required" title="Required">*</span>` : ''}</td>${sts.map(({ i, st }) => { const r = st.rows.find((x) => x.key === it.key); return html`<td>${r?.done ? html`${CK.answerText(r, r.a)} ${it.type === 'file' ? fileLinks(r, url(i)) : ''}` : html`<span class="none">—</span>`}</td>`; })}</tr>`)}</tbody>`)}
      </table></div></section>`;
  }
  // A published state, read-only (version history and the supplier preview).
  const specView = (st) => html`${st.summary ? html`<p class="pd-desc">${st.summary}</p>` : ''}
    ${st.requirements ? html`<h3 class="sec2">Requirements</h3><p class="pd-desc pre">${st.requirements}</p>` : ''}
    ${st.certifications ? html`<h3 class="sec2">Certifications / standards</h3><p class="pd-desc pre">${st.certifications}</p>` : ''}
    ${(st.extra || []).length ? html`<h3 class="sec2">Extra quote questions</h3><ul class="plain">${st.extra.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
    <h3 class="sec2">Files <span class="count">${(st.files || []).length}</span></h3>${(st.files || []).length ? html`<ul class="plain">${st.files.map((x) => html`<li>${x.title}</li>`)}</ul>` : html`<p class="sub">None</p>`}
    <h3 class="sec2">Factory checklist <span class="count">${(st.checklist || []).length}</span></h3>${(st.checklist || []).length ? CK.sections(CK.normItems(st.checklist)).map((s) => html`<details class="ck-sec"><summary><b>${s.title}</b> <span class="count">${s.rows.length}</span></summary>
      <table class="list compact ck-q"><tbody>${s.rows.map((it) => html`<tr><td>${it.name}</td><td>${typeTag(it)}</td><td class="r">${reqTag(it)}</td></tr>`)}</tbody></table></details>`) : html`<p class="sub">None</p>`}`;
  // Spec tab: the factory checklist suppliers answer (copied from the category; switch questions off or add your own).
  function checklistCard(p, cat) {
    const items = CK.normItems(p.checklist, { project: true }); const on = items.filter((x) => x.on).length;
    return html`<section class="card" id="docs"><div class="sec-row"><h2 class="sec">Factory checklist <span class="count">${on}</span></h2>
        <a class="btn ghost small" href="/admin/projects/${p.id}/preview">Preview what suppliers see</a></div>
      <p class="sub">${cat ? html`From the <a href="/admin/categories/${cat.id}/checklist">${cat.name} checklist</a> v${p.checklist_version || 0}.` : 'Choose a category to load its checklist.'} Suppliers answer it in the portal; every <b>Required</b> question must be answered before they can quote.${p.checklist_file ? html` <a href="/admin/projects/${p.id}/checklist-file" download>Download Excel</a>` : ''}</p>
      <input type="hidden" name="ck_form" value="1">
      ${items.length ? CK.sections(items).map((s) => html`<details class="ck-sec"><summary><b>${s.title}</b> <span class="count">${s.rows.filter((x) => x.on).length} / ${s.rows.length}</span></summary>
        <ul class="ck-list">${s.rows.map((x) => html`<li class="${x.on ? '' : 'off'}"><label class="ck-on"><input type="checkbox" name="ck_on" value="${x.key}" ${x.on ? raw('checked') : ''} aria-label="Ask: ${x.name}"></label>
          <span class="ck-name"><b>${x.name}</b>${x.custom ? html` <span class="pill">This project</span>` : ''}</span><span>${typeTag(x)}</span><span class="r">${reqTag(x)}</span></li>`)}</ul></details>`)
      : html`<p class="d-empty">${cat ? html`The ${cat.name} category has no checklist yet. <a href="/admin/categories/${cat.id}/checklist">Import it</a> or add questions for this project below.` : 'No questions yet.'}</p>`}
      <p class="sub">Unticked questions are not asked. Changes go to suppliers when you publish the next version.</p></section>`;
  }

  // ═════════════════════════ ADMIN ═════════════════════════
  router.get('/admin/projects', G(async (req, res) => {
    const [projects, invs, quotes, miles, suppliers, cats] = await Promise.all([db.list('dev_projects', { order: 'created_at.desc' }), db.list('dev_invitations'), db.list('dev_quotes'), db.list('dev_milestones', { filters: { done_at: null } }), db.list('suppliers', { select: 'id,name' }), db.list('categories', { order: 'sort.asc,name.asc' })]);
    const q = String(req.query.q || '').toLowerCase(); const st = req.query.status || '';
    const shown = projects.filter((p) => (!st || p.status === st) && (!q || `${p.ref} ${p.name} ${p.category || ''}`.toLowerCase().includes(q)));
    res.html(page({
      title: 'Development projects', nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><div><h1>Development projects</h1><p class="muted small">Create a product, send the spec to several suppliers, follow their questions and quotes.</p></div><a class="btn" href="/admin/projects/new">+ New project</a></div>
      <form class="filters" method="get"><input type="search" name="q" placeholder="Search projects" value="${req.query.q || ''}"><select name="status"><option value="">All statuses</option>${P.PROJECT_STATUSES.map((s) => html`<option ${st === s ? raw('selected') : ''}>${s}</option>`)}</select><button class="btn small">Filter</button></form>
      ${shown.length ? html`<div class="table-wrap"><table class="list dp-table"><thead><tr><th>Project</th><th>Status</th><th>Suppliers</th><th>Quotes</th><th>Next milestone</th></tr></thead><tbody>
        ${shown.map((p) => { const pi = invs.filter((i) => i.project_id === p.id); const quoted = pi.filter((i) => quotes.some((x) => x.invitation_id === i.id)).length; const nm = miles.filter((x) => x.project_id === p.id && x.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
          return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}">${p.name}</a><div class="sub">${p.ref}${p.category ? ` · ${p.category}` : ''} · spec v${p.current_version}</div></td>
          <td><span class="pill ${p.status === 'Completed' ? 's-selected' : p.status === 'Draft' ? '' : 's-reviewing'}">${p.status}</span></td>
          <td>${pi.length ? html`${pi.length} invited${pi.some((i) => i.status === 'Questions') ? html`<div class="sub neg">${pi.filter((i) => i.status === 'Questions').length} with questions</div>` : ''}` : html`<span class="none">—</span>`}</td>
          <td>${pi.length ? `${quoted} of ${pi.length}` : html`<span class="none">—</span>`}</td>
          <td>${nm ? html`<span class="${nm.due_date < P.today() ? 'neg' : ''}">${fmt.date(nm.due_date)}</span><div class="sub">${nm.title}</div>` : html`<span class="none">—</span>`}</td></tr>`; })}</tbody></table></div>` : html`<div class="card empty-state"><p><b>${projects.length ? 'No projects match.' : 'No development projects yet.'}</b></p><p class="muted">Start with a name and a short description. You add requirements, drawings and suppliers next.</p><p><a class="btn" href="/admin/projects/new">+ New project</a></p></div>`}`,
    }));
  }));

  router.get('/admin/projects/new', G(async (req, res) => {
    const cats = await db.list('categories', { order: 'sort.asc,name.asc' });
    res.html(page({
      title: 'New project', nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/projects">Development</a></nav>
      <h1>New project</h1><p class="muted small">A name, a category and a short description. You add requirements, files and suppliers next.</p>
      <section class="card"><form method="post" action="/admin/projects" class="fields"><label class="frow"><span>Product name</span><input name="name" required maxlength="160" placeholder="e.g. Cat water fountain v1" autofocus></label>
        <div class="frow"><span>Category</span>${ddSel('category_id', '', catOpts(cats))}</div>
        <p class="sub fl-note">Required. The category loads its factory checklist: the certificates, test reports and details suppliers must answer before quoting.</p>
        <label class="frow top"><span>Short description</span><textarea name="summary" rows="3" placeholder="What is it, who is it for?"></textarea></label>
        <div class="form-actions"><button class="btn">Create project</button> <a class="btn ghost" href="/admin/projects">Cancel</a></div></form></section>`,
    }));
  }));

  router.post('/admin/projects', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const name = str(fields.name, 160); if (!name) { flash(res, 'error', 'Enter a product name'); return res.redirect('/admin/projects/new'); }
    const cat = await pickCategory(fields); if (!cat) { flash(res, 'error', 'Choose a category: it sets the document checklist'); return res.redirect('/admin/projects/new'); }
    const p = await db.insert('dev_projects', { ref: await P.nextRef(db), name, ...CK.fromCategory(cat), summary: str(fields.summary), status: 'Draft', current_version: 1, extra_fields: [], created_at: now(), updated_at: now() });
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
    const cats = await db.list('categories', { order: 'sort.asc,name.asc' }); const cat = cats.find((c) => c.id === p.category_id) || null;
    const pub = await published(p, files, invs); const changes = activeInvs(invs).length ? CK.diffStates(pub, CK.specState(p, files)) : [];
    const sname = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
    const invIds = new Set(invs.map((i) => i.id));
    const quotesBy = {}; for (const q of allQuotes) if (invIds.has(q.invitation_id) && !quotesBy[q.invitation_id]) quotesBy[q.invitation_id] = q;
    const lastMsg = {}; for (const x of msgs) if (invIds.has(x.invitation_id) && !lastMsg[x.invitation_id]) lastMsg[x.invitation_id] = x;
    const canDelete = ST.can(ST.current()?.role, 'delete');
    const tabHref = (k) => `/admin/projects/${p.id}?tab=${k}`;
    const header = html`<nav class="crumb"><a href="/admin/projects">Development</a></nav>
      <div class="head-row"><div><h1>${p.name}</h1><ul class="pp-meta"><li>${p.ref}</li>${p.category ? html`<li>${p.category}</li>` : ''}<li><span class="pill s-reviewing">${p.status}</span></li><li>Spec v${p.current_version}</li><li>${invs.length} supplier${invs.length === 1 ? '' : 's'} invited</li></ul></div>
      <div class="actions">${canDelete ? html`<form method="post" action="/admin/projects/${p.id}/delete" data-confirm="Delete this project, its files, threads and quotes? This cannot be undone."><button class="btn small ghost danger">Delete project</button></form>` : ''}</div></div>
      <nav class="dp-tabs" aria-label="Project sections">${TABS.map(([k, l]) => html`<a href="${tabHref(k)}" class="${tab === k ? 'cur' : ''}">${l}${k === 'suppliers' && invs.length ? html` <b>${invs.length}</b>` : ''}${k === 'files' && files.length ? html` <b>${files.length}</b>` : ''}</a>`)}</nav>
      ${['spec', 'files'].includes(tab) || changes.length ? versionBar(p, versions, invs, changes, sname) : ''}`;

    let body;
    if (tab === 'spec') {
      const extra = (p.extra_fields || []).map((f) => f.label).join('\n');
      const ckc = CK.categoryChanges(p, cat);
      body = html`${!p.category_id ? html`<div class="flash warn"><b>Choose a category for this project.</b> It loads the factory checklist suppliers must answer before quoting.</div>` : ''}
        ${ckc ? html`<div class="ck-upd"><span><b>${cat.name} checklist v${ckc.version} is available.</b> ${[ckc.added && `${ckc.added} new`, ckc.changed && `${ckc.changed} changed`, ckc.removed && `${ckc.removed} removed`, ckc.fileChanged && 'new file'].filter(Boolean).join(' · ') || 'Small changes'}. Your own items and switched-off items are kept.</span>
          <form method="post" action="/admin/projects/${p.id}/checklist/refresh"><button class="btn small">Update checklist</button></form></div>` : ''}
        <form method="post" action="/admin/projects/${p.id}" class="dp-grid" data-guard><div class="dp-main">
        <section class="card"><h2 class="sec">What suppliers see</h2><div class="sg">
          <label class="sg-2"><span class="lbl">Product name</span><input name="name" value="${p.name}" required></label>
          <div><span class="lbl">Category</span>${ddSel('category_id', p.category_id || '', catOpts(cats))}</div>
          <label class="sg-3"><span class="lbl">Summary</span><textarea name="summary" rows="2" data-grow placeholder="What it is and who it is for">${p.summary || ''}</textarea></label>
          <label class="sg-3"><span class="lbl">Requirements</span><textarea name="requirements" rows="5" data-grow placeholder="Materials, dimensions and tolerances, colours, functions, packaging, labelling, quantity expectations…">${p.requirements || ''}</textarea></label>
          <label class="sg-15"><span class="lbl">Certifications / standards</span><textarea name="certifications" rows="2" data-grow placeholder="e.g. ASTM F963, CPSIA (one per line)">${p.certifications || ''}</textarea></label>
          <label class="sg-15"><span class="lbl">Extra quote questions</span><textarea name="extra_fields" rows="2" data-grow placeholder="One per line, e.g. Motor warranty period">${extra}</textarea></label>
          <p class="sub sg-3">The quote form always asks for price tiers, tooling, MOQ, sample and production lead times, validity, payment terms and material. Extra questions are added to it.</p></div></section>
        ${checklistCard(p, cat)}</div>
        <aside class="dp-side"><section class="card"><h2 class="sec">Internal only</h2><div class="sg sg-side">
          <div class="sg-3"><span class="lbl">Status</span>${ddSel('status', p.status, P.PROJECT_STATUSES.map((x) => [x, x]))}</div>
          <label><span class="lbl">Target price</span><span class="inp-unit"><input name="target_price_usd" type="number" step="0.01" min="0" value="${p.target_price_usd ?? ''}"><i>USD</i></span></label>
          <label><span class="lbl">Target MOQ</span><span class="inp-unit"><input name="target_moq" type="number" step="1" min="0" value="${p.target_moq ?? ''}"><i>pcs</i></span></label>
          <label class="sg-3"><span class="lbl">Notes</span><textarea name="internal_notes" rows="2" data-grow>${p.internal_notes || ''}</textarea></label></div>
          <p class="sub">Never shown to suppliers.</p>
          <div class="nda-row"><label class="chk"><input type="checkbox" name="nda_required" value="1" ${p.nda_required ? raw('checked') : ''}> Suppliers accept an NDA before seeing the spec</label>
            <details class="q-more" ${p.nda_text ? raw('open') : ''}><summary>Custom NDA text</summary><textarea name="nda_text" rows="4" placeholder="Leave empty for the standard confidentiality wording.">${p.nda_text || ''}</textarea></details></div></section>
          <div class="form-actions"><button class="btn" data-save>Save</button><span class="dirty-note" data-dirty-note hidden>Unsaved changes</span></div></aside></form>`;
    } else if (tab === 'files') {
      const titles = P.fileTitles(files);
      const groups = P.KIND_ORDER.map((k) => [k, files.filter((f) => f.kind === k)]).filter(([, l]) => l.length);
      const row = (f) => html`<li class="fl-row">
          <div class="fl-thumb">${THUMB_OK.test(f.name) ? html`<button type="button" class="fl-thumb-btn" data-preview="/admin/dev-files/${f.id}?inline=1" data-type="image" data-dl="/admin/dev-files/${f.id}" aria-label="Preview"><img src="/admin/dev-files/${f.id}?inline=1" alt="" loading="lazy"></button>` : html`<span aria-hidden="true">${kindIcon(f.kind)}</span>`}</div>
          <div class="fl-main"><div class="fl-title" title="${f.name}">${titles.get(f.id)}${f.controlling ? html` <span class="pill s-selected">Controlling</span>` : ''}${f.internal ? html` <span class="pill s-closed">Internal only</span>` : ''}</div>
            <div class="fl-meta">${P.extOf(f.name).slice(1).toUpperCase()} · ${bytes(f.bytes)} · added in v${f.version}${f.internal ? '' : ' · visible to suppliers'}</div></div>
          <div class="fl-act">${P.INLINE_OK.test(f.name) ? html`<button type="button" class="ic-btn" data-preview="/admin/dev-files/${f.id}?inline=1" data-type="${THUMB_OK.test(f.name) ? 'image' : 'doc'}" data-dl="/admin/dev-files/${f.id}" title="Preview" aria-label="Preview">${icon('eye', 18)}</button>` : ''}<a class="ic-btn" href="/admin/dev-files/${f.id}" title="Download" aria-label="Download">${icon('download', 18)}</a><button type="button" class="ic-btn" data-fl-toggle title="Edit" aria-label="Edit">${icon('pencil', 17)}</button>
            <form class="inline" method="post" action="/admin/projects/${p.id}/files/${f.id}/delete" data-confirm="Remove this file?"><button class="ic-btn danger" title="Remove" aria-label="Remove">${icon('trash', 17)}</button></form></div>
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
      const pickList = suppliers.filter((x) => (x.active !== false && !/^pending:/i.test(String(x.name || '').trim())) || invited.has(x.id));
      body = html`<section class="card"><h2 class="sec">Invited suppliers</h2>
        ${invs.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>Supplier</th><th>Status</th><th>Spec</th>${pub.checklist?.length ? html`<th>Checklist</th>` : ''}<th>Quote</th><th>Last message</th><th></th></tr></thead><tbody>
          ${invs.map((i) => { const q = quotesBy[i.id]; const lm = lastMsg[i.id]; return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}/suppliers/${i.id}">${sname[i.supplier_id] || 'Supplier'}</a>${p.nda_required ? html`<div class="sub">${i.nda_accepted_at ? `NDA accepted ${fmt.date(i.nda_accepted_at)}` : html`<span class="neg">NDA not accepted</span>`}</div>` : ''}</td>
            <td><span class="pill ${pillCls(i.status)}">${i.status}</span></td><td>${i.ack_version >= p.current_version ? html`v${i.ack_version} confirmed` : html`<span class="neg">v${p.current_version} not confirmed</span>`}</td>
            ${pub.checklist?.length ? docCell(CK.docStatus(pub.checklist, i.doc_answers)) : ''}
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
        ${rows.length ? html`<div class="table-wrap"><table class="list compact cmp"><thead><tr><th>Supplier</th><th class="r">Unit price (tier 1)</th><th class="r">vs target</th><th class="r">Tooling</th><th class="r">MOQ</th><th class="r">Sample</th><th class="r">Sample lead</th><th class="r">Production lead</th><th>Valid until</th><th>Spec</th>${pub.checklist?.length ? html`<th>Checklist</th>` : ''}${labels.map((l) => html`<th>${l}</th>`)}</tr></thead><tbody>
          ${rows.map(({ i, q }) => { const pr = p1(q); const vs = p.target_price_usd && pr && (q.currency || 'USD') === 'USD' ? ((pr - p.target_price_usd) / p.target_price_usd) * 100 : null; return html`<tr><td><a class="sp-name" href="/admin/projects/${p.id}/suppliers/${i.id}">${sname[i.supplier_id]}</a><div class="sub"><span class="pill ${pillCls(i.status)}">${i.status}</span> rev ${q.revision}</div></td>
            ${cell(pr, bp, html`<b>${fmt.money(pr, q.currency)}</b>${q.incoterm ? html`<div class="sub">${q.incoterm}</div>` : ''}`)}<td class="r ${vs !== null && vs > 0 ? 'neg' : ''}">${vs === null ? html`<span class="none">—</span>` : `${vs > 0 ? '+' : ''}${vs.toFixed(1)}%`}</td>
            ${cell(q.tooling_cost, bt, fmt.money(q.tooling_cost, q.currency))}<td class="r">${q.moq ? fmt.num(q.moq) : html`<span class="none">—</span>`}</td><td class="r">${q.sample_cost !== null && q.sample_cost !== undefined ? fmt.money(q.sample_cost, q.currency) : html`<span class="none">—</span>`}</td><td class="r">${q.sample_lead_days ? `${q.sample_lead_days} d` : html`<span class="none">—</span>`}</td>
            ${cell(q.production_lead_days, bl, `${q.production_lead_days} d`)}<td>${q.validity_date ? fmt.date(q.validity_date) : html`<span class="none">—</span>`}${q.validity_date && q.validity_date < P.today() ? html` <span class="neg">expired</span>` : ''}</td><td>${q.spec_version < p.current_version ? html`<span class="neg">v${q.spec_version}</span>` : `v${q.spec_version}`}</td>
            ${pub.checklist?.length ? docCell(CK.docStatus(pub.checklist, i.doc_answers)) : ''}
            ${labels.map((l) => html`<td>${(q.custom || []).find((c) => c.label === l)?.value || html`<span class="none">—</span>`}</td>`)}</tr>`; })}</tbody></table></div>` : html`<p class="d-empty">No quotes have been submitted yet.</p>`}</section>
        ${checklistCompare(p, pub, activeInvs(invs), sname)}`;
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
    let note = '';
    if ('category_id' in f || 'category' in f) {
      const cat = await pickCategory(f);
      if (!cat) { if (!p.category_id) note = ' Choose a category to load its document checklist.'; }
      else if (cat.id !== p.category_id) { Object.assign(patch, CK.fromCategory(cat, p.checklist)); note = ` Category ${cat.name}: its factory checklist is loaded.`; }
    }
    if (f.ck_form === '1' && !patch.checklist) {
      const on = new Set([].concat(f.ck_on || []));
      const list = (p.checklist || []).map((x) => ({ ...x, on: on.has(x.key) }));
      if (JSON.stringify(list) !== JSON.stringify(p.checklist || [])) patch.checklist = list;
    }
    await db.update('dev_projects', { id: p.id }, patch);
    const shared = activeInvs(await db.list('dev_invitations', { filters: { project_id: p.id } })).length;
    flash(res, 'ok', `Saved.${shared ? ` Suppliers still see v${p.current_version}: publish v${p.current_version + 1} when you are ready.` : ''}${note}`);
    res.redirect(`/admin/projects/${p.id}?tab=spec`);
  }));

  // Newer category checklist → bring it into the project (project's own items and switched-off items are kept).
  router.post('/admin/projects/:id/checklist/refresh', G(async (req, res) => {
    const p = await loadProject(req.params.id); const cat = p.category_id ? await db.get('categories', p.category_id) : null;
    if (cat) { await db.update('dev_projects', { id: p.id }, { ...CK.refreshFromCategory(p, cat), updated_at: now() }); flash(res, 'ok', `Checklist updated to ${cat.name} v${cat.checklist_version || 0}. Publish the next version to send it to suppliers.`); }
    res.redirect(`/admin/projects/${p.id}?tab=spec#docs`);
  }));
  router.get('/admin/projects/:id/checklist-file', G(async (req, res) => {
    const p = await loadProject(req.params.id); if (!p.checklist_file?.path) throw new HttpError(404, 'No checklist file');
    serveCk(res, await db.docs.download(p.checklist_file.path), p.checklist_file, req.query.inline === '1');
  }));

  // Discard the draft: back to what suppliers see. Files added since are set to Internal only (never deleted here).
  router.post('/admin/projects/:id/discard', G(async (req, res) => {
    const p = await loadProject(req.params.id); const files = await db.list('dev_files', { filters: { project_id: p.id } }); const pub = await published(p, files);
    const keep = new Set((pub.checklist || []).map((x) => x.key)); const byKey = Object.fromEntries((p.checklist || []).map((x) => [x.key, x]));
    const checklist = [...(pub.checklist || []).map((x) => ({ ...byKey[x.key], ...x, on: true })), ...(p.checklist || []).filter((x) => !keep.has(x.key)).map((x) => ({ ...x, on: false }))];
    await db.update('dev_projects', { id: p.id }, { name: pub.name || p.name, summary: pub.summary || null, requirements: pub.requirements || null, certifications: pub.certifications || null, extra_fields: extraOf(pub), checklist, checklist_file: pub.ckfile || null, updated_at: now() });
    const pubIds = new Set((pub.files || []).map((x) => x.id)); let hidden = 0;
    for (const f of files) {
      if (!f.internal && !pubIds.has(f.id)) { await db.update('dev_files', { id: f.id }, { internal: true }); hidden++; }
      else if (f.internal && pubIds.has(f.id)) await db.update('dev_files', { id: f.id }, { internal: false });
    }
    flash(res, 'ok', `Draft discarded: back to v${p.current_version}.${hidden ? ` ${hidden} file${hidden === 1 ? '' : 's'} added since ${hidden === 1 ? 'was' : 'were'} set to Internal only.` : ''}`);
    res.redirect(`/admin/projects/${p.id}?tab=spec`);
  }));

  // History: every version, who confirmed it, compare with the one before.
  router.get('/admin/projects/:id/versions', G(async (req, res) => {
    const p = await loadProject(req.params.id);
    const [versions, invs, suppliers] = await Promise.all([db.list('dev_spec_versions', { filters: { project_id: p.id }, order: 'version.desc' }), db.list('dev_invitations', { filters: { project_id: p.id } }), db.list('suppliers', { select: 'id,name' })]);
    const sname = Object.fromEntries(suppliers.map((x) => [x.id, x.name])); const act = activeInvs(invs);
    const cmp = Number(req.query.cmp) || 0; const view = Number(req.query.view) || 0;
    const vOf = (n) => versions.find((v) => v.version === n);
    let detail = '';
    if (cmp && vOf(cmp)) {
      const a = stateOf(vOf(cmp - 1)); const b = stateOf(vOf(cmp)); const d = a && b ? CK.diffStates(a, b) : null;
      detail = html`<section class="card"><h2 class="sec">v${cmp - 1} → v${cmp}</h2>${d ? (d.length ? chgList(d, 20) : html`<p class="d-empty">No differences in what suppliers see.</p>`) : html`<p class="d-empty">Published before the full history was kept: only the note is known.</p>`}</section>`;
    } else if (view && vOf(view)) {
      const st = stateOf(vOf(view));
      detail = st ? html`<section class="card"><h2 class="sec">v${view} as suppliers saw it</h2>${specView(st)}</section>` : html`<section class="card"><p class="d-empty">Published before the full history was kept.</p></section>`;
    }
    const chips = (v) => (v.version === p.current_version
      ? act.map((i) => html`<span class="${i.ack_version >= v.version ? '' : 'o'}">${sname[i.supplier_id] || 'Supplier'}${i.ack_version >= v.version ? ' ✓' : ` · on v${i.ack_version}`}</span>`)
      : html`<span>${act.filter((i) => i.ack_version >= v.version).length} confirmed</span>`);
    res.html(page({ title: `${p.name} · versions`, nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/projects">Development</a><span>›</span><a href="/admin/projects/${p.id}?tab=spec">${p.name}</a></nav>
      <div class="head-row"><div><h1>Spec versions</h1><ul class="pp-meta"><li>${p.ref}</li><li>Current v${p.current_version}</li></ul></div></div>
      <section class="card vh">${versions.map((v) => html`<div class="vh-row${v.version === cmp || v.version === view ? ' cur' : ''}"><b>v${v.version}</b><span class="sub">${fmt.date(v.created_at)}</span><span>${v.change_note || ''}</span><span class="vh-chips">${act.length ? chips(v) : ''}</span>
        <span class="vh-act"><a href="?view=${v.version}">View</a>${v.version > 1 && vOf(v.version - 1) ? html` · <a href="?cmp=${v.version}">Compare v${v.version - 1}</a>` : ''}</span></div>`)}</section>
      ${detail}` }));
  }));
  // What a supplier sees right now (the published version), without logging in as one.
  router.get('/admin/projects/:id/preview', G(async (req, res) => {
    const p = await loadProject(req.params.id); const pub = await published(p);
    res.html(page({ title: `${p.name} · supplier view`, nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/projects">Development</a><span>›</span><a href="/admin/projects/${p.id}?tab=spec">${p.name}</a></nav>
      <div class="head-row"><div><h1>${pub.name}</h1><ul class="pp-meta"><li>${p.ref}</li><li>Spec v${p.current_version}</li><li>What suppliers see</li></ul></div></div>
      <section class="card">${specView(pub)}</section>` }));
  }));

  router.post('/admin/projects/:id/publish', G(async (req, res) => {
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req);
    const note = str(f.change_note, 500); if (!note) { flash(res, 'error', 'Describe what changed'); return res.redirect(`/admin/projects/${p.id}?tab=spec`); }
    const v = p.current_version + 1; const state = CK.specState(p, await db.list('dev_files', { filters: { project_id: p.id }, order: 'created_at.asc' }));
    await db.insert('dev_spec_versions', { project_id: p.id, version: v, change_note: note, snapshot: { summary: p.summary, requirements: p.requirements, certifications: p.certifications, state }, created_at: now() });
    await db.update('dev_projects', { id: p.id }, { current_version: v, updated_at: now() });
    let sent = 0;
    if (f.notify === '1') {
      const invs = (await db.list('dev_invitations', { filters: { project_id: p.id } })).filter((i) => !['Declined', 'Closed'].includes(i.status));
      for (const i of invs) { const s = await db.get('suppliers', i.supplier_id); if (s && await P.notifySupplier(config, db, s, { replyTo: DE.threadAddress(), subject: `[Lulyboo ${DE.threadCode(p, i)}] Spec updated to v${v} · 规格已更新至 v${v}`, en: `The specification for "${p.name}" was updated to v${v}.\nWhat changed: ${note}\nPlease review it and confirm in the portal.`, zh: `“${p.name}”的规格已更新至 v${v}。\n变更内容：${note}\n请在平台中查看并确认。`, link: link(i.id), email: { ref: p.ref, project: p.name, title: [`Specification updated to v${v}`, `规格已更新至 v${v}`], lead: ['The specification of this project has changed:', '以下项目的规格已更新：'], noteLabel: ['What changed', '变更内容'], note, points: [['Please review the new version and confirm it in the portal.', '请查看新版本并在平台中确认。'], ['If your quote is affected, submit a revised quote.', '如报价受影响，请提交修订报价。']], button: ['Review and confirm', '查看并确认'] } })) sent++; }
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
    const p = await loadProject(req.params.id); const { fields: f } = await parseForm(req); await published(p);
    const ids = [].concat(f.supplier_ids || []).filter(Boolean); if (!ids.length) { flash(res, 'warn', 'Tick at least one supplier'); return res.redirect(`/admin/projects/${p.id}?tab=suppliers`); }
    const have = new Set((await db.list('dev_invitations', { filters: { project_id: p.id } })).map((i) => i.supplier_id)); let n = 0; let mailed = 0;
    for (const sid of ids) {
      if (have.has(sid)) continue; const s = await db.get('suppliers', sid); if (!s) continue;
      const inv = await db.insert('dev_invitations', { project_id: p.id, supplier_id: sid, status: 'Invited', message: str(f.message, 2000), ack_version: p.current_version, created_at: now(), updated_at: now() }); n++;
      if (f.send_email === '1' && await P.notifySupplier(config, db, s, { replyTo: DE.threadAddress(), subject: `[Lulyboo ${DE.threadCode(p, inv)}] New development project · 新开发项目: ${p.name}`, en: `You are invited to quote on a new development project: "${p.name}".${f.message ? `\n\n${str(f.message, 2000)}` : ''}\n\nPlease review the specification and drawings, ask questions if anything is unclear, and submit your quote in the portal.${p.nda_required ? '\nThis project requires you to accept a confidentiality agreement first.' : ''}`, zh: `邀请您为新开发项目“${p.name}”报价。${f.message ? `\n\n${str(f.message, 2000)}` : ''}\n\n请查看规格和图纸，如有疑问请提问，并在平台中提交报价。${p.nda_required ? '\n此项目需要您先接受保密协议。' : ''}`, link: link(inv.id), email: { ref: p.ref, project: p.name, title: ['New development project', '新开发项目'], lead: ['You are invited to quote on a new development project:', '邀请您为以下新开发项目报价：'], noteLabel: ['Message from Lulyboo', 'Lulyboo 留言'], note: str(f.message, 2000), points: [...(p.nda_required ? [['First accept the confidentiality agreement (NDA) in the portal.', '请先在平台中接受保密协议（NDA）。']] : []), ['Review the specification, drawings and files.', '查看规格、图纸和文件。'], ['Ask questions in the project thread if anything is unclear.', '如有疑问，请在项目对话中提问。'], ['Submit your quote in the portal.', '在平台中提交报价。']], button: ['Open project', '打开项目'] } })) mailed++;
    }
    if (n && p.status === 'Draft') await db.update('dev_projects', { id: p.id }, { status: 'Sourcing', updated_at: now() });
    flash(res, 'ok', n ? `${n} supplier(s) invited${mailed ? `, ${mailed} emailed` : (f.send_email === '1' ? '. Email could not be sent: check Resend settings.' : '')}.` : 'Nothing to invite');
    res.redirect(`/admin/projects/${p.id}?tab=suppliers`);
  }));

  router.get('/admin/projects/:id/suppliers/:invId', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId);
    const smps = await db.list('samples', { filters: { invitation_id: inv.id }, order: 'created_at.desc' }).catch(() => []);
    const [s, msgs, quotes] = await Promise.all([db.get('suppliers', inv.supplier_id), db.list('dev_messages', { filters: { invitation_id: inv.id }, order: 'created_at.asc' }), db.list('dev_quotes', { filters: { invitation_id: inv.id }, order: 'revision.desc' })]);
    const contacts = await db.list('supplier_users', { filters: { supplier_id: inv.supplier_id } }).catch(() => []);
    const draftMsg = req.query.quote ? msgs.find((x) => x.id === req.query.quote && x.email?.quote_draft && !x.email?.quote_id) : null;
    res.html(page({
      title: `${s?.name} · ${p.name}`, nav: adminNav('projects'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/projects">Development</a><span>›</span><a href="/admin/projects/${p.id}?tab=suppliers">${p.name}</a></nav>
      <div class="head-row"><div><h1>${s?.name}</h1><ul class="pp-meta"><li><span class="pill ${pillCls(inv.status)}">${inv.status}</span></li><li>${p.ref}</li><li>Confirmed spec v${inv.ack_version} of v${p.current_version}</li>${p.nda_required ? html`<li>${inv.nda_accepted_at ? `NDA accepted ${fmt.date(inv.nda_accepted_at)} by ${inv.nda_accepted_by || ''}` : 'NDA not accepted'}</li>` : ''}<li><a href="/admin/suppliers/${s?.id}">Supplier profile</a></li></ul></div>
        <form method="post" action="/admin/projects/${p.id}/suppliers/${inv.id}/status" class="inline-form"><select name="status" aria-label="Status">${P.INV_STATUSES.map((x) => html`<option ${x === inv.status ? raw('selected') : ''}>${x}</option>`)}</select><button class="btn small ghost">Set status</button></form></div>
      <div class="dp-thread"><section class="card"><h2 class="sec">Conversation</h2>
        <div class="msgs">${msgs.length ? msgs.map((x) => html`<article class="msg ${x.direction}${x.source === 'email' ? ' by-email' : ''}"><header><b>${x.direction === 'supplier' ? (x.author || s?.name) : (x.author || 'Lulyboo')}</b>${when(x.created_at)}${x.source === 'email' ? html`<span class="via-email" title="${x.email?.from || ''}">✉ email${x.email?.summarized ? ' · AI summary' : ''}</span>` : ''}${via(x) ? html`<span class="via-email via-manual">${via(x)[2]} ${via(x)[0]} · added by ${x.email?.added_by || 'Lulyboo'}${x.email?.summarized ? ' · AI summary' : ''}</span>` : ''}</header><p>${x.body}</p>${emailExtras(x)}${attLinks(x.attachments, (i) => `/admin/dev-files/att/${x.id}/${i}`)}</article>`) : html`<p class="d-empty">No messages yet.</p>`}</div>
        ${draftMsg ? quoteCheck(p, inv, draftMsg) : ''}
        <div class="seg-links rtabs mt" role="tablist"><button type="button" class="${req.query.log ? '' : 'on'}" data-rtab="reply" role="tab">Reply to supplier</button><button type="button" class="${req.query.log ? 'on' : ''}" data-rtab="log" role="tab">Add supplier's reply</button></div>
        ${manualForm(p, inv, contacts, req.query.log)}
        ${aiDraftDialog(p, inv)}
        <form method="post" enctype="multipart/form-data" action="/admin/projects/${p.id}/suppliers/${inv.id}/message" class="fields mt" data-rpane="reply" ${req.query.log ? raw('hidden') : ''}><div class="ad-bar"><button type="button" class="btn small ghost ad-open" data-ad-open>✦ Draft with AI</button><span class="sub">Follow up, ask for a quote, sample, files or a timeline — you check the email first</span></div>
          <label class="frow top"><span>Reply</span><textarea name="body" rows="4" required data-reply-body placeholder="Ask for more information or answer a question. The supplier is emailed."></textarea></label>
          <label class="frow"><span>Attach</span>${multiFile('files')}</label><label class="chk"><input type="checkbox" name="notify" value="1" checked> Email the supplier</label><div class="form-actions"><button class="btn">Send</button></div></form></section>
        <aside class="dp-side">${docsCard(p, inv, await published(p))}<section class="card em-addr"><h2 class="sec">Follow up by email</h2><p class="sub">One mailbox for all projects. This conversation is found by the code in the subject, so keep it when you reply or write.</p><div class="em-copy"><span class="em-k">Code</span><code>[${DE.threadCode(p, inv)}]</code><button type="button" class="btn small ghost" data-copy-text="[${DE.threadCode(p, inv)}]">Copy</button></div><div class="em-copy"><span class="em-k">CC</span><code>${DE.threadAddress()}</code><button type="button" class="btn small ghost" data-copy-text="${DE.threadAddress()}">Copy</button></div><p class="sub">Supplier replies come here automatically. When you email the supplier from Outlook, CC the mailbox and put the code in the subject. Each email is summarised by AI and posted here with name and time.</p></section><section class="card"><div class="head-row"><h2 class="sec">Samples</h2><a class="btn small" href="/admin/samples/new?invitation=${inv.id}">+ Request sample</a></div>${smps.length ? html`<ul class="smp-mini">${smps.map((x) => html`<li><a href="/admin/samples/${x.id}">${x.ref}${x.stage ? ` · ${x.stage}` : ''}</a><span class="stp ${require('../samples').pillCls(x.status)}"><i></i>${x.status}</span></li>`)}</ul>` : html`<p class="muted small">No samples yet.</p>`}</section><section class="card"><h2 class="sec">Latest quote${quotes[0] ? html` <span class="sub">rev ${quotes[0].revision} · ${fmt.date(quotes[0].created_at)}${quotes[0].spec_version < p.current_version ? ` · on spec v${quotes[0].spec_version}` : ''}</span>` : ''}</h2>${quoteCards(quotes[0], p, { admin: true })}${quotes[0] ? attLinks(quotes[0].attachments, (i) => `/admin/dev-files/quote/${quotes[0].id}/${i}`) : ''}
          ${quotes.length > 1 ? html`<details class="fold mt"><summary><b>Earlier revisions (${quotes.length - 1})</b></summary>${quotes.slice(1).map((q) => html`<h3 class="sec2">Rev ${q.revision} · ${fmt.date(q.created_at)}</h3>${quoteCards(q, p, { admin: true })}`)}</details>` : ''}</section></aside></div>`,
    }));
  }));
  router.get('/admin/projects/:id/suppliers/:invId/docs/:key/:idx', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const f = inv.doc_answers?.[req.params.key]?.files?.[Number(req.params.idx)];
    if (!f) throw new HttpError(404, 'File not found'); serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
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
    if (f.notify === '1' && s) mailed = await P.notifySupplier(config, db, s, { replyTo: DE.threadAddress(), subject: `[Lulyboo ${DE.threadCode(p, inv)}] New message · 新消息: ${p.name}`, en: `New message about "${p.name}":\n\n${body}${r.saved.length ? `\n\n(${r.saved.length} attachment(s) in the portal)` : ''}`, zh: `关于“${p.name}”的新消息：\n\n${body}${r.saved.length ? `\n\n（平台中有 ${r.saved.length} 个附件）` : ''}`, link: link(inv.id), email: { ref: p.ref, project: p.name, title: ['New message from Lulyboo', 'Lulyboo 新消息'], lead: ['You have a new message about this project:', '关于以下项目，您有一条新消息：'], noteLabel: ['Message', '消息内容'], note: body, points: r.saved.length ? [[`${r.saved.length} attachment(s) are waiting in the portal.`, `平台中有 ${r.saved.length} 个附件。`]] : [], button: ['Reply in the portal', '在平台中回复'] } });
    flash(res, r.errors.length ? 'warn' : 'ok', `Message sent${mailed ? ' and supplier emailed' : ''}${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}`);
    res.redirect(`/admin/projects/${p.id}/suppliers/${inv.id}`);
  }));

  // AI email draft for this supplier thread (returned as JSON; nothing is saved or sent).
  router.post('/admin/projects/:id/suppliers/:invId/draft', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const { fields: f } = await parseForm(req);
    const AI = require('../ai'); if (!AI.enabled()) return res.json({ ok: false, error: 'AI is not set up (ANTHROPIC_API_KEY).' }, 400);
    const [supplier, msgs, quote, samples, milestones, users] = await Promise.all([
      db.get('suppliers', inv.supplier_id), db.list('dev_messages', { filters: { invitation_id: inv.id }, order: 'created_at.asc' }), latestQuote(inv.id),
      db.list('samples', { filters: { invitation_id: inv.id } }).catch(() => []), db.list('dev_milestones', { filters: { project_id: p.id } }).catch(() => []),
      db.list('supplier_users', { filters: { supplier_id: inv.supplier_id } }).catch(() => []),
    ]);
    const lastFrom = [...msgs].reverse().find((m) => m.direction === 'supplier' && m.author)?.author;
    const contact = lastFrom || users.find((u) => u.status !== 'disabled' && u.name)?.name || '';
    const context = DD.brief({ p, inv, supplier, contact, msgs, quote, samples, milestones });
    try {
      const d = await DD.draft({ context, purpose: DD.PURPOSES[f.purpose] ? f.purpose : 'follow', tone: f.tone, notes: str(f.notes, 1500) || '', zh: f.zh === '1', sender: ST.current()?.name || 'Lulyboo' });
      res.json({ ok: true, body: d.body_zh ? `${d.body}\n\n———\n\n${d.body_zh}` : d.body, pending: d.pending });
    } catch (e) { res.json({ ok: false, error: `AI could not write the draft: ${String(e.message).slice(0, 160)}` }, 502); }
  }));

  // A supplier reply that came by WeChat / phone / … : record it in the thread (nothing is emailed).
  router.post('/admin/projects/:id/suppliers/:invId/log', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 8 });
    const thread = `/admin/projects/${p.id}/suppliers/${inv.id}`;
    const text = str(f.body, 20000);
    const all = DM.CAT_ORDER.flatMap((c) => P.fileList(files, `f_${c}`).map((x) => ({ ...x, cat: c })));
    if (!text && !all.length) { flash(res, 'error', 'Paste the message or add a file'); return res.redirect(`${thread}?log=1`); }
    const r = await P.storeFiles(db, { projectId: p.id, files: all, maxBytes });
    const atts = r.saved.map((a) => ({ ...a, cat: all[a.i].cat }));
    const s = await db.get('suppliers', inv.supplier_id);
    const author = str(f.from, 120) || str(f.from_other, 120) || s?.name || 'Supplier';
    const channel = DM.CHANNELS[f.channel] ? f.channel : 'other';
    let at = Date.parse(f.received_iso || ''); if (!Number.isFinite(at)) at = Date.parse(f.received || '');
    const created = Number.isFinite(at) && at < Date.now() + 36e5 ? new Date(at).toISOString() : now();
    const ai = f.ai === '1' && text ? await DE.summarize({ text, subject: `${DM.CHANNELS[channel][0]} message`, project: `${p.ref} ${p.name}`, writer: `${author} (${s?.name || 'supplier'})` }) : null;
    const body = (ai?.summary || text || `(${atts.length} file${atts.length === 1 ? '' : 's'})`).slice(0, 6000);
    const meta = { channel, added_by: ST.current()?.name || 'Lulyboo', text: text || '', summarized: !!ai, language: ai?.language || null, questions: ai?.questions || [], commitments: ai?.commitments || [], skipped_files: r.errors };
    let draft = null;
    if (f.quote === '1') {
      const pricing = r.saved.filter((a) => all[a.i].cat === 'pricing').map((a) => ({ name: a.name, buffer: all[a.i].buffer }));
      if (pricing.length || text) draft = await DM.readQuote({ files: pricing, text: pricing.length ? text : text, project: `${p.ref} ${p.name}` });
      if (draft) meta.quote_draft = draft;
    }
    let msg;
    try { msg = await db.insert('dev_messages', { invitation_id: inv.id, direction: 'supplier', author, body, attachments: atts, created_at: created, source: 'manual', email: meta }); }
    catch (e) { console.error('Saving manual reply details failed (run the dev_messages email SQL?):', e.message); msg = await db.insert('dev_messages', { invitation_id: inv.id, direction: 'supplier', author, body: `${body}\n\n(${DM.CHANNELS[channel][0]}, added by ${meta.added_by})`, attachments: atts, created_at: created }); draft = null; }
    await db.update('dev_invitations', { id: inv.id }, { status: ['Invited', 'Viewed'].includes(inv.status) ? 'Questions' : inv.status, updated_at: now() });
    const extra = f.quote === '1' && !draft ? ' · No price found to make a quote' : '';
    flash(res, r.errors.length ? 'warn' : 'ok', `Reply added${ai ? ' and summarized' : ''}${draft ? ' · Check the quote below' : extra}${r.errors.length ? ' · ' + r.errors.join(' · ') : ''}`);
    res.redirect(draft ? `${thread}?quote=${msg.id}#quote-check` : thread);
  }));
  // Save the checked quote (from a manual reply) as the supplier's next quote revision.
  router.post('/admin/projects/:id/suppliers/:invId/quote', G(async (req, res) => {
    const p = await loadProject(req.params.id); const inv = await loadInv(p.id, req.params.invId); const { fields: f } = await parseForm(req);
    const thread = `/admin/projects/${p.id}/suppliers/${inv.id}`;
    const msg = f.msg ? await db.get('dev_messages', f.msg) : null;
    if (msg && msg.invitation_id !== inv.id) throw new HttpError(404, 'Message not found');
    const tiers = [0, 1, 2].map((i) => ({ qty: int(f[`qty${i}`]), price: num(f[`price${i}`]) })).filter((x) => x.qty && x.price !== null && x.price >= 0);
    if (!tiers.length) { flash(res, 'error', 'Enter at least one quantity and unit price'); return res.redirect(msg ? `${thread}?quote=${msg.id}#quote-check` : thread); }
    const prev = await latestQuote(inv.id); const cur = F.CURRENCIES.includes(f.currency) ? f.currency : 'USD';
    const q = await db.insert('dev_quotes', { invitation_id: inv.id, revision: (prev?.revision || 0) + 1, spec_version: p.current_version, currency: cur, incoterm: F.INCOTERMS.includes(f.incoterm) ? f.incoterm : null, tiers,
      tooling_cost: num(f.tooling_cost), tooling_lead_days: int(f.tooling_lead_days), moq: int(f.moq), sample_cost: num(f.sample_cost), sample_lead_days: int(f.sample_lead_days), production_lead_days: int(f.production_lead_days),
      validity_date: /^\d{4}-\d{2}-\d{2}$/.test(f.validity_date || '') ? f.validity_date : null, payment_terms: str(f.payment_terms, 300), material_notes: str(f.material_notes, 300), custom: [], notes: str(f.notes, 4000),
      attachments: (msg?.attachments || []).filter((a) => a.cat === 'pricing'), created_at: now() });
    await db.update('dev_invitations', { id: inv.id }, { status: ['Sample', 'Selected'].includes(inv.status) ? inv.status : 'Quoted', updated_at: now() });
    if (msg?.email) await db.update('dev_messages', { id: msg.id }, { email: { ...msg.email, quote_draft: null, quote_id: q.id, quote_line: `${fmt.money(tiers[0].price, cur)} / pc at ${fmt.num(tiers[0].qty)}+${num(f.tooling_cost) !== null ? ` · tooling ${fmt.money(num(f.tooling_cost), cur)}` : ''}` } });
    flash(res, 'ok', `Saved as quote rev ${q.revision}`); res.redirect(thread);
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

  // Documents Lulyboo needs: for each one Available (upload) · By a date · Not available, plus a comment.
  // Factory checklist in the portal: sections → questions; files are uploaded next to their question.
  const PREFILL = { Factory_Name: (c) => c.supplier?.name, Contact_Name: (c) => c.user?.name, Contact_Email: (c) => c.user?.email || c.supplier?.email, Product_Name: (c) => c.pub?.name, Product_Category: (c) => c.category };
  const shortOpts = (it) => it.options.length <= 5 && it.options.every((o) => CK.optLabel(o).length <= 16);
  function portalChecklist(inv, p, pub, ds, locked, ctx) {
    if (!ds.rows.length) return '';
    const base = `/portal/projects/${inv.id}/docs`; const furl = (r, n) => `${base}/${r.key}/${n}`;
    const reqT = (r) => html`<span class="rq rq-${r.req}">${r.req === 'required' ? t('Required', '必填') : r.req_label}</span>`;
    const answer = (r) => {
      const a = r.a || {}; const k = r.key;
      if (locked) return html`<div class="q-ans"><span>${r.done ? CK.answerText(r, r.a) : t('Not answered', '未回复')}</span>${r.type === 'file' ? fileLinks(r, furl) : ''}</div>`;
      if (r.type === 'file') {
        const opts = Object.entries(CK.FILE_ANS).filter(([x]) => x !== 'na' || r.req !== 'required');
        return html`<div class="q-ans dk-ans">
          ${r.files.length ? html`<ul class="dk-files">${r.files.map((f, n) => html`<li>${fileLinks({ ...r, files: [f] }, () => furl(r, n))}<button class="link danger" formaction="${base}/${k}/${n}/remove" formnovalidate>${t('Remove', '删除')}</button></li>`)}</ul>` : ''}
          <div class="seg dk-seg" role="radiogroup" aria-label="${r.name}">${opts.map(([x, l]) => html`<label><input type="radio" name="st_${k}" value="${x}" ${a.status === x ? raw('checked') : ''}><span>${x === 'yes' ? t('Upload', '上传') : x === 'na' ? t('N/A', '不适用') : x === 'date' ? t('By date', '预计日期') : t(...l)}</span></label>`)}</div>
          <div class="dk-more"><input type="file" name="file_${k}" multiple class="dk-up" accept="${FILE_ACCEPT}" aria-label="Upload"><input type="date" name="dt_${k}" class="dk-date" value="${a.date || ''}" aria-label="Date"></div></div>`;
      }
      const details = html`<details class="q-more" ${a.details ? raw('open') : ''}><summary>${t('+ Details', '+ 说明')}</summary><input name="d_${k}" maxlength="500" value="${a.details || ''}" placeholder="Details, or what “Other” means · 说明"></details>`;
      if (r.type === 'multi') {
        const vals = new Set(Array.isArray(a.value) ? a.value : []);
        return html`<div class="q-ans"><div class="q-chips">${r.options.map((o) => html`<label class="q-chip"><input type="checkbox" name="v_${k}" value="${o}" ${vals.has(o) ? raw('checked') : ''}><span>${CK.optLabel(o)}</span></label>`)}</div>${details}</div>`;
      }
      if (r.type === 'choice') {
        let v = a.value; if (v === undefined && PREFILL[k]) { const pv = PREFILL[k](ctx); v = r.options.find((o) => o.trim().toLowerCase() === String(pv || '').trim().toLowerCase()); }
        return html`<div class="q-ans">${shortOpts(r)
          ? html`<div class="seg q-seg" role="radiogroup" aria-label="${r.name}">${r.options.map((o) => html`<label><input type="radio" name="v_${k}" value="${o}" ${v === o ? raw('checked') : ''}><span>${CK.optLabel(o)}</span></label>`)}</div>`
          : ddSel(`v_${k}`, v || '', [['', 'Choose…'], ...r.options.map((o) => [o, CK.optLabel(o)])])}${details}</div>`;
      }
      const v = a.value ?? (PREFILL[k] ? PREFILL[k](ctx) || '' : '');
      return html`<div class="q-ans"><input name="v_${k}" maxlength="1000" value="${a.na ? '' : v}" placeholder="${r.hint || ''}" aria-label="${r.name}">${r.req !== 'required' ? html`<label class="chk small"><input type="checkbox" name="na_${k}" value="1" ${a.na ? raw('checked') : ''}> ${t('Not applicable', '不适用')}</label>` : ''}</div>`;
    };
    const firstOpen = ds.sections.findIndex((s) => s.rows.some((r) => r.req === 'required' && !r.done));
    return html`<section class="card" id="docs"><div class="sec-row"><h2 class="sec">${t('Factory checklist', '工厂清单')} <span class="count">${ds.done} / ${ds.total}</span></h2>
        ${pub.ckfile ? html`<a class="btn ghost small" href="/portal/projects/${inv.id}/checklist-file" download>${t('Download Excel', '下载 Excel')}</a>` : ''}</div>
      <div class="q-bar"><i style="width:${Math.round((ds.done / Math.max(1, ds.total)) * 100)}%"></i></div>
      <p class="sub">${ds.reqLeft.length ? t(`${ds.reqLeft.length} required questions left. Answer them to submit your quote. Attach photos, test reports and certificates right next to their question.`, `还有 ${ds.reqLeft.length} 个必填问题。回答后才能提交报价。照片、测试报告和证书请在对应问题旁上传。`) : t('All required questions are answered. You can add the rest any time.', '必填问题已全部回答，其余问题可随时补充。')}</p>
      <form method="post" enctype="multipart/form-data" action="${base}" class="qform" data-guard>
        ${ds.sections.map((s, n) => { const left = s.rows.filter((r) => r.req === 'required' && !r.done).length; return html`<details class="q-sec" ${n === (firstOpen < 0 ? 0 : firstOpen) ? raw('open') : ''}><summary><b>${s.title}</b><span class="q-cnt ${left ? 'neg' : s.done === s.rows.length ? 'pos' : ''}">${s.done} / ${s.rows.length}${left ? html` · ${left} ${t('required', '必填')}` : s.done === s.rows.length ? ' ✓' : ''}</span></summary>
          ${s.rows.map((r) => html`<div class="q ${r.done ? 'done' : ''}"><div class="q-l"><b>${r.name}</b> ${reqT(r)}${r.hint && r.type !== 'text' ? html`<span class="sub">${r.hint}</span>` : ''}</div>${answer(r)}</div>`)}</details>`; })}
        ${locked ? '' : html`<div class="form-actions q-save"><button class="btn">${t('Save answers', '保存回答')}</button><span class="dirty-note" data-dirty-note hidden>${t('Unsaved changes', '有未保存的更改')}</span></div>`}</form></section>`;
  }

  router.get('/portal/projects', A(async (req, res) => {
    const invs = (await db.list('dev_invitations', { filters: { supplier_id: req.supplier.id }, order: 'created_at.desc' })).filter((i) => i.status !== 'Closed');
    const projects = Object.fromEntries((await db.list('dev_projects')).filter((p) => invs.some((i) => i.project_id === p.id)).map((p) => [p.id, p]));
    const quoted = new Set((await db.list('dev_quotes')).map((q) => q.invitation_id));
    res.html(page({ title: 'Development projects', nav: nav(), flash: takeFlash(req, res), req,
      body: html`<h1>${t('Development projects', '开发项目')}</h1><p class="muted">${t('Products Lulyboo invites you to quote on. Open a project to see the specification, ask questions and submit your quote.', 'Lulyboo 邀请您报价的产品。打开项目可查看规格、提问并提交报价。')}</p>
      ${invs.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>${t('Project', '项目')}</th><th>${t('Received', '收到日期')}</th><th>${t('Status', '状态')}</th><th>${t('Action needed', '待办')}</th></tr></thead><tbody>${invs.map((i) => { const p = projects[i.project_id]; if (!p) return ''; const need = ndaGate(p, i) ? t('Accept the NDA', '请接受保密协议') : i.ack_version < p.current_version ? t(`Confirm spec v${p.current_version}`, `请确认规格 v${p.current_version}`) : !quoted.has(i.id) && !['Declined'].includes(i.status) ? t('Submit your quote', '请提交报价') : '';
        const fresh = !i.viewed_at && !['Closed', 'Declined'].includes(i.status);
        return html`<tr class="${fresh ? 'is-new' : ''}"><td><a class="sp-name" href="/portal/projects/${i.id}">${p.name}</a>${fresh ? html` <span class="new-tag">${t('New', '新')}</span>` : ''}<div class="sub">${p.ref}${p.category ? ` · ${p.category}` : ''}</div></td><td class="nowrap">${fmt.date(i.created_at)}</td><td><span class="pill ${pillCls(i.status)}">${i.status === 'Quoted' ? t('Quoted', '已报价') : i.status === 'Declined' ? t('Declined', '已婉拒') : i.status === 'Selected' ? t('Selected', '已选中') : i.status === 'Sample' ? t('Sampling', '样品中') : t('Open', '进行中')}</span></td><td>${need ? html`<span class="neg">${need}</span>` : html`<span class="none">—</span>`}</td></tr>`; })}</tbody></table></div>` : html`<div class="card empty-state"><p><b>${t('No projects yet', '暂无项目')}</b></p><p class="muted">${t('When Lulyboo invites you to a development project it appears here.', 'Lulyboo 邀请您参与开发项目后，将显示在此处。')}</p></div>`}` }));
  }));

  router.get('/portal/projects/:invId', A(async (req, res) => {
    const { inv, p } = await ownInv(req);
    if (ndaGate(p, inv)) {
      return res.html(page({ title: p.name, nav: nav(), flash: takeFlash(req, res), req, body: html`<h1>${p.name}</h1>
        <section class="card"><h2 class="sec">${t('Confidentiality agreement', '保密协议')}</h2><p class="muted">${t('Please accept before viewing the specification and drawings.', '查看规格和图纸前，请先接受以下条款。')}</p>
          <div class="nda-box">${p.nda_text || html`${t('The specification, drawings, samples and any related information for this project are confidential and belong to Lulyboo. You agree to use them only to prepare a quotation and to produce for Lulyboo, not to share them with third parties, and not to make products from them for anyone else.', '本项目的规格、图纸、样品及相关信息均属保密信息，归 Lulyboo 所有。您同意仅将其用于报价及为 Lulyboo 生产，不向第三方披露，也不为他人据此生产产品。')}`}</div>
          <form method="post" action="/portal/projects/${inv.id}/nda" class="mt"><label class="chk"><input type="checkbox" name="agree" value="1" required> ${t('I have authority to accept this on behalf of my company and I agree.', '我有权代表公司接受，并同意以上条款。')}</label><div class="form-actions"><button class="btn">${t('Accept and continue', '接受并继续')}</button></div></form></section>` }));
    }
    if (!inv.viewed_at) { await db.update('dev_invitations', { id: inv.id }, { viewed_at: now(), status: inv.status === 'Invited' ? 'Viewed' : inv.status }); if (req.navBadges) req.navBadges['/portal/projects'] = Math.max(0, (req.navBadges['/portal/projects'] || 1) - 1); }
    const [files, versions, msgs, quotes] = await Promise.all([db.list('dev_files', { filters: { project_id: p.id }, order: 'created_at.asc' }), db.list('dev_spec_versions', { filters: { project_id: p.id }, order: 'version.desc' }), db.list('dev_messages', { filters: { invitation_id: inv.id }, order: 'created_at.asc' }), db.list('dev_quotes', { filters: { invitation_id: inv.id }, order: 'revision.desc' })]);
    const pub = await published(p, files); const pubIds = new Set((pub.files || []).map((x) => x.id));
    const vis = files.filter((x) => pubIds.has(x.id)); const supTitles = P.fileTitles(vis, true); const q = quotes[0]; const locked = ['Declined', 'Selected', 'Closed'].includes(inv.status);
    const ds = CK.docStatus(pub.checklist, inv.doc_answers); const gate = !locked && ds.quoteOpen.length > 0;
    const needAck = inv.ack_version < p.current_version;
    const val = (k) => (q ? q[k] ?? '' : '');
    res.html(page({ title: p.name, nav: nav(), flash: takeFlash(req, res), req, wide: true,
      body: html`<nav class="crumb"><a href="/portal/projects">${t('Development projects', '开发项目')}</a></nav>
      <div class="head-row"><div><h1>${pub.name || p.name}</h1><ul class="pp-meta"><li>${p.ref}</li>${p.category ? html`<li>${p.category}</li>` : ''}<li>${t('Spec', '规格')} v${p.current_version}</li><li><span class="pill ${pillCls(inv.status)}">${inv.status}</span></li></ul></div></div>
      ${needAck ? html`<div class="flash warn"><b>${t(`The specification was updated to v${p.current_version}.`, `规格已更新至 v${p.current_version}。`)}</b> ${versions[0]?.change_note || ''}
        <form method="post" action="/portal/projects/${inv.id}/ack" class="inline"><button class="btn small">${t('I have reviewed it', '我已查看')}</button></form></div>` : ''}
      ${inv.message ? html`<div class="notice info"><b>${t('Message from Lulyboo', '来自 Lulyboo 的留言')}</b><p>${inv.message}</p></div>` : ''}
      <div class="dp-thread">
        <div class="dp-main">
          <section class="card"><h2 class="sec">${t('Specification', '规格要求')}</h2>${pub.summary ? html`<p class="pd-desc">${pub.summary}</p>` : ''}
            ${pub.requirements ? html`<h3 class="sec2">${t('Requirements', '要求')}</h3><p class="pd-desc pre">${pub.requirements}</p>` : ''}
            ${pub.certifications ? html`<h3 class="sec2">${t('Certifications / standards', '认证 / 标准')}</h3><p class="pd-desc pre">${pub.certifications}</p>` : ''}
            ${versions.length > 1 ? html`<details class="fold mt"><summary><b>${t('Change history', '变更记录')}</b></summary><ul class="feed">${versions.map((v) => html`<li><span class="date">${fmt.date(v.created_at)}</span><b>v${v.version}</b> ${v.change_note || ''}</li>`)}</ul></details>` : ''}</section>
          <section class="card"><h2 class="sec">${t('Files', '文件')} <span class="count">${vis.length}</span></h2>${vis.length ? html`<ul class="fl">${vis.map((f) => html`<li class="fl-row"><div class="fl-thumb">${THUMB_OK.test(f.name) ? html`<button type="button" class="fl-thumb-btn" data-preview="/portal/projects/${inv.id}/files/${f.id}?inline=1" data-type="image" data-dl="/portal/projects/${inv.id}/files/${f.id}" aria-label="Preview"><img src="/portal/projects/${inv.id}/files/${f.id}?inline=1" alt="" loading="lazy"></button>` : html`<span aria-hidden="true">${kindIcon(f.kind)}</span>`}</div><div class="fl-main"><div class="fl-title">${supTitles.get(f.id)}${f.controlling ? html` <span class="pill s-selected">${t('Controlling drawing', '主图纸')}</span>` : ''}</div><div class="fl-meta">${t(P.FILE_KINDS[f.kind] || f.kind, P.FILE_KINDS_ZH[f.kind] || f.kind)} · ${P.extOf(f.name).slice(1).toUpperCase()} · ${bytes(f.bytes)} · v${f.version}</div></div><div class="fl-act">${P.INLINE_OK.test(f.name) ? html`<button type="button" class="ic-btn" data-preview="/portal/projects/${inv.id}/files/${f.id}?inline=1" data-type="${THUMB_OK.test(f.name) ? 'image' : 'doc'}" data-dl="/portal/projects/${inv.id}/files/${f.id}" title="Preview · 预览" aria-label="Preview">${icon('eye', 18)}</button>` : ''}<a class="ic-btn" href="/portal/projects/${inv.id}/files/${f.id}" title="Download · 下载" aria-label="Download">${icon('download', 18)}</a></div></li>`)}</ul>` : html`<p class="d-empty">${t('No files yet.', '暂无文件。')}</p>`}</section>
          ${portalChecklist(inv, p, pub, ds, locked, { supplier: req.supplier, user: req.user, pub, category: p.category })}
          <section class="card"><h2 class="sec">${t('Questions & answers', '问答')}</h2>
            <div class="msgs">${msgs.length ? msgs.map((x) => html`<article class="msg ${x.direction}"><header><b>${x.direction === 'supplier' ? (['email', 'manual'].includes(x.source) ? x.author || t('You', '您') : t('You', '您')) : 'Lulyboo'}</b>${when(x.created_at)}${x.source === 'email' ? html`<span class="via-email">✉ ${t('email', '邮件')}</span>` : ''}${via(x) ? html`<span class="via-email">${via(x)[2]} ${t(via(x)[0], via(x)[1])}</span>` : ''}</header><p>${['email', 'manual'].includes(x.source) && x.email?.text ? x.email.text : x.body}</p>${attLinks(x.attachments, (i) => `/portal/projects/${inv.id}/att/${x.id}/${i}`)}</article>`) : html`<p class="d-empty">${t('Ask Lulyboo anything that is unclear.', '如有不清楚之处，请随时向 Lulyboo 提问。')}</p>`}</div>
            ${locked ? '' : html`<form method="post" enctype="multipart/form-data" action="/portal/projects/${inv.id}/message" class="fields mt"><label class="frow top"><span>${t('Message', '留言')}</span><textarea name="body" rows="3" required></textarea></label><label class="frow"><span>${t('Attach', '附件')}</span>${multiFile('files')}</label><div class="form-actions"><button class="btn">${t('Send', '发送')}</button></div></form>`}</section>
        </div>
        <aside class="dp-side"><section class="card" id="quote"><h2 class="sec">${t('Your quote', '您的报价')}${q ? html` <span class="sub">rev ${q.revision} · ${fmt.date(q.created_at)}</span>` : ''}</h2>
          ${q ? quoteCards(q, p) : ''}${q ? attLinks(q.attachments, (i) => `/portal/projects/${inv.id}/quote-att/${q.id}/${i}`) : ''}
          ${locked ? html`<p class="muted">${inv.status === 'Declined' ? t('You declined this project.', '您已婉拒此项目。') : t('This project is closed for new quotes.', '此项目已不再接受新报价。')}</p>` : html`
          ${gate ? html`<div class="notice warn mt"><b>${t('Factory checklist first', '请先完成工厂清单')}</b><p>${t(`Answer the ${ds.reqLeft.length} required checklist questions before you quote:`, `报价前请回答 ${ds.reqLeft.length} 个必填问题：`)} ${ds.reqLeft.slice(0, 5).map((r) => r.name).join(', ')}${ds.reqLeft.length > 5 ? ' …' : ''}. <a href="#docs">${t('Go to the checklist', '前往清单')}</a></p></div>` : ''}
          <details class="fold mt" ${q || gate ? '' : raw('open')}><summary><b>${q ? t('Submit a revised quote', '提交修订报价') : t('Submit your quote', '提交报价')}</b></summary>
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
              ${extraOf(pub).map((x) => html`<label><span class="lbl">${x.label}</span><input name="x_${x.key}" value="${(q?.custom || []).find((c) => c.label === x.label)?.value || ''}"></label>`)}
              <label><span class="lbl">${t('Notes, assumptions, suggested changes (DFM)', '备注、假设、改进建议（DFM）')}</span><textarea name="notes" rows="4">${val('notes')}</textarea></label>
              <label><span class="lbl">${t('Attach your own quotation or files', '附上您自己的报价单或文件')}</span>${multiFile('files')}</label>
              <div class="form-actions"><button class="btn" ${gate ? raw('disabled') : ''}>${q ? t('Submit revised quote', '提交修订报价') : t('Submit quote', '提交报价')}</button></div></form></details>
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
  const notifyAdmin = async (p, inv, what, extra = '', o = {}) => {
    const s = await db.get('suppliers', inv.supplier_id); const who = s?.name || 'A supplier'; const url = `${config.publicUrl}/admin/projects/${p.id}/suppliers/${inv.id}`;
    await P.notifyOwner(config, `[${DE.threadCode(p, inv)}] ${s?.name || 'Supplier'} ${what}`, `${who} ${what} on "${p.name}".${extra ? `\n\n${extra}` : ''}\n\n${url}`, {
      title: `${who} ${what}`, project: `${p.ref} · ${p.name}`, detail: extra ? { label: o.label || 'Details', text: extra } : null,
      items: o.items || [], button: o.button || 'Open supplier thread', link: url,
      intro: `Reply to this email to answer: your reply is added to the thread and sent to ${who}.`,
    }, DE.threadAddress());
  };

  router.get('/portal/projects/:invId/files/:fid', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv)) throw new HttpError(403, NA);
    const f = await db.get('dev_files', req.params.fid); const pub = f && f.project_id === p.id ? await published(p) : null;
    if (!f || !pub || !(pub.files || []).some((x) => x.id === f.id)) throw new HttpError(404, NA);
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
    await notifyAdmin(p, inv, 'sent a message', body, { label: 'Message', button: 'Reply in the thread' });
    flash(res, r.errors.length ? 'warn' : 'ok', m('Message sent', '留言已发送') + (r.errors.length ? ' · ' + r.errors.join(' · ') : '')); toDetail(res, inv.id);
  }));

  router.post('/portal/projects/:invId/quote', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv) || ['Declined', 'Selected', 'Closed'].includes(inv.status)) throw new HttpError(403, NA);
    const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 5 });
    const pub = await published(p); const open = CK.docStatus(pub.checklist, inv.doc_answers).quoteOpen;
    if (open.length) { flash(res, 'error', m(`Answer the ${open.length} required checklist questions first: ${open.slice(0, 5).map((r) => r.name).join(', ')}${open.length > 5 ? ' …' : ''}`, `请先回答 ${open.length} 个必填问题：${open.slice(0, 5).map((r) => r.name).join('、')}`)); return toDetail(res, inv.id); }
    const tiers = [0, 1, 2].map((n) => ({ qty: int(f[`qty${n}`]), price: num(f[`price${n}`]) })).filter((x) => x.qty && x.price !== null && x.price >= 0);
    if (!tiers.length) { flash(res, 'error', m('Enter at least one quantity and unit price', '请至少填写一个数量及单价')); return toDetail(res, inv.id); }
    const r = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, 'files'), maxBytes });
    const prev = await latestQuote(inv.id);
    const custom = extraOf(pub).map((x) => ({ label: x.label, value: str(f[`x_${x.key}`], 500) })).filter((c) => c.value);
    await db.insert('dev_quotes', { invitation_id: inv.id, revision: (prev?.revision || 0) + 1, spec_version: p.current_version, currency: F.CURRENCIES.includes(f.currency) ? f.currency : 'USD', incoterm: F.INCOTERMS.includes(f.incoterm) ? f.incoterm : null, tiers,
      tooling_cost: num(f.tooling_cost), tooling_lead_days: int(f.tooling_lead_days), moq: int(f.moq), sample_cost: num(f.sample_cost), sample_lead_days: int(f.sample_lead_days), production_lead_days: int(f.production_lead_days),
      validity_date: /^\d{4}-\d{2}-\d{2}$/.test(f.validity_date || '') ? f.validity_date : null, payment_terms: str(f.payment_terms, 300), material_notes: str(f.material_notes, 300), custom, notes: str(f.notes, 4000), attachments: r.saved.length ? r.saved : (prev?.attachments || []), created_at: now() });
    await db.update('dev_invitations', { id: inv.id }, { status: inv.status === 'Sample' ? 'Sample' : 'Quoted', ack_version: p.current_version, updated_at: now() });
    await notifyAdmin(p, inv, prev ? `submitted a revised quote (rev ${prev.revision + 1})` : 'submitted a quote', `Unit price ${tiers[0].price} ${f.currency || 'USD'} at ${tiers[0].qty}+ pcs`, { label: 'Quote', button: 'Review the quote' });
    flash(res, r.errors.length ? 'warn' : 'ok', m('Quote submitted. Thank you!', '报价已提交，谢谢！') + (r.errors.length ? ' · ' + r.errors.join(' · ') : '')); toDetail(res, inv.id);
  }));
  router.post('/portal/projects/:invId/docs', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv) || ['Declined', 'Selected', 'Closed'].includes(inv.status)) throw new HttpError(403, NA);
    const { fields: f, files } = await parseForm(req, { limitBytes: maxBytes * 10 });
    const pub = await published(p); const ans = { ...(inv.doc_answers || {}) }; const errors = []; let changed = 0;
    const same = (a, b) => JSON.stringify({ ...(a || {}), at: 0 }) === JSON.stringify({ ...(b || {}), at: 0 });
    for (const it of CK.normItems(pub.checklist)) {
      const k = it.key; const prev = ans[k] || null; let next = null;
      if (it.type === 'file') {
        const up = await P.storeFiles(db, { projectId: p.id, files: P.fileList(files, `file_${k}`), maxBytes }); errors.push(...up.errors);
        const st = f[`st_${k}`]; const status = Object.keys(CK.FILE_ANS).includes(st) ? st : (up.saved.length ? 'yes' : prev?.status || null);
        if (!status) continue;
        const day = String(f[`dt_${k}`] || '');
        next = { status, date: status === 'date' ? (/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : prev?.date || null) : null,
          files: [...(prev?.files || []), ...up.saved.map((x) => ({ name: x.name, path: x.path, size: x.size, mime: x.mime, at: now() }))] };
      } else {
        if (!(`v_${k}` in f) && !(`na_${k}` in f) && !(`d_${k}` in f)) continue; // question not on the form
        const details = str(f[`d_${k}`], 500);
        if (it.type === 'multi') { const v = [].concat(f[`v_${k}`] || []).filter((x) => it.options.includes(x)); next = v.length || details ? { value: v, details } : null; }
        else if (it.type === 'choice') { const v = it.options.includes(f[`v_${k}`]) ? f[`v_${k}`] : null; next = v || details ? { value: v, details } : null; }
        else if (f[`na_${k}`] === '1' && it.req !== 'required') next = { value: null, na: true };
        else { const v = str(f[`v_${k}`], 1000); next = v ? { value: v } : null; }
      }
      if (!next) { if (prev && it.type !== 'file') { delete ans[k]; changed++; } continue; }
      if (!same(prev, next)) { ans[k] = { ...next, at: now() }; changed++; }
    }
    if (changed) {
      await db.update('dev_invitations', { id: inv.id }, { doc_answers: ans, updated_at: now() });
      const st = CK.docStatus(pub.checklist, ans);
      await notifyAdmin(p, inv, 'updated the factory checklist', `Answered ${CK.readinessText(st)}`, { label: 'Factory checklist', button: 'Open supplier thread' });
    }
    const noDate = CK.normItems(pub.checklist).filter((it) => ans[it.key]?.status === 'date' && !ans[it.key].date).map((it) => it.name);
    const left = CK.docStatus(pub.checklist, ans).reqLeft.length;
    flash(res, errors.length || noDate.length ? 'warn' : 'ok', (changed ? m('Answers saved', '回答已保存') : m('Nothing changed', '没有更改')) + (left ? ` · ${m(`${left} required questions left`, `还有 ${left} 个必填问题`)}` : '') + (noDate.length ? ` · ${m(`Add the date for: ${noDate.join(', ')}`, `请填写日期：${noDate.join('、')}`)}` : '') + (errors.length ? ` · ${errors.join(' · ')}` : ''));
    res.redirect(`/portal/projects/${inv.id}#docs`);
  }));
  router.post('/portal/projects/:invId/docs/:key/:idx/remove', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv) || ['Declined', 'Selected', 'Closed'].includes(inv.status)) throw new HttpError(403, NA);
    const a = inv.doc_answers?.[req.params.key]; const n = Number(req.params.idx); const f = a?.files?.[n];
    if (f) {
      const files = a.files.filter((_, i) => i !== n); const next = { ...a, files, at: now() };
      await db.update('dev_invitations', { id: inv.id }, { doc_answers: { ...inv.doc_answers, [req.params.key]: next }, updated_at: now() });
      await db.docs.remove([f.path]).catch(() => {}); flash(res, 'ok', m('File removed', '文件已删除'));
    }
    res.redirect(`/portal/projects/${inv.id}#docs`);
  }));
  router.get('/portal/projects/:invId/docs/:key/:idx', A(async (req, res) => {
    const { inv } = await ownInv(req); const f = inv.doc_answers?.[req.params.key]?.files?.[Number(req.params.idx)];
    if (!f) throw new HttpError(404, NA); serve(res, await db.docs.download(f.path), f.name, f.mime, req.query.inline === '1');
  }));
  router.get('/portal/projects/:invId/checklist-file', A(async (req, res) => {
    const { inv, p } = await ownInv(req); if (ndaGate(p, inv)) throw new HttpError(403, NA);
    const pub = await published(p); if (!pub.ckfile?.path) throw new HttpError(404, NA);
    serveCk(res, await db.docs.download(pub.ckfile.path), pub.ckfile, req.query.inline === '1');
  }));
  router.post('/portal/projects/:invId/decline', A(async (req, res) => {
    const { inv, p } = await ownInv(req); await db.update('dev_invitations', { id: inv.id }, { status: 'Declined', updated_at: now() });
    await db.insert('dev_messages', { invitation_id: inv.id, direction: 'supplier', author: req.user?.name || req.user?.email || null, body: '(Declined to quote)', attachments: [], created_at: now() });
    await notifyAdmin(p, inv, 'declined to quote'); flash(res, 'ok', m('You have declined this project.', '您已婉拒此项目。')); toDetail(res, inv.id);
  }));
};
