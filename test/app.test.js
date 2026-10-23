'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');

const calc = require('../src/calc');
const { parseUpload, parseCsv } = require('../src/importer');
const { processImage } = require('../src/images');
const { createApp, buildConfig } = require('../src/server');
const { seedDb } = require('./memory-db');
const AI = require('../src/ai');
const A = require('../src/auth');

const FIX = path.join(__dirname, 'fixtures');
const PUB = path.join(__dirname, '..', 'public');

// ── Calculations ──────────────────────────────────────────────
test('container fit: 50×35×30 carton', () => {
  assert.equal(calc.cartonsFit({ l: 50, w: 35, h: 30 }, '20GP').cartons, 462);
  assert.equal(calc.cartonsFit({ l: 50, w: 35, h: 30 }, '40GP').cartons, 1008);
  const hq = calc.cartonsFit({ l: 50, w: 35, h: 30, gw: 10.6 }, '40HQ');
  assert.equal(hq.cartons, 1200);
  assert.equal(hq.limitedBy, 'dimensions');
});

test('container fit is capped by weight', () => {
  const f = calc.cartonsFit({ l: 30, w: 30, h: 30, gw: 40 }, '40HQ');
  assert.equal(f.limitedBy, 'weight');
  assert.equal(f.cartons, 500); // 20000 / 40
});

test('landed cost, CNY conversion, LCL and air', () => {
  const db = seedDb();
  const ctx = { settings: db.tables.settings[0], categories: db.tables.categories, options: db.tables.logistics_options };
  const p = { id: 'p', category: 'Infant/Toddler', currency: 'CNY', unit_price: 23, units_per_carton: 24, carton_l_cm: 50, carton_w_cm: 35, carton_h_cm: 30, carton_gw_kg: 10.6, moq: 1000, our_wholesale_usd: 7, certifications: 'CPSIA' };
  const a = calc.analyzeProduct(p, ctx);
  assert.equal(a.unit_price_usd, 3.22);
  assert.equal(a.primary.name, '40HQ FCL');
  assert.equal(a.primary.freight_per_unit, 0.184); // 5300 / 28800
  assert.equal(a.duty_pct, 7);
  assert.ok(Math.abs(a.landed_cost - 3.6543) < 0.0005);
  assert.equal(a.pricing.suggested_wholesale, 6.64);
  const lcl = a.scenarios.find((s) => s.mode === 'LCL');
  assert.equal(lcl.freight_per_unit, 0.8595);
  const air = a.scenarios.find((s) => s.mode === 'AIR');
  assert.equal(air.chargeable, 445.2);
  assert.deepEqual(a.issues, []);
});

test('DDP price excludes freight and duty; missing data flagged', () => {
  const db = seedDb();
  const ctx = { settings: db.tables.settings[0], categories: db.tables.categories, options: db.tables.logistics_options };
  const a = calc.analyzeProduct({ id: 'x', unit_price: 5, incoterm: 'DDP', units_per_carton: 10, carton_l_cm: 40, carton_w_cm: 40, carton_h_cm: 40, carton_gw_kg: 5 }, ctx);
  assert.equal(a.landed_cost, 5);
  const b = calc.analyzeProduct({ id: 'y', product_name: 'x' }, ctx);
  assert.equal(b.landed_cost, null);
  assert.ok(b.issues.includes('No unit price'));
  assert.ok(b.issues.includes('Missing carton dimensions'));
});

// ── Importers ─────────────────────────────────────────────────
test('imports the Lulyboo Excel template: header terms apply to every product row', () => {
  const r = parseUpload({ name: 'template_filled.xlsx', buffer: fs.readFileSync(path.join(FIX, 'template_filled.xlsx')) });
  assert.equal(r.products.length, 2);
  assert.equal(r.skipped, 2); // Chinese header row + example row
  assert.deepEqual(r.unknownColumns, []);
  const [a, b] = r.products.map((x) => x.row);
  assert.equal(r.products[0].rowNumber, 17);
  assert.equal(a.product_name, 'Rubber bath duck set');
  assert.equal(a.supplier_sku, 'MW-01');
  assert.equal(a.unit_price, 8.5);
  assert.equal(a.moq, 2000);
  assert.equal(a.carton_l_cm, 60); assert.equal(a.carton_gw_kg, 9.2);
  // From the "terms for all products" block, entered once
  for (const p of [a, b]) {
    assert.equal(p.currency, 'CNY'); assert.equal(p.incoterm, 'FOB'); assert.equal(p.fob_port, 'Shenzhen');
    assert.equal(p.payment_terms, '30% deposit, 70% before shipment'); assert.equal(p.quote_valid_until, '2026-12-31');
    assert.equal(p.country_of_origin, 'China'); assert.equal(p.sample_lead_days, 7);
  }
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].rowNumber, 19);
  assert.match(r.errors[0].messages[0], /Unit Price/);
});

test('imports a flat CSV (UTF-8 BOM), one product per row', () => {
  const csv = '\uFEFFProduct Name,Unit Price,Currency,MOQ (units)\r\nExample: thing,1,USD,1\r\nBib,"1,250.50",CNY,500\r\n';
  const r = parseUpload({ name: 't.csv', buffer: Buffer.from(csv, 'utf8') });
  assert.equal(r.skipped, 1);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].row.unit_price, 1250.5);
  assert.equal(r.products[0].row.currency, 'CNY');
});

