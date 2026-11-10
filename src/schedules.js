'use strict';
// Sailing schedules: ocean departures from the main China ports to Los Angeles / Long Beach.
//
// Two sources, both free:
//   1. Carrier APIs in the DCSA "Commercial Schedules" format (point-to-point routes). Each carrier is switched on
//      with env vars once you have registered on its developer portal:
//         DCSA_<CODE>_URL         full URL of the point-to-point endpoint, e.g. https://…/v1/point-to-point-routes
//         DCSA_<CODE>_KEY         API key           (sent in DCSA_<CODE>_KEY_HEADER, default "API-Key")
//      or OAuth client credentials:
//         DCSA_<CODE>_TOKEN_URL, DCSA_<CODE>_CLIENT_ID, DCSA_<CODE>_CLIENT_SECRET
//      <CODE> is the carrier's SCAC: CMDU (CMA CGM), MAEU (Maersk), MSCU (MSC), HLCU (Hapag-Lloyd), ONEY (ONE), ZIMU (ZIM).
//      Each lane is fetched at most once a week, so a whole month costs a few dozen requests.
//   2. Forwarder schedules (Excel / CSV / PDF / photo / email text), read by AI. Upload on the page, or forward the
//      email to schedules@<inbound domain>. This covers COSCO, OOCL, Matson, SM Line and the others without an API.

const AI = require('./ai');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

const ORIGINS = [
  { code: 'CNNGB', name: 'Ningbo', zh: '宁波', alias: /ningbo|zhoushan|\bnbo\b|cnnbo|cnnbg|\bnb\b/i },
  { code: 'CNSHA', name: 'Shanghai', zh: '上海', alias: /shanghai|yangshan|waigaoqiao|\bsha\b|cnsha/i },
  { code: 'CNYTN', name: 'Yantian', zh: '盐田', alias: /yantian|shenzhen|shekou|\bytn\b|cnytn|cnszx|cnshk/i },
  { code: 'CNCAN', name: 'Guangzhou', zh: '广州', alias: /guangzhou|nansha|huangpu|\bcan\b|cncan|cnnsa|cnhua/i },
];
const DESTS = [
  { code: 'USLGB', name: 'Long Beach', alias: /long\s*beach|\blgb\b|uslgb/i },
  { code: 'USLAX', name: 'Los Angeles', alias: /los\s*angeles|\blax?\b|uslax|san\s*pedro/i },
];
const PORT = Object.fromEntries([...ORIGINS, ...DESTS].map((p) => [p.code, p]));
function portCode(s) {
  const v = String(s || '').trim(); if (!v) return null;
  const up = v.toUpperCase().replace(/\s+/g, '');
  if (PORT[up]) return up;
  for (const p of [...ORIGINS, ...DESTS]) if (p.alias.test(v)) return p.code;
  return null;
}

// Carrier names as forwarders and APIs write them → one display name each.
const CARRIERS = [
  ['COSCO', /cosco|\bcosu\b|\bcco\b/i], ['OOCL', /oocl|\booLU\b/i], ['CMA CGM', /cma|cgm|\bcmdu\b|\bapl\b/i], ['Matson', /matson|\bmatu\b/i],
  ['SM Line', /sm\s*line|\bsmlm\b|sml\b/i], ['Wan Hai', /wan\s*hai|\bwhlc\b/i], ['Evergreen', /evergreen|\begl\b|\beglv\b/i],
  ['HMM', /\bhmm\b|hyundai|\bhdmu\b/i], ['ONE', /\bone\b|ocean network|\boney\b/i], ['KMTC', /kmtc|korea marine/i],
  ['Yang Ming', /yang\s*ming|\bymlu\b|\bym\b/i], ['Maersk', /maersk|\bmaeu\b|\bmsk\b|sealand/i], ['MSC', /\bmsc\b|mediterranean|\bmscu\b/i],
  ['Hapag-Lloyd', /hapag|\bhlcu\b|\bhpl\b/i], ['ZIM', /\bzim\b|\bzimu\b/i], ['CStar', /cstar|c-star/i],
];
function carrierName(s) {
  const v = String(s || '').trim(); if (!v) return null;
  for (const [name, re] of CARRIERS) if (re.test(v)) return name;
  return v.slice(0, 40);
}

const API_CARRIERS = [['CMDU', 'CMA CGM'], ['MAEU', 'Maersk'], ['MSCU', 'MSC'], ['HLCU', 'Hapag-Lloyd'], ['ONEY', 'ONE'], ['ZIMU', 'ZIM']];
const env = (k) => String(process.env[k] || '').trim();
function apiSources() {
  return API_CARRIERS.map(([code, name]) => {
    const p = `DCSA_${code}_`;
    const url = env(`${p}URL`);
    const oauth = env(`${p}TOKEN_URL`) && env(`${p}CLIENT_ID`) && env(`${p}CLIENT_SECRET`);
    return { code, name, url, configured: !!(url && (env(`${p}KEY`) || oauth)), oauth: !!oauth };
  });
}

