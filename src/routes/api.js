'use strict';
// Write-only integration API: an outside agent (Hermes) records the RFQs it sends. Nothing can be read back.
//
//   POST /api/v1/rfq      Authorization: Bearer <INTEGRATION_API_KEY>   (or INTEGRATION_API_KEY_NEXT while rotating)
//
// Safeguards: HTTPS only (Railway), key compared in constant time, per-hour call cap, daily cap on automatically
// created suppliers, throttling of repeated bad keys per IP, an audit log of every call (/admin/api-log), and
// auto-created suppliers are flagged "needs review". The reply never returns supplier, product, price or request data.

const crypto = require('node:crypto');
const { html, fmt } = require('../lib/html');
const { readBody } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const C = require('../crm');

const CHANNELS = ['Telegram', 'WhatsApp', 'WeChat', 'Email', 'Phone', 'Other'];
const ACTIVITY_TYPE = { Email: 'Email', Telegram: 'WeChat/WhatsApp', WhatsApp: 'WeChat/WhatsApp', WeChat: 'WeChat/WhatsApp', Phone: 'Call', Other: 'Note' };
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));
const normName = (n) => String(n || '').toLowerCase().replace(/\b(co|ltd|limited|inc|llc|corp|corporation|company|trading|factory)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const intEnv = (name, def) => { const v = Number(process.env[name]); return Number.isInteger(v) && v > 0 ? v : def; };
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

class ApiError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

module.exports = function apiRoutes(router, { db, config }) {
  // The proxy (Railway) appends the real client address last; earlier entries can be forged by the caller.
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',').map((x) => x.trim()).filter(Boolean).pop() || 'unknown';

  /** Which configured key matches? 'current' | 'next' | null. Both are compared (no early exit on the first). */
  function matchKey(req) {
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || ''));
    let label = null;
    for (const [name, env] of [['current', 'INTEGRATION_API_KEY'], ['next', 'INTEGRATION_API_KEY_NEXT']]) {
      const key = process.env[env];
      if (!key || key.length < 16) continue;
      const k = Buffer.from(key);
      if (given.length === k.length && crypto.timingSafeEqual(given, k) && !label) label = name;
    }
    return label;
  }
  const enabled = () => ['INTEGRATION_API_KEY', 'INTEGRATION_API_KEY_NEXT'].some((n) => (process.env[n] || '').length >= 16);

  async function handle(req) {
    if (!enabled()) throw new ApiError(503, 'The integration API is not enabled');
    const ip = ipOf(req);
    // Repeated bad keys from one address are throttled before anything else is checked.
    const recentFails = (await db.list('api_log', { filters: { ip, key_label: null, created_at: ['gte', hoursAgo(0.25)] }, limit: 50 })).length;
    if (recentFails >= intEnv('API_MAX_FAILED_PER_15MIN', 10)) throw new ApiError(429, 'Too many failed attempts. Try again later.');
    const keyLabel = matchKey(req);
    if (!keyLabel) throw new ApiError(401, 'Invalid or missing API key');
    req.keyLabel = keyLabel;
    const perHour = intEnv('API_MAX_CALLS_PER_HOUR', 60);
    const calls = await db.list('api_log', { filters: { status: ['in', [200, 201]], created_at: ['gte', hoursAgo(1)] }, limit: perHour + 1 });
    if (calls.length >= perHour) throw new ApiError(429, 'Hourly limit reached. Try again later.');

    let b;
    try { b = JSON.parse((await readBody(req, 40 * 1024 * 1024)).toString('utf8')); } catch { throw new ApiError(400, 'Body must be JSON'); }
    const sIn = b.supplier && typeof b.supplier === 'object' ? b.supplier : {};
    const sName = str(sIn.name, 200);
    const sEmail = str(sIn.email, 200).toLowerCase();
    if (!sName) throw new ApiError(400, 'supplier.name is required');
    if (sEmail && !EMAIL_RE.test(sEmail)) throw new ApiError(400, 'supplier.email is not a valid email address');
    const message = str(b.message, 20000);
    const products = (Array.isArray(b.products) ? b.products : []).slice(0, 50).map((p) => (typeof p === 'string' ? { name: p } : p)).filter((p) => p && str(p.name, 300));
    const title = str(b.title, 300) || (products[0] ? `RFQ: ${str(products[0].name, 200)}` : '');
    if (!title) throw new ApiError(400, 'title is required (or send at least one product)');
    const channel = CHANNELS.find((c) => c.toLowerCase() === String(b.channel || '').toLowerCase()) || 'Other';
    const externalId = str(b.external_id, 200) || null;

    // Retries with the same external_id never create a second record.
    if (externalId) {
      const dupe = (await db.list('info_requests', { filters: { external_id: externalId } }))[0];
      if (dupe) return { status: 200, ref: dupe.ref, body: { ok: true, duplicate: true, ref: dupe.ref, request_id: dupe.id, url: `${config.publicUrl}/admin/requests/${dupe.id}` }, note: 'duplicate' };
    }

    // Supplier: match, else create (flagged for review). A matched supplier only gets blank fields filled; nothing is returned about it.
    const all = await db.list('suppliers', { select: 'id,name,email,contact_name,phone,website,country,address,crm_status' });
    let supplier = (sEmail && all.find((s) => String(s.email || '').toLowerCase() === sEmail)) || (normName(sName) && all.find((s) => normName(s.name) === normName(sName))) || null;
    const created = !supplier;
    const extra = { contact_name: str(sIn.contact_name, 200), phone: str(sIn.phone, 100), website: str(sIn.website, 300), country: str(sIn.country, 100), address: str(sIn.address, 500) };
    if (created) {
      const newToday = (await db.list('suppliers', { filters: { created_via: 'api', created_at: ['gte', hoursAgo(24)] }, limit: 200 })).length;
      if (newToday >= intEnv('API_MAX_NEW_SUPPLIERS_PER_DAY', 20)) throw new ApiError(429, 'Daily limit for new suppliers reached. Try again tomorrow.');
    }

    const { nextRef, saveAttachment } = router.requestHelpers;
    const ref = await nextRef();
    if (created) {
      supplier = await db.insert('suppliers', { name: sName, email: sEmail || null, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v || null])), crm_status: 'Contacted', needs_review: true, created_via: 'api', notes: `Added automatically from RFQ ${ref} logged by the Hermes agent. Please check the details.` });
    } else {
      const patch = {};
      for (const [k, v] of Object.entries({ email: sEmail, ...extra })) if (v && !supplier[k]) patch[k] = v;
      if (supplier.crm_status === 'Prospect') patch.crm_status = 'Contacted';
      if (Object.keys(patch).length) await db.update('suppliers', { id: supplier.id }, patch);
    }

    const sentAt = b.sent_at && !Number.isNaN(Date.parse(b.sent_at)) ? new Date(b.sent_at).toISOString() : new Date().toISOString();
    const productLines = products.map((p) => `• ${str(p.name, 300)}${p.sku ? ` (${str(p.sku, 100)})` : ''}${p.qty ? ` — qty ${str(p.qty, 50)}` : ''}${p.target_price ? ` — target ${str(p.target_price, 50)}` : ''}${p.notes ? ` — ${str(p.notes, 300)}` : ''}`);
    const bodyText = [message, productLines.length ? `Products:\n${productLines.join('\n')}` : ''].filter(Boolean).join('\n\n') || '(no text recorded)';
    const row = await db.insert('info_requests', {
      ref, supplier_id: supplier.id, kind: 'rfq', channel, contact: str(b.contact, 200) || null, external_id: externalId,
      subject: title, note: str(b.notes, 2000) || null, to_emails: sEmail ? [sEmail] : [], created_at: sentAt, updated_at: sentAt,
    });
    const attachments = [];
    for (const a of (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 10)) {
      const buf = Buffer.from(String(a?.content_base64 || ''), 'base64');
      if (buf.length) attachments.push(await saveAttachment(ref, { name: str(a.filename, 200) || 'file', type: str(a.content_type, 100), buffer: buf }));
    }
    await db.insert('info_request_messages', { request_id: row.id, direction: 'out', from_email: null, to_emails: sEmail ? [sEmail] : [], subject: title, body: bodyText, attachments, created_at: sentAt });
    await db.insert('supplier_activities', { supplier_id: supplier.id, type: ACTIVITY_TYPE[channel], summary: `RFQ ${ref} sent via ${channel}: ${title}`.slice(0, 5000), activity_date: sentAt.slice(0, 10), done: true });
    const days = b.follow_up_days === undefined ? 3 : Math.min(60, Math.max(0, Number(b.follow_up_days) || 0));
    if (days > 0) await db.insert('crm_tasks', { supplier_id: supplier.id, request_id: row.id, type: 'Follow-up', title: `Follow up RFQ ${ref}: ${title}`.slice(0, 300), due_date: C.addDays(C.localNow().date, days) });
    return { status: 201, ref, created, body: { ok: true, ref, request_id: row.id, url: `${config.publicUrl}/admin/requests/${row.id}`, supplier_created: created }, note: created ? 'new supplier' : null };
  }

  router.post('/api/v1/rfq', async (req, res) => {
    let out;
    try { out = await handle(req); } catch (e) {
      if (e instanceof ApiError) out = { status: e.status, body: { error: e.message }, note: e.message };
      else { console.error(new Date().toISOString(), 'API /rfq failed:', e.message); out = { status: 500, body: { error: 'Could not record the request' }, note: 'server error' }; }
    }
    if (out.status !== 503) {
      try { await db.insert('api_log', { ip: ipOf(req), key_label: req.keyLabel || null, endpoint: 'POST /api/v1/rfq', status: out.status, ref: out.ref || null, supplier_created: out.created ?? null, note: out.note || null }); } catch (e) { console.error('API log failed:', e.message); }
    }
    res.json(out.body, out.status);
  });

  // ── Admin: audit log
  router.get('/admin/api-log', guard(config, async (req, res) => {
    const rows = await db.list('api_log', { order: 'created_at.desc', limit: 200 });
    const day = rows.filter((r) => r.created_at >= hoursAgo(24));
    const refs = rows.filter((r) => r.ref).map((r) => r.ref);
    const reqs = refs.length ? await db.list('info_requests', { filters: { ref: ['in', refs] }, select: 'id,ref' }) : [];
    const idOf = Object.fromEntries(reqs.map((r) => [r.ref, r.id]));
    res.html(page({
      title: 'Integration log', nav: adminNav('requests'), wide: true,
      body: html`<h1>Integration log</h1>
      <p class="muted">Every call to the RFQ API: who called (address and key), what happened, and which request it created. The API can only add records. <a href="/admin/requests">Back to Requests</a></p>
      <div class="kpis"><div class="kpi"><b>${day.filter((r) => r.status < 300).length}</b><span>Recorded (24 h)</span></div>
        <div class="kpi ${day.some((r) => r.status >= 400) ? 'warn' : ''}"><b>${day.filter((r) => r.status >= 400).length}</b><span>Refused or failed (24 h)</span></div></div>
      <div class="table-wrap"><table class="list"><thead><tr><th>Time (UTC)</th><th>Address</th><th>Key</th><th>Result</th><th>Request</th><th>Note</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => html`<tr><td>${String(r.created_at).replace('T', ' ').slice(0, 19)}</td><td>${r.ip || '—'}</td><td>${r.key_label || '—'}</td>
        <td><span class="pill ${r.status < 300 ? 's-selected' : 's-rejected'}">${r.status}</span></td>
        <td>${r.ref ? (idOf[r.ref] ? html`<a href="/admin/requests/${idOf[r.ref]}">${r.ref}</a>` : r.ref) : '—'}</td><td>${r.note || ''}</td></tr>`) : html`<tr><td colspan="6" class="muted">No calls yet.</td></tr>`}</tbody></table></div>`,
    }));
  }));

  // ── Admin: approve an automatically created supplier
  router.post('/admin/suppliers/:id/approve', guard(config, async (req, res) => {
    const s = await db.get('suppliers', req.params.id);
    if (s) await db.update('suppliers', { id: s.id }, { needs_review: false });
    res.redirect(`/admin/suppliers/${req.params.id}`);
  }));
};