test('imports the Factory Quotation Request form, with terms and split cells', () => {
  const r = parseUpload({ name: 'q.xlsx', buffer: fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx')) });
  assert.equal(r.products.length, 2);
  assert.equal(r.errors.length, 1); // row 17 has only an item number
  assert.equal(r.errors[0].rowNumber, 17);
  assert.equal(r.products[0].rowNumber, 15);
  const [a, b] = r.products.map((x) => x.row);
  assert.equal(a.supplier_sku, 'NB-01');
  assert.equal(a.product_name, 'Muslin swaddle blanket 2-pack');
  assert.equal(a.unit_price, 3.15);
  assert.equal(a.carton_l_cm, 50); assert.equal(a.carton_h_cm, 30);
  assert.equal(a.carton_nw_kg, 9.6); assert.equal(a.carton_gw_kg, 10.6);
  assert.equal(a.currency, 'USD'); assert.equal(a.incoterm, 'FOB'); assert.equal(a.fob_port, 'Ningbo');
  assert.equal(a.moq, 1000); assert.equal(a.production_lead_days, 45); assert.equal(a.sample_lead_days, 7);
  assert.equal(a.quote_valid_until, '2026-12-31');
  assert.equal(a.supplier_qty_40hq, 28000);
  assert.equal(b.production_lead_days, 30); // row value beats header term
  assert.equal(b.carton_w_cm, 32); assert.equal(b.carton_gw_kg, 7);
});

test('csv parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('a,b,c\n"x, y","multi\nline","q""uote"\n');
  assert.deepEqual(rows[1], ['x, y', 'multi\nline', 'q"uote']);
});

// ── Images ────────────────────────────────────────────────────
test('images are converted to WebP ≤1600px with a 400px thumbnail', async () => {
  const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#d9776a' } }).jpeg({ quality: 95 }).toBuffer();
  const out = await processImage(big);
  assert.equal(out.width, 1600);
  assert.equal(out.height, 1200);
  const meta = await sharp(out.thumb).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 400);
});

