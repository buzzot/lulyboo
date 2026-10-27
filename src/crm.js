'use strict';
// CRM core: dates in the team's time zone, open items (tasks + legacy follow-ups), task actions,
// and the reminder runner (daily digest + timed pings on Telegram).

const tg = require('./telegram');

const TASK_TYPES = ['Follow-up', 'Call', 'Email', 'Meeting', 'Sample', 'Visit', 'Other'];
const ACTIVITY_TYPE = { 'Follow-up': 'Note', Call: 'Call', Email: 'Email', Meeting: 'Meeting', Sample: 'Sample', Visit: 'Factory visit', Other: 'Note' };
const tzOf = () => process.env.CRM_TIMEZONE || 'America/Los_Angeles';
const digestHourLabel = () => `${digestHour()}:00`;
const digestHour = () => { const h = Number(process.env.CRM_DIGEST_HOUR); return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8; };

// ── Dates (plain 'YYYY-MM-DD' strings; arithmetic done in UTC so DST never shifts a day)
const pad = (n) => String(n).padStart(2, '0');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
function addDays(date, n) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** Local date + time in the CRM time zone. */
function localNow(now = new Date(), tz = tzOf()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}
const minutesOf = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const hmOf = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const dayName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// ── Open items: CRM tasks plus follow-up dates from the older activity log
async function openItems(db, { supplierId } = {}) {
  const tf = { done: false }; const af = { done: false };
  if (supplierId) { tf.supplier_id = supplierId; af.supplier_id = supplierId; }
  const [tasks, acts] = await Promise.all([
    db.list('crm_tasks', { filters: tf, order: 'due_date.asc' }),
    db.list('supplier_activities', { filters: af, order: 'follow_up_date.asc' }),
  ]);
  const items = tasks.map((x) => ({ kind: 'task', id: x.id, supplier_id: x.supplier_id, title: x.title, notes: x.notes, type: x.type, due_date: x.due_date, due_time: x.due_time || null, remind_minutes: x.remind_minutes, request_id: x.request_id, product_id: x.product_id }));
  for (const a of acts) if (a.follow_up_date) items.push({ kind: 'act', id: a.id, supplier_id: a.supplier_id, title: a.summary, type: 'Follow-up', due_date: a.follow_up_date, due_time: null });
  const key = (i) => `${i.due_date} ${i.due_time || '99:99'}`;
  return items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ── Task actions (shared by the web pages and the Telegram bot)
async function completeTask(db, id) {
  const x = await db.get('crm_tasks', id);
  if (!x || x.done) return x;
  await db.update('crm_tasks', { id }, { done: true, done_at: new Date().toISOString() });
  if (x.supplier_id) await db.insert('supplier_activities', { supplier_id: x.supplier_id, type: ACTIVITY_TYPE[x.type] || 'Note', summary: `Done: ${x.title}`.slice(0, 5000), activity_date: localNow().date, done: true });
  return { ...x, done: true };
}
async function snoozeTask(db, id, days, now = new Date()) {
  const x = await db.get('crm_tasks', id);
  if (!x) return null;
  const base = x.due_date < localNow(now).date ? localNow(now).date : x.due_date; // overdue items move from today, not from the past
  const due = addDays(base, days);
  await db.update('crm_tasks', { id }, { due_date: due, reminded_at: null });
  return { ...x, due_date: due };
}

/** A supplier answered: close the open follow-up tasks that were created for that request. */
async function completeRequestTasks(db, requestId) {
  const open = await db.list('crm_tasks', { filters: { request_id: requestId, done: false } });
  for (const x of open) await completeTask(db, x.id);
  return open.length;
}

// ── Telegram reminders
const settingsRow = async (db) => (await db.list('settings', { limit: 1 }))[0] || null;
const line = (i, names) => `• ${i.due_time ? i.due_time + ' ' : ''}<b>${tg.escapeHtml(names[i.supplier_id] || 'General')}</b> — ${tg.escapeHtml(i.title)} <i>(${tg.escapeHtml(i.type)})</i>`;

async function supplierNames(db) { return Object.fromEntries((await db.list('suppliers', { select: 'id,name' })).map((s) => [s.id, s.name])); }

function digestText(items, names, today) {
  const overdue = items.filter((i) => i.due_date < today);
  const todays = items.filter((i) => i.due_date === today);
  const tomorrow = items.filter((i) => i.due_date === addDays(today, 1)).length;
  const out = [`☀️ <b>Good morning — ${dayName(today)}</b>`];
  if (overdue.length) out.push('', `⚠️ <b>Overdue (${overdue.length})</b>`, ...overdue.slice(0, 15).map((i) => `${line(i, names)} · due ${i.due_date}`));
  if (todays.length) out.push('', `📌 <b>Today (${todays.length})</b>`, ...todays.slice(0, 20).map((i) => line(i, names)));
  if (!overdue.length && !todays.length) out.push('', 'Nothing due today ✅');
  if (tomorrow) out.push('', `Tomorrow: ${tomorrow} item${tomorrow > 1 ? 's' : ''}`);
  return out.join('\n');
}
const taskButtons = (id) => [[{ text: '✅ Done', data: `d:${id}` }, { text: '💤 +1 day', data: `s1:${id}` }, { text: '💤 +1 week', data: `s7:${id}` }]];

/**
 * Called every minute. Sends (1) one digest per day after CRM_DIGEST_HOUR and (2) a ping for each timed task
 * when its reminder moment arrives. Safe to call repeatedly: sent state is stored (settings.crm_digest_date, task.reminded_at).
 */
async function runReminders({ db, config, now = new Date() }) {
  if (!tg.enabled()) return { sent: 0 };
  const st = await settingsRow(db);
  const chat = st?.telegram_chat_id;
  if (!chat) return { sent: 0 };
  const ln = localNow(now);
  const items = await openItems(db);
  const names = await supplierNames(db);
  let sent = 0;

  if (ln.hour >= digestHour() && st.crm_digest_date !== ln.date) {
    const dueNow = items.filter((i) => i.due_date <= addDays(ln.date, 1));
    if (items.some((i) => i.due_date <= ln.date) || dueNow.length) {
      await tg.sendMessage(chat, digestText(items, names, ln.date), { buttons: [[{ text: 'Open CRM', url: `${config.publicUrl}/admin/crm` }]] });
      sent++;
    }
    await db.update('settings', { id: 1 }, { crm_digest_date: ln.date });
  }

  for (const i of items) {
    if (i.kind !== 'task' || !i.due_time) continue;
    const task = await db.get('crm_tasks', i.id);
    if (!task || task.reminded_at) continue;
    const remindAt = `${i.due_date} ${hmOf(Math.max(0, minutesOf(i.due_time) - (Number(i.remind_minutes) || 0)))}`;
    if (`${ln.date} ${ln.time}` < remindAt) continue;
    const stale = `${ln.date} ${ln.time}` > `${addDays(i.due_date, 1)} ${i.due_time}`; // missed by over a day: the digest already covers it
    if (!stale) {
      await tg.sendMessage(chat, `⏰ <b>${i.due_time}</b> — ${tg.escapeHtml(i.type)}\n<b>${tg.escapeHtml(names[i.supplier_id] || 'General')}</b>: ${tg.escapeHtml(i.title)}`, { buttons: taskButtons(i.id) });
      sent++;
    }
    await db.update('crm_tasks', { id: i.id }, { reminded_at: now.toISOString() });
  }
  return { sent };
}

module.exports = { digestHourLabel, TASK_TYPES, ACTIVITY_TYPE, tzOf, localNow, addDays, isDate, isTime, dayName, openItems, completeTask, completeRequestTasks, snoozeTask, runReminders, digestText, taskButtons, supplierNames, settingsRow, line };
