'use strict';
// Supplier business license: number check, private image storage and the optional AI check.
// The AI check has two steps:
//   1. read the uploaded license image (Claude vision) and translate it to English;
//   2. if web search is available on the API key, look the company up in public business-registry sources
//      (China: National Enterprise Credit Information Publicity System gsxt.gov.cn, and registry mirrors such as
//      Qichacha / Tianyancha / Aiqicha) and compare with the license.
// The result is saved on the supplier (suppliers.license_info). It is advice: the card always links to the official site.

const crypto = require('node:crypto');
const AI = require('./ai');

const LICENSE_EXT = /^\.(jpe?g|png|webp|pdf)$/i;
const LICENSE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const MAX_LICENSE_BYTES = 10 * 1024 * 1024;
const extOf = (n) => (String(n || '').match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

const normalizeNo = (v) => String(v || '').toUpperCase().replace(/[\s\-–—]/g, '').slice(0, 40) || null;

// ── China Unified Social Credit Code (统一社会信用代码), GB 32100-2015
const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const PROVINCES = { 11: 'Beijing', 12: 'Tianjin', 13: 'Hebei', 14: 'Shanxi', 15: 'Inner Mongolia', 21: 'Liaoning', 22: 'Jilin', 23: 'Heilongjiang', 31: 'Shanghai', 32: 'Jiangsu', 33: 'Zhejiang', 34: 'Anhui', 35: 'Fujian', 36: 'Jiangxi', 37: 'Shandong', 41: 'Henan', 42: 'Hubei', 43: 'Hunan', 44: 'Guangdong', 45: 'Guangxi', 46: 'Hainan', 50: 'Chongqing', 51: 'Sichuan', 52: 'Guizhou', 53: 'Yunnan', 54: 'Tibet', 61: 'Shaanxi', 62: 'Gansu', 63: 'Qinghai', 64: 'Ningxia', 65: 'Xinjiang', 71: 'Taiwan', 81: 'Hong Kong', 82: 'Macau' };
const ORG_TYPES = { 1: 'Government body', 5: 'Social organisation', 9: 'Business (registered with SAMR)', Y: 'Other' };

function checkUSCC(code) {
  const c = normalizeNo(code);
  if (!c) return null;
  if (c.length !== 18) return { valid: false, reason: `China credit codes have 18 characters; this one has ${c.length}.` };
  if (![...c].every((ch) => USCC_CHARS.includes(ch))) return { valid: false, reason: 'Contains characters that a China credit code never uses (I, O, S, V, Z).' };
  const sum = USCC_W.reduce((a, w, i) => a + USCC_CHARS.indexOf(c[i]) * w, 0);
  const expect = USCC_CHARS[(31 - (sum % 31)) % 31];
  if (expect !== c[17]) return { valid: false, reason: 'The check digit does not match. The number is mistyped or not genuine.' };
  return { valid: true, province: PROVINCES[c.slice(2, 4)] || null, orgType: ORG_TYPES[c[0]] || null };
}
const looksChinese = (s) => /china|中国|prc|^cn$|^chn$/i.test(String(s?.country || '').trim()) || /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(normalizeNo(s?.business_license_no) || '');

// ── Storage (private documents bucket)
async function storeLicense(db, supplierId, file) {
  if (!file?.buffer?.length) return { error: null, saved: null };
  const ext = extOf(file.name);
  if (!LICENSE_EXT.test(ext)) return { error: 'Business license must be a photo (JPG, PNG, WEBP) or a PDF' };
  if (file.buffer.length > MAX_LICENSE_BYTES) return { error: 'Business license file is larger than 10 MB' };
  const path = `licenses/${supplierId}/${crypto.randomUUID()}${ext}`;
  await db.docs.upload(path, file.buffer, LICENSE_MIME[ext]);
  return { error: null, saved: { path, name: String(file.name).slice(0, 200) } };
}

// ── AI step 1: read the license image
const READ_TOOL = {
  name: 'record_license',
  description: 'Record what is printed on the business license, with English translations.',
  input_schema: {
    type: 'object',
    properties: {
      is_business_license: { type: 'boolean', description: 'False if the image is not a business license.' },
      credit_code: { type: 'string', description: 'Unified Social Credit Code / registration number exactly as printed.' },
      name_original: { type: 'string' }, name_en: { type: 'string', description: 'English translation of the company name.' },
      company_type_en: { type: 'string' },
      legal_representative: { type: 'string', description: 'Original name, then pinyin in brackets.' },
      registered_capital_en: { type: 'string' },
      established_date: { type: 'string', description: 'YYYY-MM-DD' },
      business_term_en: { type: 'string', description: 'e.g. 2015-03-02 to long-term' },
      address_original: { type: 'string' }, address_en: { type: 'string' },
      business_scope_en: { type: 'string', description: 'Translated business scope, concise.' },
      issuing_authority_en: { type: 'string' },
      issue_date: { type: 'string' },
      legibility_notes: { type: 'string', description: 'Anything unreadable, cropped or suspicious.' },
    },
    required: ['is_business_license'],
  },
};

function fileBlock(buf, mime) {
  const data = buf.toString('base64');
  return mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mime, data } } : { type: 'image', source: { type: 'base64', media_type: mime, data } };
}

