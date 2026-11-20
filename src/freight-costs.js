'use strict';
// Freight costs: every forwarder offer compared all-in per container, a catalog of every additional charge
// (with internal notes on what it is and when it applies), actual costs from freight invoices, and history.
//   Offers live in freight_quotes (RFQ replies are copied there already; offers added from a PDF / screenshot / email
//   are stored there too, quote_id null). Charges on an offer are mapped to the catalog (charge_types) by aliases.
//   All-in for one container = ocean + every "always" charge (amount × quantity from its unit: B/L, entry, HTS line,
//   day with a minimum, % of drayage) + "if needed" charges × how often they happened on your own invoices.
//   A charge the forwarder did not quote is estimated from your typical (other quotes, then invoices, then default).

const AI = require('./ai');
const PL = require('./planning');
const SC = require('./schedules');

const now = () => new Date().toISOString();
const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const usd = (v, d = 2) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const missingTable = (e) => /charge_types|freight_actuals|freight_quotes|PGRST20[45]|relation|column/i.test(e?.message || '');

const GROUPS = { ocean: 'Ocean', port: 'Port & terminal', customs: 'Customs', trucking: 'Drayage & chassis', extra: 'Extras' };
const UNITS = { container: 'per container', bl: 'per B/L', entry: 'per entry', line: 'per HTS line', day: 'per day', hour: 'per hour', pct_drayage: '% of drayage', each: 'each time', shipment: 'per shipment' };
const WHEN = { always: 'always', if_needed: 'if needed' };
const DEFAULT_ADDRESS = '15041 Bake Parkway Suite K, Irvine, CA 92618';
const DOOR_DAYS = 3; // ETA → at the warehouse

