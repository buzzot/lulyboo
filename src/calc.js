'use strict';
// Logistics + landed cost + pricing calculations. Pure functions, no I/O.

// Inside dimensions (cm) and usable payload (kg). Payload uses typical US road
// limits (about 44,000 lb gross for a 40', 38,000 lb for a 20'), which are lower than the
// container's rated maximum; for light baby/pet goods volume is almost always the limit.
const CONTAINERS = {
  '20GP': { l: 589, w: 235, h: 239, payloadKg: 17200, cbm: 33.1 },
  '40GP': { l: 1203, w: 235, h: 239, payloadKg: 20000, cbm: 67.6 },
  '40HQ': { l: 1203, w: 235, h: 269, payloadKg: 20000, cbm: 76.1 },
};

const MODES = {
  FCL_20GP: { label: 'FCL 20GP', unit: 'per container', container: '20GP', ocean: true },
  FCL_40GP: { label: 'FCL 40GP', unit: 'per container', container: '40GP', ocean: true },
  FCL_40HQ: { label: 'FCL 40HQ', unit: 'per container', container: '40HQ', ocean: true },
  LCL: { label: 'LCL', unit: 'per CBM (W/M)', ocean: true },
  AIR: { label: 'Air freight', unit: 'per chargeable kg', volDivisor: 6000 },
  EXPRESS: { label: 'Express', unit: 'per chargeable kg', volDivisor: 5000 },
};

// US Customs user fees (approximate, % of entered value): MPF 0.3464% + HMF 0.125% for ocean.
const MPF_PCT = 0.3464;
const HMF_PCT = 0.125;

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const r = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Cartons of size l×w×h (cm, gross kg) that fit in a container: best of 6 orientations, capped by payload. */
function cartonsFit({ l, w, h, gw }, containerCode) {
  const c = CONTAINERS[containerCode];
  l = n(l); w = n(w); h = n(h); gw = n(gw);
  if (!c || !(l > 0) || !(w > 0) || !(h > 0)) return null;
  const f = Math.floor;
  const orient = [
    [l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l],
  ].map(([a, b, d]) => ({ dims: [a, b, d], count: f(c.l / a) * f(c.w / b) * f(c.h / d) }));
  const best = orient.reduce((x, y) => (y.count > x.count ? y : x));
  const byWeight = gw > 0 ? f(c.payloadKg / gw) : Infinity;
  const cartons = Math.min(best.count, byWeight);
  return {
    container: containerCode,
    byDimensions: best.count,
    byWeight: Number.isFinite(byWeight) ? byWeight : null,
    cartons,
    limitedBy: byWeight < best.count ? 'weight' : 'dimensions',
    orientation: best.dims,
    fillPct: r((cartons * l * w * h) / (c.l * c.w * c.h) * 100, 1),
  };
}

/** Freight for one product under one logistics option. Returns per-unit costs and notes. */
function freightForOption(p, opt, { qty }) {
  const mode = MODES[opt.mode];
  const upc = n(p.units_per_carton);
  const L = n(p.carton_l_cm), W = n(p.carton_w_cm), H = n(p.carton_h_cm), GW = n(p.carton_gw_kg);
  const rate = n(opt.rate_usd) || 0;
  const fees = n(opt.fees_per_shipment_usd) || 0;
  const minCharge = n(opt.min_charge_usd) || 0;
  const out = { option_id: opt.id, name: opt.name, mode: opt.mode, mode_label: mode?.label, transit_days: opt.transit_days, notes: [] };
  if (!mode) { out.notes.push('Unknown mode'); return out; }
  if (!(upc > 0) || !(L > 0) || !(W > 0) || !(H > 0)) { out.notes.push('Needs units per carton and carton L×W×H'); return out; }
  const cartonCbm = (L * W * H) / 1e6;

  if (mode.container) {
    const fit = cartonsFit({ l: L, w: W, h: H, gw: GW }, mode.container);
    out.fit = fit;
    out.units_per_container = fit.cartons * upc;
    if (!(out.units_per_container > 0)) { out.notes.push('Carton does not fit this container'); return out; }
    const perContainer = Math.max(rate, minCharge) + fees;
    if (qty) {
      out.containers = Math.ceil(qty / out.units_per_container);
      out.shipment_qty = qty;
      out.freight_total = out.containers * perContainer;
      out.freight_per_unit = out.freight_total / qty;
      const fill = qty / (out.containers * out.units_per_container);
      if (fill < 0.8) out.notes.push(`Last container only ${Math.round(fill * 100)}% full at ${qty.toLocaleString()} units`);
    } else {
      out.containers = 1;
      out.shipment_qty = out.units_per_container;
      out.freight_total = perContainer;
      out.freight_per_unit = perContainer / out.units_per_container;
      out.notes.push('Assumes a full container');
    }
    if (fit.limitedBy === 'weight') out.notes.push('Limited by weight, not space');
  } else {
    if (!qty) { out.notes.push('Needs MOQ or planned qty to cost a part shipment'); return out; }
    const cartons = Math.ceil(qty / upc);
    out.cartons = cartons;
    out.shipment_qty = qty;
    out.shipment_cbm = r(cartons * cartonCbm, 3);
    out.shipment_gw_kg = GW ? r(cartons * GW, 1) : null;
    if (opt.mode === 'LCL') {
      const tons = GW ? (cartons * GW) / 1000 : 0;
      const rt = Math.max(cartons * cartonCbm, tons, 1); // W/M with 1 CBM minimum
      out.chargeable = r(rt, 3);
      out.chargeable_unit = 'RT';
      out.freight_total = Math.max(rate * rt, minCharge) + fees;
      if (out.shipment_cbm > 15) out.notes.push('Over ~15 CBM: a 20GP FCL is usually cheaper');
    } else {
      const volKg = (L * W * H) / mode.volDivisor;
      const perCarton = Math.max(GW || 0, volKg);
      if (!GW) out.notes.push('No gross weight; used volumetric weight');
      out.chargeable = r(perCarton * cartons, 1);
      out.chargeable_unit = 'kg';
      out.freight_total = Math.max(rate * out.chargeable, minCharge) + fees;
    }
    out.freight_per_unit = out.freight_total / qty;
  }
  out.freight_total = r(out.freight_total, 2);
  out.freight_per_unit = r(out.freight_per_unit, 4);
  return out;
}

