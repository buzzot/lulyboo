'use strict';
// Development threads by email.
//
// One mailbox for all projects (projects@in.lulyboo.space by default). Each supplier thread is identified by a code
// in the subject, e.g. "[Lulyboo DP-1001-9D6A] New message". Emails we send about a thread carry the code and use the
// mailbox as Reply-To; you can CC the mailbox on emails you write yourself (keep the code, or at least "DP-1001").
// Mailgun's catch-all route forwards it to /hooks/mailgun-inbound, which calls handleDevEmail():
//   1. find the thread: the code in the subject; else "DP-1001" + the supplier who sent it (or, for your own
//      emails, the supplier you sent it to)
//   2. summarise the email with AI (English, short) and keep the original text
//   3. post it to the thread with the sender's name and the time the email was sent; attachments are kept
//   4. relay it: supplier email → owners are emailed; Lulyboo email → the supplier is emailed (unless already on it)

const crypto = require('node:crypto');
const AI = require('./ai');
const P = require('./projects');
const { sendEmail, projectEmail, adminEmail } = require('./email');

const domain = () => (process.env.INBOUND_EMAIL_DOMAIN || 'in.lulyboo.space').toLowerCase();
const sig = (id) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'lulyboo-dev-thread').update(`dev-thread:${id}`).digest('hex').slice(0, 8);
const threadAddress = () => (process.env.DEV_EMAIL || `projects@${domain()}`).toLowerCase();
const threadCode = (p, inv) => `${p.ref}-${sig(inv.id).slice(0, 4).toUpperCase()}`;   // DP-1001-9D6A
const CODE_RE = /\b(DP)-(\d{3,7})-([0-9A-F]{4})\b/i;
const REF_RE = /\b(DP)-?(\d{3,7})\b/i;

