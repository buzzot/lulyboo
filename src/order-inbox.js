'use strict';
// New POs by email: forward or CC the PO to orders@<inbound domain>. AI reads every attachment (and the email
// text) like Import orders does, the supplier is matched, and the import waits under Import orders → "From email"
// until you check the lines and save them. Nothing reaches Container planning on its own.

const PL = require('./planning');

const now = () => new Date().toISOString();
const low = (s) => String(s || '').trim().toLowerCase();
const EMAILS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ORDER_FILE = /\.(xlsx|xls|csv|pdf|png|jpe?g|webp)$/i;
const isLogo = (f) => /^image\//i.test(f.type || '') && ((f.buffer?.length || 0) < 30 * 1024 || /logo|signature|image0\d\d|outlook|icon/i.test(f.name || ''));

/** The supplier: the name the AI read on the PO, else an address in the (forwarded) email that belongs to a supplier. */
function matchSupplier(sups, { aiName, text, from }) {
  const n = low(aiName).replace(/[.,]/g, '').replace(/\b(co|ltd|limited|inc|llc|company|corp|corporation|trading|industrial|factory)\b/g, '').replace(/\s+/g, ' ').trim();
  if (n.length >= 3) {
    const exact = sups.find((s) => low(s.name) === low(aiName));
    if (exact) return { supplier: exact, by: 'name on the PO' };
    const part = sups.filter((s) => { const sn = low(s.name).replace(/[.,]/g, ''); return sn.includes(n) || n.includes(sn.replace(/\b(co|ltd|limited|inc)\b/g, '').trim()); });
    if (part.length === 1) return { supplier: part[0], by: 'name on the PO' };
  }
  const addrs = [...new Set([...(String(text || '').match(EMAILS) || []), ...(String(from || '').match(EMAILS) || [])].map(low))].filter((e) => !/lulyboo/.test(e));
  for (const e of addrs) {
    const dom = e.split('@')[1];
    const hit = sups.find((s) => low(s.email) === e) || (!/gmail|qq\.com|163\.com|126\.com|outlook|hotmail|yahoo|foxmail|sina/.test(dom) && sups.find((s) => low(s.email).endsWith(`@${dom}`)));
    if (hit) return { supplier: hit, by: `email ${e}` };
  }
  return { supplier: null, by: null };
}

/** Inbound email to orders@… → a pending import. */
async function handleOrderEmail({ db, config, from, subject, text, files = [] }) {
  const docs = files.filter((f) => f.buffer?.length && ORDER_FILE.test(f.name || '') && !isLogo(f));
  const body = String(text || '').trim();
  let lines = []; let aiName = null; const notes = [];
  for (const f of docs) {
    try { const r = await PL.readOrders({ name: f.name, buffer: f.buffer }); f.pos = r.orders.map((o) => o.po); lines = lines.concat(r.orders); aiName = aiName || r.supplierName; notes.push(`${f.name}: ${r.orders.length} line${r.orders.length === 1 ? '' : 's'}`); }
    catch (e) { notes.push(`${f.name}: could not be read (${String(e.message).slice(0, 120)})`); }
  }
  // the email text is read too when there is no attachment, or the attachments gave nothing
  if (!lines.length && body.length >= 20) {
    try { const r = await PL.readOrders({ name: 'Email text', text: [subject ? `Subject: ${subject}` : '', body].join('\n\n') }); lines = lines.concat(r.orders); aiName = aiName || r.supplierName; notes.push(`Email text: ${r.orders.length} line${r.orders.length === 1 ? '' : 's'}`); }
    catch (e) { notes.push(`Email text: could not be read (${String(e.message).slice(0, 120)})`); }
  }
  const sups = await db.list('suppliers', { select: 'id,name,email' }).catch(() => []);
  const m = matchSupplier(sups, { aiName, text: body, from });
  const id = `oi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const stored = [];
  for (const f of docs) {
    const path = `order-inbox/${id}/${String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120)}`;
    try { await db.docs.upload(path, f.buffer, f.type || 'application/octet-stream'); stored.push({ name: String(f.name).slice(0, 200), path, type: f.type || '', size: f.buffer.length, pos: f.pos || [] }); } catch { notes.push(`${f.name}: could not be stored`); }
  }
  const row = await db.insert('order_imports', {
    status: 'pending', from_email: String(from || '').slice(0, 300), subject: String(subject || '').slice(0, 300), supplier_id: m.supplier?.id || null, supplier_name: aiName || null,
    matched_by: m.by, lines, notes, files: stored, created_at: now(),
  });
  const pos = [...new Set(lines.map((l) => l.po).filter(Boolean))];
  const P = require('./projects');
  const link = `${config.publicUrl || ''}/admin/logistics/planning/import/inbox/${row.id}`;
  await P.notifyOwner(config, lines.length ? `[Orders] ${pos.length ? `PO ${pos.slice(0, 3).join(', ')}` : 'New order'} — ${m.supplier?.name || aiName || 'supplier to choose'}, ${lines.length} line${lines.length === 1 ? '' : 's'} to check` : `[Orders] Nothing read from "${subject}"`,
    `${notes.join('\n')}\n\nCheck and save: ${link}`,
    { title: lines.length ? 'New PO to check' : 'PO email — nothing read', intro: `${lines.length} line${lines.length === 1 ? '' : 's'} read${pos.length ? ` (PO ${pos.join(', ')})` : ''}${m.supplier ? ` for ${m.supplier.name}` : aiName ? ` — supplier on the PO: ${aiName}` : ''}. Nothing is saved until you check it.`, button: 'Check the lines', link }).catch(() => null);
  return { id: row.id, lines: lines.length, supplier: m.supplier?.id || null };
}

/** Files of a pending import, ready for PL.storeFiles once it's saved. */
async function filesOf(db, imp) {
  const out = [];
  for (const f of imp.files || []) { try { const buffer = await db.docs.download(f.path); if (buffer?.length) out.push({ name: f.name, type: f.type, buffer, pos: f.pos }); } catch { /* skip */ } }
  return out;
}

async function close(db, imp, status, by) {
  await db.update('order_imports', { id: imp.id }, { status, decided_at: now(), decided_by: by || null });
  if (status === 'discarded') await db.docs.remove((imp.files || []).map((f) => f.path)).catch(() => null);
}

module.exports = { handleOrderEmail, matchSupplier, filesOf, close };
