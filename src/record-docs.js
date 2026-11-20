'use strict';
// AI reading of a record-only shipment's documents, and the "Found in documents" suggestions.
//   Each uploaded file is read once (re-read on request): its type and key facts are kept on the file
//   (record.files[i].ai). A CBP 7501 also becomes a customs entry (pending → reviewed in Customs, as for any shipment).
//   suggest() compares what the documents say with the record: empty fields come ticked, a different value unticked.
//   Nothing changes on the record until "Apply". Local charges on a freight invoice (THC, doc, ISF…) count as Freight;
//   Fees are the customs fees (MPF + HMF) from the 7501.

const AI = require('./ai');
const PL = require('./planning');
const now = () => new Date().toISOString();
const day = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
const code = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const usd = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const TYPES = {
  customs_entry: 'CBP 7501', invoice: 'Freight invoice', bill_of_lading: 'Bill of lading', telex_release: 'Telex release',
  arrival_notice: 'Arrival notice', commercial_invoice: 'Commercial invoice', packing_list: 'Packing list', isf: 'ISF filing', delivery_order: 'Delivery order', other: 'Other document',
};

const TOOL = {
  name: 'read_shipping_document',
  description: 'Record what one shipping document says.',
  input_schema: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', enum: Object.keys(TYPES), description: 'customs_entry = US Customs entry summary, CBP Form 7501. invoice = a freight forwarder / carrier invoice for transport charges. commercial_invoice = the supplier\'s invoice for the goods.' },
      doc_no: { type: 'string', description: 'The document\'s own number (invoice no., B/L no., entry no.)' },
      hbl_no: { type: 'string', description: 'House B/L number' }, mbl_no: { type: 'string', description: 'Master / ocean B/L number' },
      container_no: { type: 'string', description: '4 letters + 7 digits' }, container_type: { type: 'string' },
      carrier: { type: 'string' }, vessel: { type: 'string', description: 'Vessel name without voyage' }, voyage: { type: 'string' },
      pol: { type: 'string', description: 'Port of loading as written' }, pod: { type: 'string', description: 'Port of discharge as written' },
      atd: { type: 'string', description: 'Date it sailed / on board date, YYYY-MM-DD' }, ata: { type: 'string', description: 'Actual arrival date, YYYY-MM-DD — only when the document says the vessel has arrived' },
      eta: { type: 'string', description: 'Vessel arrival date / ETA at the port of discharge, YYYY-MM-DD. Arrival notices always state it (often "ETA", "Arrival date" or "Vessel arrival"); record it.' }, release_date: { type: 'string', description: 'Telex / cargo release date, YYYY-MM-DD' },
      due_date: { type: 'string', description: 'Payment due date of an invoice, YYYY-MM-DD' },
      ocean_usd: { type: 'number', description: 'Ocean / air freight charge in USD (the transport line only)' },
      charges: { type: 'array', description: 'Every other charge line in USD (THC, documentation, ISF, customs clearance, delivery…)', items: { type: 'object', properties: { name: { type: 'string' }, usd: { type: 'number' } }, required: ['name', 'usd'] } },
      invoice_total_usd: { type: 'number', description: 'Invoice total in USD' },
      goods_value_usd: { type: 'number', description: 'Total value of the goods (commercial invoice), USD' },
      cartons: { type: 'number' }, pieces: { type: 'number' }, gross_kg: { type: 'number' }, volume_cbm: { type: 'number' },
      pos: { type: 'array', items: { type: 'string' }, description: 'Purchase order numbers, each separately' },
      summary: { type: 'string', description: 'One sentence: what this document is and says' },
    },
    required: ['doc_type', 'summary'],
  },
};

