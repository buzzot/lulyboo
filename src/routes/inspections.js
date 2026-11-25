'use strict';
// Orders → Inspections: request, confirmations, report, Pass / Fail, invoice. Inspection companies list.
//   GET  /admin/orders/inspections?tab=                 list (To request · Upcoming · Your decision · Failed · To pay · All)
//   GET  /admin/orders/inspections/new?supplier=&po=    request page (or ?id= for a "to request" row)
//   POST /admin/orders/inspections/new                  save + send the request (or save only)
//   GET  /admin/orders/inspections/:id                  one inspection
//   POST /admin/orders/inspections/:id/{date,confirm,move,keep,send-confirm,resend,files,decide,invoice,cancel,delete,reopen}
//   POST /admin/orders/inspections/skip · /supplier-off  not needed for a PO / never for a supplier
//   /admin/orders/inspections/companies (+ POST, /:cid, /:cid/delete)

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const ST = require('../staff');
const PL = require('../planning');
const IN = require('../inspections');
const { ddSel } = require('./logistics-costs');

const BASE = '/admin/orders/inspections';
const SQL_MSG = 'Run supabase/inspections.sql in Supabase → SQL Editor first.';
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emails = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const tagOf = (i) => { const s = IN.STATUS[i.status] || [i.status, '']; return html`<span class="cp-tag ${s[1]}">${s[0]}</span>`; };
const poUrl = (sid, po) => `/admin/orders/view?supplier=${encodeURIComponent(sid)}&po=${encodeURIComponent(po)}`;
const fileUrl = (f) => `/admin/logistics/planning/files/${f.id}`;
const fileA = (f, label) => html`<a href="${fileUrl(f)}?inline=1" ${/pdf|image/.test(f.content_type || '') ? raw(`data-preview="${fileUrl(f)}?inline=1" data-type="${/image/.test(f.content_type || '') ? 'image' : 'doc'}" data-dl="${fileUrl(f)}"`) : raw('download')}>${label || f.name}</a>`;
const TABS = [['todo', 'To request'], ['upcoming', 'Upcoming'], ['decision', 'Your decision'], ['failed', 'Failed'], ['pay', 'Invoices to pay'], ['all', 'All']];
const inTab = (tab, i) => ({ todo: i.status === 'todo', upcoming: ['requested', 'scheduled', 'confirmed'].includes(i.status), decision: i.status === 'report', failed: i.status === 'failed', pay: i.invoice_amount && !i.paid_at, all: true }[tab]);
const STEPS = [['requested', 'Requested'], ['scheduled', 'Scheduled'], ['confirmed', 'Confirmed'], ['report', 'Report'], ['decided', 'Pass / Fail'], ['paid', 'Paid']];
function stepAt(i) {
  if (i.paid_at) return 6; if (['passed', 'failed'].includes(i.status)) return i.invoice_amount ? 5 : 4;
  return { todo: 0, requested: 1, scheduled: 2, confirmed: 3, report: 4 }[i.status] ?? 0;
}
const stepsHTML = (i) => { const at = stepAt(i); return html`<ol class="lp-steps in-steps" aria-label="Stage">${STEPS.map(([, l], n) => html`<li class="${n < at ? 'done' : n === at ? 'now' : ''}" ${n === at ? raw('aria-current="step"') : ''}><i>${n < at ? '✓' : n + 1}</i>${l}</li>`)}</ol>`; };
const confTag = (v) => (v === 'confirmed' ? html`<span class="cp-tag ok">✓ Confirmed</span>` : v === 'issue' ? html`<span class="cp-tag warn">Issue</span>` : v === 'asked' ? html`<span class="cp-tag">Waiting</span>` : html`<span class="cp-tag done">Not asked yet</span>`);