// ── HTTP end-to-end ───────────────────────────────────────────
process.env.EMAIL_DEV_LOG = 'true';
process.on('exit', () => {}); // keep console tidy
function startServer(db) {
  const config = { ...buildConfig({ ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 's', PORT: '0', SUPABASE_URL: 'https://x.supabase.co' }), publicUrl: 'http://test', showDevCodes: true };
  const server = http.createServer(createApp({ db, config }));
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
async function req(base, method, p, { body, cookie, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload = body;
  if (form) { payload = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie(), text: await res.text() };
}

test('end-to-end: admin creates supplier, supplier submits, admin reviews and analyses', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());

  // Admin pages require login
  assert.equal((await req(base, 'GET', '/admin')).status, 303);
  assert.equal((await req(base, 'POST', '/admin/login', { form: { password: 'wrong' } })).location, '/admin/login');
  const login = await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } });
  assert.equal(login.location, '/admin');
  const cookie = login.cookies.map((c) => c.split(';')[0]).join('; ');

  // Create supplier + invitation
  const created = await req(base, 'POST', '/admin/suppliers', { cookie, form: { invite_email: 'Lily@Example.com', crm_status: 'Quoting', send_email: '1' } });
  assert.equal(created.status, 303);
  const flashOf = (r) => { const c = r.cookies.find((x) => x.startsWith('lb_flash=')); return c ? decodeURIComponent(c.split(';')[0].slice(9)) : ''; };
  const link = flashOf(created).match(/http:\/\/test(\/s\/[\w-]+)/)[1];
  const supplierPage = await req(base, 'GET', created.location, { cookie: cookie + '; lb_flash=' + encodeURIComponent(flashOf(created)) });
  assert.match(supplierPage.text, /Email is not configured/);
  assert.match(supplierPage.text, /lily@example.com/);
  assert.equal(db.tables.supplier_users[0].email, 'lily@example.com');
  assert.ok(!JSON.stringify(db.tables).includes(link.split('/')[2]), 'invite token stored only as hash');
  assert.equal((await req(base, 'POST', '/admin/suppliers', { cookie, form: { invite_email: 'lily@example.com' } })).status, 303);
  assert.equal(db.tables.supplier_users.length, 1, 'duplicate email rejected');

  // Invite landing → email code
  assert.equal((await req(base, 'GET', '/s/not-a-valid-token-xxxxxxxx')).status, 404);
  const landing = await req(base, 'GET', link);
  assert.equal(landing.status, 200);
  assert.match(landing.text, /li•+@example\.com/);
  const sent = await req(base, 'POST', `${link}/send-code`, { form: {} });
  const code = flashOf(sent).match(/code (\d{6})/)[1];
  assert.equal(db.tables.auth_codes.length, 1);
  assert.notEqual(db.tables.auth_codes[0].code_hash, code);
  assert.equal((await req(base, 'POST', `${link}/send-code`, { form: {} })).status, 429, 'resend throttled');
  const wrong = await req(base, 'POST', `${link}/verify`, { form: { code: code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.location, `${link}?sent=1`);
  assert.equal(db.tables.auth_codes[0].attempts, 1);
  const ok = await req(base, 'POST', `${link}/verify`, { form: { code } });
  assert.equal(ok.location, '/register');
  const regCookie = ok.cookies.map((c) => c.split(';')[0]).join('; ');

  // Not signed in → /portal redirects to /login; register page needs verification
  assert.equal((await req(base, 'GET', '/portal')).location, '/login');
  assert.equal((await req(base, 'GET', '/register')).status, 403);
  const regPage = await req(base, 'GET', '/register', { cookie: regCookie });
  assert.match(regPage.text, /Company registration/);

  // Registration: validation, then success
  const bad = await req(base, 'POST', '/register', { cookie: regCookie, form: { name: 'Ningbo Happy Baby', user_name: 'Lily', password: 'short', password2: 'short' } });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /required/);
  const reg = await req(base, 'POST', '/register', { cookie: regCookie, form: {
    name: 'Ningbo Happy Baby', phone: '+86 138', address: 'Ningbo', country: 'China',
    user_name: 'Lily Chen', password: 'correct horse battery', password2: 'correct horse battery' } });
  assert.equal(reg.location, '/portal');
  let scookie = reg.cookies.filter((c) => c.startsWith('lb_sup=')).map((c) => c.split(';')[0]).join('; ');
  assert.ok(scookie);
  assert.equal(db.tables.suppliers[0].name, 'Ningbo Happy Baby');
  assert.equal(db.tables.suppliers[0].contact_name, 'Lily Chen');
  assert.equal(db.tables.suppliers[0].email, 'lily@example.com');
  assert.ok(db.tables.suppliers[0].registered_at);
  assert.equal(db.tables.supplier_users[0].status, 'active');
  assert.equal(db.tables.supplier_users[0].invite_token_hash, null);
  assert.match(db.tables.supplier_users[0].password_hash, /^scrypt\$/);
  assert.equal((await req(base, 'GET', link)).status, 404, 'invite link is single-use');

  // Sign in with email + password
  const badLogin = await req(base, 'POST', '/login', { form: { email: 'lily@example.com', password: 'nope-nope-nope' } });
  assert.match(badLogin.location, /^\/login/);
  const login2 = await req(base, 'POST', '/login', { form: { email: ' LILY@example.com ', password: 'correct horse battery' } });
  assert.equal(login2.location, '/portal');
  scookie = login2.cookies.filter((c) => c.startsWith('lb_sup=')).map((c) => c.split(';')[0]).join('; ');
  const dash = await req(base, 'GET', '/portal', { cookie: scookie });
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Ningbo Happy Baby/);

  // Supplier submits a product with a photo (multipart)
  const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#88aacc' } }).jpeg().toBuffer();
  const fd = new FormData();
  Object.entries({ product_name: 'Muslin swaddle 2-pack', category: 'Infant/Toddler', currency: 'USD', unit_price: '3.20', incoterm: 'FOB', moq: '1000', units_per_carton: '24', carton_l_cm: '50', carton_w_cm: '35', carton_h_cm: '30', carton_gw_kg: '10.6', certifications: 'CPSIA' })
    .forEach(([k, v]) => fd.append(k, v));
  fd.append('images', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  const sub = await fetch(`${base}/portal/products`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: scookie } });
  assert.equal(sub.status, 303);
  assert.equal(db.tables.products.length, 1);
  assert.equal(db.tables.product_images.length, 1);
  assert.equal(db.files.size, 2);
  const pid = db.tables.products[0].id;

  // Supplier cannot see review fields; can view own product
  const own = await req(base, 'GET', `/portal/products/${pid}`, { cookie: scookie });
  assert.equal(own.status, 200);
  assert.doesNotMatch(own.text, /our_wholesale|review_notes/);

  // Supplier bulk upload (factory quotation form)
  const fd2 = new FormData();
  fd2.append('file', new Blob([fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx'))]), 'quote.xlsx');
  const imp = await fetch(`${base}/portal/import`, { method: 'POST', body: fd2, headers: { cookie: scookie } });
  assert.match(await imp.text(), /<strong>2<\/strong> products added/);
  assert.equal(db.tables.products.length, 3);

  // Isolation: another supplier's user cannot read or change these products
  const s2 = await db.insert('suppliers', { name: 'Other Factory', registered_at: new Date().toISOString() });
  await db.insert('supplier_users', { supplier_id: s2.id, email: 'other@example.com', status: 'active', password_hash: await A.hashPassword('other-password-123') });
  const l2 = await req(base, 'POST', '/login', { form: { email: 'other@example.com', password: 'other-password-123' } });
  const c2 = l2.cookies.filter((c) => c.startsWith('lb_sup=')).map((c) => c.split(';')[0]).join('; ');
  assert.equal((await req(base, 'GET', `/portal/products/${pid}`, { cookie: c2 })).status, 404);
  assert.equal((await req(base, 'POST', `/portal/products/${pid}/delete`, { cookie: c2, form: {} })).status, 404);
  assert.doesNotMatch((await req(base, 'GET', '/portal', { cookie: c2 })).text, /Muslin swaddle/);
  assert.equal(db.tables.products.length, 3);

  // Cross-site form posts are blocked
  const csrf = await fetch(`${base}/portal/products/${pid}/delete`, { method: 'POST', headers: { cookie: scookie, origin: 'https://evil.example' }, redirect: 'manual' });
  assert.equal(csrf.status, 403);

  // Forgot password → code → new password; old sessions end
  const fg = await req(base, 'POST', '/forgot', { form: { email: 'lily@example.com' } });
  const rcode = flashOf(fg).match(/code (\d{6})/)[1];
  const rcookie = fg.cookies.filter((c) => c.startsWith('lb_rst=')).map((c) => c.split(';')[0]).join('; ');
  const rs = await req(base, 'POST', '/reset', { cookie: rcookie, form: { code: rcode, password: 'brand new password 1', password2: 'brand new password 1' } });
  assert.equal(rs.location, '/portal');
  assert.equal((await req(base, 'GET', '/portal', { cookie: scookie })).location, '/login', 'old session ended');
  scookie = rs.cookies.filter((c) => c.startsWith('lb_sup=')).map((c) => c.split(';')[0]).join('; ');
  assert.equal((await req(base, 'GET', '/portal', { cookie: scookie })).status, 200);
  const unknown = await req(base, 'POST', '/forgot', { form: { email: 'nobody@example.com' } });
  assert.equal(unknown.location, '/reset', 'same response for unknown email');

  // Another supplier's product for compare/similar
  const other = await db.insert('suppliers', { name: 'Shenzhen Soft Goods' });
  await db.insert('products', { supplier_id: other.id, product_name: 'Organic muslin swaddle blanket 2 pack', category: 'Infant/Toddler', unit_price: 2.9, currency: 'USD', units_per_carton: 30, carton_l_cm: 55, carton_w_cm: 38, carton_h_cm: 32, carton_gw_kg: 12, moq: 2000 });

  // Admin pages render
  for (const p of ['/admin', '/admin/products', '/admin/products?sort=landed&category=Infant%2FToddler', `/admin/products/${pid}`, '/admin/suppliers', `/admin/suppliers/${db.tables.suppliers[0].id}`,
    '/admin/categories', '/admin/logistics', '/admin/logistics?l=50&w=35&h=30&gw=10.6&upc=24&qty=1000&price=3.2', '/admin/pricing', '/admin/ai', '/admin/settings',
    `/admin/compare?ids=${db.tables.products.map((p) => p.id).join(',')}`]) {
    const r = await req(base, 'GET', p, { cookie });
    assert.equal(r.status, 200, `${p} → ${r.status} ${r.text.slice(0, 300)}`);
  }
  const detail = await req(base, 'GET', `/admin/products/${pid}`, { cookie });
  assert.match(detail.text, /Landed cost/);
  assert.match(detail.text, /1,200 cartons/);
  const logi = await req(base, 'GET', '/admin/logistics?l=50&w=35&h=30&gw=10.6&upc=24&qty=1000&price=3.2', { cookie });
  assert.match(logi.text, /28,800 units/);

  // Review + pricing + status
  await req(base, 'POST', `/admin/products/${pid}/review`, { cookie, form: { status: 'Shortlisted', score: '4', our_wholesale_usd: '7.5', our_retail_usd: '16.99', target_stores: 'Ross', review_notes: 'Good' } });
  assert.equal(db.tables.products.find((p) => p.id === pid).status, 'Shortlisted');
  assert.deepEqual(db.tables.products.find((p) => p.id === pid).target_stores, ['Ross']);
  await req(base, 'POST', '/admin/pricing', { cookie, form: { ids: pid, [`wh_${pid}`]: '8', [`rt_${pid}`]: '17.99' } });
  assert.equal(db.tables.products.find((p) => p.id === pid).our_wholesale_usd, 8);

  // Locked once selected: supplier cannot edit
  await req(base, 'POST', '/admin/products/bulk', { cookie, form: { ids: pid, action: 'status', status: 'Selected' } });
  assert.equal((await req(base, 'POST', `/portal/products/${pid}/delete`, { cookie: scookie, form: {} })).status, 403);

  // CRM activity + follow-up appears on dashboard
  const sid = db.tables.suppliers[0].id;
  await req(base, 'POST', `/admin/supplier-users/${db.tables.supplier_users[0].id}/toggle`, { cookie, form: {} });
  assert.equal((await req(base, 'GET', '/portal', { cookie: scookie })).location, '/login', 'disabled user signed out');
  await req(base, 'POST', `/admin/suppliers/${sid}/activities`, { cookie, form: { type: 'Call', summary: 'Asked for CPC', follow_up_date: '2020-01-01' } });
  const dashboard = await req(base, 'GET', '/admin', { cookie });
  assert.match(dashboard.text, /Asked for CPC/);

  // Categories/logistics/settings save
  const catId = db.tables.categories[0].id;
  await req(base, 'POST', '/admin/categories', { cookie, form: { [`name_${catId}`]: 'Infant/Toddler', [`duty_${catId}`]: '6.5', [`margin_${catId}`]: '50', [`sort_${catId}`]: '1', name_new: 'Home', margin_new: '40' } });
  assert.equal(db.tables.categories.find((c) => c.id === catId).default_duty_pct, 6.5);
  assert.ok(db.tables.categories.some((c) => c.name === 'Home'));
  await req(base, 'POST', '/admin/settings', { cookie, form: { default_duty_pct: '0', default_target_margin_pct: '40', insurance_pct: '0.3', fx_CNY: '0.139', fx_new: 'GBP=1.27' } });
  assert.equal(db.tables.settings[0].fx_to_usd.GBP, 1.27);

  // Export
  const csv = await req(base, 'GET', '/admin/export.csv', { cookie });
  assert.match(csv.text, /Landed Cost/);
  assert.equal(csv.text.trim().split('\r\n').length, 5);

  // AI disabled → friendly error
  delete process.env.ANTHROPIC_API_KEY;
  const ai = await req(base, 'POST', `/admin/products/${pid}/ai-review`, { cookie, form: {} });
  assert.equal(ai.status, 400);

  // Similar-candidate ranking finds the other supplier's swaddle
  const cands = AI.rankCandidates(db.tables.products.find((p) => p.id === pid), db.tables.products);
  assert.equal(cands[0].supplier_id, other.id);

  // Blocking a supplier signs out all its users
  await req(base, 'POST', `/admin/suppliers/${s2.id}/toggle`, { cookie, form: {} });
  assert.equal((await req(base, 'GET', '/portal', { cookie: c2 })).location, '/login');
});

test('AI calls use forced tool output and are stored (mocked Claude API)', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const realFetch = global.fetch;
  let sent;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.anthropic.com')) {
      sent = JSON.parse(opts.body);
      return new Response(JSON.stringify({ model: 'claude-test', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', name: sent.tool_choice.name, input: { verdict: 'Strong', summary: 'Good value', data_issues: [], pricing: { rationale: 'ok' }, risks: ['CPC needed'], questions_for_factory: ['CPC?'] } }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; });
  process.env.ANTHROPIC_API_KEY = 'test';
  const s = await db.insert('suppliers', { name: 'A' });
  const p = await db.insert('products', { supplier_id: s.id, product_name: 'Bib', unit_price: 1, units_per_carton: 50, carton_l_cm: 45, carton_w_cm: 32, carton_h_cm: 28, carton_gw_kg: 7 });
  const login = await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } });
  const cookie = login.cookies.map((c) => c.split(';')[0]).join('; ');
  const r = await req(base, 'POST', `/admin/products/${p.id}/ai-review`, { cookie, form: {} });
  assert.equal(r.status, 303);
  assert.equal(sent.tool_choice.name, 'product_review');
  assert.match(JSON.stringify(sent.messages), /landed_cost/);
  assert.equal(db.tables.ai_analyses.length, 1);
  const page = await req(base, 'GET', `/admin/products/${p.id}`, { cookie });
  assert.match(page.text, /Good value/);
  assert.match(page.text, /CPC needed/);
});