const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const readable = (f) => { const ext = (String(f.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''; return MIMES[ext] || (/^image\/(png|jpeg|webp)$/.test(f.type || '') ? f.type : /pdf/.test(f.type || '') ? 'application/pdf' : null); };

/** Read one file: { type, label, facts, summary, at } (facts normalised). */
async function readFile(f) {
  const mt = readable(f);
  if (!mt) return { type: 'other', label: TYPES.other, facts: {}, summary: 'Not a PDF or image — not read.', at: now(), skipped: true };
  const block = mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } };
  const { result: r = {} } = await AI.callTool({ tool: TOOL, maxTokens: 1500, content: [block, { type: 'text', text: `Today is ${PL.today()}. File name: ${f.name}. Read this shipping document for an importer (goods from China to the US). Record only what it states; never guess numbers. Dates like 11/04/26 are US format (month/day/year).` }] });
  const type = TYPES[r.doc_type] ? r.doc_type : 'other';
  const facts = {};
  for (const k of ['doc_no', 'hbl_no', 'mbl_no', 'container_no', 'container_type', 'carrier', 'vessel', 'voyage', 'pol', 'pod']) if (r[k] && String(r[k]).trim()) facts[k] = String(r[k]).trim().slice(0, 80);
  for (const k of ['hbl_no', 'mbl_no', 'container_no']) if (facts[k]) facts[k] = code(facts[k]);
  for (const k of ['atd', 'ata', 'eta', 'release_date', 'due_date']) { const d = r[k] ? PL.isoDay(r[k]) : null; if (d) facts[k] = d; }
  for (const k of ['ocean_usd', 'invoice_total_usd', 'goods_value_usd', 'cartons', 'pieces', 'gross_kg', 'volume_cbm']) { const n = num(r[k]); if (n != null && n > 0) facts[k] = n; }
  facts.charges = (Array.isArray(r.charges) ? r.charges : []).map((x) => ({ name: String(x.name || '').slice(0, 40), usd: num(x.usd) })).filter((x) => x.name && x.usd != null).slice(0, 15);
  facts.pos = [...new Set((Array.isArray(r.pos) ? r.pos : []).map((p) => PL.normPo(p)).filter((p) => /\d{3,}/.test(p)))].slice(0, 20);
  return { type, label: TYPES[type], facts, summary: String(r.summary || '').slice(0, 300), at: now() };
}

/** Freight from a freight invoice: the total, else ocean + every charge. */
function freightOf(fx) {
  const ch = (fx.charges || []).reduce((a, x) => a + (x.usd || 0), 0);
  if (fx.invoice_total_usd) return { v: fx.invoice_total_usd, detail: [fx.ocean_usd ? `ocean ${usd(fx.ocean_usd)}` : '', ...(fx.charges || []).map((x) => `${x.name} ${usd(x.usd)}`)].filter(Boolean).join(' · ') };
  if (fx.ocean_usd) return { v: Math.round((fx.ocean_usd + ch) * 100) / 100, detail: [`ocean ${usd(fx.ocean_usd)}`, ...(fx.charges || []).map((x) => `${x.name} ${usd(x.usd)}`)].join(' · ') };
  return null;
}

