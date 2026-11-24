'use strict';
// Catalog → Categories → factory checklist of each category, imported from the Lulyboo Excel template.
//   POST /admin/categories/import                  several "Factory Checklist - <Category>.xlsx" at once (missing categories are created)
//   GET  /admin/categories/:id/checklist           the questions by section (type · required)
//   POST /admin/categories/:id/checklist           replace with a new Excel (new version)
//   GET  /admin/categories/:id/checklist-file      the original Excel
// Read exactly, no AI. Projects copy the checklist when their category is set; a newer version shows "Update" on the project.

const crypto = require('node:crypto');
const { html, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const CK = require('../checklists');
const S = require('../services');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xlsx': XLSX };
const extOf = (n) => (String(n).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
const typeTag = (it) => html`<span class="t t-${it.type}">${it.type === 'choice' || it.type === 'multi' ? `${it.type === 'multi' ? 'Several: ' : ''}${it.options.map(CK.optLabel).slice(0, 6).join(' · ')}${it.options.length > 6 ? ' …' : ''}` : CK.TYPES[it.type]}</span>`;
const reqTag = (it) => html`<span class="rq rq-${it.req}">${it.req_label}</span>`;

function serveFile(res, buf, f, inline) {
  const ok = inline && /\.(pdf|png|jpe?g|webp|txt)$/i.test(f.name);
  res.statusCode = 200; res.setHeader('Content-Type', (ok && MIME[extOf(f.name)]) || f.mime || MIME[extOf(f.name)] || 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (ok) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', /\.pdf$/i.test(f.name) ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; frame-ancestors 'self'"); }
  res.setHeader('Content-Disposition', `${ok ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`); res.end(buf);
}

module.exports = function categoryChecklists(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const load = async (id) => { const c = await db.get('categories', id); if (!c) throw new HttpError(404, 'Category not found'); return c; };
  const base = (c) => `/admin/categories/${c.id}/checklist`;
  const fileName = (f) => String(f.name || 'checklist.xlsx').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150);

  /** Save one Excel onto a category: { version, count, same } */
  async function apply(c, f, parsed) {
    const items = parsed.items;
    if (JSON.stringify(CK.normItems(c.checklist)) === JSON.stringify(items) && c.checklist_file) return { same: true, count: items.length, version: c.checklist_version || 0 };
    const path = `checklists/${c.id}/${crypto.randomUUID()}.xlsx`;
    await db.docs.upload(path, f.buffer, XLSX);
    const version = (c.checklist_version || 0) + 1;
    await db.update('categories', { id: c.id }, { checklist: items, checklist_file: { name: fileName(f), path, mime: XLSX, bytes: f.buffer.length, at: new Date().toISOString() }, checklist_version: version });
    Object.assign(c, { checklist: items, checklist_version: version });
    return { version, count: items.length };
  }

  router.post('/admin/categories/import', G(async (req, res) => {
    const { files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const list = [].concat(files?.files || []).filter((f) => f?.buffer?.length);
    if (!list.length) { flash(res, 'warn', 'Choose the factory checklist Excel files'); return res.redirect('/admin/categories'); }
    const cats = await db.list('categories', { order: 'sort.asc,name.asc' }); const done = []; const errors = [];
    for (const f of list) {
      if (extOf(f.name) !== '.xlsx') { errors.push(`${fileName(f)}: not an .xlsx file`); continue; }
      let parsed; try { parsed = CK.parseFactoryChecklist(f.buffer, f.name); } catch (e) { errors.push(`${fileName(f)}: ${e.message}`); continue; }
      if (!parsed.category) { errors.push(`${fileName(f)}: no category in the title or file name`); continue; }
      let c = cats.find((x) => x.name.trim().toLowerCase() === parsed.category.toLowerCase()); let created = false;
      if (!c) { c = await db.insert('categories', { name: parsed.category, sort: cats.length + 1 }); cats.push(c); created = true; }
      const r = await apply(c, f, parsed);
      done.push(`${c.name}${created ? ' (new)' : ''}: ${r.count} questions${r.same ? ', unchanged' : ` · v${r.version}`}`);
    }
    S.invalidate('ctx');
    flash(res, errors.length ? 'warn' : 'ok', [done.length ? `Imported ${done.length} checklist${done.length === 1 ? '' : 's'}: ${done.join(' · ')}` : '', ...errors].filter(Boolean).join(' · '));
    res.redirect('/admin/categories');
  }));

  router.get('/admin/categories/:id/checklist', G(async (req, res) => {
    const c = await load(req.params.id);
    const items = CK.normItems(c.checklist); const secs = CK.sections(items);
    const projects = (await db.list('dev_projects').catch(() => [])).filter((p) => p.category_id === c.id && !['Completed', 'Cancelled'].includes(p.status));
    const behind = projects.filter((p) => (p.checklist_version || 0) < (c.checklist_version || 0)).length;
    const n = (t) => items.filter((x) => x.type === t).length;
    res.html(page({
      title: `${c.name} · factory checklist`, nav: adminNav('categories'), flash: takeFlash(req, res), wide: true,
      body: html`<nav class="crumb"><a href="/admin/categories">Categories</a></nav>
      <div class="head-row"><div><h1>${c.name} · factory checklist</h1><ul class="pp-meta"><li>v${c.checklist_version || 0}</li><li>${items.length} questions</li><li>${items.filter((x) => x.req === 'required').length} required</li><li>${n('file')} file uploads</li><li>${projects.length} open project${projects.length === 1 ? '' : 's'}${behind ? html` · <span class="warn-text">${behind} on an older version</span>` : ''}</li></ul></div>
        ${c.checklist_file ? html`<div class="actions"><a class="btn ghost small" href="/admin/categories/${c.id}/checklist-file" download>Download Excel</a></div>` : ''}</div>
      <section class="card"><h2 class="sec">${items.length ? 'Replace with a new version' : 'Import the Excel'}</h2>
        <form method="post" enctype="multipart/form-data" action="${base(c)}" class="ck-drop"><div class="mdrop small" data-filebox data-max="1"><div class="mdrop-box"><input type="file" name="file" accept=".xlsx" required title="" aria-label="Factory checklist Excel"><span class="dz-main" data-main>Drop the Excel here, paste (⌘V) or <u>choose</u></span><span class="dz-hint">Factory Checklist .xlsx</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div><div class="form-actions"><button class="btn small" data-busy>Import</button></div></form>
        <p class="sub">The Lulyboo factory checklist template (.xlsx), read exactly: sections, questions, dropdown answers and required levels. Edit the Excel and import it again to change questions; projects then get an Update button. Pricing, MOQ and lead times are asked in the quote form.</p></section>
      ${secs.length ? html`<section class="card">${secs.map((s) => html`<details class="ck-sec" open><summary><b>${s.title}</b> <span class="count">${s.rows.length}</span></summary>
        <table class="list compact ck-q"><tbody>${s.rows.map((it) => html`<tr><td>${it.name}${it.hint ? html`<div class="sub">${it.hint}</div>` : ''}</td><td>${typeTag(it)}</td><td class="r">${reqTag(it)}</td></tr>`)}</tbody></table></details>`)}</section>` : html`<p class="d-empty">No checklist yet.</p>`}
      ${c.checklist_file ? html`<p class="sub">File: ${c.checklist_file.name} · imported ${fmt.date(c.checklist_file.at)}</p>` : ''}`,
    }));
  }));

  router.post('/admin/categories/:id/checklist', G(async (req, res) => {
    const c = await load(req.params.id);
    const { files } = await parseForm(req, { limitBytes: 25 * 1024 * 1024 });
    const f = [].concat(files?.file || [])[0];
    if (!f?.buffer?.length || extOf(f.name) !== '.xlsx') { flash(res, 'error', 'Choose the factory checklist .xlsx file'); return res.redirect(base(c)); }
    let parsed; try { parsed = CK.parseFactoryChecklist(f.buffer, f.name); } catch (e) { flash(res, 'error', e.message); return res.redirect(base(c)); }
    const r = await apply(c, f, parsed); S.invalidate('ctx');
    flash(res, 'ok', r.same ? 'Same questions as before: nothing changed' : `Checklist v${r.version} imported: ${r.count} questions`);
    res.redirect(base(c));
  }));

  router.get('/admin/categories/:id/checklist-file', G(async (req, res) => {
    const c = await load(req.params.id); if (!c.checklist_file?.path) throw new HttpError(404, 'No checklist file');
    serveFile(res, await db.docs.download(c.checklist_file.path), c.checklist_file, req.query.inline === '1');
  }));
};
module.exports.serveFile = serveFile;
module.exports.typeTag = typeTag;
module.exports.reqTag = reqTag;