/**
 * Full analysis for one product.
 * ctx: { settings, categories: [{name, default_duty_pct, target_margin_pct, ...}], options: [logistics_options] }
 */
function analyzeProduct(p, ctx) {
  const settings = ctx.settings || {};
  const fx = settings.fx_to_usd || { USD: 1 };
  const cat = (ctx.categories || []).find((c) => c.name === p.category) || null;
  const options = (ctx.options || []).filter((o) => o.active !== false);
  const issues = [];

  const currency = (p.currency || 'USD').toUpperCase();
  const rate = fx[currency];
  const unitPrice = n(p.unit_price);
  const unitPriceUsd = unitPrice !== null && rate ? unitPrice * Number(rate) : null;
  if (unitPrice === null) issues.push('No unit price');
  else if (!rate) issues.push(`No exchange rate for ${currency}. Add it in Settings`);

  const upc = n(p.units_per_carton);
  const L = n(p.carton_l_cm), W = n(p.carton_w_cm), H = n(p.carton_h_cm);
  const GW = n(p.carton_gw_kg), NW = n(p.carton_nw_kg), unitNW = n(p.unit_net_weight_kg);
  const cartonCbm = L && W && H ? (L * W * H) / 1e6 : null;
  if (!upc) issues.push('Missing units per master carton');
  if (!cartonCbm) issues.push('Missing carton dimensions');
  if (!GW) issues.push('Missing carton gross weight');
  if (GW && NW && GW < NW) issues.push('Carton gross weight is less than net weight');
  if (unitNW && upc && NW && Math.abs(unitNW * upc - NW) / NW > 0.25) issues.push(`Unit weight × units per carton (${r(unitNW * upc, 2)} kg) does not match carton net weight (${NW} kg)`);
  if (p.quote_valid_until && p.quote_valid_until < new Date().toISOString().slice(0, 10)) issues.push('Quote has expired');
  if (p.dangerous_goods && !/^\s*(no|none|n\/a|否|无)\s*$/i.test(p.dangerous_goods)) issues.push(`Special cargo: ${p.dangerous_goods}`);
  if (/^infant|toddler|baby/i.test(p.category || '') && !/cpsia|astm|cpc/i.test(p.certifications || '')) issues.push('Children\'s product with no CPSIA / ASTM / CPC certificate listed');
  const incoterm = (p.incoterm || 'FOB').toUpperCase();
  if (incoterm === 'EXW') issues.push('EXW price: origin trucking and export clearance are not included');

  const fits = {};
  for (const code of Object.keys(CONTAINERS)) {
    fits[code] = cartonsFit({ l: L, w: W, h: H, gw: GW }, code);
    if (fits[code] && upc) fits[code].units = fits[code].cartons * upc;
  }
  const supplierQ = n(p.supplier_qty_40hq);
  if (supplierQ && fits['40HQ']?.units && Math.abs(supplierQ - fits['40HQ'].units) / fits['40HQ'].units > 0.15) {
    issues.push(`Factory says ${supplierQ.toLocaleString()} units per 40HQ; calculated ${fits['40HQ'].units.toLocaleString()}`);
  }

  const dutyPct = n(p.duty_rate_pct) ?? n(cat?.default_duty_pct) ?? n(settings.default_duty_pct) ?? 0;
  const dutySource = n(p.duty_rate_pct) !== null ? 'product' : n(cat?.default_duty_pct) !== null ? 'category' : 'default';
  const targetMarginPct = n(cat?.target_margin_pct) ?? n(settings.default_target_margin_pct) ?? 40;
  const insurancePct = n(settings.insurance_pct) ?? 0;
  const qtyExplicit = n(p.planned_qty);
  const qtyForPartial = qtyExplicit || n(p.moq);

  const included = { freight: true, duty: true, insurance: true };
  if (incoterm === 'CFR' || incoterm === 'CIF') included.oceanInPrice = true;
  if (incoterm === 'CIF') included.insurance = false;
  if (incoterm === 'DAP') { included.freight = false; included.insurance = false; }
  if (incoterm === 'DDP') { included.freight = false; included.duty = false; included.insurance = false; }

  const scenarios = options.map((opt) => {
    const isFcl = !!MODES[opt.mode]?.container;
    const f = freightForOption(p, opt, { qty: isFcl ? qtyExplicit : qtyForPartial });
    if (f.freight_per_unit !== null && f.freight_per_unit !== undefined) {
      if (!included.freight) { f.freight_per_unit = 0; f.notes.push(`${incoterm}: freight included in price`); }
      else if (included.oceanInPrice && f.shipment_qty) {
        // Main freight is in the supplier price; we still pay destination fees.
        f.freight_per_unit = r((n(opt.fees_per_shipment_usd) || 0) * (f.containers || 1) / f.shipment_qty, 4);
        f.notes.push(`${incoterm}: main freight included in price; only destination fees counted`);
      }
    }
    const ocean = !!MODES[opt.mode]?.ocean;
    const s = { ...f };
    if (unitPriceUsd !== null && f.freight_per_unit !== null && f.freight_per_unit !== undefined) {
      s.duty_per_unit = included.duty ? r(unitPriceUsd * dutyPct / 100) : 0;
      s.customs_fees_per_unit = included.duty ? r(unitPriceUsd * (MPF_PCT + (ocean ? HMF_PCT : 0)) / 100) : 0;
      s.insurance_per_unit = included.insurance ? r(unitPriceUsd * insurancePct / 100) : 0;
      s.landed_cost = r(unitPriceUsd + f.freight_per_unit + s.duty_per_unit + s.customs_fees_per_unit + s.insurance_per_unit);
    } else {
      s.landed_cost = null;
    }
    return s;
  });

  const primaryId = p.logistics_option_id || settings.default_logistics_option_id;
  const primary = scenarios.find((s) => s.option_id === primaryId && s.landed_cost !== null)
    || scenarios.find((s) => s.landed_cost !== null) || null;
  const cheapest = scenarios.filter((s) => s.landed_cost !== null).sort((a, b) => a.landed_cost - b.landed_cost)[0] || null;

  const landed = primary?.landed_cost ?? null;
  const pricing = { target_margin_pct: targetMarginPct };
  if (landed !== null) {
    pricing.suggested_wholesale = r(landed / (1 - targetMarginPct / 100), 2);
    pricing.suggested_retail_at_2_5x = r(pricing.suggested_wholesale * 2.5, 2); // common off-price keystone+ multiple
  }
  const wh = n(p.our_wholesale_usd);
  const rt = n(p.our_retail_usd) ?? n(p.suggested_retail_usd);
  if (wh && landed !== null) pricing.our_margin_pct = r((wh - landed) / wh * 100, 1);
  if (wh && rt) pricing.retailer_margin_pct = r((rt - wh) / rt * 100, 1);
  if (pricing.our_margin_pct !== undefined && pricing.our_margin_pct < targetMarginPct) {
    issues.push(`Margin ${pricing.our_margin_pct}% is below the ${targetMarginPct}% target`);
  }

  return {
    id: p.id,
    currency,
    unit_price_usd: r(unitPriceUsd),
    carton_cbm: r(cartonCbm, 4),
    unit_cbm: cartonCbm && upc ? r(cartonCbm / upc, 6) : null,
    fits,
    duty_pct: dutyPct,
    duty_source: dutySource,
    insurance_pct: insurancePct,
    incoterm,
    planned_qty: qtyExplicit,
    qty_for_partial: qtyForPartial,
    moq_cartons: n(p.moq) && upc ? Math.ceil(n(p.moq) / upc) : null,
    moq_cbm: n(p.moq) && upc && cartonCbm ? r(Math.ceil(n(p.moq) / upc) * cartonCbm, 2) : null,
    scenarios,
    primary,
    cheapest,
    landed_cost: landed,
    pricing,
    margin_pct: pricing.our_margin_pct ?? null,
    issues,
  };
}

module.exports = { CONTAINERS, MODES, cartonsFit, freightForOption, analyzeProduct };
