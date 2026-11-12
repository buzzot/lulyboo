'use strict';
// AI draft of an email to a supplier about a development project: request (quote, sample, info, schedule) or a
// follow-up on whatever is pending. Uses the project, this supplier's thread, quote, samples and milestones.

const AI = require('./ai');

const PURPOSES = {
  follow: ['Follow up', 'Follow up on whatever is still pending from the supplier (unanswered questions, missing quote, sample, files, dates). Mention how long it has been if that helps.'],
  quote: ['Ask for a quote', 'Ask for a complete quotation: unit price at the quantity breaks, tooling / mold cost, MOQ, sample cost and lead times, payment terms, validity.'],
  sample: ['Request a sample', 'Ask for a sample: confirm what is to be sampled, ask for the sample cost, ship date and tracking.'],
  info: ['Ask for information', 'Ask for missing technical information or files the project needs (drawings, materials, certificates, packaging).'],
  schedule: ['Ask for timeline', 'Ask for an update and a timeline: where things stand now and dates for the next steps.'],
  answer: ['Answer their questions', 'Answer the supplier’s open questions from the thread using the project information. If the answer is not in the information, say Lulyboo will confirm, do not invent it.'],
  custom: ['Custom', 'Write what Lulyboo asks for in the notes.'],
};
const TONES = { friendly: 'friendly and polite', firm: 'polite but firm, make the deadline clear', short: 'very short and direct' };

const TOOL = {
  name: 'draft_email',
  description: 'Draft one email from Lulyboo to the factory.',
  input_schema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'The email body in plain text. Greeting with the contact name if known, short paragraphs or "- " bullets for the requests, a clear ask with a date when useful, sign-off "Best regards,\\n<sender>". No subject line.' },
      body_zh: { type: 'string', description: 'Simplified Chinese version of the same email (only when asked)' },
      pending: { type: 'array', items: { type: 'string' }, description: 'What is still open in this project with this supplier, short English phrases (what the draft is chasing)' },
    },
    required: ['body'],
  },
};