test('AI helpers on the wizard are gated when AI is off', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const fs_ = require('node:fs');
  const src = fs_.readFileSync(path.join(__dirname, '../src/routes/supplier.js'), 'utf8');
  assert.match(src, /\/portal\/ai\/:what/);
  assert.equal(AI.enabled(), false);
});

// ── Photos embedded in the bulk template ──────────────────────
for (const kind of ['floating', 'incell', 'wps']) {
  test(`bulk template: ${kind} pictures are matched to their product rows`, async () => {
    const { runImport } = require('../src/routes/supplier');
    const buffer = fs.readFileSync(path.join(FIX, `template_photos_${kind}.xlsx`));
    const parsed = parseUpload({ name: 'x.xlsx', buffer });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.products.length, 3);
    assert.equal(parsed.photosFound, kind === 'floating' ? 3 : 2);
    const byName = Object.fromEntries(parsed.products.map((p) => [p.row.product_name, (p.images || []).length]));
    assert.equal(byName['Silicone bib'], 1);
    assert.equal(byName['Pet bowl'], kind === 'floating' ? 2 : 1);
    assert.equal(byName['No photo item'], 0);
    assert.deepEqual(parsed.unknownColumns, []);

    const db = seedDb();
    const sid = (await db.insert('suppliers', { name: 'Test Factory' })).id;
    const before = (db.tables.product_images ||= []).length;
    const res = await runImport(db, { name: 'x.xlsx', buffer }, sid);
    assert.equal(res.inserted, 3);
    assert.equal(res.photos, kind === 'floating' ? 3 : 2);
    assert.equal(db.tables.product_images.length - before, res.photos);
    const bib = db.tables.products.find((p) => p.product_name === 'Silicone bib');
    assert.equal(db.tables.product_images.filter((i) => i.product_id === bib.id).length, 1);
  });
}

