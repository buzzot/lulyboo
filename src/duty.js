'use strict';
// US import duty research for one product.
//
//   1. Official data: the USITC Harmonized Tariff Schedule (hts.usitc.gov REST API) gives the column-1 general
//      rate for an HTS code, plus the Chapter 99 headings (Section 301 etc.) its footnotes point to.
//   2. Judgment: Claude picks the best HTS line for the product, decides which additional measures apply to the
//      country of origin, and explains. Optionally (DUTY_WEB_SEARCH=true) it may look up current additional
//      tariffs on the web first (Anthropic web search tool).
//   3. Arithmetic is done HERE, not by the model: base rate comes from the USITC row; additional measures are
//      only counted when backed by USITC data or web research.
// The result is advisory: the admin confirms it, and can always override it by hand (see calc.js precedence).

const ai = require('./ai');

const USITC = 'https://hts.usitc.gov/reststop/search';
const CACHE = new Map(); // keyword → { at, rows }
const CACHE_MS = 24 * 3600 * 1000;

const digits = (s) => String(s || '').replace(/\D/g, '');
function formatHts(code) {
  const d = digits(code).slice(0, 10);
  if (d.length <= 4) return d;
  const parts = [d.slice(0, 4), d.slice(4, 6)];
  if (d.length > 6) parts.push(d.slice(6, 8));
  if (d.length > 8) parts.push(d.slice(8, 10));
  return parts.join('.');
}

/** "Free" → {ad_valorem: 0}; "3.4%" → 3.4; "6.8¢/kg + 10%" → ad valorem 10 plus a specific part (flagged). */
function parseGeneralRate(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { raw, ad_valorem: null, specific: false };
  if (/^free\b/i.test(raw)) return { raw, ad_valorem: 0, specific: false };
  const pct = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  const specific = /[¢$]|\/\s*(kg|doz|no|m2|liter|l|pr|gross)/i.test(raw);
  return { raw, ad_valorem: pct.length ? pct.reduce((a, b) => a + b, 0) : null, specific };
}

