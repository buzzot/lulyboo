'use strict';
// CRM: follow-up tasks per supplier, Today/Overdue list, month calendar, Telegram reminders.
//   /admin/crm            list (Overdue · Today · Next 7 days · Later)
//   /admin/crm/calendar   month calendar with the day's items below
//   POST /hooks/telegram  Telegram bot webhook (pairing, Done / Snooze buttons, /today)

const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, readBody, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const { guard } = require('./admin');
const C = require('../crm');
const tg = require('../telegram');

const REMIND = [[0, 'At the time'], [15, '15 min before'], [30, '30 min before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']];
const tyClass = (t) => `ty-${String(t).toLowerCase().replace(/[^a-z]/g, '')}`;
const safeBack = (b, fb) => (/^\/admin\/[\w\/?=&.#-]*$/.test(b || '') ? b : fb);
let botName = null;

module.exports = function crmRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);

  // ── Shared view pieces ──────────────────────────────────────
  const supplierOptions = (suppliers, selected) => html`<option value="">— General (no supplier) —</option>${suppliers.map((s) => html`<option value="${s.id}" ${s.id === selected ? raw('selected') : ''}>${s.name}</option>`)}`;

  function taskForm({ suppliers, date, back, supplierId = '', requestId = '', productId = '' }) {
    return html`<form method="post" action="/admin/crm/tasks" class="grid crm-form">
      <input type="hidden" name="back" value="${back}"><input type="hidden" name="request_id" value="${requestId}"><input type="hidden" name="product_id" value="${productId}">
      <label class="span2"><span class="lbl">What needs to happen</span><input name="title" required maxlength="300" placeholder="e.g. Chase sample shipment tracking number"></label>
      <label><span class="lbl">Supplier</span><select name="supplier_id">${supplierOptions(suppliers, supplierId)}</select></label>
      <label><span class="lbl">Type</span><select name="type">${C.TASK_TYPES.map((x) => html`<option>${x}</option>`)}</select></label>
      <label><span class="lbl">Date</span><input type="date" name="due_date" value="${date}" required></label>
      <label><span class="lbl">Time (optional, enables a Telegram ping)</span><input type="time" name="due_time"></label>
      <label><span class="lbl">Ping me</span><select name="remind_minutes">${REMIND.map(([v, l]) => html`<option value="${v}" ${v === 15 ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="span2"><span class="lbl">Notes (optional)</span><input name="notes" maxlength="2000"></label>
      <div><button class="btn small">Add to calendar</button></div>
    </form>`;
  }

  function itemRow(i, { names, today, back }) {
    const late = i.due_date < today;
    const supplier = i.supplier_id ? html`<a href="/admin/suppliers/${i.supplier_id}">${names[i.supplier_id] || 'Supplier'}</a>` : html`<span class="muted">General</span>`;
    const doneUrl = i.kind === 'task' ? `/admin/crm/tasks/${i.id}/done` : `/admin/activities/${i.id}/done`;
    const snooze = (days, label) => html`<form method="post" action="/admin/crm/tasks/${i.id}/snooze" class="inline"><input type="hidden" name="back" value="${back}"><input type="hidden" name="days" value="${days}"><button class="link">${label}</button></form>`;
    return html`<li class="task ${tyClass(i.type)} ${late ? 'late' : ''}">
      <div class="t-main"><span class="date ${late ? 'late' : ''}">${C.dayName(i.due_date)}${i.due_time ? ' · ' + i.due_time : ''}</span>
        <span class="tag ${tyClass(i.type)}">${i.type}</span> <b>${i.title}</b> · ${supplier}${i.notes ? html`<div class="sub">${i.notes}</div>` : ''}</div>
      <div class="t-act">
        <form method="post" action="${doneUrl}" class="inline"><input type="hidden" name="back" value="${back}"><button class="link ok">✓ Done</button></form>
        ${i.kind === 'task' ? html`${snooze(1, '+1 day')}${snooze(7, '+1 week')}
          <details class="t-edit"><summary class="link">Edit</summary>
            <form method="post" action="/admin/crm/tasks/${i.id}/edit" class="grid crm-form"><input type="hidden" name="back" value="${back}">
              <label class="span2"><span class="lbl">Title</span><input name="title" value="${i.title}" required maxlength="300"></label>
              <label><span class="lbl">Date</span><input type="date" name="due_date" value="${i.due_date}" required></label>
              <label><span class="lbl">Time</span><input type="time" name="due_time" value="${i.due_time || ''}"></label>
              <div><button class="btn small">Save</button></div></form>
            <form method="post" action="/admin/crm/tasks/${i.id}/delete" class="inline" data-confirm="Delete this task?"><input type="hidden" name="back" value="${back}"><button class="link danger">Delete</button></form>
          </details>` : ''}
      </div></li>`;
  }

  const tabs = (active) => html`<div class="tabs"><a href="/admin/crm" class="${active === 'list' ? 'on' : ''}">List</a><a href="/admin/crm/calendar" class="${active === 'cal' ? 'on' : ''}">Calendar</a></div>`;

  // Used by the supplier page: this supplier's open items + a form to schedule one.
  router.crmWidget = async (supplierId, back) => {
    const [items, suppliers, names] = await Promise.all([C.openItems(db, { supplierId }), db.list('suppliers', { select: 'id,name', order: 'name.asc' }), C.supplierNames(db)]);
    const today = C.localNow().date;
    return html`<section class="card" id="next-actions"><div class="head-row"><h2>Next actions</h2><a class="btn small ghost" href="/admin/crm/calendar">Calendar</a></div>
      ${items.length ? html`<ul class="tasks">${items.map((i) => itemRow(i, { names, today, back }))}</ul>` : html`<p class="muted">Nothing scheduled with this supplier.</p>`}
      <details class="t-edit"><summary class="btn small">+ Schedule a follow-up</summary>${taskForm({ suppliers, date: today, back, supplierId })}</details></section>`;
  };

  // ── List ────────────────────────────────────────────────────
  router.get('/admin/crm', G(async (req, res) => {
    const today = C.localNow().date;
    const supplierFilter = req.query.supplier || '';
    const [items, suppliers, names, doneRows, st] = await Promise.all([
      C.openItems(db, { supplierId: supplierFilter || undefined }),
      db.list('suppliers', { select: 'id,name', order: 'name.asc' }),
      C.supplierNames(db),
      db.list('crm_tasks', { filters: { done: true }, order: 'done_at.desc', limit: 8 }),
      C.settingsRow(db),
    ]);
    const week = C.addDays(today, 7);
    const groups = [
      ['Overdue', items.filter((i) => i.due_date < today), 'late'],
      ['Today', items.filter((i) => i.due_date === today), 'today'],
      ['Next 7 days', items.filter((i) => i.due_date > today && i.due_date <= week), ''],
      ['Later', items.filter((i) => i.due_date > week), ''],
    ];
    const back = '/admin/crm' + (supplierFilter ? `?supplier=${supplierFilter}` : '');
    const ctx = { names, today, back };
    res.html(page({
      title: 'CRM', nav: adminNav('crm'), flash: takeFlash(req, res),
      body: html`<div class="head-row"><h1>CRM</h1>${tabs('list')}</div>
      <div class="kpis">
        <div class="kpi ${groups[0][1].length ? 'warn' : ''}"><b>${groups[0][1].length}</b><span>Overdue</span></div>
        <div class="kpi accent"><b>${groups[1][1].length}</b><span>Due today</span></div>
        <div class="kpi"><b>${groups[2][1].length}</b><span>Next 7 days</span></div>
        <div class="kpi"><b>${items.length}</b><span>Open in total</span></div>
      </div>
      <form method="get" class="filters"><label><span class="lbl">Supplier</span><select name="supplier" onchange="this.form.submit()"><option value="">All suppliers</option>${suppliers.map((s) => html`<option value="${s.id}" ${s.id === supplierFilter ? raw('selected') : ''}>${s.name}</option>`)}</select></label><noscript><button class="btn small">Filter</button></noscript></form>
      <section class="card"><h2>Add a follow-up or appointment</h2>${taskForm({ suppliers, date: today, back, supplierId: supplierFilter })}</section>
      ${groups.map(([label, list, cls]) => list.length ? html`<section class="card crm-group ${cls}"><h2>${label} <span class="muted">(${list.length})</span></h2><ul class="tasks">${list.map((i) => itemRow(i, ctx))}</ul></section>` : '')}
      ${!items.length ? html`<section class="card"><p class="muted">Nothing scheduled. Add your first follow-up above.</p></section>` : ''}
      ${doneRows.length ? html`<details class="card"><summary><b>Recently completed</b></summary><ul class="feed">${doneRows.map((d) => html`<li class="done"><span class="date">${fmt.date(d.due_date)}</span> ${d.title} · ${names[d.supplier_id] || 'General'}</li>`)}</ul></details>` : ''}
      ${await remindersCard(st)}`,
    }));
  }));

  async function remindersCard(st) {
    const paired = !!st?.telegram_chat_id;
    let link = null;
    if (tg.enabled() && st?.telegram_pair_code) {
      try { botName ||= (await tg.getMe()).username; link = `https://t.me/${botName}?start=${st.telegram_pair_code}`; } catch { /* shown below */ }
    }
    return html`<section class="card" id="reminders"><h2>Telegram reminders</h2>
      ${!tg.enabled() ? html`<p class="muted">Not set up. Create a bot with <b>@BotFather</b> in Telegram, then add its token as <code>TELEGRAM_BOT_TOKEN</code> in Railway and redeploy.</p>` : paired ? html`
        <p>✅ Connected. You get a summary every morning (${C.digestHourLabel()} ${C.tzOf()}) and a ping before timed items, with Done / +1 day / +1 week buttons.</p>
        <div class="form-actions"><form method="post" action="/admin/crm/telegram/test" class="inline"><button class="btn small ghost">Send a test message</button></form>
        <form method="post" action="/admin/crm/telegram/disconnect" class="inline" data-confirm="Disconnect Telegram reminders?"><button class="link danger">Disconnect</button></form></div>` : link ? html`
        <p>Open this link on your phone (or computer with Telegram) and press <b>Start</b>:</p><p><a class="btn" href="${link}" target="_blank" rel="noopener">Connect Telegram</a></p>
        <p class="muted small">After pressing Start the bot says “Connected”. Reload this page to confirm.</p>` : html`
        <p class="muted">Get the morning summary and timed pings on your phone.</p>
        <form method="post" action="/admin/crm/telegram/connect"><button class="btn small">Connect Telegram</button></form>`}
    </section>`;
  }

  // ── Calendar ────────────────────────────────────────────────
  router.get('/admin/crm/calendar', G(async (req, res) => {
    const today = C.localNow().date;
    let month = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : today.slice(0, 7);
    const first = `${month}-01`;
    const dow = new Date(first + 'T00:00:00Z').getUTCDay();
    const gridStart = C.addDays(first, -dow);
    const gridEnd = C.addDays(gridStart, 41);
    const prev = C.addDays(first, -1).slice(0, 7);
    const next = C.addDays(first, 32).slice(0, 7);
    const day = C.isDate(req.query.day) ? req.query.day : (today.startsWith(month) ? today : first);
    const [tasks, acts, legacy, suppliers, names, reqRows] = await Promise.all([
      db.list('crm_tasks', { filters: { due_date: ['gte', gridStart] }, order: 'due_date.asc' }),
      db.list('supplier_activities', { filters: { activity_date: ['gte', gridStart] }, order: 'activity_date.asc' }),
      db.list('supplier_activities', { filters: { done: false, follow_up_date: ['gte', gridStart] } }),
      db.list('suppliers', { select: 'id,name', order: 'name.asc' }),
      C.supplierNames(db),
      db.list('info_requests', { select: 'id,ref' }),
    ]);
    const reqByRef = Object.fromEntries(reqRows.map((r) => [r.ref, r.id]));
    const entries = []; // {date, time, kind: 'open'|'done'|'log', ...}
    for (const x of tasks) if (x.due_date <= gridEnd) entries.push({ date: x.due_date, time: x.due_time, state: x.done ? 'done' : 'open', raw: { kind: 'task', ...x }, label: x.title, type: x.type, supplier_id: x.supplier_id });
    for (const a of legacy) if (a.follow_up_date <= gridEnd) entries.push({ date: a.follow_up_date, state: 'open', raw: { kind: 'act', id: a.id, supplier_id: a.supplier_id, title: a.summary, type: 'Follow-up', due_date: a.follow_up_date, due_time: null }, label: a.summary, type: 'Follow-up', supplier_id: a.supplier_id });
    for (const a of acts) if (a.activity_date <= gridEnd && !(a.summary || '').startsWith('Done: ')) entries.push({ date: a.activity_date, state: 'log', label: a.summary, type: a.type, supplier_id: a.supplier_id });
    const byDate = new Map();
    for (const e of entries) (byDate.get(e.date) || byDate.set(e.date, []).get(e.date)).push(e);
    for (const l of byDate.values()) l.sort((a, b) => `${a.time || '99'}`.localeCompare(`${b.time || '99'}`));

    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date = C.addDays(gridStart, w * 7 + d);
        const list = byDate.get(date) || [];
        const chips = list.slice(0, 3).map((e) => html`<a class="chip ${tyClass(e.type)} ${e.state}" href="/admin/crm/calendar?m=${month}&day=${date}#day" title="${e.type}: ${e.label}${names[e.supplier_id] ? ' — ' + names[e.supplier_id] : ''}">${e.time ? e.time + ' ' : ''}${e.label}${names[e.supplier_id] ? ' · ' + names[e.supplier_id] : ''}</a>`);
        cells.push(html`<td class="${date.slice(0, 7) !== month ? 'out' : ''} ${date === today ? 'today' : ''} ${date === day ? 'sel' : ''}">
          <a class="dnum" href="/admin/crm/calendar?m=${month}&day=${date}">${Number(date.slice(8))}</a>${chips}${list.length > 3 ? html`<a class="more" href="/admin/crm/calendar?m=${month}&day=${date}">+${list.length - 3} more</a>` : ''}</td>`);
      }
      weeks.push(html`<tr>${cells}</tr>`);
    }
    const monthLabel = new Date(first + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const dayList = byDate.get(day) || [];
    const back = `/admin/crm/calendar?m=${month}&day=${day}`;
    res.html(page({
      title: 'CRM calendar', nav: adminNav('crm'), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><h1>CRM</h1>${tabs('cal')}</div>
      <div class="cal-nav"><a class="btn small ghost" href="/admin/crm/calendar?m=${prev}">←</a><b>${monthLabel}</b><a class="btn small ghost" href="/admin/crm/calendar?m=${next}">→</a><a class="btn small ghost" href="/admin/crm/calendar">Today</a>
        <span class="legend">${C.TASK_TYPES.map((x) => html`<span class="chip ${tyClass(x)}">${x}</span>`)}<span class="chip log">Logged activity</span></span></div>
      <div class="table-wrap"><table class="cal"><thead><tr>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => html`<th>${d}</th>`)}</tr></thead><tbody>${weeks}</tbody></table></div>
      <section class="card" id="day"><h2>${C.dayName(day)}</h2>
        ${dayList.length ? html`<ul class="tasks">${dayList.map((e) => e.raw ? itemRow(e.raw, { names, today, back }) : html`<li class="task log"><div class="t-main"><span class="tag ${tyClass(e.type)}">${e.type}</span> <span class="muted">logged</span><div>${e.label}</div>
          <div class="sub">${e.supplier_id ? html`<a href="/admin/suppliers/${e.supplier_id}">${names[e.supplier_id]}</a>` : 'General'}${(() => { const ref = (String(e.label).match(/\bLB-\d{3,7}\b/) || [])[0]; return ref && reqByRef[ref] ? html` · <a href="/admin/requests/${reqByRef[ref]}">Open request ${ref}</a>` : ''; })()}</div></div></li>`)}</ul>` : html`<p class="muted">Nothing on this day.</p>`}
        ${dayList.some((e) => e.state === 'done') ? html`<p class="muted small">Completed tasks are shown struck through in the calendar.</p>` : ''}
        <h3>Schedule something on this day</h3>${taskForm({ suppliers, date: day, back })}</section>`,
    }));
  }));

  // ── Task actions ────────────────────────────────────────────
  router.post('/admin/crm/tasks', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const back = safeBack(f.back, '/admin/crm');
    const title = String(f.title || '').trim();
    if (!title) { flash(res, 'error', 'Please say what needs to happen'); return res.redirect(back); }
    let supplier_id = null;
    if (f.supplier_id) { const s = await db.get('suppliers', f.supplier_id); if (!s) { flash(res, 'error', 'Supplier not found'); return res.redirect(back); } supplier_id = s.id; }
    const remind = Number(f.remind_minutes);
    await db.insert('crm_tasks', {
      supplier_id, title: title.slice(0, 300), notes: String(f.notes || '').trim().slice(0, 2000) || null,
      product_id: f.product_id || null, request_id: f.request_id || null,
      type: C.TASK_TYPES.includes(f.type) ? f.type : 'Follow-up',
      due_date: C.isDate(f.due_date) ? f.due_date : C.localNow().date,
      due_time: C.isTime(f.due_time) ? f.due_time : null,
      remind_minutes: REMIND.some(([v]) => v === remind) ? remind : 15,
    });
    flash(res, 'ok', 'Added');
    res.redirect(back);
  }));
  const withTask = (fn) => G(async (req, res) => {
    const x = await db.get('crm_tasks', req.params.id);
    if (!x) throw new HttpError(404, 'Task not found');
    const { fields } = await parseForm(req);
    await fn(x, fields, req, res);
    res.redirect(safeBack(fields.back, '/admin/crm'));
  });
  router.post('/admin/crm/tasks/:id/done', withTask(async (x) => { await C.completeTask(db, x.id); }));
  router.post('/admin/crm/tasks/:id/snooze', withTask(async (x, f) => { await C.snoozeTask(db, x.id, [1, 3, 7].includes(Number(f.days)) ? Number(f.days) : 1); }));
  router.post('/admin/crm/tasks/:id/edit', withTask(async (x, f) => {
    const patch = {};
    if (String(f.title || '').trim()) patch.title = String(f.title).trim().slice(0, 300);
    if (C.isDate(f.due_date)) patch.due_date = f.due_date;
    patch.due_time = C.isTime(f.due_time) ? f.due_time : null;
    if (patch.due_date !== x.due_date || patch.due_time !== x.due_time) patch.reminded_at = null;
    await db.update('crm_tasks', { id: x.id }, patch);
  }));
  router.post('/admin/crm/tasks/:id/delete', withTask(async (x) => { await db.remove('crm_tasks', { id: x.id }); }));

  // ── Telegram setup (admin) ──────────────────────────────────
  router.post('/admin/crm/telegram/connect', G(async (req, res) => {
    if (!tg.enabled()) { flash(res, 'error', 'Set TELEGRAM_BOT_TOKEN first'); return res.redirect('/admin/crm#reminders'); }
    if (!config.publicUrl.startsWith('https://')) { flash(res, 'error', 'Telegram needs a public https address (set PUBLIC_URL)'); return res.redirect('/admin/crm#reminders'); }
    try {
      await tg.setWebhook(`${config.publicUrl}/hooks/telegram`, tg.webhookSecret(config));
      botName = (await tg.getMe()).username;
    } catch (e) { flash(res, 'error', `Telegram said: ${e.message}`); return res.redirect('/admin/crm#reminders'); }
    await db.update('settings', { id: 1 }, { telegram_pair_code: crypto.randomBytes(5).toString('hex') });
    res.redirect('/admin/crm#reminders');
  }));
  router.post('/admin/crm/telegram/test', G(async (req, res) => {
    const st = await C.settingsRow(db);
    try { await tg.sendMessage(st.telegram_chat_id, '✅ Test from Lulyboo CRM. Reminders are working.'); flash(res, 'ok', 'Test message sent'); } catch (e) { flash(res, 'error', e.message); }
    res.redirect('/admin/crm#reminders');
  }));
  router.post('/admin/crm/telegram/disconnect', G(async (req, res) => {
    await db.update('settings', { id: 1 }, { telegram_chat_id: null, telegram_pair_code: null });
    try { await tg.deleteWebhook(); } catch { /* ignore */ }
    flash(res, 'ok', 'Telegram disconnected');
    res.redirect('/admin/crm#reminders');
  }));

  // ── Telegram bot webhook ────────────────────────────────────
  router.post('/hooks/telegram', async (req, res) => {
    if (!tg.enabled() || !tg.safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', tg.webhookSecret(config))) return res.json({ error: 'not found' }, 404);
    let u; try { u = JSON.parse((await readBody(req, 1_000_000)).toString('utf8')); } catch { return res.json({ error: 'bad json' }, 400); }
    try { await handleUpdate(u); } catch (e) { console.error('Telegram update failed:', e.message); }
    res.json({ ok: true });
  });

  async function handleUpdate(u) {
    const st = await C.settingsRow(db);
    const reply = (chat, text, o) => tg.sendMessage(chat, text, o).catch((e) => console.error('Telegram send failed:', e.message));

    if (u.callback_query) {
      const q = u.callback_query; const chat = q.message?.chat?.id;
      if (!st?.telegram_chat_id || String(chat) !== String(st.telegram_chat_id)) return;
      const m = /^(d|s1|s7):([0-9a-f-]{36})$/.exec(q.data || '');
      if (!m) return tg.answerCallback(q.id);
      const task = await db.get('crm_tasks', m[2]);
      if (!task) return tg.answerCallback(q.id, 'Task not found');
      let note;
      if (m[1] === 'd') { await C.completeTask(db, task.id); note = '✅ Done'; }
      else { const r = await C.snoozeTask(db, task.id, m[1] === 's1' ? 1 : 7); note = `💤 Moved to ${r.due_date}`; }
      await tg.answerCallback(q.id, note);
      await tg.editMessage(chat, q.message.message_id, `${q.message.text ? tg.escapeHtml(q.message.text) : ''}\n\n${note}`);
      return;
    }

    const msg = u.message; if (!msg?.text) return;
    const chat = msg.chat.id; const text = msg.text.trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
    if (start) {
      const code = start[1] || '';
      if (st?.telegram_pair_code && code && tg.safeEqual(code, st.telegram_pair_code)) {
        await db.update('settings', { id: 1 }, { telegram_chat_id: String(chat), telegram_pair_code: null });
        return reply(chat, '✅ <b>Connected.</b> You will get a summary each morning and a ping before timed items.\n\nCommands: /today · /overdue · /week');
      }
      if (st?.telegram_chat_id && String(chat) === String(st.telegram_chat_id)) return reply(chat, 'Already connected. Try /today.');
      return reply(chat, 'This bot is private.');
    }
    if (!st?.telegram_chat_id || String(chat) !== String(st.telegram_chat_id)) return; // ignore strangers
    const today = C.localNow().date;
    const items = await C.openItems(db); const names = await C.supplierNames(db);
    const show = (title, list) => reply(chat, list.length ? `<b>${title} (${list.length})</b>\n${list.slice(0, 25).map((i) => `${C.line(i, names)}${i.due_date !== today ? ' · ' + i.due_date : ''}`).join('\n')}` : `${title}: nothing ✅`);
    if (/^\/today/i.test(text)) return show('Today', items.filter((i) => i.due_date === today));
    if (/^\/overdue/i.test(text)) return show('Overdue', items.filter((i) => i.due_date < today));
    if (/^\/week/i.test(text)) return show('Next 7 days', items.filter((i) => i.due_date >= today && i.due_date <= C.addDays(today, 7)));
    return reply(chat, 'Commands: /today · /overdue · /week');
  }
};
