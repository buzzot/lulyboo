'use strict';
// Sailing schedules page: /admin/logistics/schedules — a month calendar of departures from Ningbo, Shanghai, Yantian and
// Guangzhou to Los Angeles / Long Beach, fed by carrier APIs and forwarder schedules read by AI.

const { html, raw, fmt } = require('../lib/html');
const { parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const SC = require('../schedules');
const AI = require('../ai');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COLORS = { COSCO: '#1f5fa8', OOCL: '#c8202f', 'CMA CGM': '#0a2a5c', Matson: '#2f6fb5', 'SM Line': '#d64545', 'Wan Hai': '#e07b00', Evergreen: '#1a8a4a', HMM: '#f08a00', ONE: '#d4007a', KMTC: '#2d4f9e', 'Yang Ming': '#d9a400', Maersk: '#42b0d5', MSC: '#a58b4c', 'Hapag-Lloyd': '#f26b00', ZIM: '#24356e' };
const color = (c) => COLORS[c] || '#6b7280';
const short = (iso) => { if (!iso) return '—'; const d = new Date(`${iso}T12:00:00Z`); return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`; };
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.BUSINESS_TZ || 'America/Los_Angeles' });
/** Tabs shared by the Logistics pages. */
const logisticsTabs = (active) => html`<div class="lg-top"><h1>Logistics</h1><nav class="lg-tabs" aria-label="Logistics">
  <a href="/admin/logistics/schedules" class="lg-tab${active === 'schedules' ? ' is-on' : ''}" ${active === 'schedules' ? raw('aria-current="page"') : ''}>Sailing schedules</a>
  <a href="/admin/logistics" class="lg-tab${active === 'costs' ? ' is-on' : ''}" ${active === 'costs' ? raw('aria-current="page"') : ''}>Costs &amp; freight rates</a></nav></div>`;

/** Compact "next departures" strip for the Logistics costs page. */
async function nextSailings(db, n = 8) {
  const today = todayIso();
  const rows = await db.list('sailings', { filters: { etd: ['gte', today] }, order: 'etd.asc', limit: 60 }).catch(() => []);
  const list = rows.slice(0, n);
  return html`<section class="card lg-next"><div class="lg-h"><h2>Next sailings to LA / Long Beach</h2><a class="link small" href="/admin/logistics/schedules">Full schedule ›</a></div>
    ${list.length ? html`<div class="lg-next-row">${list.map((s) => html`<a class="lg-sail" href="/admin/logistics/schedules?month=${s.etd.slice(0, 7)}#s-${s.id}" style="--c:${color(s.carrier)}">
      <span class="lg-sail-d">${short(s.etd)}</span><b>${s.carrier}</b><span class="sub">${SC.PORT[s.origin]?.name || s.origin} → ${s.destination === 'USLAX' ? 'LA' : 'LB'}${s.transit_days ? ` · ${s.transit_days}d` : ''}${s.direct === false ? ' · T/S' : ''}</span>${s.cy_cutoff ? html`<span class="lg-cut">Cut-off ${short(s.cy_cutoff)}</span>` : ''}</a>`)}</div>`
    : html`<p class="muted">No upcoming sailings yet. <a href="/admin/logistics/schedules">Add a forwarder schedule</a> or connect a carrier API.</p>`}</section>`;
}

const inboundDomain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();

function schedulesRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  router.get('/admin/logistics/schedules', G(async (req, res) => {
    const q = req.query;
    const today = todayIso();
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : today.slice(0, 7);
    const [y, mo] = month.split('-').map(Number);
    const first = `${month}-01`; const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const origins = String(q.from || '').split(',').filter((c) => SC.PORT[c] && /^CN/.test(c));
    const from = origins.length ? origins : SC.ORIGINS.map((o) => o.code);
    const to = ['USLGB', 'USLAX'].includes(q.to) ? [q.to] : ['USLGB', 'USLAX'];
    const direct = q.direct === '1';
    let all = [];
    let missingTable = false;
    try { all = await db.list('sailings', { filters: { etd: ['gte', first] }, order: 'etd.asc' }); }
    catch (e) { if (/sailings|PGRST205|relation/i.test(e.message)) missingTable = true; else throw e; }
    const inMonth = all.filter((s) => s.etd <= last);
    const carriers = [...new Set(inMonth.map((s) => s.carrier))].sort();
    const carrier = carriers.includes(q.carrier) ? q.carrier : '';
    const list = inMonth.filter((s) => from.includes(s.origin) && to.includes(s.destination) && (!direct || s.direct !== false) && (!carrier || s.carrier === carrier));
    const upcoming = list.filter((s) => s.etd >= today);
    const fastest = list.filter((s) => s.transit_days).sort((a, b) => a.transit_days - b.transit_days)[0];
    const byDay = {}; for (const s of list) (byDay[s.etd] = byDay[s.etd] || []).push(s);

    const url = (over = {}) => {
      const p = { month, from: origins.join(','), to: to.length === 1 ? to[0] : '', carrier, direct: direct ? '1' : '', ...over };
      const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();
      return `/admin/logistics/schedules${s ? `?${s}` : ''}`;
    };
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    const toggleOrigin = (c) => { const set = new Set(origins.length ? origins : []); if (set.has(c)) set.delete(c); else set.add(c); return [...set].join(','); };

    // Calendar: Monday-first weeks covering the month.
    const startDow = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
    const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysIn; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
    while (cells.length % 7) cells.push(null);
    const chip = (s) => html`<a class="sl-chip" href="#s-${s.id}" style="--c:${color(s.carrier)}" title="${s.carrier}${s.vessel ? ` · ${s.vessel}` : ''}${s.voyage ? ` ${s.voyage}` : ''} · ${SC.PORT[s.origin]?.name} → ${SC.PORT[s.destination]?.name} · ETA ${short(s.eta)}${s.cy_cutoff ? ` · CY cut-off ${short(s.cy_cutoff)}` : ''}"><b>${s.carrier}</b><span>${SC.PORT[s.origin]?.name.slice(0, 3)}${s.transit_days ? ` · ${s.transit_days}d` : ''}${s.direct === false ? ' · T/S' : ''}</span></a>`;

    const srcs = SC.apiSources();
    const batches = {};
    for (const s of all) if (s.batch) { const b = (batches[s.batch] = batches[s.batch] || { batch: s.batch, name: s.source_name, source: s.source, n: 0, at: s.created_at }); b.n++; if (s.created_at > b.at) b.at = s.created_at; }
    const recentBatches = Object.values(batches).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
    const lastApi = all.filter((s) => s.source === 'api').reduce((a, s) => (s.fetched_at > a ? s.fetched_at : a), '');

    res.html(page({
      title: 'Sailing schedules · Logistics', nav: adminNav('logistics'), flash: takeFlash(req, res), wide: true, req,
      body: html`${logisticsTabs('schedules')}<div class="sl-head"><div><h2 class="sl-title">Sailing schedules</h2><p>Departures from China's main ports to Los Angeles and Long Beach. Carrier APIs refresh weekly; forwarder schedules are read by AI.</p></div>
        <div class="sl-month"><a class="btn ghost small" href="${url({ month: prev })}" aria-label="Previous month">‹</a><b>${MONTHS[mo - 1]} ${y}</b><a class="btn ghost small" href="${url({ month: next })}" aria-label="Next month">›</a>${month !== today.slice(0, 7) ? html`<a class="link small" href="${url({ month: today.slice(0, 7) })}">This month</a>` : ''}</div></div>
      ${missingTable ? html`<p class="flash warn">Run the sailing schedules SQL in Supabase first (supabase/schema.sql, "Sailing schedules").</p>` : ''}
      <div class="sl-filters card">
        <div class="sl-f"><span class="sl-k">From</span>${SC.ORIGINS.map((o) => html`<a class="sl-pill ${origins.includes(o.code) ? 'on' : ''}" href="${url({ from: toggleOrigin(o.code) })}">${o.name}</a>`)}${origins.length ? html`<a class="link small" href="${url({ from: '' })}">All</a>` : ''}</div>
        <div class="sl-f"><span class="sl-k">To</span><a class="sl-pill ${to.length === 2 ? 'on' : ''}" href="${url({ to: '' })}">LA + Long Beach</a>${SC.DESTS.map((d) => html`<a class="sl-pill ${to.length === 1 && to[0] === d.code ? 'on' : ''}" href="${url({ to: d.code })}">${d.name}</a>`)}</div>
        <form class="sl-f" method="get" action="/admin/logistics/schedules"><input type="hidden" name="month" value="${month}"><input type="hidden" name="from" value="${origins.join(',')}"><input type="hidden" name="to" value="${to.length === 1 ? to[0] : ''}">
          <span class="sl-k">Line</span><select name="carrier" onchange="this.form.submit()"><option value="">All lines</option>${carriers.map((c) => html`<option ${c === carrier ? raw('selected') : ''}>${c}</option>`)}</select>
          <label class="sl-direct"><input type="checkbox" name="direct" value="1" ${direct ? raw('checked') : ''} onchange="this.form.submit()"> Direct only</label></form>
      </div>
      <div class="kpis sl-kpis">
        <div class="kpi"><span>Sailings this month</span><b>${list.length}</b></div>
        <div class="kpi"><span>Still to depart</span><b>${upcoming.length}</b></div>
        <div class="kpi"><span>Lines</span><b>${new Set(list.map((s) => s.carrier)).size}</b></div>
        <div class="kpi"><span>Fastest</span><b>${fastest ? `${fastest.transit_days} days` : '—'}</b>${fastest ? html`<small>${fastest.carrier} · ${short(fastest.etd)}</small>` : ''}</div>
      </div>
      <section class="card sl-cal"><div class="sl-dow">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<span>${d}</span>`)}</div>
        <div class="sl-grid">${cells.map((d) => (d ? html`<div class="sl-day ${d === today ? 'today' : ''} ${d < today ? 'past' : ''}"><span class="sl-dn">${Number(d.slice(8))}</span>${(byDay[d] || []).slice(0, 5).map(chip)}${(byDay[d] || []).length > 5 ? html`<a class="sl-more" href="#d-${d}">+${byDay[d].length - 5} more</a>` : ''}</div>` : html`<div class="sl-day off"></div>`))}</div>
        ${!list.length ? html`<p class="muted sl-empty">No sailings for this month yet. Upload a forwarder schedule below${srcs.some((s) => s.configured) ? ' or refresh the carrier APIs' : ''}.</p>` : ''}
      </section>
      ${list.length ? html`<section class="card"><h2>All departures</h2><div class="table-wrap"><table class="list sl-table"><thead><tr><th>Departs</th><th>Line</th><th>Vessel / voyage</th><th>Route</th><th>Arrives</th><th class="r">Transit</th><th>CY cut-off</th><th>Doc cut-off</th><th>Source</th><th></th></tr></thead>
        <tbody>${list.map((s, i) => html`<tr id="s-${s.id}" class="${s.etd < today ? 'past' : ''}">${i === 0 || list[i - 1].etd !== s.etd ? raw(`<td id="d-${s.etd}">`) : raw('<td>')}<b>${short(s.etd)}</b></td>
          <td><span class="sl-dot" style="--c:${color(s.carrier)}"></span>${s.carrier}${s.service ? html`<div class="sub">${s.service}</div>` : ''}</td>
          <td>${s.vessel || '—'}${s.voyage ? html`<div class="sub">${s.voyage}</div>` : ''}</td>
          <td>${SC.PORT[s.origin]?.name || s.origin} → ${SC.PORT[s.destination]?.name || s.destination}${s.direct === false ? html`<div class="sub">via ${s.via || 'transshipment'}</div>` : html`<div class="sub">Direct</div>`}</td>
          <td>${short(s.eta)}</td><td class="r">${s.transit_days ? `${s.transit_days} d` : '—'}</td><td>${short(s.cy_cutoff)}</td><td>${short(s.doc_cutoff)}</td>
          <td><span class="sl-src ${s.source}">${s.source === 'api' ? 'API' : s.source === 'email' ? 'Email' : 'File'}</span>${s.source_name ? html`<div class="sub">${s.source_name}</div>` : ''}</td>
          <td><form method="post" action="/admin/logistics/schedules/${s.id}/delete" class="inline" onsubmit="return confirm('Remove this sailing?')"><button class="icon-btn" title="Remove" aria-label="Remove">×</button></form></td></tr>`)}</tbody></table></div></section>` : ''}
      <div class="sl-sources">
        <section class="card"><h2>Add a forwarder schedule</h2><p class="sub">Excel, CSV, PDF or a photo of the monthly schedule. AI reads every sailing and keeps the ones on your lanes.</p>
          <form method="post" action="/admin/logistics/schedules/import" enctype="multipart/form-data" data-busy>
            <div class="mdrop small" data-filebox><div class="mdrop-box"><input type="file" name="file" multiple accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp" aria-label="Choose schedule files"><span class="dz-main" data-main>Drag & drop schedules here, or choose files</span><span class="dz-hint">Excel, CSV, PDF, JPG, PNG · up to 20 MB</span></div><ul class="dz-list" data-list></ul><p class="dz-note" data-note role="status"></p></div>
            <label class="sl-paste">Or paste schedule text<textarea name="text" rows="3" placeholder="Paste a schedule table or email text"></textarea></label>
            <button class="btn" ${AI.enabled() ? '' : raw('disabled title="Set ANTHROPIC_API_KEY to read schedules"')}>Read schedule</button></form>
          <p class="sub sl-mail">Or forward the forwarder's email to <code>schedules@${inboundDomain()}</code> <button type="button" class="btn small ghost" data-copy-text="schedules@${inboundDomain()}">Copy</button></p>
          ${recentBatches.length ? html`<h3 class="sl-h3">Recent imports</h3><ul class="sl-batches">${recentBatches.map((b) => html`<li><span>${b.name || 'Schedule'} · ${b.n} sailing${b.n === 1 ? '' : 's'} · ${fmt.date(b.at)}</span><form method="post" action="/admin/logistics/schedules/batch/${encodeURIComponent(b.batch)}/delete" class="inline" onsubmit="return confirm('Remove the sailings from this import?')"><button class="link small">Undo</button></form></li>`)}</ul>` : ''}
        </section>
        <section class="card"><div class="head-row"><h2>Carrier APIs</h2><form method="post" action="/admin/logistics/schedules/refresh" class="inline" data-busy><button class="btn small ghost" ${srcs.some((s) => s.configured) ? '' : raw('disabled')}>Refresh now</button></form></div>
          <p class="sub">Free DCSA schedule APIs. Each lane is checked once a week.${lastApi ? ` Last update ${fmt.date(lastApi)}.` : ''}</p>
          <ul class="sl-api">${srcs.map((s) => html`<li><span class="sl-dot" style="--c:${color(s.name)}"></span><b>${s.name}</b><span class="${s.configured ? 'ok' : 'muted'}">${s.configured ? 'Connected' : 'Not connected'}</span>${s.configured ? '' : html`<code>${s.code === 'MAEU' ? 'MAERSK_CONSUMER_KEY' : `DCSA_${s.code}_URL + DCSA_${s.code}_KEY`}</code>`}</li>`)}</ul>
          <p class="sub">Register on the carrier's developer portal, then add its schedule URL and key in Railway → Variables. COSCO, OOCL, Matson, SM Line and the other lines without a public API come from forwarder schedules.</p>
        </section>
      </div>`,
    }));
  }));

  router.get('/admin/schedules', (req, res) => res.redirect(`/admin/logistics/schedules${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));

  router.post('/admin/logistics/schedules/import', G(async (req, res) => {
    const { fields, files } = await parseForm(req, { limitBytes: (config.maxUploadBytes || 20 * 1024 * 1024) * 3 });
    const list = (files.file ? [].concat(files.file) : []).filter((f) => f.buffer?.length);
    const text = String(fields.text || '').trim();
    if (!list.length && text.length < 20) { flash(res, 'error', 'Choose a schedule file or paste the schedule text'); return res.redirect('/admin/logistics/schedules'); }
    const batch = `up-${Date.now().toString(36)}`;
    const msgs = []; let firstEtd = null;
    for (const f of list) {
      if (!SC.SHEET_FILE.test(f.name || '')) { msgs.push(`${f.name}: not a schedule file`); continue; }
      try { const r = await SC.importSchedule(db, { name: f.name, buffer: f.buffer, batch }); msgs.push(`${f.name}: ${r.kept} sailings (${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} on other routes skipped` : ''})`); }
      catch (e) { msgs.push(`${f.name}: could not be read (${String(e.message).slice(0, 120)})`); }
    }
    if (text.length >= 20) {
      try { const r = await SC.importSchedule(db, { name: 'Pasted schedule', text, batch }); msgs.push(`Pasted text: ${r.kept} sailings (${r.added} new, ${r.updated} updated)`); }
      catch (e) { msgs.push(`Pasted text: could not be read (${String(e.message).slice(0, 120)})`); }
    }
    try { firstEtd = (await db.list('sailings', { filters: { batch }, order: 'etd.asc', limit: 1 }))[0]?.etd || null; } catch { /* ignore */ }
    flash(res, msgs.some((x) => /could not|not a schedule/.test(x)) ? 'error' : 'ok', msgs.join(' · '));
    res.redirect(`/admin/logistics/schedules${firstEtd ? `?month=${firstEtd.slice(0, 7)}` : ''}`);
  }));

  router.post('/admin/logistics/schedules/refresh', G(async (req, res) => {
    await parseForm(req).catch(() => null);
    const r = await SC.runRefresh({ db, force: true });
    flash(res, r.errors.length ? 'error' : 'ok', `Carrier APIs: ${r.added} new, ${r.updated} updated sailings${r.errors.length ? ` · ${r.errors.length} lane(s) failed: ${r.errors[0]}` : ''}`);
    res.redirect('/admin/logistics/schedules');
  }));

  router.post('/admin/logistics/schedules/:id/delete', G(async (req, res) => {
    await parseForm(req).catch(() => null);
    await db.remove('sailings', { id: req.params.id });
    flash(res, 'ok', 'Sailing removed');
    res.redirect('/admin/logistics/schedules');
  }));

  router.post('/admin/logistics/schedules/batch/:batch/delete', G(async (req, res) => {
    await parseForm(req).catch(() => null);
    const rows = await db.list('sailings', { filters: { batch: req.params.batch }, select: 'id' });
    for (const r of rows) await db.remove('sailings', { id: r.id });
    flash(res, 'ok', `Removed ${rows.length} sailing${rows.length === 1 ? '' : 's'} from that import`);
    res.redirect('/admin/logistics/schedules');
  }));
}

module.exports = schedulesRoutes;
module.exports.logisticsTabs = logisticsTabs;
module.exports.nextSailings = nextSailings;
