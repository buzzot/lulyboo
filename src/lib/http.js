'use strict';
// Minimal HTTP plumbing on top of node:http — router, body parsing,
// signed cookies, static files. Keeps the app dependency-free apart from sharp.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Raw } = require('./html');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── Router ────────────────────────────────────────────────────
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/$/, '').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handlers: r.handlers, params };
      }
    }
    return null;
  }
}

// ── Body parsing ──────────────────────────────────────────────
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limitBytes) { req.resume(); return reject(new HttpError(413, `Upload too large (max ${Math.round(limitBytes / 1048576)} MB per submission)`)); }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { req.destroy(); reject(new HttpError(413, `Upload too large (max ${Math.round(limitBytes / 1048576)} MB per submission)`)); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Collect repeated keys into arrays (e.g. checkboxes).
function addField(obj, k, v) {
  if (k in obj) obj[k] = [].concat(obj[k], v); else obj[k] = v;
}

/**
 * Parses urlencoded or multipart bodies.
 * Returns { fields: {k: string|string[]}, files: {k: [{name,type,size,buffer}]} }
 */
async function parseForm(req, { limitBytes = 1_000_000 } = {}) {
  const ct = req.headers['content-type'] || '';
  const buf = await readBody(req, limitBytes);
  const fields = {}; const files = {};
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) addField(fields, k, v);
  } else if (ct.startsWith('multipart/form-data')) {
    // Node's built-in (undici) multipart parser.
    const fd = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ct }, body: buf }).formData();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') addField(fields, k, v);
      else if (v && v.size > 0) {
        (files[k] ||= []).push({ name: v.name, type: v.type, size: v.size, buffer: Buffer.from(await v.arrayBuffer()) });
      }
    }
  } else if (buf.length) {
    throw new HttpError(415, 'Unsupported content type');
  }
  return { fields, files };
}

// ── Cookies (HMAC-signed) ─────────────────────────────────────
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sign(value, secret) {
  return value + '.' + crypto.createHmac('sha256', secret).update(value).digest('base64url');
}
function unsign(signed, secret) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value, secret)); const b = Buffer.from(signed);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
}

// ── Response helpers ──────────────────────────────────────────
function decorate(req, res, { secureCookies }) {
  res.html = (body, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body instanceof Raw ? body.s : String(body));
  };
  res.redirect = (location, status = 303) => { res.statusCode = status; res.setHeader('Location', location); res.end(); };
  res.json = (obj, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  res.setCookie = (name, value, { maxAge, httpOnly = true } = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (secureCookies) parts.push('Secure');
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
  };
  const url = new URL(req.url, 'http://local');
  req.pathname = url.pathname;
  req.query = Object.fromEntries(url.searchParams);
  req.queryAll = url.searchParams;
  req.cookies = parseCookies(req);
}

// Flash messages via short-lived cookie
function flash(res, type, msg) { res.setCookie('lb_flash', JSON.stringify({ type, msg }), { maxAge: 30 }); }
function takeFlash(req, res) {
  const v = req.cookies.lb_flash;
  if (!v) return null;
  res.setCookie('lb_flash', '', { maxAge: 0 });
  try { return JSON.parse(v); } catch { return null; }
}

// ── Static files ──────────────────────────────────────────────
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(root, req, res) {
  const rel = decodeURIComponent(req.pathname.replace(/^\/static\//, ''));
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  // Versioned URLs (?v=…) can be cached long; anything else must be revalidated.
  res.setHeader('Cache-Control', req.query && req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { Router, HttpError, parseForm, readBody, parseCookies, sign, unsign, decorate, flash, takeFlash, serveStatic };