/** The starting catalog. Notes are drafts to edit; rates empty (they come from your quotes and invoices). */
const DEFAULTS = [
  ['docs', 'Documentation', 'port', 'bl', 'always', 0, 0, ['documentation', 'doc fee', 'docs fee', 'b l fee', 'bl fee', 'document fee'],
    'The forwarder\'s fee for issuing / handling the bill of lading and the delivery order at destination. Charged once per B/L on every shipment.'],
  ['isf', 'ISF filing', 'customs', 'entry', 'always', 0, 0, ['isf', 'importer security filing', '10 2', '10+2'],
    'Importer Security Filing ("10+2") sent to US Customs at least 24 hours before the container is loaded in China. Required for every ocean shipment; late or missing ISF can be fined $5,000.'],
  ['entry', 'Customs entry', 'customs', 'entry', 'always', 0, 0, ['customs entry', 'customs clearance', 'entry fee', 'clearance', 'customs brokerage', 'brokerage'],
    'The customs broker\'s fee to file the entry (CBP 7501) and clear the goods. Usually covers the first 5 HTS lines; extra lines cost more (often $10 per line). Needs an active customs bond.'],
  ['cpsc', 'CPSC fee', 'customs', 'line', 'always', 0, 0, ['cpsc'],
    'Filing for products regulated by the Consumer Product Safety Commission (children\'s products: certificates, eFiling). Charged per HTS line on baby and toy shipments. "As costs" means billed at the broker\'s actual cost.'],
  ['pierpass', 'Pier Pass (TMF)', 'port', 'container', 'always', 0, 0, ['pier pass', 'pierpass', 'tmf', 'traffic mitigation'],
    'Traffic Mitigation Fee charged by the LA / Long Beach terminals on every container picked up (per 20\' or 40\'). Set by PierPass, the same for every forwarder.'],
  ['ctf', 'Clean Truck Fee', 'port', 'container', 'always', 0, 0, ['clean truck', 'ctf'],
    'Port of LA / Long Beach fee on containers moved by trucks, funding cleaner trucks. Per container, the same for every forwarder.'],
  ['drayage', 'Drayage', 'trucking', 'container', 'always', 0, 0, ['drayage', 'trucking', 'delivery charge', 'port to warehouse', 'cartage', 'pick up and delivery', 'pickup delivery'],
    'Trucking the container from the terminal to our warehouse and returning the empty. Priced per container to a given address; check the address on the quote.'],
  ['fuel', 'Fuel surcharge', 'trucking', 'pct_drayage', 'always', 0, 0, ['fuel', 'fsc', 'fuel surcharge'],
    'Percentage added to the drayage price for diesel cost. Changes with fuel prices (often 15–30%).'],
  ['chassis', 'Chassis', 'trucking', 'day', 'always', 2, 0, ['chassis', 'chassis usage', 'chassis rental', 'chs'],
    'The trailer frame the container sits on while trucked. Charged per day from terminal pick-up until the empty is returned, usually with a 2-day minimum. Goes up when unloading is late or the empty can\'t be returned. Keep it low: book the delivery appointment before ETA and unload the same day.'],
  ['prepull', 'Pre-pull', 'trucking', 'container', 'if_needed', 0, 0, ['pre pull', 'prepull', 'pre-pull'],
    'The trucker takes the container out of the terminal before the delivery day and parks it at their yard — used when the last free day is close or the warehouse can\'t receive in time. Adds yard storage and chassis days.'],
  ['split', 'Chassis split', 'trucking', 'each', 'if_needed', 0, 0, ['chassis split', 'split'],
    'Extra trip when the chassis has to be picked up or returned at a different place than the container (off-terminal chassis pool).'],
  ['waiting', 'Terminal waiting time', 'trucking', 'hour', 'if_needed', 0, 2, ['terminal waiting', 'waiting time', 'terminal wait'],
    'The truck waits at the terminal beyond the free time (often 2 hours), e.g. congestion or a hold.'],
  ['detention', 'Driver detention', 'trucking', 'hour', 'if_needed', 0, 2, ['driver detention', 'driver waiting', 'live unload waiting'],
    'The driver waits at our warehouse beyond the free time (often 2 hours) during a live unload. Keep it low: have the dock and team ready at the appointment time.'],
  ['storage', 'Yard storage', 'trucking', 'day', 'if_needed', 0, 0, ['storage', 'yard storage'],
    'Per-day storage at the trucker\'s yard, usually after a pre-pull or when we can\'t receive.'],
  ['drop', 'Drop fee', 'trucking', 'container', 'if_needed', 0, 0, ['drop fee', 'drop and pick', 'drop pick'],
    'The container is left at our warehouse on its chassis to unload later, and picked up again — two trips. Adds chassis days.'],
  ['exam', 'Customs exam', 'customs', 'each', 'if_needed', 0, 0, ['exam', 'cet', 'x ray', 'vacis', 'intensive exam', 'tailgate'],
    'Random or targeted inspection by US Customs (X-ray / VACIS, tailgate or intensive at a CES). We pay the exam, trucking to the exam station and storage; can add days.'],
  ['demurrage', 'Demurrage', 'port', 'day', 'if_needed', 0, 0, ['demurrage'],
    'Terminal charge per day the full container stays at the port after the free days. Avoid by picking up (or pre-pulling) before the last free day.'],
  ['perdiem', 'Per diem', 'port', 'day', 'if_needed', 0, 0, ['per diem', 'container detention', 'equipment detention'],
    'Carrier charge per day we keep the container (full or empty) outside the terminal after the free days. Avoid by returning the empty quickly.'],
  ['thc', 'Destination THC', 'port', 'container', 'if_needed', 0, 0, ['thc', 'dthc', 'terminal handling'],
    'Terminal handling at the destination port. Often included in the ocean rate for CY-CY quotes; check if a forwarder adds it.'],
];

async function catalog(db) {
  let rows;
  try { rows = await db.list('charge_types', { order: 'sort.asc' }); } catch (e) { if (missingTable(e)) return { rows: [], missing: true }; throw e; }
  if (!rows.length) {
    let i = 0;
    for (const [code, name, group, unit, when, min, free, aliases, note] of DEFAULTS) {
      await db.insert('charge_types', { code, name, grp: group, unit, when_applies: when, min_qty: min || null, free_qty: free || null, aliases, note, note_draft: true, sort: ++i, created_at: now() }).catch(() => null);
    }
    rows = await db.list('charge_types', { order: 'sort.asc' }).catch(() => []);
  }
  return { rows };
}

