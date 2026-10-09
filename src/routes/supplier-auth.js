'use strict';
// Supplier sign-up and sign-in:
//   /s/<invite-token>  → send 6-digit code to the invited email → enter code
//   /register          → company registration + create password  → /portal
//   /login, /forgot, /reset, /logout
const crypto = require('node:crypto');
const { html, raw, t, m } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page } = require('../views/layout');
const { SUPPLIER_FIELDS, cleanSupplier } = require('../fields');
const A = require('../auth');
const { sendEmail, inviteEmail, emailConfigured } = require('../email');

const INVITE_DAYS = 14;
const REG_REQUIRED = ['name', 'phone', 'address', 'country'];
// Contact person = the registering user; company email = their login email (editable later on the Company page).
const REG_SKIP = ['contact_name', 'email'];

/** Creates (or refreshes) an invite for a user. Returns { link }. Sends the email when asked. */
async function createInvite(db, config, user, { send = false, companyName } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  await db.update('supplier_users', { id: user.id }, {
    invite_token_hash: A.sha256(token),
    invite_expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString(),
  });
  const link = `${config.publicUrl}/s/${token}`;
  let emailed = false;
  if (send && emailConfigured()) { await sendEmail(config, { to: user.email, ...inviteEmail({ link, companyName, days: INVITE_DAYS }) }); emailed = true; }
  return { link, emailed };
}

const box = (title, body) => html`<section class="card narrow auth"><h1>${title}</h1>${body}</section>`;
const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

