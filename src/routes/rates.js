'use strict';
// Logistics → Rate history: forwarder quotes kept for comparing forwarders and prices.

const { html, raw } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const SCR = require('./schedules');
const PL = require('../planning');
const RH = require('../rate-history');

const BASE = '/admin/logistics/rates';
const TYPES = ['20GP', '40GP', '40HQ', 'LCL'];
const TYPE_NAME = { '20GP': "20' GP", '40GP': "40' GP", '40HQ': "40' HQ", LCL: 'LCL' };
const usd = (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const unitOf = (box) => (box === 'LCL' ? ' /W/M' : '');
const hours = (h) => (h == null ? '—' : h < 24 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} d`);
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

module.exports = function rateRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  async function load() {
    try { await RH.syncAll(db); return { rows: await db.list('freight_quotes', { order: 'quoted_on.desc' }) }; }
    catch (e) { if (RH.missingTable(e)) return { rows: [], missing: true }; throw e; }
  }

  router.get(BASE, G(async (req, res) => {
    const { rows, missing } = await load();
    const canDel = require('../staff').can(require('../staff').current()?.role || 'admin', 'delete');
    const q = req.query;
    const basis = q.basis === 'ocean' ? 'ocean' : 'allin';
    const lanes = [...new Set(rows.map(RH.laneOf))];
    const count = (fn) => { const m = {}; for (const r of rows.filter(fn)) m[RH.laneOf(r)] = (m[RH.laneOf(r)] || 0) + 1; return m; };
    const lc = count(() => true);
    lanes.sort((a, b) => lc[b] - lc[a]);
    const lane = lanes.includes(q.lane) ? q.lane : lanes[0] || '';
    const onLane = rows.filter((r) => RH.laneOf(r) === lane);
    const types = TYPES.filter((t) => onLane.some((r) => r.box === t));
    const box = types.includes(q.box) ? q.box : [...types].sort((a, b) => onLane.filter((r) => r.box === b).length - onLane.filter((r) => r.box === a).length)[0] || '40HQ';
    const set = onLane.filter((r) => r.box === box);
    const stats = RH.forwarderStats(set.filter((r) => !r.excluded), basis);
    const rds = RH.rounds(set).filter((rd) => rd.rows.length);
    const rd = rds.find((x) => x.key === q.round) || rds[0];
    const link = (o) => `${BASE}?${new URLSearchParams({ lane, box, basis, ...o })}`;
    const priceTxt = (r) => { const v = RH.priceOf(r, basis); return v == null ? '—' : `${usd(v)}${unitOf(r.box)}`; };
    const per = box === 'LCL' ? ' per W/M' : ` per ${TYPE_NAME[box]}`;

    const roundView = () => {
      if (!rd) return '';
      const ps = rd.rows.map((r) => [r, RH.priceOf(r, basis)]).sort((a, b) => (a[1] ?? 1e12) - (b[1] ?? 1e12));
      const mx = Math.max(...ps.map(([, v]) => v || 0)) || 1;
      const lo = Math.min(...ps.filter(([, v]) => v != null).map(([, v]) => v));
      const r0 = rd.rows[0];
      const label = (x) => { const a = x.rows[0]; return `${PL.short(x.on)} · ${a.box === 'LCL' ? `LCL${a.wm ? ` · ${a.wm} W/M` : ''}` : TYPE_NAME[a.box]}${a.cbm && a.box !== 'LCL' ? ` · ${a.cbm} m³` : ''} · ${x.rows.length} quote${x.rows.length > 1 ? 's' : ''}`; };
      return html`<section class="card"><div class="rh-head"><h2 class="sec">Same request, side by side</h2>
        ${rds.length > 1 ? html`<form method="get" action="${BASE}" class="rh-f"><input type="hidden" name="lane" value="${lane}"><input type="hidden" name="box" value="${box}"><input type="hidden" name="basis" value="${basis}"><select name="round" data-autosubmit aria-label="Request">${rds.map((x) => html`<option value="${x.key}" ${x.key === rd.key ? raw('selected') : ''}>${label(x)}</option>`)}</select><noscript><button class="btn small">Show</button></noscript></form>` : html`<span class="sub">${label(rd)}</span>`}</div>
        ${ps.map(([r, v]) => html`<div class="rh-br"><span class="rh-bn">${r.company}${r.chosen ? html` <span class="cp-tag ok">Chosen</span>` : ''}</span>
          <div class="rh-bt"><i class="${v === lo ? 'lo' : ''}" style="width:${v == null ? 0 : Math.max(3, Math.round(v / mx * 100))}%"></i></div>
          <b class="rh-bv">${v == null ? '—' : `${usd(v)}${unitOf(r.box)}`}</b><span class="sub">${[r.transit_days != null ? `${r.transit_days} days` : '', r.reply_hours != null ? `replied in ${hours(r.reply_hours)}` : ''].filter(Boolean).join(' · ')}</span></div>`)}
        ${r0.box === 'LCL' && r0.wm ? html`<p class="sub rh-foot">${r0.cbm} m³${r0.kg ? ` · ${Number(r0.kg).toLocaleString('en-US')} kg` : ''} = ${r0.wm} W/M</p>` : ''}
      </section>`;
    };

    res.html(page({
      title: 'Rate history · Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`${SCR.logisticsTabs('rates')}${require('./freight').subTabs('quotes')}
        ${missing ? html`<p class="flash warn">Run the rate history SQL in Supabase first (supabase/rate-history.sql).</p>` : ''}
        <div class="cp-head"><div><h2 class="sl-title">Rate history</h2><p class="muted">Every priced forwarder quote, kept even after the container is gone. Compared like for like: same lane, same container type; LCL per W/M.</p></div>
          ${rows.length ? html`<a class="btn ghost small" href="${BASE}/export.csv">Export CSV</a>` : ''}</div>
        ${!rows.length ? html`<section class="card"><p class="muted">No quotes yet. When forwarders reply to a request for quotation from Load containers, their prices are kept here.</p></section>` : html`
        <div class="rh-filters">
          <form method="get" action="${BASE}" class="rh-f"><input type="hidden" name="basis" value="${basis}"><select name="lane" data-autosubmit aria-label="Lane">${lanes.map((l) => html`<option value="${l}" ${l === lane ? raw('selected') : ''}>${RH.laneName(l)} (${lc[l]})</option>`)}</select><noscript><button class="btn small">Show</button></noscript></form>
          <div class="rh-seg" role="group" aria-label="Container type">${types.map((t) => html`<a href="${link({ box: t, round: '' })}" class="${t === box ? 'on' : ''}">${TYPE_NAME[t]}</a>`)}</div>
          <div class="rh-seg" role="group" aria-label="Price">${[['allin', 'All-in'], ['ocean', 'Ocean only']].map(([k, l]) => html`<a href="${link({ basis: k, round: rd?.key || '' })}" class="${k === basis ? 'on' : ''}">${l}</a>`)}</div>
        </div>
        <div class="rh-two">
          ${roundView()}
          <section class="card"><div class="rh-head"><h2 class="sec">Forwarders on this lane</h2><span class="sub">${TYPE_NAME[box]} · ${basis === 'ocean' ? 'ocean' : 'all-in'}${per}</span></div>
            <div class="table-wrap"><table class="list rh-t"><thead><tr><th>Forwarder</th><th class="r">Quotes</th><th class="r">Median</th><th class="r">Last</th><th class="r" title="Times cheapest in the same request">Cheapest</th><th class="r">Won</th><th class="r">Reply</th></tr></thead><tbody>
            ${stats.map((s) => html`<tr><td><b>${s.company}</b></td><td class="r">${s.n}</td><td class="r">${usd(s.median)}</td><td class="r">${usd(s.last)}<div class="sub">${PL.short(s.lastOn)}</div></td><td class="r">${s.cheapest ? `${s.cheapest}×` : '—'}</td><td class="r">${s.won || '—'}</td><td class="r">${hours(s.reply)}</td></tr>`)}
            </tbody></table></div></section>
        </div>
        <section class="card flush"><div class="rh-head pad"><h2 class="sec">Records <span class="sub">${set.length}</span></h2><span class="sub">${RH.laneName(lane)} · ${TYPE_NAME[box]}</span></div>
          <div class="table-wrap"><table class="list rh-t"><thead><tr><th>Quoted</th><th>Forwarder</th><th>Volume</th><th class="r">Ocean</th><th class="r">All-in</th>${box === 'LCL' ? html`<th class="r">Per W/M</th>` : ''}<th>Carrier</th><th class="r">Days</th><th>Valid to</th><th></th><th>Quote</th><th></th></tr></thead><tbody>
          ${set.map((r) => html`<tr class="${r.excluded ? 'done' : ''}"><td>${PL.short(r.quoted_on)}</td><td><b>${r.company}</b></td>
            <td>${r.box === 'LCL' ? (r.wm ? `${r.wm} W/M` : r.cbm ? `${r.cbm} m³` : '—') : r.cbm ? `${r.cbm} m³` : '—'}</td>
            <td class="r">${usd(r.ocean_usd)}</td><td class="r"><b>${usd(r.total_usd)}</b></td>${box === 'LCL' ? html`<td class="r">${priceTxt(r)}</td>` : ''}
            <td>${r.carrier || '—'}</td><td class="r">${r.transit_days ?? '—'}</td><td>${r.valid_until ? PL.short(r.valid_until) : '—'}</td>
            <td>${r.chosen ? html`<span class="cp-tag ok">Chosen</span>` : ''}${r.excluded ? html`<span class="cp-tag">Left out</span>` : ''}</td>
            <td class="sub">${r.code || ''}</td>
            <td class="rh-acts" data-armbox><form method="post" action="${BASE}/${r.id}/exclude" class="inline"><input type="hidden" name="back" value="${link({ round: rd?.key || '' })}"><input type="hidden" name="excluded" value="${r.excluded ? '' : '1'}"><button class="link small">${r.excluded ? 'Include' : 'Leave out'}</button></form>
              ${canDel ? html`<button type="button" class="bd-del rh-del" data-arm title="${r.quote_id ? 'Also removes this reply from the container on Load containers' : 'Delete this quote'}">Delete</button><button type="submit" class="bd-yes" form="${`rh-del-${r.id}`}">✓ Delete</button>
              <form id="${`rh-del-${r.id}`}" method="post" action="${BASE}/${r.id}/delete" hidden><input type="hidden" name="back" value="${link({ round: rd?.key || '' })}"></form>` : ''}</td></tr>`)}
          </tbody></table></div></section>`}`,
    }));
  }));

  router.post(`${BASE}/:id/exclude`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    const r = await db.get('freight_quotes', req.params.id).catch(() => null);
    if (!r) throw new HttpError(404, 'Record not found');
    await db.update('freight_quotes', { id: r.id }, { excluded: !!fields.excluded, updated_at: new Date().toISOString() });
    flash(res, 'ok', fields.excluded ? 'Left out of the comparison.' : 'Included again.');
    res.redirect(String(fields.back || '').startsWith(BASE) ? fields.back : BASE);
  }));

  // Delete a quote for good. A reply to a quote request is the same quote as on Load containers: both go.
  router.post(`${BASE}/:id/delete`, G(async (req, res) => {
    const { fields } = await parseForm(req);
    const ST = require('../staff');
    if (!ST.can(ST.current()?.role || 'admin', 'delete')) throw new HttpError(403, 'Only an Admin can delete. Use Leave out instead.');
    const r = await db.get('freight_quotes', req.params.id).catch(() => null);
    if (!r) throw new HttpError(404, 'Record not found');
    if ((r.files || []).length) await db.docs.remove(r.files.map((x) => x.path)).catch(() => null);
    if (r.quote_id) await db.remove('plan_quotes', { id: r.quote_id }).catch(() => null);
    await db.remove('freight_quotes', { id: r.id });
    flash(res, 'ok', `Deleted: ${r.company || 'quote'} ${PL.short(r.quoted_on)}${r.ocean_usd != null ? ` · ${usd(r.ocean_usd)}` : ''}`);
    res.redirect(String(fields.back || '').startsWith(BASE) ? fields.back : BASE);
  }));

  router.get(`${BASE}/export.csv`, G(async (req, res) => {
    const { rows } = await load();
    const cols = [['quoted_on', 'Quoted'], ['company', 'Forwarder'], ['pol', 'From'], ['pod', 'To'], ['box', 'Type'], ['cbm', 'm3'], ['kg', 'kg'], ['wm', 'W/M'], ['currency', 'Currency'], ['ocean_usd', 'Ocean USD'], ['total_usd', 'All-in USD'], ['per_wm', 'All-in per W/M'], ['carrier', 'Carrier'], ['vessel', 'Vessel'], ['etd', 'ETD'], ['eta', 'ETA'], ['transit_days', 'Transit days'], ['valid_until', 'Valid until'], ['free_days', 'Free days'], ['reply_hours', 'Reply hours'], ['chosen', 'Chosen'], ['excluded', 'Left out'], ['code', 'Quote']];
    const body = [cols.map(([, l]) => l).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(k === 'pod' && r.pod === 'LALB' ? 'Los Angeles / Long Beach' : typeof r[k] === 'boolean' ? (r[k] ? 'yes' : '') : r[k])).join(','))].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="freight-rate-history-${PL.today()}.csv"`, 'Cache-Control': 'private, no-store' });
    res.end(`﻿${body}`);
  }));
};
