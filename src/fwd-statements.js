'use strict';
// Forwarder statements (accounting statements / statements of account): AI reads every invoice on the statement,
// each invoice is matched to a shipment (master B/L → booking → container → POs in the Ref column), you check the
// matches and save. Invoices are kept once per forwarder + invoice no. in freight_actuals: the next statement only
// updates paid / balance (no duplicates). The statement itself is kept in fwd_statements with its PDF.

const AI = require('./ai');
const FW = require('./forwarding');
const PL = require('./planning');

const now = () => new Date().toISOString();
const r2 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const day = (v) => { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const clean = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const missing = (e) => /fwd_statements|freight_actuals|PGRST20[45]|relation|column/i.test(e?.message || '');

const TOOL = {
  name: 'forwarder_statement',
  description: 'Every invoice listed on a freight forwarder statement of account (or one freight invoice).',
  input_schema: {
    type: 'object',
    properties: {
      forwarder: { type: 'string', description: 'Company that issued the statement (the forwarder), e.g. "Affinity Shipping (USA) Inc."' },
      statement_date: { type: 'string', description: 'YYYY-MM-DD' },
      currency: { type: 'string', description: 'e.g. USD' },
      credit_term: { type: 'string', description: 'e.g. "30 days"' },
      total_records: { type: 'number', description: 'Number of invoices the statement says it lists (e.g. "4 Record(s)")' },
      total_amount: { type: 'number' }, total_paid: { type: 'number' }, total_balance: { type: 'number', description: 'Balance due on the statement' },
      invoices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            invoice_no: { type: 'string', description: 'Invoice number, e.g. IN-26820' },
            invoice_date: { type: 'string', description: 'YYYY-MM-DD (dates on US statements are MM-DD-YYYY)' },
            due_date: { type: 'string', description: 'YYYY-MM-DD' },
            file_no: { type: 'string', description: "Forwarder's file / job number, e.g. OI-267440" },
            mbl_no: { type: 'string', description: 'B/L number shown (master B/L)' },
            hbl_no: { type: 'string', description: 'House B/L if shown separately' },
            booking_no: { type: 'string' },
            container_no: { type: 'string' },
            refs: { type: 'string', description: 'The Ref / customer reference text exactly as printed, e.g. "PO#313, PO#314" or "6144 + 6149"' },
            amount: { type: 'number' }, paid: { type: 'number' }, balance: { type: 'number' },
            payments: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, ref: { type: 'string', description: 'e.g. CHK#3404' }, amount: { type: 'number' } } } },
          },
          required: ['invoice_no', 'amount'],
        },
      },
    },
    required: ['invoices'],
  },
};

/** POs written in a Ref column: "PO#313, PO#314" → ['313','314'], "6144 + 6149" → ['6144','6149'], "PO#60009, 600011". */
function posFrom(refs) {
  return [...new Set((String(refs || '').match(/\d{3,}/g) || []).map((x) => x.replace(/^0+(?=\d)/, '')))];
}

/** Read a statement PDF / image with AI → { forwarder, statement_date, currency, invoices, totals, checks }. */
async function read(file) {
  const ext = (String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const mt = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : /^jpe?g$/.test(ext) ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : '';
  if (!mt) throw new Error('Upload the statement as a PDF or an image');
  const data = file.buffer.toString('base64');
  const block = mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data } } : { type: 'image', source: { type: 'base64', media_type: mt, data } };
  const { result } = await AI.callTool({ tool: TOOL, maxTokens: 6000, content: [block, { type: 'text', text: 'Read every invoice line on this forwarder statement. Payment lines (e.g. a date with CHK#… under an invoice) belong to the invoice above them. Dates as YYYY-MM-DD.' }],
    system: 'You read freight forwarder accounting statements for Lulyboo, a US importer. Copy numbers exactly as printed; never invent invoices.' });
  return normalize(result);
}

function normalize(x) {
  const invoices = (Array.isArray(x.invoices) ? x.invoices : []).map((v) => {
    const amount = r2(v.amount); const paid = r2(v.paid) ?? 0; const bal = r2(v.balance) ?? (amount != null ? r2(amount - paid) : null);
    return {
      invoice_no: String(v.invoice_no || '').trim().slice(0, 60), invoice_date: day(v.invoice_date), due_date: day(v.due_date),
      file_no: String(v.file_no || '').trim().slice(0, 60) || null, mbl_no: String(v.mbl_no || '').trim().slice(0, 60) || null, hbl_no: String(v.hbl_no || '').trim().slice(0, 60) || null,
      booking_no: String(v.booking_no || '').trim().slice(0, 60) || null, container_no: String(v.container_no || '').trim().slice(0, 30) || null,
      refs: String(v.refs || '').trim().slice(0, 200) || null, amount, paid, balance: bal,
      payments: (Array.isArray(v.payments) ? v.payments : []).map((p) => ({ date: day(p.date), ref: String(p.ref || '').trim().slice(0, 60) || null, amount: r2(p.amount) })).filter((p) => p.amount != null || p.ref),
    };
  }).filter((v) => v.invoice_no);
  const sum = (k) => r2(invoices.reduce((a, v) => a + (Number(v[k]) || 0), 0));
  const totals = { records: Number(x.total_records) || null, amount: r2(x.total_amount), paid: r2(x.total_paid), balance: r2(x.total_balance) };
  const ok = (a, b) => a == null || b == null || Math.abs(a - b) < 0.02;
  const checks = { records: totals.records == null || totals.records === invoices.length, amount: ok(totals.amount, sum('amount')), paid: ok(totals.paid, sum('paid')), balance: ok(totals.balance, sum('balance')) };
  return { forwarder: String(x.forwarder || '').trim().slice(0, 160) || null, statement_date: day(x.statement_date), currency: String(x.currency || 'USD').trim().toUpperCase().slice(0, 6), credit_term: String(x.credit_term || '').trim().slice(0, 40) || null,
    invoices, totals, sums: { amount: sum('amount'), paid: sum('paid'), balance: sum('balance') }, checks };
}