const _tokens = new Map();
async function authHeaders(code) {
  const p = `DCSA_${code}_`;
  if (env(`${p}TOKEN_URL`)) {
    const c = _tokens.get(code);
    if (c && c.exp > Date.now() + 60_000) return { Authorization: `Bearer ${c.token}` };
    const res = await fetch(env(`${p}TOKEN_URL`), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env(`${p}CLIENT_ID`), client_secret: env(`${p}CLIENT_SECRET`) }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`${code} sign-in failed (${res.status})`);
    _tokens.set(code, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 });
    return { Authorization: `Bearer ${j.access_token}` };
  }
  return { [env(`${p}KEY_HEADER`) || 'API-Key']: env(`${p}KEY`) };
}

const isoDay = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
const loc = (x) => x?.UNLocationCode || x?.facility?.UNLocationCode || x?.location?.UNLocationCode || x?.address?.UNLocationCode || x?.UNLocation?.UNLocationCode || null;

/** DCSA point-to-point routes → sailings. Tolerant of the small differences between carriers' versions. */
function parseDcsa(json, carrier) {
  const routes = Array.isArray(json) ? json : json?.routes || json?.pointToPointRoutes || json?.data || [];
  const out = [];
  for (const r of routes) {
    const legs = (r.legs || []).slice().sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    const vessels = legs.filter((l) => /vessel/i.test(l.transport?.modeOfTransport || l.modeOfTransport || 'VESSEL'));
    const main = vessels.find((l) => /^US/.test(loc(l.arrival?.location || l.arrival) || '')) || vessels[0] || legs[0];
    if (!main) continue;
    const first = legs[0]; const last = legs[legs.length - 1];
    const origin = portCode(loc(r.placeOfReceipt) || loc(first?.departure?.location || first?.departure));
    const destination = portCode(loc(r.placeOfDelivery) || loc(last?.arrival?.location || last?.arrival));
    const etd = isoDay(r.placeOfReceipt?.dateTime || first?.departure?.dateTime);
    const eta = isoDay(r.placeOfDelivery?.dateTime || last?.arrival?.dateTime);
    if (!origin || !destination || !etd) continue;
    const t = main.transport || {}; const sp = (t.servicePartners || [])[0] || {};
    const cut = (code) => isoDay((r.cutOffTimes || []).find((c) => c.cutOffDateTimeCode === code)?.cutOffDateTime);
    const via = vessels.slice(0, -1).map((l) => loc(l.arrival?.location || l.arrival)).filter(Boolean);
    out.push({
      carrier, origin, destination, etd, eta,
      transit_days: Number.isFinite(Number(r.transitTime)) ? Math.round(Number(r.transitTime)) : eta ? Math.round((Date.parse(eta) - Date.parse(etd)) / 864e5) : null,
      vessel: t.vessel?.name || t.vesselName || null, imo: t.vessel?.vesselIMONumber || null,
      voyage: sp.carrierExportVoyageNumber || t.carrierExportVoyageNumber || t.universalExportVoyageReference || null,
      service: sp.carrierServiceName || sp.carrierServiceCode || t.carrierServiceName || null,
      direct: vessels.length <= 1, via: via.join(', ') || null,
      cy_cutoff: cut('FCO') || cut('LCO'), doc_cutoff: cut('DCO') || cut('ECP'),
    });
  }
  return out;
}

async function fetchLane(src, origin, destination, { from, to }) {
  const u = new URL(src.url);
  u.searchParams.set('placeOfReceipt', origin); u.searchParams.set('placeOfDelivery', destination);
  u.searchParams.set('departureStartDate', from); u.searchParams.set('departureEndDate', to);
  u.searchParams.set('limit', '100');
  const res = await fetch(u, { headers: { Accept: 'application/json', 'API-Version': '1', ...(await authHeaders(src.code)) }, signal: AbortSignal.timeout(30000) });
  const txt = await res.text();
  if (res.status === 404 || res.status === 204) return [];
  if (!res.ok) throw new Error(`${src.name} ${res.status}: ${txt.slice(0, 160)}`);
  let j; try { j = JSON.parse(txt || '[]'); } catch { throw new Error(`${src.name}: answer was not JSON`); }
  return parseDcsa(j, src.name);
}

const keyOf = (s) => [s.carrier, s.origin, s.destination, String(s.vessel || '').toLowerCase().replace(/[^a-z0-9]/g, ''), String(s.voyage || '').toLowerCase().replace(/[^a-z0-9]/g, ''), s.vessel || s.voyage ? '' : s.etd].join('|');

