'use strict';
// AI summaries for the request communication log: each message gets a short headline and a clean structure
// (sections, key figures, open questions, commitments). Stored in info_request_messages.ai (jsonb).
// Summaries are made in the background so pages never wait on the AI.

const AI = require('./ai');

const TOOL = {
  name: 'record_message_summary',
  description: 'Structure one message from a sourcing conversation between Lulyboo (a US importer of baby and pet products) and a factory.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'English, at most 12 words: what this message is, e.g. "RFQ for padded potty seat, target $1.50-2.50 FOB"' },
      summary: { type: 'string', description: 'English, one or two plain sentences with the gist.' },
      sections: {
        type: 'array', description: '2-5 short sections that make the message easy to scan, e.g. "Product", "Pricing & target", "Asked to quote", "Requirements", "Supplier answers", "Context". Skip empty ones.',
        items: { type: 'object', properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, description: 'Short bullet points, at most ~15 words each' } }, required: ['title', 'items'] },
      },
      facts: { type: 'array', description: 'Key figures as label/value: prices, quantities, MOQ, lead times, dates, certifications, addresses.', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions still waiting for an answer' },
      commitments: { type: 'array', items: { type: 'string' }, description: 'Promises with dates or quantities' },
      language: { type: 'string', description: 'Language of the original, e.g. English, Chinese' },
    },
    required: ['headline', 'sections'],
  },
};

const running = new Set();
let columnMissing = false;

const eligible = (m) => !m.ai && String(m.original || m.body || '').trim().length >= 60;

async function summarizeMessage(db, m, { request, supplierName } = {}) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const text = String(m.original || m.body || '').slice(0, 14000);
  const who = m.direction === 'out' ? 'Lulyboo → supplier' : m.direction === 'in' ? 'Supplier → Lulyboo' : 'Internal note by Lulyboo';
  const { result, model } = await AI.callTool({
    tool: TOOL, maxTokens: 1800,
    content: `Request: ${request?.ref || ''} ${request?.subject || ''}\nSupplier: ${supplierName || ''}\nDirection: ${who}\nSubject: ${m.subject || ''}\n\nMessage:\n${text}`,
  });
  const ai = { ...result, model, at: new Date().toISOString() };
  try { await db.update('info_request_messages', { id: m.id }, { ai }); }
  catch (e) { if (/column|ai/i.test(e.message)) columnMissing = true; throw e; }
  return ai;
}

/** Start summaries for messages that have none. Returns how many are being prepared. */
function ensureSummaries(db, msgs, ctx) {
  if (!AI.enabled() || columnMissing) return 0;
  let n = 0;
  for (const m of msgs) {
    if (!eligible(m)) continue;
    n++;
    if (running.has(m.id)) continue;
    running.add(m.id);
    summarizeMessage(db, m, ctx).catch((e) => console.error('Message summary failed:', e.message)).finally(() => running.delete(m.id));
  }
  return n;
}

const pendingCount = (msgs) => msgs.filter((m) => running.has(m.id)).length;

module.exports = { summarizeMessage, ensureSummaries, pendingCount, eligible, isColumnMissing: () => columnMissing };