/** "Li Kuan <sales@x.cn>" → { name: 'Li Kuan', email: 'sales@x.cn' } */
function parseAddress(s) {
  const str = String(s || '').trim();
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const e = (str.match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [''])[0].toLowerCase();
  return { name: '', email: e };
}
const emailsIn = (s) => (String(s || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map((x) => x.toLowerCase());

async function findThread(db, { subject = '', fromEmail = '', recipients = [], admin = false }) {
  const code = String(subject).match(CODE_RE);
  if (code) {
    const p = (await db.list('dev_projects', { filters: { ref: `DP-${code[2]}` } }))[0];
    const inv = p && (await db.list('dev_invitations', { filters: { project_id: p.id } })).find((i) => sig(i.id).slice(0, 4) === code[3].toLowerCase());
    if (inv) return { p, inv, how: 'code' };
  }
  // Only the project number: work out the supplier from who sent it (theirs) or who it went to (ours).
  const rm = String(subject).match(REF_RE); if (!rm) return null;
  const p = (await db.list('dev_projects', { filters: { ref: `DP-${rm[2]}` } }))[0]; if (!p) return null;
  const people = admin ? recipients : [fromEmail];
  const FREE = /@(gmail|qq|163|126|outlook|hotmail|yahoo|foxmail|sina|aliyun)\./i;
  const hits = [];
  for (const inv of await db.list('dev_invitations', { filters: { project_id: p.id } })) {
    const s = await db.get('suppliers', inv.supplier_id); if (!s) continue;
    const mails = await P.supplierRecipients(db, s); const doms = new Set(mails.filter((x) => !FREE.test(x)).map((x) => x.split('@')[1]));
    if (people.some((e) => mails.includes(e) || (!FREE.test(e) && doms.has(e.split('@')[1])))) hits.push(inv);
  }
  return hits.length === 1 ? { p, inv: hits[0], how: 'project' } : null;
}

async function isLulyboo(db, email) {
  if (!email) return false;
  const own = P.ownerEmails();
  if (own.includes(email)) return true;
  const ownDomains = new Set([...own, process.env.EMAIL_FROM || ''].map((x) => (parseAddress(x).email || x).split('@')[1]).filter(Boolean));
  if (ownDomains.has(email.split('@')[1])) return true;
  try { return (await db.list('staff_users', { filters: { email } })).length > 0; } catch { return false; }
}

// Drop quoted history and signatures when the provider did not do it already.
function cleanText(t) {
  const lines = String(t || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*(On .{4,120} wrote:|-{2,}\s*Original Message|From:\s.+|发件人[:：]|-----\s*原始邮件|在\s.+写道[:：])\s*$/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const SUMMARY_TOOL = {
  name: 'record_email_summary',
  description: 'Summarise one email in a product-development thread between Lulyboo (a US importer) and a factory.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'English. 1-4 short sentences or "- " bullets with the substance only: answers, questions, numbers, materials, sizes, prices, dates, files mentioned. No greetings or signatures. Translate Chinese.' },
      language: { type: 'string', description: 'Language the email was written in, e.g. "English", "Chinese"' },
      questions: { type: 'array', items: { type: 'string' }, description: 'Open questions the writer asks, in English' },
      commitments: { type: 'array', items: { type: 'string' }, description: 'Promises with dates or quantities, e.g. "Samples ship Nov 20"' },
      needs_reply: { type: 'boolean' },
    },
    required: ['summary'],
  },
};

async function summarize({ text, subject, project, writer }) {
  if (!AI.enabled() || !text) return null;
  try {
    const { result } = await AI.callTool({
      tool: SUMMARY_TOOL, maxTokens: 1200,
      content: `Project: ${project}\nWriter: ${writer}\nSubject: ${subject}\n\nEmail:\n${String(text).slice(0, 12000)}`,
    });
    return result && result.summary ? result : null;
  } catch (e) { console.error('Email summary failed:', e.message); return null; }
}

function emailDate(d) {
  const t = Date.parse(d || '');
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 60 * 864e5) return new Date().toISOString();
  return new Date(t).toISOString();
}

// Inline logos and signature images are not worth keeping.
const junkAttachment = (f) => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif)$/i.test(f.name || '')
  ? (f.buffer?.length || 0) < 15_000 || /^(image\d{3}|outlook|logo|signature)/i.test(f.name || '')
  : false;

/**
 * Post an inbound email to its development thread.
 * Returns { matched, duplicate?, messageId? }.
 */
