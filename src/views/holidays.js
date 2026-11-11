'use strict';
// Supplier holiday form + popup, shared by the CRM calendar (Lulyboo) and the supplier portal (bilingual).

const { html, raw, t } = require('../lib/html');
const H = require('../holidays');
const picker = (...a) => require('../routes/samples').supplierPicker(...a); // searchable supplier popup (shared)

/** Before / after date for each stage, with the source words AI read it from. */
function stageTable(h = {}) {
  return html`<div class="hol-stages" role="group" aria-label="Holiday dates">
    <div class="hol-st-h"><span>${t('Stage', '阶段')}</span><span>${t('Before the holiday', '节前')}</span><span>${t('After the holiday', '节后')}</span></div>
    ${H.STAGES.map((s) => html`<div class="hol-st" data-stage="${s.key}">
      <div class="hol-st-n"><b>${s.ic} ${t(s.en, s.zh)}</b><small>${t(s.hintEn, s.hintZh)}</small></div>
      <label><span class="sr-only">${s.en} — ${['factory', 'office'].includes(s.key) ? 'from' : 'before'}</span><input type="date" name="${s.a}" value="${h[s.a] || ''}" data-hf="${s.a}"><em class="hol-q" data-q="${s.a}"></em></label>
      <label><span class="sr-only">${s.en} — ${['factory', 'office'].includes(s.key) ? 'to' : 'after'}</span><input type="date" name="${s.b}" value="${h[s.b] || ''}" data-hf="${s.b}"><em class="hol-q" data-q="${s.b}"></em></label>
    </div>`)}
  </div>`;
}

/**
 * Popup: (1) drop a screenshot / PDF or paste the email → AI reads it, or enter by hand; (2) check every date and save.
 * suppliers: list for Lulyboo (select); null in the supplier portal (own company).
 */
function holidayDialog({ action, readUrl, suppliers = null, deleteBase = '', back = '', remind = false }) {
  return html`<dialog class="rp-modal hol-dlg" data-hol-dlg data-read="${readUrl}" data-delete-base="${deleteBase}" aria-labelledby="hol-dlg-t">
    <div class="rp-top"><h2 id="hol-dlg-t" data-hol-title>${t('Add holiday schedule', '添加假期安排')}</h2><button type="button" class="icon-btn" data-hol-close aria-label="Close">×</button></div>
    <div class="hol-step" data-hol-step="read">
      ${suppliers ? html`<div class="hol-sup0">${picker(suppliers, '', { name: '', required: false, placeholder: 'AI finds it from the notice, or choose…', attrs: 'data-hol-sup0' })}</div>` : ''}
      <div class="hol-in" data-hol-drop>
        <input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.eml,.html" hidden data-hol-file>
        <textarea rows="6" data-hol-text aria-label="Holiday notice" placeholder="${'Paste the email text or a screenshot (⌘V / Ctrl+V), or drop a file here — PNG, JPG, PDF or email file'}"></textarea>
        <div class="hol-in-bar">
          <span class="hol-in-ic" aria-hidden="true">✦</span>
          <span class="hol-in-hint" data-hol-hint>${t('AI reads the order cut-off, shipping cut-off, factory and office closing dates. You check them before saving.', 'AI 会识别下单截止、出货截止、工厂和办公室放假日期，保存前请核对。')}</span>
          <span class="hol-att" data-hol-att hidden><span data-hol-attname></span><button type="button" class="icon-btn" data-hol-attx aria-label="Remove file">×</button></span>
          <button type="button" class="btn ghost small" data-hol-choose>${t('Choose file', '选择文件')}</button>
        </div>
        <div class="hol-in-over" aria-hidden="true">${t('Drop the file here', '将文件拖到这里')}</div>
      </div>
      <div class="hol-read-row"><label class="hol-sent">${t('Sent on', '发送日期')} <input type="date" data-hol-sent></label><button type="button" class="btn" data-hol-read>${t('Read with AI', 'AI 识别')}</button><button type="button" class="link" data-hol-manual>${t('Enter dates by hand', '手动填写')}</button></div>
      <p class="hol-status" data-hol-status role="status" aria-live="polite"></p>
    </div>
    <form class="hol-step" data-hol-step="form" method="post" action="${action}" hidden>
      <input type="hidden" name="id" data-hf="id"><input type="hidden" name="file_token" data-hf="file_token"><input type="hidden" name="back" value="${back}">
      <div class="hol-pick" data-hol-pickwrap hidden><label>${t('Holiday found in the file', '文件中的假期')} <select data-hol-pick></select></label></div>
      <div class="hol-row2">
        ${suppliers ? picker(suppliers, '', { attrs: 'data-hf="supplier_id"' }) : ''}
        <label>${t('Holiday', '假期名称')}<input name="name" data-hf="name" placeholder="Chinese New Year 2027" required></label>
      </div>
      ${stageTable()}
      <label class="hol-notes">${t('Notes', '备注')}<input name="notes" data-hf="notes" placeholder="${'e.g. Production very busy in December'}"></label>
      ${remind ? html`<label class="cp-chk hol-remind"><input type="checkbox" name="remind" value="1" checked> ${'Remind me 7 days before each order cut-off (CRM follow-up)'}</label>` : ''}
      <p class="hol-src sub" data-hol-src></p>
      <div class="rp-actions"><button class="btn">${t('Save', '保存')}</button><button type="button" class="btn ghost" data-hol-close>${t('Cancel', '取消')}</button>
        <button type="button" class="btn ghost danger-text hol-del" data-hol-delete hidden>${t('Delete', '删除')}</button></div>
    </form>
  </dialog>`;
}

