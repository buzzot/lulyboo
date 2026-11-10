'use strict';
// AI draft of our next email in an RFQ thread: reads the whole thread (original emails and their AI summaries) and
// writes a reply that answers what the supplier asked and asks for what is still missing.

const AI = require('./ai');

const TOOL = {
  name: 'draft_reply',
  description: 'Draft Lulyboo\'s next email to the supplier in this sourcing (RFQ) thread.',
  input_schema: {
    type: 'object',
    properties: {
      subject_topic: { type: 'string', description: 'Short topic for the subject, without "Re:" and without the reference, e.g. "Padded potty training seat: quotation and samples"' },
      body: {
        type: 'string',
        description: 'Plain-text email body in clear, simple English that a Chinese factory sales person reads easily. Greeting with the contact name if known. '
          + 'Answer every question the supplier asked, using only facts in the thread; where we have not decided yet, write a placeholder in square brackets, e.g. [packaging: polybag or printed box?]. '
          + 'Then ask, as a short numbered list, for everything still missing to complete the quotation (prices per quantity tier, MOQ, sample cost and time, lead time, certifications, packaging). '
          + 'Do not invent prices, quantities or decisions. Keep it under ~220 words. End with "Best regards," and the signature placeholder [Your name] / Lulyboo.',
      },
      open_points: { type: 'array', items: { type: 'string' }, description: 'Placeholders and decisions the user must fill in before sending' },
      asked: { type: 'array', items: { type: 'string' }, description: 'What the draft asks the supplier for' },
    },
    required: ['subject_topic', 'body'],
  },
};

const clip = (s, n) => String(s || '').slice(0, n);

/** Build the draft for the request `r`, answering the message `latest`. */
async function draftReply({ r, supplier, msgs, latest }) {
  if (!AI.enabled()) throw new Error('AI is not configured: set ANTHROPIC_API_KEY');
  const lines = msgs.map((m) => {
    const who = m.direction === 'out' ? 'LULYBOO → supplier' : m.direction === 'in' ? 'SUPPLIER → Lulyboo' : 'INTERNAL NOTE (not seen by supplier)';
    const sum = m.ai ? `\nAI summary: ${clip(m.ai.headline, 200)}. ${clip(m.ai.summary, 600)}${(m.ai.open_questions || []).length ? `\nOpen questions: ${m.ai.open_questions.join('; ')}` : ''}` : '';
    return `### ${who} · ${String(m.created_at || '').slice(0, 16)}${m.id === latest.id ? ' · (LATEST, reply to this)' : ''}${m.subject ? `\nSubject: ${m.subject}` : ''}\n${clip(m.original || m.body, 9000)}${sum}${(m.attachments || []).length ? `\nAttachments: ${m.attachments.map((a) => a.filename).join(', ')}` : ''}`;
  });
  const { result } = await AI.callTool({
    tool: TOOL, maxTokens: 2500,
    content: `We are Lulyboo, a US importer of baby and pet products, sourcing from China. Draft our reply to the supplier's latest email so the RFQ moves forward.
Request ${r.ref}: ${r.subject || ''}
Supplier: ${supplier?.name || ''}${supplier?.contact_name ? ` (contact: ${supplier.contact_name})` : ''}
${r.note ? `Our internal notes: ${clip(r.note, 1500)}\n` : ''}
Thread, oldest first:
${lines.join('\n\n').slice(0, 60000)}`,
  });
  return {
    topic: clip(result?.subject_topic, 200),
    body: clip(result?.body, 8000),
    open_points: Array.isArray(result?.open_points) ? result.open_points.map(String).slice(0, 12) : [],
    asked: Array.isArray(result?.asked) ? result.asked.map(String).slice(0, 12) : [],
  };
}

module.exports = { draftReply, TOOL };
