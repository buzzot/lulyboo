'use strict';
// Direct carrier tracking: DHL Express (Shipment Tracking - Unified API), FedEx (Track API), UPS (Tracking API).
// Every carrier answer is turned into the same shape:
//   { status, summary, location, eta, deliveredAt, signedBy, events: [{ at, code, description, location, key }] }
// status is one of STATUSES below. No dependencies; credentials come from environment variables:
//   DHL_API_KEY
//   FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ENV=sandbox|production (default production)
//   UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_ENV=sandbox|production (default production)

const STATUSES = ['pre_transit', 'in_transit', 'customs', 'out_for_delivery', 'delivered', 'exception', 'unknown'];
const STATUS_LABEL = {
  pre_transit: ['Label created', '已创建运单'], in_transit: ['In transit', '运输中'], customs: ['Customs', '清关中'],
  out_for_delivery: ['Out for delivery', '派送中'], delivered: ['Delivered', '已签收'], exception: ['Exception', '异常'], unknown: ['Unknown', '未知'],
};
const CARRIERS = {
  dhl: { name: 'DHL Express', short: 'DHL', url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}` },
  fedex: { name: 'FedEx', short: 'FedEx', url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  ups: { name: 'UPS', short: 'UPS', url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}` },
  other: { name: 'Other', short: 'Other', url: () => null },
};

