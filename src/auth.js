'use strict';
// Supplier accounts: passwords (scrypt), one-time email codes, sessions, rate limits.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { sign, unsign, HttpError } = require('./lib/http');
const { sendEmail, codeEmail } = require('./email');

const scrypt = promisify(crypto.scrypt);
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_WAIT_SEC = 60;
const CODES_PER_HOUR = 5;
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

// ── Passwords ─────────────────────────────────────────────────
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return crypto.timingSafeEqual(got, expected);
}
function passwordProblem(pw, confirm) {
  if (!pw || String(pw).length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters · 密码至少 ${MIN_PASSWORD} 位`;
  if (String(pw).length > 200) return 'Password is too long';
  if (confirm !== undefined && pw !== confirm) return 'Passwords do not match · 两次输入的密码不一致';
  return null;
}

// ── Rate limiting (in memory, per process) ────────────────────
const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, t: now };
  if (now - b.t > windowMs) { b.n = 0; b.t = now; }
  b.n++;
  buckets.set(key, b);
  if (b.n > max) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again. 尝试次数过多，请 15 分钟后再试。');
}
function resetLimit(key) { buckets.delete(key); }

// ── Email codes ───────────────────────────────────────────────
const codeHash = (userId, code, secret) => sha256(`${secret}:${userId}:${code}`);

async function issueCode(db, config, user, purpose) {
  const recent = await db.list('auth_codes', { filters: { user_id: user.id, purpose, created_at: ['gt', new Date(Date.now() - 3600_000).toISOString()] }, order: 'created_at.desc' });
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESEND_WAIT_SEC * 1000) {
    throw new HttpError(429, `Please wait a minute before requesting another code. 请稍等一分钟后再获取验证码。`);
  }
  if (recent.length >= CODES_PER_HOUR) throw new HttpError(429, 'Too many codes requested. Try again in an hour. 获取验证码次数过多，请一小时后再试。');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.update('auth_codes', { user_id: user.id, purpose, used: false }, { used: true }); // invalidate older codes
  await db.insert('auth_codes', {
    user_id: user.id, purpose, code_hash: codeHash(user.id, code, config.sessionSecret),
    expires_at: new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString(),
  });
  const mail = codeEmail({ code, purpose, minutes: CODE_TTL_MIN });
  const sent = await sendEmail(config, { to: user.email, ...mail });
  return { devCode: sent.dev ? code : null };
}

/** Returns true when the code is right. Counts failed attempts. */
async function checkCode(db, config, user, purpose, code) {
  code = String(code || '').replace(/\D/g, '');
  const rows = await db.list('auth_codes', { filters: { user_id: user.id, purpose, used: false }, order: 'created_at.desc', limit: 1 });
  const c = rows[0];
  if (!c || new Date(c.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (c.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  const a = Buffer.from(codeHash(user.id, code, config.sessionSecret)); const b = Buffer.from(c.code_hash);
  if (code.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await db.update('auth_codes', { id: c.id }, { attempts: c.attempts + 1 });
    return { ok: false, reason: c.attempts + 1 >= CODE_MAX_ATTEMPTS ? 'locked' : 'wrong' };
  }
  await db.update('auth_codes', { id: c.id }, { used: true });
  return { ok: true };
}
const codeError = (r) => ({
  expired: 'The code has expired. Request a new one. 验证码已过期，请重新获取。',
  locked: 'Too many wrong codes. Request a new one. 错误次数过多，请重新获取验证码。',
  wrong: 'Wrong code. Check the email and try again. 验证码错误，请检查邮件后重试。',
}[r.reason]);

// ── Short-lived signed cookies (registration / reset steps) ───
function setStepCookie(res, config, name, userId, minutes) {
  res.setCookie(name, sign(`${userId}.${Date.now() + minutes * 60_000}`, config.sessionSecret), { maxAge: minutes * 60 });
}
function readStepCookie(req, config, name) {
  const v = unsign(req.cookies[name], config.sessionSecret);
  if (!v) return null;
  const [id, exp] = v.split('.');
  return Number(exp) > Date.now() ? id : null;
}

// ── Sessions ──────────────────────────────────────────────────
function startSession(res, config, user) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  res.setCookie('lb_sup', sign(`${user.id}.${user.session_version || 1}.${exp}`, config.sessionSecret), { maxAge: SESSION_DAYS * 86400 });
}
function endSession(res) { res.setCookie('lb_sup', '', { maxAge: 0 }); }

/** Returns { user, supplier } for a valid session, else null. */
async function currentSupplierUser(db, config, req) {
  const v = unsign(req.cookies.lb_sup, config.sessionSecret);
  if (!v) return null;
  const [id, ver, exp] = v.split('.');
  if (!(Number(exp) > Date.now())) return null;
  const user = await db.get('supplier_users', id);
  if (!user || user.status !== 'active' || String(user.session_version) !== ver) return null;
  const supplier = await db.get('suppliers', user.supplier_id);
  if (!supplier || !supplier.active) return null;
  return { user, supplier };
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return e;
  return `${u.slice(0, Math.min(2, u.length))}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

module.exports = {
  sha256, normEmail, validEmail, hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD,
  limit, resetLimit, issueCode, checkCode, codeError, setStepCookie, readStepCookie,
  startSession, endSession, currentSupplierUser, maskEmail, SESSION_DAYS,
};