module.exports = function supplierAuthRoutes(router, { db, config }) {
  async function inviteUser(token) {
    if (!token || token.length < 20) return null;
    const rows = await db.list('supplier_users', { filters: { invite_token_hash: A.sha256(token) }, limit: 1 });
    const u = rows[0];
    if (!u || !u.invite_expires_at || new Date(u.invite_expires_at).getTime() < Date.now()) return null;
    return u;
  }
  const invalidInvite = (req) => page({
    title: 'Invitation', req, body: box(t('Invitation not valid', '邀请链接无效'), html`
      <p>${t('This invitation link has expired or was replaced. Ask your Lulyboo contact for a new one.', '该邀请链接已过期或已失效，请联系 Lulyboo 获取新的链接。')}</p>
      <p>${t('Already registered?', '已注册？')} <a href="/login">${t('Sign in', '登录')}</a></p>`),
  });
  const devNote = (r) => (r.devCode && config.showDevCodes ? ` [dev mode: code ${r.devCode}]` : '');

  // ── Invite landing: send + enter code
  router.get('/s/:token', async (req, res) => {
    const u = await inviteUser(req.params.token);
    if (!u) return res.html(invalidInvite(req), 404);
    if (u.status === 'active') return res.redirect('/login');
    if (u.status === 'disabled') return res.html(invalidInvite(req), 404);
    const base = `/s/${req.params.token}`;
    const sent = req.query.sent === '1';
    res.html(page({
      title: 'Verify email', req, flash: takeFlash(req, res),
      body: box(t('Welcome to Lulyboo', '欢迎加入 Lulyboo'), html`
        <p>${t('To register, first confirm your email address.', '注册前请先验证您的邮箱。')}</p>
        <p class="email-chip">${A.maskEmail(u.email)}</p>
        ${sent ? html`
          <form method="post" action="${base}/verify" class="stack">
            <label><span class="lbl">${t('6-digit code from the email', '邮件中的 6 位验证码')}</span>
              <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus class="code-input"></label>
            <button class="btn">${t('Continue', '继续')}</button>
          </form>
          <form method="post" action="${base}/send-code" class="inline"><button class="link">${t('Send a new code', '重新发送验证码')}</button></form>
          <p class="muted small">${t("Can't find it? Check your spam/junk folder.", '收不到？请检查垃圾邮件。')}</p>`
        : html`<form method="post" action="${base}/send-code"><button class="btn">${t('Email me a code', '发送验证码')}</button></form>`}`),
    }));
  });

  router.post('/s/:token/send-code', async (req, res) => {
    const u = await inviteUser(req.params.token);
    if (!u || u.status !== 'invited') return res.html(invalidInvite(req), 404);
    A.limit(`send:${ip(req)}`, 15, 15 * 60_000);
    const r = await A.issueCode(db, config, u, 'invite');
    flash(res, 'ok', m(`Code sent to ${A.maskEmail(u.email)}`, `验证码已发送至 ${A.maskEmail(u.email)}`) + devNote(r));
    res.redirect(`/s/${req.params.token}?sent=1`);
  });

  router.post('/s/:token/verify', async (req, res) => {
    const u = await inviteUser(req.params.token);
    if (!u || u.status !== 'invited') return res.html(invalidInvite(req), 404);
    A.limit(`verify:${ip(req)}`, 30, 15 * 60_000);
    const { fields } = await parseForm(req);
    const r = await A.checkCode(db, config, u, 'invite', fields.code);
    if (!r.ok) { flash(res, 'error', A.codeError(r)); return res.redirect(`/s/${req.params.token}?sent=1`); }
    A.setStepCookie(res, config, 'lb_reg', u.id, 30);
    res.redirect('/register');
  });

  // ── Registration
  async function regUser(req) {
    const id = A.readStepCookie(req, config, 'lb_reg');
    const u = id && await db.get('supplier_users', id);
    if (!u || u.status !== 'invited') throw new HttpError(403, m('Your verification has expired. Open your invitation link again.', '验证已过期，请重新打开邀请链接。'));
    return u;
  }
  function regForm(u, s, values = {}) {
    const joining = !!s.registered_at;
    const v = (k) => {
      if (values[k] !== undefined) return values[k];
      if (k === 'name' && /^Pending: /.test(s.name || '')) return '';
      return s[k] ?? (k === 'email' ? u.email : '');
    };
    return html`<section class="card narrow wide-form auth">
      <h1>${joining ? t(`Join ${s.name}`, `加入 ${s.name}`) : t('Company registration', '公司注册')}</h1>
      <p class="muted">${t('Login email:', '登录邮箱：')} <b>${u.email}</b></p>
      <form method="post" action="/register">
        ${joining ? html`<input type="hidden" name="joining" value="1">` : html`
        <h2>${t('Company details', '公司信息')}</h2>
        <div class="grid two">${SUPPLIER_FIELDS.filter((f) => !REG_SKIP.includes(f.key)).sort((a, b) => (a.type === 'textarea') - (b.type === 'textarea')).map((f) => {
          const req = REG_REQUIRED.includes(f.key);
          return html`<label class="${f.type === 'textarea' ? 'span2' : ''}"><span class="lbl">${t(f.en, f.cn)}${req ? html`<b class="req">*</b>` : ''}</span>
            ${f.type === 'textarea' ? html`<textarea name="${f.key}" rows="2" ${req ? raw('required') : ''}>${v(f.key)}</textarea>`
              : html`<input name="${f.key}" value="${v(f.key)}" ${req ? raw('required') : ''} ${f.type === 'url' ? raw('inputmode="url" autocapitalize="off" spellcheck="false" placeholder="www.example.com"') : ''}>`}</label>`;
        })}</div>`}
        <h2>${t('Your account', '您的账号')}</h2>
        <div class="grid two">
          <label><span class="lbl">${t('Your name', '您的姓名')}<b class="req">*</b></span><input name="user_name" value="${values.user_name ?? u.name ?? ''}" required autocomplete="name"></label>
          <label><span class="lbl">${t('Login email', '登录邮箱')}</span><input value="${u.email}" readonly autocomplete="username"></label>
          <label><span class="lbl">${t(`Password (min. ${A.MIN_PASSWORD} characters)`, `密码（至少 ${A.MIN_PASSWORD} 位）`)}<b class="req">*</b></span><input type="password" name="password" minlength="${A.MIN_PASSWORD}" required autocomplete="new-password"></label>
          <label><span class="lbl">${t('Confirm password', '确认密码')}<b class="req">*</b></span><input type="password" name="password2" minlength="${A.MIN_PASSWORD}" required autocomplete="new-password"></label>
        </div>
        <div class="form-actions"><button class="btn">${joining ? t('Create account', '创建账号') : t('Create company', '创建公司')}</button></div>
      </form></section>`;
  }

  router.get('/register', async (req, res) => {
    const u = await regUser(req);
    const s = await db.get('suppliers', u.supplier_id);
    res.html(page({ title: 'Registration', req, flash: takeFlash(req, res), body: regForm(u, s) }));
  });

  router.post('/register', async (req, res) => {
    const u = await regUser(req);
    const s = await db.get('suppliers', u.supplier_id);
    const { fields } = await parseForm(req);
    const errors = [];
    let row = null;
    if (!s.registered_at) {
      const c = cleanSupplier(fields);
      row = c.row;
      errors.push(...c.errors.filter((e) => !/required/.test(e)));
      for (const k of REG_REQUIRED) if (!row[k]) { const f = SUPPLIER_FIELDS.find((x) => x.key === k); errors.push(m(`${f.en} is required`, `请填写${f.cn}`)); }
    }
    const userName = String(fields.user_name || '').trim().slice(0, 200);
    if (!userName) errors.push(m('Your name is required', '请填写您的姓名'));
    const pwErr = A.passwordProblem(fields.password, fields.password2);
    if (pwErr) errors.push(pwErr);
    if (errors.length) return res.html(page({ title: 'Registration', req, flash: { type: 'error', msg: errors.join(' · ') }, body: regForm(u, s, fields) }), 422);

    if (row) await db.update('suppliers', { id: s.id }, { ...row, contact_name: userName, email: s.email || u.email, registered_at: new Date().toISOString() });
    const now = new Date().toISOString();
    const [updated] = await db.update('supplier_users', { id: u.id }, {
      name: userName, password_hash: await A.hashPassword(fields.password), status: 'active',
      invite_token_hash: null, invite_expires_at: null, last_login_at: now,
    });
    await db.update('auth_codes', { user_id: u.id, used: false }, { used: true });
    res.setCookie('lb_reg', '', { maxAge: 0 });
    A.startSession(res, config, updated);
    flash(res, 'ok', m('Registration complete. Welcome!', '注册成功，欢迎！'));
    res.redirect('/portal');
  });

  // ── Sign in
  router.get('/login', async (req, res) => {
    const cur = await A.currentSupplierUser(db, config, req);
    if (cur) return res.redirect('/portal');
    res.html(page({
      title: 'Sign in', req, flash: takeFlash(req, res),
      body: box(t('Supplier sign in', '供应商登录'), html`
        <form method="post" action="/login" class="stack">
          <label><span class="lbl">${t('Email', '邮箱')}</span><input type="email" name="email" value="${req.query.email || ''}" required autocomplete="username" autofocus></label>
          <label><span class="lbl">${t('Password', '密码')}</span><input type="password" name="password" required autocomplete="current-password"></label>
          <button class="btn">${t('Sign in', '登录')}</button>
        </form>
        <p><a href="/forgot">${t('Forgot password?', '忘记密码？')}</a></p>
        <p class="muted small">${t('New supplier? Register with the invitation link from Lulyboo.', '新供应商请使用 Lulyboo 发送的邀请链接注册。')}</p>`),
    }));
  });

  router.post('/login', async (req, res) => {
    const { fields } = await parseForm(req);
    const email = A.normEmail(fields.email);
    A.limit(`login-ip:${ip(req)}`, 30, 15 * 60_000);
    A.limit(`login-email:${email}`, 10, 15 * 60_000);
    const rows = await db.list('supplier_users', { filters: { email }, limit: 1 });
    const u = rows[0];
    const ok = u && u.status === 'active' && await A.verifyPassword(fields.password, u.password_hash);
    if (!ok) {
      if (!u) await A.hashPassword('timing-equaliser');
      flash(res, 'error', u && u.status === 'invited'
        ? m('Please finish registration using your invitation link first.', '请先通过邀请链接完成注册。')
        : m('Wrong email or password', '邮箱或密码错误'));
      return res.redirect(`/login?email=${encodeURIComponent(email)}`);
    }
    const s = await db.get('suppliers', u.supplier_id);
    if (!s || !s.active) { flash(res, 'error', m('This supplier account is turned off. Contact Lulyboo.', '该供应商账号已停用，请联系 Lulyboo。')); return res.redirect('/login'); }
    A.resetLimit(`login-email:${email}`);
    await db.update('supplier_users', { id: u.id }, { last_login_at: new Date().toISOString() });
    A.startSession(res, config, u);
    res.redirect('/portal');
  });

  router.get('/logout', async (req, res) => { A.endSession(res); flash(res, 'ok', m('Signed out', '已退出登录')); res.redirect('/login'); });

  // ── Forgot / reset password (email code)
  router.get('/forgot', async (req, res) => {
    res.html(page({
      title: 'Forgot password', req, flash: takeFlash(req, res),
      body: box(t('Reset password', '重置密码'), html`
        <p>${t("Enter your login email. We'll send you a 6-digit code.", '请输入登录邮箱，我们将发送 6 位验证码。')}</p>
        <form method="post" action="/forgot" class="stack">
          <label><span class="lbl">${t('Email', '邮箱')}</span><input type="email" name="email" required autocomplete="username" autofocus></label>
          <button class="btn">${t('Send code', '发送验证码')}</button>
        </form><p><a href="/login">${t('Back to sign in', '返回登录')}</a></p>`),
    }));
  });

  router.post('/forgot', async (req, res) => {
    const { fields } = await parseForm(req);
    const email = A.normEmail(fields.email);
    A.limit(`forgot-ip:${ip(req)}`, 10, 15 * 60_000);
    if (!emailConfigured() && process.env.EMAIL_DEV_LOG !== 'true') {
      throw new HttpError(503, m('Email is not set up on this portal yet. Please contact Lulyboo to reset your password.', '平台邮件功能尚未开通，请联系 Lulyboo 重置密码。'));
    }
    const rows = await db.list('supplier_users', { filters: { email }, limit: 1 });
    const u = rows[0];
    let note = '';
    if (u && u.status === 'active') {
      try { const r = await A.issueCode(db, config, u, 'reset'); note = devNote(r); } catch (e) { if (e.status !== 429) throw e; }
      A.setStepCookie(res, config, 'lb_rst', u.id, 20);
    } else {
      A.setStepCookie(res, config, 'lb_rst', 'none', 20); // same response either way
    }
    flash(res, 'ok', m(`If ${email} has an account, a code is on its way.`, `如果 ${email} 已注册，验证码已发送。`) + note);
    res.redirect('/reset');
  });

  router.get('/reset', async (req, res) => {
    if (!A.readStepCookie(req, config, 'lb_rst')) return res.redirect('/forgot');
    res.html(page({
      title: 'New password', req, flash: takeFlash(req, res),
      body: box(t('Choose a new password', '设置新密码'), html`
        <form method="post" action="/reset" class="stack">
          <label><span class="lbl">${t('6-digit code from the email', '邮件中的 6 位验证码')}</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required class="code-input"></label>
          <label><span class="lbl">${t(`New password (min. ${A.MIN_PASSWORD} characters)`, `新密码（至少 ${A.MIN_PASSWORD} 位）`)}</span><input type="password" name="password" minlength="${A.MIN_PASSWORD}" required autocomplete="new-password"></label>
          <label><span class="lbl">${t('Confirm password', '确认密码')}</span><input type="password" name="password2" minlength="${A.MIN_PASSWORD}" required autocomplete="new-password"></label>
          <button class="btn">${t('Save and sign in', '保存并登录')}</button>
        </form><p><a href="/forgot">${t('Send a new code', '重新发送验证码')}</a></p>`),
    }));
  });

  router.post('/reset', async (req, res) => {
    const id = A.readStepCookie(req, config, 'lb_rst');
    if (!id) return res.redirect('/forgot');
    A.limit(`reset-ip:${ip(req)}`, 20, 15 * 60_000);
    const { fields } = await parseForm(req);
    const pwErr = A.passwordProblem(fields.password, fields.password2);
    if (pwErr) { flash(res, 'error', pwErr); return res.redirect('/reset'); }
    const u = id !== 'none' ? await db.get('supplier_users', id) : null;
    const r = u && u.status === 'active' ? await A.checkCode(db, config, u, 'reset', fields.code) : { ok: false, reason: 'wrong' };
    if (!r.ok) { flash(res, 'error', A.codeError(r)); return res.redirect('/reset'); }
    const [updated] = await db.update('supplier_users', { id: u.id }, {
      password_hash: await A.hashPassword(fields.password), session_version: (u.session_version || 1) + 1, last_login_at: new Date().toISOString(),
    });
    res.setCookie('lb_rst', '', { maxAge: 0 });
    A.startSession(res, config, updated);
    flash(res, 'ok', m('Password changed', '密码已修改'));
    res.redirect('/portal');
  });
};

module.exports.createInvite = createInvite;
module.exports.INVITE_DAYS = INVITE_DAYS;
