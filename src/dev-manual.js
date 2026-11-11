'use strict';
// Supplier replies added by hand to a development thread (WeChat, WhatsApp, phone, meeting, an email that missed the
// mailbox): message + attachments in three categories, AI summary like emails, and an optional quote read from the
// pricing file(s) that Lulyboo checks before it is saved.

const AI = require('./ai');
const { parseXlsx, parseCsv, decodeText } = require('./importer');

const CHANNELS = { wechat: ['WeChat', '微信', '💬'], whatsapp: ['WhatsApp', 'WhatsApp', '🟢'], email: ['Email', '邮件', '✉'], phone: ['Phone call', '电话', '📞'], meeting: ['Meeting', '会议', '🤝'], other: ['Other', '其他', '📝'] };
const CATS = { design: ['Design files', '设计文件', '📐', 'Drawings, CAD, STEP, AI, PDF'], image: ['Reference images', '参考图片', '🖼️', 'Photos, renders, screenshots'], pricing: ['Pricing', '报价', '💲', 'Quotation sheet, price list'] };
const CAT_ORDER = ['design', 'image', 'pricing'];

const QUOTE_TOOL = {
  name: 'record_quote',
  description: "Record a factory's quotation for a product-development project.",
  input_schema: {
    type: 'object',
    properties: {
      currency: { type: 'string', description: 'ISO code, e.g. USD, CNY' },
      tiers: { type: 'array', description: 'Unit price per quantity break, lowest quantity first', items: { type: 'object', properties: { qty: { type: 'number' }, price: { type: 'number' } }, required: ['qty', 'price'] } },
      incoterm: { type: 'string', description: 'FOB, EXW, CIF, DDP… if stated' },
      tooling_cost: { type: 'number', description: 'Total mold / tooling cost (sum all molds)' },
      tooling_lead_days: { type: 'number' }, moq: { type: 'number' }, sample_cost: { type: 'number' }, sample_lead_days: { type: 'number' }, production_lead_days: { type: 'number' },
      payment_terms: { type: 'string' }, material_notes: { type: 'string', description: 'Material / spec the price is based on' },
      validity_date: { type: 'string', description: 'YYYY-MM-DD if a validity date is stated' },
      notes: { type: 'string', description: 'English, short: tooling split per mold, packaging, anything else that changes the price' },
    },
  },
};
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const n = (v) => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : null; };
const tableText = (rows) => rows.map((r, i) => { const c = r.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()); return c.some(Boolean) ? `R${i + 1}: ${c.join(' | ')}` : null; }).filter(Boolean).slice(0, 800).join('\n').slice(0, 80000);

/** Read a quote from pricing files ({name, buffer}) and / or the message text. Returns a draft or null. */
async function readQuote({ files = [], text = '', project = '' }) {
  if (!AI.enabled()) return null;
  const content = []; const tables = [];
  for (const f of files.slice(0, 4)) {
    const ext = (String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    try {
      if (MIME[ext] === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      else if (MIME[ext]) content.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext], data: f.buffer.toString('base64') } });
      else if (/^xlsx?m?$/.test(ext)) tables.push(`File ${f.name}:\n${tableText(parseXlsx(f.buffer))}`);
      else if (/^(csv|txt)$/.test(ext)) tables.push(`File ${f.name}:\n${tableText(parseCsv(decodeText(f.buffer)))}`);
    } catch (e) { console.error('Quote file unreadable:', f.name, e.message); }
  }
  if (!content.length && !tables.length && !String(text).trim()) return null;
  content.push({ type: 'text', text: `Project: ${project}\nRead the factory's quotation for this project. Use only numbers that are stated; leave a field out when it is not given. Sum separate mold costs into tooling_cost and list the split in notes.${tables.length ? `\n\n${tables.join('\n\n')}` : ''}${text ? `\n\nMessage from the factory:\n${String(text).slice(0, 12000)}` : ''}` });
  try {
    const { result: r } = await AI.callTool({ tool: QUOTE_TOOL, content, maxTokens: 1500 });
    if (!r) return null;
    const tiers = (Array.isArray(r.tiers) ? r.tiers : []).map((t) => ({ qty: Math.round(n(t.qty) || 0), price: n(t.price) })).filter((t) => t.qty > 0 && t.price !== null && t.price >= 0).slice(0, 3);
    const q = { currency: /^[A-Z]{3}$/.test(String(r.currency || '').toUpperCase()) ? String(r.currency).toUpperCase() : 'USD', tiers, incoterm: r.incoterm ? String(r.incoterm).toUpperCase().slice(0, 10) : null,
      tooling_cost: n(r.tooling_cost), tooling_lead_days: n(r.tooling_lead_days), moq: n(r.moq), sample_cost: n(r.sample_cost), sample_lead_days: n(r.sample_lead_days), production_lead_days: n(r.production_lead_days),
      payment_terms: r.payment_terms ? String(r.payment_terms).slice(0, 300) : null, material_notes: r.material_notes ? String(r.material_notes).slice(0, 300) : null,
      validity_date: /^\d{4}-\d{2}-\d{2}$/.test(r.validity_date || '') ? r.validity_date : null, notes: r.notes ? String(r.notes).slice(0, 2000) : null };
    return tiers.length || q.tooling_cost !== null || q.sample_cost !== null ? q : null;
  } catch (e) { console.error('Quote reading failed:', e.message); return null; }
}

module.exports = { CHANNELS, CATS, CAT_ORDER, QUOTE_TOOL, readQuote };