const day = (iso) => String(iso || '').slice(0, 10);
const ago = (iso, now) => { const d = Math.round((Date.parse(now) - Date.parse(iso)) / 864e5); return Number.isFinite(d) ? (d <= 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`) : ''; };
const clip = (s, n) => { s = String(s || '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** Plain-text brief of the project + this supplier's thread for the model. */
function brief({ p, inv, supplier, contact, msgs = [], quote = null, samples = [], milestones = [], now = new Date().toISOString() }) {
  const lines = [];
  lines.push(`Project: ${p.ref} ${p.name} (project status ${p.status}; spec version ${p.current_version})`);
  if (p.summary) lines.push(`Product: ${clip(p.summary, 800)}`);
  if (p.requirements) lines.push(`Requirements: ${clip(p.requirements, 1500)}`);
  if (p.certifications) lines.push(`Certifications: ${clip(p.certifications, 300)}`);
  if (p.target_qty || p.target_moq) lines.push(`Planned quantity: ${p.target_qty || p.target_moq}`);
  if (Array.isArray(p.extra_fields) && p.extra_fields.length) lines.push(`Quote must also answer: ${p.extra_fields.map((x) => x.label).join(', ')}`);
  lines.push(`Supplier: ${supplier?.name || ''}${contact ? `, contact ${contact}` : ''}. Status with this supplier: ${inv.status}. Confirmed spec v${inv.ack_version || '?'}${p.nda_required ? `; NDA ${inv.nda_accepted_at ? 'accepted' : 'NOT accepted yet'}` : ''}. Invited ${day(inv.created_at)}.`);
  const theirs = msgs.filter((m) => m.direction === 'supplier'); const ours = msgs.filter((m) => m.direction !== 'supplier');
  lines.push(`Last message from the supplier: ${theirs.length ? `${day(theirs[theirs.length - 1].created_at)} (${ago(theirs[theirs.length - 1].created_at, now)})` : 'never'}. Last message from Lulyboo: ${ours.length ? `${day(ours[ours.length - 1].created_at)} (${ago(ours[ours.length - 1].created_at, now)})` : 'never'}.`);
  if (msgs.length) {
    lines.push('\nThread (oldest first, latest 12):');
    for (const m of msgs.slice(-12)) {
      const who = m.direction === 'supplier' ? `${m.author || 'Supplier'} (supplier)` : `${m.author || 'Lulyboo'} (Lulyboo)`;
      const extra = [...(m.email?.questions || []).map((q) => `  question: ${q}`), ...(m.email?.commitments || []).map((c) => `  commitment: ${c}`)];
      lines.push(`- ${day(m.created_at)} ${who}: ${clip(m.body, 700)}${m.attachments?.length ? ` [${m.attachments.length} file(s)]` : ''}${extra.length ? `\n${extra.join('\n')}` : ''}`);
    }
  } else lines.push('No messages yet in this thread.');
  if (quote) {
    const t = (quote.tiers || []).map((x) => `${x.price} ${quote.currency || 'USD'} @ ${x.qty}+`).join(', ');
    lines.push(`\nLatest quote rev ${quote.revision} (${day(quote.created_at)}, on spec v${quote.spec_version}): ${t}${quote.tooling_cost != null ? `; tooling ${quote.tooling_cost}` : ''}${quote.moq ? `; MOQ ${quote.moq}` : ''}${quote.sample_lead_days ? `; sample ${quote.sample_lead_days} d` : ''}${quote.production_lead_days ? `; production ${quote.production_lead_days} d` : ''}${quote.validity_date ? `; valid until ${quote.validity_date}` : ''}`);
  } else lines.push('\nNo quote received yet.');
  if (samples.length) lines.push(`Samples: ${samples.map((s) => `${s.ref} ${s.title} – ${s.status}${s.due_ship_date ? `, due to ship ${s.due_ship_date}` : ''}${s.tracking_number ? `, tracking ${s.tracking_number}` : ''}`).join('; ')}`);
  const open = milestones.filter((x) => !x.done_at && (!x.invitation_id || x.invitation_id === inv.id));
  if (open.length) lines.push(`Open milestones: ${open.map((x) => `${x.title}${x.due_date ? ` due ${x.due_date}${x.due_date < day(now) ? ' (OVERDUE)' : ''}` : ''}`).join('; ')}`);
  return lines.join('\n');
}

async function draft({ context, purpose = 'follow', tone = 'friendly', notes = '', zh = false, sender = 'Lulyboo', today = new Date().toISOString().slice(0, 10) }) {
  if (!AI.enabled()) throw new Error('AI is not set up (ANTHROPIC_API_KEY)');
  const goal = PURPOSES[purpose] || PURPOSES.follow;
  const text = [
    `Today is ${today}. Write an email from ${sender} at Lulyboo (a US baby & pet products importer) to the factory about this development project.`,
    `Purpose: ${goal[0]} — ${goal[1]}`,
    `Tone: ${TONES[tone] || TONES.friendly}. Plain, clear English that a Chinese factory sales person reads easily; no idioms. Keep it under 180 words unless the requests need more.`,
    'Only use facts from the project information below. Never invent prices, dates, or things the supplier said. Do not mention internal target prices or internal notes. Keep the project name and code in the text once.',
    notes ? `Lulyboo's notes for this email (follow them): ${notes}` : '',
    zh ? 'Also write body_zh: the same email in Simplified Chinese.' : 'Do not write body_zh.',
    `\nPROJECT INFORMATION\n${context}`,
  ].filter(Boolean).join('\n');
  const { result } = await AI.callTool({ tool: TOOL, content: text, maxTokens: 2000 });
  if (!result?.body) throw new Error('AI returned no draft');
  return { body: String(result.body).trim().slice(0, 6000), body_zh: zh && result.body_zh ? String(result.body_zh).trim().slice(0, 6000) : '', pending: (result.pending || []).map((x) => String(x).slice(0, 160)).slice(0, 8) };
}

module.exports = { PURPOSES, TONES, brief, draft };
