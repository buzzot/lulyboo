'use strict';
// Factory checklists per category, and spec versions of development projects.
//   A category holds a factory checklist imported from the Lulyboo Excel template ("Factory Checklist - Bath.xlsx"):
//   sections → questions, each with a stable key (the "AI Field Name"), an answer type and a required level.
//   A project copies it when its category is set (switch questions off, add its own). Suppliers answer it in the portal.
//   Spec versions: what suppliers see is the last PUBLISHED state. Saved edits are a draft until "Publish vN".
const crypto = require('node:crypto');

const TYPES = { file: 'File upload', choice: 'Choice', multi: 'Multi-select', text: 'Text' };
const REQ = { required: 'Required', cond: 'If applicable', preferred: 'Preferred', optional: 'Optional' };
const FILE_ANS = { yes: ['Uploaded', '已上传'], date: ['By a date', '预计日期'], no: ['Not available', '无法提供'], na: ['Not applicable', '不适用'] };
const MULTI = /^(Certifications_Available|Sound_Types|Light_Color_Options|Closure_Type|Attachment_Method|Cleaning_Method)$/;
const newKey = () => `x_${crypto.randomBytes(4).toString('hex')}`;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Clean questions: [{ key, name, section, type, options, req, req_label, hint }] (+ on/custom on projects). Older document items ({stage}) still read. */
function normItems(list, { project = false } = {}) {
  const seen = new Set(); const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const name = clip(x?.name, 200); if (!name) continue;
    let key = clip(x.key, 60).replace(/[^a-z0-9_-]/gi, '') || newKey(); if (seen.has(key)) key = newKey(); seen.add(key);
    const req = REQ[x.req] ? x.req : x.stage ? (x.stage === 'quote' ? 'required' : x.stage === 'optional' ? 'optional' : 'preferred') : 'optional';
    const type = TYPES[x.type] ? x.type : x.stage ? 'file' : 'text';
    const it = { key, name, section: clip(x.section, 80) || 'Documents', type, options: (type === 'choice' || type === 'multi') ? (x.options || []).map((o) => clip(o, 80)).filter(Boolean).slice(0, 40) : [],
      req, req_label: clip(x.req_label, 40) || REQ[req], hint: clip(x.hint || x.note, 300) };
    if (project) { it.on = x.on !== false; if (x.custom) it.custom = true; }
    out.push(it); if (out.length >= 200) break;
  }
  return out;
}
const sections = (items) => { const m = new Map(); for (const it of items) { if (!m.has(it.section)) m.set(it.section, []); m.get(it.section).push(it); } return [...m].map(([title, rows]) => ({ title, rows })); };