/** One line of facts for the file row. */
function factsLine(ai, entry) {
  if (!ai) return '';
  const fx = ai.facts || {};
  if (ai.type === 'customs_entry' && entry) return [`Entry ${entry.entry_no || '—'}`, entry.entry_date ? PL.short(String(entry.entry_date).slice(0, 10)) : '', entry.entered_value != null ? `entered value ${usd(entry.entered_value)}` : '', entry.duty != null ? `duty ${usd(entry.duty)}` : '', `${(entry.lines || []).length} line${(entry.lines || []).length === 1 ? '' : 's'}`, (entry.pos || []).length ? `PO ${entry.pos.map(PL.normPo).join(', ')}` : ''].filter(Boolean).join(' · ');
  const fr = ai.type === 'invoice' ? freightOf(fx) : null;
  return [
    fx.doc_no && ai.type !== 'bill_of_lading' ? `${ai.type === 'invoice' || ai.type === 'commercial_invoice' ? 'Invoice' : 'No.'} ${fx.doc_no}` : '',
    fx.hbl_no ? `HBL ${fx.hbl_no}` : '', fx.mbl_no ? `MBL ${fx.mbl_no}` : '', fx.container_no || '',
    [fx.carrier, [fx.vessel, fx.voyage].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
    fx.pol || fx.pod ? `${fx.pol || '?'} → ${fx.pod || '?'}` : '',
    fr ? `freight ${usd(fr.v)}${(fx.charges || []).length ? ` (incl. ${fx.charges.length} charge${fx.charges.length === 1 ? '' : 's'})` : ''}` : '',
    fx.goods_value_usd ? `goods ${usd(fx.goods_value_usd)}` : '', fx.cartons ? `${fx.cartons} ctns` : '',
    fx.atd ? `sailed ${PL.short(fx.atd)}` : '', fx.ata ? `arrived ${PL.short(fx.ata)}` : fx.eta ? `ETA ${PL.short(fx.eta)}` : '', fx.release_date ? `released ${PL.short(fx.release_date)}` : '', fx.due_date ? `due ${PL.short(fx.due_date)}` : '',
    fx.pos?.length ? `PO ${fx.pos.join(', ')}` : '',
  ].filter(Boolean).join(' · ') || ai.summary;
}

const FLAB = { eta: 'ETA', entry_no: 'Entry no.', duty: 'Customs duty', fees: 'Fees (MPF + HMF)', freight: 'Freight', pos: 'POs', atd: 'Sailed', ata: 'Arrived', hbl_no: 'House B/L', mbl_no: 'Master B/L', container_no: 'Container', carrier: 'Carrier', vessel: 'Vessel', voyage: 'Voyage' };

/**
 * What the documents say vs the record. c: the record container; entries: its customs entries.
 * Returns { items: [{ key, label, now, found, show, detail, from, differs }], checks: [text] }.
 */
function suggest(c, entries = []) {
  const rec = c.record || {}; const f = c.fwd || {};
  const files = (rec.files || []).map((x, i) => ({ x, i })).filter(({ x }) => x.ai && !x.ai.skipped);
  const saved = entries.filter((e) => e.status === 'saved');
  const found = {}; // key → { v, show, detail, from }
  const put = (k, v, extra = {}) => { if (v == null || v === '' || (Array.isArray(v) && !v.length) || found[k]) return; found[k] = { v, ...extra }; };
  for (const { x } of files) {
    const fx = x.ai.facts || {};
    const e = x.ai.entry_id ? entries.find((y) => y.id === x.ai.entry_id) : null;
    if (x.ai.type === 'customs_entry' && e) {
      put('entry_no', e.entry_no, { from: x.name });
      if (!saved.length) { put('duty', e.duty, { from: x.name, show: usd(e.duty) }); put('fees', e.fees, { from: x.name, show: usd(e.fees), detail: [e.facts?.mpf != null ? `MPF ${usd(e.facts.mpf)}` : '', e.facts?.hmf != null ? `HMF ${usd(e.facts.hmf)}` : ''].filter(Boolean).join(' · ') }); }
      put('pos', (e.pos || []).map(PL.normPo), { from: x.name });
    }
    if (x.ai.type === 'invoice') { const fr = freightOf(fx); if (fr) put('freight', fr.v, { from: x.name, show: usd(fr.v), detail: fr.detail }); }
    for (const k of ['hbl_no', 'mbl_no', 'container_no', 'carrier', 'vessel', 'voyage']) put(k, fx[k], { from: x.name });
    if (fx.atd) put('atd', fx.atd, { from: x.name, show: PL.short(fx.atd) });
    if (fx.ata) put('ata', fx.ata, { from: x.name, show: PL.short(fx.ata) });
    // an arrival notice gives the vessel's arrival as an ETA: once that day has passed it is the arrival date
    else if (fx.eta && fx.eta <= PL.today()) put('ata', fx.eta, { from: x.name, show: PL.short(fx.eta), detail: `ETA on the ${x.ai.label.toLowerCase()} — passed` });
    else if (fx.eta) put('eta', fx.eta, { from: x.name, show: PL.short(fx.eta) });
    if (fx.pos?.length) put('pos', fx.pos, { from: x.name });
  }
  const cur = {
    entry_no: rec.entry_no || null, duty: rec.duty ?? null, fees: rec.fees ?? null, freight: rec.freight ?? null, pos: (rec.pos_text || (rec.pos || []).map((p) => p.po)).map(PL.normPo),
    atd: day(f.atd), ata: day(f.ata), eta: f.ata ? day(f.ata) : day(f.eta), hbl_no: f.hbl_no ? code(f.hbl_no) : null, mbl_no: f.mbl_no ? code(f.mbl_no) : null, container_no: f.container_no || null, carrier: f.carrier || null, vessel: f.vessel || null, voyage: f.voyage || null,
  };
  const dis = new Set(rec.dismissed || []);
  const items = [];
  for (const [k, s] of Object.entries(found)) {
    const now0 = cur[k];
    let same; let differs;
    if (k === 'pos') { const add = s.v.filter((p) => !now0.includes(p)); same = !add.length; differs = false; s.v = [...new Set([...now0, ...s.v])]; s.show = s.v.join(', '); }
    else if (['duty', 'fees', 'freight'].includes(k)) { same = now0 != null && Math.abs(Number(now0) - Number(s.v)) < 0.01; differs = now0 != null && !same; }
    else { const n = (v) => (k === 'voyage' ? code(v).replace(/^(VOY|V)(?=\d)/, '') : code(v)); same = now0 != null && n(now0) === n(s.v); differs = now0 != null && now0 !== '' && !same; }
    if (same || dis.has(`${k}=${Array.isArray(s.v) ? s.v.join(',') : s.v}`)) continue;
    items.push({ key: k, label: FLAB[k], now: k === 'pos' ? (now0.length ? now0.join(', ') : null) : ['duty', 'fees', 'freight'].includes(k) ? (now0 != null ? usd(now0) : null) : ['atd', 'ata', 'eta'].includes(k) ? (now0 ? PL.short(now0) : null) : now0, found: s.show || (Array.isArray(s.v) ? s.v.join(', ') : String(s.v)), value: s.v, detail: s.detail || '', from: s.from, differs });
  }
  const order = Object.keys(FLAB); items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // cross-checks between documents
  const checks = [];
  const hbls = new Map();
  for (const { x } of files) if (x.ai.facts?.hbl_no) hbls.set(x.ai.facts.hbl_no, [...(hbls.get(x.ai.facts.hbl_no) || []), x.name]);
  for (const e of entries) for (const h of e.hbls || []) if (!hbls.has(code(h))) hbls.set(code(h), [`7501 ${e.entry_no || ''}`.trim()]); else hbls.get(code(h)).push(`7501 ${e.entry_no || ''}`.trim());
  if (hbls.size > 1) checks.push(`Several house B/Ls: ${[...hbls].map(([h, src]) => `${h} (${[...new Set(src)].join(', ')})`).join('; ')} — check that this record covers all of them; a 7501's duty is for every B/L on it.`);
  const ctns = [...new Set(files.map(({ x }) => x.ai.facts?.container_no).filter(Boolean))];
  if (ctns.length > 1) checks.push(`Different containers on the documents: ${ctns.join(', ')}.`);
  const ci = files.find(({ x }) => x.ai.type === 'commercial_invoice' && x.ai.facts?.goods_value_usd);
  const e0 = entries.find((e) => e.entered_value);
  if (ci && e0) { const a = ci.x.ai.facts.goods_value_usd; const b = Number(e0.entered_value); if (Math.abs(a - b) / b > 0.03) checks.push(`Commercial invoice ${usd(a)} vs 7501 entered value ${usd(b)} (${a > b ? '+' : ''}${Math.round(((a - b) / b) * 1000) / 10}%).`); }
  return { items, checks };
}

/** Apply the chosen suggestions to the record. keys: suggestion keys. */
async function apply(db, c, keys, entries, { by = null, markShipped = false } = {}) {
  const REC = require('./records');
  const { items } = suggest(c, entries);
  const pick = items.filter((s) => keys.includes(s.key));
  const rec = { ...(c.record || {}) }; const fwd = { ...(c.fwd || {}) }; const src = { ...(rec.src || {}) };
  for (const s of pick) {
    if (['duty', 'fees', 'freight'].includes(s.key)) rec[s.key] = Number(s.value);
    else if (s.key === 'entry_no') rec.entry_no = String(s.value).slice(0, 40);
    else if (s.key === 'pos') { const r = await REC.resolvePos(db, s.value); rec.pos = r.found; rec.pos_text = r.all; }
    else if (s.key === 'atd') fwd.atd = s.value;
    else if (s.key === 'ata') Object.assign(fwd, { ata: s.value, eta: s.value, arrived: true });
    else if (s.key === 'eta') fwd.eta = s.value;
    else fwd[s.key] = s.value;
    src[s.key] = s.from;
  }
  rec.src = src;
  const delivered = fwd.ata || fwd.eta || fwd.atd;
  await db.update('plan_containers', { id: c.id }, { record: rec, fwd, ...(delivered ? { delivered_at: `${delivered}T12:00:00Z` } : {}), updated_at: now() });
  if (markShipped && pick.some((s) => s.key === 'pos')) await REC.markShipped(db, rec.pos || []);
  return pick.length;
}

/** Read the new files of a record (indexes) — a 7501 becomes a pending customs entry on this record. */
async function readFiles(db, config, c, idx, { by = null } = {}) {
  const CU = require('./customs');
  const list = [...((c.record || {}).files || [])];
  const out = { read: 0, entries: 0, failed: [] };
  await Promise.all(idx.map(async (i) => {
    const x = list[i]; if (!x) return;
    try {
      const buffer = await db.docs.download(x.path);
      const ai = await readFile({ name: x.name, type: x.type, buffer });
      if (ai.type === 'customs_entry') {
        const old = x.ai?.entry_id ? await db.get('customs_entries', x.ai.entry_id).catch(() => null) : null;
        if (old && old.status !== 'discarded') ai.entry_id = old.id;
        else {
          try { const e = await CU.createEntry(db, config, { files: [{ name: x.name, type: x.type, buffer }], source: 'record', containerId: c.id, by }); ai.entry_id = e.id; out.entries++; }
          catch (err) { ai.note = `Not added to Customs: ${err.message}`.slice(0, 200); }
        }
      }
      list[i] = { ...x, ai }; out.read++;
    } catch (e) { console.error('Record document read failed:', e.message); out.failed.push(x.name); list[i] = { ...x, ai: { type: 'other', label: TYPES.other, facts: {}, summary: '', at: now(), error: String(e.message).slice(0, 160) } }; }
  }));
  const fresh = await db.get('plan_containers', c.id);
  const merged = ((fresh.record || {}).files || []).map((x) => list.find((y) => y.path === x.path) || x);
  await db.update('plan_containers', { id: c.id }, { record: { ...(fresh.record || {}), files: merged }, updated_at: now() });
  return out;
}

module.exports = { TYPES, TOOL, readFile, readFiles, suggest, apply, factsLine, freightOf };
