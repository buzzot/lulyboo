'use strict';
// Staff accounts for the admin side: roles, permissions, sessions, audit trail.
//   admin    everything, including users, settings and deleting
//   director everything except users, settings and deleting; can read the audit log
//   manager  day-to-day work; pricing and logistics are view-only; cannot delete
//   accountant only the Finance pages (payments to make, documents to check, mark paid, reports)
//   development new products: edits Development (projects) and Samples; reads Suppliers, RFQs and Products.
//              No orders, logistics, pricing, payments, bank details; no deleting.
// The ADMIN_PASSWORD "owner" login always works as an emergency Admin, even before the staff table exists.
const { AsyncLocalStorage } = require('node:async_hooks');
const { sign, unsign } = require('./lib/http');

const ROLES = { admin: 'Admin', director: 'Director', manager: 'Manager', accountant: 'Accountant', development: 'Development' };
const SESSION_DAYS = 14;
const als = new AsyncLocalStorage();
const current = () => als.getStore()?.staff || null;
const runAs = (staff, fn) => als.run({ staff }, fn);

/** What a role may do (used to hide buttons; the server enforces it in `deny`). */
const CAN = {
  admin: { users: true, settings: true, delete: true, audit: true, costs: true, bank: true, orders: true },
  director: { users: false, settings: false, delete: false, audit: true, costs: true, bank: true, orders: true },
  manager: { users: false, settings: false, delete: false, audit: false, costs: false, bank: false, orders: true },
  accountant: { users: false, settings: false, delete: false, audit: false, costs: false, bank: true, orders: false },
  development: { users: false, settings: false, delete: false, audit: false, costs: false, bank: false, orders: false },
};
const can = (role, what) => !!(CAN[role] && CAN[role][what]);
/** Landed cost, margins, wholesale: everyone on the admin side except Development (they see the factory price only). */
const seesLanded = (role) => role !== 'development';

/** Returns a reason string when this role may not make this request, else null. */
function deny(role, method, path) {
  if (role === 'admin') return null;
  if (!CAN[role]) return 'Unknown role';
  const get = method === 'GET' || method === 'HEAD';
  if (role === 'accountant') {
    if (/^\/admin\/(finance|profile|logout)(\/|\.|$)/.test(path)) return null;
    // the documents and slips they verify (read only)
    if (get && (/^\/admin\/logistics\/planning\/files\/[^/]+$/.test(path) || /^\/admin\/orders\/shipping\/fwd\/[^/]+\/files\/\d+$/.test(path))) return null;
    return 'The accountant account can open the Finance pages only.';
  }
  if (role === 'development') {
    if (/^\/admin\/(profile|logout)(\/|\.|$)/.test(path)) return null;
    if (/^\/admin\/(projects|samples|suppliers|products)\/[^/]+\/delete$/.test(path)) return 'Only an Admin can delete. Use Archive instead.';
    // edit: Development (projects) and Samples
    if (/^\/admin\/(projects|dev-files|samples|sample-files|samples-carriers)(\/|\.|$)/.test(path)) return null;
    // read only: Suppliers, RFQs & requests, Products (+ their files, compare, quick jump)
    if (get && /^\/admin(\/(suppliers|requests|request-files|products|archive|categories|compare|documents|quick|activities)(\/|\.|$)|\/?$)/.test(path)) {
      if (/^\/admin\/suppliers\/[^/]+\/bank(\/|\.|$)/.test(path)) return 'Bank details are for Admin, Director and Accountant.';
      return null;
    }
    if (!get && /^\/admin\/(suppliers|requests|products|archive|categories)(\/|\.|$)/.test(path)) return 'The Development role can view suppliers, RFQs and products but not change them — Development projects and Samples can be edited.';
    return 'Not available for the Development role. Orders, logistics, pricing and payments are managed by the operations team — ask an Admin if you need access.';
  }
  if (/^\/admin\/suppliers\/[^/]+\/bank(\/|\.|$)/.test(path) && !can(role, 'bank')) return 'Only an Admin, Director or Accountant can see bank details.';
  if (/^\/admin\/(users|settings|api-log)(\/|$)/.test(path) || /^\/admin\/crm\/telegram\//.test(path)) return 'Only an Admin can open this page.';
  if (/^\/admin\/audit(\/|$)/.test(path)) return can(role, 'audit') ? null : 'Only an Admin or Director can view the audit log.';
  if (/^\/admin\/(suppliers|products|requests|documents|projects|samples)\/[^/]+\/delete$/.test(path)) return 'Only an Admin can delete. Use Archive instead.';
  if (!get && role === 'manager' && (/^\/admin\/(pricing|logistics)(\/|$)/.test(path) && !/^\/admin\/logistics\/(schedules|planning|forwarders|freight\/charges\/[^/]+\/explain)(\/|\.|$)/.test(path) || /^\/admin\/products\/[^/]+\/duty\//.test(path))) return 'Managers can view pricing and logistics but not change them.';
  return null;
}

// ── "View as": an Admin sees the portal with another role's menu and limits (testing / troubleshooting).
//    Actions still count as the Admin, recorded as "Name (as Role)". Only a real Admin can switch; it ends on sign-out.
const VIEW_ROLES = ['director', 'manager', 'accountant', 'development'];
function viewAs(config, req, staff) {
  if (!staff || staff.role !== 'admin') return staff;
  const v = unsign(req.cookies.lb_viewas, config.sessionSecret);
  const m = /^viewas:([a-z]+):(.+)$/.exec(v || '');
  if (!m || !VIEW_ROLES.includes(m[1]) || m[2] !== String(staff.id)) return staff;
  return { ...staff, role: m[1], realRole: 'admin', realName: staff.name, viewing: m[1], name: `${staff.name} (as ${ROLES[m[1]]})` };
}
function setViewAs(res, config, staff, role) {
  if (!role) return res.setCookie('lb_viewas', '', { maxAge: 0 });
  res.setCookie('lb_viewas', sign(`viewas:${role}:${staff.id}`, config.sessionSecret), { maxAge: 12 * 3600 });
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
  [/^\/admin\/(finance|orders\/payments)\/[^/]+\/paid$/, 'Marked payment paid'], [/^\/admin\/finance\/[^/]+\/ask$/, 'Asked about a payment'],
  [/^\/admin\/suppliers\/([^/]+)\/bank$/, 'Changed bank details'],
  [/^\/admin\/categories/, 'Changed categories'], [/^\/admin\/documents\/([^/]+)\/delete$/, 'Deleted document'],
];
const NOISY = /\/explain$|^\/admin\/view-as|\/import\/(image|source|ai-describe|cancel)$|\/ai-|^\/admin\/(login|logout|forgot)|^\/admin\/invite\/|^\/admin\/users|^\/admin\/profile|\/ai\//;
function autoLabel(path) {
  if (NOISY.test(path)) return null;
  for (const [re, label] of LABELS) if (re.test(path)) return label;
  return 'POST ' + path;
}

module.exports = { seesLanded, VIEW_ROLES, viewAs, setViewAs, ROLES, CAN, can, deny, current, runAs, currentStaff, startSession, startOwnerSession, audit, autoLabel, OWNER, SESSION_DAYS };
