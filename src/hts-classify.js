'use strict';
// HTS classification of one product, for customs (Product → Customs records → "HTS classification").
//   AI reads the photos, the catalog fields and the attached spec / documents once (re-run on request) and writes
//   1. a customs description — plain facts a classifier needs (what it is, who uses it, materials by weight, function).
//      Stored on the product for declarations and AI only; it is not shown in the catalog.
//   2. candidate HTS codes, most correct first, each with a fit (strong / possible / weak) and why.
//   Rates are NOT from the model: the base rate is read from the USITC schedule; extras are the Chapter 99 headings the
//   USITC line points to (Section 301 lists) plus the country-wide extras (9903.01.xx — IEEPA) paid on the last 7501.
//   Duty per piece uses the last import's value per piece (else the unit price), per import the last import's qty.
//   Nothing changes on its own: a person ticks "I checked" and saves a code to declare; the original code is kept.

const ai = require('./ai');
const duty = require('./duty');

const digits = (s) => String(s || '').replace(/\D/g, '');
// 7501 style: 3922.20.0000
const fmt = (c) => { const d = digits(c).slice(0, 10); return d.length > 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : duty.formatHts(d); };
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const now = () => new Date().toISOString();
const FITS = ['strong', 'possible', 'weak'];

const TOOL = {
  name: 'classify_product',
  description: 'Classify one product under the US HTSUS for import, and describe it for customs.',
  input_schema: {
    type: 'object',
    properties: {
      customs_description: { type: 'string', description: 'Factual description for customs, 2–5 sentences: what the article is, its function, who it is for (age grade for children\'s goods), materials with approximate share by weight, construction (knitted / woven / molded…), size. No marketing words. Only facts from the photos, fields and documents; say "not stated" for what is unknown.' },
      summary: { type: 'string', description: 'One sentence: what this product is, for the importer.' },
      candidates: {
        type: 'array', minItems: 1, maxItems: 4,
        description: 'HTSUS 10-digit codes that could apply, MOST CORRECT FIRST. Include the code currently on file if it is plausible. Never rank a code higher because its duty is lower.',
        items: {
          type: 'object',
          properties: {
            hts: { type: 'string', description: '10-digit HTSUS code, e.g. 9503.00.0073' },
            title: { type: 'string', description: 'Short name of the tariff line, under 60 characters' },
            fit: { type: 'string', enum: FITS },
            why: { type: 'string', description: 'One or two sentences: which product facts support or weaken this code (GRI, chapter notes).' },
          },
          required: ['hts', 'fit', 'why'],
        },
      },
      missing_facts: { type: 'array', items: { type: 'string' }, description: 'Facts that would change the classification and are not in the input (e.g. exact fibre content, age grade on the label).' },
    },
    required: ['customs_description', 'candidates'],
  },
};

const SYSTEM = `You are a licensed-broker-level US customs classification analyst for Lulyboo, an importer of infant / toddler, pet and home products (mostly made in China).
Classify by the General Rules of Interpretation, section and chapter notes and the statistical suffixes (for toys mind the age grade: 9503.00.0071 under 3 years, 9503.00.0073 3 to 12 years).
Rank candidates by correctness only. Duty cost is compared by the importer afterwards; it never decides your ranking.
Use only facts shown in the photos, fields and documents. If a fact that decides the code is missing, say so in missing_facts and mark the fit "possible" rather than guess.
This is advice: the importer and their customs broker decide.`;

const clean = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const refsOf = (r) => [...new Set([...(Array.isArray(r.footnotes) ? r.footnotes : []).map((f) => (typeof f === 'string' ? f : f?.value || '')), String(r.additionalDuties || ''), String(r.general || '')].join(' ').match(/9903\.\d{2}\.\d{2}/g) || [])];
const is301 = (c) => /^9903\.88\./.test(String(c || ''));
const is232 = (c) => /^9903\.8[0-5]\./.test(String(c || ''));

/**
 * The official lines for a code: the code itself, its 8-digit line and its heading (USITC search results).
 * The rate of a 10-digit statistical line sits on its 8-digit line, so the nearest rated line up the chain is used.
 */