// ── HTS / duty ────────────────────────────────────────────────
const Duty = require('../src/duty');

test('parseGeneralRate reads free, percent and mixed rates', () => {
  assert.equal(Duty.parseGeneralRate('Free').ad_valorem, 0);
  assert.equal(Duty.parseGeneralRate('3.4%').ad_valorem, 3.4);
  const mixed = Duty.parseGeneralRate('6.8¢/kg + 10%');
  assert.equal(mixed.ad_valorem, 10);
  assert.equal(mixed.specific, true);
  assert.equal(Duty.parseGeneralRate('').ad_valorem, null);
});

test('calc duty precedence: manual > AI > category > default', () => {
  const db = seedDb();
  const ctx = { settings: db.tables.settings[0], categories: db.tables.categories, options: db.tables.logistics_options };
  const base = { id: 'd', category: 'Infant/Toddler', unit_price: 5, units_per_carton: 24, carton_l_cm: 50, carton_w_cm: 35, carton_h_cm: 30, carton_gw_kg: 10 };
  assert.equal(calc.analyzeProduct(base, ctx).duty_pct, 7);
  assert.equal(calc.analyzeProduct({ ...base, duty_ai_pct: 12.5 }, ctx).duty_pct, 12.5);
  const m = calc.analyzeProduct({ ...base, duty_ai_pct: 12.5, duty_rate_pct: 3 }, ctx);
  assert.equal(m.duty_pct, 3);
  assert.equal(m.duty_source, 'manual');
});

function mockDutyFetch(t, usitcRows) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://hts.usitc.gov')) return new Response(JSON.stringify(usitcRows), { status: 200 });
    if (u.startsWith('https://api.anthropic.com')) {
      const name = JSON.parse(opts.body).tool_choice.name;
      const input = name === 'record_duty'
        ? { hts_code: '3924.10.40', hts_description: 'Tableware', confidence: 'high', summary: 'ok', classification_note: 'n',
            additional: [
              { label: 'Section 301', heading: '9903.88.03', rate_pct: 25, applies: true, basis: 'usitc_data' },
              { label: 'Mystery tariff', rate_pct: 10, applies: true, basis: 'general_knowledge' },
            ], review_flags: [] }
        : { codes: ['392410'] };
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', name, input }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; Duty._cache.clear(); });
  process.env.ANTHROPIC_API_KEY = 'test';
  Duty._cache.clear();
}
const ROWS = [{ htsno: '3924.10.40', description: 'Other tableware', general: '3.4%', footnotes: [{ value: 'See 9903.88.03.' }] }];

test('researchDuty: base from USITC row, only confirmed additions counted', async (t) => {
  mockDutyFetch(t, ROWS);
  const r = await Duty.researchDuty({ product_name: 'Bib', hs_code: '3924.10', country_of_origin: 'China' });
  assert.equal(r.base_rate_pct, 3.4);
  assert.equal(r.additional_pct, 25);
  assert.equal(r.total_pct, 28.4);
  assert.ok(r.review_flags.some((f) => /Mystery tariff/.test(f)));
  assert.equal(Duty.productPatch(r).duty_ai_pct, 28.4);
});