async function handleDevEmail({ db, config, from, toList = [], cc = '', subject = '', text = '', bodyPlain = '', files = [], messageId = '', date = '' }) {
  const sender = parseAddress(from);
  const admin = await isLulyboo(db, sender.email);
  const recipients = emailsIn([...toList, cc].join(',')).filter((e) => e !== threadAddress());
  const th = await findThread(db, { subject, fromEmail: sender.email, recipients, admin });
  if (!th) return { matched: false };
  const { p, inv } = th;
  const s = await db.get('suppliers', inv.supplier_id);
  const existing = await db.list('dev_messages', { filters: { invitation_id: inv.id } });
  if (messageId && existing.some((x) => x.email?.message_id === messageId)) return { matched: true, duplicate: true };

  let name = sender.name;
  if (!name && !admin) name = (await db.list('supplier_users', { filters: { email: sender.email } }).catch(() => []))[0]?.name || '';
  if (!name) name = admin ? 'Lulyboo' : (sender.email.split('@')[0] || s?.name || 'Supplier');

  const clean = cleanText(text || bodyPlain).slice(0, 20000);
  const ai = await summarize({ text: clean, subject, project: `${p.ref} ${p.name}`, writer: `${name}${admin ? ' (Lulyboo)' : ` (${s?.name || 'supplier'})`}` });
  const body = (ai?.summary || clean || '(No text: see the attachments)').slice(0, 6000);

  const keep = files.filter((f) => f.buffer?.length && !junkAttachment(f));
  const stored = await P.storeFiles(db, { projectId: p.id, files: keep, maxBytes: config.maxUploadBytes || 20 * 1024 * 1024 });

  const row = { invitation_id: inv.id, direction: admin ? 'admin' : 'supplier', author: name, body, attachments: stored.saved, created_at: emailDate(date) };
  const meta = {
    from: sender.email, subject: String(subject).slice(0, 300), message_id: messageId || null, text: clean.slice(0, 20000),
    original: String(bodyPlain || text).slice(0, 50000), summarized: !!ai, language: ai?.language || null,
    questions: ai?.questions || [], commitments: ai?.commitments || [], skipped_files: stored.errors,
  };
  let msg;
  try { msg = await db.insert('dev_messages', { ...row, source: 'email', email: meta }); }
  catch (e) {
    console.error('Saving email details failed (run the dev_messages email SQL?):', e.message);
    if (messageId && existing.some((x) => x.body === body && x.author === name)) return { matched: true, duplicate: true };
    msg = await db.insert('dev_messages', { ...row, body: `${body}\n\n(by email)` });
  }
  const upd = { updated_at: new Date().toISOString() };
  if (!admin && ['Invited', 'Viewed'].includes(inv.status)) upd.status = 'Questions';
  await db.update('dev_invitations', { id: inv.id }, upd);

  // Relay so that a thread can run purely on email.
  const onIt = new Set(emailsIn([...toList, cc].join(',')));
  const replyTo = threadAddress();
  const topic = (String(subject).replace(/\[[^\]]*\]/g, '').replace(/^\s*((re|fw|fwd|aw|回复|答复|转发)\s*[:：]\s*)+/gi, '').trim() || p.name).slice(0, 150);
  const tag = threadCode(p, inv);
  const topicFor = s?.name && topic.toLowerCase().startsWith(`${s.name.toLowerCase()}:`) ? topic.slice(s.name.length + 1).trim() || p.name : topic;
  try {
    if (admin && s) {
      const to = (await P.supplierRecipients(db, s)).filter((e) => !onIt.has(e));
      if (to.length) {
        const e = projectEmail({ ref: p.ref, project: p.name, companyName: s.name, title: ['New message from Lulyboo', '来自 Lulyboo 的新消息'], lead: [`${name} wrote about`, `${name} 发来关于以下项目的消息`], noteLabel: ['Message', '消息'], note: clean || body, button: ['Open the project', '打开项目'], link: `${config.publicUrl}/portal/projects/${inv.id}`, replyHint: true });
        await sendEmail(config, { to, subject: `[Lulyboo ${tag}] ${topicFor}`, text: e.text, html: e.html, replyTo });
      }
    } else if (!admin) {
      const to = P.ownerEmails().filter((e) => !onIt.has(e));
      if (to.length) {
        const url = `${config.publicUrl}/admin/projects/${p.id}/suppliers/${inv.id}`;
        const items = [...(ai?.questions || []).map((q) => ({ tag: 'Question', tone: 'amber', title: q })), ...(ai?.commitments || []).map((c) => ({ tag: 'Commitment', tone: 'green', title: c }))];
        const e = adminEmail({ title: `${name} (${s?.name || 'supplier'}) emailed`, project: `${p.ref} · ${p.name}`, detail: { label: ai ? 'AI summary' : 'Message', text: body }, items, button: 'Open supplier thread', link: url, intro: `Reply to this email to answer: your reply is added to the thread and sent to ${s?.name || 'the supplier'}.` });
        await sendEmail(config, { to, subject: `[${tag}] ${s?.name || 'Supplier'}: ${topicFor}`, text: e.text, html: e.html, replyTo });
      }
    }
  } catch (e) { console.error('Thread relay failed:', e.message); }
  return { matched: true, duplicate: false, messageId: msg?.id, direction: row.direction, how: th.how };
}

module.exports = { threadAddress, threadCode, parseAddress, findThread, handleDevEmail, cleanText, summarize, CODE_RE, sig };
