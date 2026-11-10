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
const tg = require('../telegram');
const C = require('../crm');
const AI = require('../ai');
const RS = require('../req-summary');
const when = (iso) => { if (!iso) return ''; let txt = iso; try { txt = new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' }); } catch {} return html`<time class="sub" datetime="${iso}" data-local>${txt}</time>`; };

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const STATUSES = ['Sent', 'Replied', 'Complete', 'Closed'];
const ccList = () => (process.env.REQUEST_CC || 'marsel@lulyboo.com').split(/[,;\s]+/).filter((e) => EMAIL_RE.test(e));
const uniq = (arr) => [...new Set(arr.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
const refOf = (text) => (String(text || '').match(/\bLB-(\d{3,7})\b/i) || [])[0]?.toUpperCase() || null;
// Which request does an incoming email belong to? 1) an LB-#### reference anywhere; 2) otherwise the sender:
// an open request to that address (or, for a company domain, to that supplier), preferring a matching subject.
const FREE_MAIL = /@(gmail|qq|163|126|outlook|hotmail|yahoo|foxmail|sina|aliyun|icloud)\./i;
const normSubj = (x) => String(x || '').replace(/\[[^\]]*\]/g, ' ').replace(/^\s*((re|fw|fwd|aw|回复|答复|转发)\s*[:：]\s*)+/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function findRequest(db, { subject = '', toList = [], text = '', from = '' }) {
  const ref = refOf(subject) || toList.map(refOf).find(Boolean) || refOf(text) || null;
  if (ref) { const r = (await db.list('info_requests', { filters: { ref } }))[0]; if (r) return { r, how: 'ref' }; }
  const email = (String(from).match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase();
  if (!email) return null;
  const dom = FREE_MAIL.test(email) ? null : email.split('@')[1];
  const open = (await db.list('info_requests', { order: 'created_at.desc' })).filter((x) => !['Complete', 'Closed'].includes(x.status));
  const suppliers = new Map();
  const supplierOf = async (id) => { if (!id) return null; if (!suppliers.has(id)) suppliers.set(id, await db.get('suppliers', id).catch(() => null)); return suppliers.get(id); };
  const hits = [];
  for (const x of open) {
    const sent = (x.to_emails || []).map((e) => String(e).toLowerCase());
    const s = await supplierOf(x.supplier_id);
    const known = [...sent, String(s?.email || '').toLowerCase(), String(x.contact || '').toLowerCase()];
    if (known.some((k) => k.includes(email)) || (dom && known.some((k) => k.endsWith(`@${dom}`) || k.includes(`@${dom}`)))) hits.push(x);
  }
  if (!hits.length) return null;
  const ns = normSubj(subject);
  const bySubject = ns ? hits.filter((x) => { const t = normSubj(x.subject); return t && (t === ns || t.includes(ns) || ns.includes(t)); }) : [];
  if (bySubject.length) return { r: bySubject[0], how: 'sender+subject' };
  return hits.length === 1 ? { r: hits[0], how: 'sender' } : { r: hits[0], how: 'sender-latest' };
}

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
    // Documents bucket: any file type up to 25 MB (the image bucket only accepts the portal's own WebP photos).
    try { await db.docs.upload(path, buffer, type || 'application/octet-stream'); return { ...rec, path, bucket: 'docs' }; } catch (e) {
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
      <p class="muted">Send them from a supplier page: tick products, then “Request information”. Replies are tracked by the reference in the subject line. RFQs recorded by Hermes appear here too (<a href="/admin/api-log">integration log</a>).</p>
      <p>${['', ...STATUSES].map((s) => html`<a class="btn small ${(st || '') === s ? '' : 'ghost'}" href="/admin/requests${s ? `?status=${s}` : ''}">${s || 'All'}</a> `)}</p>
      <div class="table-wrap"><table class="list reqs"><thead><tr><th>Ref</th><th>Supplier</th><th>Requested</th><th class="r">Products</th><th>Status</th><th>Sent</th></tr></thead>
      <tbody>${list.length ? list.map((r) => html`<tr><td><a href="/admin/requests/${r.id}"><b>${r.ref}</b></a></td><td><a href="/admin/suppliers/${r.supplier_id}">${name[r.supplier_id] || '—'}</a></td>
        <td title="${r.kind === 'rfq' ? (r.subject || '') : ''}">${r.kind === 'rfq' ? html`<span class="pill s-new">RFQ${r.channel ? ' · ' + r.channel : ''}</span> ${r.subject}` : [...(r.items || []).map((k) => REQUEST_ITEMS[k]?.en.split(' (')[0]), r.other_text].filter(Boolean).join(', ')}</td><td class="r">${(r.product_ids || []).length}</td><td>${pill(r.status)}</td><td>${fmt.date(r.created_at)}</td></tr>`) : html`<tr><td colspan="6" class="muted">No requests yet.</td></tr>`}</tbody></table></div>`,
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
    const urls = await db.storage.signedUrls(msgs.flatMap((m) => (m.attachments || []).filter((a) => a.bucket !== 'docs').map((a) => a.path)), 3600).catch(() => ({}));
    for (const m of msgs) (m.attachments || []).forEach((a, i) => { if (a.bucket === 'docs' && a.path) urls[a.path] = `/admin/request-files/${m.id}/${i}`; });
    const aiPending = RS.ensureSummaries(db, msgs, { request: r, supplierName: supplier?.name });
    const KIND = { out: ['Sent to supplier', 'out'], in: ['Reply from supplier', 'in'], note: ['Internal note', 'note'] };
    const files = (m) => (m.attachments || []).length ? html`<div class="clog-files">${m.attachments.map((a) => (a.path && urls[a.path] ? html`<a class="att-chip" href="${urls[a.path]}" download="${a.filename}">📎 ${a.filename}</a>` : html`<span class="att-chip off">📎 ${a.filename}${a.error ? ` (${a.error})` : ''}</span>`))}</div>` : '';
    const fallback = (t) => { const paras = String(t || '').trim().split(/\n{2,}/).filter(Boolean); return html`<div class="clog-text ${String(t || '').length > 480 ? 'clamp' : ''}">${paras.map((x) => html`<p>${x}</p>`)}</div>${String(t || '').length > 480 ? html`<button type="button" class="link small" data-more>Show more</button>` : ''}`; };
    // One odd message must never break the whole page: fall back to its plain text.
    const safeEntry = (m) => { try { return logEntry(m); } catch (e) { console.error('Log entry render failed', m.id, e.message); return html`<li class="clog-item"><div class="clog-head"><span class="clog-kind">${m.direction || 'note'}</span>${when(m.created_at)}</div>${fallback(m.original || m.body)}</li>`; } };
    const latestIn = [...msgs].reverse().find((m) => m.direction === 'in');
    const logEntry = (m) => {
      const [label, cls] = KIND[m.direction] || KIND.note; const a = RS.normalize(m.ai);
      const from = m.direction === 'out' ? (m.from_email || process.env.EMAIL_FROM || 'Lulyboo') : m.from_email || (m.direction === 'note' ? m.author || 'Lulyboo' : supplier?.name || 'Supplier');
      const toList = RS.arr(m.to_emails).map(RS.str);
      const to = (toList.length ? toList : m.direction === 'out' ? [...new Set([...RS.arr(r.to_emails).map(RS.str), ...(r.contact && /@/.test(r.contact) ? [r.contact] : [])])] : m.direction === 'in' ? ['Lulyboo'] : []).join(', ');
      const original = m.original || m.body || '';
      return html`<li class="clog-item ${cls}"><div class="clog-head"><span class="clog-kind ${cls}">${label}</span>${when(m.created_at)}${m.author && m.direction === 'note' ? html`<span class="sub">by ${m.author}</span>` : ''}${a ? html`<span class="ai-badge" title="Summarised by AI from the original">✨ AI summary</span>` : ''}</div>
        <h3 class="clog-title">${a?.headline || m.subject || label}</h3>
        ${latestIn && m.id === latestIn.id ? html`<button type="button" class="btn small rp-open" data-draft-reply="/admin/requests/${r.id}/draft-reply" ${AI.enabled() ? '' : raw('disabled title="Set ANTHROPIC_API_KEY to draft replies"')}>✉ Draft reply with AI</button>` : ''}
        ${a ? html`${a.summary ? html`<p class="clog-sum">${a.summary}</p>` : ''}
          ${(a.facts || []).length ? html`<dl class="clog-facts">${a.facts.map((f) => html`<div><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>` : ''}
          ${(a.sections || []).length ? html`<div class="clog-secs">${a.sections.filter((x) => (x.items || []).length).map((x) => html`<section><h4>${x.title}</h4><ul>${x.items.map((v) => html`<li>${v}</li>`)}</ul></section>`)}</div>` : ''}
          ${(a.open_questions || []).length || (a.commitments || []).length ? html`<ul class="em-points">${(a.open_questions || []).map((v) => html`<li><span class="em-tag q">Open question</span>${v}</li>`)}${(a.commitments || []).map((v) => html`<li><span class="em-tag c">Commitment</span>${v}</li>`)}</ul>` : ''}` : fallback(m.body)}
        ${files(m)}
        ${original ? html`<details class="clog-orig"><summary>${m.direction === 'note' ? 'Show full note' : 'Show original email'}${a?.language && a.language !== 'English' ? ` (${a.language})` : ''}</summary>
          <dl class="mail-head">${m.direction !== 'note' ? html`<div><dt>From</dt><dd>${from}</dd></div><div><dt>To</dt><dd>${to || '—'}</dd></div>` : ''}${m.subject ? html`<div><dt>Subject</dt><dd>${m.subject}</dd></div>` : ''}<div><dt>Date</dt><dd>${when(m.created_at)}</dd></div></dl>
          <pre>${original}</pre>
          ${AI.enabled() && original.length >= 60 ? html`<form method="post" action="/admin/requests/${r.id}/messages/${m.id}/summarize" class="inline"><button class="link small">${a ? 'Summarise again' : 'Summarise with AI'}</button></form>` : ''}</details>` : ''}</li>`;
    };
    const attLinks = (m) => (m.attachments || []).length ? html`<div class="sub">Attachments: ${m.attachments.map((a) => (a.path && urls[a.path] ? html`<a href="${urls[a.path]}" download="${a.filename}">${a.filename}</a> ` : html`${a.filename}${a.error ? ` (${a.error})` : ''} `))}</div>` : '';
    res.html(page({
      title: r.ref, nav: adminNav('requests'), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><div><h1>${r.ref} ${pill(r.status)}</h1>
        <p class="muted"><a href="/admin/suppliers/${r.supplier_id}">${supplier?.name || 'Supplier'}</a> · sent ${fmt.date(r.created_at)}${r.kind === 'rfq' ? html` as RFQ${r.channel ? ' via ' + r.channel : ''}` : ''}${(() => {
          // Show the recipient once: the To list if there is one, otherwise the RFQ contact (skip it if it is already in the list).
          const tos = r.to_emails || [];
          const contact = r.kind === 'rfq' && r.contact && !/\[object Object\]/.test(r.contact) && !tos.some((e) => String(e).toLowerCase() === String(r.contact).toLowerCase()) ? [r.contact] : [];
          const all = [...contact, ...tos];
          return all.length ? ' to ' + all.join(', ') : '';
        })()}${(r.cc_emails || []).length ? ` · CC ${r.cc_emails.join(', ')}` : ''}</p></div>
        <form method="post" action="/admin/requests/${r.id}/status" class="inline-form"><select name="status">${STATUSES.map((s) => html`<option ${s === r.status ? raw('selected') : ''}>${s}</option>`)}</select><button class="btn small">Update status</button></form></div>
      <div class="cols">
        <section class="card"><h2>What was requested</h2>
          ${r.kind === 'rfq' ? html`<p>${r.subject}</p>` : ''}
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
            <div class="span2"><span class="lbl">Attach files (optional)</span>
              <label class="dropzone compact" data-multidrop>
                <input type="file" name="files" multiple>
                <span class="dz-icon" aria-hidden="true">⬆</span>
                <span class="dz-main">Drag &amp; drop files here, or <u>choose files</u></span>
                <span class="dz-hint">You can also paste (Ctrl/⌘+V) a copied file or screenshot · up to 10 files · 20 MB each</span>
              </label>
              <ul class="dz-list" data-multilist></ul><p class="dz-note" data-multinote></p></div>
            <div class="span2"><button class="btn small">Save to log</button></div></form></section>
      </div>
      <section class="card"><div class="head-row"><h2>Communication log</h2>${aiPending ? html`<span class="ai-wait" data-ai-wait="/admin/requests/${r.id}/ai-status">✨ Preparing AI summaries…</span>` : ''}</div>
        ${RS.isColumnMissing() ? html`<p class="flash warn">AI summaries can't be saved yet: run the request-log SQL in Supabase (<code>alter table public.info_request_messages add column if not exists ai jsonb;</code>).</p>` : ''}
        ${msgs.length ? html`<ol class="clog">${msgs.map((m) => safeEntry(m)).reverse()}</ol>` : html`<p class="muted">Nothing logged yet.</p>`}
      </section>
      <dialog class="rp-modal" data-reply-modal aria-labelledby="rp-title">
        <form method="post" action="/admin/requests/${r.id}/reply" enctype="multipart/form-data" data-busy>
          <div class="rp-top"><h2 id="rp-title">Reply to supplier</h2><button type="button" class="icon-btn" data-reply-close aria-label="Close">×</button></div>
          <p class="sub rp-ctx" data-reply-ctx></p>
          <div class="rp-loading" data-reply-loading>✨ Reading the thread and drafting a reply…</div>
          <p class="flash error" data-reply-error hidden></p>
          <div class="rp-fields" data-reply-fields hidden>
            <label>To<input name="to" data-f="to" required></label>
            <label>CC<input name="cc" data-f="cc"></label>
            <label>Subject<input name="subject" data-f="subject" required></label>
            <label>Message<textarea name="body" rows="14" data-f="body" required></textarea></label>
            <div class="rp-points" data-reply-points hidden><b>Fill in before sending</b><ul data-reply-list></ul></div>
            <label class="rp-files">Attach files (optional)<input type="file" name="files" multiple></label>
            <div class="rp-actions"><button class="btn">Send email</button><button type="button" class="btn ghost" data-reply-copy>Copy text</button><button type="button" class="btn ghost" data-reply-again>Draft again</button><button type="button" class="link" data-reply-close>Cancel</button></div>
          </div>
        </form>
      </dialog>`,
    }));
  }));

  router.get('/admin/request-files/:msgId/:idx', G(async (req, res) => {
    const m = await db.get('info_request_messages', req.params.msgId);
    const a = (m?.attachments || [])[Number(req.params.idx)];
    if (!a || !a.path || a.bucket !== 'docs') throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(a.path);
    const name = String(a.filename || 'file').replace(/["\r\n]/g, '_');
    const inline = req.query.inline === '1' && /^(image\/|application\/pdf)/.test(a.content_type || '');
    res.writeHead(200, { 'Content-Type': a.content_type || 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }));
  // AI draft of our next email, answering the supplier's latest reply (JSON for the popup).
  router.post('/admin/requests/:id/draft-reply', G(async (req, res) => {
    await parseForm(req).catch(() => null);
    const r = await db.get('info_requests', req.params.id);
    if (!r) return res.json({ error: 'Request not found' }, 404);
    const [supplier, msgs] = await Promise.all([r.supplier_id ? db.get('suppliers', r.supplier_id) : null, db.list('info_request_messages', { filters: { request_id: r.id }, order: 'created_at.asc' })]);
    const latest = [...msgs].reverse().find((m) => m.direction === 'in');
    if (!latest) return res.json({ error: 'No reply from the supplier yet' }, 400);
    const sender = (String(latest.from_email || '').match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase();
    const to = [...new Set([sender, ...(r.to_emails || [])].filter((e) => EMAIL_RE.test(e)))].slice(0, sender ? 1 : 5);
    const cc = [...new Set([...(r.cc_emails || []), ...ccList()])].filter((e) => !to.includes(e));
    try {
      const d = await require('../req-reply').draftReply({ r, supplier, msgs, latest });
      const base = String(latest.subject || r.subject || d.topic || '').replace(/^\s*((re|fw|fwd|回复|答复)\s*[:：]\s*)+/i, '').replace(/\[[^\]]*LB-\d+[^\]]*\]\s*/gi, '').trim();
      res.json({ ok: true, to: to.join(', '), cc: cc.join(', '), subject: `Re: [${r.ref}] ${base || d.topic}`.slice(0, 250), body: d.body, open_points: d.open_points, asked: d.asked, replying_to: { at: latest.created_at, from: latest.from_email || supplier?.name || '' } });
    } catch (e) { res.json({ error: `AI draft failed: ${String(e.message).slice(0, 200)}` }, 502); }
  }));

  // Send our reply from the popup and log it.
  router.post('/admin/requests/:id/reply', G(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: 60 * 1024 * 1024 });
    const r = await db.get('info_requests', req.params.id);
    if (!r) throw new HttpError(404, 'Request not found');
    const split = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const to = split(fields.to); const cc = split(fields.cc).filter((e) => !to.includes(e));
    const subject = String(fields.subject || '').trim().slice(0, 250); const body = String(fields.body || '').trim().slice(0, 20000);
    const back = (type, msg) => { flash(res, type, msg); res.redirect(`/admin/requests/${r.id}`); };
    if (!to.length || to.some((e) => !EMAIL_RE.test(e)) || cc.some((e) => !EMAIL_RE.test(e))) return back('error', 'Check the email addresses');
    if (!subject || !body) return back('error', 'Subject and message are needed');
    if (/\[[^\]]{2,80}\]/.test(body.replace(/\[(LB-\d+)\]/g, ''))) return back('error', 'The message still has [placeholders] to fill in');
    const uploads = (files.files || []).filter((f) => f.buffer?.length).slice(0, 10);
    const subj = subject.includes(r.ref) ? subject : `[${r.ref}] ${subject}`;
    let sent;
    try { sent = await sendEmail(config, { to, cc, subject: subj, text: body, attachments: uploads.map((f) => ({ filename: f.name, content: f.buffer })) }); }
    catch (e) { return back('error', `Email not sent: ${String(e.provider?.reason || e.message).replace(/⟪|⟫|⟦.*?⟧/g, '').slice(0, 200)}`); }
    const attachments = [];
    for (const f of uploads) attachments.push(await saveAttachment(r.ref, f));
    await db.insert('info_request_messages', { request_id: r.id, direction: 'out', from_email: process.env.EMAIL_FROM || null, to_emails: [...to, ...cc], subject: subj, body, attachments });
    await db.update('info_requests', { id: r.id }, { updated_at: new Date().toISOString(), ...(sent?.id ? { email_id: sent.id } : {}) });
    back('ok', `Reply sent to ${to.join(', ')}`);
  }));

  router.get('/admin/requests/:id/ai-status', G(async (req, res) => {
    const msgs = await db.list('info_request_messages', { filters: { request_id: req.params.id } });
    res.json({ pending: RS.pendingCount(msgs), missing: msgs.filter(RS.eligible).length });
  }));
  router.post('/admin/requests/:id/messages/:mid/summarize', G(async (req, res) => {
    const r = await db.get('info_requests', req.params.id); const m = await db.get('info_request_messages', req.params.mid);
    if (!r || !m || m.request_id !== r.id) throw new HttpError(404, 'Message not found');
    try { const s = r.supplier_id ? await db.get('suppliers', r.supplier_id) : null; await RS.summarizeMessage(db, m, { request: r, supplierName: s?.name }); flash(res, 'ok', 'AI summary updated'); }
    catch (e) { flash(res, 'error', `AI summary failed: ${String(e.message).slice(0, 200)}`); }
    res.redirect(`/admin/requests/${r.id}`);
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
    const noteRow = { request_id: r.id, direction, body: body || null, attachments };
    const who = req.staff && !req.staff.owner ? req.staff.name : req.staff ? 'Owner' : null;
    try { await db.insert('info_request_messages', who ? { ...noteRow, author: who } : noteRow); } catch (e) { await db.insert('info_request_messages', noteRow); } // 'author' column may not exist yet
    const status = STATUSES.includes(fields.status) ? fields.status : direction === 'in' && r.status === 'Sent' ? 'Replied' : r.status;
    await db.update('info_requests', { id: r.id }, { status, updated_at: new Date().toISOString() });
    flash(res, 'ok', 'Saved to the log');
    res.redirect(`/admin/requests/${r.id}`);
  }));

  // Log one inbound reply on its request (used by every inbound provider) and tell the admin on Telegram.
  const plain = (htmlBody) => String(htmlBody || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  async function logReply(r, { from, toList, subject, text, htmlBody, attachments, original }) {
    const body = (text || plain(htmlBody)).trim().slice(0, 20000) || '(no text: open the original email)';
    const dupe = (await db.list('info_request_messages', { filters: { request_id: r.id, direction: 'in' } })).some((x) => x.body === body && x.from_email === from && x.subject === subject);
    if (dupe) return { duplicate: true };
    const inRow = { request_id: r.id, direction: 'in', from_email: from, to_emails: toList, subject, body, attachments };
    const orig = String(original || '').trim().slice(0, 50000);
    if (orig && orig !== body) {
      try { await db.insert('info_request_messages', { ...inRow, original: orig }); }
      catch (e) { console.error('Saving original message failed (run the "original" column SQL?):', e.message); await db.insert('info_request_messages', inRow); }
    } else await db.insert('info_request_messages', inRow);
    await db.update('info_requests', { id: r.id }, { status: r.status === 'Sent' ? 'Replied' : r.status, updated_at: new Date().toISOString() });
    await C.completeRequestTasks(db, r.id);
    if (tg.enabled()) {
      try {
        const st = await C.settingsRow(db);
        if (st?.telegram_chat_id) {
          const sup = r.supplier_id ? await db.get('suppliers', r.supplier_id) : null;
          const n = attachments.filter((a) => a.path).length;
          await tg.sendMessage(st.telegram_chat_id, `📬 <b>${tg.escapeHtml(sup?.name || from || 'Supplier')}</b> replied to <b>${r.ref}</b>${n ? ` · ${n} attachment${n > 1 ? 's' : ''}` : ''}\n${tg.escapeHtml(body.slice(0, 300))}${body.length > 300 ? '…' : ''}`, { buttons: [[{ text: 'Open request', url: `${config.publicUrl}/admin/requests/${r.id}` }]] });
        }
      } catch (e) { console.error('Reply notification failed:', e.message); }
    }
    return { duplicate: false };
  }

  router.requestHelpers = { nextRef, saveAttachment, logReply };

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
    const r = (await findRequest(db, { subject, toList, text: d.text, from }))?.r || null;
    if (!r) return res.json({ ok: true, matched: false }, 202);
    let text = d.text || ''; let htmlBody = d.html || '';
    if (!text && !htmlBody && d.email_id && process.env.RESEND_API_KEY) {
      try {
        const rr = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000) });
        if (rr.ok) { const j = await rr.json(); text = j.text || ''; htmlBody = j.html || ''; }
      } catch (e) { console.error('Inbound body fetch failed:', e.message); }
    }
    const attachments = await fetchInboundAttachments(r.ref, d.email_id || d.id, d.attachments);
    await logReply(r, { from, toList, subject, text, htmlBody, attachments });
    res.json({ ok: true, matched: true, ref: r.ref });
  });

  // ── Mailgun inbound route. In Mailgun: Receiving → Create route → expression `match_recipient(".*@<your-inbound-domain>")`,
  //    action `Forward` to https://<your-site>/hooks/mailgun-inbound. Set MAILGUN_SIGNING_KEY (Mailgun → Settings → API security →
  //    "HTTP webhook signing key"). Replies are matched to their request by the LB-xxxx reference, like the Resend route above.
  router.post('/hooks/mailgun-inbound', async (req, res) => {
    const key = process.env.MAILGUN_SIGNING_KEY;
    if (!key) return res.json({ error: 'not found' }, 404);
    let parsed;
    try { parsed = await parseForm(req, { limitBytes: 45 * 1024 * 1024 }); } catch { return res.json({ error: 'bad request' }, 400); }
    const f = parsed.fields;
    const expect = crypto.createHmac('sha256', key).update(String(f.timestamp || '') + String(f.token || '')).digest('hex');
    const sig = String(f.signature || '');
    const fresh = Math.abs(Date.now() / 1000 - Number(f.timestamp)) < 15 * 60;
    if (!(sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) && fresh)) return res.json({ error: 'not found' }, 404);
    const from = String(f.from || f.sender || '');
    const toList = String(f.recipient || f.To || '').split(/[,;]\s*/).filter(Boolean);
    const subject = String(f.subject || '');
    const text = String(f['stripped-text'] || f['body-plain'] || '');
    // Forwarder sailing schedules sent to schedules@… are read by AI into Sailing schedules.
    if (toList.some((x) => /^schedules@/i.test(x.trim()))) {
      const out = await require('../schedules').handleScheduleEmail({ db, config, from, subject, text: String(f['body-plain'] || text), files: Object.values(parsed.files).flat() });
      return res.json({ ok: true, schedules: true, added: out.added, updated: out.updated });
    }
    // Carrier alerts sent to samples@… belong to Samples, not to RFQ threads.
    if (toList.some((x) => /^samples@/i.test(x.trim()))) {
      const out = await require('../samples').handleTrackingEmail({ db, config, from, subject, text: String(f['body-plain'] || text), messageId: f['Message-Id'] || f['message-id'], date: f.Date });
      return res.json({ ok: true, samples: true, ...out });
    }
    // Development threads: matched by the code in the subject, e.g. [Lulyboo DP-1001-9D6A].
    const DE = require('../dev-email');
    if (/\bDP-?\d{3,7}\b/i.test(subject)) {
      const out = await DE.handleDevEmail({ db, config, from, toList, cc: [f.To, f.to, f.Cc, f.cc].filter(Boolean).join(', '), subject, text, bodyPlain: String(f['body-plain'] || ''), files: Object.values(parsed.files).flat(), messageId: String(f['Message-Id'] || f['message-id'] || ''), date: f.Date || f.date });
      if (out.matched) return res.json({ ok: true, dev: true, ...out });
    }
    const found = await findRequest(db, { subject, toList, text: f['body-plain'], from });
    const r = found?.r || null;
    if (!r) { console.log(`Inbound email not matched to a request: from ${from}, subject "${subject.slice(0, 120)}"`); return res.json({ ok: true, matched: false }); } // 200 so Mailgun does not retry
    const attachments = [];
    for (const file of Object.values(parsed.files).flat()) attachments.push(await saveAttachment(r.ref, file));
    const full = String(f['body-plain'] || '');
    const original = full ? `From: ${from}\nTo: ${toList.join(', ')}\nSubject: ${subject}${f.Date ? `\nDate: ${f.Date}` : ''}\n\n${full}` : '';
    const out = await logReply(r, { from, toList, subject, text, htmlBody: f['body-html'], attachments, original });
    res.json({ ok: true, matched: true, ref: r.ref, ...out });
  });
};