test('admin: research duty, test mode, apply and clear manual override', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  mockDutyFetch(t, ROWS);
  const s = await db.insert('suppliers', { name: 'A' });
  const p = await db.insert('products', { supplier_id: s.id, product_name: 'Bib', hs_code: '3924.10', unit_price: 1, units_per_carton: 50, carton_l_cm: 45, carton_w_cm: 32, carton_h_cm: 28, carton_gw_kg: 7 });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const r = await req(base, 'POST', `/admin/products/${p.id}/duty/research`, { cookie, form: {} });
  assert.equal(r.status, 303);
  let row = db.tables.products.find((x) => x.id === p.id);
  assert.equal(Number(row.duty_ai_pct), 28.4);
  assert.equal(row.hts_verified_code, '3924.10.40');
  const test1 = await req(base, 'GET', `/admin/products/${p.id}?test_duty=5`, { cookie });
  assert.equal(test1.status, 200);
  assert.match(test1.text, /TEST/);
  assert.equal(Number(db.tables.products.find((x) => x.id === p.id).duty_rate_pct ?? 0), 0);
  await req(base, 'POST', `/admin/products/${p.id}/duty/apply-override`, { cookie, form: { duty: '5' } });
  assert.equal(Number(db.tables.products.find((x) => x.id === p.id).duty_rate_pct), 5);
  await req(base, 'POST', `/admin/products/${p.id}/duty/clear-override`, { cookie, form: {} });
  assert.equal(db.tables.products.find((x) => x.id === p.id).duty_rate_pct, null);
});

test('landed cost adds the China tariff from AI/USITC research as its own line', () => {
  const db = seedDb();
  const ctx = { settings: db.tables.settings[0], categories: db.tables.categories, options: db.tables.logistics_options };
  const base = { id: 't', category: 'Infant/Toddler', unit_price: 10, units_per_carton: 24, carton_l_cm: 50, carton_w_cm: 35, carton_h_cm: 30, carton_gw_kg: 10 };
  const plain = calc.analyzeProduct({ ...base, duty_ai_pct: 3.4, duty_ai_detail: { additional_pct: 0 } }, ctx);
  const withTariff = calc.analyzeProduct({ ...base, duty_ai_pct: 28.4, duty_ai_detail: { base_rate_pct: 3.4, additional_pct: 25 } }, ctx);
  assert.equal(withTariff.tariff_pct, 25);
  assert.equal(withTariff.base_duty_pct, 3.4);
  assert.equal(withTariff.primary.tariff_per_unit, 2.5);
  assert.equal(withTariff.primary.duty_per_unit, 0.34);
  assert.ok(Math.abs(withTariff.landed_cost - plain.landed_cost - 2.5) < 0.001);
  const manual = calc.analyzeProduct({ ...base, duty_rate_pct: 3.4, duty_ai_pct: 28.4, duty_ai_detail: { additional_pct: 25 } }, ctx);
  assert.equal(manual.tariff_pct, 0); // manual override is all-in
});

test('pricing page: bulk-research China products shows the tariff column', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  mockDutyFetch(t, ROWS);
  const s = await db.insert('suppliers', { name: 'A' });
  const p = await db.insert('products', { supplier_id: s.id, product_name: 'Bib', hs_code: '3924.10', country_of_origin: 'China', is_draft: false, unit_price: 1, units_per_carton: 50, carton_l_cm: 45, carton_w_cm: 32, carton_h_cm: 28, carton_gw_kg: 7 });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  let page = await req(base, 'GET', '/admin/pricing', { cookie });
  assert.match(page.text, /not researched/);
  assert.match(page.text, /Research duty &amp; China tariff \(1 product/);
  const r = await req(base, 'POST', '/admin/pricing/research-duty', { cookie, form: {} });
  assert.equal(r.status, 303);
  assert.equal(Number(db.tables.products.find((x) => x.id === p.id).duty_ai_pct), 28.4);
  page = await req(base, 'GET', '/admin/pricing', { cookie });
  assert.doesNotMatch(page.text, /not researched/);
  assert.match(page.text, /25%/);
});

test('Products page: AI compare button forwards selected products to the AI compare route', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const s = await db.insert('suppliers', { name: 'A' });
  const a = await db.insert('products', { supplier_id: s.id, product_name: 'A', is_draft: false });
  const b = await db.insert('products', { supplier_id: s.id, product_name: 'B', is_draft: false });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const r = await req(base, 'POST', '/admin/products/bulk', { cookie, form: new URLSearchParams([['action', 'ai_compare'], ['ids', a.id], ['ids', b.id]]) });
  assert.equal(r.status, 307);
  assert.equal(r.location, `/admin/ai/compare?ids=${a.id},${b.id}`);
});

test('blanket China tariff from Settings is added to landed cost, except on manual duty or non-China origin', async (t) => {
  const db = seedDb();
  const ctx = { settings: { ...db.tables.settings[0], china_extra_tariff_pct: 10 }, categories: db.tables.categories, options: db.tables.logistics_options };
  const base = { id: 'b', category: 'Infant/Toddler', unit_price: 10, units_per_carton: 24, carton_l_cm: 50, carton_w_cm: 35, carton_h_cm: 30, carton_gw_kg: 10 };
  const china = calc.analyzeProduct({ ...base, country_of_origin: 'China' }, ctx);
  assert.equal(china.tariff_pct, 10); assert.equal(china.blanket_tariff_pct, 10);
  assert.equal(china.duty_pct, 17); // 7% category + 10% blanket
  assert.equal(china.primary.tariff_per_unit, 1);
  assert.equal(calc.analyzeProduct({ ...base, country_of_origin: 'Vietnam' }, ctx).tariff_pct, 0);
  assert.equal(calc.analyzeProduct({ ...base, country_of_origin: 'China', duty_rate_pct: 5 }, ctx).duty_pct, 5);
  const ai = calc.analyzeProduct({ ...base, duty_ai_pct: 28.4, duty_ai_detail: { additional_pct: 25 } }, ctx);
  assert.equal(ai.tariff_pct, 35); assert.equal(ai.base_duty_pct, 3.4); assert.equal(ai.duty_pct, 38.4);
});

