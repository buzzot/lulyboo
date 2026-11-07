'use strict';
// Product development projects: shared helpers (files, refs, notifications, milestone reminders).
const crypto = require('node:crypto');
const { sendEmail, projectEmail, adminEmail } = require('./email');
const tg = require('./telegram');

const PROJECT_STATUSES = ['Draft', 'Sourcing', 'Sampling', 'Testing', 'Pilot', 'Completed', 'On hold', 'Cancelled'];
const INV_STATUSES = ['Invited', 'Viewed', 'Questions', 'Quoted', 'Sample', 'Declined', 'Selected', 'Closed'];
const FILE_KINDS = { drawing: 'Drawing / CAD', image: 'Image / reference', spec: 'Specification', certificate: 'Certificate / test report', other: 'Other' };
const FILE_KINDS_ZH = { drawing: '图纸 / CAD', image: '图片 / 参考', spec: '规格说明', certificate: '证书 / 测试报告', other: '其他' };
const FILE_GROUPS = { drawing: ['Drawings & CAD', '图纸与 CAD'], image: ['Images & references', '图片与参考'], spec: ['Specifications', '规格说明'], certificate: ['Certificates & test reports', '证书与测试报告'], other: ['Other files', '其他文件'] };
const FILE_DEFAULT = { drawing: ['Drawing', '图纸'], image: ['Reference image', '参考图片'], spec: ['Specification', '规格说明'], certificate: ['Certificate', '证书'], other: ['File', '文件'] };
const KIND_ORDER = ['drawing', 'image', 'spec', 'certificate', 'other'];
const guessKind = (name) => { const e = extOf(name); const n = String(name).toLowerCase();
  if (/^\.(step|stp|iges?|dxf|dwg|ai|stl)$/.test(e) || /draw|cad|blueprint/.test(n)) return 'drawing';
  if (/^\.(png|jpe?g|webp|gif|psd)$/.test(e)) return 'image';
  if (/cert|test.?report|fcc|ce[-_ ]|rohs|reach|astm|en71/.test(n)) return 'certificate';
  if (/^\.(pdf|docx?|xlsx?|csv|txt|pptx?)$/.test(e)) return 'spec';
  return 'other'; };
