'use strict';
// Customs entries (CBP 7501 entry summaries): AI reads the form, links it to the container, POs and catalog
// products, checks the duty math, compares with past entries, and reviews each HTS code against the catalog.
// Nothing is saved until you accept ("pending" → "saved"). Duty of a line covering several products is split by PO value.

const crypto = require('node:crypto');
const AI = require('./ai');
const PL = require('./planning');

const now = () => new Date().toISOString();
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const digits = (h) => String(h || '').replace(/\D/g, '');
const fmtHts = (h) => { const d = digits(h); return d.length >= 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 10)}` : String(h || ''); };   // as on the 7501: 9503.00.0073
const code = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const missingTable = (e) => /customs_entries|PGRST20[45]|relation/i.test(e?.message || '');
const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const customsAddress = () => (process.env.CUSTOMS_EMAIL || `customs@${domain()}`).toLowerCase();

const TOOL = {
  name: 'record_customs_entry',
  description: 'Record a US Customs entry summary (CBP Form 7501) exactly as printed.',
  input_schema: {
    type: 'object',
    properties: {
      is_entry_summary: { type: 'boolean', description: 'true if this is a CBP 7501 entry summary (or a broker\'s duty statement for one)' },
      entry_no: { type: 'string', description: 'Box 1 Filer code / entry number, e.g. 9T2-0090981-5' },
      entry_type: { type: 'string', description: 'Box 2, e.g. "01 ABI/P"' },
      summary_date: { type: 'string', description: 'Box 3, YYYY-MM-DD' },
      entry_date: { type: 'string', description: 'Box 7, YYYY-MM-DD' },
      import_date: { type: 'string', description: 'Box 11, YYYY-MM-DD' },
      export_date: { type: 'string', description: 'Box 15, YYYY-MM-DD' },
      port_code: { type: 'string', description: 'Box 6 port code, e.g. 2704' },
      carrier: { type: 'string', description: 'Box 8 importing carrier' },
      voyage: { type: 'string' },
      mbl: { type: 'string', description: 'Box 12 B/L number (master B/L)' },
      hbls: { type: 'array', items: { type: 'string' }, description: 'House B/L numbers listed with the lines (without the SCAC prefix if separated by a space, e.g. "RSLC SNAL2610035A" → "SNAL2610035A")' },
      packages: { type: 'number', description: 'Total packages / cartons across the house B/Ls' },
      country_of_origin: { type: 'string' },
      foreign_port: { type: 'string', description: 'Box 19 foreign port of lading code' },
      importer_no_last4: { type: 'string', description: 'Last 4 digits of the importer number (box 27) only' },
      broker: { type: 'string', description: 'Box 46 broker / filer name' },
      broker_file: { type: 'string', description: 'Box 47 broker file number' },
      entered_value: { type: 'number', description: 'Box 39 total entered value, USD' },
      duty: { type: 'number', description: 'Box 41 duty, USD' },
      tax: { type: 'number', description: 'Box 42 tax, USD' },
      other: { type: 'number', description: 'Box 43 other (fees), USD' },
      total: { type: 'number', description: 'Box 44 total, USD' },
      mpf: { type: 'number', description: 'Total 499 Merchandise Processing Fee, USD' },
      hmf: { type: 'number', description: 'Total 501 Harbor Maintenance Fee, USD' },
      pos: { type: 'array', items: { type: 'string' }, description: 'Purchase order numbers written anywhere (e.g. "PO#310002 & PO#610000" → ["310002","610000"])' },
      lines: {
        type: 'array',
        description: 'One per entry line (box 31). Keep all tariff numbers of the line.',
        items: {
          type: 'object',
          properties: {
            line_no: { type: 'string' },
            description: { type: 'string', description: 'Description of the goods (the line of the main HTS number, e.g. "OTHER TOYS, NSPF")' },
            hts: { type: 'string', description: 'The main (chapter 1–97) HTSUS number, 10 digits, e.g. 9503.00.0073' },
            rate: { type: 'string', description: 'Rate of the main HTS number as printed, e.g. "6.3%" or "FREE"' },
            duty: { type: 'number', description: 'Duty USD of the main HTS number' },
            extras: { type: 'array', description: 'Additional chapter 99 numbers on the line (9903.xx.xx)', items: { type: 'object', properties: { code: { type: 'string' }, label: { type: 'string', description: 'The text above it, e.g. "ARTICLE OF CHINA, US NTE 20(F)"' }, rate: { type: 'string' }, amount: { type: 'number' } }, required: ['code'] } },
            gross_kg: { type: 'number' },
            qty: { type: 'number', description: 'Net quantity in HTSUS units (box 35)' },
            qty_unit: { type: 'string', description: 'e.g. NO (pieces), KG, DOZ' },
            value: { type: 'number', description: 'Entered value USD (box 36A)' },
            charges: { type: 'number', description: 'Box 36B charges (CHGS), USD' },
            mpf: { type: 'number' }, hmf: { type: 'number' },
            invoice_no: { type: 'string' },
            product_codes: { type: 'array', items: { type: 'string' }, description: 'Product / item codes written on the line or next to it, e.g. "DPS 001", "SWS 001 & SST 001" → ["SWS 001","SST 001"]' },
            pos: { type: 'array', items: { type: 'string' }, description: 'PO numbers written for this line' },
          },
          required: ['hts'],
        },
      },
      summary: { type: 'string', description: 'One sentence: what was entered, total duty and fees' },
    },
    required: ['is_entry_summary', 'lines'],
  },
};

const HTS_TOOL = {
  name: 'review_hts',
  description: 'Review the declared HTS code of each customs entry line against what the product actually is.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_no: { type: 'string' },
            verdict: { type: 'string', enum: ['ok', 'suggest', 'unsure'], description: 'ok = the declared code fits; suggest = a different 10-digit code fits better; unsure = not enough information' },
            suggested_hts: { type: 'string', description: '10-digit HTSUS code when verdict is suggest' },
            reason: { type: 'string', description: 'One or two plain sentences: why, naming the deciding fact (material, use, age grade…)' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            same_duty: { type: 'boolean', description: 'true when the suggested code has the same general duty rate (e.g. only the statistical suffix differs)' },
          },
          required: ['line_no', 'verdict', 'reason', 'confidence'],
        },
      },
    },
    required: ['lines'],
  },
};

async function read({ text = '', files = [] }) {
  const content = [];
  for (const f of files.slice(0, 4)) {
    const n = String(f.name || '').toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    const mt = MIMES[ext] || (/^image\/(png|jpeg|webp|gif)$/.test(f.type || '') ? f.type : /pdf/.test(f.type || '') ? 'application/pdf' : null);
    if (!mt || !f.buffer?.length || f.buffer.length > 15 * 1024 * 1024) continue;
    content.push(mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text: `Read this US Customs entry summary (CBP 7501). Dates are US format (MM/DD/YY). Copy numbers exactly as printed; leave out anything not shown. Each line can carry several tariff numbers: the chapter 1–97 HTS number is "hts"; chapter 99 numbers (9903…) go in "extras" with their own rate and dollar amount. Product codes and PO numbers are often handwritten or typed next to a line.\n\n${String(text).slice(0, 20000)}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 4000 });
  return result || {};
}