test('Settings page saves the blanket China tariff', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  assert.match((await req(base, 'GET', '/admin/settings', { cookie })).text, /Blanket extra tariff/);
  await req(base, 'POST', '/admin/settings', { cookie, form: { default_duty_pct: '0', default_target_margin_pct: '40', insurance_pct: '0.3', china_extra_tariff_pct: '7.5' } });
  assert.equal(Number(db.tables.settings[0].china_extra_tariff_pct), 7.5);
});

test('logistics: Check market rate proposes, and only a confirmation changes the rate', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      if (body.tools?.[0]?.type === 'web_search_20250305') {
        return new Response(JSON.stringify({ model: 'm', stop_reason: 'end_turn', content: [
          { type: 'web_search_tool_result', content: [{ url: 'https://example.com/wci', title: 'Drewry WCI' }] },
          { type: 'text', text: 'Shanghai to Los Angeles: $2,450 per 40ft as of 2026-10-08 (Drewry WCI), ocean freight only.' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', name: 'propose_rate', input: { rate_usd: 2450, basis: 'index', as_of: '2026-10-08', confidence: 'medium', explanation: 'Drewry WCI Shanghai-LA.', includes_fees: 'ocean only' } }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; });
  process.env.ANTHROPIC_API_KEY = 'test';
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const opt = db.tables.logistics_options.find((o) => o.mode === 'FCL_40HQ');
  const before = Number(opt.rate_usd);
  const r = await req(base, 'POST', `/admin/logistics/${opt.id}/check-rate`, { cookie, form: {} });
  assert.equal(r.status, 200);
  assert.match(r.text, /2,450|2450/);
  assert.match(r.text, /Drewry WCI/);
  assert.equal(Number(db.tables.logistics_options.find((o) => o.id === opt.id).rate_usd), before); // nothing saved yet
  const ok = await req(base, 'POST', `/admin/logistics/${opt.id}/apply-rate`, { cookie, form: { rate: '2450', source: 'Drewry WCI', as_of: '2026-10-08' } });
  assert.equal(ok.status, 303);
  const after = db.tables.logistics_options.find((o) => o.id === opt.id);
  assert.equal(Number(after.rate_usd), 2450);
  assert.match(after.notes, /Drewry WCI/);
  assert.ok(after.valid_until);
  const bad = await req(base, 'POST', `/admin/logistics/${opt.id}/apply-rate`, { cookie, form: { rate: '-5' } });
  assert.equal(Number(db.tables.logistics_options.find((o) => o.id === opt.id).rate_usd), 2450);
});

test('logistics: when no rate is found, the page says so, retries once and offers no apply button', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const realFetch = global.fetch;
  let searches = 0;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      if (body.tools?.[0]?.type === 'web_search_20250305') { searches++; return new Response(JSON.stringify({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'No figures found.' }] }), { status: 200 }); }
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', name: 'propose_rate', input: { rate_usd: null, basis: 'not_found', confidence: 'low', explanation: 'Nothing found.' } }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; });
  process.env.ANTHROPIC_API_KEY = 'test';
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const opt = db.tables.logistics_options.find((o) => o.mode === 'FCL_40HQ');
  const r = await req(base, 'POST', `/admin/logistics/${opt.id}/check-rate`, { cookie, form: {} });
  assert.equal(r.status, 200);
  assert.equal(searches, 2);
  assert.match(r.text, /No usable figure found/);
  assert.doesNotMatch(r.text, /Confirm &amp; update rate/);
});

test('information requests: ticked products → email with CC and reference → inbound reply is linked to the request', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const s = await db.insert('suppliers', { name: 'Happy Toys', email: 'sales@happy.cn' });
  const a = await db.insert('products', { supplier_id: s.id, product_name: 'Rattle', is_draft: false });
  const b = await db.insert('products', { supplier_id: s.id, product_name: 'Teether', is_draft: false });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  process.env.RESEND_API_KEY = 're_test'; process.env.INBOUND_EMAIL_SECRET = 'sekret';
  const realFetch = global.fetch; const sent = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.resend.com/emails') && opts?.method === 'POST') { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.RESEND_API_KEY; delete process.env.INBOUND_EMAIL_SECRET; });

  // supplier page shows checkboxes + the button
  const page = await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie });
  assert.match(page.text, /name="ids" value="/); assert.match(page.text, /Request information/);
  // compose
  const idsForm = (extra = []) => new URLSearchParams([['ids', a.id], ['ids', b.id], ...extra]);
  const compose = await req(base, 'POST', `/admin/suppliers/${s.id}/request`, { cookie, form: idsForm() });
  assert.equal(compose.status, 200); assert.match(compose.text, /Packaging dieline/); assert.match(compose.text, /sales@happy\.cn/);
  // nothing chosen → rejected, no email
  const none = await req(base, 'POST', `/admin/suppliers/${s.id}/request/send`, { cookie, form: idsForm([['to', 'sales@happy.cn']]) });
  assert.equal(none.status, 303); assert.equal(sent.length, 0);
  // send
  const ok = await req(base, 'POST', `/admin/suppliers/${s.id}/request/send`, { cookie, form: idsForm([['items', 'dieline'], ['items', 'samples'], ['to', 'sales@happy.cn'], ['note', 'Need by Friday']]) });
  assert.equal(ok.status, 303); assert.match(ok.location, /^\/admin\/requests\//);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['sales@happy.cn']); assert.deepEqual(sent[0].cc, ['marsel@lulyboo.com']);
  assert.match(sent[0].subject, /\[Lulyboo LB-1001\]/); assert.match(sent[0].text, /do not start a new email|Do not change the subject/i);
  assert.match(sent[0].text, /Rattle/); assert.match(sent[0].text, /Need by Friday/);
  const detail = await req(base, 'GET', ok.location, { cookie });
  assert.match(detail.text, /LB-1001/); assert.match(detail.text, /Sent to supplier/);
  // inbound webhook: wrong key refused; right key links by reference in the subject
  const hook = (key, payload) => req(base, 'POST', `/hooks/inbound-email?key=${key}`, { body: JSON.stringify(payload) });
  assert.equal((await hook('nope', {})).status, 404);
  assert.equal((await hook('sekret', { from: 'x@y.com', subject: 'Re: hello', text: 'unrelated' })).status, 202);
  const inb = await hook('sekret', { from: 'sales@happy.cn', to: ['sourcing@lulyboo.space'], subject: 'RE: [Lulyboo LB-1001] Information request', text: 'Dieline attached', attachments: [{ filename: 'dieline.pdf', content_type: 'application/pdf', content: Buffer.from('%PDF-1.4 test').toString('base64') }] });
  assert.equal(inb.status, 200);
  assert.equal(db.tables.info_requests[0].status, 'Replied');
  const detail2 = await req(base, 'GET', ok.location, { cookie });
  assert.match(detail2.text, /Dieline attached/); assert.match(detail2.text, /dieline\.pdf/);
  assert.match(detail2.text, /href="https:\/\/x\.supabase\.co\/storage[^"]*LB-1001[^"]*dieline\.pdf/); // stored and linked
  // list + status + manual log
  assert.match((await req(base, 'GET', '/admin/requests', { cookie })).text, /LB-1001/);
  const id = db.tables.info_requests[0].id;
  await req(base, 'POST', `/admin/requests/${id}/status`, { cookie, form: { status: 'Complete' } });
  assert.equal(db.tables.info_requests[0].status, 'Complete');
  await req(base, 'POST', `/admin/requests/${id}/log`, { cookie, form: { direction: 'note', body: 'Sample arrived' } });
  const fd = new FormData(); fd.set('direction', 'in'); fd.set('body', ''); fd.set('files', new Blob(['dieline v2'], { type: 'application/pdf' }), 'box v2.pdf');
  const up = await fetch(`${base}/admin/requests/${id}/log`, { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
  assert.equal(up.status, 303);
  const msgs = db.tables.info_request_messages;
  assert.equal(msgs.length, 4);
  assert.match(msgs[3].attachments[0].path, /^requests\/LB-1001\/.*box_v2\.pdf$/);
  // second request gets the next reference
  const ok2 = await req(base, 'POST', `/admin/suppliers/${s.id}/request/send`, { cookie, form: idsForm([['items', 'certs'], ['to', 'sales@happy.cn']]) });
  assert.equal(ok2.status, 303); assert.match(sent[1].subject, /LB-1002/);
});

test('supplier page: bulk-set status on ticked products and return to the supplier page', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const s = await db.insert('suppliers', { name: 'A' });
  const a = await db.insert('products', { supplier_id: s.id, product_name: 'A', is_draft: false, status: 'New' });
  const b = await db.insert('products', { supplier_id: s.id, product_name: 'B', is_draft: false, status: 'New' });
  const c = await db.insert('products', { supplier_id: s.id, product_name: 'C', is_draft: false, status: 'New' });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const page = await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie });
  assert.match(page.text, /formaction="\/admin\/products\/bulk"/);
  const r = await req(base, 'POST', '/admin/products/bulk', { cookie, form: new URLSearchParams([['action', 'status'], ['status', 'Shortlisted'], ['back', `/admin/suppliers/${s.id}`], ['ids', a.id], ['ids', b.id]]) });
  assert.equal(r.status, 303); assert.equal(r.location, `/admin/suppliers/${s.id}`);
  const st = Object.fromEntries(db.tables.products.map((p) => [p.product_name, p.status]));
  assert.deepEqual(st, { A: 'Shortlisted', B: 'Shortlisted', C: 'New' });
  // an off-site "back" is ignored
  const evil = await req(base, 'POST', '/admin/products/bulk', { cookie, form: new URLSearchParams([['action', 'status'], ['status', 'Rejected'], ['back', 'https://evil.example'], ['ids', c.id]]) });
  assert.equal(evil.location, '/admin/products');
});

test('importer accepts the Factory Quotation Request form layout', () => {
  const { mapRows } = require('../src/importer');
  const rows = [];
  rows[11] = ['Currency', '', 'Incoterm', '', 'FOB Port / Delivery Point', '', 'Payment Terms', '', 'MOQ'];
  rows[12] = ['USD', '', 'FOB', '', 'Ningbo', '', '30% deposit', '', 500];
  rows[13] = ['ITEM NO. / SKU', 'FACTORY PRODUCT PICTURE', 'PRODUCT SIZE (cm)', 'DESCRIPTION', 'UNIT PRICE (USD)', 'MATERIAL', 'PRODUCTION LEAD TIME (days)', 'PACKAGING TYPE', 'PACKING (pcs/ctn)', 'N.W. / G.W. (kg)', 'CARTON SIZE L×W×H (cm)', 'HS CODE', 'QTY PER 40HQ (pcs)', 'FACTORY NOTES'];
  rows[14] = ['HB-1', 'Insert image', '20x20', 'Muslin swaddle', 3.2, 'Cotton', 30, 'Polybag', 48, '9.6 / 10.8', '56x38x32', '6307.90', 5000, ''];
  for (let i = 0; i < 11; i++) rows[i] = rows[i] || [];
  const r = mapRows(rows);
  assert.equal(r.errors.length, 0);
  assert.equal(r.products.length, 1);
  const p = r.products[0].row;
  assert.equal(p.carton_gw_kg, 10.8); assert.equal(p.carton_h_cm, 32); assert.equal(p.incoterm, 'FOB'); assert.equal(p.moq, 500);
});