async function usitcSearch(keyword, fetchImpl = fetch) {
  const key = String(keyword).trim();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const res = await fetchImpl(`${USITC}?keyword=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'LulybooSupplierPortal/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`USITC HTS lookup failed (${res.status})`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  CACHE.set(key, { at: Date.now(), rows });
  return rows;
}

const footnoteText = (r) => (Array.isArray(r.footnotes) ? r.footnotes : []).map((f) => (typeof f === 'string' ? f : f?.value || '')).filter(Boolean);
const chapter99Refs = (r) => [...new Set([...footnoteText(r), String(r.additionalDuties || ''), String(r.general || ''), String(r.special || '')].join(' ').match(/9903\.\d{2}\.\d{2}/g) || [])];

/** Rows of an USITC result that carry a rate for this code (the code itself, else the nearest rated ancestor). */
function pickCandidates(rows, code) {
  const want = digits(code);
  const rated = rows.filter((r) => String(r.general ?? '').trim() && digits(r.htsno).length >= 4);
  let exact = rated.filter((r) => digits(r.htsno).startsWith(want));
  if (!exact.length) {
    const anc = rated.filter((r) => want.startsWith(digits(r.htsno)));
    anc.sort((a, b) => digits(b.htsno).length - digits(a.htsno).length);
    exact = anc.slice(0, 1);
  }
  // Prefer 8-digit lines (statistical suffix rows repeat the rate)
  const seen = new Set();
  const out = [];
  for (const r of exact) {
    const key = digits(r.htsno).slice(0, 8);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      htsno: r.htsno, description: String(r.description || '').replace(/<[^>]+>/g, '').trim(),
      general: String(r.general).trim(), special: String(r.special || '').trim(), other: String(r.other || '').trim(),
      parsed: parseGeneralRate(r.general), footnotes: footnoteText(r).slice(0, 6), chapter99: chapter99Refs(r),
    });
    if (out.length >= 8) break;
  }
  return out;
}

async function chapter99Info(code, fetchImpl) {
  try {
    const rows = await usitcSearch(code, fetchImpl);
    const row = rows.find((r) => digits(r.htsno) === digits(code)) || rows.find((r) => digits(r.htsno).startsWith(digits(code)));
    if (!row) return { heading: code, found: false };
    const general = String(row.general || row.additionalDuties || '').trim();
    const plus = general.match(/\+\s*(\d+(?:\.\d+)?)\s*%/);
    return { heading: row.htsno || code, found: true, description: String(row.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 400), general, plus_pct: plus ? Number(plus[1]) : null };
  } catch { return { heading: code, found: false }; }
}

const SYSTEM = `You are a US customs classification and duty analyst helping an importer of infant/toddler, pet and home goods.
Rules you must follow:
- The USITC rows in the input are the official source. Choose the HTS line that best fits the product from them; if the supplier's HTS/HS code is wrong or too vague, say so and choose a better one that appears in the candidate rows.
- Never invent a rate. A base rate must come from a candidate row. An additional measure (Section 301, Section 232, IEEPA or other country-specific duty) may only be marked as counted when its rate is shown in the Chapter 99 rows or in the WEB RESEARCH text provided. Anything else you believe may apply goes in review_flags with rate_pct null.
- Say when the answer depends on facts you don't have (material composition, how the product is used, size, gender/age fit for apparel).
- Be brief. The importer will confirm your answer; you are helping, not deciding.`;

const TOOL = {
  name: 'record_duty',
  description: 'Record the classification and duty findings for this product.',
  input_schema: {
    type: 'object',
    properties: {
      hts_code: { type: 'string', description: 'Best HTS code, 8 or 10 digits, taken from the candidate rows' },
      hts_description: { type: 'string' },
      classification_note: { type: 'string', description: 'Why this line; whether the supplier code looks right' },
      additional: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'e.g. Section 301 List 3' },
            heading: { type: 'string', description: 'Chapter 99 heading or program, if known' },
            rate_pct: { type: ['number', 'null'] },
            applies: { type: 'boolean' },
            basis: { type: 'string', enum: ['usitc_data', 'web_research', 'general_knowledge'] },
            note: { type: 'string' },
          },
          required: ['label', 'applies', 'basis'],
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      review_flags: { type: 'array', items: { type: 'string' }, description: 'Things the importer must verify' },
      summary: { type: 'string', description: '2-3 sentences' },
    },
    required: ['hts_code', 'confidence', 'summary'],
  },
};

const SUGGEST_TOOL = {
  name: 'suggest_hts',
  description: 'Suggest HTS codes for a product.',
  input_schema: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' }, description: 'Up to 3 plausible 6-8 digit HTS codes, best first' } }, required: ['codes'] },
};

/** Optional: let Claude check current additional US tariffs on the web (Anthropic web search server tool). */
async function webResearch({ origin, codes }, fetchImpl = fetch) {
  if (process.env.DUTY_WEB_SEARCH !== 'true' || !ai.enabled()) return null;
  const messages = [{ role: 'user', content: `Find the CURRENT additional US import tariffs (Section 301, Section 232, IEEPA / reciprocal tariffs, anti-dumping if relevant) that apply on top of the base HTS duty to goods of ${origin || 'China'} origin under HTS ${codes.join(', ')}. Use official sources (USTR, CBP, hts.usitc.gov, whitehouse.gov, Federal Register) and report each measure with its rate, effective date and source URL. If tariffs changed recently or are under court challenge, say so. Plain text, under 250 words.` }];
  for (let i = 0; i < 4; i++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ai.model(), max_tokens: 1500, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`web research failed (${res.status})`);
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  }
  return null;
}

/**
 * product: { product_name, description, materials, category, hs_code, country_of_origin, unit_price?, currency? }
 * opts: { hts (admin-chosen code, forces the lookup), fetchImpl }
 * Returns the record stored on the product (see applyResult).
 */
async function researchDuty(product, { hts, fetchImpl = fetch } = {}) {
  if (!ai.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const notes = [];
  const origin = (product.country_of_origin || '').trim() || 'China';
  if (!product.country_of_origin) notes.push('No country of origin on the product: assumed China.');

  // 1. Which codes to look up
  let codes = [];
  const forced = digits(hts);
  const given = digits(product.hs_code);
  if (forced.length >= 4) codes = [forced];
  else if (given.length >= 4) codes = [given];
  if (!codes.length) {
    const { result } = await ai.callTool({ tool: SUGGEST_TOOL, system: SYSTEM, maxTokens: 400, content: `Suggest HTS codes (US Harmonized Tariff Schedule) for this product.\n${JSON.stringify({ name: product.product_name, description: product.description, materials: product.materials, category: product.category })}` });
    codes = (result.codes || []).map(digits).filter((c) => c.length >= 6).slice(0, 3);
    notes.push('No HTS/HS code on the product: codes were suggested by AI.');
  }
  if (!codes.length) throw new Error('No HTS code to look up. Enter one and try again.');

  // 2. Official rows
  let candidates = [];
  for (const c of codes) {
    let rows;
    try { rows = await usitcSearch(formatHts(c), fetchImpl); } catch (e) { notes.push(`USITC lookup failed for ${formatHts(c)}: ${e.message}`); continue; }
    candidates.push(...pickCandidates(rows, c));
    // A 4-6 digit code returns many lines: if nothing matched, fall back to a keyword search on the product name
  }
  if (!candidates.length && !forced) {
    try { candidates = pickCandidates(await usitcSearch(String(product.product_name || '').slice(0, 60), fetchImpl), digits(codes[0]).slice(0, 4)); } catch { /* ignore */ }
  }
  const dedup = new Map(); for (const c of candidates) dedup.set(digits(c.htsno), c);
  candidates = [...dedup.values()].slice(0, 10);
  if (!candidates.length) throw new Error(`USITC returned no tariff line for ${codes.map(formatHts).join(', ')}. Check the code on hts.usitc.gov.`);

  // 3. Chapter 99 headings the candidates point to (Section 301 etc.)
  const refs = [...new Set(candidates.flatMap((c) => c.chapter99))].slice(0, 8);
  const ch99 = await Promise.all(refs.map((r) => chapter99Info(r, fetchImpl)));

  // 4. Optional web research on current additional tariffs
  let web = null;
  try { web = await webResearch({ origin, codes: candidates.slice(0, 3).map((c) => c.htsno) }, fetchImpl); } catch (e) { notes.push(`Web research unavailable: ${e.message}`); }

  const facts = {
    product: { name: product.product_name, description: product.description, materials: product.materials, category: product.category, supplier_hts_code: product.hs_code || null, country_of_origin: origin },
    admin_requested_code: forced ? formatHts(forced) : null,
    usitc_candidate_rows: candidates.map((c) => ({ htsno: c.htsno, description: c.description, general_rate_text: c.general, general_ad_valorem_pct: c.parsed.ad_valorem, has_specific_duty: c.parsed.specific, footnotes: c.footnotes, chapter99_refs: c.chapter99 })),
    chapter99_rows: ch99,
    web_research: web,
  };
  const { result } = await ai.callTool({ tool: TOOL, system: SYSTEM, maxTokens: 1800, content: `Research the US import duty for this product.\n${JSON.stringify(facts)}` });

  // 5. Numbers are computed here, from the official row.
  const chosen = candidates.find((c) => digits(c.htsno) === digits(result.hts_code))
    || candidates.find((c) => digits(c.htsno).startsWith(digits(result.hts_code)) || digits(result.hts_code).startsWith(digits(c.htsno)))
    || candidates[0];
  const flags = [...(result.review_flags || []), ...notes];
  if (chosen && digits(chosen.htsno) !== digits(result.hts_code)) flags.push(`AI proposed ${result.hts_code}, which is not in the USITC rows: used ${chosen.htsno}.`);
  let base = chosen?.parsed.ad_valorem ?? null;
  if (chosen?.parsed.specific) flags.push(`${chosen.htsno} has a specific (per-unit) duty (“${chosen.general}”): only the percentage part is counted. Check the full rate.`);
  if (base === null) flags.push(`No percentage rate could be read from “${chosen?.general}”: enter the duty manually.`);

  const additional = (result.additional || []).map((a) => {
    const counted = !!a.applies && a.rate_pct !== null && a.rate_pct !== undefined && a.basis !== 'general_knowledge';
    if (a.applies && a.basis === 'general_knowledge') flags.push(`${a.label}: not confirmed by USITC data or web research, so it is NOT counted. Verify and add manually if it applies.`);
    return { label: a.label, heading: a.heading || null, rate_pct: a.rate_pct ?? null, applies: !!a.applies, basis: a.basis, note: a.note || null, counted };
  });
  const addPct = additional.filter((a) => a.counted).reduce((s, a) => s + Number(a.rate_pct), 0);
  const total = base === null ? null : Math.round((base + addPct) * 100) / 100;

  return {
    hts_code: chosen?.htsno || result.hts_code,
    hts_description: chosen?.description || result.hts_description || '',
    general_rate_text: chosen?.general || null,
    base_rate_pct: base,
    additional,
    additional_pct: Math.round(addPct * 100) / 100,
    total_pct: total,
    confidence: base === null ? 'low' : result.confidence,
    classification_note: result.classification_note || null,
    summary: result.summary,
    review_flags: [...new Set(flags)],
    alternatives: candidates.filter((c) => c !== chosen).slice(0, 5).map((c) => ({ htsno: c.htsno, description: c.description, general: c.general })),
    web_research_used: !!web,
    origin_assumed: origin,
    model: ai.model(),
    checked_at: new Date().toISOString(),
  };
}

/** Columns to store on the product from a researchDuty result. */
function productPatch(r) {
  return { hts_verified_code: r.hts_code, duty_ai_pct: r.total_pct, duty_ai_detail: r, duty_ai_checked_at: r.checked_at };
}

module.exports = { researchDuty, productPatch, parseGeneralRate, formatHts, pickCandidates, usitcSearch, _cache: CACHE };
