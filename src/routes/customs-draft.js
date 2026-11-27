'use strict';
// Shipment → Customs draft (our own 7501 before the broker files). See src/customs-draft.js for the logic.
//   GET  /admin/orders/shipments/:id/customs-draft           the draft (or a start screen)
//   POST /admin/orders/shipments/:id/customs-draft/build     make / refresh it (rerun=all → AI again with photos)
//   POST /admin/orders/shipments/:id/customs-draft/info      documents + note for one product → re-classify it
//   POST /admin/orders/shipments/:id/customs-draft/keep      after the broker's 7501: keep ours / the broker's code
//   POST /admin/orders/shipments/:id/customs-draft/email     correction request to the broker

const crypto = require('node:crypto');
const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { guard } = require('./admin');
const { page, adminNav } = require('../views/layout');
const { ddSel } = require('./logistics-costs');
const PL = require('../planning');
const CD = require('../customs-draft');
const AI = require('../ai');
const ST = require('../staff');

const BASE = '/admin/orders/shipments';
const usd = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (v) => (v == null ? '—' : v === 0 ? 'Free' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
const num = (v) => Number(v || 0).toLocaleString('en-US');
const dmy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : null);
const now = () => new Date().toISOString();
const DOC_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

module.exports = function customsDraftRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const by = () => ST.current()?.name || 'Owner';
  const SH = require('./shipments');
  async function shipment(id) {
    const { list } = await SH.load(db); const r = list.find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'Shipment not found');
    if (!r.c || r.kind === 'courier' || r.kind === 'record') throw new HttpError(400, 'A customs draft is for containers and LCL shipments');
    return r;
  }
  const getDraft = async (r) => { try { return (await db.list('customs_drafts', { filters: { container_id: r.c.id } }))[0] || null; } catch (e) { if (CD.missing(e)) return undefined; throw e; } };
  const slim = (items) => items.map((it) => ({ ...it, product: it.product ? { id: it.product.id, name: it.product.product_name, sku: it.product.supplier_sku } : null }));

  async function make(r, { rerun = new Set(), notes = {} } = {}) {
    const entries = await db.list('customs_entries').catch(() => []);
    const out = await CD.build(db, r, { by: by(), rerun, notes, entries });
    const L = CD.lines(out.items, { ocean: true });
    const data = { header: CD.header(r), items: slim(out.items), lines: L.lines.map((l) => ({ ...l, items: l.items.map((it) => it.key) })), totals: L.totals, errors: out.errors, ai: AI.enabled() };
    const prev = await getDraft(r);
    const row = { container_id: r.c.id, data, notes, built_at: now(), built_by: by(), updated_at: now() };
    const cmp = CD.compare(data, (entries || []).filter((e) => e.container_id === r.c.id));
    if (cmp) row.compare = cmp;
    if (prev) await db.update('customs_drafts', { id: prev.id }, row); else await db.insert('customs_drafts', { ...row, created_at: now() });
    return { data, errors: out.errors };
  }

  router.get(`${BASE}/:id/customs-draft`, G(async (req, res) => {
    const r = await shipment(req.params.id); const d = await getDraft(r);
    const title = `${r.title || 'Shipment'}`;
    const crumb = html`<nav class="crumb"><a href="${BASE}">Shipments</a> › <a href="${`${BASE}/${r.id}`}">${title}</a></nav>`;
    if (d === undefined) return res.html(page({ title: 'Customs draft', nav: adminNav('shipments'), wide: true, flash: takeFlash(req, res), req, body: html`${crumb}<h1>Customs draft · 7501</h1><div class="notice warn"><b>One step left</b><p>Run <code>supabase/customs-drafts.sql</code> in the Supabase SQL editor to turn on customs drafts.</p></div>` }));
    if (!d) {
      return res.html(page({ title: 'Customs draft', nav: adminNav('shipments'), wide: true, flash: takeFlash(req, res), req, body: html`${crumb}
        <div class="cd-top"><div><h1>Customs draft · 7501</h1><p class="muted">Our own entry summary before the broker files: every product of this shipment classified from the catalog, its photos and specs, with duty, Section 301 and the China extras, and the lower-duty codes that can be defended. Compare with the broker's 7501 when it arrives.</p></div></div>
        <section class="card cd-start"><p><b>${r.lines.length} PO line${r.lines.length === 1 ? '' : 's'}</b> from ${[...new Set(r.lines.map((l) => l.po))].length} POs. Products classified before reuse their saved classification (rates refreshed); the others are classified now${AI.enabled() ? '' : ' — AI is off, so only codes already on file are used'}. It can take a minute.</p>
          <form method="post" action="${`${BASE}/${r.id}/customs-draft/build`}" data-busy><button class="btn">Prepare the draft</button></form></section>` }));
    }
    const D = d.data || {}; const T = D.totals || {}; const H = D.header || {};
    const items = Object.fromEntries((D.items || []).map((it) => [it.key, it]));
    const cmp = d.compare || null;
    const canSend = require('../email').emailConfigured?.() || process.env.EMAIL_DEV_LOG === 'true';
    const brokerTo = await require('../payments').brokerEmail(db).catch(() => '');
    const mail = cmp ? CD.correctionEmail(D, cmp, { shipment: title }) : null;
    const hd = (n, l, v, warn) => html`<div><i>${n}</i><span>${l}</span><b class="${warn ? 'mut' : ''}">${v || 'to fill'}</b></div>`;
    const fitTag = (it) => (it.unclassified ? html`<em class="cd-fit w">${it.unclassified}</em>` : it.code.checked ? html`<em class="cd-fit s">checked code</em>` : (it.alts || []).some((x) => x.save > 0) ? html`<em class="cd-fit p">lower code possible</em>` : (it.missing || []).length ? html`<em class="cd-fit p">needs info</em>` : it.code.fit === 'strong' ? html`<em class="cd-fit s">strong fit</em>` : html`<em class="cd-fit p">${it.code.fit} fit</em>`);
    const rk = (x) => (x.ok ? (x.save > 0 ? 'am' : 'ok') : 'no');
    const detail = (it) => (it.unclassified || !it.code ? '' : html`<details class="cd-x" ${(it.alts || []).some((x) => x.save > 0) ? raw('open') : ''}><summary>${it.sku ? `${it.sku} · ` : ''}${it.name} — why ${it.code.hts}${(it.alts || []).length ? ' & alternatives' : ''}</summary>
      <p><b>Broker note.</b> ${it.code.why || '—'}${it.code.checked ? ' This is the code a person checked and saved on the product.' : ''}</p>
      ${(it.alts || []).length ? html`<table class="cd-alt"><thead><tr><th>HTS</th><th>Line</th><th class="r">Rate</th><th class="r">Duty</th><th class="r">vs draft</th><th>Risk</th></tr></thead><tbody>
        <tr class="on"><td>${it.code.hts}</td><td>${it.code.title}</td><td class="r">${pct(it.code.total)}</td><td class="r">${usd(it.value * it.code.total / 100)}</td><td class="r">—</td><td><span class="rk ok">in draft</span></td></tr>
        ${it.alts.map((x) => html`<tr><td>${x.hts}</td><td title="${x.why}">${x.title || x.why.slice(0, 80)}</td><td class="r">${x.total == null ? '' : pct(x.total)}</td><td class="r">${x.duty == null ? '' : usd(x.duty)}</td><td class="r ${x.save > 0 ? 'g' : ''}">${x.save > 0 ? `−${usd(x.save)}` : x.ok && x.duty != null ? `+${usd(x.duty - it.value * it.code.total / 100)}` : ''}</td><td><span class="rk ${rk(x)}">${x.risk}${x.save > 0 ? ' · ask the broker, or a CBP ruling' : ''}</span>${x.why ? html`<small>${x.why}</small>` : ''}</td></tr>`)}</tbody></table>` : ''}
      ${(it.missing || []).length ? html`<p class="cd-need">To be sure: ${it.missing.join(' · ')}. <a href="#cd-info">Add info ↓</a></p>` : ''}
      ${(it.code.notes || []).length ? html`<p class="cd-need">${it.code.notes.join(' · ')}</p>` : ''}</details>`);
    const lineRows = (D.lines || []).map((l) => { const its = l.items.map((k) => items[k]).filter(Boolean); const c = l.code;
      return html`<tr class="ln"><td>${l.no}</td><td><b>${its.length === 1 ? its[0].name : its.map((x) => x.name).join(' · ')}</b><small>${its.map((x) => x.sku).filter(Boolean).join(' · ')} · PO ${[...new Set(its.flatMap((x) => x.pos))].join(', ')}</small>${its.map(fitTag)}</td>
        <td class="h">${c ? html`${c.hts}${l.extras.map((x) => html`<br><span title="${x.label}">${x.code}</span>`)}` : '—'}</td>
        <td class="r">${l.kg ? `${num(l.kg)} kg` : '—'}<br><span>${num(l.ctns)} ctns</span></td><td class="r">${num(l.qty)} NO</td><td class="r">${usd(l.value)}${its.some((x) => x.noPrice) ? html`<br><span class="cd-warn">price missing</span>` : ''}</td>
        <td class="r">${c ? html`${pct(c.base)}${l.extras.map((x) => html`<br><span>${pct(x.rate)}</span>`)}` : '—'}</td>
        <td class="r">${c ? html`${usd(l.base)}${l.extras.map((x) => html`<br><span>${usd(x.duty)}</span>`)}` : '—'}</td></tr>
        ${its.some((x) => x.code && ((x.alts || []).length || (x.missing || []).length)) ? html`<tr class="xp"><td></td><td colspan="7">${its.map(detail)}</td></tr>` : ''}`; });
    const savers = (D.items || []).filter((it) => (it.alts || []).some((x) => x.save > 0)).map((it) => { const a = it.alts.filter((x) => x.save > 0).sort((x, y) => y.save - x.save)[0]; return html`<li><b>${it.sku || it.name} · ${a.hts}</b> — up to −${usd(a.save)}. ${a.risk === 'defensible' ? 'The classifier rates it a strong fit too: ask the broker to file it.' : 'Possible, needs the facts above: ask the broker, or request a CBP binding ruling.'}</li>`; });
    const needs = (D.items || []).filter((it) => (it.missing || []).length || it.unclassified);
    const prodOpts = (D.items || []).filter((it) => it.product).map((it) => [it.product.id, `${it.sku ? `${it.sku} · ` : ''}${it.name}`]);
    const cmpCard = html`<section class="card cd-cmp" id="cd-cmp"><h3>Compare with the broker's 7501</h3>
      ${cmp ? html`<p class="sub">Entry ${cmp.entries.map((e) => `${e.entry_no || '—'}${e.status === 'pending' ? ' (to review)' : ''}`).join(', ')} · per product: our code and duty vs the broker's. Pick the code to keep — it's saved on the product for the next order.</p>
        <table class="cd-ct"><thead><tr><th>Product</th><th>Our draft</th><th>Broker</th><th class="r">Our duty</th><th class="r">Broker duty</th><th class="r">Difference</th><th>Keep for next orders</th></tr></thead><tbody>
        ${cmp.rows.map((x) => html`<tr class="${x.broker ? '' : 'mut'}"><td><b>${x.sku || x.name}</b><small>${x.sku ? x.name : ''}</small></td><td>${x.ours ? `${x.ours.hts} · ${pct(x.ours.rate)}` : '—'}</td><td>${x.broker ? `${x.broker.hts} · ${pct(x.broker.rate)}` : 'not on the 7501'}</td>
          <td class="r">${x.ours ? usd(x.ours.duty) : '—'}</td><td class="r">${x.broker ? usd(x.broker.duty) : '—'}</td><td class="r ${x.diff > 0 ? 'g' : x.diff < 0 ? 'bad' : ''}">${x.diff == null ? '—' : x.same ? 'same code' : x.diff > 0 ? `ours −${usd(x.diff)}` : `broker −${usd(-x.diff)}`}</td>
          <td>${x.broker && x.ours && !x.same ? html`<form method="post" action="${`${BASE}/${r.id}/customs-draft/keep`}" class="cd-keep"><input type="hidden" name="product_id" value="${x.product_id}"><button class="link small" name="which" value="ours">Ours</button> · <button class="link small" name="which" value="broker">Broker's</button></form>` : x.same ? '✓' : ''}</td></tr>`)}</tbody></table>
        ${mail ? html`<div class="cd-mail"><p><b>${mail.n} line${mail.n === 1 ? '' : 's'} filed higher than our draft (${usd(mail.save)}).</b> If you agree with our codes, ask the broker to file a post-summary correction.</p><button type="button" class="btn small" data-open-dialog="cd-mail">Draft the email…</button></div>
          <dialog id="cd-mail" class="rp-modal" aria-labelledby="cd-mail-t"><form method="post" action="${`${BASE}/${r.id}/customs-draft/email`}" data-busy><div class="rp-top"><h2 id="cd-mail-t">Correction request to the broker</h2><button type="button" class="icon-btn" data-close-dialog aria-label="Close">×</button></div>
            <label>To <input type="email" name="to" value="${brokerTo}" required placeholder="broker@…"></label><label>Subject <input name="subject" value="${mail.subject}"></label><label>Message <textarea name="body" rows="12" data-grow>${mail.body}</textarea></label>
            <div class="rp-acts"><button type="button" class="btn ghost" data-close-dialog>Cancel</button><button class="btn" ${canSend ? '' : raw('disabled title="Email is not configured"')}>Send</button></div></form></dialog>` : ''}`
        : html`<p class="sub">When the broker's entry summary comes in (email to customs@ or + Forwarder update on the shipment), each product is compared here: our code and duty vs the broker's. You pick the code to keep per product, and where ours is lower and defensible the portal drafts a correction request to the broker.</p>`}</section>`;
    res.html(page({
      title: 'Customs draft', nav: adminNav('shipments'), wide: true, flash: takeFlash(req, res), req,
      body: html`${crumb}
      <div class="cd-top"><div><h1>Customs draft · 7501</h1><p class="muted">Our own entry summary before the broker files — made ${PL.short(String(d.built_at).slice(0, 10))} by ${d.built_by || '—'}. Advice for checking the broker, not for filing.</p></div>
        <div class="cd-acts">${T.open ? html`<span class="cd-pill amb">${T.open} product${T.open === 1 ? '' : 's'} to check</span>` : html`<span class="cd-pill ok">All lines classified</span>`}
          <form method="post" action="${`${BASE}/${r.id}/customs-draft/build`}" data-busy class="inline"><button class="btn ghost small" title="Refresh rates and the 7501 from the shipment">↻ Refresh</button></form>
          <form method="post" action="${`${BASE}/${r.id}/customs-draft/build`}" data-busy class="inline"><input type="hidden" name="rerun" value="all"><button class="btn ghost small" data-confirm="Classify every product again with AI, from the photos and documents? It takes a minute.">Re-run AI</button></form>
          <button type="button" class="btn small" data-print>Print / PDF</button></div></div>
      ${(D.errors || []).length ? html`<div class="notice warn"><p>Not classified: ${D.errors.join(' · ')}</p></div>` : ''}
      <div class="cd-sum">
        <div><span>Entered value</span><b>${usd(T.value)}</b><small>FOB · ${(D.lines || []).length} line${(D.lines || []).length === 1 ? '' : 's'} · ${(D.items || []).length} product${(D.items || []).length === 1 ? '' : 's'}</small></div>
        <div><span>Estimated duty &amp; fees</span><b>${usd(T.total)}</b><small>${T.pct == null ? '' : `${T.pct}% of value`}</small></div>
        <div class="${T.save > 0 ? 'g' : ''}"><span>With the lower defensible codes</span><b>${usd(T.best)}</b><small>${T.save > 0 ? `save up to ${usd(T.save)} · needs checks below` : 'no lower code found'}</small></div>
        <div><span>Broker's 7501</span>${cmp ? html`<b>${usd(cmp.entries.reduce((a, e) => a + (Number(e.total) || 0), 0))}</b><small><a href="#cd-cmp">compared below</a></small>` : html`<b class="mut">not yet</b><small>compared here when it arrives</small>`}</div></div>
      <section class="card cd-form">
        <div class="cd-fh"><b>ENTRY SUMMARY</b><span>CBP Form 7501 · draft, not for filing</span></div>
        <div class="cd-hd">${hd(2, 'Entry type', H.entry_type)}${hd(6, 'Port code', H.port)}${hd(8, 'Importing carrier', H.carrier, !H.carrier)}${hd(9, 'Mode', H.mode)}${hd(10, 'Country of origin', H.origin)}${hd(11, 'Import date', dmy(H.import_date), !H.import_date)}${hd(12, 'B/L no.', H.bl, !H.bl)}
          ${hd(14, 'Exporting country', H.exporting)}${hd(15, 'Export date', dmy(H.export_date), !H.export_date)}${hd(19, 'Foreign port of lading', H.lading)}${hd(20, 'U.S. port of unlading', H.unlading)}${hd('', 'Container', H.container, !H.container)}${hd(25, 'Ultimate consignee', H.consignee)}${hd(26, 'Importer of record', H.importer)}</div>
        <table class="cd-t"><thead><tr><th>27<br>Line</th><th>28 Description · AI notes</th><th>29 HTSUS no.</th><th class="r">30 Gross wt · ctns</th><th class="r">31 Net qty</th><th class="r">32 Entered value</th><th class="r">33 Rate</th><th class="r">34 Duty</th></tr></thead>
          <tbody>${lineRows}</tbody></table>
        <div class="cd-tot"><div class="cd-tl"><p><b>Rates.</b> Base rate from the USITC schedule; Section 301 from the Chapter 99 heading the line points to; the China-wide extra (9903.01.xx) as paid on the last 7501. Value is the PO price (FOB) × quantity — freight and insurance are not dutiable. MPF ${CD.MPF.pct}% (min ${usd(CD.MPF.min)}, max ${usd(CD.MPF.max)}), HMF ${CD.HMF}%.</p></div>
          <div class="cd-tr"><div><i>37</i><span>Duty</span><b>${usd(T.duty)}</b></div><div><i></i><span>Section 301</span><b>${usd(T.s301)}</b></div><div><i></i><span>Other Chapter 99 (China extra)</span><b>${usd(T.other)}</b></div><div><i>39</i><span>MPF · HMF</span><b>${usd((T.mpf || 0) + (T.hmf || 0))}</b></div><div class="t"><i>40</i><span>Total</span><b>${usd(T.total)}</b></div></div></div></section>
      <div class="cd-2"><section class="card cd-lev"><h3>Ways to pay less — legally</h3><ul>${savers}
          <li><b>First-sale value</b> — if a supplier is a trading company buying from the factory, duty can be paid on the factory's price. Needs the factory invoice and a broker who supports it.</li>
          <li><b>Next orders</b> — a lower heading through a real product change (e.g. selling a set's items separately) counts only if the goods really change.</li></ul>
          <p class="sub">Not offered: codes that don't describe the goods, or another country of origin — those are misdeclarations (CBP can claim the duty back with penalties up to 4× the duty).</p></section>
        <section class="card cd-docs" id="cd-info"><h3>Product info &amp; documents for the AI</h3>
          ${needs.length ? html`<p class="cd-need">Open questions: ${needs.map((it) => `${it.sku || it.name} (${it.unclassified || it.missing.slice(0, 2).join('; ')})`).join(' · ')}</p>` : ''}
          ${prodOpts.length ? html`<form method="post" action="${`${BASE}/${r.id}/customs-draft/info`}" enctype="multipart/form-data" data-busy>
            <label class="cd-note">Product${ddSel('product_id', (needs.find((it) => it.product) || {}).product?.id || prodOpts[0][0], prodOpts)}</label>
            <div class="mdrop small" data-filebox data-max="5"><div class="mdrop-box"><input type="file" name="files" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" title="" aria-label="Documents"><span class="dz-main" data-main>Drop specs, photos, component lists, factory answers — or paste (⌘V)</span><span class="dz-hint">PDF or images · saved to the product's documents too</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <label class="cd-note">Note for the AI <textarea name="note" rows="2" maxlength="1500" placeholder="e.g. Mirror is acrylic, shatter-proof. In the feeder set the rattle is about 60% of the value."></textarea></label>
            <button class="btn small" ${AI.enabled() ? '' : raw('disabled title="AI is not configured"')}>Add &amp; re-classify this product</button></form>` : html`<p class="sub">No catalog products matched the PO lines.</p>`}
          ${Object.entries(d.notes || {}).filter(([, v]) => v).length ? html`<ul class="cd-fl">${Object.entries(d.notes).filter(([, v]) => v).map(([pid, v]) => html`<li>📝 ${(D.items || []).find((it) => it.product?.id === pid)?.sku || 'Product'}: <small>${v}</small></li>`)}</ul>` : ''}</section></div>
      ${cmpCard}`,
    }));
  }));

  router.post(`${BASE}/:id/customs-draft/build`, G(async (req, res) => {
    const r = await shipment(req.params.id); const { fields } = await parseForm(req).catch(() => ({ fields: {} }));
    const d = await getDraft(r); if (d === undefined) { flash(res, 'warn', 'Run supabase/customs-drafts.sql in Supabase first.'); return res.redirect(`${BASE}/${r.id}/customs-draft`); }
    const rerun = new Set(fields.rerun === 'all' ? (await CD.itemsOf(db, r)).filter((it) => it.product).map((it) => it.product.id) : []);
    const out = await make(r, { rerun, notes: d?.notes || {} });
    flash(res, out.errors.length ? 'warn' : 'ok', `Draft ready: ${usd(out.data.totals.total)} estimated${out.errors.length ? ` · ${out.errors.length} not classified` : ''}`);
    res.redirect(`${BASE}/${r.id}/customs-draft`);
  }));

  router.post(`${BASE}/:id/customs-draft/info`, G(async (req, res) => {
    const r = await shipment(req.params.id); const { fields, files } = await parseForm(req, { limitBytes: 40 * 1024 * 1024 });
    const d = await getDraft(r); if (!d) throw new HttpError(400, 'Prepare the draft first');
    const p = await db.get('products', String(fields.product_id || '')).catch(() => null); if (!p) throw new HttpError(400, 'Choose the product');
    let n = 0;
    for (const f of [].concat(files?.files || []).filter((x) => x?.buffer?.length).slice(0, 5)) {
      const name = String(f.name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150); const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      if (!DOC_TYPES[ext]) continue;
      const id = crypto.randomUUID(); const path = `${p.supplier_id}/${id}${ext}`;
      await db.docs.upload(path, f.buffer, DOC_TYPES[ext]);
      await db.insert('supplier_documents', { id, supplier_id: p.supplier_id, product_id: p.id, name, mime: DOC_TYPES[ext], bytes: f.buffer.length, path, kind: 'customs' }).catch(async (e) => { await db.docs.remove([path]).catch(() => {}); throw e; });
      n++;
    }
    const note = String(fields.note || '').trim().slice(0, 1500);
    const notes = { ...(d.notes || {}) }; if (note) notes[p.id] = notes[p.id] ? `${notes[p.id]}\n${note}`.slice(-1500) : note;
    const out = await make(r, { rerun: new Set([p.id]), notes });
    flash(res, out.errors.length ? 'warn' : 'ok', `${p.supplier_sku || p.product_name}: ${n ? `${n} file${n === 1 ? '' : 's'} added, ` : ''}re-classified${out.errors.length ? ` · ${out.errors.join(' · ')}` : ''}`);
    res.redirect(`${BASE}/${r.id}/customs-draft`);
  }));

  router.post(`${BASE}/:id/customs-draft/keep`, G(async (req, res) => {
    const r = await shipment(req.params.id); const { fields } = await parseForm(req);
    const d = await getDraft(r); const row = (d?.compare?.rows || []).find((x) => x.product_id === fields.product_id);
    if (!row || !row.broker || !row.ours) throw new HttpError(400, 'Nothing to keep for this product');
    const p = await db.get('products', row.product_id); const dig = (s) => String(s || '').replace(/\D/g, '');
    if (fields.which === 'ours') {
      await db.update('products', { id: p.id }, { hts_original_code: p.hts_original_code || dig(row.broker.hts), hts_declare_code: dig(row.ours.hts), hts_declare_pct: row.ours.rate, hts_verified_code: dig(row.ours.hts), hts_checked_by: by(), hts_checked_at: now(), updated_at: now() });
      flash(res, 'ok', `${p.supplier_sku || p.product_name}: ${row.ours.hts} saved as the code to declare on the next order`);
    } else {
      await db.update('products', { id: p.id }, { hts_declare_code: null, hts_declare_pct: null, hts_verified_code: dig(row.broker.hts), hts_original_code: dig(row.broker.hts), hts_checked_by: by(), hts_checked_at: now(), updated_at: now() });
      flash(res, 'ok', `${p.supplier_sku || p.product_name}: keeping the broker's ${row.broker.hts}`);
    }
    res.redirect(`${BASE}/${r.id}/customs-draft#cd-cmp`);
  }));

  router.post(`${BASE}/:id/customs-draft/email`, G(async (req, res) => {
    const r = await shipment(req.params.id); const { fields } = await parseForm(req);
    const to = String(fields.to || '').trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, "Enter the broker's email");
    const { sendEmail } = require('../email');
    await sendEmail(config, { to, subject: String(fields.subject || 'Classification review').slice(0, 200), text: String(fields.body || '').slice(0, 10000) });
    const d = await getDraft(r); if (d) await db.update('customs_drafts', { id: d.id }, { correction_sent_at: now(), correction_to: to, updated_at: now() }).catch(() => null);
    flash(res, 'ok', `Sent to ${to}`); res.redirect(`${BASE}/${r.id}/customs-draft#cd-cmp`);
  }));
};
