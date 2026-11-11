'use strict';
// Supplier holidays: read / save / delete for Lulyboo (CRM calendar) and for suppliers (portal → Holidays),
// supplier confirmation of the coming year's schedule, and reminder emails asking suppliers to confirm.

const crypto = require('node:crypto');
const { html, raw, t, m } = require('../lib/html');
const { parseForm, flash, takeFlash, HttpError } = require('../lib/http');
const { page } = require('../views/layout');
const { icon } = require('../views/icons');
const { guard } = require('./admin');
const { currentSupplierUser } = require('../auth');
const H = require('../holidays');
const HV = require('../views/holidays');
const AI = require('../ai');

const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain', '.eml': 'message/rfc822', '.html': 'text/html' };
const TOKEN_RE = /^holidays\/tmp\/[0-9a-f-]{36}\.[a-z0-9]+$/;
const missing = (e) => /supplier_holidays|holidays_confirmed|PGRST20[45]|relation/i.test(e?.message || '');
const fmtD = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const range = (a, b) => (a ? (b && b !== a ? `${fmtD(a)} – ${fmtD(b)}` : fmtD(a)) : '');

module.exports = function holidayRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const S = (fn) => async (req, res) => {
    const cur = await currentSupplierUser(db, config, req);
    if (!cur) return res.redirect('/login');
    req.supplier = cur.supplier; req.user = cur.user; req.base = '/portal';
    req.navBadges = await require('../samples').supplierBadges(db, cur.supplier.id);
    return fn(req, res);
  };
  const now = () => new Date().toISOString();

  /** Read a notice with AI; the file is kept (temporarily) so it can be attached when the holiday is saved. */
  async function read(req, res, { suppliers = null } = {}) {
    if (!AI.enabled()) return res.json({ ok: false, error: m('AI is not set up. Enter the dates by hand.', 'AI 暂不可用，请手动填写日期。') }, 400);
    const { fields: f, files } = await parseForm(req, { limitBytes: config.maxUploadBytes || 25 * 1024 * 1024 });
    const file = files.file && (Array.isArray(files.file) ? files.file[0] : files.file);
    const text = String(f.text || '').trim();
    if (!file?.buffer?.length && !text) return res.json({ ok: false, error: m('Choose a file or paste the email text', '请选择文件或粘贴邮件内容') }, 400);
    let r;
    try { r = await H.readHolidays({ file, text, emailDate: H.isDate(f.sent) ? f.sent : '' }); }
    catch (e) { return res.json({ ok: false, error: /Use a screenshot/.test(e.message) ? m('Use a screenshot (PNG/JPG), PDF or the email text', '请使用截图（PNG/JPG）、PDF 或邮件文字') : m(`AI could not read it: ${String(e.message).slice(0, 120)}`, 'AI 无法识别，请手动填写') }, 400); }
    if (!r.holidays.length) return res.json({ ok: false, error: m('No holiday dates found. Enter them by hand.', '未找到假期日期，请手动填写。') }, 400);
    let token = null; let fileName = null;
    if (file?.buffer?.length) {
      const ext = (String(file.name || '').toLowerCase().match(/\.[a-z0-9]+$/) || ['.bin'])[0];
      token = `holidays/tmp/${crypto.randomUUID()}${ext}`; fileName = String(file.name || `notice${ext}`).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 150);
      try { await db.docs.upload(token, file.buffer, MIME[ext] || 'application/octet-stream'); } catch { token = null; }
    }
    const sup = suppliers ? H.matchSupplier(r.supplierName, suppliers) : null;
    res.json({ ok: true, holidays: r.holidays, supplierName: r.supplierName, supplierId: sup?.id || '', fileToken: token ? `${token}|${fileName}` : '' });
  }

  /** Insert or update one holiday from the form. */
  async function save({ f, supplierId, source, by, remind }) {
    const row = H.clean(f);
    const [tok, fname] = String(f.file_token || '').split('|');
    if (tok && TOKEN_RE.test(tok)) Object.assign(row, { file_path: tok, file_name: fname || 'notice', file_mime: MIME[(tok.match(/\.[a-z0-9]+$/) || [''])[0]] || null });
    let h;
    if (f.id) {
      const old = await db.get('supplier_holidays', f.id).catch(() => null);
      if (!old || old.supplier_id !== supplierId) throw new HttpError(404, m('Holiday not found', '未找到该假期'));
      await db.update('supplier_holidays', { id: old.id }, { ...row, updated_at: now() });
      h = { ...old, ...row };
    } else {
      h = await db.insert('supplier_holidays', { ...row, supplier_id: supplierId, source, created_by: by, created_at: now(), updated_at: now(), reminder_task_ids: [] });
    }
    if (remind !== undefined) {
      const sup = await db.get('suppliers', supplierId).catch(() => null);
      const ids = remind ? await H.syncReminders(db, h, sup?.name) : (await H.syncReminders(db, { ...h, order_cutoff: null, order_cutoff_after: null }, '')) && [];
      await db.update('supplier_holidays', { id: h.id }, { reminder_task_ids: ids }).catch(() => null);
    }
    return h;
  }
  async function remove(h) {
    await H.syncReminders(db, { ...h, order_cutoff: null, order_cutoff_after: null }, '').catch(() => null);
    if (h.file_path) await db.docs.remove([h.file_path]).catch(() => null);
    await db.remove('supplier_holidays', { id: h.id });
  }
  async function sendFile(res, h) {
    if (!h?.file_path) throw new HttpError(404, 'File not found');
    const buf = await db.docs.download(h.file_path);
    res.writeHead(200, { 'Content-Type': h.file_mime || 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': `${/^(image\/|application\/pdf)/.test(h.file_mime || '') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(h.file_name || 'notice')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }
  const backTo = (v, dflt) => (/^\/admin\/crm(\/|$|\?)/.test(String(v || '')) ? String(v) : dflt);
  const log = (supplierId, summary) => db.insert('supplier_activities', { supplier_id: supplierId, type: 'Note', summary: summary.slice(0, 5000), activity_date: now().slice(0, 10) }).catch(() => null);

  // ── Lulyboo (CRM calendar) ──────────────────────────────────────────────
  router.post('/admin/crm/holidays/read', G(async (req, res) => read(req, res, { suppliers: await db.list('suppliers', { select: 'id,name' }) })));

  router.post('/admin/crm/holidays', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const back = backTo(f.back, '/admin/crm/calendar');
    const sup = f.supplier_id ? await db.get('suppliers', f.supplier_id).catch(() => null) : null;
    if (!sup) { flash(res, 'error', 'Choose the supplier'); return res.redirect(back); }
    try {
      const h = await save({ f, supplierId: sup.id, source: 'lulyboo', by: req.staff?.name || 'Lulyboo', remind: f.remind === '1' });
      flash(res, 'ok', `Saved ${h.name} for ${sup.name}`);
      const first = h.factory_from || h.order_cutoff || h.last_ship;
      return res.redirect(first && !/[?&]m=/.test(back) ? `/admin/crm/calendar?m=${first.slice(0, 7)}` : back);
    } catch (e) {
      if (missing(e)) { flash(res, 'error', 'Run the supplier holidays SQL in Supabase first.'); return res.redirect(back); }
      if (e instanceof HttpError || /at least one date/.test(e.message)) { flash(res, 'error', e.message); return res.redirect(back); }
      throw e;
    }
  }));

  router.post('/admin/crm/holidays/:id/delete', G(async (req, res) => {
    const { fields: f } = await parseForm(req).catch(() => ({ fields: {} }));
    const h = await db.get('supplier_holidays', req.params.id).catch(() => null);
    if (h) await remove(h);
    flash(res, 'ok', 'Holiday deleted');
    res.redirect(backTo(f.back, '/admin/crm/calendar'));
  }));

  router.get('/admin/crm/holidays/:id/file', G(async (req, res) => sendFile(res, await db.get('supplier_holidays', req.params.id).catch(() => null))));

  /** Email the holiday reminder (draft checked in the popup) to the chosen suppliers and any extra addresses. */
  router.post('/admin/crm/holidays/remind', G(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const year = Number(f.year) || H.targetYear();
    const back = backTo(f.back, '/admin/crm/calendar');
    const P = require('../projects');
    const { sendEmail, noticeEmail, emailConfigured } = require('../email');
    const def = H.reminderDraft(year);
    const subject = String(f.subject || def.subject).trim().slice(0, 200) || def.subject;
    const en = String(f.en || def.en).trim().slice(0, 5000); const zh = String(f.zh || def.zh).trim().slice(0, 5000);
    const ids = [].concat(f.ids || []).filter(Boolean);
    const extra = [...new Set(String(f.extra || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const badExtra = extra.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (badExtra.length) { flash(res, 'error', `Check these email addresses: ${badExtra.join(', ')}`); return res.redirect(back); }
    if (!ids.length && !extra.length) { flash(res, 'error', 'Choose at least one supplier or enter an email address'); return res.redirect(back); }
    if (!emailConfigured() && process.env.EMAIL_DEV_LOG !== 'true') { flash(res, 'error', 'Email is not set up (RESEND_API_KEY)'); return res.redirect(back); }
    const link = `${config.publicUrl}/portal/holidays?year=${year}`;
    const title = [`Please confirm your ${year} holiday schedule`, `请确认 ${year} 年假期安排`];
    const button = ['Open holiday schedule', '打开假期安排'];
    const all = await db.list('suppliers');
    let sent = 0; const failed = []; const done = new Set();
    for (const s of all.filter((x) => ids.includes(x.id))) {
      const to = await P.supplierRecipients(db, s);
      if (!to.length) { failed.push(`${s.name} (no email)`); continue; }
      try {
        const e = noticeEmail({ title, companyName: s.name, en, zh, button, link });
        await sendEmail(config, { to, subject, text: e.text, html: e.html, cc: P.ownerEmails() });
        to.forEach((x) => done.add(x)); sent++;
        await log(s.id, `Asked to confirm the ${year} holiday schedule (email to ${to.join(', ')}).`);
      } catch (e) { failed.push(`${s.name} (${e.provider?.reason || 'send failed'})`); }
    }
    for (const addr of extra.filter((x) => !done.has(x))) {
      try { const e = noticeEmail({ title, en, zh, button, link }); await sendEmail(config, { to: addr, subject, text: e.text, html: e.html }); sent++; } catch (e) { failed.push(`${addr} (${e.provider?.reason || 'send failed'})`); }
    }
    if (sent) flash(res, failed.length ? 'warn' : 'ok', `Reminder sent to ${sent} recipient${sent === 1 ? '' : 's'}${failed.length ? `. Not sent: ${failed.join('; ')}` : ''}`);
    else flash(res, 'error', `No reminder sent${failed.length ? `: ${failed.join('; ')}` : ''}`);
    res.redirect(back);
  }));

  // ── Supplier portal ─────────────────────────────────────────────────────
  router.get('/portal/holidays', S(async (req, res) => {
    const target = H.targetYear();
    const year = [target - 1, target, target + 1].includes(Number(req.query.year)) ? Number(req.query.year) : target;
    let list = []; let noTable = false;
    try { list = (await db.list('supplier_holidays', { filters: { supplier_id: req.supplier.id }, order: 'factory_from.asc' })).filter((h) => (h.year || H.yearOf(h)) === year); }
    catch (e) { if (missing(e)) noTable = true; else throw e; }
    const confirmed = Number(req.supplier.holidays_confirmed_year) === year;
    const cell = (h, s) => { const a = h[s.a]; const b = h[s.b]; if (!a && !b) return html`<span class="muted">—</span>`; return ['factory', 'office'].includes(s.key) ? range(a, b) : html`${a ? html`<span>${t('Before', '节前')}: <b>${fmtD(a)}</b></span>` : ''}${b ? html`<span>${t('After', '节后')}: <b>${fmtD(b)}</b></span>` : ''}`; };
    res.html(page({
      title: 'Holidays', nav: require('./supplier').nav('holidays'), flash: takeFlash(req, res), req,
      body: html`
      ${noTable ? html`<p class="flash warn">${t('Holidays are not available yet. Please try again later.', '假期功能暂不可用，请稍后再试。')}</p>` : ''}
      <div class="page-heading">
        <div><div class="eyebrow">${t('Production planning', '生产计划')}</div><h1>${t(`Holiday schedule ${year}`, `${year} 年假期安排`)}</h1>
          <p class="muted">${t('Tell Lulyboo when you stop taking orders, stop shipping, and when your factory and office are closed, so we can plan orders and containers around it.', '请告诉 Lulyboo 您的下单截止、出货截止以及工厂和办公室放假时间，方便我们提前安排订单和装柜。')}</p></div>
        <div class="actions"><div class="seg-links">${[target - 1, target, target + 1].map((y) => html`<a href="/portal/holidays?year=${y}" class="${y === year ? 'on' : ''}">${y}</a>`)}</div></div>
      </div>

      <section class="hol-confirm ${confirmed ? 'ok' : ''}">
        ${confirmed
          ? html`<div>${icon('checkCheck', 20)}<div><b>${t(`Your ${year} holiday schedule is confirmed`, `已确认 ${year} 年假期安排`)}</b><small>${t('Thank you. If anything changes, update it here and confirm again.', '谢谢！如有变动，请在此更新并重新确认。')}</small></div></div>`
          : html`<div>${icon('alert', 20)}<div><b>${t(`Please check and confirm your ${year} holiday schedule`, `请核对并确认 ${year} 年假期安排`)}</b><small>${list.length ? t('Check every date below, then confirm.', '请核对以下所有日期，然后确认。') : t('Add your holidays first (upload the notice or enter the dates). If you have no closures this year, you can still confirm.', '请先添加假期（上传通知或手动填写）。如今年没有放假安排，也可以直接确认。')}</small></div></div>
            <form method="post" action="/portal/holidays/confirm"><input type="hidden" name="year" value="${year}"><button class="btn">${icon('check', 16)}${list.length ? t(`Confirm ${year} schedule`, `确认 ${year} 年安排`) : t(`Confirm: no closures in ${year}`, `确认：${year} 年无放假`)}</button></form>`}
      </section>

      <div class="hol-layout">
        <div>
          <section class="card hol-list"><div class="head-row"><h2>${t('Your holidays', '您的假期')} <span class="muted">${list.length}</span></h2>
            <div class="actions"><button type="button" class="btn small" data-hol-open>${icon('upload', 14)}${t('Upload notice', '上传通知')}</button><button type="button" class="btn ghost small" data-hol-open="manual">${icon('plus', 14)}${t('Add by hand', '手动添加')}</button></div></div>
            ${list.length ? list.map((h) => html`<article class="hol-card">
              <div class="hol-card-h"><b>${h.name}</b><span class="sub">${h.source === 'lulyboo' ? t('added by Lulyboo — please check', 'Lulyboo 添加 — 请核对') : t('added by you', '由您添加')}${h.file_name ? html` · <a href="/portal/holidays/${h.id}/file" target="_blank" rel="noopener">${icon('link', 12)}${h.file_name}</a>` : ''}</span>
                <span class="hol-card-a"><button type="button" class="link small" data-hol-edit="${HV.editData(h)}">${t('Edit', '编辑')}</button></span></div>
              <dl class="hol-dl">${H.STAGES.map((s) => html`<div><dt>${s.ic} ${t(s.en, s.zh)}</dt><dd>${cell(h, s)}</dd></div>`)}</dl>
              ${h.notes ? html`<p class="sub">${h.notes}</p>` : ''}
            </article>`) : html`<div class="empty-sm">${t(`No holidays for ${year} yet.`, `暂无 ${year} 年假期。`)}</div>`}
          </section>
        </div>
        <aside class="card hol-help">
          <h2>${t('How to do it', '操作说明')}</h2>
          <ol>
            <li><b>${t('Upload your holiday notice', '上传假期通知')}</b>${t('A screenshot of your email or table, a PDF, or paste the text. AI reads the dates for you.', '可以是邮件或表格截图、PDF，或直接粘贴文字。AI 会自动识别日期。')}</li>
            <li><b>${t('Check the dates', '核对日期')}</b>${t('Correct anything AI got wrong and fill in what is missing. Dates are day / month / year as you type them in the calendar picker.', '修改识别错误的日期并补充缺少的内容。')}</li>
            <li><b>${t('Save, then confirm', '保存并确认')}</b>${t(`When all your ${year} holidays are here, click “Confirm” at the top.`, `所有 ${year} 年假期填写完成后，点击上方“确认”。`)}</li>
          </ol>
          <h3>${t('The four dates', '四类日期')}</h3>
          <ul class="hol-defs">${H.STAGES.map((s) => html`<li><b>${s.ic} ${t(s.en, s.zh)}</b><span>${t(s.hintEn, s.hintZh)}</span></li>`)}</ul>
          <p class="sub">${t('Example: order cut-off Dec 1, last shipment Jan 28, factory closed Jan 29 – Feb 15, first shipment after Mar 20.', '示例：12月1日下单截止，1月28日最后出货，1月29日至2月15日工厂放假，3月20日节后首次出货。')}</p>
        </aside>
      </div>
      ${HV.holidayDialog({ action: '/portal/holidays', readUrl: '/portal/holidays/read', deleteBase: '/portal/holidays' })}`,
    }));
  }));

  router.post('/portal/holidays/read', S(async (req, res) => read(req, res)));

  router.post('/portal/holidays', S(async (req, res) => {
    const { fields: f } = await parseForm(req);
    try {
      const h = await save({ f, supplierId: req.supplier.id, source: 'supplier', by: req.user?.email || req.supplier.name });
      // a change means the year has to be confirmed again
      if (Number(req.supplier.holidays_confirmed_year) === h.year) await db.update('suppliers', { id: req.supplier.id }, { holidays_confirmed_year: null, holidays_confirmed_at: null }).catch(() => null);
      await log(req.supplier.id, `Holiday schedule updated in the portal: ${h.name} (${[h.order_cutoff && `order cut-off ${h.order_cutoff}`, h.last_ship && `last shipment ${h.last_ship}`, h.factory_from && `factory closed ${h.factory_from}–${h.factory_to}`, h.office_from && `office closed ${h.office_from}–${h.office_to}`].filter(Boolean).join(', ')}).`);
      flash(res, 'ok', m('Saved. Please confirm your schedule when it is complete.', '已保存。全部填写完成后请确认。'));
      return res.redirect(`/portal/holidays?year=${h.year || H.targetYear()}`);
    } catch (e) {
      if (/at least one date/.test(e.message)) { flash(res, 'error', m('Enter at least one date', '请至少填写一个日期')); return res.redirect('/portal/holidays'); }
      throw e;
    }
  }));

  router.post('/portal/holidays/:id/delete', S(async (req, res) => {
    const h = await db.get('supplier_holidays', req.params.id).catch(() => null);
    if (!h || h.supplier_id !== req.supplier.id) throw new HttpError(404, m('Holiday not found', '未找到该假期'));
    await remove(h);
    if (Number(req.supplier.holidays_confirmed_year) === h.year) await db.update('suppliers', { id: req.supplier.id }, { holidays_confirmed_year: null, holidays_confirmed_at: null }).catch(() => null);
    await log(req.supplier.id, `Holiday removed in the portal: ${h.name}.`);
    flash(res, 'ok', m('Holiday deleted', '已删除'));
    res.redirect(`/portal/holidays?year=${h.year || H.targetYear()}`);
  }));

  router.post('/portal/holidays/confirm', S(async (req, res) => {
    const { fields: f } = await parseForm(req);
    const year = Number(f.year) || H.targetYear();
    await db.update('suppliers', { id: req.supplier.id }, { holidays_confirmed_year: year, holidays_confirmed_at: now() });
    const n = (await db.list('supplier_holidays', { filters: { supplier_id: req.supplier.id } }).catch(() => [])).filter((h) => (h.year || H.yearOf(h)) === year).length;
    await log(req.supplier.id, `Holiday schedule ${year} confirmed by the supplier (${n ? `${n} holiday${n === 1 ? '' : 's'}` : 'no closures'}).`);
    flash(res, 'ok', m(`Thank you — your ${year} holiday schedule is confirmed.`, `谢谢！已确认 ${year} 年假期安排。`));
    res.redirect(`/portal/holidays?year=${year}`);
  }));

  router.get('/portal/holidays/:id/file', S(async (req, res) => {
    const h = await db.get('supplier_holidays', req.params.id).catch(() => null);
    if (!h || h.supplier_id !== req.supplier.id) throw new HttpError(404, 'File not found');
    return sendFile(res, h);
  }));
};