// Railway values sometimes get pasted with spaces, line breaks or quotes around them.
const env = (k) => String(process.env[k] || '').trim().replace(/^['"]|['"]$/g, '');
const clean = (n) => String(n || '').toUpperCase().replace(/[\s-]/g, '');

/** Guess the carrier from the number format. Returns 'dhl' | 'fedex' | 'ups' | null. */
function detect(no) {
  const n = clean(no);
  if (!n) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return 'ups';
  if (/^(T\d{10}|K\d{10}|H\d{10})$/.test(n)) return 'ups'; // UPS Mail Innovations / freight style
  if (/^JJD\d{10,}$|^JD\d{16,}$/.test(n)) return 'dhl';
  if (/^\d{10}$/.test(n)) return 'dhl'; // DHL Express waybill: 10 digits
  if (/^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(n)) return 'fedex'; // FedEx Express/Ground
  return null;
}

const configured = (c) => ({
  dhl: !!process.env.DHL_API_KEY,
  fedex: !!(env('FEDEX_CLIENT_ID') && env('FEDEX_CLIENT_SECRET')),
  ups: !!(env('UPS_CLIENT_ID') && env('UPS_CLIENT_SECRET')),
}[c] || false);

async function http(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: r.ok, status: r.status, json, text };
}
const apiError = (who, r) => {
  const msg = r.json?.detail || r.json?.title || r.json?.errors?.[0]?.message || r.json?.response?.errors?.[0]?.message || r.json?.message || r.text?.slice(0, 160) || '';
  const e = new Error(`${who} ${r.status}${msg ? `: ${msg}` : ''}`); e.status = r.status; return e;
};

// OAuth tokens are cached in memory until shortly before they expire.
const tokens = new Map();
async function oauth(key, url, { headers = {}, body }) {
  const hit = tokens.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  if (!r.ok || !r.json?.access_token) throw apiError(`${key} login`, r);
  const s = Number(r.json.expires_in) || 3000; // FedEx: seconds (3600); UPS: seconds as string (14399)
  tokens.set(key, { token: r.json.access_token, exp: Date.now() + Math.min(s, 86_400) * 1000 });
  return r.json.access_token;
}

// ── DHL Express ──────────────────────────────────────────────
const dhlCode = (e) => {
  const c = String(e?.statusCode || '').toLowerCase(); const d = String(e?.description || e?.status || '').toLowerCase();
  if (c === 'delivered' || /\bdelivered\b/.test(d) && !/not delivered|attempt/.test(d)) return 'delivered';
  if (/with delivery courier|out for delivery/.test(d)) return 'out_for_delivery';
  if (/customs|clearance|import charges|duty/.test(d)) return /delay|held|hold|await|required|payment|duty/.test(d) ? 'exception' : 'customs';
  if (c === 'failure' || /return|refused|incorrect address|delay|exception|not delivered/.test(d)) return 'exception';
  if (c === 'pre-transit' || /shipment information received|label/.test(d)) return 'pre_transit';
  if (c === 'transit') return 'in_transit';
  return 'unknown';
};
const dhlLoc = (l) => [l?.address?.addressLocality, l?.address?.countryCode].filter(Boolean).join(', ');
async function trackDhl(no) {
  const r = await http(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(no)}&service=express`, { headers: { 'DHL-API-Key': env('DHL_API_KEY'), accept: 'application/json' } });
  if (r.status === 404) return { found: false };
  if (!r.ok) throw apiError('DHL', r);
  const s = r.json?.shipments?.[0]; if (!s) return { found: false };
  const events = (s.events || []).map((e) => ({ at: e.timestamp, code: dhlCode(e), description: e.description || e.status || '', location: dhlLoc(e.location) }));
  const cur = s.status || events[0] || {};
  const code = dhlCode(cur);
  return {
    found: true, status: code, summary: cur.description || cur.status || '', location: dhlLoc(cur.location),
    eta: s.estimatedTimeOfDelivery || null, deliveredAt: code === 'delivered' ? cur.timestamp : null,
    signedBy: s.details?.proofOfDelivery?.signed?.name || null, events,
  };
}

// ── FedEx ────────────────────────────────────────────────────
const fedexBase = () => (process.env.FEDEX_ENV === 'sandbox' ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com');
const fedexCode = (code, desc) => {
  const c = String(code || '').toUpperCase(); const d = String(desc || '').toLowerCase();
  if (c === 'DL') return 'delivered';
  if (c === 'OD') return 'out_for_delivery';
  if (['CD', 'CC'].includes(c) || /clearance delay|customs/.test(d)) return /delay|held/.test(d) || c === 'CD' ? 'exception' : 'customs';
  if (['DE', 'DY', 'CA', 'RS', 'SE', 'DD'].includes(c) || /exception|delay|return/.test(d)) return 'exception';
  if (['OC', 'IN', 'LB'].includes(c) || /label created|shipment information sent/.test(d)) return 'pre_transit';
  if (['PU', 'IT', 'AR', 'DP', 'AF', 'OW', 'HL', 'AA', 'AC', 'FD', 'PL', 'TR', 'PM'].includes(c)) return 'in_transit';
  return d ? 'in_transit' : 'unknown';
};
const fedexLoc = (l) => [l?.city, l?.stateOrProvinceCode, l?.countryCode].filter(Boolean).join(', ');
async function trackFedex(no) {
  const token = await oauth('FedEx', `${fedexBase()}/oauth/token`, { body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('FEDEX_CLIENT_ID'), client_secret: env('FEDEX_CLIENT_SECRET') }) });
  const r = await http(`${fedexBase()}/track/v1/trackingnumbers`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-locale': 'en_US' },
    body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: no } }] }),
  });
  if (!r.ok) throw apiError('FedEx', r);
  const t = r.json?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!t || t.error?.code?.includes('NOTFOUND')) return { found: false };
  const ls = t.latestStatusDetail || {};
  const events = (t.scanEvents || []).map((e) => ({ at: e.date, code: fedexCode(e.derivedStatusCode || e.eventType, e.eventDescription || e.exceptionDescription), description: [e.eventDescription, e.exceptionDescription].filter(Boolean).join(' · '), location: fedexLoc(e.scanLocation) }));
  const dt = (type) => (t.dateAndTimes || []).find((x) => x.type === type)?.dateTime || null;
  const status = fedexCode(ls.derivedCode || ls.code, ls.description);
  return {
    found: true, status, summary: [ls.description || ls.statusByLocale, ls.delayDetail?.status ? `(${ls.delayDetail.status})` : ''].filter(Boolean).join(' '),
    location: fedexLoc(ls.scanLocation), eta: t.estimatedDeliveryTimeWindow?.window?.ends || dt('ESTIMATED_DELIVERY') || null,
    deliveredAt: status === 'delivered' ? (dt('ACTUAL_DELIVERY') || events[0]?.at) : null, signedBy: t.deliveryDetails?.receivedByName || null, events,
  };
}

// ── UPS ──────────────────────────────────────────────────────
const upsBase = () => (process.env.UPS_ENV === 'sandbox' ? 'https://wwwcie.ups.com' : 'https://onlinetools.ups.com');
const upsCode = (s) => {
  const type = String(s?.type || '').toUpperCase(); const code = String(s?.statusCode || s?.code || ''); const d = String(s?.description || '').toLowerCase();
  if (type === 'D' || code === '011' || /^delivered/.test(d)) return 'delivered';
  if (code === '021' || /out for delivery/.test(d)) return 'out_for_delivery';
  if (/customs|clearance|brokerage|import/.test(d)) return /held|delay|await|required/.test(d) ? 'exception' : 'customs';
  if (type === 'X' || type === 'RS' || /exception|delay|return|refused|incorrect/.test(d)) return 'exception';
  if (type === 'M' || type === 'MV' || code === '003' || /label created|shipper created|order processed/.test(d)) return 'pre_transit';
  if (type === 'I' || type === 'P' || type === 'O') return 'in_transit';
  return d ? 'in_transit' : 'unknown';
};
const upsLoc = (l) => { const a = l?.address || {}; return [a.city || a.City, a.stateProvince || a.StateProvinceCode, a.countryCode || a.CountryCode || a.country].filter(Boolean).join(', '); };
const upsTime = (d, t) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${(t || '000000').padEnd(6, '0').replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')}` : null);
async function trackUps(no) {
  const basic = Buffer.from(`${env('UPS_CLIENT_ID')}:${env('UPS_CLIENT_SECRET')}`).toString('base64');
  const token = await oauth('UPS', process.env.UPS_TOKEN_URL || `${upsBase()}/security/v1/oauth/token`, { headers: { authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'client_credentials' }) });
  const r = await http(`${upsBase()}/api/track/v1/details/${encodeURIComponent(no)}?locale=en_US&returnSignature=false`, {
    headers: { authorization: `Bearer ${token}`, transId: `lb${Date.now()}`, transactionSrc: 'lulyboo', accept: 'application/json' },
  });
  if (r.status === 404) return { found: false };
  if (!r.ok) throw apiError('UPS', r);
  const pkg = r.json?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) return { found: false };
  const events = (pkg.activity || []).map((a) => ({ at: upsTime(a.date, a.time), code: upsCode(a.status), description: a.status?.description || '', location: upsLoc(a.location) }));
  const cur = pkg.currentStatus || pkg.activity?.[0]?.status || {};
  const status = pkg.activity?.length ? upsCode({ ...pkg.activity[0].status, description: cur.description || pkg.activity[0].status?.description, statusCode: cur.code || pkg.activity[0].status?.statusCode }) : upsCode(cur);
  const dd = (type) => (pkg.deliveryDate || []).find((x) => x.type === type)?.date;
  return {
    found: true, status, summary: cur.description || cur.simplifiedTextDescription || events[0]?.description || '', location: events[0]?.location || '',
    eta: upsTime(dd('SDD') || dd('RDD') || dd('EDD')) || null, deliveredAt: status === 'delivered' ? (upsTime(dd('DEL')) || events[0]?.at) : null, signedBy: pkg.deliveryInformation?.receivedBy || null, events,
  };
}

