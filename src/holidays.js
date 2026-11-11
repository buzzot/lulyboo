'use strict';
// Supplier holidays (Chinese New Year etc.): when a supplier stops taking orders, stops shipping, and when the factory
// and office close. Entered by Lulyboo or by the supplier in the portal, typed in or read by AI from an email /
// screenshot / PDF. Shown on the CRM calendar; suppliers confirm their schedule for the coming year.

const AI = require('./ai');

const STAGES = [
  // key, before field, after field, en, zh, icon
  { key: 'order', a: 'order_cutoff', b: 'order_cutoff_after', en: 'Order cut-off', zh: '下单截止', ic: '⛔', hintEn: 'Last day to place a PO for shipment before the holiday · for the first shipment after', hintZh: '节前出货的最后下单日 · 节后首批出货的下单截止日' },
  { key: 'ship', a: 'last_ship', b: 'first_ship', en: 'Shipping cut-off', zh: '出货截止', ic: '🚢', hintEn: 'Last shipment before the holiday · first shipment after', hintZh: '节前最后出货日 · 节后首次出货日' },
  { key: 'factory', a: 'factory_from', b: 'factory_to', en: 'Factory closed', zh: '工厂放假', ic: '🏭', hintEn: 'First and last day the factory is closed', hintZh: '工厂放假的第一天和最后一天' },
  { key: 'office', a: 'office_from', b: 'office_to', en: 'Office closed', zh: '办公室放假', ic: '🏢', hintEn: 'First and last day nobody answers emails', hintZh: '办公室放假（无人回复邮件）的第一天和最后一天' },
];
const DATE_FIELDS = STAGES.flatMap((s) => [s.a, s.b]);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const today = () => new Date().toISOString().slice(0, 10);

/** Holiday year a schedule belongs to: the year of the closure, else of any date in it. */
function yearOf(h) {
  const d = h.factory_from || h.office_from || h.last_ship || h.first_ship || h.order_cutoff_after || h.factory_to || h.order_cutoff;
  return d ? Number(String(d).slice(0, 4)) : null;
}

/** Year suppliers should be confirming now: next year from September on, otherwise this year. */
function targetYear(day = today()) {
  const y = Number(day.slice(0, 4)); const mo = Number(day.slice(5, 7));
  return mo >= 9 ? y + 1 : y;
}

/** Form / AI fields → a clean row. Throws a bilingual-ready message on bad input. */
function clean(f) {
  const row = { name: String(f.name || '').trim().slice(0, 120) || 'Holiday', notes: String(f.notes || '').trim().slice(0, 1000) || null };
  for (const k of DATE_FIELDS) row[k] = isDate(f[k]) ? String(f[k]) : null;
  const pairs = STAGES.filter((s) => ['factory', 'office'].includes(s.key));
  for (const s of pairs) {
    if (row[s.a] && !row[s.b]) row[s.b] = row[s.a];
    if (row[s.b] && !row[s.a]) row[s.a] = row[s.b];
    if (row[s.a] && row[s.b] && row[s.a] > row[s.b]) [row[s.a], row[s.b]] = [row[s.b], row[s.a]];
  }
  if (!DATE_FIELDS.some((k) => row[k])) throw new Error('Enter at least one date');
  row.year = yearOf(row);
  return row;
}