/** Insert or update sailings; same carrier + lane + vessel + voyage = same sailing. */
async function upsert(db, rows, { source, sourceName = null, batch = null }) {
  let added = 0; let updated = 0;
  if (!rows.length) return { added, updated };
  const min = rows.reduce((a, r) => (r.etd < a ? r.etd : a), rows[0].etd);
  const d = new Date(Date.parse(min) - 21 * 864e5).toISOString().slice(0, 10);
  const existing = await db.list('sailings', { filters: { etd: ['gte', d] } });
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const now = new Date().toISOString();
  for (const r of rows) {
    const row = { ...r, source, source_name: sourceName, fetched_at: now };
    const hit = byKey.get(keyOf(r));
    if (hit) {
      // A carrier API is more reliable than a forwarder file: don't let a file overwrite API dates.
      if (hit.source === 'api' && source !== 'api') continue;
      await db.update('sailings', { id: hit.id }, { ...row, batch: hit.batch || batch, updated_at: now }); updated++;
    } else { const ins = await db.insert('sailings', { ...row, batch }); byKey.set(keyOf(ins), ins); added++; }
  }
  return { added, updated };
}

/** Weekly refresh of every configured carrier API for every lane. */
async function runRefresh({ db, force = false, days = 75 }) {
  const srcs = apiSources().filter((s) => s.configured);
  const out = { fetched: 0, added: 0, updated: 0, errors: [] };
  if (!srcs.length) return out;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  const recent = force ? [] : await db.list('sailings', { filters: { source: 'api', fetched_at: ['gte', new Date(Date.now() - 6.5 * 864e5).toISOString()] }, select: 'carrier,origin,destination' }).catch(() => []);
  const fresh = new Set(recent.map((r) => `${r.carrier}|${r.origin}|${r.destination}`));
  for (const src of srcs) {
    for (const o of ORIGINS) for (const d of DESTS) {
      if (fresh.has(`${src.name}|${o.code}|${d.code}`)) continue;
      try {
        const rows = (await fetchLane(src, o.code, d.code, { from, to })).filter((r) => r.origin === o.code && r.destination === d.code);
        const u = await upsert(db, rows, { source: 'api', sourceName: `${src.name} API` });
        out.fetched++; out.added += u.added; out.updated += u.updated;
      } catch (e) { out.errors.push(`${src.name} ${o.name}→${d.name}: ${e.message}`); }
    }
  }
  if (out.errors.length) console.error('Schedule refresh:', out.errors.slice(0, 5).join(' | '));
  return out;
}

// ── Forwarder schedules read by AI ──────────────────────────────────────────
const TOOL = {
  name: 'record_sailings',
  description: 'Record every ocean sailing in a forwarder or carrier sailing schedule (China → USA West Coast).',
  input_schema: {
    type: 'object',
    properties: {
      forwarder: { type: 'string', description: 'Company that issued the schedule, if shown' },
      sailings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            carrier: { type: 'string', description: 'Shipping line, e.g. COSCO, OOCL, CMA CGM, Matson' },
            service: { type: 'string', description: 'Service / loop name or code, e.g. AAC, PCS1, CLX' },
            vessel: { type: 'string' }, voyage: { type: 'string' },
            origin_port: { type: 'string', description: 'Port of loading as written, e.g. Ningbo, Shanghai, Yantian, Nansha' },
            destination_port: { type: 'string', description: 'Port of discharge as written, e.g. Los Angeles, Long Beach' },
            etd: { type: 'string', description: 'Departure date YYYY-MM-DD (resolve the year from the schedule month)' },
            eta: { type: 'string', description: 'Arrival date YYYY-MM-DD' },
            transit_days: { type: 'integer' },
            cy_cutoff: { type: 'string', description: 'Container / CY cut-off date YYYY-MM-DD' },
            doc_cutoff: { type: 'string', description: 'Documentation / SI cut-off date YYYY-MM-DD' },
            via: { type: 'string', description: 'Transshipment port(s); empty for direct' },
          },
          required: ['carrier', 'origin_port', 'destination_port', 'etd'],
        },
      },
    },
    required: ['sailings'],
  },
};

const AI_DOC = /\.(pdf|png|jpe?g|webp)$/i;
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function tableText(rows) {
  return rows.map((r, i) => { const c = r.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()); while (c.length && !c[c.length - 1]) c.pop(); return c.some(Boolean) ? `R${i + 1}: ${c.join(' | ')}` : null; })
    .filter(Boolean).slice(0, 900).join('\n').slice(0, 160000);
}

