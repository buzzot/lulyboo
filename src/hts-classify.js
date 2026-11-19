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

/** Base rate + extras of one code. originExtras: country-wide extras from the last 7501 ([{code, rate}]). */
async function rateOf(code, { originExtras = [], fetchImpl } = {}) {
  const d = digits(code).slice(0, 10);
  const out = { hts: fmt(d), title: '', base: null, base_text: '', extras: [], total: null, specific: false, found: false };
  try {
    const rows = await duty.usitcSearch(duty.formatHts(d), fetchImpl);
    const c = duty.pickCandidates(rows, d)[0];
    if (c) {
      Object.assign(out, { found: true, title: c.description.slice(0, 160), base: c.parsed.ad_valorem, base_text: c.general, specific: !!c.parsed.specific });
      for (const ref of (c.chapter99 || []).slice(0, 4)) {
        if (/^9903\.01\./.test(ref)) continue; // country-wide: taken from the 7501 below
        const info = await duty.chapter99Info(ref, fetchImpl).catch(() => null);
        if (info?.plus_pct != null) out.extras.push({ code: ref, rate: info.plus_pct, label: /9903\.88/.test(ref) ? 'Section 301' : 'Chapter 99', from: 'USITC' });
      }
    }
  } catch { /* offline: no rate */ }
  for (const x of originExtras) if (!out.extras.some((y) => digits(y.code) === digits(x.code))) out.extras.push({ code: x.code, rate: x.rate, label: x.label || 'Country-wide', from: '7501' });
  out.total = out.base == null ? null : r1(out.base + out.extras.reduce((a, x) => a + (Number(x.rate) || 0), 0));
  return out;
}

/** Country-wide extras (9903.01.xx) on the last import, kept for every candidate. */
function originExtrasOf(last) {
  return (last?.extras || []).filter((x) => /^9903\.01\./.test(String(x.code || '')) && x.rate).map((x) => ({ code: x.code, rate: Number(x.rate), label: x.label || 'IEEPA' }));
}

/** What the duty comparison is based on: last import value/pc and qty, else the unit price. */
function basisOf(p, last) {
  const pc = last?.value_pc || (p.currency && p.currency !== 'USD' ? null : Number(p.unit_price) || null);
  return { value_pc: pc ? r2(pc) : null, qty: last?.qty ? Number(last.qty) : null, from: last?.value_pc ? `last import ${last.entry_no || ''}`.trim() : 'unit price' };
}
const dutyPc = (rate, b) => (rate == null || !b.value_pc ? null : Math.round(b.value_pc * rate * 10) / 1000);

/** Inputs for the model: photos (≤3), documents (≤2 PDFs / images ≤ 6 MB), fields, history. */
async function inputs(db, p, { customs = [] } = {}) {
  const S = require('./services');
  const content = [];
  const imgs = ((await S.imagesFor(db, [p.id]).catch(() => ({})))[p.id] || []).slice(0, 3);
  let nPhotos = 0;
  for (const im of imgs) { try { const b = await db.storage.download(im.path); if (b?.length) { content.push(ai.imageBlock ? ai.imageBlock(b) : { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: b.toString('base64') } }); nPhotos++; } } catch { /* skip */ } }
  const docs = (await db.list('supplier_documents', { filters: { product_id: p.id } }).catch(() => [])).filter((d) => /\.(pdf|png|jpe?g|webp)$/i.test(d.name || '') && (!d.bytes || d.bytes < 6 * 1024 * 1024));
  docs.sort((a, b) => (a.kind === 'specification' ? -1 : 0) - (b.kind === 'specification' ? -1 : 0));
  const used = [];
  for (const d of docs.slice(0, 2)) {
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
  content.unshift({ type: 'text', text: `Classify this product for US import. ${nPhotos} photo(s)${used.length ? ` and ${used.length} document(s) (${used.join(', ')})` : ''} attached.\n${JSON.stringify(fields, null, 1)}` });
  return { content, sources: { photos: nPhotos, docs: used, fields: Object.keys(fields).filter((k) => fields[k] !== undefined && !(Array.isArray(fields[k]) && !fields[k].length)) } };
}

/** Rate every code of a review (candidates + original + to-declare). Mutates and returns review. */
async function rateAll(review, p, last, { fetchImpl } = {}) {
  const oe = originExtrasOf(last);
  const b = basisOf(p, last);
  const codes = [...new Set([...(review.candidates || []).map((c) => digits(c.hts)), digits(review.original), digits(p.hts_declare_code)].filter((c) => c.length >= 6))];
  const rates = {};
  for (const c of codes) rates[c] = await rateOf(c, { originExtras: oe, fetchImpl });
  for (const c of review.candidates || []) {
    const r = rates[digits(c.hts)] || {};
    Object.assign(c, { hts: r.hts || fmt(c.hts), usitc_title: r.title || '', base: r.base ?? null, base_text: r.base_text || '', extras: r.extras || [], total: r.total ?? null, specific: !!r.specific, found: !!r.found, duty_pc: dutyPc(r.total, b) });
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
  const best = c.find((x) => x.fit === 'strong') || c[0] || null;
  const ok = c.filter((x) => x.fit !== 'weak' && x.total != null);
  const cheap = ok.sort((a, b) => a.total - b.total)[0] || null;
  return { best, cheap: cheap && best && digits(cheap.hts) !== digits(best.hts) && cheap.total < (best.total ?? Infinity) ? cheap : null };
}

/** Run the classification. Returns { review, customs_description }. */
async function classify(db, p, { customs = [], by = null, fetchImpl } = {}) {
  if (!ai.enabled()) throw Object.assign(new Error('AI is not configured: set ANTHROPIC_API_KEY'), { status: 503 });
  const last = customs[0] || null;
  const { content, sources } = await inputs(db, p, { customs });
  const { result } = await ai.callTool({ tool: TOOL, system: SYSTEM, content, maxTokens: 2500 });
  const seen = new Set();
  const candidates = (result.candidates || []).map((c) => ({ hts: digits(c.hts).slice(0, 10), title: String(c.title || '').slice(0, 80), fit: FITS.includes(c.fit) ? c.fit : 'possible', why: String(c.why || '').slice(0, 500) }))
    .filter((c) => c.hts.length >= 8 && !seen.has(c.hts) && seen.add(c.hts)).slice(0, 4);
  if (!candidates.length) throw Object.assign(new Error('AI returned no usable HTS code'), { status: 502 });
  const original = digits(p.hts_original_code || (last && last.hts) || p.hts_verified_code || p.hs_code).slice(0, 10) || null;
  const review = { candidates, summary: String(result.summary || '').slice(0, 300), missing: (result.missing_facts || []).map((x) => String(x).slice(0, 200)).slice(0, 6), original, sources, at: now(), by, model: ai.model() };
  await rateAll(review, p, last, { fetchImpl });
  return { review, customs_description: String(result.customs_description || '').trim().slice(0, 2000) };
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

module.exports = { TOOL, SYSTEM, classify, recheck, rateOf, rateAll, picks, compare, brokerEmail, patch, originExtrasOf, basisOf, inputs };
