'use strict';
// Customs draft (our own CBP 7501) for a shipped container / LCL shipment, made before the goods arrive.
//   Each product of the shipment is classified with the catalog classifier (hts-classify: photos, specs, fields,
//   customs documents and the importer's note → HTS candidates ranked by correctness, rates from the USITC schedule,
//   Section 301 from Chapter 99, country-wide extras as paid on the last 7501). The draft uses the code a person
//   already checked (to declare) or else the most correct one, groups products with the same code into 7501 lines
//   and does the duty arithmetic here. Cheaper codes are shown only when the classifier rates them a strong or
//   possible fit — "defensible" — never a code that does not describe the goods.
//   When the broker's 7501 is in, each product is compared: our code and duty vs the broker's.

const AI = require('./ai');
const PL = require('./planning');
const HC = require('./hts-classify');

const now = () => new Date().toISOString();
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');
const fmt = (c) => { const d = digits(c).slice(0, 10); return d.length >= 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : d; };
const missing = (e) => /customs_drafts|PGRST20[45]|relation/i.test(e?.message || '');
// CBP merchandise processing fee (formal entry) — fiscal year 2026 values; update every October 1.
const MPF = { pct: 0.3464, min: 33.58, max: 651.50 };
const HMF = 0.125;   // harbor maintenance fee, ocean shipments
const is301 = (c) => /^9903\.88\./.test(String(c || ''));
const FIT_RISK = { strong: 'defensible', possible: 'defensible · check' };

/** Country-wide extras (9903.01.xx …) on the newest saved 7501 — used for products never imported before. */
function globalExtras(entries) {
  const e = entries.filter((x) => x.status === 'saved').sort((a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || '')))[0];
  if (!e) return [];
  const seen = new Map();
  for (const l of e.lines || []) for (const x of l.extras || []) if (/^9903\./.test(String(x.code || '')) && !is301(x.code) && !/^9903\.8[0-5]\./.test(String(x.code)) && x.rate && !seen.has(x.code)) seen.set(x.code, { code: x.code, rate: Number(x.rate), label: x.label || 'Country-wide' });
  return [...seen.values()];
}

/** Items of the shipment: one per catalog product (lines of several POs merged), with value / qty / weight / cartons. */
async function itemsOf(db, r) {
  const sids = [...new Set(r.lines.map((l) => l.supplier_id))];
  const prods = {}; for (const sid of sids) prods[sid] = await db.list('products', { filters: { supplier_id: sid } }).catch(() => []);
  const by = new Map();
  for (const l of r.lines) {
    const p = PL.catalogMatch(l, prods[l.supplier_id] || []);
    const k = p ? p.id : `${l.supplier_id}|${String(l.sku || l.product || '').toUpperCase()}`;
    const price = Number(l.unit_price) || (p && (!p.currency || p.currency === 'USD') ? Number(p.unit_price) : 0) || 0;
    const it = by.get(k) || { key: k, product: p || null, sku: l.sku || p?.supplier_sku || '', name: p?.product_name || l.product || l.sku || 'Item', pos: [], qty: 0, value: 0, kg: 0, ctns: 0, noPrice: false };
    it.qty += Number(l.qty) || 0; it.value += (Number(l.qty) || 0) * price; it.kg += Number(l.gross_kg) || 0; it.ctns += Number(l.cartons) || 0;
    if (!price) it.noPrice = true;
    if (!it.pos.includes(l.po)) it.pos.push(l.po);
    by.set(k, it);
  }
  return [...by.values()].map((x) => ({ ...x, value: r2(x.value), kg: Math.round(x.kg) }));
}