function cleanRow(x) {
  const origin = portCode(x.origin_port); const destination = portCode(x.destination_port);
  const etd = isoDay(x.etd); const eta = isoDay(x.eta);
  if (!origin || !destination || !etd || !/^CN/.test(origin) || !/^US/.test(destination)) return null;
  const via = String(x.via || '').trim();
  let transit = Number.isFinite(Number(x.transit_days)) && Number(x.transit_days) > 0 ? Math.round(Number(x.transit_days)) : null;
  if (!transit && eta) transit = Math.round((Date.parse(eta) - Date.parse(etd)) / 864e5);
  return {
    carrier: carrierName(x.carrier) || 'Unknown', service: String(x.service || '').trim().slice(0, 60) || null,
    vessel: String(x.vessel || '').trim().slice(0, 80) || null, voyage: String(x.voyage || '').trim().slice(0, 40) || null,
    origin, destination, etd, eta, transit_days: transit && transit > 0 && transit < 90 ? transit : null,
    cy_cutoff: isoDay(x.cy_cutoff), doc_cutoff: isoDay(x.doc_cutoff),
    direct: !via || /^(direct|-|n\/a|none)$/i.test(via), via: via && !/^(direct|-|n\/a|none)$/i.test(via) ? via.slice(0, 80) : null,
  };
}

/** Read one schedule (file or plain text) with AI and save the sailings on our lanes. */
async function importSchedule(db, { name = 'schedule', buffer = null, text = '', batch, by = 'upload' }) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const content = []; let table = '';
  const n = String(name).toLowerCase(); const ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (buffer) {
    if (AI_DOC.test(n)) content.push(MIME[ext] === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: MIME[ext], data: buffer.toString('base64') } });
    else if (/\.(xlsx|xlsm)$/.test(n) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) table = tableText(parseXlsx(buffer));
    else table = tableText(parseCsv(decodeText(buffer)));
  }
  const year = new Date().getFullYear();
  content.push({ type: 'text', text: `Today is ${new Date().toISOString().slice(0, 10)} (dates without a year are ${year} or ${year + 1}). Record every sailing in this schedule.${table ? `\n\n${table}` : ''}${text ? `\n\n${String(text).slice(0, 60000)}` : ''}` });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 16000 });
  const all = Array.isArray(result?.sailings) ? result.sailings : [];
  const rows = all.map(cleanRow).filter(Boolean);
  const forwarder = String(result?.forwarder || '').trim().slice(0, 80) || null;
  const u = await upsert(db, rows, { source: by === 'email' ? 'email' : 'file', sourceName: forwarder || name, batch });
  return { ...u, read: all.length, kept: rows.length, skipped: all.length - rows.length, forwarder };
}

const SHEET_FILE = /\.(xlsx|xlsm|xls|csv|pdf|png|jpe?g|webp)$/i;
/** Email to schedules@…: every attached schedule (or the email text) is read and saved. */
async function handleScheduleEmail({ db, config, from, subject = '', text = '', files = [] }) {
  const batch = `email-${Date.now().toString(36)}`;
  const docs = files.filter((f) => f.buffer?.length > 2000 && SHEET_FILE.test(f.name || ''));
  const results = [];
  for (const f of docs) {
    try { results.push({ name: f.name, ...(await importSchedule(db, { name: f.name, buffer: f.buffer, batch, by: 'email' })) }); }
    catch (e) { results.push({ name: f.name, error: e.message }); }
  }
  if (!docs.length && String(text).trim().length > 40) {
    try { results.push({ name: subject || 'email', ...(await importSchedule(db, { name: subject || 'email', text, batch, by: 'email' })) }); }
    catch (e) { results.push({ name: subject || 'email', error: e.message }); }
  }
  const added = results.reduce((a, r) => a + (r.added || 0), 0); const updated = results.reduce((a, r) => a + (r.updated || 0), 0);
  try {
    const { sendEmail } = require('./email'); const P = require('./projects');
    const to = P.ownerEmails();
    if (to.length) await sendEmail(config, { to, subject: `Sailing schedule from ${from}: ${added} new, ${updated} updated`,
      text: `${results.map((r) => (r.error ? `${r.name}: could not be read (${r.error})` : `${r.name}: ${r.kept} sailings on your lanes (${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} other ports skipped` : ''})`)).join('\n')}\n\nOpen: ${config.publicUrl}/admin/logistics/schedules` });
  } catch (e) { console.error('Schedule email notice failed:', e.message); }
  return { ok: true, batch, added, updated, results };
}

module.exports = { ORIGINS, DESTS, PORT, portCode, carrierName, apiSources, parseDcsa, fetchLane, upsert, runRefresh, importSchedule, handleScheduleEmail, cleanRow, keyOf, TOOL, SHEET_FILE };