// ── Import the Excel template ───────────────────────────────────
const sentence = (s) => { const t = clip(s, 80).toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const isOther = (o) => /^other\b/i.test(o);
const optLabel = (o) => (isOther(o) ? 'Other' : o);
/**
 * Read "Factory Checklist - <Category>.xlsx" exactly (no AI).
 * Columns are found by their header: Section · Question / Field · AI Field Name · Required? · Accepted Options / Instructions.
 * Dropdown lists come from the sheet's data validation; questions asking to attach files become uploads.
 * The "Pricing, MOQ & lead time" section is left out: the quote form asks for it.
 */
function parseFactoryChecklist(buf, fileName = '') {
  const I = require('./importer');
  const files = I.unzip(buf); const sheetPath = I.targetSheetPath(files); const xml = files[sheetPath] || '';
  const rows = I.parseXlsx(buf);
  const hi = rows.findIndex((r) => r.some((c) => /^question/i.test(String(c).trim())) && r.some((c) => /ai field name/i.test(String(c))));
  if (hi < 0) throw new Error('This is not a Lulyboo factory checklist: no "Question / Field" and "AI Field Name" header row');
  const head = rows[hi].map((c) => String(c).trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const cS = col(/^section/); const cQ = col(/^question/); const cK = col(/ai field name/); const cR = col(/^required/); const cO = col(/accepted options|instructions/);
  // dropdown lists per row (column of the answer = the one after the question)
  const lists = {};
  for (const dv of xml.matchAll(/<dataValidation\b[^>]*\btype="list"[^>]*\bsqref="([^"]+)"[^>]*>[\s\S]*?<formula1>([\s\S]*?)<\/formula1>/g)) {
    const f = I.xmlDecode(dv[2]).trim(); if (!/^".*"$/.test(f)) continue;
    const opts = f.slice(1, -1).split(',').map((o) => o.trim()).filter(Boolean);
    for (const part of dv[1].split(/\s+/)) {
      const mm = part.match(/^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/); if (!mm) continue;
      for (let r = Number(mm[1]); r <= Number(mm[2] || mm[1]); r++) lists[r] = opts;
    }
  }
  const title = String(rows.slice(0, hi).flat().find((c) => /factory checklist/i.test(String(c))) || '');
  const category = clip((title.split(/\s[-–]\s/)[1]) || (String(fileName).match(/Factory Checklist\s*-\s*(.+?)\.xlsx?$/i) || [])[1] || '', 80);
  const items = []; const skipped = [];
  rows.forEach((r, i) => {
    if (i <= hi) return; const name = clip(r[cQ], 200); const key = clip(r[cK], 60).replace(/[^a-z0-9_]/gi, '_');
    if (!name || !key) return;
    const secRaw = clip(r[cS], 80);
    if (/pricing|moq|lead time/i.test(secRaw)) { skipped.push(name); return; }
    const section = /^category module/i.test(secRaw) ? `${category || 'Category'} questions` : sentence(secRaw);
    const reqTxt = clip(r[cR], 60); const instr = clip(r[cO], 400);
    const req = /^required$/i.test(reqTxt) ? 'required' : /^required\s+if/i.test(reqTxt) ? 'cond' : /^preferred/i.test(reqTxt) ? 'preferred' : /^optional/i.test(reqTxt) ? 'optional' : 'optional';
    const req_label = req === 'cond' ? reqTxt.replace(/^required\s+/i, '').replace(/^./, (c) => c.toUpperCase()) : REQ[req];
    let type = 'text'; let options = []; let hint = instr;
    let dv = lists[i + 1]; if (dv && !dv.some(isOther)) dv = null; // a validation without "Other" is a stray list, not real options
    const fromText = /\s\/\s/.test(instr) && /other\s*-\s*specify/i.test(instr) ? instr.split(/\s\/\s/).map((o) => o.trim().replace(/\.$/, '')).filter(Boolean) : null;
    if (/attach the actual file|paste image|image\/file link/i.test(instr)) { type = 'file'; hint = ''; }
    else if (dv || fromText) { options = dv || fromText; type = MULTI.test(key) ? 'multi' : 'choice'; hint = ''; }
    items.push({ key, name: type === 'file' ? name.replace(/\s+provided\?$/i, '') : name, section, type, options, req, req_label, hint });
  });
  if (!items.length) throw new Error('No questions found under the header row');
  return { category, items: normItems(items), skipped };
}

/** The checklist a project gets from its category (custom questions of the project are kept). */
function fromCategory(cat, keepCustom = []) {
  return {
    category_id: cat.id, category: cat.name,
    checklist: [...normItems(cat.checklist).map((x) => ({ ...x, on: true })), ...normItems(keepCustom, { project: true }).filter((x) => x.custom)],
    checklist_file: cat.checklist_file || null, checklist_version: cat.checklist_version || 0,
  };
}
/** Bring a project's checklist up to the category's newer version: questions from the category, the project's on/off kept. */
function refreshFromCategory(p, cat) {
  const old = Object.fromEntries((p.checklist || []).map((x) => [x.key, x]));
  return {
    checklist: [...normItems(cat.checklist).map((x) => ({ ...x, on: old[x.key] ? old[x.key].on !== false : true })), ...(p.checklist || []).filter((x) => x.custom)],
    checklist_file: cat.checklist_file || null, checklist_version: cat.checklist_version || 0,
  };
}
/** What changed in the category since the project copied it: { added, removed, changed } counts. */
function categoryChanges(p, cat) {
  if (!cat || !p.category_id || (cat.checklist_version || 0) <= (p.checklist_version || 0)) return null;
  const mine = Object.fromEntries((p.checklist || []).filter((x) => !x.custom).map((x) => [x.key, x])); const theirs = normItems(cat.checklist);
  const added = theirs.filter((x) => !mine[x.key]).length; const removed = Object.keys(mine).filter((k) => !theirs.some((x) => x.key === k)).length;
  const changed = theirs.filter((x) => mine[x.key] && (mine[x.key].name !== x.name || mine[x.key].req !== x.req || mine[x.key].type !== x.type || JSON.stringify(mine[x.key].options || []) !== JSON.stringify(x.options))).length;
  const fileChanged = (cat.checklist_file?.path || '') !== (p.checklist_file?.path || '');
  return { added, removed, changed, fileChanged, version: cat.checklist_version };
}

// ── Supplier answers ────────────────────────────────────────────
// answers[key] = { value (text/choice) | value: [..] (multi), details, na, status (file: yes|date|no|na), date, files: [{name,path,size,mime,at}], at }
function answered(it, a) {
  if (!a) return false;
  if (it.type === 'file') return (a.status === 'yes' && (a.files || []).length > 0) || (a.status === 'date' && !!a.date) || a.status === 'no' || a.status === 'na';
  if (it.type === 'multi') return Array.isArray(a.value) && a.value.length > 0;
  return !!a.na || (a.value !== undefined && a.value !== null && String(a.value).trim() !== '');
}
/** Plain answer, for admin views. */
function answerText(it, a) {
  if (!a) return '';
  if (it.type === 'file') return a.status === 'yes' ? `${(a.files || []).length} file${(a.files || []).length === 1 ? '' : 's'}` : a.status === 'date' ? `By ${a.date || '(date missing)'}` : a.status === 'no' ? 'Not available' : a.status === 'na' ? 'Not applicable' : '';
  if (a.na) return 'Not applicable';
  const v = Array.isArray(a.value) ? a.value.map(optLabel).join(', ') : optLabel(String(a.value ?? ''));
  return [v, a.details].filter(Boolean).join(' — ');
}
/** items: the published checklist (questions switched on); answers: inv.doc_answers. */
function docStatus(items, answers = {}) {
  const rows = normItems(items).map((it) => { const a = answers?.[it.key] || null; return { ...it, a, files: a?.files || [], done: answered(it, a) }; });
  const fileRows = rows.filter((r) => r.type === 'file');
  const reqLeft = rows.filter((r) => r.req === 'required' && !r.done);
  return {
    rows, sections: sections(rows).map((s) => ({ ...s, done: s.rows.filter((r) => r.done).length })),
    total: rows.length, done: rows.filter((r) => r.done).length, reqLeft, quoteOpen: reqLeft,
    files: { total: fileRows.length, ready: fileRows.filter((r) => r.a?.status === 'yes' && r.files.length).length },
    // legacy names used by older views
    ready: rows.filter((r) => r.done).length, missing: rows.filter((r) => !r.done),
  };
}
/** "42 / 86 · 9 required left" */
function readinessText(st) {
  if (!st.total) return '';
  return `${st.done} / ${st.total}${st.reqLeft.length ? ` · ${st.reqLeft.length} required left` : ' · all required answered'}`;
}

// ── Spec state, drafts and differences ──────────────────────────
/** Everything a supplier sees, as one comparable object. */
function specState(p, files = []) {
  return {
    name: p.name || '', summary: p.summary || '', requirements: p.requirements || '', certifications: p.certifications || '',
    extra: (p.extra_fields || []).map((x) => x.label),
    files: files.filter((f) => !f.internal).map((f) => ({ id: f.id, title: f.label || f.name })),
    ckfile: p.checklist_file ? { name: p.checklist_file.name, path: p.checklist_file.path, mime: p.checklist_file.mime || null } : null,
  };
}

const words = (s) => String(s).split(/\s+/).filter(Boolean);
/** One changed line, shortened to the words that differ: { before, old, new, after }. */
function wordDiff(a, b) {
  const x = words(a); const y = words(b); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0; while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const pre = x.slice(Math.max(0, i - 3), i).join(' '); const post = x.slice(x.length - j, x.length - j + 2).join(' ');
  return { before: (i > 3 ? '… ' : '') + pre, old: clip(x.slice(i, x.length - j).join(' '), 80), new: clip(y.slice(i, y.length - j).join(' '), 80), after: post + (j > 2 ? ' …' : '') };
}
const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
const TEXT = [['name', 'Product name'], ['summary', 'Summary'], ['requirements', 'Requirements'], ['certifications', 'Certifications']];

/** Differences between two spec states. Each change: { field, label, items: [{ t: 'add'|'del'|'chg', text, old?, new?, before?, after? }] } */
function diffStates(a, b) {
  a = a || {}; b = b || {}; const out = [];
  for (const [k, label] of TEXT) {
    if ((a[k] || '') === (b[k] || '')) continue;
    const la = lines(a[k]); const lb = lines(b[k]); const del = la.filter((l) => !lb.includes(l)); const add = lb.filter((l) => !la.includes(l)); const items = [];
    const pairs = Math.min(del.length, add.length);
    for (let i = 0; i < pairs; i++) items.push({ t: 'chg', ...wordDiff(del[i], add[i]) });
    for (const l of del.slice(pairs)) items.push({ t: 'del', text: clip(l, 120) });
    for (const l of add.slice(pairs)) items.push({ t: 'add', text: clip(l, 120) });
    if (!items.length) items.push({ t: 'chg', before: '', old: '', new: 'line order / spacing', after: '' });
    out.push({ field: k, label, items });
  }
  const set = (field, label, xs, ys, id, title) => {
    const A = new Map((xs || []).map((x) => [id(x), x])); const B = new Map((ys || []).map((y) => [id(y), y])); const items = [];
    const adds = [...B].filter(([k]) => !A.has(k)).map(([, y]) => y); const dels = [...A].filter(([k]) => !B.has(k)).map(([, x]) => x);
    const many = (n) => `${n} ${field === 'checklist' ? 'questions' : 'items'}`;
    if (adds.length > 6) items.push({ t: 'add', text: many(adds.length) }); else for (const y of adds) items.push({ t: 'add', text: title(y) });
    if (dels.length > 6) items.push({ t: 'del', text: many(dels.length) }); else for (const x of dels) items.push({ t: 'del', text: title(x) });
    if (field === 'checklist') for (const [k, y] of B) { const x = A.get(k); if (x && (title(x) !== title(y) || x.type !== y.type)) items.push({ t: 'chg', before: '', old: title(x), new: title(y), after: '' }); }
    if (items.length) out.push({ field, label, items });
  };
  set('extra', 'Quote questions', a.extra, b.extra, (x) => x, (x) => x);
  set('files', 'Files', a.files, b.files, (x) => x.id, (x) => x.title);
  const ck = (x) => normItems([x])[0] || x;
  set('checklist', 'Factory checklist', (a.checklist || []).map(ck), (b.checklist || []).map(ck), (x) => x.key, (x) => `${x.name} (${(x.req_label || REQ[x.req] || '').toLowerCase()})`);
  if ((a.ckfile?.path || '') !== (b.ckfile?.path || '')) out.push({ field: 'ckfile', label: 'Checklist file', items: [b.ckfile ? { t: 'add', text: b.ckfile.name } : { t: 'del', text: a.ckfile?.name || 'file' }] });
  return out;
}
/** A change note written from the differences, no AI: "Requirements: Wall 2.0 mm (was 1.5); Files: + Drawing rev B". */
function autoNote(changes) {
  const parts = changes.map((c) => {
    const bits = c.items.slice(0, 3).map((i) => (i.t === 'add' ? `+ ${i.text}` : i.t === 'del' ? `− ${i.text}` : i.old ? `${[i.before.replace(/^… /, ''), i.new || '(removed)', i.after.replace(/ …$/, '')].filter(Boolean).join(' ')} (was ${i.old})` : i.new));
    return `${c.label}: ${bits.join(', ')}${c.items.length > 3 ? ` +${c.items.length - 3} more` : ''}`;
  });
  return clip(parts.join('; '), 480);
}

module.exports = { TYPES, REQ, FILE_ANS, isOther, optLabel, newKey, normItems, sections, parseFactoryChecklist, fromCategory, refreshFromCategory, categoryChanges, answered, answerText, docStatus, readinessText, specState, diffStates, autoNote, wordDiff };