// ── AI ────────────────────────────────────────────────────────────────────────
const d = (description) => ({ type: 'string', description: `${description} (YYYY-MM-DD, or empty if not stated)` });
const TOOL = {
  name: 'record_holidays',
  description: 'Record the holiday schedule(s) a supplier announced (Chinese New Year, National Day, factory summer break…).',
  input_schema: {
    type: 'object',
    properties: {
      supplier_name: { type: 'string', description: 'Company name of the supplier who sent it, if visible (signature, email domain, letterhead)' },
      holidays: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'e.g. "Chinese New Year 2027", "National Day 2026"' },
            order_cutoff: d('Last day to place an order to ship BEFORE the holiday'),
            order_cutoff_after: d('Order deadline for the FIRST shipment AFTER the holiday'),
            last_ship: d('Last shipment / loading date before the holiday'),
            first_ship: d('First shipment date after the holiday'),
            factory_from: d('First day the factory / production is closed'),
            factory_to: d('Last day the factory is closed (or the day before work resumes)'),
            office_from: d('First day the office is closed'),
            office_to: d('Last day the office is closed'),
            notes: { type: 'string', description: 'Anything else worth keeping, one short sentence (e.g. "Busy two months before CNY")' },
            quotes: { type: 'object', description: 'For each date you filled, the short source words it came from, keyed by field name', additionalProperties: { type: 'string' } },
          },
          required: ['name'],
        },
      },
    },
    required: ['holidays'],
  },
};
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Read a holiday notice. file: {name, buffer}; text: pasted email. emailDate: when it was sent, if known. */
async function readHolidays({ file = null, text = '', emailDate = '' }) {
  const content = [];
  if (file?.buffer?.length) {
    const ext = (String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (ext === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } });
    else if (MIME[ext]) content.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext], data: file.buffer.toString('base64') } });
    else if (/^(txt|eml|html?)$/.test(ext)) text = `${file.buffer.toString('utf8').replace(/<[^>]+>/g, ' ').slice(0, 30000)}\n${text}`;
    else throw new Error('Use a screenshot (PNG/JPG), PDF or the email text');
  }
  const y = Number(today().slice(0, 4));
  content.push({ type: 'text', text: [
    `Today is ${today()}.${emailDate ? ` The notice was sent on ${emailDate}.` : ''}`,
    'Read this supplier holiday notice and record each holiday it announces.',
    `Dates: Chinese suppliers usually write day/month/year (1/12/2026 = 1 December 2026, 28/1/2027 = 28 January 2027). Use the order of the other dates to decide. A year missing from a date is ${y} or ${y + 1}, whichever makes the schedule consistent.`,
    'Relative phrases ("next week is the last week to order") only count when the notice date is known; otherwise leave the field empty.',
    'Leave a date empty when the notice does not give it. Never guess the office dates from the factory dates.',
    text ? `\nNOTICE:\n${String(text).slice(0, 30000)}` : '',
  ].join('\n') });
  const { result } = await AI.callTool({ tool: TOOL, content, maxTokens: 2500 });
  const holidays = (result?.holidays || []).map((h) => {
    const out = { name: String(h.name || 'Holiday').slice(0, 120), notes: h.notes ? String(h.notes).slice(0, 500) : '', quotes: {} };
    for (const k of DATE_FIELDS) { out[k] = isDate(h[k]) ? h[k] : ''; if (out[k] && h.quotes?.[k]) out.quotes[k] = String(h.quotes[k]).slice(0, 120); }
    return out;
  }).filter((h) => DATE_FIELDS.some((k) => h[k]));
  return { holidays, supplierName: result?.supplier_name ? String(result.supplier_name).slice(0, 160) : '' };
}

/** Best supplier match for a name AI saw (exact, then one containing the other). */
function matchSupplier(name, suppliers) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  if (n.length < 3) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  return suppliers.find((s) => norm(s.name) === n) || suppliers.filter((s) => { const m = norm(s.name); return m.length > 3 && (m.includes(n) || n.includes(m)); }).reduce((a, s, i, all) => (all.length === 1 ? s : null), null);
}

/** Calendar items for one holiday: closures as ranges, cut-offs as single days. */
function events(h) {
  const out = [];
  if (h.factory_from) out.push({ kind: 'factory', from: h.factory_from, to: h.factory_to || h.factory_from, en: 'factory closed', zh: '工厂放假' });
  if (h.office_from) out.push({ kind: 'office', from: h.office_from, to: h.office_to || h.office_from, en: 'office closed', zh: '办公室放假' });
  const flag = (k, ic, en, zh) => { if (h[k]) out.push({ kind: 'flag', from: h[k], to: h[k], ic, en, zh, field: k }); };
  flag('order_cutoff', '⛔', 'last order before holiday', '节前最后下单');
  flag('order_cutoff_after', '⛔', 'order cut-off for after holiday', '节后出货下单截止');
  flag('last_ship', '🚢', 'last shipment before holiday', '节前最后出货');
  flag('first_ship', '🚢', 'first shipment after holiday', '节后首次出货');
  return out;
}

/** Factory closure that covers a date, if any. */
function closureOn(holidays, supplierId, day) {
  if (!day) return null;
  return holidays.find((h) => h.supplier_id === supplierId && h.factory_from && day >= h.factory_from && day <= (h.factory_to || h.factory_from)) || null;
}

/** CRM follow-ups 7 days before each order cut-off (replaced when the holiday changes). Returns task ids. */
async function syncReminders(db, h, supplierName) {
  for (const id of Array.isArray(h.reminder_task_ids) ? h.reminder_task_ids : []) {
    const t = await db.get('crm_tasks', id).catch(() => null);
    if (t && !t.done) await db.remove('crm_tasks', { id }).catch(() => null);
  }
  const ids = [];
  const day = today();
  for (const [k, what] of [['order_cutoff', 'for shipment before'], ['order_cutoff_after', 'for the first shipment after']]) {
    if (!h[k]) continue;
    let due = new Date(Date.parse(`${h[k]}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
    if (h[k] < day) continue;
    if (due < day) due = day;
    try {
      const t = await db.insert('crm_tasks', { supplier_id: h.supplier_id, title: `Order cut-off ${h[k]}: place POs with ${supplierName || 'supplier'} ${what} ${h.name}`.slice(0, 300), type: 'Follow-up', due_date: due, notes: 'Added from the supplier holiday schedule.' });
      ids.push(t.id);
    } catch { /* CRM tasks are optional */ }
  }
  return ids;
}

module.exports = { STAGES, DATE_FIELDS, TOOL, isDate, yearOf, targetYear, clean, readHolidays, matchSupplier, events, closureOn, syncReminders };