const rateOf = (t) => { const s = String(t || '').trim(); if (!s) return null; if (/free/i.test(s)) return 0; const n = num(s); return n == null ? null : n; };

/** Normalised entry from the AI result. */
function normalize(r) {
  const lines = (Array.isArray(r.lines) ? r.lines : []).map((l, i) => {
    const extras = (Array.isArray(l.extras) ? l.extras : []).map((x) => ({ code: fmtHts(x.code), label: String(x.label || '').slice(0, 120), rate: rateOf(x.rate), rate_text: String(x.rate || ''), amount: num(x.amount) }));
    const base = num(l.duty);
    const duty = r2((base || 0) + extras.reduce((a, x) => a + (x.amount || 0), 0));
    return {
      no: String(l.line_no || String(i + 1).padStart(3, '0')), description: String(l.description || '').slice(0, 200), hts: fmtHts(l.hts),
      rate: rateOf(l.rate), rate_text: String(l.rate || ''), base_duty: base, extras, duty,
      qty: num(l.qty), unit: String(l.qty_unit || '').toUpperCase().slice(0, 8), kg: num(l.gross_kg), value: num(l.value), charges: num(l.charges),
      mpf: num(l.mpf), hmf: num(l.hmf), invoice: l.invoice_no ? String(l.invoice_no) : null,
      codes: [...new Set((Array.isArray(l.product_codes) ? l.product_codes : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10),
      pos: [...new Set((Array.isArray(l.pos) ? l.pos : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10),
    };
  });
  return {
    entry_no: r.entry_no ? String(r.entry_no).toUpperCase().replace(/\s+/g, '') : null, entry_type: r.entry_type || null,
    summary_date: PL.isoDay(r.summary_date), entry_date: PL.isoDay(r.entry_date), import_date: PL.isoDay(r.import_date), export_date: PL.isoDay(r.export_date),
    port_code: r.port_code ? String(r.port_code) : null, carrier: r.carrier || null, voyage: r.voyage || null,
    mbl: r.mbl ? code(r.mbl) : null, hbls: (Array.isArray(r.hbls) ? r.hbls : []).map((x) => code(String(x).split(/\s+/).pop())).filter(Boolean),
    packages: num(r.packages), origin: r.country_of_origin || null, foreign_port: r.foreign_port || null,
    importer_last4: r.importer_no_last4 ? String(r.importer_no_last4).replace(/\D/g, '').slice(-4) : null,
    broker: r.broker || null, broker_file: r.broker_file || null,
    entered_value: num(r.entered_value) ?? r2(lines.reduce((a, l) => a + (l.value || 0), 0)),
    duty: num(r.duty) ?? r2(lines.reduce((a, l) => a + l.duty, 0)), tax: num(r.tax), other: num(r.other), total: num(r.total),
    mpf: num(r.mpf), hmf: num(r.hmf),
    pos: [...new Set([...(Array.isArray(r.pos) ? r.pos : []), ...lines.flatMap((l) => l.pos)].map((x) => String(x).trim()).filter(Boolean))].slice(0, 30),
    lines, summary: r.summary ? String(r.summary).slice(0, 500) : '',
  };
}

/** Container, PO lines and catalog products for an entry. */
async function link(db, e, { containerId = null, poHint = [] } = {}) {
  const cs = await db.list('plan_containers').catch(() => []);
  const scs = await db.list('ship_confirmations').catch(() => []);
  let container = containerId ? cs.find((c) => c.id === containerId) : null; let reason = container ? 'added on this shipment' : null;
  const same = (a, b) => a && b && code(a) === code(b);
  if (!container) {
    for (const h of e.hbls) {
      const c = cs.find((x) => same(x.fwd?.hbl_no, h)) || cs.find((x) => scs.some((s) => s.container_id === x.id && (same(s.bl_no, h) || same(s.facts?.bl_no, h))));
      if (c) { container = c; reason = `house B/L ${h}`; break; }
    }
  }
  if (!container && e.mbl) { const c = cs.find((x) => same(x.fwd?.mbl_no, e.mbl)); if (c) { container = c; reason = `master B/L ${e.mbl}`; } }
  const allLines = await db.list('plan_orders').catch(() => []);
  const pos = [...new Set([...e.pos, ...poHint].map(PL.normPo))].filter(Boolean);
  if (!container && pos.length) {
    const ids = [...new Set(allLines.filter((l) => l.container_id && pos.includes(PL.normPo(l.po))).map((l) => l.container_id))];
    if (ids.length === 1) { container = cs.find((c) => c.id === ids[0]); reason = `PO ${e.pos.join(', ')}`; }
  }
  // order lines in scope: the container's, plus any PO written on the entry
  const scope = allLines.filter((l) => (container && l.container_id === container.id) || pos.includes(PL.normPo(l.po)));
  const prodCache = {};
  const prodsOf = async (sid) => (prodCache[sid] ||= await db.list('products', { filters: { supplier_id: sid } }).catch(() => []));
  const allProds = await db.list('products').catch(() => []);
  for (const ln of e.lines) {
    const found = [];
    for (const c0 of ln.codes) {
      const k = code(c0);
      let o = scope.find((x) => code(x.sku) === k) || scope.find((x) => code(x.product).startsWith(k)) || allLines.find((x) => code(x.sku) === k) || allLines.find((x) => code(x.product).startsWith(k));
      let p = null;
      if (o) p = PL.catalogMatch(o, await prodsOf(o.supplier_id));
      if (!p) p = allProds.find((x) => code(x.supplier_sku) === k) || allProds.find((x) => code(x.product_name).startsWith(k)) || null;
      // how sure: the SKU itself (automatic) or only the name (to confirm in the review)
      const how = !p ? null : code(p.supplier_sku) === k || (o && code(o.sku) === k) ? 'sku' : 'name';
      if (!o && p) o = scope.find((x) => x.supplier_id === p.supplier_id && PL.catalogMatch(x, [p])) || null;
      found.push({ code: c0, how, product_id: p?.id || null, name: p?.product_name || o?.product || c0, supplier_id: p?.supplier_id || o?.supplier_id || null, po: o?.po || null, line_id: o?.id || null, unit_price: num(o?.unit_price), qty: num(o?.qty), hts_on_file: p?.hts_verified_code || null, supplier_hs: p?.hs_code || null, description: p?.description || null, materials: p?.materials || null, category: p?.category || null, subcategory: p?.subcategory || null });
    }
    // split the line's value, duty and fees between its products: by PO value, else by quantity, else equally
    const w = found.map((f) => (f.unit_price && f.qty ? f.unit_price * f.qty : null));
    const useW = w.every((x) => x > 0) ? w : found.map((f) => f.qty || null).every((x) => x > 0) ? found.map((f) => f.qty) : found.map(() => 1);
    const tot = useW.reduce((a, x) => a + x, 0) || 1;
    const fees = (ln.mpf || 0) + (ln.hmf || 0);
    ln.products = found.map((f, i) => {
      const share = useW[i] / tot;
      const qty = found.length === 1 ? ln.qty : f.qty && useW === w ? f.qty : ln.qty ? Math.round(ln.qty * share) : null;
      const duty = r2(ln.duty * share); const fee = r2(fees * share);
      return { ...f, share: Math.round(share * 1000) / 1000, value: ln.value != null ? r2(ln.value * share) : null, qty, duty, fees: fee, per_pc: qty ? Math.round(((duty + fee) / qty) * 1000) / 1000 : null };
    });
    ln.basis = found.length > 1 ? (useW === w ? 'PO value' : useW.every((x) => x === 1) ? 'equally' : 'quantity') : null;
    ln.pos = [...new Set([...ln.pos, ...found.map((f) => f.po).filter(Boolean)])];
  }
  // one spelling per PO: the portal's when it knows the PO ("PO310002"), else as written without "PO#"
  const spell = (p) => { const k = PL.normPo(p); return allLines.find((l) => PL.normPo(l.po) === k)?.po || k; };
  const uniq = (list) => [...new Map(list.filter(Boolean).map((p) => [PL.normPo(p), spell(p)])).values()];
  for (const ln of e.lines) ln.pos = uniq(ln.pos);
  const allPos = uniq([...e.pos, ...e.lines.flatMap((l) => l.pos), ...(container ? allLines.filter((l) => l.container_id === container.id).map((l) => l.po) : [])]);
  return { container_id: container?.id || null, match_reason: reason, pos: allPos };
}

/** Email to the customs broker about what doesn't match (English). Returns null when nothing needs asking. */
function brokerDraft(e, { to = '', from = 'Lulyboo' } = {}) {
  const f = e.facts || {};
  const asks = [];
  for (const c of e.checks || []) {
    if (c.level === 'ok') continue;
    if (c.kind === 'math') for (const it of c.items || []) asks.push(it.line ? `Line ${it.line}${it.hts ? ` (HTS ${it.hts}${it.description ? `, ${String(it.description).toLowerCase()}` : ''})` : ''}: ${it.text}.` : `${it.text[0].toUpperCase()}${it.text.slice(1)}.`);
    else if (c.kind === 'declare') asks.push(`Line ${c.line}: ${c.text.replace(/^[^:]+: /, '').replace(/\.$/, '')}. Our checked classification for this product is ${c.declare} — could you confirm which code is correct${c.extra ? ' and amend the entry if needed' : ''}?`);
    else if (/HTS on file|HTS changed/.test(c.text)) asks.push(`Line ${c.line}: ${c.text.replace(/\.$/, '')} — could you confirm the classification?`);
    else if (/differs from the PO price/.test(c.text)) asks.push(`Line ${c.line}: ${c.text.replace(/\.$/, '')} — please confirm the entered value.`);
  }
  for (const l of e.lines || []) if (l.suggestion?.verdict === 'suggest' && l.suggestion.hts && l.suggestion.status !== 'rejected') asks.push(`Line ${l.no}: declared ${l.hts}; we think ${fmtHts(l.suggestion.hts)} may fit better${l.suggestion.reason ? ` (${String(l.suggestion.reason).replace(/\.$/, '')})` : ''}. Could you check?`);
  if (!asks.length) return null;
  const ref = [e.entry_no ? `entry ${e.entry_no}` : 'this entry', f.broker_file ? `your file ${f.broker_file}` : '', e.entry_date ? `entry date ${String(e.entry_date).slice(0, 10)}` : ''].filter(Boolean).join(', ');
  const subject = `Entry ${e.entry_no || ''} — please check ${asks.length === 1 ? 'one item' : `${asks.length} items`}`.replace(/\s+/g, ' ');
  const body = [`Hello${f.broker ? ` ${f.broker} team` : ''},`, '', `We are reviewing the entry summary for ${ref}${(e.hbls || []).length ? ` (HBL ${e.hbls.join(', ')})` : ''} and some figures don't match on our side:`, '', ...asks.map((a) => `- ${a}`), '', 'Could you please check these and confirm the correct figures, or send a corrected 7501 if anything needs to be amended?', '', 'Thank you,', from].join('\n');
  return { to, subject, body };
}

/** Checks: math, vs past entries, vs HTS on file, PO price. Returns [{ level, text, line? }]. */
async function checks(db, e, { selfId = null } = {}) {
  const out = []; const money = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // duty math. When every duty amount on a line points to the same entered value, the value was most likely
  // misread (or the entry has a different value) — said that way instead of listing each amount as wrong.
  const bad = []; const items = [];
  for (const l of e.lines) {
    const pairs = [...(l.rate && l.base_duty != null ? [[l.hts, l.rate, l.base_duty]] : []), ...l.extras.filter((x) => x.rate && x.amount != null).map((x) => [x.code, x.rate, x.amount])];
    const off = pairs.filter(([, rate, amt]) => l.value != null && Math.abs(l.value * rate / 100 - amt) > 1);
    if (!off.length) continue;
    const implied = pairs.map(([, rate, amt]) => (amt * 100) / rate);
    const same = implied.every((v) => Math.abs(v - implied[0]) <= Math.max(1, implied[0] * 0.005));
    if (same) {
      const v = Math.round(implied[0] * 100) / 100;
      bad.push(`line ${l.no}: the duty amounts fit an entered value of ${money(v)}, not ${money(l.value)}`);
      items.push({ line: l.no, hts: l.hts, description: l.description, text: `the duty amounts (${pairs.map(([c, rate, amt]) => `${c} ${rate}% = ${money(amt)}`).join(', ')}) correspond to an entered value of ${money(v)}, but the line shows ${money(l.value)}`, implied: v, value: l.value });
    } else for (const [c, rate, amt] of off) {
      bad.push(`line ${l.no}: ${c} ${rate}% of ${money(l.value)} is ${money(l.value * rate / 100)}, entry says ${money(amt)}`);
      items.push({ line: l.no, hts: l.hts, description: l.description, text: `${c} at ${rate}% of the ${money(l.value)} entered value is ${money(l.value * rate / 100)}, but the entry shows ${money(amt)}` });
    }
  }
  const lineDuty = r2(e.lines.reduce((a, l) => a + l.duty, 0));
  if (e.duty != null && Math.abs(lineDuty - e.duty) > 1) { bad.push(`lines add up to ${money(lineDuty)} duty, the total says ${money(e.duty)}`); items.push({ text: `the line duties add up to ${money(lineDuty)}, but the total duty shows ${money(e.duty)}` }); }
  const fees = (e.mpf || 0) + (e.hmf || 0);
  if (e.total != null && e.duty != null && Math.abs(e.duty + (e.tax || 0) + (e.other ?? fees) - e.total) > 1) { bad.push(`duty + fees ≠ total ${money(e.total)}`); items.push({ text: `duty + fees do not add up to the ${money(e.total)} total` }); }
  if (bad.length) out.push({ level: 'bad', kind: 'math', items, text: `Duty math doesn't add up — ${bad.join('; ')}. Check the PDF first: a value read wrong shows up here too.` });
  else if (e.lines.length) out.push({ level: 'ok', text: `Duty math checks out: every rate × entered value matches, and the total is ${money(e.total ?? (e.duty || 0) + fees)}.` });
  // same entry saved before
  if (e.entry_no) {
    const dup = (await db.list('customs_entries', { filters: { entry_no: e.entry_no } }).catch(() => [])).find((x) => x.status === 'saved' && x.id !== selfId);
    if (dup) out.push({ level: 'warn', text: `Entry ${e.entry_no} is already saved (${PL.short(String(dup.entry_date || dup.created_at).slice(0, 10))}) — saving replaces it.` });
  }
  // vs past entries per product
  const past = (await db.list('customs_entries', { order: 'entry_date.desc' }).catch(() => [])).filter((x) => x.status === 'saved' && x.id !== selfId && x.entry_no !== e.entry_no);
  // the products as they are now: a checked "code to declare" (Customs records → HTS classification)
  const ids = [...new Set(e.lines.flatMap((l) => (l.products || []).map((p) => p.product_id)).filter(Boolean))];
  const cat = {}; for (const id of ids) cat[id] = await db.get('products', id).catch(() => null);
  const same = [];
  for (const l of e.lines) {
    const rate = (l.rate || 0) + l.extras.reduce((a, x) => a + (x.rate || 0), 0);
    for (const p of l.products || []) {
      const label = `${p.code}${p.name && code(p.name) !== code(p.code) ? ` (${p.name})` : ''}`;
      const pr = p.product_id ? cat[p.product_id] : null;
      const dec = pr?.hts_declare_code ? digits(pr.hts_declare_code) : null;
      let flagged = false;
      if (dec && dec !== digits(l.hts).slice(0, dec.length)) {
        const dPct = Number(pr.hts_declare_pct);
        const diff = Number.isFinite(dPct) ? Math.round((rate - dPct) * 10) / 10 : null;
        const extra = diff != null && p.value ? r2(p.value * diff / 100) : null;
        const pc = extra != null && p.qty ? Math.round((extra / p.qty) * 1000) / 1000 : null;
        out.push({ level: 'warn', kind: 'declare', line: l.no, product_id: p.product_id, hts: l.hts, declare: fmtHts(dec), diff, extra, text: `${label}: declared ${l.hts} — your checked code is ${fmtHts(dec)}${diff ? ` (${diff > 0 ? '+' : '−'}${Math.abs(diff)} pts${pc ? ` ≈ ${diff > 0 ? '+' : '−'}${`$${Math.abs(pc).toFixed(3)}`}/pc` : ''}${extra ? ` · ${money(Math.abs(extra))} ${diff > 0 ? 'more' : 'less'} on this entry` : ''})` : ''}.` });
        flagged = true;
      } else if (p.hts_on_file && !(dec && dec === digits(p.hts_on_file)) && digits(p.hts_on_file).slice(0, 10) !== digits(l.hts).slice(0, digits(p.hts_on_file).length)) { out.push({ level: 'warn', line: l.no, product_id: p.product_id || null, text: `${label}: declared ${l.hts}, but the HTS on file is ${fmtHts(p.hts_on_file)}.` }); flagged = true; }
      if (p.unit_price && p.qty && p.value) { const pc = p.value / p.qty; if (Math.abs(pc - p.unit_price) / p.unit_price > 0.1) out.push({ level: 'warn', line: l.no, text: `${label}: entered value ${money(pc)}/pc differs from the PO price ${money(p.unit_price)}/pc.` }); }
      const prev = p.product_id ? past.map((x) => ({ x, l: (x.lines || []).find((y) => (y.products || []).some((q) => q.product_id === p.product_id)) })).find((y) => y.l) : null;
      if (!prev) continue;
      const pl = prev.l; const pRate = (pl.rate || 0) + (pl.extras || []).reduce((a, x) => a + (x.rate || 0), 0);
      const when = PL.short(String(prev.x.entry_date || prev.x.created_at).slice(0, 10));
      const htsChanged = digits(pl.hts) !== digits(l.hts);
      // changed on purpose (now the checked code to declare) → said once, as good news
      if (htsChanged && dec && dec === digits(l.hts).slice(0, dec.length)) out.push({ level: 'ok', kind: 'hts_prev', line: l.no, product_id: p.product_id, text: `${label}: declared the checked code ${l.hts} (was ${pl.hts} on the ${when} entry).` });
      else if (htsChanged) { out.push({ level: 'warn', kind: 'hts_prev', line: l.no, product_id: p.product_id, text: `${label}: HTS changed since the last import — ${pl.hts} on the ${when} entry, ${l.hts} now.` }); flagged = true; }
      const added = l.extras.filter((x) => !(pl.extras || []).some((y) => digits(y.code) === digits(x.code)));
      const gone = (pl.extras || []).filter((y) => !l.extras.some((x) => digits(x.code) === digits(y.code)));
      if (Math.abs(rate - pRate) >= 0.05 || added.length || gone.length) {
        const why = [...added.map((x) => `new ${x.code}${x.label ? ` (${x.label.toLowerCase()})` : ''} +${x.rate}%`), ...gone.map((x) => `${x.code} gone`)].join(', ');
        out.push({ level: rate > pRate ? 'warn' : 'ok', kind: 'rate', line: l.no, product_id: p.product_id, text: `${label}: ${htsChanged ? '' : 'same HTS, '}duty ${rate > pRate ? 'up' : 'down'} from ${Math.round(pRate * 10) / 10}% (${when}) to ${Math.round(rate * 10) / 10}%${why ? ` — ${why}` : ''}.` });
        flagged = true;
      }
      if (!flagged && !htsChanged) same.push(p.code);
    }
  }
  if (same.length) out.push({ level: 'ok', kind: 'same', text: `${[...new Set(same)].join(', ')}: same HTS and duty rate as the last import.` });
  const rank = { bad: 0, warn: 1, ai: 2, ok: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** AI review of each line's HTS against the catalog. Adds line.suggestion. */
async function reviewHts(e) {
  if (!AI.enabled() || !e.lines.length) return;
  const facts = e.lines.map((l) => ({ line_no: l.no, declared_hts: l.hts, declared_description: l.description, entered_value: l.value, quantity: l.qty, unit: l.unit, gross_kg: l.kg,
    products: (l.products || []).map((p) => ({ code: p.code, name: p.name, description: p.description, materials: p.materials, category: [p.category, p.subcategory].filter(Boolean).join(' / '), supplier_hs_code: p.supplier_hs, hts_on_file: p.hts_on_file })) }));
  try {
    const { result } = await AI.callTool({ tool: HTS_TOOL, maxTokens: 2000, content: [{ type: 'text', text: `You are a US customs classification assistant for Lulyboo, an importer of baby / infant / toddler and pet products. For each customs entry line below, judge whether the declared 10-digit HTSUS code fits the products, using their catalog details. Toys and articles for babies: mind the statistical suffix for the age grade (9503.00.0071 is "under 3 years of age", 9503.00.0073 is "3 to 12 years of age"). Only suggest a different code when a catalog fact supports it; otherwise say "ok" or "unsure". This is advice for the importer to confirm with their customs broker.\n\n${JSON.stringify(facts, null, 1)}` }] });
    for (const r of result?.lines || []) {
      const l = e.lines.find((x) => String(x.no) === String(r.line_no) || Number(x.no) === Number(r.line_no)); if (!l) continue;
      const sug = r.verdict === 'suggest' && r.suggested_hts && digits(r.suggested_hts) !== digits(l.hts) ? fmtHts(r.suggested_hts) : null;
      l.suggestion = { verdict: sug ? 'suggest' : r.verdict === 'suggest' ? 'ok' : r.verdict, hts: sug, reason: String(r.reason || '').slice(0, 500), confidence: r.confidence || 'low', same_duty: !!r.same_duty, status: 'open' };
    }
  } catch (err) { console.error('HTS review failed:', err.message); }
}

async function storeFiles(db, files = []) {
  const out = [];
  for (const f of files) {
    if (!f.buffer?.length || f.buffer.length > 25 * 1024 * 1024) continue;
    const safe = String(f.name || 'file').replace(/[^\w.\-()]+/g, '_').slice(-120) || 'file';
    const ext = (safe.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    const path = `customs/${new Date().toISOString().slice(0, 7)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const type = MIMES[ext] || (f.type && !/octet/.test(f.type) ? f.type : 'application/octet-stream');
    try { await db.docs.upload(path, f.buffer, type); out.push({ name: String(f.name || safe).slice(0, 200), path, type, size: f.buffer.length }); } catch (err) { console.error('Customs file upload failed:', err.message); }
  }
  return out;
}

/** Read, link, check → a pending entry. */
async function createEntry(db, config, { files = [], text = '', source = 'upload', from = '', containerId = null, poHint = [], by = null, notify = false }) {
  if (!AI.enabled()) throw Object.assign(new Error('AI is off — add ANTHROPIC_API_KEY to read customs entries'), { status: 400 });
  const raw = await read({ text, files });
  if (raw.is_entry_summary === false && !(raw.lines || []).length) throw Object.assign(new Error("This doesn't look like a customs entry summary (CBP 7501)"), { status: 400 });
  const e = normalize(raw);
  const l = await link(db, e, { containerId, poHint });
  await reviewHts(e);
  const stored = await storeFiles(db, files);
  const row = await db.insert('customs_entries', {
    entry_no: e.entry_no, entry_date: e.entry_date || e.import_date || e.summary_date, status: 'pending', source, from_email: String(from || '').slice(0, 300),
    container_id: l.container_id, match_reason: l.match_reason, pos: l.pos, mbl: e.mbl, hbls: e.hbls,
    entered_value: e.entered_value, duty: e.duty, fees: r2((e.mpf || 0) + (e.hmf || 0)) || e.other, total: e.total ?? r2((e.duty || 0) + (e.mpf || 0) + (e.hmf || 0)),
    facts: { ...e, lines: undefined }, lines: e.lines, files: stored, created_by: by, created_at: now(),
  });
  row.checks = await checks(db, { ...e, lines: e.lines }, { selfId: row.id });
  await db.update('customs_entries', { id: row.id }, { checks: row.checks }).catch(() => null);
  if (notify) {
    const P = require('./projects');
    const link2 = `${config.publicUrl}/admin/logistics/customs?review=${row.id}`;
    await P.notifyOwner(config, `[Customs entry] ${e.entry_no || ''} — duty $${(e.duty || 0).toLocaleString('en-US')}`, `${e.summary || ''}\n\n${link2}`, { title: 'Customs entry to review', intro: `${e.entry_no || 'Entry'}: duty $${(e.duty || 0).toLocaleString('en-US')} on $${(e.entered_value || 0).toLocaleString('en-US')}.`, button: 'Review', link: link2 }).catch(() => null);
  }
  return row;
}

/** Save: the entry counts in the statistics; the 7501 is kept with each PO; a confirmed HTS goes on the product. */
async function save(db, entry, { by = null } = {}) {
  if (entry.entry_no) for (const old of (await db.list('customs_entries', { filters: { entry_no: entry.entry_no } }).catch(() => [])).filter((x) => x.status === 'saved' && x.id !== entry.id)) await db.update('customs_entries', { id: old.id }, { status: 'replaced' });
  const recheck = await checks(db, { ...(entry.facts || {}), lines: entry.lines || [] }, { selfId: entry.id });
  await db.update('customs_entries', { id: entry.id }, { status: 'saved', saved_at: now(), saved_by: by, checks: recheck });
  // each linked product: the rate actually paid on its latest import is what pricing uses from now on
  for (const l of entry.lines || []) for (const p of l.products || []) if (p.product_id) await setPaid(db, p.product_id, { rate: lineRate(l), at: entry.entry_date, entry: entry.entry_no });
  // the 7501 on each PO's documents (once per supplier)
  const lines = await db.list('plan_orders').catch(() => []);
  const bySup = {};
  for (const po of entry.pos || []) for (const l of lines.filter((x) => PL.normPo(x.po) === PL.normPo(po))) (bySup[l.supplier_id] ||= new Set()).add(l.po);
  for (const [sid, pos] of Object.entries(bySup)) {
    const have = await db.list('plan_files', { filters: { supplier_id: sid } }).catch(() => []);
    for (const f of entry.files || []) {
      if (have.some((h) => h.path === f.path)) continue;
      await db.insert('plan_files', { supplier_id: sid, name: f.name, path: f.path, size: f.size, content_type: f.type, kind: 'Customs entry', pos: [...pos], uploaded_by: by, created_at: now() }).catch(() => null);
    }
  }
}

/** Confirm a line's HTS for its products (the declared code, or the AI suggestion). */
async function confirmHts(db, entry, lineNo, which, by = null) {
  const lines = entry.lines || [];
  const l = lines.find((x) => String(x.no) === String(lineNo)); if (!l) throw Object.assign(new Error('Line not found'), { status: 404 });
  const hts = which === 'suggested' ? l.suggestion?.hts : which === 'dismiss' ? null : l.hts;
  if (which !== 'dismiss' && !hts) throw Object.assign(new Error('No code to confirm'), { status: 400 });
  if (hts) for (const p of l.products || []) if (p.product_id) await db.update('products', { id: p.product_id }, { hts_verified_code: digits(hts), updated_at: now() }).catch(() => null);
  l.suggestion = { ...(l.suggestion || {}), status: which === 'dismiss' ? 'dismissed' : which === 'suggested' ? 'accepted' : 'kept', decided_by: by, decided_at: now() };
  for (const p of l.products || []) if (hts) p.hts_on_file = digits(hts);
  await db.update('customs_entries', { id: entry.id }, { lines });
  return { hts: hts ? fmtHts(hts) : null, products: (l.products || []).filter((p) => p.product_id).length };
}

/** Record the duty rate paid on a product's import, if it is its latest (needs supabase/customs-products.sql). */
async function setPaid(db, productId, { rate, at, entry }) {
  const p = await db.get('products', productId).catch(() => null); if (!p || rate == null) return false;
  const d = at ? String(at).slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (p.duty_paid_at && String(p.duty_paid_at).slice(0, 10) > d) return false;
  if (Number(p.duty_paid_pct) === rate && String(p.duty_paid_at || '').slice(0, 10) === d) return false;
  await db.update('products', { id: productId }, { duty_paid_pct: rate, duty_paid_at: d, duty_paid_entry: entry || null }).catch(() => null);
  return true;
}

/**
 * Delete an entry for good, and undo what it fed: each product's "duty paid" goes back to its latest other saved
 * entry (or is cleared), the 7501 copies on the POs' documents and the stored files go, records forget the link.
 * Returns { products: n restored, cleared: n }.
 */
async function removeEntry(db, e) {
  const out = { products: 0, cleared: 0 };
  const others = (await db.list('customs_entries').catch(() => [])).filter((x) => x.id !== e.id && x.status === 'saved').sort((a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || '')));
  const ids = [...new Set((e.lines || []).flatMap((l) => (l.products || []).map((p) => p.product_id)).filter(Boolean))];
  for (const id of ids) {
    const p = await db.get('products', id).catch(() => null); if (!p) continue;
    if (p.duty_paid_entry && e.entry_no && p.duty_paid_entry !== e.entry_no) continue; // a newer import already set it
    let prev = null;
    for (const x of others) { const l = (x.lines || []).find((y) => (y.products || []).some((q) => q.product_id === id)); if (l) { prev = { rate: lineRate(l), at: x.entry_date, entry: x.entry_no }; break; } }
    if (prev) { await db.update('products', { id }, { duty_paid_pct: prev.rate, duty_paid_at: prev.at ? String(prev.at).slice(0, 10) : null, duty_paid_entry: prev.entry || null }).catch(() => null); out.products++; }
    else { await db.update('products', { id }, { duty_paid_pct: null, duty_paid_at: null, duty_paid_entry: null }).catch(() => null); out.cleared++; }
  }
  const paths = (e.files || []).map((f) => f.path).filter(Boolean);
  if (paths.length) {
    for (const pf of await db.list('plan_files').catch(() => [])) if (paths.includes(pf.path)) await db.remove('plan_files', { id: pf.id }).catch(() => null);
    await db.docs.remove(paths).catch(() => null);
  }
  for (const c of await db.list('plan_containers').catch(() => [])) {
    const files = c.record?.files || [];
    if (!files.some((x) => x.ai?.entry_id === e.id)) continue;
    await db.update('plan_containers', { id: c.id }, { record: { ...c.record, files: files.map((x) => (x.ai?.entry_id === e.id ? { ...x, ai: { ...x.ai, entry_id: null, note: 'Its customs entry was deleted — Re-read to add it again.' } } : x)) } }).catch(() => null);
  }
  await db.remove('customs_entries', { id: e.id });
  return out;
}

/** Effective rate of a line (base + chapter 99), %. */
const lineRate = (l) => Math.round(((l.rate || 0) + (l.extras || []).reduce((a, x) => a + (x.rate || 0), 0)) * 10) / 10;

module.exports = { removeEntry, setPaid, brokerDraft, TOOL, HTS_TOOL, read, normalize, link, checks, reviewHts, createEntry, save, confirmHts, lineRate, fmtHts, digits, customsAddress, missingTable };
