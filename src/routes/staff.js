'use strict';
// Admin users & roles: Users page, invite / reset links, My profile, Audit log.
const crypto = require('node:crypto');
const { html, raw, fmt } = require('../lib/html');
const { HttpError, parseForm, flash, takeFlash } = require('../lib/http');
const { page, adminNav } = require('../views/layout');
const A = require('../auth');
const ST = require('../staff');
const { sendEmail, staffInviteEmail, emailConfigured } = require('../email');
const { guard } = require('./admin');

const INVITE_DAYS = 7;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const TABLE_HELP = 'The staff tables are missing. Run the staff SQL from supabase/schema.sql in the Supabase SQL editor, then reload.';

module.exports = function staffRoutes(router, { db, config }) {
  const G = (fn) => guard(config, fn);
  const roleOptions = (sel) => Object.entries(ST.ROLES).map(([k, v]) => html`<option value="${k}" ${k === sel ? raw('selected') : ''}>${v}</option>`);
  const all = async () => { try { return await db.list('staff_users', { order: 'created_at.asc' }); } catch { throw new HttpError(500, TABLE_HELP); } };
  const activeAdmins = (users) => users.filter((u) => u.role === 'admin' && u.status === 'active');

  async function issueLink(user, { send, reset }) {
    const token = crypto.randomBytes(24).toString('base64url');
    await db.update('staff_users', { id: user.id }, { invite_hash: A.sha256(token), invite_expires: new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString() });
    const link = `${config.publicUrl}/admin/invite/${token}`;
    let emailed = false;
    if (send && emailConfigured()) { await sendEmail(config, { to: user.email, ...staffInviteEmail({ link, name: user.name, reset }) }); emailed = true; }
    return { link, emailed };
  }
  const linkNote = ({ link, emailed }, email) => emailed ? `Link emailed to ${email}.` : `Email is not set up here. Send this link to the user yourself (valid ${INVITE_DAYS} days): ${link}`;

  // ── Users (Admin only; enforced by the permission check in guard)
  const rolePill = (r) => html`<span class="role-pill r-${r}">${ST.ROLES[r] || r}</span>`;
  router.get('/admin/users', G(async (req, res) => {
    const users = await all();
    res.html(page({
      title: 'Users', nav: adminNav(''), flash: takeFlash(req, res), wide: true,
      body: html`<div class="head-row"><div><h1>Users &amp; roles</h1><p class="muted">Everyone who can sign in to the admin. The owner password (set in Railway) always works as a backup.</p></div></div>
      <section class="card"><h2>Team</h2>
        ${users.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
        ${users.map((u) => html`<tr><td><b>${u.name}</b></td><td>${u.username}</td><td>${u.email}</td><td>${rolePill(u.role)}</td>
          <td><span class="pill s-${u.status === 'active' ? 'complete' : u.status === 'invited' ? 'sent' : 'closed'}">${u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Deactivated'}</span></td>
          <td>${u.last_login ? fmt.date(u.last_login) : '—'}</td><td><a class="btn ghost small nowrap" href="/admin/users/${u.id}">Edit</a></td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No staff accounts yet. Add yourself first (role Admin), then your team.</p>`}
      </section>
      <section class="card"><h2>Add a user</h2>
        <form method="post" action="/admin/users" class="grid">
          <label><span class="lbl">Full name</span><input name="name" required></label>
          <label><span class="lbl">Username</span><input name="username" required autocapitalize="off" pattern="[A-Za-z0-9._\\-]{3,30}" title="3-30 letters, numbers, . _ -"></label>
          <label><span class="lbl">Email</span><input type="email" name="email" required></label>
          <label><span class="lbl">Role</span><select name="role">${roleOptions('manager')}</select></label>
          <label class="span2"><span class="lbl">Temporary password (optional)</span><input type="text" name="password" autocomplete="off" placeholder="Leave empty to email an invitation link instead"><small class="muted">With a temporary password the user must change it at first login.</small></label>
          <div class="span2"><button class="btn small">Add user</button></div>
        </form>
        <h3>What each role can do</h3>
        <ul class="plain small"><li>${rolePill('admin')} everything, including users, settings and deleting</li>
        <li>${rolePill('director')} everything except users, settings and deleting; can read the audit log</li>
        <li>${rolePill('manager')} day-to-day work; pricing and logistics are view-only; no deleting (archive instead)</li></ul>
      </section>`,
    }));
  }));

  router.post('/admin/users', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const users = await all();
    const name = String(fields.name || '').trim().slice(0, 120);
    const username = String(fields.username || '').trim().toLowerCase();
    const email = A.normEmail(fields.email);
    const role = ST.ROLES[fields.role] ? fields.role : 'manager';
    const back = (type, msg) => { flash(res, type, msg); return res.redirect('/admin/users'); };
    if (!name) return back('error', 'Enter a name');
    if (!USERNAME_RE.test(username) || username === 'owner') return back('error', 'Username: 3-30 letters, numbers, dot, dash or underscore');
    if (!A.validEmail(email)) return back('error', 'Enter a valid email address');
    if (users.some((u) => u.username === username || String(u.email).toLowerCase() === email)) return back('error', 'That username or email is already used');
    const temp = String(fields.password || '');
    if (temp) { const bad = A.passwordProblem(temp); if (bad) return back('error', String(bad).replace(/⟪(.*?)⟫⟦.*?⟧/, '$1')); }
    const row = { name, username, email, role, status: temp ? 'active' : 'invited', must_change: !!temp, password_hash: temp ? await A.hashPassword(temp) : null, created_by: req.staff.name };
    const u = await db.insert('staff_users', row);
    await ST.audit(config, 'Added user', `${username} (${ST.ROLES[role]})`);
    if (temp) return back('ok', `${name} added with a temporary password. They must change it at first login.`);
    return back('ok', `${name} added. ${linkNote(await issueLink(u, { send: true }), email)}`);
  }));

  router.get('/admin/users/:id', G(async (req, res) => {
    const u = await db.get('staff_users', req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    res.html(page({
      title: u.name, nav: adminNav(''), flash: takeFlash(req, res),
      body: html`<p><a href="/admin/users">← Users</a></p><h1>${u.name} ${rolePill(u.role)}</h1>
      <div class="cols"><section class="card"><h2>Details</h2>
        <form method="post" action="/admin/users/${u.id}" class="grid">
          <label><span class="lbl">Full name</span><input name="name" value="${u.name}" required></label>
          <label><span class="lbl">Username</span><input name="username" value="${u.username}" required autocapitalize="off"></label>
          <label><span class="lbl">Email</span><input type="email" name="email" value="${u.email}" required></label>
          <label><span class="lbl">Role</span><select name="role">${roleOptions(u.role)}</select></label>
          <div class="span2"><button class="btn small">Save</button></div></form></section>
      <section class="card"><h2>Access</h2>
        <p class="muted">Status: <b>${u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited (has not set a password yet)' : 'Deactivated'}</b>${u.last_login ? ` · last login ${fmt.date(u.last_login)}` : ''}</p>
        <form method="post" action="/admin/users/${u.id}/link" class="inline-form"><button class="btn ghost small">${u.status === 'invited' ? 'Send invitation again' : 'Send password reset link'}</button></form>
        <form method="post" action="/admin/users/${u.id}/toggle" class="inline-form"><button class="btn ${u.status === 'disabled' ? '' : 'danger-btn'} small">${u.status === 'disabled' ? 'Reactivate' : 'Deactivate'}</button></form>
        <p class="muted small">Deactivated users are signed out immediately. Accounts are never deleted, so the audit log keeps its history.</p>
      </section></div>`,
    }));
  }));

  router.post('/admin/users/:id', G(async (req, res) => {
    const { fields } = await parseForm(req);
    const users = await all();
    const u = users.find((x) => x.id === req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const back = (type, msg) => { flash(res, type, msg); return res.redirect(`/admin/users/${u.id}`); };
    const name = String(fields.name || '').trim().slice(0, 120);
    const username = String(fields.username || '').trim().toLowerCase();
    const email = A.normEmail(fields.email);
    const role = ST.ROLES[fields.role] ? fields.role : u.role;
    if (!name || !USERNAME_RE.test(username) || username === 'owner' || !A.validEmail(email)) return back('error', 'Check the name, username and email');
    if (users.some((x) => x.id !== u.id && (x.username === username || String(x.email).toLowerCase() === email))) return back('error', 'That username or email is already used');
    if (u.role === 'admin' && role !== 'admin' && u.status === 'active' && activeAdmins(users).length < 2) return back('error', 'This is the last active Admin. Make someone else an Admin first.');
    const roleChanged = role !== u.role;
    await db.update('staff_users', { id: u.id }, { name, username, email, role, session_version: roleChanged ? (u.session_version || 1) + 1 : u.session_version });
    await ST.audit(config, roleChanged ? 'Changed role' : 'Edited user', `${username}${roleChanged ? `: ${ST.ROLES[u.role]} → ${ST.ROLES[role]}` : ''}`);
    return back('ok', 'Saved');
  }));

  router.post('/admin/users/:id/toggle', G(async (req, res) => {
    const users = await all();
    const u = users.find((x) => x.id === req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const back = (type, msg) => { flash(res, type, msg); return res.redirect(`/admin/users/${u.id}`); };
    if (u.status !== 'disabled') {
      if (u.id === req.staff.id) return back('error', 'You cannot deactivate yourself.');
      if (u.role === 'admin' && u.status === 'active' && activeAdmins(users).length < 2) return back('error', 'This is the last active Admin.');
      await db.update('staff_users', { id: u.id }, { status: 'disabled', session_version: (u.session_version || 1) + 1 });
      await ST.audit(config, 'Deactivated user', u.username);
      return back('ok', 'Deactivated and signed out');
    }
    await db.update('staff_users', { id: u.id }, { status: u.password_hash ? 'active' : 'invited' });
    await ST.audit(config, 'Reactivated user', u.username);
    return back('ok', 'Reactivated');
  }));

  router.post('/admin/users/:id/link', G(async (req, res) => {
    const u = await db.get('staff_users', req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const out = await issueLink(u, { send: true, reset: u.status !== 'invited' });
    await ST.audit(config, u.status === 'invited' ? 'Sent invitation' : 'Sent password reset link', u.username);
    flash(res, 'ok', linkNote(out, u.email));
    res.redirect(`/admin/users/${u.id}`);
  }));

  // ── Invitation / reset page (public; the token is the proof)
  const findByToken = async (token) => {
    const h = A.sha256(token || '');
    let users = []; try { users = await db.list('staff_users'); } catch { /* none */ }
    return users.find((u) => u.invite_hash && u.invite_hash === h && new Date(u.invite_expires) > new Date() && u.status !== 'disabled') || null;
  };
  router.get('/admin/invite/:token', async (req, res) => {
    const u = await findByToken(req.params.token);
    if (!u) return res.html(page({ title: 'Link expired', admin: true, body: html`<section class="card narrow"><h1>This link has expired</h1><p>Ask an Admin to send you a new one, or use <a href="/admin/forgot">Forgot password</a>.</p></section>` }), 410);
    res.html(page({
      title: 'Set password', admin: true, flash: takeFlash(req, res),
      body: html`<section class="card narrow"><h1>Welcome, ${u.name}</h1><p class="muted">Username: <b>${u.username}</b> · Role: <b>${ST.ROLES[u.role]}</b></p>
      <form method="post" action="/admin/invite/${req.params.token}">
        <label><span class="lbl">New password (at least ${A.MIN_PASSWORD} characters)</span><input type="password" name="password" autocomplete="new-password" required autofocus></label>
        <label><span class="lbl">Repeat password</span><input type="password" name="confirm" autocomplete="new-password" required></label>
        <div class="form-actions"><button class="btn">Save and sign in</button></div></form></section>`,
    }));
  });
  router.post('/admin/invite/:token', async (req, res) => {
    A.limit('staff-invite:' + (req.socket.remoteAddress || 'x'), 20, 15 * 60_000);
    const u = await findByToken(req.params.token);
    if (!u) return res.redirect(`/admin/invite/${req.params.token}`);
    const { fields } = await parseForm(req);
    const bad = A.passwordProblem(fields.password, fields.confirm);
    if (bad) { flash(res, 'error', String(bad).replace(/⟪(.*?)⟫⟦.*?⟧/, '$1')); return res.redirect(`/admin/invite/${req.params.token}`); }
    const upd = { password_hash: await A.hashPassword(fields.password), status: 'active', must_change: false, invite_hash: null, invite_expires: null, session_version: (u.session_version || 1) + 1, last_login: new Date().toISOString() };
    await db.update('staff_users', { id: u.id }, upd);
    ST.startSession(res, config, { ...u, ...upd });
    await ST.audit(config, 'Set password', '', u);
    res.redirect('/admin');
  });

  // ── Forgot password (always the same answer, so it cannot be used to find accounts)
  router.get('/admin/forgot', async (req, res) => res.html(page({
    title: 'Forgot password', admin: true, flash: takeFlash(req, res),
    body: html`<section class="card narrow"><h1>Forgot password</h1><p class="muted">Enter your email. If it belongs to a team account, we send a link to choose a new password.</p>
    <form method="post" action="/admin/forgot"><label><span class="lbl">Email</span><input type="email" name="email" required autofocus></label>
    <div class="form-actions"><button class="btn">Send link</button> <a class="muted small" href="/admin/login">Back to login</a></div></form></section>`,
  })));
  router.post('/admin/forgot', async (req, res) => {
    A.limit('staff-forgot:' + (req.socket.remoteAddress || 'x'), 5, 60 * 60_000);
    const { fields } = await parseForm(req);
    const email = A.normEmail(fields.email);
    try {
      const u = (await db.list('staff_users')).find((x) => String(x.email).toLowerCase() === email && x.status !== 'disabled');
      if (u) { await issueLink(u, { send: true, reset: u.status !== 'invited' }); await ST.audit(config, 'Requested password reset', u.username, u); }
    } catch (e) { console.error('Staff forgot failed:', e.message); }
    flash(res, 'ok', 'If that email belongs to a team account, a link is on its way.');
    res.redirect('/admin/forgot');
  });

  // ── My profile
  router.get('/admin/profile', G(async (req, res) => {
    const u = req.staff;
    res.html(page({
      title: 'My profile', nav: adminNav(''), flash: takeFlash(req, res),
      body: html`<h1>My profile ${rolePill(u.role)}</h1>
      ${u.must_change ? html`<p class="alert">Please choose your own password before you continue.</p>` : ''}
      ${u.owner ? html`<section class="card narrow"><p>You are signed in with the owner password. It is set by <code>ADMIN_PASSWORD</code> in Railway. Add yourself on the <a href="/admin/users">Users</a> page to get a personal login.</p></section>` : html`
      <div class="cols"><section class="card"><h2>Details</h2>
        <form method="post" action="/admin/profile" class="grid">
          <label><span class="lbl">Full name</span><input name="name" value="${u.name}" required></label>
          <label><span class="lbl">Email</span><input type="email" name="email" value="${u.email}" required></label>
          <p class="muted small span2">Username: <b>${u.username}</b> (ask an Admin to change it)</p>
          <div class="span2"><button class="btn small">Save</button></div></form></section>
      <section class="card"><h2>Change password</h2>
        <form method="post" action="/admin/profile/password" class="grid">
          ${u.must_change ? '' : html`<label class="span2"><span class="lbl">Current password</span><input type="password" name="current" autocomplete="current-password" required></label>`}
          <label class="span2"><span class="lbl">New password (at least ${A.MIN_PASSWORD} characters)</span><input type="password" name="password" autocomplete="new-password" required></label>
          <label class="span2"><span class="lbl">Repeat new password</span><input type="password" name="confirm" autocomplete="new-password" required></label>
          <div class="span2"><button class="btn small">Change password</button></div></form></section></div>`}`,
    }));
  }));
  router.post('/admin/profile', G(async (req, res) => {
    if (req.staff.owner) return res.redirect('/admin/profile');
    const { fields } = await parseForm(req);
    const name = String(fields.name || '').trim().slice(0, 120); const email = A.normEmail(fields.email);
    const users = await all();
    if (!name || !A.validEmail(email)) flash(res, 'error', 'Check your name and email');
    else if (users.some((x) => x.id !== req.staff.id && String(x.email).toLowerCase() === email)) flash(res, 'error', 'That email is already used');
    else { await db.update('staff_users', { id: req.staff.id }, { name, email }); flash(res, 'ok', 'Saved'); }
    res.redirect('/admin/profile');
  }));
  router.post('/admin/profile/password', G(async (req, res) => {
    if (req.staff.owner) return res.redirect('/admin/profile');
    A.limit('staff-pw:' + req.staff.id, 10, 15 * 60_000);
    const { fields } = await parseForm(req);
    const u = req.staff;
    const back = (type, msg) => { flash(res, type, msg); return res.redirect('/admin/profile'); };
    if (!u.must_change && !(await A.verifyPassword(fields.current, u.password_hash))) return back('error', 'Current password is wrong');
    const bad = A.passwordProblem(fields.password, fields.confirm);
    if (bad) return back('error', String(bad).replace(/⟪(.*?)⟫⟦.*?⟧/, '$1'));
    const upd = { password_hash: await A.hashPassword(fields.password), must_change: false, session_version: (u.session_version || 1) + 1 };
    await db.update('staff_users', { id: u.id }, upd);
    ST.startSession(res, config, { ...u, ...upd }); // keep this browser signed in; other sessions end
    await ST.audit(config, 'Changed password', '');
    return back('ok', 'Password changed');
  }));

  // ── Audit log (Admin and Director)
  router.get('/admin/audit', G(async (req, res) => {
    let rows = []; let missing = false;
    try { rows = await db.list('staff_audit', { order: 'created_at.desc', limit: 300 }); } catch { missing = true; }
    res.html(page({
      title: 'Audit log', nav: adminNav(''), wide: true,
      body: html`<h1>Audit log</h1><p class="muted">Sign-ins, user changes and every change made in the admin. Latest 300.</p>
      ${missing ? html`<p class="alert">${TABLE_HELP}</p>` : ''}
      <section class="card">${rows.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr><td>${fmt.date(r.created_at)} ${String(r.created_at || '').slice(11, 16)}</td><td>${r.staff_name || '—'}</td><td>${r.action}</td><td class="sub">${r.detail || ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing recorded yet.</p>`}</section>`,
    }));
  }));
};
