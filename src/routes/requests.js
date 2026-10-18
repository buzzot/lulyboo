'use strict';
// Information requests to suppliers (dieline files, checklists, samples, certificates, photos).
//
//   Admin ticks products on a supplier page → compose form → one email goes to the supplier (CC the team).
//   Every request has a reference (LB-1001) in the email subject. The email tells the supplier to REPLY and keep the
//   subject, so replies can be matched to the request and logged. Replies reach the log by either:
//     1. the inbound-email webhook  POST /hooks/inbound-email?key=INBOUND_EMAIL_SECRET   (see README of this file below), or
//     2. the admin pasting the reply / adding a note on the request page.

const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, readBody, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const S = require('../services');
const { sendEmail, requestEmail, REQUEST_ITEMS, emailConfigured } = require('../email');
const { guard } = require('./admin');

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const STATUSES = ['Sent', 'Replied', 'Complete', 'Closed'];
const ccList = () => (process.env.REQUEST_CC || 'marsel@lulyboo.com').split(/[,;\s]+/).filter((e) => EMAIL_RE.test(e));
const uniq = (arr) => [...new Set(arr.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
const refOf = (text) => (String(text || '').match(/\bLB-(\d{3,7})\b/i) || [])[0]?.toUpperCase() || null;
const canSend = () => emailConfigured() || process.env.EMAIL_DEV_LOG === 'true';
const pill = (st) => html`<span class="pill ${st === 'Complete' ? 's-selected' : st === 'Replied' ? 's-reviewing' : st === 'Closed' ? '' : 's-new'}">${st}</span>`;

const MAX_FILE = 20 * 1024 * 1024;
const safeName = (n) => String(n || 'file').replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_').slice(-100) || 'file';

module.exports = function requestRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  // Store one attachment in Storage and return its record for the log.
  async function saveAttachment(ref, { name, type, buffer }) {
    const rec = { filename: name || 'file', size: buffer.length, content_type: type || null };
    if (buffer.length > MAX_FILE) return { ...rec, error: 'too large to store' };
    const path = `requests/${ref}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName(name)}`;
    try { await db.storage.upload(path, buffer, type || 'application/octet-stream'); return { ...rec, path }; } catch (e) {
      console.error('Attachment save failed:', e.message); return { ...rec, error: 'could not be stored' };
    }
  }

  // Resend inbound: attachments are listed in the event; download them with the API key.
  async function fetchInboundAttachments(ref, emailId, listed) {
    const key = process.env.RESEND_API_KEY; const out = [];
    const H = { Authorization: `Bearer ${key}` };
    let items = listed || [];
    try {
      if (!items.length && emailId && key) {
        const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { headers: H, signal: AbortSignal.timeout(15000) });
        if (r.ok) { const j = await r.json(); items = j.data || j.attachments || (Array.isArray(j) ? j : []); }
      }
    } catch (e) { console.error('Attachment list failed:', e.message); }
    for (const a of items.slice(0, 10)) {
      const name = a.filename || a.name || 'file'; const type = a.content_type || a.contentType || null;
      try {
        let buffer = null;
        if (a.content) buffer = Buffer.from(a.content, 'base64');
        else {
          let url = a.download_url || a.url;
          if (!url && emailId && a.id && key) {
            const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`, { headers: H, signal: AbortSignal.timeout(15000) });
            if (r.ok) { const j = await r.json(); url = j.download_url || j.url; }
          }
          if (url) { const r = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (r.ok) buffer = Buffer.from(await r.arrayBuffer()); }
        }
        out.push(buffer ? await saveAttachment(ref, { name, type, buffer }) : { filename: name, size: a.size || null, error: 'not downloaded: open the original email' });
      } catch (e) { console.error('Attachment download failed:', e.message); out.push({ filename: name, size: a.size || null, error: 'not downloaded: open the original email' }); }
    }
    return out;
  }

  async function nextRef() {
    const rows = await db.list('info_requests', { select: 'ref' });
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r.ref).replace(/\D/g, '')) || 1000), 1000);
    return `LB-${max + 1}`;
  }

  // ── Compose (the supplier page posts the ticked product ids here)
  router.post('/admin/suppliers/:id/request', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const supplier = await db.get('suppliers', req.params.id);
    if (!supplier) throw new HttpError(404, 'Supplier not found');
    const ids = [].concat(fields.ids || []).filter(Boolean);
    if (!ids.length) { flash(res, 'warn', 'Tick at least one product first'); return res.redirect(`/admin/suppliers/${supplier.id}`); }
    const [products, users] = await Promise.all([
      db.list('products', { filters: { id: ['in', ids], supplier_id: supplier.id } }),
      db.list('supplier_users', { filters: { supplier_id: supplier.id }, order: 'created_at.asc' }),
    ]);
    if (!products.length) { flash(res, 'warn', 'No matching products'); return res.redirect(`/admin/suppliers/${supplier.id}`); }
    const recipients = uniq([supplier.email, ...users.filter((u) => u.status !== 'disabled').map((u) => u.email)].filter(Boolean));
    const cc = ccList();
    res.html(page({
      title: 'Request information', nav: adminNav('suppliers'), flash: takeFlash(req, res),
      body: html`<h1>Request information</h1>
      <p class="muted"><a href="/admin/suppliers/${supplier.id}">← ${supplier.name}</a></p>
      ${canSend() ? '' : html`<div class="flash warn">Email is not set up (no RESEND_API_KEY), so nothing can be sent.</div>`}
      <form method="post" action="/admin/suppliers/${supplier.id}/request/send" class="card">
        ${products.map((p) => html`<input type="hidden" name="ids" value="${p.id}">`)}
        <h2>Products (${products.length})</h2>
        <ul class="plain">${products.map((p) => html`<li><a href="/admin/products/${p.id}">${p.product_name}</a> <span class="sub">${p.supplier_sku || ''}</span></li>`)}</ul>
        <h2>What do you need?</h2>
        <div class="req-items">${Object.entries(REQUEST_ITEMS).map(([k, v]) => html`<label class="chk"><input type="checkbox" name="items" value="${k}"> ${v.en} <span class="sub">${v.zh}</span></label>`)}</div>
        <label><span class="lbl">Something else (optional, written in the email as a request)</span><input name="other_text" placeholder="e.g. Instruction manual in English"></label>
        <label><span class="lbl">Note to the supplier (optional)</span><textarea name="note" rows="3" placeholder="e.g. Need the dieline in AI or PDF with 3mm bleed. Deadline: ..."></textarea></label>
        <h2>Send to</h2>
        ${recipients.length ? html`<div class="req-items">${recipients.map((e) => html`<label class="chk"><input type="checkbox" name="to" value="${e}" checked> ${e}</label>`)}</div>` : html`<p class="muted">This supplier has no email on file. Add one below.</p>`}
        <label><span class="lbl">Other recipient(s), comma separated (optional)</span><input name="to_extra" placeholder="name@factory.com"></label>
        <p class="sub">CC: ${cc.join(', ') || 'none'} · The email asks the supplier to reply to it and keep the subject, so their answer is linked to this request.</p>
        <div class="form-actions"><button class="btn" data-busy ${canSend() ? '' : raw('disabled')}>Send request</button> <a class="btn ghost" href="/admin/suppliers/${supplier.id}">Cancel</a></div>
      </form>`,
    }));
  }));

  router.post('/admin/suppliers/:id/request/send', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const supplier = await db.get('suppliers', req.params.id);
    if (!supplier) throw new HttpError(404, 'Supplier not found');
    const back = `/admin/suppliers/${supplier.id}`;
    const ids = [].concat(fields.ids || []).filter(Boolean);
    const items = [].concat(fields.items || []).filter((k) => REQUEST_ITEMS[k]);
    const other = String(fields.other_text || '').trim().slice(0, 300);
    const note = String(fields.note || '').trim().slice(0, 2000);
    const to = uniq([...[].concat(fields.to || []), ...String(fields.to_extra || '').split(/[,;\s]+/)]).filter((e) => EMAIL_RE.test(e));
    const products = ids.length ? await db.list('products', { filters: { id: ['in', ids], supplier_id: supplier.id } }) : [];
    const fail = (msg) => { flash(res, 'error', msg); res.redirect(back); };
    if (!products.length) return fail('Tick at least one product first');
    if (!items.length && !other) return fail('Choose what you need from the supplier');
    if (!to.length) return fail('Add at least one recipient');
    const cc = ccList().filter((e) => !to.includes(e));
    const ref = await nextRef();
    const mail = requestEmail({ ref, companyName: supplier.contact_name || supplier.name, items, other, note, products });
    const row = await db.insert('info_requests', { ref, supplier_id: supplier.id, product_ids: products.map((p) => p.id), items, other_text: other || null, note: note || null, to_emails: to, cc_emails: cc, subject: mail.subject, status: 'Sent' });
    let sent;
    try { sent = await sendEmail(config, { to, cc, ...mail }); } catch (e) {
      await db.remove('info_requests', { id: row.id });
      return fail(`Email not sent: ${String(e.message).replace(/⟪|⟫|⟦.*?⟧/g, '')}`);
    }
    if (sent.id) await db.update('info_requests', { id: row.id }, { email_id: sent.id });
    await db.insert('info_request_messages', { request_id: row.id, direction: 'out', from_email: process.env.EMAIL_FROM || null, to_emails: to, subject: mail.subject, body: mail.text });
    await db.insert('supplier_activities', { supplier_id: supplier.id, type: 'Email', summary: `Information request ${ref} sent (${[...items.map((k) => REQUEST_ITEMS[k].en.split(' (')[0]), other].filter(Boolean).join(', ')}) for ${products.length} product(s)` }).catch(() => {});
    flash(res, 'ok', `Request ${ref} sent to ${to.join(', ')}${cc.length ? ` (CC ${cc.join(', ')})` : ''}`);
    res.redirect(`/admin/requests/${row.id}`);
  }));

  // ── List and detail
  router.get('/admin/requests', G(async (req, res) => {
    const [rows, suppliers] = await Promise.all([db.list('info_requests', { order: 'created_at.desc', limit: 300 }), db.list('suppliers', { select: 'id,name' })]);
    const name = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
    const st = req.query.status;
    const list = st ? rows.filter((r) => r.status === st) : rows;
    res.html(page({
      title: 'Requests', nav: adminNav('requests'), flash: takeFlash(req, res), wide: true,
      body: html`<h1>Information requests</h1>
      <p class="muted">Send them from a supplier page: tick products, then “Request information”. Replies are tracked by the reference in the subject line.</p>
      <p>${['', ...STATUSES].map((s) => html`<a class="btn small ${(st || '') === s ? '' : 'ghost'}" href="/admin/requests${s ? `?status=${s}` : ''}">${s || 'All'}</a> `)}</p>
      <div class="table-wrap"><table class="list"><thead><tr><th>Ref</th><th>Supplier</th><th>Requested</th><th class="r">Products</th><th>Status</th><th>Sent</th></tr></thead>
      <tbody>${list.length ? list.map((r) => html`<tr><td><a href="/admin/requests/${r.id}"><b>${r.ref}</b></a></td><td><a href="/admin/suppliers/${r.supplier_id}">${name[r.supplier_id] || '—'}</a></td>
        <td>${[...(r.items || []).map((k) => REQUEST_ITEMS[k]?.en.split(' (')[0]), r.other_text].filter(Boolean).join(', ')}</td><td class="r">${(r.product_ids || []).length}</td><td>${pill(r.status)}</td><td>${fmt.date(r.created_at)}</td></tr>`) : html`<tr><td colspan="6" class="muted">No requests yet.</td></tr>`}</tbody></table></div>`,
    }));
  }));

  router.get('/admin/requests/:id', G(async (req, res) => {
    const r = await db.get('info_requests', req.params.id);
    if (!r) throw new HttpError(404, 'Request not found');
    const [supplier, msgs, products] = await Promise.all([
      db.get('suppliers', r.supplier_id),
      db.list('info_request_messages', { filters: { request_id: r.id }, order: 'created_at.asc' }),
      (r.product_ids || []).length ? db.list('products', { filters: { id: ['in', r.product_ids] } }) : [],
    ]);
    const urls = await db.storage.signedUrls(msgs.flatMap((m) => (m.attachments || []).map((a) => a.path)), 3600);
    const attLinks = (m) => (m.attachments || []).length ? html`<div class="sub">Attachments: ${m.attachments.map((a) => (a.path && urls[a.path] ? html`<a href="${urls[a.path]}" download="${a.filename}">${a.filename}</a> ` : html`${a.filename}${a.error ? ` (${a.error})` : ''} `))}</div>` : '';
    res.html(page({
      title: r.ref, nav: adminNav('requests'), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><div><h1>${r.ref} ${pill(r.status)}</h1>
        <p class="muted"><a href="/admin/suppliers/${r.supplier_id}">${supplier?.name || 'Supplier'}</a> · sent ${fmt.date(r.created_at)} to ${(r.to_emails || []).join(', ')}${(r.cc_emails || []).length ? ` · CC ${r.cc_emails.join(', ')}` : ''}</p></div>
        <form method="post" action="/admin/requests/${r.id}/status" class="inline-form"><select name="status">${STATUSES.map((s) => html`<option ${s === r.status ? raw('selected') : ''}>${s}</option>`)}</select><button class="btn small">Update status</button></form></div>
      <div class="cols">
        <section class="card"><h2>What was requested</h2>
          <ul class="plain">${(r.items || []).map((k) => html`<li>${REQUEST_ITEMS[k]?.en || k} <span class="sub">${REQUEST_ITEMS[k]?.zh || ''}</span></li>`)}${r.other_text ? html`<li>${r.other_text}</li>` : ''}</ul>
          ${r.note ? html`<p><b>Note:</b> ${r.note}</p>` : ''}
          <h3>Products</h3><ul class="plain">${products.map((p) => html`<li><a href="/admin/products/${p.id}">${p.product_name}</a> <span class="sub">${p.supplier_sku || ''}</span></li>`)}</ul>
          <p class="sub">Subject: ${r.subject}</p></section>
        <section class="card"><h2>Add to the log</h2>
          <p class="muted">Replies are logged automatically when the inbound-email webhook is set up. Otherwise paste the reply here, or add a note (for example “dieline received by WeChat”).</p>
          <form method="post" enctype="multipart/form-data" action="/admin/requests/${r.id}/log" class="grid">
            <label><span class="lbl">Type</span><select name="direction"><option value="in">Reply from supplier</option><option value="note">Internal note</option></select></label>
            <label><span class="lbl">Mark as</span><select name="status"><option value="">Keep status</option><option>Replied</option><option>Complete</option><option>Closed</option></select></label>
            <label class="span2"><span class="lbl">Text</span><textarea name="body" rows="4" placeholder="Paste the reply, or describe what was received"></textarea></label>
            <label class="span2"><span class="lbl">Attach files (optional, up to 20 MB each)</span><input type="file" name="files" multiple></label>
            <div class="span2"><button class="btn small">Save to log</button></div></form></section>
      </div>
      <section class="card"><h2>Communication log</h2>
        ${msgs.length ? html`<ul class="feed req-log">${msgs.map((m) => html`<li class="${m.direction}"><span class="date">${fmt.date(m.created_at)}</span> <b>${m.direction === 'out' ? 'Sent to supplier' : m.direction === 'in' ? `Reply${m.from_email ? ` from ${m.from_email}` : ''}` : 'Note'}</b>
          ${m.subject ? html`<div class="sub">${m.subject}</div>` : ''}
          <div class="req-body">${m.body || ''}</div>
          ${attLinks(m)}</li>`)}</ul>` : html`<p class="muted">Nothing logged yet.</p>`}
      </section>`,
    }));
  }));

  router.post('/admin/requests/:id/status', G(async (req, res) => {
    const { fields } = await parseForm(req);
    if (!STATUSES.includes(fields.status)) throw new HttpError(400, 'Invalid status');
    await db.update('info_requests', { id: req.params.id }, { status: fields.status, updated_at: new Date().toISOString() });
    flash(res, 'ok', `Status: ${fields.status}`);
    res.redirect(`/admin/requests/${req.params.id}`);
  }));

  router.post('/admin/requests/:id/log', G(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const r = await db.get('info_requests', req.params.id);
    if (!r) throw new HttpError(404, 'Request not found');
    const body = String(fields.body || '').trim().slice(0, 20000);
    const uploads = (files.files || []).slice(0, 10);
    if (!body && !uploads.length) { flash(res, 'warn', 'Write something or attach a file first'); return res.redirect(`/admin/requests/${r.id}`); }
    const direction = fields.direction === 'in' ? 'in' : 'note';
    const attachments = [];
    for (const f of uploads) attachments.push(await saveAttachment(r.ref, f));
    await db.insert('info_request_messages', { request_id: r.id, direction, body: body || null, attachments });
    const status = STATUSES.includes(fields.status) ? fields.status : direction === 'in' && r.status === 'Sent' ? 'Replied' : r.status;
    await db.update('info_requests', { id: r.id }, { status, updated_at: new Date().toISOString() });
    flash(res, 'ok', 'Saved to the log');
    res.redirect(`/admin/requests/${r.id}`);
  }));

  // ── Inbound email webhook: links a supplier's reply to its request by the LB-xxxx reference.
  //    Set INBOUND_EMAIL_SECRET and point your inbound-email provider (e.g. Resend inbound) at
  //    https://<your-site>/hooks/inbound-email?key=<secret>. Accepts Resend's `email.received` event, or a plain JSON
  //    {from, to, subject, text, html, attachments}. Resend sends only metadata, so the body is fetched by id.
  router.post('/hooks/inbound-email', async (req, res) => {
    const secret = process.env.INBOUND_EMAIL_SECRET;
    const given = String(req.query.key || '');
    const ok = secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) return res.json({ error: 'not found' }, 404);
    let payload;
    try { payload = JSON.parse((await readBody(req, 5_000_000)).toString('utf8')); } catch { return res.json({ error: 'bad json' }, 400); }
    const d = payload.data || payload;
    const from = typeof d.from === 'string' ? d.from : d.from?.email || d.from?.address || '';
    const toList = [].concat(d.to || []).map((x) => (typeof x === 'string' ? x : x?.email || x?.address || ''));
    const subject = String(d.subject || '');
    const ref = refOf(subject) || toList.map(refOf).find(Boolean) || refOf(d.text) || null;
    const r = ref ? (await db.list('info_requests', { filters: { ref } }))[0] : null;
    if (!r) return res.json({ ok: true, matched: false }, 202);
    let text = d.text || ''; let htmlBody = d.html || '';
    if (!text && !htmlBody && d.email_id && process.env.RESEND_API_KEY) {
      try {
        const rr = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000) });
        if (rr.ok) { const j = await rr.json(); text = j.text || ''; htmlBody = j.html || ''; }
      } catch (e) { console.error('Inbound body fetch failed:', e.message); }
    }
    const body = (text || String(htmlBody).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim().slice(0, 20000) || '(no text: open the original email)';
    const attachments = await fetchInboundAttachments(r.ref, d.email_id || d.id, d.attachments);
    await db.insert('info_request_messages', { request_id: r.id, direction: 'in', from_email: from, to_emails: toList, subject, body, attachments });
    await db.update('info_requests', { id: r.id }, { status: r.status === 'Sent' ? 'Replied' : r.status, updated_at: new Date().toISOString() });
    res.json({ ok: true, matched: true, ref });
  });
};