async function readLicense({ buffer, mime }) {
  const { result } = await AI.callTool({
    tool: READ_TOOL, maxTokens: 2500,
    system: 'You read company business licenses (mostly Chinese 营业执照) for a sourcing team. Copy codes exactly, translate everything else into clear English. Never guess: leave a field empty if it is not printed or not readable.',
    content: [fileBlock(buffer, mime), { type: 'text', text: 'Read this business license and record it.' }],
  });
  return result;
}

// ── AI step 2: public registry lookup with web search
const LOOKUP_TOOL = {
  name: 'record_registry',
  description: 'Record the registry facts found for the company, translated to English, with the source pages used.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      registry_status_en: { type: 'string', description: 'e.g. Active (存续/在业), Cancelled (注销), Revoked (吊销), Abnormal operations list' },
      name_original: { type: 'string' }, name_en: { type: 'string' },
      credit_code: { type: 'string' },
      legal_representative: { type: 'string' },
      registered_capital_en: { type: 'string' }, paid_in_capital_en: { type: 'string' },
      established_date: { type: 'string' },
      company_type_en: { type: 'string' },
      address_en: { type: 'string' },
      business_scope_en: { type: 'string' },
      insured_employees: { type: 'string', description: 'Social-insurance headcount if published.' },
      risk_notes_en: { type: 'string', description: 'Abnormal operation listings, penalties, court cases, name changes, anything a buyer should know.' },
      sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
    },
    required: ['found'],
  },
};