async function lineOf(d, fetchImpl) {
  const keys = [duty.formatHts(d), d.length > 8 ? duty.formatHts(d.slice(0, 8)) : null, d.length > 6 ? duty.formatHts(d.slice(0, 6)) : null, d.slice(0, 4)].filter(Boolean);
  const rows = new Map();
  for (const k of keys) {
    try { for (const r of await duty.usitcSearch(k, fetchImpl)) { const x = digits(r.htsno); if (x.length >= 4 && d.startsWith(x)) rows.set(x, r); } } catch { /* offline */ }
    // stop once the code's own line and a rate are both known
    const have = [...rows.keys()];
    if (have.includes(d) && have.includes(d.slice(0, 4)) && have.some((x) => String(rows.get(x).general || '').trim())) break;
  }
  const chain = [...rows.entries()].sort((a, b) => a[0].length - b[0].length).map(([, r]) => r);
  return { chain, own: rows.get(d) || null, rated: [...chain].reverse().find((r) => String(r.general || '').trim()) || null };
}

/** Base rate + extras of one code. ctx: { originExtras, s301 } from the last 7501. */
async function rateOf(code, { originExtras = [], s301 = null, lastHts = null, fetchImpl } = {}) {
  const d = digits(code).slice(0, 10);
  const out = { hts: fmt(d), title: '', official: '', base: null, base_text: '', extras: [], total: null, specific: false, found: false, notes: [] };
  const { chain, own, rated } = await lineOf(d, fetchImpl);
  out.official = chain.map((r) => clean(r.description)).filter(Boolean).join(' › ').slice(0, 400);
  out.title = clean((own || chain[chain.length - 1])?.description).slice(0, 160);
  out.found = !!own;
  if (!own && chain.some((r) => digits(r.htsno).length >= 8)) out.notes.push('statistical suffix not found in the schedule');
  else if (!own) out.notes.push('code not found in the US schedule');
  if (rated) {
    const p = duty.parseGeneralRate(rated.general);
    Object.assign(out, { base: p.ad_valorem, base_text: String(rated.general).trim(), specific: !!p.specific });
    const refs = [...new Set(chain.flatMap(refsOf))];
    for (const ref of refs.slice(0, 6)) {
      if (!is301(ref) && !is232(ref)) continue; // country-wide measures: taken from the 7501 below
      const info = await duty.chapter99Info(ref, fetchImpl).catch(() => null);
      if (info?.plus_pct != null) out.extras.push({ code: ref, rate: info.plus_pct, label: is301(ref) ? 'Section 301' : 'Section 232', from: 'USITC' });
    }
  }
  // Section 301: paid on the last import but not listed for this code by USITC → same 8 digits: as paid; else assumed (verify)
  if (s301 && !out.extras.some((x) => is301(x.code))) {
    const same8 = lastHts && digits(lastHts).slice(0, 8) === d.slice(0, 8);
    out.extras.push({ code: s301.code, rate: s301.rate, label: same8 ? 'Section 301' : 'Section 301 (assumed)', from: same8 ? '7501' : 'assumed' });
    if (!same8) out.notes.push(`Section 301 ${s301.rate}% assumed — check the code is on the China 301 lists`);
  }
  for (const x of originExtras) if (!out.extras.some((y) => digits(y.code) === digits(x.code))) out.extras.push({ code: x.code, rate: x.rate, label: x.label || 'Country-wide', from: '7501' });
  out.total = out.base == null ? null : r1(out.base + out.extras.reduce((a, x) => a + (Number(x.rate) || 0), 0));
  if (out.base == null && rated) out.notes.push(`rate “${out.base_text}” is not a percentage`);
  return out;
}

/** Country-wide extras on the last import (IEEPA etc.: every Chapter 99 line except Section 301 / 232), kept for every candidate. */
function originExtrasOf(last) {
  return (last?.extras || []).filter((x) => /^9903\./.test(String(x.code || '')) && !is301(x.code) && !is232(x.code) && x.rate).map((x) => ({ code: x.code, rate: Number(x.rate), label: x.label || 'Country-wide' }));
}
const s301Of = (last) => { const x = (last?.extras || []).find((e) => is301(e.code) && e.rate); return x ? { code: x.code, rate: Number(x.rate) } : null; };

/** What the duty comparison is based on: last import value/pc and qty, else the unit price. */
function basisOf(p, last) {
  const pc = last?.value_pc || (p.currency && p.currency !== 'USD' ? null : Number(p.unit_price) || null);
  return { value_pc: pc ? r2(pc) : null, qty: last?.qty ? Number(last.qty) : null, from: last?.value_pc ? `last import ${last.entry_no || ''}`.trim() : 'unit price' };
}
const dutyPc = (rate, b) => (rate == null || !b.value_pc ? null : Math.round(b.value_pc * rate * 10) / 1000);