// What a file is, in words: the description someone typed, else the type (numbered when there are several of the same type).
function fileTitles(files, zh = false) {
  const out = new Map(); const count = {}; const seen = {};
  for (const f of files) if (!f.label) count[f.kind] = (count[f.kind] || 0) + 1;
  for (const f of files) {
    if (f.label) { out.set(f.id, f.label); continue; }
    const base = (FILE_DEFAULT[f.kind] || FILE_DEFAULT.other)[zh ? 1 : 0]; seen[f.kind] = (seen[f.kind] || 0) + 1;
    out.set(f.id, count[f.kind] > 1 ? `${base} ${seen[f.kind]}` : base);
  }
  return out;
}
const ALLOWED_EXT = /^\.(pdf|png|jpe?g|webp|gif|docx?|xlsx?|csv|txt|zip|step|stp|iges?|dxf|dwg|ai|stl|psd|pptx?)$/;
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const INLINE_OK = /\.(pdf|png|jpe?g|webp|gif|txt)$/i;
const STD_MILESTONES = [
  ['RFQ package sent to suppliers', 0], ['Supplier quotes due', 10], ['Supplier selected', 17], ['Tooling / first samples (EVT) received', 45],
  ['Certification testing complete', 70], ['Pre-production sample (PVT) approved', 85], ['Pilot run', 100], ['Purchase order placed', 110],
];
// Business day in Lulyboo's time zone (California by default), so "overdue" flips at local midnight, not UTC.
const TZ = () => process.env.BUSINESS_TZ || 'America/Los_Angeles';
const dayIn = (d = new Date()) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); } catch { return d.toISOString().slice(0, 10); } };
const today = () => dayIn();
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const niceDate = (d) => { try { return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
const extOf = (n) => (String(n).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150);
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ownerEmails = () => (process.env.REQUEST_CC || 'marsel@lulyboo.com').split(/[,;\s]+/).filter((e) => EMAIL_RE.test(e));

async function nextRef(db) {
  const rows = await db.list('dev_projects', { select: 'ref' });
  return `DP-${rows.reduce((mx, r) => Math.max(mx, Number(String(r.ref).replace(/\D/g, '')) || 1000), 1000) + 1}`;
}

/** Store uploaded files in the documents bucket. Returns { saved:[{name,path,size,mime}], errors:[] } */
async function storeFiles(db, { projectId, files = [], maxBytes = 20 * 1024 * 1024 }) {
  const saved = []; const errors = [];
  for (const [i, f] of files.entries()) {
    const name = safeName(f.name); const ext = extOf(name);
    if (!f.buffer?.length) continue;
    if (!ALLOWED_EXT.test(ext)) { errors.push(`${name}: file type not allowed`); continue; }
    if (f.buffer.length > maxBytes) { errors.push(`${name}: larger than ${Math.round(maxBytes / 1048576)} MB`); continue; }
    const path = `dev/${projectId}/${crypto.randomUUID()}${ext}`;
    try { await db.docs.upload(path, f.buffer, MIME[ext] || 'application/octet-stream'); saved.push({ i, name, path, size: f.buffer.length, mime: MIME[ext] || null }); } catch (e) { errors.push(`${name}: could not be stored`); }
  }
  return { saved, errors };
}
const fileList = (files, key) => [].concat(files?.[key] || []);

// ── Notifications (best effort: a failed email never blocks the action)
async function notifyOwner(config, subject, text, email) {
  const to = ownerEmails(); if (!to.length) return;
  try {
    if (email) { const e = adminEmail({ preheader: subject, ...email }); await sendEmail(config, { to, subject, text: e.text, html: e.html }); return; }
    await sendEmail(config, { to, subject, text });
  } catch (e) { console.error('Owner notice failed:', e.message); }
}
async function supplierRecipients(db, supplier) {
  const users = await db.list('supplier_users', { filters: { supplier_id: supplier.id } });
  return [...new Set([supplier.email, ...users.filter((u) => u.status !== 'disabled').map((u) => u.email)].filter(Boolean).map((e) => e.toLowerCase()))];
}
async function notifySupplier(config, db, supplier, { subject, en, zh, link, email }) {
  try {
    const to = await supplierRecipients(db, supplier); if (!to.length) return false;
    if (email) { const e = projectEmail({ ...email, companyName: supplier.name, link }); await sendEmail(config, { to, subject, text: e.text, html: e.html, cc: ownerEmails() }); return true; }
    const text = `${en}\n\nOpen in the supplier portal: ${link}\n\n${zh}\n\n在供应商平台中查看：${link}`;
    await sendEmail(config, { to, subject, text, cc: ownerEmails() });
    return true;
  } catch (e) { console.error('Supplier notice failed:', e.message); return false; }
}

// Projects the supplier has been invited to but not opened yet (red badge in the portal menu).
async function newProjectCount(db, supplierId) {
  try { return (await db.list('dev_invitations', { filters: { supplier_id: supplierId } })).filter((i) => !i.viewed_at && !['Closed', 'Declined'].includes(i.status)).length; } catch { return 0; }
}

/**
 * Milestone reminders: one notice when (due - remind_days) arrives, then one per day while overdue.
 * Goes to the owner by email and, when configured, Telegram. Safe to call often.
 */
async function runMilestoneReminders({ db, config, now = new Date() }) {
  const day = dayIn(now);
  const open = (await db.list('dev_milestones', { filters: { done_at: null } })).filter((x) => x.due_date);
  const due = open.filter((x) => (x.due_date < day ? x.overdue_notice_on !== day : !x.reminded_at && addDays(x.due_date, -(x.remind_days ?? 2)) <= day));
  if (!due.length) return { sent: 0 };
  const projects = Object.fromEntries((await db.list('dev_projects')).map((p) => [p.id, p]));
  const lines = due.map((x) => `${x.due_date < day ? '⚠️ OVERDUE' : '⏰ Due'} ${x.due_date} · ${projects[x.project_id]?.ref || ''} ${projects[x.project_id]?.name || ''} · ${x.title}`);
  const sorted = [...due].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const late = sorted.filter((x) => x.due_date < day).length;
  const items = sorted.map((x) => {
    const pr = projects[x.project_id]; const d = daysBetween(day, x.due_date);
    const tag = d < 0 ? `Overdue · ${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`;
    return { tag, tone: d < 0 ? 'red' : 'amber', title: x.title, sub: `${pr?.ref || ''} ${pr?.name || ''} · due ${niceDate(x.due_date)}`.trim(), href: `${config.publicUrl}/admin/projects/${x.project_id}?tab=milestones` };
  });
  const subject = late ? `⚠️ ${late} overdue milestone${late > 1 ? 's' : ''}${due.length > late ? ` · ${due.length - late} due soon` : ''}` : `⏰ ${due.length} milestone${due.length > 1 ? 's' : ''} due soon`;
  await notifyOwner(config, `[Development] ${subject.replace(/^\S+ /, '')}`, `${lines.join('\n')}\n\n${config.publicUrl}/admin/projects`, {
    title: `${due.length} milestone${due.length > 1 ? 's' : ''} need${due.length > 1 ? '' : 's'} attention`,
    intro: late ? `${late} ${late > 1 ? 'are' : 'is'} overdue. Mark them done or move the date in the project's Milestones tab.` : 'Coming up soon in your development projects.',
    items, button: 'Open Development', link: `${config.publicUrl}/admin/projects`,
  });
  try {
    const st = (await db.list('settings', { limit: 1 }))[0];
    if (tg.enabled() && st?.telegram_chat_id) await tg.sendMessage(st.telegram_chat_id, `🛠 <b>Development milestones</b>\n${lines.map((l) => tg.escapeHtml(l)).join('\n')}`);
  } catch (e) { console.error('Milestone Telegram failed:', e.message); }
  for (const x of due) await db.update('dev_milestones', { id: x.id }, x.due_date < day ? { overdue_notice_on: day, reminded_at: x.reminded_at || now.toISOString() } : { reminded_at: now.toISOString() });
  return { sent: due.length };
}

module.exports = { dayIn, niceDate, newProjectCount, PROJECT_STATUSES, INV_STATUSES, FILE_KINDS, FILE_KINDS_ZH, FILE_GROUPS, FILE_DEFAULT, KIND_ORDER, guessKind, fileTitles, ALLOWED_EXT, MIME, INLINE_OK, STD_MILESTONES, today, addDays, slug, extOf, safeName, nextRef, storeFiles, fileList, notifyOwner, notifySupplier, supplierRecipients, runMilestoneReminders, ownerEmails };
