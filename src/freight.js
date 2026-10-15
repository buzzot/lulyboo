'use strict';
// "Check market rate" for a freight option: Claude searches the web for the current benchmark rate on the
// option's lane and mode, then proposes a rate. NOTHING is saved here: the admin reviews the proposal and
// confirms it (see the logistics routes). Benchmarks (Drewry WCI, Freightos FBX, forwarder pages) are port-to-port
// spot rates; the fees per shipment (drayage, broker, terminal) are not changed by this.

const ai = require('./ai');

const MODE_INFO = {
  FCL_20GP: { label: '20ft container (20GP)', unit: 'per container', unitText: 'USD per 20ft container' },
  FCL_40GP: { label: '40ft container (40GP)', unit: 'per container', unitText: 'USD per 40ft container' },
  FCL_40HQ: { label: '40ft high-cube container (40HQ)', unit: 'per container', unitText: 'USD per 40ft container (a 40HQ is normally priced like a 40ft)' },
  LCL: { label: 'LCL (less than container load)', unit: 'per CBM', unitText: 'USD per cubic metre (CBM)' },
  AIR: { label: 'air freight', unit: 'per kg', unitText: 'USD per chargeable kg' },
};

const TOOL = {
  name: 'propose_rate',
  description: 'Propose the current freight rate from the research notes. Use only numbers stated in the notes.',
  input_schema: {
    type: 'object',
    properties: {
      rate_usd: { type: ['number', 'null'], description: 'Best current rate in USD for the unit asked, or null if the notes give no usable number' },
      low_usd: { type: ['number', 'null'] },
      high_usd: { type: ['number', 'null'] },
      basis: { type: 'string', enum: ['index', 'forwarder_quote', 'carrier_or_news', 'estimate', 'not_found'], description: 'What kind of figure this is' },
      as_of: { type: ['string', 'null'], description: 'Date the figure refers to, as stated in the source (YYYY-MM-DD or text)' },
      lane: { type: 'string', description: 'The lane the figure is for, e.g. Shanghai to Los Angeles' },
      includes_fees: { type: 'string', description: 'What the figure includes or excludes (ocean freight only? surcharges? drayage?)' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      explanation: { type: 'string', description: 'Two or three sentences: where the number comes from and how it maps to the option' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['rate_usd', 'basis', 'confidence', 'explanation'],
  },
};

async function searchRates(option, fetchImpl = fetch, attempt = 0) {
  const info = MODE_INFO[option.mode];
  const today = new Date().toISOString().slice(0, 10);
  const hints = attempt === 0
    ? `Search CHINESE sources first, in Chinese as well as English, because Chinese forwarders and exchanges publish the freshest transpacific rates: the Shanghai Shipping Exchange SCFI index (上海出口集装箱运价指数, 美西航线 USD/FEU, published weekly on sse.net.cn and quoted in Chinese shipping news), Chinese freight forwarder and platform rate pages and weekly market reports (货代 / 订舱平台 / 锦程物流 / 运去哪 / 海运费报价 / 美西线 本周运价 40HQ 上海 洛杉矶 / 宁波 洛杉矶 / 深圳 洛杉矶 FOB 海运费), and Chinese shipping news (e.g. 航运界, 集装箱网, 搜航网). Report the figures printed there, in USD (convert nothing yourself; if a figure is in RMB, say so).`
    : `The first search found no figure. Now try the international benchmarks and trade press that quote numbers weekly: Drewry World Container Index (Shanghai to Los Angeles, per 40ft), Freightos Baltic Index / "Freightos update" (China/East Asia to US West Coast per FEU), Hellenic Shipping News, Container News, JOC, Loadstar, Splash247. The index sites themselves are often unreadable, so read the articles that quote them.`;
  const prompt = `Today is ${today}. Find the CURRENT spot freight rate for ${info.label} shipping from ${option.origin || 'China'} to ${option.destination || 'the US West Coast'}. ` +
    `I need ${info.unitText}. ${hints} ` +
    `Use the most recent figure available (within the last 3 weeks) and say its date. State each figure with its date, lane, what it includes (ocean only vs all-in) and the source name. If sources disagree, give the range. Do not guess: if you cannot find a figure, say so. Plain text, under 250 words.`;
  const messages = [{ role: 'user', content: prompt }];
  const sources = new Map();
  let text = '';
  for (let i = 0; i < 4; i++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ai.model(), max_tokens: 1500, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Web search failed (${res.status}). ${/web_search|not enabled|permission/i.test(t) ? 'Web search may not be enabled for your Anthropic account.' : ''}`.trim());
    }
    const data = await res.json();
    for (const b of data.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) sources.set(r.url, r.title || r.url);
      if (b.type === 'text') { text += `${b.text}\n`; for (const c of b.citations || []) if (c.url) sources.set(c.url, c.title || c.url); }
    }
    if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
    break;
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })).slice(0, 8) };
}

async function extract(option, info, text) {
  return ai.callTool({
    tool: TOOL, maxTokens: 800,
    system: 'You extract freight rates from research notes. Use only numbers that appear in the notes. Never invent or average numbers that are not there; if the notes give no usable figure, return rate_usd null and basis not_found.',
    content: `Option: ${option.name} (${info.label}), ${option.origin || ''} → ${option.destination || ''}. Unit wanted: ${info.unitText}. Current rate in our system: ${option.rate_usd}.\n\nRESEARCH NOTES:\n${text}`,
  });
}

/** Returns a proposal {rate_usd, ..., sources, current_rate_usd, change_pct, checked_at}. Saves nothing. */
async function researchRate(option, { fetchImpl = fetch } = {}) {
  if (!ai.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  if (!MODE_INFO[option.mode]) throw new Error('Market rate check is available for container, LCL and air options only.');
  const info = MODE_INFO[option.mode];
  let text = ''; let sources = []; let result = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await searchRates(option, fetchImpl, attempt);
    if (found.text) text = text ? `${text}\n\n--- second search ---\n${found.text}` : found.text;
    const known = new Set(sources.map((x) => x.url));
    sources = sources.concat(found.sources.filter((x) => !known.has(x.url)));
    if (!text) continue;
    ({ result } = await extract(option, info, text));
    if (result.rate_usd !== null && result.rate_usd !== undefined && result.basis !== 'not_found') break;
  }
  if (!result) throw new Error('The web search returned nothing usable. Try again later.');
  const rate = result.rate_usd === null || result.rate_usd === undefined ? null : Number(result.rate_usd);
  const cur = Number(option.rate_usd);
  const warnings = [...(result.warnings || [])];
  if (rate !== null && (!(rate > 0) || rate > 100000)) warnings.push('The proposed number looks implausible: do not apply it.');
  if (rate !== null && cur > 0 && Math.abs(rate - cur) / cur > 0.5) warnings.push('More than 50% different from the current rate: double-check the source before applying.');
  if (!sources.length) warnings.push('No source links were returned: verify the figure yourself.');
  warnings.push('Index and news rates are port-to-port spot rates. Drayage, broker and terminal fees are in "Fees / shipment", which this check does not change. Confirm with your forwarder before relying on it.');
  return {
    ...result, rate_usd: rate, unit: info.unitText, warnings, sources, notes_text: text,
    current_rate_usd: cur, change_pct: rate !== null && cur > 0 ? Math.round(((rate - cur) / cur) * 1000) / 10 : null,
    model: ai.model(), checked_at: new Date().toISOString(),
  };
}

module.exports = { researchRate, MODE_INFO };