/** Classify (when needed) and rate each product. opts.rerun: Set of product ids to re-run with photos/documents. */
async function build(db, r, { by = null, rerun = new Set(), notes = {}, fetchImpl, entries = null } = {}) {
  const CR = require('./routes/customs');
  const all = entries || await db.list('customs_entries').catch(() => []);
  const gx = globalExtras(all);
  const items = await itemsOf(db, r);
  const errors = [];
  const work = async (it) => {
    const p = it.product; if (!p) { it.unclassified = 'not in the catalog'; return; }
    const customs = await CR.forProduct(db, p.id).catch(() => []);
    const last = customs[0] || (gx.length ? { extras: gx } : null);
    let review = p.hts_review && (p.hts_review.candidates || []).length ? JSON.parse(JSON.stringify(p.hts_review)) : null;
    if ((!review || rerun.has(p.id)) && AI.enabled()) {
      try {
        const out = await HC.classify(db, p, { customs, by, fetchImpl, reuse: !rerun.has(p.id) && !!p.customs_description, note: notes[p.id] || '' });
        await db.update('products', { id: p.id }, { ...HC.patch(out), ...(p.hts_original_code ? {} : { hts_original_code: out.review.original }), updated_at: now() }).catch(() => null);
        review = out.review; it.fresh = true;
        if (!customs.length && gx.length) await HC.rateAll(review, p, last, { fetchImpl }).catch(() => null);   // never imported: China-wide extras from the newest 7501
      } catch (e) { errors.push(`${it.sku || it.name}: ${String(e.message).slice(0, 120)}`); }
    }
    if (!review) {   // no AI: the code on file, rated
      const code = digits(p.hts_declare_code || p.hts_verified_code || p.hs_code);
      if (code.length < 8) { it.unclassified = AI.enabled() ? 'could not be classified' : 'no HTS code on file (AI is off)'; return; }
      review = { candidates: [{ hts: code, fit: 'possible', why: 'Code on file — not reviewed by AI.' }], missing: [] };
    } else if (!it.fresh) { try { await HC.rateAll(review, p, last, { fetchImpl }); } catch { /* keep saved rates */ } }   // today's rates for a saved review
    const cands = (review.candidates || []).filter((c) => c.total != null && c.found !== false);
    const declared = p.hts_declare_code ? cands.find((c) => digits(c.hts) === digits(p.hts_declare_code)) : null;
    const pk = HC.picks(review);
    const use = declared || pk.best || cands[0] || null;
    if (!use) { it.unclassified = 'no code with a rate in the US schedule'; it.review = review; return; }
    it.code = { hts: fmt(use.hts), title: use.usitc_title || use.title || '', base: use.base, base_text: use.base_text, extras: (use.extras || []).map((x) => ({ code: x.code, rate: Number(x.rate) || 0, label: x.label, from: x.from })), total: use.total, fit: use.fit, why: use.why, checked: !!declared, notes: use.notes || [] };
    it.alts = (review.candidates || []).filter((c) => digits(c.hts) !== digits(use.hts)).map((c) => {
      const ok = c.found !== false && c.matches !== false && c.total != null && c.fit !== 'weak';
      return { hts: fmt(c.hts), title: c.usitc_title || c.title || '', total: c.total, fit: c.fit, why: c.why, risk: c.found === false ? 'not in the US schedule' : c.matches === false || c.fit === 'weak' ? 'not supported' : FIT_RISK[c.fit] || 'check', ok,
        duty: c.total != null ? r2(it.value * c.total / 100) : null, save: ok && c.total < use.total ? r2(it.value * (use.total - c.total) / 100) : 0 };
    });
    it.missing = review.missing || []; it.summary = review.summary || ''; it.desc = p.customs_description || '';
  };
  // a few products at a time (each classification is two AI calls)
  const q = items.slice(); await Promise.all([0, 1, 2].map(async () => { while (q.length) await work(q.shift()); }));
  return { items, errors, gx };
}

/** 7501 lines: products with the same code and extras together; duty per part. Totals with MPF / HMF. */
function lines(items, { ocean = true } = {}) {
  const map = new Map();
  for (const it of items) {
    const key = it.code ? `${digits(it.code.hts)}|${it.code.extras.map((x) => `${x.code}:${x.rate}`).join(',')}` : `x|${it.key}`;
    const l = map.get(key) || { code: it.code || null, items: [], qty: 0, value: 0, kg: 0, ctns: 0 };
    l.items.push(it); l.qty += it.qty; l.value += it.value; l.kg += it.kg; l.ctns += it.ctns; map.set(key, l);
  }
  const out = [...map.values()].map((l, i) => {
    const v = r2(l.value); const c = l.code;
    const base = c && c.base != null ? r2(v * c.base / 100) : null;
    const extras = c ? c.extras.map((x) => ({ ...x, duty: r2(v * x.rate / 100) })) : [];
    return { no: String(i + 1).padStart(3, '0'), ...l, value: v, base, extras, duty: c ? r2((base || 0) + extras.reduce((a, x) => a + x.duty, 0)) : null };
  });
  const value = r2(out.reduce((a, l) => a + l.value, 0));
  const duty = r2(out.reduce((a, l) => a + (l.base || 0), 0));
  const s301 = r2(out.reduce((a, l) => a + l.extras.filter((x) => is301(x.code)).reduce((b, x) => b + x.duty, 0), 0));
  const other = r2(out.reduce((a, l) => a + l.extras.filter((x) => !is301(x.code)).reduce((b, x) => b + x.duty, 0), 0));
  const mpf = value ? r2(Math.min(MPF.max, Math.max(MPF.min, value * MPF.pct / 100))) : 0;
  const hmf = ocean ? r2(value * HMF / 100) : 0;
  const total = r2(duty + s301 + other + mpf + hmf);
  const save = r2(items.reduce((a, it) => a + Math.max(0, ...(it.alts || []).map((x) => x.save || 0)), 0));
  return { lines: out, totals: { value, duty, s301, other, mpf, hmf, total, pct: value ? Math.round(total / value * 1000) / 10 : null, save, best: r2(total - save), open: items.filter((it) => it.unclassified || (it.missing || []).length || (it.alts || []).some((x) => x.save > 0)).length } };
}

