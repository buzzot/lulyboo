'use strict';
// Claude API integration. All numbers (landed cost, freight, margins) are computed in calc.js;
// the model receives them as facts and is asked to review, explain, match and compare —
// not to do arithmetic of its own.

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are a sourcing analyst for Lulyboo, a US brand placing infant/toddler and pet products
into off-price and mass retailers (Ross, Burlington, TJ Maxx, Nordstrom Rack, Target).
You review factory quotations. Landed cost, freight per unit, duty and margins in the input were calculated
by the system: treat them as correct and cite them, never recompute them differently.
Be concrete and brief. Point out real differences (materials, size, pack count, certifications, MOQ, lead time,
packing efficiency) that explain price gaps. Flag compliance risks for US children's products (CPSIA, CPC,
ASTM F963, tracking labels) and pet products where relevant. When suggesting HS codes or duty rates, say they must be
verified on hts.usitc.gov and note possible Section 301 tariffs for China-origin goods. Use USD.`;

function enabled() { return !!process.env.ANTHROPIC_API_KEY; }
function model() { return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'; }

async function callTool({ tool, content, maxTokens = 4000 }) {
  if (!enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const body = {
    model: model(),
    max_tokens: maxTokens,
    system: SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const block = (data.content || []).find((b) => b.type === 'tool_use');
      if (!block) throw new Error('AI returned no structured result');
      return { result: block.input, model: data.model, usage: data.usage || {} };
    }
    const text = await res.text().catch(() => '');
    lastErr = new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
    if (![429, 500, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw lastErr;
}

// Compact product facts for the prompt
function facts(p, a, supplierName) {
  const o = {
    product_id: p.id,
    supplier: supplierName || p.supplier_name,
    name: p.product_name,
    sku: p.supplier_sku,
    category: p.category,
    subcategory: p.subcategory,
    description: p.description ? String(p.description).slice(0, 500) : undefined,
    materials: p.materials,
    product_size_cm: p.product_size_cm,
    unit_net_weight_kg: p.unit_net_weight_kg,
    packaging: p.packaging_type,
    certifications: p.certifications,
    hs_code: p.hs_code,
    origin: p.country_of_origin,
    special_cargo: p.dangerous_goods,
    quoted_price: p.unit_price !== null ? `${p.unit_price} ${p.currency} ${p.incoterm || ''} ${p.fob_port || ''}`.trim() : undefined,
    unit_price_usd: a?.unit_price_usd,
    moq: p.moq,
    production_lead_days: p.production_lead_days,
    payment_terms: p.payment_terms,
    units_per_carton: p.units_per_carton,
    carton_cbm: a?.carton_cbm,
    units_per_40hq: a?.fits?.['40HQ']?.units,
    landed_cost_usd: a?.landed_cost,
    landed_cost_basis: a?.primary?.name,
    duty_pct_used: a?.duty_pct,
    our_wholesale_usd: p.our_wholesale_usd,
    our_retail_usd: p.our_retail_usd,
    suggested_retail_usd: p.suggested_retail_usd,
    our_margin_pct: a?.margin_pct,
  };
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

const imageBlock = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: buf.toString('base64') } });

// ── Tools (output schemas) ────────────────────────────────────
const REVIEW_TOOL = {
  name: 'product_review',
  description: 'Structured review of one factory quotation.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['Strong', 'Promising', 'Weak'] },
      summary: { type: 'string', description: '2–4 sentences' },
      data_issues: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, issue: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['issue', 'severity'] } },
      hs_duty: { type: 'object', properties: { suggested_hs_code: { type: 'string' }, note: { type: 'string' } }, required: ['note'] },
      pricing: { type: 'object', properties: { wholesale_low_usd: { type: 'number' }, wholesale_high_usd: { type: 'number' }, retail_usd: { type: 'number' }, rationale: { type: 'string' } }, required: ['rationale'] },
      risks: { type: 'array', items: { type: 'string' } },
      questions_for_factory: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'summary', 'data_issues', 'pricing', 'risks', 'questions_for_factory'],
  },
};

const SIMILAR_TOOL = {
  name: 'similar_products',
  description: 'Which candidate products are the same or comparable to the target, and how they differ.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string' },
            match_type: { type: 'string', enum: ['Same product', 'Close alternative'] },
            reason: { type: 'string' },
            key_differences: { type: 'array', items: { type: 'string' } },
            price_note: { type: 'string', description: 'Price/landed-cost difference vs target and why' },
          },
          required: ['product_id', 'match_type', 'reason', 'key_differences', 'price_note'],
        },
      },
      recommendation: { type: 'string' },
    },
    required: ['summary', 'matches', 'recommendation'],
  },
};

const COMPARE_TOOL = {
  name: 'product_comparison',
  description: 'Side-by-side comparison of selected quotations.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      best_value_product_id: { type: 'string' },
      per_product: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } } }, required: ['product_id', 'strengths', 'weaknesses'] } },
      price_differences: { type: 'array', items: { type: 'string' }, description: 'What explains each price gap' },
      negotiation_points: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string' },
    },
    required: ['summary', 'per_product', 'price_differences', 'negotiation_points', 'recommendation'],
  },
};

const CATEGORY_TOOL = {
  name: 'category_matches',
  description: 'Groups of equivalent products offered by different suppliers in one category.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Generic product name, e.g. "Muslin swaddle 2-pack 120cm"' },
            product_ids: { type: 'array', items: { type: 'string' } },
            match_type: { type: 'string', enum: ['Same product', 'Close alternatives'] },
            price_spread_note: { type: 'string' },
            best_value_product_id: { type: 'string' },
          },
          required: ['label', 'product_ids', 'match_type', 'price_spread_note'],
        },
      },
    },
    required: ['summary', 'groups'],
  },
};

// ── Candidate search for "find similar" (cheap, local) ───────
const STOP = new Set(['the', 'and', 'for', 'with', 'set', 'pcs', 'pc', 'pack', 'of', 'in', 'a', 'cm', 'inch', 'baby', 'pet', 'new']);
function tokens(p) {
  const s = [p.product_name, p.subcategory, p.materials, p.description, p.category].filter(Boolean).join(' ').toLowerCase();
  const words = s.match(/[a-z]{3,}|[一-鿿]{2}/g) || [];
  return new Set(words.filter((w) => !STOP.has(w)).map((w) => w.replace(/(es|s)$/, '')));
}
function rankCandidates(target, all, { limit = 15, otherSuppliersOnly = true } = {}) {
  const t = tokens(target);
  return all
    .filter((p) => p.id !== target.id && (!otherSuppliersOnly || p.supplier_id !== target.supplier_id))
    .map((p) => {
      const o = tokens(p);
      let inter = 0; for (const w of t) if (o.has(w)) inter++;
      const jac = inter / (t.size + o.size - inter || 1);
      const score = jac + (p.category && p.category === target.category ? 0.15 : 0) + (p.subcategory && p.subcategory === target.subcategory ? 0.15 : 0);
      return { p, score };
    })
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

// ── Public functions ──────────────────────────────────────────
async function reviewProduct({ product, analysis, supplierName, category, image }) {
  const content = [];
  if (image) content.push(imageBlock(image));
  content.push({
    type: 'text',
    text: `Review this quotation.\n\nPRODUCT:\n${JSON.stringify(facts(product, analysis, supplierName), null, 1)}\n\n` +
      `CATEGORY SETTINGS:\n${JSON.stringify({ name: category?.name, target_margin_pct: analysis.pricing.target_margin_pct, default_duty_pct: category?.default_duty_pct, default_hs_code: category?.default_hs_code })}\n\n` +
      `LOGISTICS OPTIONS (calculated):\n${JSON.stringify(analysis.scenarios.map((s) => ({ option: s.name, freight_per_unit: s.freight_per_unit, landed_cost: s.landed_cost, transit_days: s.transit_days, notes: s.notes })))}\n\n` +
      `SYSTEM PRICING:\n${JSON.stringify(analysis.pricing)}\n\nSYSTEM-DETECTED ISSUES:\n${JSON.stringify(analysis.issues)}`,
  });
  return callTool({ tool: REVIEW_TOOL, content });
}

async function findSimilar({ target, targetAnalysis, candidates, images = {} }) {
  const content = [{ type: 'text', text: `TARGET PRODUCT:\n${JSON.stringify(facts(target, targetAnalysis))}` }];
  if (images[target.id]) content.push({ type: 'text', text: 'Target photo:' }, imageBlock(images[target.id]));
  content.push({ type: 'text', text: `\nCANDIDATES from other suppliers (${candidates.length}). Return only real matches; omit unrelated items.` });
  for (const c of candidates) {
    content.push({ type: 'text', text: JSON.stringify(facts(c.product, c.analysis)) });
    if (images[c.product.id]) content.push(imageBlock(images[c.product.id]));
  }
  return callTool({ tool: SIMILAR_TOOL, content });
}

async function compareProducts({ items, images = {} }) {
  const content = [{ type: 'text', text: `Compare these ${items.length} quotations for the same retail opportunity.` }];
  for (const it of items) {
    content.push({ type: 'text', text: JSON.stringify(facts(it.product, it.analysis)) });
    if (images[it.product.id]) content.push(imageBlock(images[it.product.id]));
  }
  return callTool({ tool: COMPARE_TOOL, content });
}

async function matchCategory({ category, items }) {
  const lines = items.map((it) => JSON.stringify(facts(it.product, it.analysis)));
  const content = [{
    type: 'text',
    text: `Category: ${category}. Group products from DIFFERENT suppliers that are the same item or close alternatives, ` +
      `so the buyer can compare prices. Ignore products that have no counterpart.\n\n${lines.join('\n')}`,
  }];
  return callTool({ tool: CATEGORY_TOOL, content, maxTokens: 6000 });
}

module.exports = { enabled, model, reviewProduct, findSimilar, compareProducts, matchCategory, rankCandidates, facts };