async function lookupRegistry({ code, name, country }) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const china = !country || /china|中国|cn/i.test(country);
  const messages = [{ role: 'user', content: `Find the official business registration of this company and record what you find.
Company: ${name || '(unknown)'}
Registration / credit code: ${code || '(unknown)'}
Country: ${country || 'China'}
${china ? 'Prefer the National Enterprise Credit Information Publicity System (gsxt.gov.cn) and registry mirrors that copy it (qcc.com, tianyancha.com, aiqicha.baidu.com). Search by the credit code first, then by the Chinese name.' : 'Prefer the official company registry of that country.'}
Translate everything into English. Only record facts you saw on a page; list every page you used in sources. If nothing reliable is found, record found=false.` }];
  const body = {
    model: AI.model(), max_tokens: 3000,
    system: 'You verify suppliers for a US sourcing team. You are careful and literal: no guessing, no invented numbers.',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, LOOKUP_TOOL],
    messages,
  };
  const seen = [];
  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Registry lookup unavailable (Claude API ${res.status}): ${t.slice(0, 200)}`); }
    const data = await res.json();
    for (const b of data.content || []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) seen.push({ title: r.title || r.url, url: r.url });
    const rec = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_registry');
    if (rec) {
      const out = rec.input || {};
      const urls = new Set(seen.map((x) => x.url));
      out.sources = (out.sources || []).filter((x) => x?.url && /^https?:\/\//.test(x.url)).slice(0, 8);
      if (!out.sources.length) out.sources = seen.slice(0, 5);
      out.sources_checked = out.sources.every((x) => urls.has(x.url)); // every cited page was actually opened by search
      return out;
    }
    if (data.stop_reason === 'pause_turn' || data.stop_reason === 'end_turn') {
      body.messages = [...body.messages, { role: 'assistant', content: data.content }, ...(data.stop_reason === 'end_turn' ? [{ role: 'user', content: 'Now record the result with record_registry.' }] : [])];
      if (data.stop_reason === 'end_turn') body.tool_choice = { type: 'tool', name: 'record_registry' };
      continue;
    }
    break;
  }
  throw new Error('Registry lookup returned no result');
}

// ── Compare license vs registry and the supplier profile
const simplify = (s) => String(s || '').toLowerCase().replace(/co\.?,?|ltd\.?|limited|company|inc\.?|有限公司|有限责任公司|股份/g, '').replace(/[^a-z0-9一-鿿]/g, '');
function compare(s, lic, reg) {
  const issues = [];
  const code = normalizeNo(s.business_license_no);
  if (lic && lic.is_business_license === false) issues.push('The uploaded file does not look like a business license.');
  if (lic?.credit_code && code && normalizeNo(lic.credit_code) !== code) issues.push(`Number typed on the profile (${code}) differs from the license image (${normalizeNo(lic.credit_code)}).`);
  if (reg?.found && reg.credit_code && (code || lic?.credit_code) && normalizeNo(reg.credit_code) !== (code || normalizeNo(lic.credit_code))) issues.push(`Registry shows credit code ${normalizeNo(reg.credit_code)}.`);
  const names = [lic?.name_en, lic?.name_original, reg?.name_en, reg?.name_original].filter(Boolean).map(simplify);
  if (names.length && s.name && !names.some((n) => n && (n.includes(simplify(s.name)) || simplify(s.name).includes(n)))) issues.push(`Company name on the profile ("${s.name}") does not match the license/registry name.`);
  if (reg?.found && reg.registry_status_en && !/active|存续|在业|开业/i.test(reg.registry_status_en)) issues.push(`Registry status: ${reg.registry_status_en}.`);
  if (reg?.risk_notes_en) issues.push(reg.risk_notes_en);
  return issues;
}

async function runCheck({ db, supplier: s }) {
  const out = { checked_at: new Date().toISOString(), model: AI.model(), code: normalizeNo(s.business_license_no), checksum: null, license: null, registry: null, issues: [], errors: [] };
  if (looksChinese(s) && out.code) out.checksum = checkUSCC(out.code);
  if (s.business_license_path) {
    try {
      const ext = extOf(s.business_license_path);
      out.license = await readLicense({ buffer: await db.docs.download(s.business_license_path), mime: LICENSE_MIME[ext] || 'image/jpeg' });
    } catch (e) { out.errors.push(`Could not read the license image: ${e.message}`); }
  }
  const code = out.code || normalizeNo(out.license?.credit_code);
  if (code || s.name) {
    try { out.registry = await lookupRegistry({ code, name: out.license?.name_original || s.name, country: s.country }); } catch (e) { out.errors.push(e.message); }
  }
  out.issues = compare(s, out.license, out.registry);
  if (out.checksum && !out.checksum.valid) out.issues.unshift(`Credit code check failed: ${out.checksum.reason}`);
  out.verdict = out.issues.length ? 'review' : (out.registry?.found || out.license?.is_business_license) ? 'ok' : 'unknown';
  return out;
}

const officialLinks = (s) => {
  const code = normalizeNo(s.business_license_no) || '';
  const q = encodeURIComponent(code || s.name || '');
  return looksChinese(s) ? [
    { label: 'gsxt.gov.cn (official)', url: 'https://www.gsxt.gov.cn/index.html' },
    { label: 'Qichacha', url: `https://www.qcc.com/web/search?key=${q}` },
    { label: 'Aiqicha', url: `https://aiqicha.baidu.com/s?q=${q}` },
  ] : [];
};

module.exports = { normalizeNo, checkUSCC, looksChinese, storeLicense, readLicense, lookupRegistry, compare, runCheck, officialLinks, LICENSE_EXT, LICENSE_MIME, MAX_LICENSE_BYTES, extOf };