/** 7501 header from the shipment. */
function header(r, settings = {}) {
  const f = r.f || {};
  const pod = String(f.pod || '').toLowerCase();
  const port = /long beach/.test(pod) ? '2709 Long Beach' : /los angeles|\blax?\b|la\/lb/.test(pod) || !pod ? '2704 Los Angeles' : f.pod;
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  return {
    entry_type: '01 Consumption', port, carrier: [f.vessel, f.voyage].filter(Boolean).join(' ') || f.carrier || null, mode: r.c?.box === 'LCL' ? '11 Vessel (LCL)' : '11 Vessel, container',
    origin: 'CN China', import_date: day(f.ata || f.eta), bl: f.mbl_no || f.hbl_no || null, hbl: f.hbl_no || null, exporting: 'CN', export_date: day(f.atd || f.etd),
    lading: f.pol || require('./schedules').PORT?.[r.c?.port]?.name || r.c?.port || null, unlading: port, consignee: settings.company_name || 'Lulyboo LLC', importer: settings.company_name || 'Lulyboo LLC', container: f.container_no || null,
  };
}

/** Our draft vs the broker's 7501, per product. */
function compare(draft, entries) {
  const saved = entries.filter((e) => ['saved', 'pending'].includes(e.status));
  if (!saved.length) return null;
  const rows = [];
  for (const it of draft.items || []) {
    if (!it.product) continue;
    let hts = null; let rate = null; let duty = 0; let found = false; let entry = null;
    for (const e of saved) for (const l of e.lines || []) for (const p of l.products || []) if (p.product_id === it.product.id) { found = true; hts = fmt(l.hts); rate = Math.round(((l.rate || 0) + (l.extras || []).reduce((a, x) => a + (x.rate || 0), 0)) * 10) / 10; duty += Number(p.duty) || 0; entry = e.entry_no; }
    const ours = it.code ? r2(it.value * it.code.total / 100) : null;
    rows.push({ key: it.key, product_id: it.product.id, name: it.name, sku: it.sku, ours: it.code ? { hts: it.code.hts, rate: it.code.total, duty: ours } : null, broker: found ? { hts, rate, duty: r2(duty), entry } : null,
      diff: found && ours != null ? r2(duty - ours) : null, same: found && it.code ? digits(hts) === digits(it.code.hts) : null });
  }
  return { rows, entries: saved.map((e) => ({ id: e.id, entry_no: e.entry_no, total: e.total, duty: e.duty, status: e.status })), at: now() };
}

/** Email to the broker: lines where our defensible code is lower than what was filed. */
function correctionEmail(draft, cmp, { from = 'Lulyboo', shipment = '' } = {}) {
  const rows = (cmp?.rows || []).filter((x) => x.broker && x.ours && !x.same && x.diff > 0);
  if (!rows.length) return null;
  const items = Object.fromEntries((draft.items || []).map((it) => [it.key, it]));
  const body = ['Hello,', '', `For entry ${rows[0].broker.entry || ''} (${shipment}), we reviewed the classification of these items and believe the following codes are correct:`, '',
    ...rows.flatMap((x) => [`• ${x.sku ? `${x.sku} — ` : ''}${x.name}: filed ${x.broker.hts} (${x.broker.rate}%), we propose ${x.ours.hts} (${x.ours.rate}%).`, `  Reason: ${items[x.key]?.code?.why || ''}`]),
    '', 'Could you please review and, if you agree, file a post-summary correction? If you disagree, please let us know which code you would use and why.', '', 'Thank you,', from];
  return { subject: `Classification review — entry ${rows[0].broker.entry || ''}`, body: body.join('\n'), n: rows.length, save: r2(rows.reduce((a, x) => a + x.diff, 0)) };
}

module.exports = { build, lines, header, compare, correctionEmail, itemsOf, globalExtras, missing, MPF, HMF, fmt };
