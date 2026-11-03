'use strict';
// Staff accounts for the admin side: roles, permissions, sessions, audit trail.
//   admin    everything, including users, settings and deleting
//   director everything except users, settings and deleting; can read the audit log
//   manager  day-to-day work; pricing and logistics are view-only; cannot delete
// The ADMIN_PASSWORD "owner" login always works as an emergency Admin, even before the staff table exists.
const { AsyncLocalStorage } = require('node:async_hooks');
const { sign, unsign } = require('./lib/http');

const ROLES = { admin: 'Admin', director: 'Director', manager: 'Manager' };
const SESSION_DAYS = 14;
const als = new AsyncLocalStorage();
const current = () => als.getStore()?.staff || null;
const runAs = (staff, fn) => als.run({ staff }, fn);

/** What a role may do (used to hide buttons; the server enforces it in `deny`). */
const CAN = {
  admin: { users: true, settings: true, delete: true, audit: true, costs: true },
  director: { users: false, settings: false, delete: false, audit: true, costs: true },
  manager: { users: false, settings: false, delete: false, audit: false, costs: false },
};
const can = (role, what) => !!(CAN[role] && CAN[role][what]);

/** Returns a reason string when this role may not make this request, else null. */
function deny(role, method, path) {
  if (role === 'admin') return null;
  if (!CAN[role]) return 'Unknown role';
  const get = method === 'GET' || method === 'HEAD';
  if (/^\/admin\/(users|settings|api-log)(\/|$)/.test(path) || /^\/admin\/crm\/telegram\//.test(path)) return 'Only an Admin can open this page.';
  if (/^\/admin\/audit(\/|$)/.test(path)) return can(role, 'audit') ? null : 'Only an Admin or Director can view the audit log.';
  if (/^\/admin\/(suppliers|products|requests|documents)\/[^/]+\/delete$/.test(path)) return 'Only an Admin can delete. Use Archive instead.';
  if (!get && role === 'manager' && (/^\/admin\/(pricing|logistics)(\/|$)/.test(path) || /^\/admin\/products\/[^/]+\/duty\//.test(path))) return 'Managers can view pricing and logistics but not change them.';
  return null;
}

function startSession(res, config, user) {
  res.setCookie('lb_admin', sign(`staff:${user.id}:${user.session_version || 1}:${Date.now() + SESSION_DAYS * 86400_000}`, config.sessionSecret), { maxAge: SESSION_DAYS * 86400 });
}
function startOwnerSession(res, config) {
  res.setCookie('lb_admin', sign(`admin:${Date.now() + SESSION_DAYS * 86400_000}`, config.sessionSecret), { maxAge: SESSION_DAYS * 86400 });
}

const OWNER = Object.freeze({ id: 'owner', owner: true, name: 'Owner', username: 'owner', email: '', role: 'admin', status: 'active' });

/** The signed-in staff member for this request, or null. */
async function currentStaff(config, req) {
  const v = unsign(req.cookies.lb_admin, config.sessionSecret);
  if (!v) return null;
  const parts = v.split(':');
  if (parts[0] === 'admin') return Number(parts[1]) > Date.now() ? OWNER : null; // legacy / owner cookie
  if (parts[0] !== 'staff' || !(Number(parts[3]) > Date.now())) return null;
  try {
    const u = await config.db.get('staff_users', parts[1]);
    if (!u || u.status !== 'active' || String(u.session_version || 1) !== parts[2]) return null;
    return u;
  } catch { return null; } // staff table not created yet
}

async function audit(config, action, detail = '', who = current()) {
  try {
    await config.db.insert('staff_audit', { staff_id: who && !who.owner ? who.id : null, staff_name: who ? (who.owner ? 'Owner' : who.name) : null, action: String(action).slice(0, 80), detail: String(detail || '').slice(0, 500) });
  } catch { /* audit is best effort; the table may not exist yet */ }
}

// Friendly names for the actions recorded automatically for every successful POST.
const LABELS = [
  [/^\/admin\/suppliers\/([^/]+)\/delete$/, 'Deleted supplier'], [/^\/admin\/products\/([^/]+)\/delete$/, 'Deleted product'],
  [/^\/admin\/products\/bulk$/, 'Bulk product action'], [/^\/admin\/products\/([^/]+)\/edit$/, 'Edited product'],
  [/^\/admin\/suppliers\/([^/]+)\/import\/confirm$/, 'Imported products'], [/^\/admin\/suppliers\/([^/]+)\/request\/send$/, 'Sent info request'],
  [/^\/admin\/suppliers\/([^/]+)\/approve$/, 'Approved supplier'], [/^\/admin\/suppliers\/([^/]+)\/toggle$/, 'Toggled supplier'],
  [/^\/admin\/suppliers\/([^/]+)\/users$/, 'Invited supplier user'], [/^\/admin\/supplier-users\//, 'Supplier user change'],
  [/^\/admin\/requests\/([^/]+)\/status$/, 'Changed request status'], [/^\/admin\/requests\/([^/]+)\/log$/, 'Added to request log'],
  [/^\/admin\/settings$/, 'Changed settings'], [/^\/admin\/pricing/, 'Changed pricing'], [/^\/admin\/logistics/, 'Changed logistics'],
  [/^\/admin\/categories/, 'Changed categories'], [/^\/admin\/documents\/([^/]+)\/delete$/, 'Deleted document'],
];
const NOISY = /\/import\/(image|source|ai-describe|cancel)$|\/ai-|^\/admin\/(login|logout|forgot)|^\/admin\/invite\/|^\/admin\/users|^\/admin\/profile|\/ai\//;
function autoLabel(path) {
  if (NOISY.test(path)) return null;
  for (const [re, label] of LABELS) if (re.test(path)) return label;
  return 'POST ' + path;
}

module.exports = { ROLES, CAN, can, deny, current, runAs, currentStaff, startSession, startOwnerSession, audit, autoLabel, OWNER, SESSION_DAYS };