/** Inputs for the model: photos (≤3), documents (≤2 PDFs / images ≤ 6 MB), fields, history. */
async function inputs(db, p, { customs = [], reuse = false, note = '' } = {}) {
  const noteText = String(note || '').trim() ? `\n\nImporter's note (facts about the goods, from the importer): ${String(note).trim().slice(0, 1500)}` : '';
  const S = require('./services');
  const content = [];
  // re-run: the saved customs description stands in for the photos and documents (far fewer tokens)
  if (reuse && p.customs_description) {
    const f = { name: p.product_name, sku: p.supplier_sku, customs_description: p.customs_description, materials: p.materials, country_of_origin: p.country_of_origin || 'China (assumed)', supplier_hs_code: p.hs_code || undefined, declared_on_imports: [...new Set(customs.map((x) => x.hts).filter(Boolean))] };
    content.push({ type: 'text', text: `Classify this product for US import. No photos this time: use the customs description, written earlier from the photos and documents; return it unchanged as customs_description unless a fact in it is contradicted.\n${JSON.stringify(f, null, 1)}${noteText}` });
    return { content, sources: { ...(p.hts_review?.sources || {}), reused: true } };
  }
  const imgs = ((await S.imagesFor(db, [p.id]).catch(() => ({})))[p.id] || []).slice(0, 3);
  let nPhotos = 0;
  for (const im of imgs) { try { const b = await db.storage.download(im.path); if (b?.length) { content.push(ai.imageBlock ? ai.imageBlock(b) : { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: b.toString('base64') } }); nPhotos++; } } catch { /* skip */ } }
  const docs = (await db.list('supplier_documents', { filters: { product_id: p.id } }).catch(() => [])).filter((d) => /\.(pdf|png|jpe?g|webp)$/i.test(d.name || '') && (!d.bytes || d.bytes < 6 * 1024 * 1024));
  const prio = (d) => (d.kind === 'customs' ? 0 : d.kind === 'specification' ? 1 : 2);   // files added for customs first, then the spec
  docs.sort((a, b) => prio(a) - prio(b) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const used = [];
  for (const d of docs.slice(0, 3)) {
    try {
      const b = await db.docs.download(d.path); if (!b?.length) continue;
      const ext = (d.name.toLowerCase().match(/\.([a-z]+)$/) || [])[1];
      content.push(ext === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', data: b.toString('base64') } });
      used.push(d.name);
    } catch { /* skip */ }
  }
  const fields = {
    name: p.product_name, sku: p.supplier_sku, category: [p.category, p.subcategory].filter(Boolean).join(' / ') || undefined,
    description: p.description ? String(p.description).slice(0, 2500) : undefined, materials: p.materials, size_cm: p.product_size_cm,
    age_grade: p.age_range || p.age_grade || undefined, country_of_origin: p.country_of_origin || 'China (assumed)',
    supplier_hs_code: p.hs_code || undefined, hts_on_file: p.hts_verified_code ? duty.formatHts(p.hts_verified_code) : undefined,
    declared_on_imports: [...new Set(customs.map((x) => x.hts).filter(Boolean))],
    previous_customs_description: p.customs_description || undefined,
  };
  content.unshift({ type: 'text', text: `Classify this product for US import. ${nPhotos} photo(s)${used.length ? ` and ${used.length} document(s) (${used.join(', ')})` : ''} attached.\n${JSON.stringify(fields, null, 1)}${noteText}` });
  return { content, sources: { photos: nPhotos, docs: used, fields: Object.keys(fields).filter((k) => fields[k] !== undefined && !(Array.isArray(fields[k]) && !fields[k].length)) } };
}

/** Rate every code of a review (candidates + original + to-declare). Mutates and returns review. */
async function rateAll(review, p, last, { fetchImpl } = {}) {
  const ctx = { originExtras: originExtrasOf(last), s301: s301Of(last), lastHts: last?.hts || null, fetchImpl };
  const b = basisOf(p, last);
  const codes = [...new Set([...(review.candidates || []).map((c) => digits(c.hts)), digits(review.original), digits(p.hts_declare_code)].filter((c) => c.length >= 6))];
  const rates = {};
  for (const c of codes) rates[c] = await rateOf(c, ctx);
  for (const c of review.candidates || []) {
    const r = rates[digits(c.hts)] || {};
    Object.assign(c, { hts: r.hts || fmt(c.hts), usitc_title: r.title || '', official: r.official || '', notes: r.notes || [], base: r.base ?? null, base_text: r.base_text || '', extras: r.extras || [], total: r.total ?? null, specific: !!r.specific, found: !!r.found, duty_pc: dutyPc(r.total, b) });
  }
  // the code last declared: the rate actually paid wins over the schedule
  const o = rates[digits(review.original)] || null;
  review.original_rate = o ? { ...o, paid: last && digits(last.hts) === digits(review.original) ? last.rate : null } : null;
  review.basis = b;
  review.rates_at = now();
  return review;
}

/** Recommended (most correct) and cost-effective (cheapest strong / possible fit). */
function picks(review) {
  const c = review.candidates || [];
  const real = c.filter((x) => x.found !== false && x.total != null);
  const best = real.find((x) => x.fit === 'strong') || real.find((x) => x.fit === 'possible') || null;
  const ok = c.filter((x) => x.fit !== 'weak' && x.total != null);
  const cheap = ok.sort((a, b) => a.total - b.total)[0] || null;
  return { best, cheap: cheap && best && digits(cheap.hts) !== digits(best.hts) && cheap.total < (best.total ?? Infinity) ? cheap : null };
}

/** Run the classification. Returns { review, customs_description }. */
async function classify(db, p, { customs = [], by = null, fetchImpl, reuse = false, note = '' } = {}) {
  if (!ai.enabled()) throw Object.assign(new Error('AI is not configured: set ANTHROPIC_API_KEY'), { status: 503 });
  const last = customs[0] || null;
  const { content, sources } = await inputs(db, p, { customs, reuse, note });
  const { result } = await ai.callTool({ tool: TOOL, system: SYSTEM, content, maxTokens: 2500 });
  const seen = new Set();
  const candidates = (result.candidates || []).map((c) => ({ hts: digits(c.hts).slice(0, 10), title: String(c.title || '').slice(0, 80), fit: FITS.includes(c.fit) ? c.fit : 'possible', why: String(c.why || '').slice(0, 700) }))
    .filter((c) => c.hts.length >= 8 && !seen.has(c.hts) && seen.add(c.hts)).slice(0, 4);
  if (!candidates.length) throw Object.assign(new Error('AI returned no usable HTS code'), { status: 502 });
  const original = digits(p.hts_original_code || (last && last.hts) || p.hts_verified_code || p.hs_code).slice(0, 10) || null;
  const review = { candidates, summary: String(result.summary || '').slice(0, 300), missing: (result.missing_facts || []).map((x) => String(x).slice(0, 200)).slice(0, 6), original, sources, at: now(), by, model: ai.model() };
  const desc = String(result.customs_description || '').trim().slice(0, 2000);
  await rateAll(review, p, last, { fetchImpl });
  await verify(review, desc, p, last, { fetchImpl });
  return { review, customs_description: desc };
}

const VERIFY_TOOL = {
  name: 'verify_codes',
  description: 'Check each proposed HTS code against its official USITC wording.',
  input_schema: {
    type: 'object',
    properties: {
      codes: { type: 'array', items: { type: 'object', properties: {
        hts: { type: 'string' },
        matches: { type: 'boolean', description: 'false when the official wording contradicts the product (wrong material, wrong article, not in the schedule)' },
        fit: { type: 'string', enum: FITS },
        why: { type: 'string', description: 'One or two short sentences, citing the official wording.' },
      }, required: ['hts', 'matches', 'fit', 'why'] } },
      better_hts: { type: 'string', description: 'Only if none of the codes fits: the 10-digit HTSUS code that does. Leave empty otherwise.' },
      better_why: { type: 'string' },
    },
    required: ['codes'],
  },
};

/** Second pass: the model checks each code against the official USITC text (catches e.g. "metal furniture" for a plastic item). */
async function verify(review, desc, p, last, { fetchImpl } = {}) {
  const list = review.candidates.map((c) => ({ hts: c.hts, official_usitc_text: c.official || '(not found in the US schedule)', in_schedule: c.found, first_opinion: { fit: c.fit, why: c.why } }));
  let result;
  try {
    ({ result } = await ai.callTool({ tool: VERIFY_TOOL, system: SYSTEM, maxTokens: 1500, content: [{ type: 'text', text: `Product (customs description): ${desc}\nMaterials on file: ${p.materials || 'not stated'}\n\nCheck every code against its OFFICIAL USITC text below — heading, subheading and statistical line. A code whose official text names a different material or article does not match, whatever the first opinion said. Codes not in the schedule do not match.\n${JSON.stringify(list, null, 1)}` }] }));
  } catch (e) { console.error('HTS verify failed:', e.message); review.verified = false; return review; }
  for (const v of result.codes || []) {
    const c = review.candidates.find((x) => digits(x.hts) === digits(v.hts)); if (!c) continue;
    Object.assign(c, { fit: v.matches === false ? 'weak' : FITS.includes(v.fit) ? v.fit : c.fit, why: String(v.why || c.why).slice(0, 700), matches: v.matches !== false });
  }
  const better = digits(result.better_hts).slice(0, 10);
  if (better.length >= 8 && !review.candidates.some((c) => digits(c.hts) === better)) {
    const r = await rateOf(better, { originExtras: originExtrasOf(last), s301: s301Of(last), lastHts: last?.hts || null, fetchImpl });
    if (r.found) review.candidates.push({ hts: r.hts, title: '', fit: 'strong', why: String(result.better_why || 'Proposed after checking the official text.').slice(0, 700), matches: true, usitc_title: r.title, official: r.official, notes: r.notes, base: r.base, base_text: r.base_text, extras: r.extras, total: r.total, specific: r.specific, found: true, duty_pc: dutyPc(r.total, review.basis || {}) });
  }
  // order: codes in the schedule that match, by fit (the model's order within a fit)
  const rank = (c) => (c.found === false || c.matches === false ? 10 : 0) + FITS.indexOf(c.fit);
  review.candidates = review.candidates.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c).slice(0, 5);
  review.verified = true;
  return review;
}