/** Which catalog charge a charge line is: the longest alias (or the name) found in it. */
function matchType(types, name) {
  const n = ` ${norm(name)} `; let best = null; let len = 0;
  for (const t of types) for (const a of [t.name, ...(t.aliases || [])]) { const k = norm(a); if (k && n.includes(` ${k} `) && k.length > len) { best = t; len = k.length; } }
  return best;
}

/** A charge line from an RFQ reply ({name, amount, per}) or an offer read here ({name, amount, unit, min, free, when}). */
function normCharge(c) {
  const per = norm(c.per || '');
  const unit = c.unit || (/%/.test(String(c.per || c.name)) ? 'pct_drayage' : /\bday\b/.test(per) ? 'day' : /hour|hr/.test(per) ? 'hour' : /line/.test(per) ? 'line' : /\bb l\b|bl|bill/.test(per) ? 'bl' : /entry/.test(per) ? 'entry' : /container|cntr|ctr|20|40/.test(per) ? 'container' : null);
  return { name: String(c.name || '').slice(0, 60), amount: c.amount == null || c.amount === '' ? null : Number(c.amount), unit, min: c.min ?? null, free: c.free ?? null, when: c.when || null, note: c.note || '' };
}

// ── Reading an offer (PDF / screenshot / pasted email) ───────────────────────────
const OFFER_TOOL = {
  name: 'read_freight_offer',
  description: 'Record a forwarder\'s freight offer exactly as written.',
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'The forwarder (company issuing the quote)' },
      ref: { type: 'string', description: 'Quote reference / number' },
      quoted_on: { type: 'string', description: 'Quote date or "valid from", YYYY-MM-DD' },
      valid_until: { type: 'string', description: 'YYYY-MM-DD' },
      pol: { type: 'string', description: 'Port of loading as written' }, pod: { type: 'string', description: 'Port of discharge as written' },
      box: { type: 'string', enum: ['20GP', '40GP', '40HQ', 'LCL', 'unknown'], description: 'The container type the main rate is for' },
      ocean_usd: { type: 'number', description: 'Ocean freight for ONE container of that type (or per W/M for LCL), USD' },
      carrier: { type: 'string', description: 'Carrier; "Various" when not fixed' },
      etd: { type: 'string', description: 'YYYY-MM-DD' }, eta: { type: 'string', description: 'YYYY-MM-DD' },
      transit_days: { type: 'number' }, cutoff: { type: 'string', description: 'CY or SI cut-off, YYYY-MM-DD' },
      delivery_to: { type: 'string', description: 'Delivery address for drayage, as written' },
      charges: {
        type: 'array',
        description: 'EVERY other charge line (destination / local / trucking / extras). Skip duty, insurance and bond. Give the amount for the container type of this quote (e.g. Pier Pass for a 40\' when the quote is for a 40\'HQ).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, amount: { type: 'number', description: 'USD per unit; for a percentage give the number (20 for 20%). Omit when "at cost" / "as costs".' },
            unit: { type: 'string', enum: Object.keys(UNITS) }, min: { type: 'number', description: 'Minimum quantity, e.g. 2 for "min 2 days"' },
            free: { type: 'number', description: 'Free quantity before charging, e.g. 2 for "first two hours free"' },
            when: { type: 'string', enum: ['always', 'if_needed', 'at_cost'], description: 'if_needed when the quote says "if needed", "if apply", "if applicable"' },
            note: { type: 'string', description: 'Any condition, e.g. "first 5 lines incl., $10 per line after"' },
          },
          required: ['name', 'unit', 'when'],
        },
      },
      notes: { type: 'string', description: 'Important remarks, e.g. "rate for reference only, subject to space"' },
    },
    required: ['ocean_usd', 'charges'],
  },
};