/** Data attribute payload for editing an existing holiday. */
const editData = (h) => JSON.stringify({ id: h.id, supplier_id: h.supplier_id, name: h.name, notes: h.notes || '', ...Object.fromEntries(H.DATE_FIELDS.map((k) => [k, h[k] || ''])), file: h.file_name || '' });

const CRM_STATUSES = ['Active', 'Quoting', 'Contacted', 'Prospect', 'On hold', 'Blocked'];

/** Lulyboo: choose who gets the "confirm your holidays" email (default: Active suppliers who have not confirmed), check the draft, send. */
function remindDialog({ year, suppliers, users = [], back = '' }) {
  const mails = {};
  for (const s of suppliers) mails[s.id] = new Set([s.email].filter(Boolean).map((e) => e.toLowerCase()));
  for (const u of users) if (u.status !== 'disabled' && u.email && mails[u.supplier_id]) mails[u.supplier_id].add(u.email.toLowerCase());
  const st = (s) => (CRM_STATUSES.includes(s.crm_status) ? s.crm_status : 'No status');
  const groups = [...CRM_STATUSES, 'No status'].map((g) => ({ g, n: suppliers.filter((s) => st(s) === g).length })).filter((x) => x.n);
  const confirmed = (s) => Number(s.holidays_confirmed_year) === year;
  const d = H.reminderDraft(year);
  return html`<dialog class="rp-modal hol-dlg rem-dlg" data-rem-dlg aria-labelledby="rem-t">
    <div class="rp-top"><h2 id="rem-t">Email holiday reminder · ${year}</h2><button type="button" class="icon-btn" data-rem-close aria-label="Close">×</button></div>
    <form method="post" action="/admin/crm/holidays/remind" class="hol-step rem-form" data-rem-form>
      <input type="hidden" name="year" value="${year}"><input type="hidden" name="back" value="${back}">
      <h3 class="rem-h">1 · Send to</h3>
      <div class="up-bar rem-groups">${groups.map(({ g, n }) => html`<button type="button" class="cf ${g === 'Active' ? 'on' : ''}" data-rem-group="${g}" aria-pressed="${g === 'Active' ? 'true' : 'false'}">${g} <small>${n}</small></button>`)}</div>
      <div class="rem-tools"><label class="cp-chk"><input type="checkbox" data-rem-skip checked> Skip suppliers who already confirmed ${year}</label><input type="search" placeholder="Search suppliers" data-rem-q autocomplete="off"></div>
      <ul class="rem-list" data-rem-list>${suppliers.map((s) => { const em = [...mails[s.id]]; return html`<li data-status="${st(s)}" data-confirmed="${confirmed(s) ? '1' : ''}" data-name="${String(s.name).toLowerCase()} ${em.join(' ')}">
        <label><input type="checkbox" name="ids" value="${s.id}" ${em.length ? '' : raw('disabled')} data-rem-cb><span class="rem-n"><b>${s.name}</b><small>${em.length ? em.join(', ') : 'No email on file'}</small></span>
        <span class="rem-tags">${confirmed(s) ? html`<span class="pill s-complete">Confirmed</span>` : ''}<span class="pill">${st(s)}</span></span></label></li>`; })}</ul>
      <p class="sub rem-none" data-rem-none hidden>No suppliers in the selected groups.</p>
      <label class="hol-notes">Other email addresses <input name="extra" placeholder="name@factory.com, another@supplier.cn" data-rem-extra></label>
      <h3 class="rem-h">2 · Check the email</h3>
      <label class="hol-notes">Subject <input name="subject" value="${d.subject}" required maxlength="200"></label>
      <div class="rem-msg"><label class="hol-notes">English <textarea name="en" rows="9" required>${d.en}</textarea></label>
        <label class="hol-notes">中文 <textarea name="zh" rows="9" required>${d.zh}</textarea></label></div>
      <p class="sub">Each supplier's email starts with "Hello {company name}," and ends with a button <b>Open holiday schedule</b> that opens their Holidays page in the portal. Lulyboo owners are copied.</p>
      <div class="rp-actions"><button class="btn" data-rem-send>Send</button><button type="button" class="btn ghost" data-rem-close>Cancel</button><span class="sub" data-rem-count></span></div>
    </form>
  </dialog>`;
}

module.exports = { stageTable, holidayDialog, editData, remindDialog };