/** Re-check rates only (no AI): returns { review, changes: [text] }. */
async function recheck(p, last, { fetchImpl } = {}) {
  const review = JSON.parse(JSON.stringify(p.hts_review || { candidates: [], original: digits(p.hts_original_code || p.hts_verified_code || p.hs_code) }));
  const before = Object.fromEntries((review.candidates || []).map((c) => [digits(c.hts), c.total]));
  if (review.original_rate) before[digits(review.original)] ??= review.original_rate.total;
  await rateAll(review, p, last, { fetchImpl });
  const changes = [];
  for (const c of review.candidates) { const b = before[digits(c.hts)]; if (b != null && c.total != null && Math.abs(b - c.total) >= 0.05) changes.push(`${c.hts}: ${b}% → ${c.total}%`); }
  return { review, changes };
}

/** Duty comparison of original vs to-declare (or a candidate): per pc and per import. */
function compare(review, toCode) {
  if (!review) return null;
  const o = review.original_rate; const b = review.basis || {};
  const t = (review.candidates || []).find((c) => digits(c.hts) === digits(toCode));
  if (!o || !t) return null;
  const oRate = o.paid ?? o.total;
  if (oRate == null || t.total == null) return null;
  const oPc = dutyPc(oRate, b); const tPc = dutyPc(t.total, b);
  const save = oPc != null && tPc != null ? Math.round((oPc - tPc) * 1000) / 1000 : null;
  return { from: { hts: o.hts, rate: oRate, pc: oPc, paid: o.paid != null }, to: { hts: t.hts, rate: t.total, pc: tPc, fit: t.fit }, save_pc: save, save_import: save != null && b.qty ? r2(save * b.qty) : null, qty: b.qty, value_pc: b.value_pc, basis: b.from };
}