/** Forwarder from the name on the statement: exact, then first word ("Affinity Shipping (USA) Inc." → Affinity…). */
function guessForwarder(fwds, name) {
  const n = clean(name); if (!n) return null;
  const word = (s) => clean(String(s || '').split(/[\s(,]+/)[0]);
  return fwds.find((f) => clean(f.company) === n) || fwds.find((f) => n.includes(clean(f.company)) || clean(f.company).includes(n)) || fwds.find((f) => word(f.company).length >= 4 && word(f.company) === word(name)) || null;
}

/** Shipment for one invoice: an earlier save of the same invoice, else master B/L / booking / container / POs. */
async function matchOne(db, inv, saved) {
  if (saved?.container_id) return { container_id: saved.container_id, how: 'saved', why: 'saved before' };
  const m = await FW.match(db, { mbl_no: inv.mbl_no, hbl_no: inv.hbl_no, booking_no: inv.booking_no, container_no: inv.container_no, pos: posFrom(inv.refs) });
  if (!m.container_id) return { container_id: null, how: 'none', why: inv.mbl_no ? `No shipment with B/L ${inv.mbl_no}` : 'No matching shipment' };
  const r = String(m.reason || '');
  const how = /^PO /.test(r) ? 'po' : 'id';
  return { container_id: m.container_id, how, why: how === 'po' ? `matched by ${r} — check` : `matched by ${r.replace(/ \(from the supplier's documents\)/, ' (supplier documents)')}` };
}

/** Invoices already saved for this forwarder, by invoice no. */
async function savedFor(db, fwd) {
  const all = await db.list('freight_actuals').catch(() => []);
  return all.filter((a) => a.invoice_no && (a.forwarder_id === fwd?.id || (!a.forwarder_id && fwd && clean(a.company) === clean(fwd.company))));
}

/** Rows for the review screen: each invoice + its match + what changed since the last save. */
async function review(db, st, fwd) {
  const saved = await savedFor(db, fwd);
  const rows = [];
  for (const inv of st.parsed.invoices) {
    const prev = saved.find((a) => clean(a.invoice_no) === clean(inv.invoice_no));
    const m = await matchOne(db, inv, prev);
    const changes = [];
    if (prev) {
      if (r2(prev.paid) !== r2(inv.paid)) changes.push(`paid ${money(inv.paid)} (was ${money(prev.paid)})`);
      if (r2(prev.amount) != null && r2(prev.amount) !== r2(inv.amount)) changes.push(`amount ${money(inv.amount)} (was ${money(prev.amount)})`);
    }
    rows.push({ ...inv, ...m, prev_id: prev?.id || null, isNew: !prev, changes });
  }
  return rows;
}
const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Save: insert new invoices, update known ones (amounts, payments, shipment). Returns { added, updated }. */
async function save(db, st, fwd, choices, by) {
  const saved = await savedFor(db, fwd);
  const conts = await db.list('plan_containers').catch(() => []);
  let added = 0; let updated = 0;
  for (const inv of st.parsed.invoices) {
    const cid = choices[inv.invoice_no] === undefined ? null : choices[inv.invoice_no] || null;
    const c = conts.find((x) => x.id === cid) || null;
    const prev = saved.find((a) => clean(a.invoice_no) === clean(inv.invoice_no));
    const row = { forwarder_id: fwd.id, company: fwd.company, container_id: c?.id || null, box: c?.box || null, invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, due_date: inv.due_date,
      amount: inv.amount, paid: inv.paid, balance: inv.balance, currency: st.parsed.currency || 'USD', file_no: inv.file_no, mbl_no: inv.mbl_no, booking_no: inv.booking_no, refs: inv.refs,
      payments: inv.payments, statement_id: st.id, updated_at: now() };
    if (prev) { await db.update('freight_actuals', { id: prev.id }, { ...row, files: prev.files || [], lines: prev.lines || [] }); updated++; }
    else { await db.insert('freight_actuals', { ...row, source: 'statement', lines: [], files: st.file ? [st.file] : [], created_by: by || null, created_at: now() }); added++; }
  }
  await db.update('fwd_statements', { id: st.id }, { status: 'saved', forwarder_id: fwd.id, saved_at: now() });
  return { added, updated };
}

/** Open invoices of a forwarder with aging (days past due, by today). */
function aging(invoices, today = PL.today()) {
  const b = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
  for (const a of invoices) {
    const bal = Number(a.balance) || 0; if (bal <= 0) continue;
    const late = a.due_date ? Math.round((Date.parse(today) - Date.parse(a.due_date)) / 864e5) : 0;
    if (late <= 0) b.current += bal; else if (late <= 30) b.d30 += bal; else if (late <= 60) b.d60 += bal; else if (late <= 90) b.d90 += bal; else b.d90p += bal;
  }
  for (const k of Object.keys(b)) b[k] = r2(b[k]);
  return { ...b, total: r2(b.current + b.d30 + b.d60 + b.d90 + b.d90p) };
}
const lateDays = (a, today = PL.today()) => (a.due_date && (Number(a.balance) || 0) > 0 ? Math.round((Date.parse(today) - Date.parse(a.due_date)) / 864e5) : 0);

module.exports = { TOOL, read, normalize, posFrom, guessForwarder, matchOne, review, save, savedFor, aging, lateDays, money, missing, clean };