const CLIENTS = { dhl: trackDhl, fedex: trackFedex, ups: trackUps };

/** Track one number. Throws with a readable message if the carrier is not configured or the API fails. */
async function track(carrier, no) {
  const fn = CLIENTS[carrier];
  if (!fn) throw new Error('Automatic tracking is available for DHL, FedEx and UPS');
  if (!configured(carrier)) throw new Error(`${CARRIERS[carrier].name} API is not connected (add its keys in Railway)`);
  const out = await fn(clean(no));
  if (!out.found) return out;
  // Newest first; a stable key per event lets us store only new ones.
  out.events = (out.events || []).filter((e) => e.at || e.description)
    .map((e) => ({ ...e, key: `${String(e.at || '').slice(0, 16)}|${String(e.description).slice(0, 60)}` }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return out;
}

/** Check a connection by fetching a token (FedEx/UPS) or a dummy lookup (DHL). */
async function testConnection(carrier) {
  if (!configured(carrier)) return { ok: false, message: 'Not configured' };
  try {
    if (carrier === 'dhl') { const r = await http('https://api-eu.dhl.com/track/shipments?trackingNumber=0000000000&service=express', { headers: { 'DHL-API-Key': env('DHL_API_KEY') } }); return r.status === 401 || r.status === 403 ? { ok: false, message: 'Key rejected' } : { ok: true, message: 'Connected' }; }
    if (carrier === 'fedex') { tokens.delete('FedEx'); await oauth('FedEx', `${fedexBase()}/oauth/token`, { body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('FEDEX_CLIENT_ID'), client_secret: env('FEDEX_CLIENT_SECRET') }) }); return { ok: true, message: 'Connected' }; }
    if (carrier === 'ups') { tokens.delete('UPS'); const basic = Buffer.from(`${env('UPS_CLIENT_ID')}:${env('UPS_CLIENT_SECRET')}`).toString('base64'); await oauth('UPS', process.env.UPS_TOKEN_URL || `${upsBase()}/security/v1/oauth/token`, { headers: { authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'client_credentials' }) }); return { ok: true, message: 'Connected' }; }
  } catch (e) { return { ok: false, message: e.message }; }
  return { ok: false, message: 'Unknown carrier' };
}

const trackingUrl = (carrier, no) => (no && CARRIERS[carrier]?.url(clean(no))) || null;

module.exports = { STATUSES, STATUS_LABEL, CARRIERS, detect, configured, track, testConnection, trackingUrl, clean, _codes: { dhlCode, fedexCode, upsCode }, _tokens: tokens };
