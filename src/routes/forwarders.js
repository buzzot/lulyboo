'use strict';
// Logistics → Forwarders: the freight forwarders we ask for container quotations.

const { html, raw, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const SCR = require('./schedules');

const BASE = '/admin/logistics/forwarders';
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emails = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const missing = (e) => /forwarders|plan_quotes|PGRST205|relation/i.test(e?.message || '');

/** Clean form fields → row, or throws. */
function rowFrom(f) {
  const company = String(f.company || '').trim().slice(0, 160);
  const email = emails(f.email);
  const cc = emails(f.cc);
  if (!company) throw new HttpError(400, 'Company name is required');
  if (!email.length) throw new HttpError(400, 'Email is required');
  const bad = [...email, ...cc].find((e) => !EMAIL_RE.test(e));
  if (bad) throw new HttpError(400, `Check this email address: ${bad}`);
  return { company, contact_name: String(f.contact_name || '').trim().slice(0, 120) || null, email: email.join(', ').toLowerCase(), cc: cc.join(', ').toLowerCase() || null, phone: String(f.phone || '').trim().slice(0, 60) || null, notes: String(f.notes || '').trim().slice(0, 1000) || null };
}

module.exports = function forwarderRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const now = () => new Date().toISOString();
  const wantsJson = (req) => /json/.test(req.headers.accept || '');

  router.get(BASE, G(async (req, res) => {
    let rows = []; let noTable = false;
    try { rows = await db.list('forwarders', { order: 'company.asc' }); } catch (e) { if (missing(e)) noTable = true; else throw e; }
    const quotes = await db.list('plan_quotes', { order: 'created_at.desc' }).catch(() => []);
    const stat = (id) => { const qs = quotes.filter((q) => q.forwarder_id === id); return { n: qs.length, replied: qs.filter((q) => q.replied_at).length, won: qs.filter((q) => q.status === 'chosen').length, last: qs[0]?.sent_at }; };
    const field = (name, label, v, extra = '') => html`<label>${label} <input name="${name}" value="${v || ''}" ${raw(extra)}></label>`;
    const form = (r = {}) => html`<div class="fw-form">${field('company', 'Company', r.company, 'required')}${field('contact_name', 'Contact person', r.contact_name, 'placeholder="e.g. Ms. Lily Chen"')}${field('email', 'Email', r.email, 'required placeholder="sales@forwarder.com"')}${field('cc', 'CC', r.cc, 'placeholder="optional, comma separated"')}${field('phone', 'Phone / WeChat', r.phone)}${field('notes', 'Notes', r.notes, 'placeholder="e.g. strong on Ningbo, NVOCC"')}</div>`;
    res.html(page({
      title: 'Forwarders · Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`${SCR.logisticsTabs('forwarders')}
        ${noTable ? html`<p class="flash warn">Run the forwarders SQL in Supabase first (supabase/schema.sql, "Forwarders you ask for quotes").</p>` : ''}
        <div class="cp-head"><div><h2 class="sl-title">Forwarders</h2><p class="muted">Freight forwarders you ask for container quotations. Pick them in Container planning → Load containers → Request quotes.</p></div></div>
        <section class="card"><h2 class="sec">Add a forwarder</h2><form method="post" action="${BASE}">${form()}<button class="btn">Add forwarder</button></form></section>
        <section class="card flush"><div class="table-wrap"><table class="list fw-table"><thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th class="r">Requests</th><th class="r">Replied</th><th class="r">Chosen</th><th></th></tr></thead>
          <tbody>${rows.map((r) => { const s = stat(r.id); return html`<tr class="${r.active === false ? 'done' : ''}"><td><b>${r.company}</b>${r.notes ? html`<div class="sub">${r.notes}</div>` : ''}</td><td>${r.contact_name || '—'}</td><td>${r.email}${r.cc ? html`<div class="sub">cc ${r.cc}</div>` : ''}</td><td>${r.phone || '—'}</td>
            <td class="r">${s.n || '—'}${s.last ? html`<div class="sub">last ${fmt.date(s.last)}</div>` : ''}</td><td class="r">${s.n ? `${s.replied}` : '—'}</td><td class="r">${s.won || '—'}</td>
            <td class="fw-acts"><details><summary class="link small">Edit</summary><form method="post" action="${BASE}/${r.id}">${form(r)}<label class="cp-chk"><input type="checkbox" name="active" value="1" ${r.active !== false ? raw('checked') : ''}> Active (shown when requesting quotes)</label><button class="btn small">Save</button></form></details>
              <form method="post" action="${BASE}/${r.id}/delete" class="inline" onsubmit="return confirm('Delete this forwarder? Past quotes are kept.')"><button class="icon-btn" title="Delete" aria-label="Delete ${r.company}">×</button></form></td></tr>`; })}</tbody></table></div>
          ${rows.length ? '' : html`<p class="muted or-empty">No forwarders yet. Add the companies you ask for quotes.</p>`}</section>`,
    }));
  }));

  router.post(BASE, G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    try {
      const r = await db.insert('forwarders', { ...rowFrom(f), active: true, created_at: now(), updated_at: now() });
      if (wantsJson(req)) return res.json({ ok: true, forwarder: { id: r.id, company: r.company, contact: r.contact_name || '', email: r.email, sent: false } });
      flash(res, 'ok', `${r.company} added`);
    } catch (e) {
      if (wantsJson(req)) return res.json({ ok: false, error: missing(e) ? 'Run the forwarders SQL in Supabase first.' : e.message }, 400);
      if (!(e instanceof HttpError)) throw e;
      flash(res, 'error', e.message);
    }
    res.redirect(BASE);
  }));

  router.post(`${BASE}/:id`, G(async (req, res) => {
    const r = await db.get('forwarders', req.params.id).catch(() => null); if (!r) throw new HttpError(404, 'Forwarder not found');
    const { fields: f } = await parseForm(req);
    try { await db.update('forwarders', { id: r.id }, { ...rowFrom(f), active: f.active === '1', updated_at: now() }); flash(res, 'ok', 'Saved'); }
    catch (e) { if (!(e instanceof HttpError)) throw e; flash(res, 'error', e.message); }
    res.redirect(BASE);
  }));

  router.post(`${BASE}/:id/delete`, G(async (req, res) => {
    await db.remove('forwarders', { id: req.params.id });
    flash(res, 'ok', 'Forwarder deleted');
    res.redirect(BASE);
  }));
};