/** Draft email to the customs broker about the code to declare. */
function brokerEmail(p, review, toCode, { to = '', from = 'Lulyboo' } = {}) {
  const cmp = compare(review, toCode); const t = (review?.candidates || []).find((c) => digits(c.hts) === digits(toCode));
  if (!t) return null;
  const name = [p.supplier_sku, p.product_name].filter(Boolean).join(' — ');
  const lines = [
    'Hello,', '',
    `For our product ${name}, we would like to declare HTS ${t.hts} on the next entry${cmp ? ` instead of ${cmp.from.hts}, which was used on the last import` : ''}.`, '',
    'Product description for customs:', p.customs_description || '(see attached specification)', '',
    `Our reasoning: ${t.why}`,
    ...(cmp && cmp.save_pc ? ['', `Duty at the current rates: ${cmp.from.rate}% → ${t.total}% (about $${Math.abs(cmp.save_pc).toFixed(3)} per piece${cmp.save_import ? `, $${Math.abs(cmp.save_import).toLocaleString('en-US', { maximumFractionDigits: 0 })} on an import like the last one` : ''}).`] : []),
    '', `Could you please confirm ${t.hts} is correct for this article, or let us know which code you would use and why?`, '', 'Thank you,', from,
  ];
  return { to, subject: `HTS classification check — ${p.supplier_sku || p.product_name} (${t.hts})`, body: lines.join('\n') };
}

/** Columns to store after a classification. */
function patch({ review, customs_description }) {
  return { hts_review: review, customs_description: customs_description || null, hts_rates_at: review.rates_at };
}

module.exports = { TOOL, SYSTEM, classify, recheck, rateOf, rateAll, picks, compare, brokerEmail, patch, originExtrasOf, basisOf, inputs, s301Of };
