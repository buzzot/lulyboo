'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Load .env for local development (Railway injects variables directly).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Router, HttpError, decorate, serveStatic } = require('./lib/http');
const { html, t, m } = require('./lib/html');
const { page, errorPage } = require('./views/layout');

function buildConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, '');
  return {
    port: Number(env.PORT || 3000),
    publicUrl,
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || crypto.createHash('sha256').update('lb:' + (env.ADMIN_PASSWORD || 'dev')).digest('hex'),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 80) * 1024 * 1024,
    storagePlanGb: Number(env.STORAGE_PLAN_GB || 1),
    supabaseUrl: env.SUPABASE_URL || '',
    secureCookies: publicUrl.startsWith('https://'),
    showDevCodes: env.EMAIL_DEV_SHOW_CODES === 'true' && !env.RESEND_API_KEY,
  };
}

function createApp({ db, config }) {
  const router = new Router();
  const publicDir = path.join(__dirname, '..', 'public');

  router.get('/', async (req, res) => res.html(page({
    title: 'Supplier Portal', req,
    body: html`<section class="card narrow"><h1>${t('Lulyboo Supplier Portal', 'Lulyboo 供应商平台')}</h1>
      <p>${t('Submit your products, quotations and photos to Lulyboo.', '向 Lulyboo 提交您的产品、报价和图片。')}</p>
      <p><a class="btn" href="/login">${t('Supplier sign in', '供应商登录')}</a></p>
      <p class="muted small">${t('New supplier? Register with the invitation link Lulyboo emailed you.', '新供应商请通过 Lulyboo 发送的邀请链接注册。')}</p>
      <p class="muted small"><a href="/admin">Lulyboo team</a></p></section>`,
  })));
  router.get('/health', async (req, res) => res.json({ ok: true }));

  require('./routes/supplier-auth')(router, { db, config });
  require('./routes/supplier')(router, { db, config });
  require('./routes/admin')(router, { db, config });
  require('./routes/admin-tools')(router, { db, config });
  require('./routes/requests')(router, { db, config });
  require('./routes/crm')(router, { db, config });

  const imgOrigin = config.supabaseUrl ? new URL(config.supabaseUrl).origin : '';

  return async function handler(req, res) {
    decorate(req, res, { secureCookies: config.secureCookies });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin'); // invite tokens never sent to other sites; keeps Origin on form posts
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data: blob: ${imgOrigin}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    try {
      // Reject cross-site form posts (CSRF): browsers send Origin on POST.
      if (req.method === 'POST' && req.headers.origin) {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        let ok = false; try { ok = new URL(req.headers.origin).host === host; } catch { /* bad origin */ }
        if (!ok) throw new HttpError(403, 'Cross-site request blocked');
      }
      if (req.pathname.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) {
        if (serveStatic(publicDir, req, res)) return;
        throw new HttpError(404, 'File not found');
      }
      const route = router.match(req.method, req.pathname);
      if (!route) throw new HttpError(404, m('Page not found', '页面不存在'));
      req.params = route.params;
      for (const h of route.handlers) { await h(req, res); if (res.writableEnded) break; }
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error(new Date().toISOString(), req.method, req.pathname.replace(/\/s\/[^/]+/, '/s/***'), err);
      if (res.headersSent) { res.end(); return; }
      const msg = status >= 500 && !(err instanceof HttpError) && !err.message.includes('⟪') ? m('Something went wrong. Please try again.', '出现错误，请重试。') : err.message;
      res.html(errorPage(status, msg, req), status);
    }
  };
}

if (require.main === module) {
  const config = buildConfig();
  const { createSupabaseDb } = require('./db');
  const db = createSupabaseDb({ url: config.supabaseUrl, key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY });
  if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set; admin login is disabled.');
  if (!process.env.RESEND_API_KEY) console.warn('RESEND_API_KEY is not set: emails (codes, invitations) are not sent.');
  if (process.env.EMAIL_DEV_LOG === 'true') console.warn('EMAIL_DEV_LOG=true: email contents incl. codes are written to this log. Turn it off for production.');
  if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; using a value derived from ADMIN_PASSWORD.');
  const server = http.createServer(createApp({ db, config }));
  server.requestTimeout = 5 * 60_000; // AI calls and large uploads
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { runReminders } = require('./crm');
    const tick = () => runReminders({ db, config }).catch((e) => console.error('Reminder run failed:', e.message));
    setTimeout(tick, 15_000); setInterval(tick, 60_000);
  } else console.warn('TELEGRAM_BOT_TOKEN is not set: CRM reminders on Telegram are off.');
  server.listen(config.port, () => console.log(`Lulyboo portal on :${config.port} (${config.publicUrl})`));
}

module.exports = { createApp, buildConfig };