const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function blockOf(f) {
  const ext = (String(f.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const mt = MIMES[ext] || (/^image\//.test(f.type || '') ? f.type : /pdf/.test(f.type || '') ? 'application/pdf' : null);
  if (!mt) return null;
  return mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data: f.buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: mt === 'image/gif' ? 'image/png' : mt, data: f.buffer.toString('base64') } };
}

const portCode = (s) => { const t = String(s || ''); const p = SC.ORIGINS.find((x) => x.alias.test(t) || x.name.toLowerCase() === t.toLowerCase()); return p ? p.code : null; };

/** Read an offer. files: [{name,type,buffer}], text: pasted email. Returns the fields for freight_quotes (no id). */
async function readOffer({ files = [], text = '', box = null }) {
  const content = files.map(blockOf).filter(Boolean);
  content.push({ type: 'text', text: `Today is ${PL.today()}. ${box ? `We are comparing offers for a ${box}. ` : ''}Read this freight offer for Lulyboo (importer, goods from China to Los Angeles / Long Beach). Record only what it states. Dates like 11/20/26 or "Dec 4" are US format; assume the next such date from today.${text ? `\n\nEMAIL / TEXT:\n${String(text).slice(0, 12000)}` : ''}` });
  const { result: r } = await AI.callTool({ tool: OFFER_TOOL, content, maxTokens: 2500 });
  const day = (v) => (v ? PL.isoDay(v) : null);
  const b = r.box && r.box !== 'unknown' ? r.box : box || '40HQ';
  return {
    company: String(r.company || '').slice(0, 120) || null, ref: String(r.ref || '').slice(0, 60) || null,
    quoted_on: day(r.quoted_on) || PL.today(), valid_until: day(r.valid_until), box: b,
    pol: portCode(r.pol), pol_text: r.pol || null, pod: 'LALB', ocean_usd: r2(r.ocean_usd), carrier: r.carrier || null,
    etd: day(r.etd), eta: day(r.eta), transit_days: r.transit_days ? Math.round(r.transit_days) : (day(r.etd) && day(r.eta) ? Math.round((Date.parse(day(r.eta)) - Date.parse(day(r.etd))) / 864e5) : null),
    cutoff: day(r.cutoff), delivery_to: r.delivery_to ? String(r.delivery_to).slice(0, 200) : null,
    charges: (r.charges || []).map((c) => normCharge({ ...c, when: c.when })).filter((c) => c.name).slice(0, 40),
    notes: r.notes ? String(r.notes).slice(0, 500) : null,
  };
}

// ── Actual costs (freight invoices) ─────────────────────────────────────────
/**
 * Actual cost lines per container: freight invoices read on record-only shipments + invoices added on the
 * Actual costs tab (freight_actuals). Returns [{ container_id, box, label, company, invoice_no, date, lines: [{name, usd, type}], total }].
 */
async function actuals(db, types) {
  const out = [];
  const conts = await db.list('plan_containers').catch(() => []);
  const SN = require('./shipname');
  for (const c of conts) {
    for (const x of (c.record?.files || [])) {
      if (x.ai?.type !== 'invoice') continue;
      const fx = x.ai.facts || {};
      const lines = [...(fx.ocean_usd ? [{ name: 'Ocean freight', usd: fx.ocean_usd, ocean: true }] : []), ...(fx.charges || []).map((l) => ({ name: l.name, usd: l.usd }))];
      if (!lines.length) continue;
      out.push({ container_id: c.id, box: c.box, label: SN.shipName(c), company: fx.issuer || fx.carrier || null, invoice_no: fx.doc_no || null, date: fx.due_date || c.fwd?.ata || c.fwd?.atd || String(x.at || '').slice(0, 10), lines, src: 'record', name: x.name });
    }
  }
  for (const a of await db.list('freight_actuals', { order: 'invoice_date.desc' }).catch(() => [])) {
    const c = conts.find((y) => y.id === a.container_id);
    out.push({ id: a.id, container_id: a.container_id, box: a.box || c?.box || null, label: c ? SN.shipName(c) : (a.label || 'Shipment'), company: a.company, invoice_no: a.invoice_no, date: a.invoice_date, lines: a.lines || [], src: 'upload', name: (a.files || [])[0]?.name || '', file: (a.files || [])[0] || null });
  }
  for (const a of out) {
    for (const l of a.lines) { if (l.ocean || /^ocean|freight charge|^o f\b|sea freight/i.test(l.name)) { l.ocean = true; l.type = null; } else l.type = matchType(types, l.name)?.code || null; }
    a.total = r2(a.lines.reduce((s, l) => s + (Number(l.usd) || 0), 0));
  }
  return out;
}

/** Per charge: typical amount (per container) from quotes and invoices, how often it happened, quoted range. */
function typicals(types, offers, acts) {
  const byC = new Map(); for (const a of acts) byC.set(a.container_id, [...(byC.get(a.container_id) || []), a]);
  const nCont = byC.size;
  const out = {};
  for (const t of types) {
    const quoted = []; const unitRates = [];
    for (const o of offers) for (const c of (o.charges || []).map(normCharge)) if (c.amount != null && matchType(types, c.name)?.code === t.code) { unitRates.push(c.amount); }
    const perCont = []; let hits = 0;
    for (const [, list] of byC) { const s = list.flatMap((a) => a.lines).filter((l) => l.type === t.code).reduce((x, l) => x + (Number(l.usd) || 0), 0); if (s > 0) { perCont.push(s); hits++; } }
    out[t.code] = {
      rate: median(unitRates) ?? (t.rate_usd != null ? Number(t.rate_usd) : null), rateFrom: unitRates.length ? 'quotes' : t.rate_usd != null ? 'default' : null,
      low: unitRates.length ? Math.min(...unitRates) : null, high: unitRates.length ? Math.max(...unitRates) : null, nQuoted: unitRates.length,
      actual: median(perCont), nActual: perCont.length, freq: nCont >= 3 ? hits / nCont : null, nCont,
    };
    void quoted;
  }
  return out;
}

/** Quantity of a charge for one container. ctx: { lines, drayage, days } */
function qtyOf(unit, { min = null, free = null } = {}, ctx = {}) {
  switch (unit) {
    case 'line': return Math.max(1, ctx.lines || 1);
    case 'day': return Math.max(Number(min) || 1, ctx.days || 0, 1);
    case 'hour': return Math.max(0, (ctx.hours || 0) - (Number(free) || 0));
    default: return 1;
  }
}

/**
 * All-in for one offer and one container. Returns { rows: [{code, name, group, when, amount, how: quoted|est|expected|missing, detail}], ocean, total, missing: [names], other: [...] }.
 * ctx: { lines (HTS lines), typ (typicals), types }
 */
function allIn(offer, types, typ, ctx = {}) {
  const charges = (offer.charges || []).map(normCharge);
  const used = new Set(); const rows = [];
  const quotedOf = (t) => charges.find((c, i) => !used.has(i) && matchType(types, c.name)?.code === t.code && (used.add(i), true));
  const dray = (() => { const t = types.find((x) => x.code === 'drayage'); const q = t && charges.find((c) => matchType(types, c.name)?.code === 'drayage' && c.amount != null); return q ? q.amount : t ? typ[t.code]?.rate : null; })();
  for (const t of types) {
    const q = quotedOf(t);
    const ty = typ[t.code] || {};
    const min = q?.min ?? t.min_qty; const free = q?.free ?? t.free_qty;
    const unit = t.unit === 'pct_drayage' ? 'pct_drayage' : (q?.unit || t.unit);
    const amountOf = (rate) => (rate == null ? null : unit === 'pct_drayage' ? r2((rate / 100) * (dray || 0)) : r2(rate * qtyOf(unit, { min, free }, { lines: ctx.lines, days: unit === 'day' && t.code === 'chassis' ? Number(min) || 2 : 0 })));
    const qtyTxt = unit === 'line' ? `× ${Math.max(1, ctx.lines || 1)} lines` : unit === 'day' && min ? `min ${min} days` : unit === 'pct_drayage' ? 'of drayage' : '';
    if ((t.when_applies || 'always') === 'always') {
      if (q && q.amount != null && q.when !== 'at_cost') rows.push({ code: t.code, name: t.name, group: t.grp, when: 'always', amount: amountOf(q.amount), how: 'quoted', detail: [unit === 'pct_drayage' ? `${q.amount}%` : `${usd(q.amount)}${unit !== 'container' && UNITS[unit] ? ` ${UNITS[unit]}` : ''}`, qtyTxt].filter(Boolean).join(' ') });
      else if (ty.rate != null) rows.push({ code: t.code, name: t.name, group: t.grp, when: 'always', amount: amountOf(ty.rate), how: 'est', detail: `${q?.when === 'at_cost' ? 'at cost · ' : ''}${unit === 'pct_drayage' ? `${r2(ty.rate)}%` : usd(ty.rate)} typical${qtyTxt ? ` ${qtyTxt}` : ''}` });
      else rows.push({ code: t.code, name: t.name, group: t.grp, when: 'always', amount: null, how: 'missing', detail: q?.when === 'at_cost' ? 'at cost — no history yet' : 'not quoted, no history yet' });
    } else {
      const rate = q?.amount ?? ty.rate;
      const per = rate == null ? null : unit === 'pct_drayage' ? r2((rate / 100) * (dray || 0)) : r2(rate * (unit === 'hour' ? 1 : qtyOf(unit, { min, free }, ctx)));
      if (ty.freq && per != null) rows.push({ code: t.code, name: t.name, group: t.grp, when: 'if_needed', amount: r2(per * ty.freq), how: 'expected', detail: `${usd(per)} × ${Math.round(ty.freq * 100)}%`, quoted: !!q });
      else if (q) rows.push({ code: t.code, name: t.name, group: t.grp, when: 'if_needed', amount: null, how: 'quoted_if', detail: `${q.amount != null ? `${unit === 'pct_drayage' ? `${q.amount}%` : usd(q.amount)}${UNITS[unit] && unit !== 'container' ? ` ${UNITS[unit]}` : ''}` : 'at cost'}${free ? ` after ${free} free` : ''}`, quoted: true });
    }
  }
  const other = charges.filter((c, i) => !used.has(i) && c.amount != null && c.when !== 'if_needed').map((c) => ({ name: c.name, amount: r2(c.amount * (c.unit === 'line' ? Math.max(1, ctx.lines || 1) : 1)) }));
  const ocean = offer.ocean_usd != null ? Number(offer.ocean_usd) : null;
  const total = r2((ocean || 0) + rows.reduce((s, x) => s + (x.amount || 0), 0) + other.reduce((s, x) => s + x.amount, 0));
  return { rows, other, ocean, total, missing: rows.filter((x) => x.when === 'always' && x.how !== 'quoted').map((x) => x.name), unknown: rows.filter((x) => x.how === 'missing').map((x) => x.name) };
}

/** "Your typical" as an offer: median ocean of recent quotes for the box, every charge from typicals. */
function typicalOffer(offers, box) {
  const recent = offers.filter((o) => o.box === box && o.ocean_usd != null && String(o.quoted_on) >= PL.addDays(PL.today(), -90));
  return { company: 'Your typical', ocean_usd: median(recent.map((o) => Number(o.ocean_usd))), charges: [], n: recent.length, typical: true };
}

// ── AI: internal note draft and market price ──────────────────────────────────
const NOTE_TOOL = { name: 'charge_note', description: 'Explain a US import logistics charge for an internal team.', input_schema: { type: 'object', properties: { note: { type: 'string', description: '3–5 short sentences: what it is, who charges it, when it applies, how to keep it low. Plain English, no marketing.' }, aliases: { type: 'array', items: { type: 'string' }, description: 'Other names it appears under on quotes and invoices' } }, required: ['note'] } };
async function draftNote(t) {
  const { result } = await AI.callTool({ tool: NOTE_TOOL, maxTokens: 600, content: `Charge: ${t.name} (${UNITS[t.unit] || t.unit}, ${WHEN[t.when_applies] || ''}). Context: Lulyboo imports baby / home products in 20' / 40' containers from China to Los Angeles / Long Beach, trucked to a warehouse in Irvine, CA.` });
  return { note: String(result.note || '').slice(0, 1200), aliases: (result.aliases || []).map((a) => String(a).toLowerCase().slice(0, 40)).slice(0, 8) };
}

async function webSearch(prompt, fetchImpl = fetch) {
  const messages = [{ role: 'user', content: prompt }]; const sources = new Map(); let text = '';
  for (let i = 0; i < 4; i++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI.model(), max_tokens: 1200, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }] }), signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Web search failed (${res.status}). ${/web_search|not enabled|permission/i.test(t) ? 'Web search may not be enabled for your Anthropic account.' : ''}`.trim()); }
    const data = await res.json();
    for (const b of data.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) sources.set(r.url, r.title || r.url);
      if (b.type === 'text') { text += `${b.text}\n`; for (const c of b.citations || []) if (c.url) sources.set(c.url, c.title || c.url); }
    }
    if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
    break;
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })).slice(0, 6) };
}
const MARKET_TOOL = { name: 'market_price', description: 'Record a current market price range found in research notes.', input_schema: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' }, typical: { type: 'number' }, unit: { type: 'string' }, as_of: { type: 'string', description: 'Date of the figures, YYYY-MM-DD or month' }, summary: { type: 'string', description: 'One sentence with the range and what it covers' }, found: { type: 'boolean' } }, required: ['found', 'summary'] } };
async function marketCheck(t, { fetchImpl = fetch } = {}) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const { text, sources } = await webSearch(`Today is ${PL.today()}. What does "${t.name}" (${UNITS[t.unit] || t.unit}) currently cost for import containers at the ports of Los Angeles / Long Beach, trucked to the Irvine / Orange County area? Look for recent (last 6 months) published rates: trucker / drayage company rate sheets, forwarder tariffs, port or PierPass notices, industry news. Give figures with their dates and sources. If none is published, say so. Plain text, under 200 words.`, fetchImpl);
  if (!text) throw new Error('The web search returned nothing usable.');
  const { result } = await AI.callTool({ tool: MARKET_TOOL, maxTokens: 500, system: 'Use only numbers that appear in the notes. If there is no usable figure, found=false.', content: `Charge: ${t.name}, ${UNITS[t.unit] || t.unit}.\n\nNOTES:\n${text}` });
  return { found: !!result.found, low: r2(result.low), high: r2(result.high), typical: r2(result.typical), unit: result.unit || UNITS[t.unit] || '', as_of: result.as_of || null, summary: String(result.summary || '').slice(0, 300), sources, at: now() };
}

// ── History (charts and forwarder table) ───────────────────────────────────────
const monthOf = (d) => String(d || '').slice(0, 7);
function lastMonths(n, today = PL.today()) { const out = []; const d = new Date(`${today.slice(0, 7)}-15T12:00:00Z`); for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() - i); out.push(x.toISOString().slice(0, 7)); } return out; }

/** All-in per container by month, split by group: actual invoices; months with none fall back to the chosen quote. */
function monthlyAllIn(acts, offers, types, typ, box, months) {
  const per = Object.fromEntries(months.map((m) => [m, []]));
  const byC = new Map(); for (const a of acts.filter((x) => !box || x.box === box)) byC.set(a.container_id, [...(byC.get(a.container_id) || []), a]);
  for (const [, list] of byC) {
    const m = monthOf(list.map((a) => a.date).filter(Boolean).sort()[0]); if (!per[m]) continue;
    const g = { ocean: 0, port: 0, customs: 0, trucking: 0, extra: 0 };
    for (const l of list.flatMap((a) => a.lines)) { if (l.ocean) g.ocean += Number(l.usd) || 0; else { const t = types.find((x) => x.code === l.type); g[t ? (t.when_applies === 'if_needed' ? 'extra' : t.grp) : 'extra'] += Number(l.usd) || 0; } }
    per[m].push({ ...g, src: 'actual' });
  }
  for (const o of offers.filter((x) => x.chosen && (!box || x.box === box))) {
    const m = monthOf(o.etd || o.quoted_on); if (!per[m] || (o.container_id && byC.has(o.container_id))) continue;
    const a = allIn(o, types, typ, { lines: 3 });
    const g = { ocean: a.ocean || 0, port: 0, customs: 0, trucking: 0, extra: 0 };
    for (const r of a.rows) g[r.when === 'if_needed' ? 'extra' : r.group] += r.amount || 0;
    per[m].push({ ...g, src: 'quote' });
  }
  return months.map((m) => { const xs = per[m]; if (!xs.length) return { m, n: 0 }; const avg = (k) => r2(xs.reduce((s, x) => s + x[k], 0) / xs.length); return { m, n: xs.length, ocean: avg('ocean'), port: avg('port'), customs: avg('customs'), trucking: avg('trucking'), extra: avg('extra'), quoteOnly: xs.every((x) => x.src === 'quote') }; });
}

function oceanByForwarder(offers, box, months) {
  const fw = {};
  for (const o of offers) { if (o.box !== box || o.ocean_usd == null || !months.includes(monthOf(o.quoted_on)) || o.excluded) continue; const k = o.company || 'Unknown'; (fw[k] ||= {})[monthOf(o.quoted_on)] = [...((fw[k] || {})[monthOf(o.quoted_on)] || []), Number(o.ocean_usd)]; }
  return Object.entries(fw).map(([company, m]) => ({ company, n: Object.values(m).flat().length, points: months.map((x) => (m[x] ? median(m[x]) : null)) })).sort((a, b) => b.n - a.n).slice(0, 5);
}

function extrasTop(acts, types, months) {
  const t = {}; let n = new Set();
  for (const a of acts) { if (!months.includes(monthOf(a.date))) continue; n.add(a.container_id); for (const l of a.lines) { const ty = types.find((x) => x.code === l.type); if (!ty || ty.when_applies !== 'if_needed') continue; t[ty.name] = (t[ty.name] || 0) + (Number(l.usd) || 0); } }
  const list = Object.entries(t).map(([name, v]) => ({ name, v: r2(v) })).sort((a, b) => b.v - a.v);
  const sum = r2(list.reduce((s, x) => s + x.v, 0));
  return { list, sum, n: n.size, per: n.size ? r2(sum / n.size) : null };
}

function forwarderTable(offers, acts, types, typ, conts, box) {
  const by = {};
  for (const o of offers.filter((x) => (!box || x.box === box) && !x.excluded)) {
    const k = o.company || 'Unknown'; const f = (by[k] ||= { company: k, quotes: 0, booked: 0, ocean: [], allin: [], actual: [], reply: [], onTime: 0, withAta: 0 });
    f.quotes++; if (o.ocean_usd != null) f.ocean.push(Number(o.ocean_usd));
    const a = allIn(o, types, typ, { lines: 3 }); if (o.ocean_usd != null) f.allin.push(a.total);
    if (o.reply_hours != null) f.reply.push(Number(o.reply_hours));
    if (o.chosen) {
      f.booked++;
      const act = acts.filter((x) => x.container_id === o.container_id); if (act.length) f.actual.push({ q: a.total, a: act.reduce((s, x) => s + x.total, 0) });
      const c = conts.find((x) => x.id === o.container_id); const ata = c?.fwd?.ata;
      if (ata && o.eta) { f.withAta++; if (Date.parse(ata) - Date.parse(o.eta) <= 2 * 864e5) f.onTime++; }
    }
  }
  return Object.values(by).map((f) => ({ ...f, oceanAvg: f.ocean.length ? r2(f.ocean.reduce((a, b) => a + b, 0) / f.ocean.length) : null, allinAvg: f.allin.length ? r2(f.allin.reduce((a, b) => a + b, 0) / f.allin.length) : null,
    actualAvg: f.actual.length ? r2(f.actual.reduce((s, x) => s + x.a, 0) / f.actual.length) : null, variance: f.actual.length ? Math.round(((f.actual.reduce((s, x) => s + x.a, 0) - f.actual.reduce((s, x) => s + x.q, 0)) / f.actual.reduce((s, x) => s + x.q, 0)) * 1000) / 10 : null,
    replyMed: median(f.reply) })).sort((a, b) => b.quotes - a.quotes);
}

module.exports = { GROUPS, UNITS, WHEN, DEFAULTS, DEFAULT_ADDRESS, DOOR_DAYS, OFFER_TOOL, NOTE_TOOL, catalog, matchType, normCharge, readOffer, portCode, actuals, typicals, allIn, typicalOffer, draftNote, marketCheck, lastMonths, monthlyAllIn, oceanByForwarder, extrasTop, forwarderTable, median, usd, r2, missingTable };