module.exports = function inspectionRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = (req) => req.staff?.name || 'Owner';
  const canDel = (req) => !req.staff || ST.can(req.staff.role, 'delete');
  const now = () => new Date().toISOString();
  const get = async (id) => { const i = await db.get('inspections', String(id)).catch(() => null); if (!i) throw new HttpError(404, 'Inspection not found'); return i; };
  const sups = async () => Object.fromEntries((await db.list('suppliers').catch(() => [])).map((s) => [s.id, s]));
  const back = (res, f, fallback) => res.redirect(String(f.back || '').startsWith('/admin/') ? f.back : fallback);
  const noSql = (req, res, title) => res.html(page({ title, nav: adminNav('inspections'), req, flash: takeFlash(req, res), body: html`<h2 class="sl-title">${title}</h2><section class="card"><p>${SQL_MSG}</p></section>` }));

  // ── List ────────────────────────────────────────────────────────────────
  router.get(BASE, G(async (req, res) => {
    const { rows, companies, missing } = await IN.loadAll(db);
    if (missing) return noSql(req, res, 'Inspections');
    const S = await sups(); const today = PL.today();
    const co = Object.fromEntries(companies.map((c) => [c.id, c]));
    const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : rows.some((i) => i.status === 'report') ? 'decision' : rows.some((i) => i.status === 'todo') ? 'todo' : 'upcoming';
    const list = rows.filter((i) => inTab(tab, i)).sort((a, b) => String(a.inspection_date || a.target_date || '9999').localeCompare(String(b.inspection_date || b.target_date || '9999')));
    const count = (k) => rows.filter((i) => inTab(k, i)).length;
    const dateCell = (i) => {
      if (i.inspection_date) return html`<b>${PL.short(i.inspection_date)}</b>${i.status === 'todo' ? '' : html`<div class="sub">${i.inspection_date < today ? 'done' : `in ${Math.round((Date.parse(i.inspection_date) - Date.parse(today)) / 864e5)} days`}</div>`}`;
      if (i.target_date) { const bookBy = PL.addDays(i.target_date, -IN.LEAD.book_ahead); return html`<span class="sub">around</span> ${PL.short(i.target_date)}<div class="sub ${bookBy < today ? 'in-late' : ''}">book by ${PL.short(bookBy)}</div>`; }
      return html`<span class="sub">ready date tbc</span>`;
    };
    res.html(page({
      title: 'Inspections', nav: adminNav('inspections'), flash: takeFlash(req, res), wide: true, req,
      body: html`<div class="cp-head"><div><h2 class="sl-title">Inspections</h2><p class="muted">Quality inspection before shipping — every new PO gets one. Request it about a month ahead; the inspector and the supplier confirm ${IN.LEAD.book_ahead > 0 ? 'a week before' : ''}; reports and invoices sent to <b>${IN.inspectAddress()}</b> are read automatically.</p></div>
        <div class="cp-acts"><a class="btn ghost" href="${BASE}/companies">Inspection companies</a><a class="btn" href="${BASE}/new">+ Inspection</a></div></div>
        ${companies.length ? '' : html`<p class="flash warn">Add your inspection companies first — <a href="${BASE}/companies">Inspection companies</a>.</p>`}
        <nav class="cp-views" aria-label="Inspections">${TABS.map(([k, l]) => html`<a href="${`${BASE}?tab=${k}`}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${l} <span class="or-n">${count(k)}</span></a>`)}</nav>
        <section class="card flush"><div class="table-wrap"><table class="list in-table"><thead><tr><th>Ref</th><th>PO · supplier</th><th>Type</th><th>Company</th><th>Date</th><th>Status</th><th class="r">Fee / invoice</th><th></th></tr></thead><tbody>
        ${list.map((i) => html`<tr><td><a href="${`${BASE}/${i.id}`}"><b>${i.ref}</b></a></td>
          <td>${IN.posOf(i).map((p, n) => html`${n ? ', ' : ''}<a href="${poUrl(i.supplier_id, p)}">${p}</a>`)}<div class="sub">${S[i.supplier_id]?.name || ''}</div></td>
          <td>${IN.SHORT[i.type] || i.type}</td><td>${co[i.company_id]?.name || html`<span class="sub">—</span>`}</td><td>${dateCell(i)}</td>
          <td>${tagOf(i)}${i.status === 'report' && i.ai?.result ? html`<div class="sub">AI suggests ${String(i.ai.result).toUpperCase()}</div>` : ''}${['requested', 'scheduled'].includes(i.status) && i.confirm_sent_at ? html`<div class="sub">inspector ${i.inspector_confirm || '—'} · supplier ${i.supplier_confirm || '—'}</div>` : ''}</td>
          <td class="r">${i.invoice_amount ? html`${IN.usd(i.invoice_amount)}<div class="sub">${i.paid_at ? `paid ${PL.short(i.paid_at)}` : i.invoice_due ? `due ${PL.short(i.invoice_due)}` : 'to pay'}</div>` : i.fee_quoted ? html`<span class="sub">quoted</span> ${IN.usd(i.fee_quoted)}` : '—'}</td>
          <td class="r">${i.status === 'todo' ? html`<span class="in-acts"><a class="btn small" href="${`${BASE}/new?id=${i.id}`}">Request</a><form method="post" action="${`${BASE}/skip`}" class="inline"><input type="hidden" name="id" value="${i.id}"><input type="hidden" name="back" value="${req.url}"><button class="link small" title="This PO doesn't need an inspection">Not needed</button></form></span>` : html`<a class="link small" href="${`${BASE}/${i.id}`}">Open</a>`}</td></tr>`)}
        </tbody></table></div>${list.length ? '' : html`<p class="muted or-empty">${tab === 'todo' ? 'Every open PO has its inspection requested.' : tab === 'decision' ? 'No reports waiting for your decision.' : 'Nothing here.'}</p>`}</section>`,
    }));
  }));

  // ── Request page ────────────────────────────────────────────────────────
  router.get(`${BASE}/new`, G(async (req, res) => {
    const { rows, companies, missing } = await IN.loadAll(db);
    if (missing) return noSql(req, res, 'Request inspection');
    const q = { ...req.query };
    if (q.pick && !q.supplier) { const [s0, p0] = String(q.pick).split('|'); q.supplier = s0; q.po = p0; }
    const todo = q.id ? rows.find((x) => x.id === q.id) : null;
    const sid = todo?.supplier_id || q.supplier || '';
    const open = await IN.openPos(db);
    if (!sid) {
      const S = await sups();
      const opts = open.sort((a, b) => String(a.ready || '9').localeCompare(String(b.ready || '9'))).map((p) => [`${p.supplier_id}|${p.po}`, `${p.po} · ${S[p.supplier_id]?.name || ''}${p.ready ? ` · ready ${PL.short(p.ready)}` : ''}`]);
      return res.html(page({ title: 'Request inspection', nav: adminNav('inspections'), req, flash: takeFlash(req, res), wide: true, body: html`<p class="crumbs"><a href="${BASE}">Inspections</a></p><h2 class="sl-title">Request inspection</h2>
        <section class="card in-pick"><form method="get" action="${`${BASE}/new`}" data-in-pick><label>Purchase order ${ddSel('pick', '', [['', 'Choose a PO…'], ...opts])}</label><button class="btn">Continue</button></form></section>` }));
    }
    const sup = await db.get('suppliers', sid).catch(() => null); if (!sup) throw new HttpError(404, 'Supplier not found');
    const mine = open.filter((p) => p.supplier_id === sid).sort((a, b) => String(a.ready || '9').localeCompare(String(b.ready || '9')));
    const chosen = new Set((todo ? IN.posOf(todo) : [q.po]).filter(Boolean).map(PL.normPo));
    const firstReady = mine.filter((p) => chosen.has(PL.normPo(p.po))).map((p) => p.ready).filter(Boolean).sort()[0];
    const day = todo?.inspection_date || PL.isoDay(q.date) || todo?.target_date || IN.timing(firstReady).target || '';
    const versions = await IN.reqVersions(db, sid);
    const last = versions[0];
    const conts = (await db.list('plan_containers').catch(() => [])).filter((c) => c.status !== 'shipped');
    const lines = await db.list('plan_orders', { filters: { supplier_id: sid } }).catch(() => []);
    const cIds = new Set(lines.filter((l) => l.container_id && chosen.has(PL.normPo(l.po))).map((l) => l.container_id));
    const cOpts = [['', 'Not linked'], ...conts.filter((c) => cIds.has(c.id) || c.id === todo?.container_id).map((c) => [c.id, require('../shipname').shipName(c)])];
    const P = require('../projects');
    const supMails = await P.supplierRecipients(db, sup).catch(() => []);
    const coOpts = companies.filter((c) => c.active !== false).map((c) => [c.id, c.name]);
    const coDef = todo?.company_id || rows.filter((x) => x.supplier_id === sid && x.company_id).map((x) => x.company_id)[0] || coOpts[0]?.[0] || '';
    res.html(page({
      title: 'Request inspection', nav: adminNav('inspections'), req, flash: takeFlash(req, res), wide: true,
      body: html`<p class="crumbs"><a href="${BASE}">Inspections</a> · <a href="${poUrl(sid, [...chosen][0] || '')}">${sup.name}</a></p>
        <h2 class="sl-title">Request inspection · ${sup.name}</h2>
        ${coOpts.length ? '' : html`<p class="flash warn">No inspection companies yet — <a href="${`${BASE}/companies`}">add one</a> first.</p>`}
        <form method="post" action="${`${BASE}/new`}" enctype="multipart/form-data" class="card in-form" id="in-form" data-busy data-in-form>
          <input type="hidden" name="supplier_id" value="${sid}">${todo ? html`<input type="hidden" name="id" value="${todo.id}">` : html`<input type="hidden" name="ref" value="${IN.newRef()}">`}
          <div class="in-lay"><div class="in-main">
          <h3 class="in-h">Purchase orders inspected</h3>
          <div class="in-pos">${mine.map((p) => html`<label class="in-po"><input type="checkbox" name="pos" value="${p.po}" ${chosen.has(PL.normPo(p.po)) ? raw('checked') : ''}><b>${p.po}</b>${p.ready ? html`<span class="in-ready">ready ${PL.short(p.ready)}</span>` : html`<span class="sub">ready date not set</span>`}${(() => {
            const items = []; const seen = new Set();
            for (const l of lines) { if (PL.normPo(l.po) !== PL.normPo(p.po)) continue; const k = `${l.sku || ''}|${l.product || ''}`; if (seen.has(k)) continue; seen.add(k); items.push(l); }
            return items.length ? html`<span class="in-pop" role="tooltip"><span class="in-pop-h">${p.po} · ${items.length} item${items.length === 1 ? '' : 's'}</span>${items.slice(0, 30).map((l) => html`<span class="in-pop-r">${l.sku ? html`<button type="button" class="in-sku" data-copy="${l.sku}" title="Copy SKU">${l.sku}</button>` : html`<code>—</code>`}<span>${l.product || ''}</span></span>`)}${items.length > 30 ? html`<span class="sub">+ ${items.length - 30} more</span>` : ''}</span>` : '';
          })()}</label>`)}</div>
          <div class="in-grid">
            <label><span class="lbl">Inspection company</span>${coOpts.length ? ddSel('company_id', coDef, coOpts) : html`<span class="sub">none yet</span>`}</label>
            <label><span class="lbl">Type</span>${ddSel('type', todo?.type || (IN.TYPES[q.type] ? q.type : 'psi'), Object.entries(IN.TYPES))}</label>
            <label><span class="lbl">Shipment</span>${ddSel('container_id', todo?.container_id || [...cIds][0] || '', cOpts)}</label>
            <label><span class="lbl">Inspection day</span><input type="date" name="inspection_date" value="${day}"><span class="sub">${firstReady ? `ready ${PL.short(firstReady)} · suggested ${IN.LEAD.before_ready} days before` : 'ready date not known'}</span></label>
            <label><span class="lbl">AQL level</span>${ddSel('aql', todo?.aql || IN.AQLS[0], IN.AQLS.map((a) => [a, a]))}</label>
            <label><span class="lbl">Confirmation emails</span>${ddSel('confirm_days', String(todo?.confirm_days ?? 7), [3, 5, 7, 10, 14].map((d) => [String(d), `${d} days before · inspector + supplier`]))}</label>
            <label><span class="lbl">Fee quoted (USD)</span><input name="fee_quoted" inputmode="decimal" value="${todo?.fee_quoted ?? ''}" placeholder="optional"></label>
          </div>
          <div class="in-btns"><button type="button" class="btn" data-in-review>Send request…</button><button class="btn ghost" name="send" value="">Save without sending</button><a class="link small" href="${BASE}">Cancel</a></div>
          </div>
          <aside class="in-side" aria-label="Attachments">
            <h3 class="in-h">Attachments <span class="sub">sent with the request</span></h3>
            <div class="in-att">
              <div class="in-att-h"><b>Testing requirements</b>${last ? html`<span class="cp-tag">v${last.version}</span>` : html`<span class="cp-tag warn">Required</span>`}</div>
              ${last ? html`<ul class="in-att-l">${last.files.map((lf) => html`<li><span class="in-ic">${(String(lf.name).match(/\.([a-z0-9]+)$/i) || [, 'FILE'])[1].toUpperCase().slice(0, 4)}</span><span class="in-att-n">${fileA(lf, lf.name)}</span></li>`)}</ul><p class="sub in-hist">${last.files.length} file${last.files.length === 1 ? '' : 's'} · ${last.used.length ? `used ${PL.short(String(last.used[0].at).slice(0, 10))} · ${last.used[0].ref}` : `added ${PL.short(String(last.file.created_at).slice(0, 10))}`}</p>
                <label class="cp-chk in-ok"><input type="checkbox" name="req_ok" value="1"> Still correct, send v${last.version} again${last.files.length > 1 ? ` (${last.files.length} files)` : ''}</label>` : html`<p class="sub">No file for ${sup.name} yet.</p>`}
            <div class="mdrop small in-drop" data-filebox data-max="10"><div class="mdrop-box"><input type="file" name="req_file" multiple accept=".pdf,.doc,.docx,.xlsx,.xls,.png,.jpg,.jpeg" aria-label="Updated testing requirements"><span class="dz-main" data-main>${last ? html`Drop updated files <span class="sub">→ v${last.version + 1}</span>` : html`Drop the files or <u>choose</u>`}</span><span class="dz-hint">PDF, Word, Excel or image · paste works too</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
              ${versions.length > 1 ? html`<p class="sub in-hist">History: ${versions.slice().reverse().map((v, n) => html`${n ? ' · ' : ''}${fileA(v.file, `v${v.version}`)}${v.files.length > 1 ? ` (${v.files.length})` : ''}`)}</p>` : ''}
            </div>
          </aside></div>
        </form>
        <dialog class="in-dlg" data-in-dlg aria-labelledby="in-dlg-t">
          <div class="in-dlg-h"><h3 id="in-dlg-t">Review the email</h3><span class="sub">Check it, edit To, Cc or the message here, then send.</span><button type="button" class="in-dlg-x" data-close-dialog aria-label="Close">×</button></div>
          <div class="in-dlg-m">
            <label><span>To</span><input name="to" form="in-form" data-in-live placeholder="the company's booking email" aria-label="To"></label>
            <label><span>Cc</span><input name="cc" form="in-form" data-in-live value="${[...supMails, ...require('../projects').ownerEmails()].join(', ')}" aria-label="Cc"></label>
            <div><span>Subject</span><b data-d="subject"></b></div>
            <div><span>Attached</span><span data-d="att"></span></div>
            <label class="in-dlg-msg"><span>Message</span><textarea name="intro" form="in-form" rows="2" data-in-live placeholder="Optional: replaces the first paragraph of the email." aria-label="Message"></textarea></label>
            <p class="sub">Always copied: ${IN.ALWAYS_CC.join(', ')} · English · replies come to ${IN.inspectAddress()} · the email lists the factory address and contact, every product with qty and cartons, and the AQL.</p></div>
          <p class="in-dlg-err" data-d="err" hidden></p>
          <iframe class="in-dlg-f" sandbox title="Email preview" data-d="frame"></iframe>
          <div class="in-dlg-b"><button type="button" class="btn ghost" data-close-dialog>Back to edit</button><span class="sub" data-d="state">Changes update the preview.</span><button type="submit" class="btn" form="in-form" name="send" value="1" data-in-send>Send now</button></div>
        </dialog>`,
    }));
  }));

  // Review before sending: the exact request email for what is on the form (nothing is saved).
  router.post(`${BASE}/draft`, G(async (req, res) => {
    const { fields: f } = await parseForm(req, { limitBytes: 2 * 1024 * 1024 });
    const sid = String(f.supplier_id || ''); const sup = await db.get('suppliers', sid).catch(() => null);
    const pos = [].concat(f.pos || []).map((x) => String(x).trim()).filter(Boolean);
    const err = (m) => res.json({ ok: false, error: m }, 400);
    if (!sup) return err('Supplier not found'); if (!pos.length) return err('Tick at least one PO');
    if (!f.company_id) return err('Choose the inspection company'); if (!IN.TYPES[f.type]) return err('Choose the inspection type');
    const versions = await IN.reqVersions(db, sid); const reqNames = [].concat(f.req_name || []).map((x) => String(x).trim()).filter(Boolean); const reqName = reqNames[0];
    if (!reqName && !(f.req_ok && versions.length)) return err(versions.length ? `Attach the updated requirements file, or tick that v${versions[0].version} is still correct` : 'Attach the testing requirements file');
    const old = f.id ? await db.get('inspections', String(f.id)).catch(() => null) : null;
    const i = { ref: old?.ref || (IN.REF_RE.test(String(f.ref || '')) ? String(f.ref) : 'LBI-NEW'), supplier_id: sid, pos, company_id: String(f.company_id), type: f.type, inspection_date: PL.isoDay(f.inspection_date), aql: String(f.aql || '').slice(0, 40) || null };
    const d = await IN.requestDraft(db, i, { to: emails(f.to), cc: emails(f.cc), intro: String(f.intro || '').trim() });
    const reqLabels = reqName ? reqNames.map((x) => `${x} (requirements v${(versions[0]?.version || 0) + 1})`) : versions[0].files.map((x) => `${x.name} (requirements v${versions[0].version})`);
    res.json({ ok: true, to: d.to, cc: d.cc, subject: d.subject, html: d.html, attachments: reqLabels, warn: d.to.length ? '' : 'The inspection company has no email: add it under Inspection companies, or type one in To.' });
  }));

  router.post(`${BASE}/new`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 30 * 1024 * 1024 });
    const sid = String(f.supplier_id || '');
    const sup = await db.get('suppliers', sid).catch(() => null); if (!sup) throw new HttpError(404, 'Supplier not found');
    const pos = [].concat(f.pos || []).map((x) => String(x).trim()).filter(Boolean);
    const redo = (msg) => { flash(res, 'warn', msg); res.redirect(`${BASE}/new?${f.id ? `id=${f.id}` : `supplier=${sid}&po=${encodeURIComponent(pos[0] || '')}`}`); };
    if (!pos.length) return redo('Tick at least one PO');
    if (!f.company_id) return redo('Choose the inspection company');
    if (!IN.TYPES[f.type]) return redo('Choose the inspection type');
    const date = PL.isoDay(f.inspection_date);
    const { rows } = await IN.loadAll(db);
    const versions = await IN.reqVersions(db, sid);
    const uploads = [].concat(files.req_file || []).filter((x) => x?.buffer?.length).slice(0, 10); const upload = uploads[0];
    if (!upload && !(f.req_ok && versions.length)) return redo(versions.length ? `Attach the updated requirements file, or tick that v${versions[0].version} is still correct` : 'Attach the testing requirements file');
    let i = f.id ? rows.find((x) => x.id === f.id) : null;
    const base = { supplier_id: sid, pos, company_id: String(f.company_id), type: f.type, container_id: f.container_id || null, inspection_date: date, aql: String(f.aql || '').slice(0, 40) || null, confirm_days: Math.max(1, Math.min(30, Number(f.confirm_days) || 7)), fee_quoted: IN.num(f.fee_quoted), updated_at: now() };
    if (i) { await db.update('inspections', { id: i.id }, base); i = { ...i, ...base }; }
    else { const want = IN.REF_RE.test(String(f.ref || '')) && !rows.some((x) => x.ref === f.ref) ? String(f.ref) : IN.newRef(); i = await db.insert('inspections', { ...base, ref: want, status: 'todo', log: [{ at: now(), text: 'Created', by: by(req) }], created_at: now() }); }
    // other "to request" rows for the POs now covered: this request replaces them
    for (const x of rows.filter((x) => x.id !== i.id && x.status === 'todo' && x.supplier_id === sid && IN.posOf(x).every((p) => pos.some((q) => PL.normPo(q) === PL.normPo(p))))) await db.update('inspections', { id: x.id }, { status: 'cancelled', log: IN.withLog(x, `Replaced by ${i.ref}`, by(req)), updated_at: now() });
    let reqFile = versions[0]?.file; let ver = versions[0]?.version;
    if (upload) { const batch = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; const saved = []; for (const u of uploads) saved.push(await IN.storeFile(db, i, { ...u, name: u.name }, IN.REQ_KIND, by(req), batch)); reqFile = saved[0]; ver = (versions[0]?.version || 0) + 1; }
    const p2 = { req_file_id: reqFile.id, req_version: ver, status: i.status === 'todo' ? (f.send ? 'requested' : 'scheduled') : i.status, log: IN.withLog(i, `${f.send ? 'Request prepared' : 'Saved without sending'} · requirements v${ver}${uploads.length > 1 ? ` (${uploads.length} files)` : ''}${date ? ` · ${PL.short(date)}` : ''}`, by(req)) };
    await db.update('inspections', { id: i.id }, p2); i = { ...i, ...p2 };
    if (f.send) {
      try { await IN.sendRequest(db, config, i, { edits: { to: emails(f.to), cc: emails(f.cc), intro: String(f.intro || '').trim() }, by: by(req) }); flash(res, 'ok', `${i.ref} sent to the inspection company`); }
      catch (e) { flash(res, 'warn', `${i.ref} saved, but the email didn't go out: ${e.message}`); }
    } else flash(res, 'ok', `${i.ref} saved — status Scheduled`);
    res.redirect(`${BASE}/${i.id}`);
  }));

  // ── Not needed ──────────────────────────────────────────────────────────
  router.post(`${BASE}/skip`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    if (f.id) { const i = await get(f.id); await db.update('inspections', { id: i.id }, { status: 'skipped', log: IN.withLog(i, 'Not needed for this PO', by(req)), updated_at: now() }); }
    else if (f.supplier_id && f.po) await db.insert('inspections', { ref: IN.newRef(), supplier_id: f.supplier_id, pos: [String(f.po)], status: 'skipped', type: 'psi', log: [{ at: now(), text: 'Not needed for this PO', by: by(req) }], created_at: now() });
    flash(res, 'ok', 'Marked as not needed'); back(res, f, BASE);
  }));
  router.post(`${BASE}/supplier-off`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const s = await db.get('suppliers', String(f.supplier_id || '')).catch(() => null); if (!s) throw new HttpError(404, 'Supplier not found');
    await db.update('suppliers', { id: s.id }, { inspection_off: !f.on });
    if (!f.on) { const { rows } = await IN.loadAll(db); for (const x of rows.filter((x) => x.supplier_id === s.id && x.status === 'todo')) await db.update('inspections', { id: x.id }, { status: 'skipped', log: IN.withLog(x, `${s.name}: inspections switched off`, by(req)), updated_at: now() }); }
    flash(res, 'ok', f.on ? `Inspections on again for ${s.name}` : `No inspection alerts for ${s.name} any more`); back(res, f, BASE);
  }));

  // ── Inspection companies ────────────────────────────────────────────────
  const coFrom = (f) => {
    const name = String(f.name || '').trim().slice(0, 120); if (!name) throw new HttpError(400, 'Company name is required');
    const email = emails(f.email); const cc = emails(f.cc);
    const bad = [...email, ...cc].find((e) => !EMAIL_RE.test(e)); if (bad) throw new HttpError(400, `Check this email address: ${bad}`);
    if (!email.length) throw new HttpError(400, 'Booking email is required');
    return { name, email: email[0], cc: [...email.slice(1), ...cc].join(', ') || null, contact: String(f.contact || '').trim().slice(0, 120) || null, phone: String(f.phone || '').trim().slice(0, 60) || null, man_day_usd: IN.num(f.man_day_usd), default_aql: String(f.default_aql || '').slice(0, 40) || null, notes: String(f.notes || '').trim().slice(0, 500) || null };
  };
  router.get(`${BASE}/companies`, G(async (req, res) => {
    const { rows, companies, missing } = await IN.loadAll(db);
    if (missing) return noSql(req, res, 'Inspection companies');
    const field = (n, l, v, extra = '') => html`<label><span class="lbl">${l}</span><input name="${n}" value="${v ?? ''}" ${raw(extra)}></label>`;
    const form = (c = {}) => html`<div class="in-grid">${field('name', 'Company', c.name, 'required')}${field('email', 'Booking email', c.email, 'required type="email"')}${field('cc', 'Cc', c.cc, 'placeholder="more addresses, comma separated"')}${field('contact', 'Contact person', c.contact)}${field('phone', 'Phone', c.phone)}${field('man_day_usd', 'Price per inspection (USD)', c.man_day_usd, 'inputmode="decimal"')}<label><span class="lbl">Default AQL</span>${ddSel('default_aql', c.default_aql || IN.AQLS[0], IN.AQLS.map((a) => [a, a]))}</label>${field('notes', 'Notes', c.notes)}</div>`;
    const stat = (id) => { const xs = rows.filter((i) => i.company_id === id); return { n: xs.filter((i) => !['todo', 'skipped', 'cancelled'].includes(i.status)).length, pass: xs.filter((i) => i.status === 'passed').length, fail: xs.filter((i) => i.status === 'failed').length, spent: xs.reduce((a, i) => a + (Number(i.invoice_amount) || 0), 0) }; };
    res.html(page({
      title: 'Inspection companies', nav: adminNav('inspections'), req, flash: takeFlash(req, res), wide: true,
      body: html`<p class="crumbs"><a href="${BASE}">Inspections</a></p><div class="cp-head"><div><h2 class="sl-title">Inspection companies</h2><p class="muted">Who you book inspections with. Requests go to the booking email; their replies, reports and invoices come back to ${IN.inspectAddress()}.</p></div></div>
        <section class="card"><h2 class="sec">Add a company</h2><form method="post" action="${`${BASE}/companies`}">${form()}<button class="btn">Add company</button></form></section>
        <section class="card flush"><div class="table-wrap"><table class="list"><thead><tr><th>Company</th><th>Contact</th><th>Email</th><th class="r">Price</th><th class="r">Inspections</th><th class="r">Passed / failed</th><th class="r">Invoiced</th><th></th></tr></thead><tbody>
          ${companies.map((c) => { const s = stat(c.id); return html`<tr class="${c.active === false ? 'done' : ''}"><td><b>${c.name}</b>${c.notes ? html`<div class="sub">${c.notes}</div>` : ''}</td><td>${c.contact || '—'}${c.phone ? html`<div class="sub">${c.phone}</div>` : ''}</td><td>${c.email || '—'}${c.cc ? html`<div class="sub">cc ${c.cc}</div>` : ''}</td><td class="r">${c.man_day_usd ? IN.usd(c.man_day_usd) : '—'}</td><td class="r">${s.n || '—'}</td><td class="r">${s.pass} / ${s.fail}</td><td class="r">${s.spent ? IN.usd(s.spent) : '—'}</td>
            <td class="fw-acts" data-armbox><details><summary class="link small">Edit</summary><form method="post" action="${`${BASE}/companies/${c.id}`}">${form(c)}<label class="cp-chk"><input type="checkbox" name="active" value="1" ${c.active !== false ? raw('checked') : ''}> Active</label><button class="btn small">Save</button></form></details>
              ${canDel(req) ? html`<button type="button" class="bd-del" data-arm>Delete</button><button type="submit" class="bd-yes" form="${`co-del-${c.id}`}">✓ Delete</button><form id="${`co-del-${c.id}`}" method="post" action="${`${BASE}/companies/${c.id}/delete`}" class="inline"></form>` : ''}</td></tr>`; })}
        </tbody></table></div>${companies.length ? '' : html`<p class="muted or-empty">No companies yet.</p>`}</section>`,
    }));
  }));
  router.post(`${BASE}/companies`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    try { const c = await db.insert('inspection_companies', { ...coFrom(f), active: true, created_at: now() }); flash(res, 'ok', `${c.name} added`); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(`${BASE}/companies`);
  }));
  router.post(`${BASE}/companies/:cid`, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    try { await db.update('inspection_companies', { id: req.params.cid }, { ...coFrom(f), active: !!f.active }); flash(res, 'ok', 'Saved'); } catch (e) { flash(res, 'warn', e.message); }
    res.redirect(`${BASE}/companies`);
  }));
  router.post(`${BASE}/companies/:cid/delete`, G(async (req, res) => {
    if (!canDel(req)) throw new HttpError(403, 'Only an Admin can delete');
    await db.remove('inspection_companies', { id: req.params.cid }); flash(res, 'ok', 'Company deleted — its past inspections are kept'); res.redirect(`${BASE}/companies`);
  }));

  // ── One inspection ──────────────────────────────────────────────────────
  router.get(`${BASE}/:id`, G(async (req, res) => {
    const i = await get(req.params.id);
    const sup = await db.get('suppliers', i.supplier_id).catch(() => null) || {};
    const co = i.company_id ? await db.get('inspection_companies', i.company_id).catch(() => null) : null;
    const files = await IN.filesOf(db, i);
    const reqFs = IN.reqSet(files, i); const reqF = reqFs[0];
    const docs = files.filter((f) => !reqFs.some((r) => r.id === f.id));
    const cont = i.container_id ? await db.get('plan_containers', i.container_id).catch(() => null) : null;
    const today = PL.today(); const url = `${BASE}/${i.id}`;
    const hid = html`<input type="hidden" name="back" value="${url}">`;
    const confDay = i.inspection_date ? PL.addDays(i.inspection_date, -(i.confirm_days ?? 7)) : null;
    const ai = i.ai || null;
    const lim = (v, l) => (v == null ? '' : `${v}${l != null ? ` (limit ${l})` : ''}`);
    const confRow = (side, label) => html`<div class="in-cf"><span class="in-cfl">${confTag(i[`${side}_confirm`])}<b>${label}</b></span><span class="sub in-cfn">${i[`${side}_note`] ? `“${i[`${side}_note`]}”` : i[`${side}_confirm`] === 'asked' ? `asked ${PL.short(String(i.confirm_sent_at).slice(0, 10))}` : ''}</span>
      <span class="in-cfa">${i[`${side}_confirm`] === 'issue' && i.proposed_date ? html`<form method="post" action="${`${url}/move`}" class="inline">${hid}<input type="hidden" name="date" value="${i.proposed_date}"><button class="link small">Move to ${PL.short(i.proposed_date)}</button></form>` : ''}
        ${i[`${side}_confirm`] === 'issue' ? html`<form method="post" action="${`${url}/keep`}" class="inline">${hid}<input type="hidden" name="side" value="${side}"><button class="link small">Keep ${PL.short(i.inspection_date)}</button></form>` : ''}
        ${i[`${side}_confirm`] !== 'confirmed' && i.inspection_date ? html`<form method="post" action="${`${url}/confirm`}" class="inline">${hid}<input type="hidden" name="side" value="${side}"><button class="link small" title="They confirmed another way (phone, WeChat)">Mark confirmed</button></form>` : ''}</span></div>`;
    const kinds = ['Inspection report', 'Inspection invoice', 'Inspection photos', 'Inspection document'];
    res.html(page({
      title: `${i.ref} · Inspection`, nav: adminNav('inspections'), req, flash: takeFlash(req, res), wide: true,
      body: html`<p class="crumbs"><a href="${BASE}">Inspections</a> · ${IN.posOf(i).map((p, n) => html`${n ? ', ' : ''}<a href="${poUrl(i.supplier_id, p)}">PO ${p}</a>`)}</p>
        <div class="cp-head"><div><h2 class="sl-title">${i.ref} · ${IN.TYPES[i.type] || 'Inspection'} ${tagOf(i)}</h2>
          <p class="muted">${co?.name || 'No company yet'} · ${sup.name || ''} · PO ${IN.posOf(i).join(', ')}${cont ? ` · ${require('../shipname').shipName(cont)}` : ''}</p></div>
          <div class="cp-acts">${i.status === 'todo' ? html`<a class="btn" href="${`${BASE}/new?id=${i.id}`}">Request inspection</a>` : ''}${['requested', 'scheduled', 'confirmed'].includes(i.status) ? html`<a class="btn ghost" href="${`${BASE}/new?id=${i.id}`}">Edit request</a>` : ''}</div></div>
        <section class="card">${stepsHTML(i)}
          <div class="in-kv"><div><b>${i.inspection_date ? PL.short(i.inspection_date) : i.target_date ? `~${PL.short(i.target_date)}` : '—'}</b><span>inspection day${i.inspection_date ? '' : ' (suggested)'}</span></div>
            <div><b>${confDay ? PL.short(confDay) : '—'}</b><span>${i.confirm_sent_at ? `confirmation emails sent ${PL.short(String(i.confirm_sent_at).slice(0, 10))}` : `confirmation emails · ${i.confirm_days ?? 7} days before`}</span></div>
            <div><b>${reqF ? `Requirements v${i.req_version || 1}` : '—'}</b><span>${reqF ? reqFs.map((f, n) => html`${n ? ' · ' : ''}${fileA(f, f.name)}`) : 'not attached yet'}</span></div>
            <div><b>${i.invoice_amount ? IN.usd(i.invoice_amount) : i.fee_quoted ? IN.usd(i.fee_quoted) : '—'}</b><span>${i.invoice_amount ? (i.paid_at ? `paid ${PL.short(i.paid_at)}` : `invoice${i.invoice_due ? ` · due ${PL.short(i.invoice_due)}` : ''}`) : i.fee_quoted ? 'quoted' : 'fee'}</span></div></div>
          ${['requested', 'scheduled', 'confirmed'].includes(i.status) ? html`<form method="post" action="${`${url}/date`}" class="in-date">${hid}<label>Inspection day <input type="date" name="date" value="${i.inspection_date || ''}" required></label><button class="btn small ghost">${i.inspection_date ? 'Change date' : 'Set date (booked)'}</button><span class="sub">A new date resets the confirmations — they go out again ${i.confirm_days ?? 7} days before.</span></form>` : ''}
        </section>

        ${['requested', 'scheduled', 'confirmed'].includes(i.status) && i.inspection_date ? html`<section class="card"><div class="in-sh"><h3 class="in-h">Confirmations · ${i.confirm_days ?? 7} days before</h3>
          ${i.inspection_date >= today ? html`<form method="post" action="${`${url}/send-confirm`}" class="inline">${hid}<button class="btn small ghost">${i.confirm_sent_at ? 'Send again' : 'Send now'}</button></form>` : ''}</div>
          ${i.confirm_sent_at ? html`${confRow('inspector', `Inspector · ${co?.name || ''}`)}${confRow('supplier', `Supplier · ${sup.name || ''}`)}<p class="sub">No answer in ${IN.LEAD.remind_after} days → a reminder goes to whoever hasn't answered, and you get a Telegram.</p>`
            : html`<p class="sub">On ${confDay ? PL.short(confDay) : '—'} two emails go out: to the inspector (date, factory, final qty) and to the supplier (is the date OK — goods finished and at least 80% packed?). Their replies are read automatically.</p>`}</section>` : ''}

        <section class="card"><div class="in-sh"><h3 class="in-h">Report & invoice</h3></div>
          ${ai ? html`<div class="in-ai ${ai.result === 'fail' ? 'f' : ai.result === 'pass' ? 'p' : ''}"><span aria-hidden="true">🤖</span><span><b>AI summary — suggests ${String(ai.result || 'unknown').toUpperCase()}:</b> ${[ai.critical != null ? `${ai.critical} critical` : '', ai.major != null ? `${lim(ai.major, ai.limit_major)} major` : '', ai.minor != null ? `${lim(ai.minor, ai.limit_minor)} minor` : '', ai.sampled ? `${ai.sampled} pcs sampled` : ''].filter(Boolean).join(' · ')}${ai.findings ? ` — ${ai.findings}` : ''}${ai.summary ? html`<br><span class="sub">${ai.summary}</span>` : ''}${ai.pos?.length ? html`<br><span class="sub">POs in the report: ${ai.pos.join(', ')} — the report is on each of them.</span>` : ''}</span></div>` : html`<p class="sub">Reports and invoices emailed to <b>${IN.inspectAddress()}</b> (keep ${i.ref} in the subject) land here and on each PO. Or add them below.</p>`}
          ${i.status === 'report' || (ai && !['passed', 'failed'].includes(i.status)) ? html`<form method="post" action="${`${url}/decide`}" class="in-dec">${hid}<textarea name="note" rows="2" placeholder="Notes (shown on the PO) — e.g. labels to be fixed before loading"></textarea>
            <div class="in-decb"><button class="btn in-pass" name="decision" value="pass">Pass</button><button class="btn in-fail" name="decision" value="fail">Fail</button><button class="btn ghost" name="decision" value="pass_notes">Pass with notes</button><span class="sub">Fail puts the POs on hold — Confirm booking warns until there's a Pass.</span></div></form>` : ''}
          ${['passed', 'failed'].includes(i.status) ? html`<p class="in-decided">${tagOf(i)} <span class="sub">${i.decision === 'pass_notes' ? 'with notes · ' : ''}by ${i.decided_by || '—'} · ${i.decided_at ? PL.short(String(i.decided_at).slice(0, 10)) : ''}</span>${i.decision_note ? html`<br>${i.decision_note}` : ''} <form method="post" action="${`${url}/reopen`}" class="inline">${hid}<button class="link small">Change</button></form></p>` : ''}
          <div class="in-files">${docs.map((f) => html`<span class="in-file"><span class="cp-tag">${String(f.kind || 'File').replace('Inspection ', '')}</span> ${fileA(f)}</span>`)}</div>
          <details class="in-add"><summary class="link small">Add report, invoice or photos</summary>
            <form method="post" action="${`${url}/files`}" enctype="multipart/form-data" data-busy class="in-addf">${hid}
              <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple required accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx" aria-label="Inspection files"><span class="dz-main" data-main>Drag &amp; drop or choose files</span><span class="dz-hint">AI reads the report and the invoice</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
              <div class="in-addr">${ddSel('kind', '', [['', 'Detect type'], ...kinds.map((k) => [k, k.replace('Inspection ', '')])])}<button class="btn small">Add</button></div></form></details>
          <details class="in-invd" ${i.invoice_amount != null || i.invoice_no || ai ? raw('open') : ''}><summary class="in-h">Invoice ${i.invoice_amount != null ? html`<span class="sub">${IN.usd(i.invoice_amount)}${i.paid_at ? ` · paid ${PL.short(i.paid_at)}` : i.invoice_due ? ` · due ${PL.short(i.invoice_due)}` : ''}</span>` : html`<span class="sub">read from the inspector's email, or type it</span>`}</summary>
          <form method="post" action="${`${url}/invoice`}" class="in-grid in-inv">${hid}
            <label><span class="lbl">Invoice no.</span><input name="invoice_no" value="${i.invoice_no || ''}"></label>
            <label><span class="lbl">Amount (USD)</span><input name="invoice_amount" inputmode="decimal" value="${i.invoice_amount ?? ''}"></label>
            <label><span class="lbl">Due</span><input type="date" name="invoice_due" value="${i.invoice_due || ''}"></label>
            <label><span class="lbl">File</span>${ddSel('invoice_file_id', i.invoice_file_id || '', [['', 'None'], ...docs.map((f) => [f.id, f.name])])}</label>
            <div class="in-btns"><button class="btn small">Save invoice</button><span class="sub">${i.paid_at ? html`Paid ${PL.short(i.paid_at)}${i.paid_by ? ` by ${i.paid_by}` : ''}` : 'It appears in Accountant view → Inspection invoices.'}</span></div></form></details>
        </section>

        <section class="card"><h3 class="in-h">History</h3><ul class="fn-log">${[...(i.log || [])].reverse().map((x) => html`<li><span>${PL.short(String(x.at || '').slice(0, 10))}</span><span>${x.text}${x.by ? html` <small class="sub">· ${x.by}</small>` : ''}</span></li>`)}</ul>
          <div class="in-foot" data-armbox>${!['cancelled', 'passed', 'failed'].includes(i.status) ? html`<form method="post" action="${`${url}/cancel`}" class="inline" data-confirm="Cancel this inspection? The POs go back to “to request”.">${hid}<button class="link small">Cancel inspection</button></form>` : ''}
            ${canDel(req) ? html`<button type="button" class="bd-del" data-arm>Delete</button><button type="submit" class="bd-yes" form="in-del">✓ Delete</button><form id="in-del" method="post" action="${`${url}/delete`}" class="inline"></form>` : ''}</div></section>`,
    }));
  }));

  const act = (path, fn) => router.post(`${BASE}/:id/${path}`, G(async (req, res) => {
    const { fields: f, files } = await parseForm(req, { limitBytes: 45 * 1024 * 1024 });
    const i = await get(req.params.id);
    const msg = await fn(i, f, req, files);
    if (msg) flash(res, msg[0], msg[1]);
    back(res, f, `${BASE}/${i.id}`);
  }));
  const reset = { confirm_sent_at: null, inspector_confirm: null, supplier_confirm: null, inspector_note: null, supplier_note: null, proposed_date: null, reminded_at: null };
  act('date', async (i, f, req) => {
    const d = PL.isoDay(f.date); if (!d) return ['warn', 'Choose a date'];
    const changed = d !== i.inspection_date;
    await db.update('inspections', { id: i.id }, { inspection_date: d, ...(changed ? reset : {}), status: ['todo', 'requested'].includes(i.status) ? 'scheduled' : changed && i.status === 'confirmed' ? 'scheduled' : i.status, log: IN.withLog(i, `Inspection day ${changed ? `set to ${PL.short(d)}` : 'kept'}`, by(req)), updated_at: now() });
    return ['ok', `Inspection day ${PL.short(d)}`];
  });
  act('move', async (i, f, req) => {
    const d = PL.isoDay(f.date); if (!d) return ['warn', 'No date'];
    await db.update('inspections', { id: i.id }, { inspection_date: d, ...reset, status: 'scheduled', log: IN.withLog(i, `Moved to ${PL.short(d)}`, by(req)), updated_at: now() });
    const ni = { ...i, inspection_date: d, ...reset, status: 'scheduled' };
    try { await IN.sendConfirmations(db, config, ni, { by: by(req) }); return ['ok', `Moved to ${PL.short(d)} — the inspector and the supplier were asked to confirm the new date`]; }
    catch (e) { return ['warn', `Moved to ${PL.short(d)}, but the emails didn't go out: ${e.message}`]; }
  });
  act('keep', async (i, f, req) => {
    const side = f.side === 'supplier' ? 'supplier' : 'inspector';
    const p = { [`${side}_confirm`]: 'confirmed', [`${side}_note`]: `Kept ${PL.short(i.inspection_date)} (decided by ${by(req)})`, proposed_date: null, updated_at: now() };
    const ni = { ...i, ...p }; p.status = IN.afterConfirm(ni); p.log = IN.withLog(i, `Kept ${PL.short(i.inspection_date)} for the ${side}`, by(req));
    await db.update('inspections', { id: i.id }, p); return ['ok', `${PL.short(i.inspection_date)} kept`];
  });
  act('confirm', async (i, f, req) => {
    const side = f.side === 'supplier' ? 'supplier' : 'inspector';
    const p = { [`${side}_confirm`]: 'confirmed', confirm_sent_at: i.confirm_sent_at || now(), updated_at: now() };
    if (side === 'inspector' && !i.supplier_confirm) p.supplier_confirm = null;
    const ni = { ...i, ...p }; p.status = IN.afterConfirm(ni); p.log = IN.withLog(i, `${side === 'inspector' ? 'Inspector' : 'Supplier'} confirmed (marked by hand)`, by(req));
    await db.update('inspections', { id: i.id }, p); return ['ok', 'Marked confirmed'];
  });
  act('send-confirm', async (i, f, req) => {
    try { await IN.sendConfirmations(db, config, { ...i, ...reset, inspector_confirm: i.inspector_confirm === 'confirmed' ? 'confirmed' : null, supplier_confirm: i.supplier_confirm === 'confirmed' ? 'confirmed' : null }, { by: by(req) }); return ['ok', 'Confirmation emails sent to the inspector and the supplier']; }
    catch (e) { return ['warn', e.message]; }
  });
  act('files', async (i, f, req, files) => {
    const list = (files.file || []).filter((x) => x.buffer?.length);
    if (!list.length) return ['warn', 'Choose a file'];
    const kind = ['Inspection report', 'Inspection invoice', 'Inspection photos', 'Inspection document'].includes(f.kind) ? f.kind : null;
    if (kind) {
      for (const x of list) { const rec = await IN.storeFile(db, i, x, kind, by(req)); if (kind === 'Inspection invoice' && !i.invoice_file_id) await db.update('inspections', { id: i.id }, { invoice_file_id: rec.id }); }
      // a report added by hand is still read by AI for the summary
      if (kind === 'Inspection report' && require('../ai').enabled()) {
        try { const r = await IN.readEmail({ text: `Inspection report for ${i.ref}, PO ${IN.posOf(i).join(', ')}`, files: list }); await db.update('inspections', { id: i.id }, { ai: { result: r.result || 'unknown', critical: IN.num(r.critical), major: IN.num(r.major), minor: IN.num(r.minor), limit_major: IN.num(r.limit_major), limit_minor: IN.num(r.limit_minor), sampled: IN.num(r.sampled), findings: r.findings || '', summary: r.summary || '', pos: r.pos || [], at: now() }, status: ['passed', 'failed'].includes(i.status) ? i.status : 'report', updated_at: now() }); } catch { /* summary optional */ }
      }
      await db.update('inspections', { id: i.id }, { log: IN.withLog(i, `${list.length} file${list.length > 1 ? 's' : ''} added (${kind.replace('Inspection ', '')})`, by(req)), updated_at: now() });
      return ['ok', 'Added'];
    }
    // detect: the same reader as the inspect@ mailbox
    const r = await IN.handleInspectionEmail({ db, config, from: by(req), subject: `${i.ref} files added by hand`, text: `Files added by ${by(req)} for ${i.ref}.`, files: list });
    return ['ok', r.matched ? `Added ${r.files} file${r.files === 1 ? '' : 's'}` : 'Added'];
  });
  act('decide', async (i, f, req) => {
    const d = await IN.decide(db, i, f.decision, { note: f.note, by: by(req) });
    return ['ok', `${i.ref}: ${d.status === 'failed' ? 'Failed — the POs are on hold' : 'Passed'}`];
  });
  act('reopen', async (i, f, req) => {
    await db.update('inspections', { id: i.id }, { status: 'report', decision: null, decided_at: null, decided_by: null, log: IN.withLog(i, 'Decision reopened', by(req)), updated_at: now() }); return ['ok', 'Decision reopened'];
  });
  act('invoice', async (i, f, req) => {
    const p = { invoice_no: String(f.invoice_no || '').trim().slice(0, 60) || null, invoice_amount: IN.num(f.invoice_amount), invoice_due: PL.isoDay(f.invoice_due), invoice_file_id: f.invoice_file_id || null, updated_at: now() };
    p.log = IN.withLog(i, `Invoice ${p.invoice_no || ''} ${p.invoice_amount != null ? IN.usd(p.invoice_amount) : ''} saved`.replace(/\s+/g, ' '), by(req));
    await db.update('inspections', { id: i.id }, p); return ['ok', 'Invoice saved'];
  });
  act('cancel', async (i, f, req) => {
    await db.update('inspections', { id: i.id }, { status: 'cancelled', log: IN.withLog(i, 'Cancelled', by(req)), updated_at: now() }); return ['ok', `${i.ref} cancelled`];
  });
  router.post(`${BASE}/:id/delete`, G(async (req, res) => {
    if (!canDel(req)) throw new HttpError(403, 'Only an Admin can delete');
    const i = await get(req.params.id);
    const files = (await IN.filesOf(db, i)).filter((f) => f.inspection_id === i.id);
    if (files.length) { await db.docs.remove(files.map((f) => f.path)).catch(() => null); for (const f of files) await db.remove('plan_files', { id: f.id }).catch(() => null); }
    await db.remove('inspections', { id: i.id });
    flash(res, 'ok', `${i.ref} deleted`); res.redirect(BASE);
  }));
};

module.exports.BASE = BASE;
module.exports.tagOf = tagOf;
