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

  // Supplier bulk upload (factory quotation form), shown as a drag-and-drop / paste box
  const bulkPage = await req(base, 'GET', '/portal/import', { cookie: scookie });
  assert.equal(bulkPage.status, 200);
  assert.match(bulkPage.text, /data-filedrop/); assert.match(bulkPage.text, /accept="\.xlsx,\.csv,text\/csv"/);
  const fd2 = new FormData();
  fd2.append('file', new Blob([fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx'))]), 'quote.xlsx');
  const imp = await fetch(`${base}/portal/import`, { method: 'POST', body: fd2, headers: { cookie: scookie } });
  const review = await imp.text();
  assert.match(review, /Review before importing/);
  assert.equal(db.tables.products.length, 1); // nothing is saved until the supplier approves
  const rvToken = /name="token" value="([a-f0-9]{24})"/.exec(review)[1];
  const rvRows = [...review.matchAll(/name="use_(\d+)"/g)].map((x) => x[1]);
  assert.equal(rvRows.length, 2);
  const rvForm = new URLSearchParams({ token: rvToken }); rvRows.forEach((rn) => rvForm.append(`use_${rn}`, '1'));
  const approved = await req(base, 'POST', '/portal/import/confirm', { cookie: scookie, form: rvForm });
  assert.match(approved.text, /<strong>2<\/strong> products added/);
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
  // The product import is a drag-and-drop / paste box (still a normal file input underneath)
  assert.match(page.text, /data-filedrop/);
  assert.match(page.text, /<input type="file" name="file" accept="\.xlsx,\.csv[^"]*" required>/);
  assert.match(page.text, /Quotation form/);
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

test('importer: "20 DAYS" validity and separate N.W./G.W. columns', () => {
  const { mapRows } = require('../src/importer');
  const rows = [[], [], [], [], [], [], [], [], [],
    ['Quotation Valid Until', '20 DAYS'],
    ['ITEM NO. / SKU', 'DESCRIPTION', 'UNIT PRICE (USD)', 'PACKING (pcs/ctn)', 'N.W. (kg)', 'G.W. (kg)', 'CARTON SIZE L×W×H (cm)'],
    ['A1', 'Soft rubber boats', 1.16, 48, 9.6, 10.8, '56x38x32']];
  const r = mapRows(rows);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.products.length, 1);
  assert.deepEqual(r.unknownColumns, []);
  const p = r.products[0].row;
  assert.equal(p.carton_nw_kg, 9.6); assert.equal(p.carton_gw_kg, 10.8);
  assert.match(p.quote_valid_until, /^\d{4}-\d\d-\d\d$/);
});

// ── CRM ───────────────────────────────────────────────────────
test('crm: add, list, calendar, snooze, done (logs activity), supplier page widget', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const C = require('../src/crm');
  const today = C.localNow().date;
  const s = await db.insert('suppliers', { name: 'Dadi Toys' });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');

  const bad = await req(base, 'POST', '/admin/crm/tasks', { cookie, form: { title: '  ', due_date: today } });
  assert.equal(bad.status, 303); assert.equal(db.tables.crm_tasks?.length || 0, 0);
  const add = await req(base, 'POST', '/admin/crm/tasks', { cookie, form: { title: 'Chase samples', supplier_id: s.id, type: 'Call', due_date: C.addDays(today, -2), due_time: '10:30', remind_minutes: '30', back: '/admin/crm' } });
  assert.equal(add.location, '/admin/crm');
  await req(base, 'POST', '/admin/crm/tasks', { cookie, form: { title: 'Send NDA', due_date: today, type: 'nonsense' } });
  assert.equal(db.tables.crm_tasks.length, 2);
  const [a, b] = db.tables.crm_tasks;
  assert.equal(a.type, 'Call'); assert.equal(a.due_time, '10:30'); assert.equal(a.remind_minutes, 30);
  assert.equal(b.type, 'Follow-up'); assert.equal(b.supplier_id, null);

  const list = await req(base, 'GET', '/admin/crm', { cookie });
  assert.equal(list.status, 200);
  assert.match(list.text, /Overdue/); assert.match(list.text, /Chase samples/); assert.match(list.text, /Send NDA/); assert.match(list.text, /Dadi Toys/);
  const cal = await req(base, 'GET', `/admin/crm/calendar?m=${today.slice(0, 7)}&day=${today}`, { cookie });
  assert.equal(cal.status, 200); assert.match(cal.text, /class="cal"/); assert.match(cal.text, /Send NDA/);
  assert.match((await req(base, 'GET', '/admin/crm/calendar?m=garbage', { cookie })).text, /class="cal"/);
  assert.match((await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie })).text, /Next actions[\s\S]*Chase samples/);

  // snooze an overdue task moves it from today, not from the past
  await req(base, 'POST', `/admin/crm/tasks/${a.id}/snooze`, { cookie, form: { days: '1' } });
  assert.equal(db.tables.crm_tasks.find((x) => x.id === a.id).due_date, C.addDays(today, 1));
  // done logs an activity on the supplier timeline
  const done = await req(base, 'POST', `/admin/crm/tasks/${a.id}/done`, { cookie, form: { back: 'https://evil.example' } });
  assert.equal(done.location, '/admin/crm');
  assert.equal(db.tables.crm_tasks.find((x) => x.id === a.id).done, true);
  assert.ok(db.tables.supplier_activities.some((x) => x.supplier_id === s.id && x.summary === 'Done: Chase samples' && x.type === 'Call'));
  await req(base, 'POST', `/admin/crm/tasks/${b.id}/delete`, { cookie, form: {} });
  assert.equal(db.tables.crm_tasks.length, 1);
  // not reachable without login
  assert.equal((await req(base, 'GET', '/admin/crm')).status, 303);
});

test('crm: Telegram pairing, buttons, digest and timed pings', async (t) => {
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  const realFetch = global.fetch; const calls = [];
  const db = seedDb();
  const { server, base } = await startServer(db);
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      const method = String(url).split('/').pop(); const body = JSON.parse(opts.body); calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { username: 'lulyboo_test_bot' } : { message_id: 1 } }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; delete process.env.TELEGRAM_BOT_TOKEN; server.close(); });
  const C = require('../src/crm'); const tgm = require('../src/telegram');
  const config = { ...buildConfig({ ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 's', PORT: '0', SUPABASE_URL: 'https://x.supabase.co' }), publicUrl: 'https://portal.test' };
  const secret = tgm.webhookSecret(config); // same derivation as the server (config.sessionSecret = 's')
  const hook = (update, sec = secret) => fetch(`${base}/hooks/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': sec }, body: JSON.stringify(update) });
  const sent = () => calls.filter((c) => c.method === 'sendMessage');

  // wrong secret is refused
  assert.equal((await hook({ message: { text: '/start x', chat: { id: 1 } } }, 'nope')).status, 404);
  // pairing with the right one-time code
  await db.insert('settings', { id: 1 }).catch(() => {});
  db.tables.settings[0].telegram_pair_code = 'abc123';
  await hook({ message: { text: '/start wrongcode', chat: { id: 77 } } });
  assert.equal(db.tables.settings[0].telegram_chat_id ?? null, null);
  await hook({ message: { text: '/start abc123', chat: { id: 42 } } });
  assert.equal(db.tables.settings[0].telegram_chat_id, '42'); assert.equal(db.tables.settings[0].telegram_pair_code, null);
  assert.match(sent().at(-1).body.text, /Connected/);
  // strangers are ignored
  const before = sent().length;
  await hook({ message: { text: '/today', chat: { id: 999 } } });
  assert.equal(sent().length, before);

  const sup = await db.insert('suppliers', { name: 'Dadi Toys' });
  const noon = new Date(); // run reminders "now"
  const ln = C.localNow(noon);
  const overdue = await db.insert('crm_tasks', { supplier_id: sup.id, title: 'Late thing', due_date: C.addDays(ln.date, -1) });
  const timed = await db.insert('crm_tasks', { supplier_id: sup.id, title: 'Call about samples', type: 'Call', due_date: ln.date, due_time: '23:59', remind_minutes: 24 * 60 - 1 }); // remind moment = 00:00 today → already due
  const later = await db.insert('crm_tasks', { supplier_id: sup.id, title: 'Future', due_date: C.addDays(ln.date, 5), due_time: '09:00' });

  // digest only after the digest hour
  process.env.CRM_DIGEST_HOUR = '23';
  const early = new Date(Date.now()); if (ln.hour >= 23) process.env.CRM_DIGEST_HOUR = '23';
  const r1 = await C.runReminders({ db, config, now: noon });
  const msgs1 = sent().slice(before).map((c) => c.body.text);
  assert.ok(msgs1.some((x) => /Call about samples/.test(x) && /⏰/.test(x)), 'timed ping');
  assert.ok(db.tables.crm_tasks.find((x) => x.id === timed.id).reminded_at);
  assert.equal(db.tables.crm_tasks.find((x) => x.id === later.id).reminded_at ?? null, null);
  // run again: nothing new is sent
  const n = sent().length; await C.runReminders({ db, config, now: noon }); assert.equal(sent().length, n);
  // digest at/after the hour, once per day
  process.env.CRM_DIGEST_HOUR = '0';
  await C.runReminders({ db, config, now: noon });
  const digest = sent().map((c) => c.body.text).find((x) => /Good morning/.test(x));
  assert.ok(digest && /Late thing/.test(digest) && /Overdue/.test(digest));
  assert.equal(db.tables.settings[0].crm_digest_date, ln.date);
  const n2 = sent().length; await C.runReminders({ db, config, now: noon }); assert.equal(sent().length, n2);
  delete process.env.CRM_DIGEST_HOUR;

  // buttons: snooze then done
  const cb = (data) => hook({ callback_query: { id: 'q1', data, message: { message_id: 5, text: 'x', chat: { id: 42 } } } });
  await cb(`s7:${overdue.id}`);
  assert.equal(db.tables.crm_tasks.find((x) => x.id === overdue.id).due_date, C.addDays(ln.date, 7));
  await cb(`d:${overdue.id}`);
  assert.equal(db.tables.crm_tasks.find((x) => x.id === overdue.id).done, true);
  // commands
  await hook({ message: { text: '/today', chat: { id: 42 } } });
  assert.match(sent().at(-1).body.text, /Today/);
});

test('crm calendar: chips link to the day; logged request activities link to the request', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const C = require('../src/crm'); const today = C.localNow().date;
  const s = await db.insert('suppliers', { name: 'Dadi Toys' });
  const r = await db.insert('info_requests', { supplier_id: s.id, ref: 'LB-1005' });
  await db.insert('supplier_activities', { supplier_id: s.id, type: 'Email', summary: 'Information request LB-1005 sent (Samples)', activity_date: today });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const cal = await req(base, 'GET', `/admin/crm/calendar?day=${today}`, { cookie });
  assert.match(cal.text, /<a class="chip [^"]*" href="\/admin\/crm\/calendar\?m=\d{4}-\d{2}&(?:amp;)?day=\d{4}-\d{2}-\d{2}#day"/);
  assert.ok(cal.text.includes(`href="/admin/requests/${r.id}"`));
  assert.match(cal.text, /Open request LB-1005/);
});

test('mailgun inbound: signed reply is logged with attachment; bad/stale signature refused; unmatched is 200; retries not duplicated', async (t) => {
  process.env.MAILGUN_SIGNING_KEY = 'mg-key';
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => { delete process.env.MAILGUN_SIGNING_KEY; server.close(); });
  const crypto = require('node:crypto');
  const s = await db.insert('suppliers', { name: 'Dadi Toys' });
  const r = await db.insert('info_requests', { supplier_id: s.id, ref: 'LB-1007', status: 'Sent' });
  const sign = (ts, token, key = 'mg-key') => crypto.createHmac('sha256', key).update(ts + token).digest('hex');
  const post = (over = {}, { file = true, ts = String(Math.floor(Date.now() / 1000)), key } = {}) => {
    const token = 'tok' + Math.random();
    const fd = new FormData();
    const fields = { timestamp: ts, token, signature: sign(ts, token, key), from: 'Lily <lily@dadi.example>', recipient: 'requests@in.lulyboo.space', subject: 'Re: Lulyboo information request LB-1007', 'stripped-text': 'Attached are the photos.', 'body-plain': 'Attached are the photos.\n> quoted', ...over };
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('attachment-1', new Blob([Buffer.from('JPEGDATA')], { type: 'image/jpeg' }), 'photo 1.jpg');
    return fetch(`${base}/hooks/mailgun-inbound`, { method: 'POST', body: fd });
  };
  assert.equal((await post({}, { key: 'wrong' })).status, 404);
  assert.equal((await post({}, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status, 404);
  assert.equal(db.tables.info_request_messages?.length || 0, 0);

  const ok = await post();
  assert.equal(ok.status, 200);
  const j = await ok.json(); assert.equal(j.matched, true); assert.equal(j.ref, 'LB-1007');
  const msgs = db.tables.info_request_messages;
  assert.equal(msgs.length, 1); assert.equal(msgs[0].direction, 'in'); assert.equal(msgs[0].body, 'Attached are the photos.');
  assert.match(msgs[0].from_email, /lily@dadi\.example/);
  assert.equal(msgs[0].attachments.length, 1); assert.ok(msgs[0].attachments[0].path);
  assert.ok(db.files.has(msgs[0].attachments[0].path));
  assert.equal(db.tables.info_requests[0].status, 'Replied');

  // Mailgun retry of the same message is not logged twice
  assert.equal((await (await post({}, {})).json()).duplicate, true);
  assert.equal(db.tables.info_request_messages.length, 1);
  // no reference → accepted (so Mailgun stops retrying) but nothing logged
  const none = await post({ subject: 'Hello', 'body-plain': 'x', 'stripped-text': 'x' }, { file: false });
  assert.equal(none.status, 200); assert.equal((await none.json()).matched, false);
  assert.equal(db.tables.info_request_messages.length, 1);
});

test('AI failures show the reason on the page instead of a generic 500', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'bad-key';
  const realFetch = global.fetch;
  const db = seedDb();
  const { server, base } = await startServer(db);
  global.fetch = async (url, opts) => (String(url).startsWith('https://api.anthropic.com') ? new Response('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }) : realFetch(url, opts));
  t.after(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; server.close(); });
  const s = await db.insert('suppliers', { name: 'A' });
  const p = await db.insert('products', { supplier_id: s.id, product_name: 'Swaddle', is_draft: false, status: 'New', unit_price: 3 });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const r = await req(base, 'POST', `/admin/products/${p.id}/ai-review`, { cookie, form: {} });
  assert.equal(r.status, 303); assert.equal(r.location, `/admin/products/${p.id}`);
  const page = await req(base, 'GET', r.location, { cookie: cookie + '; ' + r.cookies.map((x) => x.split(';')[0]).join('; ') });
  assert.match(page.text, /AI request failed: The Anthropic API key was rejected/);
});

test('integration API: Hermes records RFQs (write-only), creates new suppliers, no read access', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => { delete process.env.INTEGRATION_API_KEY; server.close(); });
  const call = (body, { key = 'k'.repeat(32), method = 'POST', path = '/api/v1/rfq' } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) });

  assert.equal((await call({})).status, 503); // not enabled until the key is set
  process.env.INTEGRATION_API_KEY = 'k'.repeat(32);
  assert.equal((await call({ supplier: { name: 'X' }, title: 't' }, { key: 'wrong' })).status, 401);
  assert.equal((await call({ supplier: { name: 'X' }, title: 't' }, { key: null })).status, 401);
  assert.equal((await call({ title: 'no supplier' })).status, 400);
  assert.equal(db.tables.suppliers?.length || 0, 0);

  const payload = { supplier: { name: 'Shantou Dadi Plastic Toys Co., Ltd', email: 'Lily@Dadi.example', contact_name: 'Lily', country: 'China' }, title: 'RFQ: silicone bottle', message: 'Please quote 3000 pcs, FOB Shantou.', channel: 'telegram', contact: '@lily_dadi', products: [{ name: 'Silicone baby bottle', qty: 3000, target_price: '$1.20' }], external_id: 'tg-1', attachments: [{ filename: 'spec.pdf', content_type: 'application/pdf', content_base64: Buffer.from('PDF').toString('base64') }] };
  const r1 = await call(payload);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.match(j1.ref, /^LB-\d+$/); assert.equal(j1.supplier_created, true);
  assert.deepEqual(Object.keys(j1).sort(), ['ok', 'ref', 'request_id', 'supplier_created', 'url']); // nothing else comes back

  const sup = db.tables.suppliers[0];
  assert.equal(sup.email, 'lily@dadi.example'); assert.equal(sup.crm_status, 'Contacted'); assert.equal(sup.country, 'China');
  const rq = db.tables.info_requests[0];
  assert.equal(rq.kind, 'rfq'); assert.equal(rq.channel, 'Telegram'); assert.equal(rq.subject, 'RFQ: silicone bottle');
  const msg = db.tables.info_request_messages[0];
  assert.match(msg.body, /Please quote 3000 pcs/); assert.match(msg.body, /Silicone baby bottle — qty 3000 — target \$1\.20/);
  assert.equal(msg.attachments.length, 1); assert.ok(db.files.has(msg.attachments[0].path));
  assert.ok(db.tables.supplier_activities.some((a) => a.type === 'WeChat/WhatsApp' && a.summary.includes(j1.ref)));
  const task = db.tables.crm_tasks[0];
  assert.equal(task.request_id, rq.id); assert.equal(task.done, false);

  // retry is idempotent
  const dupe = await (await call(payload)).json();
  assert.equal(dupe.duplicate, true); assert.equal(dupe.ref, j1.ref);
  assert.equal(db.tables.info_requests.length, 1);

  // existing supplier matched by name (different punctuation/suffix): reused, nothing overwritten, not reported back
  const again = await (await call({ supplier: { name: 'shantou dadi plastic toys', country: 'Vietnam', phone: '123' }, title: 'Second RFQ', follow_up_days: 0 })).json();
  assert.equal(again.supplier_created, false);
  assert.equal(db.tables.suppliers.length, 1);
  assert.equal(db.tables.suppliers[0].country, 'China'); assert.equal(db.tables.suppliers[0].phone, '123');
  assert.equal(db.tables.crm_tasks.length, 1); // follow_up_days: 0 skips the task

  // no way to read anything back
  for (const [m, p] of [['GET', '/api/v1/rfq'], ['GET', `/api/v1/rfq/${j1.ref}`], ['GET', '/api/v1/suppliers']]) assert.equal((await call(null, { method: m, path: p })).status, 404);

  // shows in the admin Requests list, and a supplier reply closes the follow-up
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const list = await req(base, 'GET', '/admin/requests', { cookie });
  assert.match(list.text, /RFQ · Telegram/); assert.match(list.text, new RegExp(j1.ref));
  const detail = await req(base, 'GET', `/admin/requests/${j1.request_id}`, { cookie });
  assert.match(detail.text, /Please quote 3000 pcs/); assert.match(detail.text, /via Telegram/);
  // The recipient is shown once even when contact and the To list hold the same address.
  Object.assign(db.tables.info_requests[0], { contact: 'a@b.example', to_emails: ['a@b.example'] });
  const detail2 = await req(base, 'GET', `/admin/requests/${j1.request_id}`, { cookie });
  assert.match(detail2.text, /as RFQ via telegram to a@b\.example/i);
  assert.doesNotMatch(detail2.text, /to a@b\.example to a@b\.example/i);
  // Original message: stored, shown behind "Show original message", escaped; summary-only entries show no toggle
  assert.doesNotMatch(detail2.text, /Show original message/);
  const j3 = await (await call({ supplier: { name: 'Orig Co' }, title: 'RFQ orig', message: 'Short summary', original_message: 'From: a\nSubject: Hi <b>x</b>\n\nFull verbatim text', external_id: 'o-1' })).json();
  assert.equal(db.tables.info_request_messages.find((m) => m.request_id === j3.request_id).original.includes('Full verbatim text'), true);
  const d3 = await req(base, 'GET', `/admin/requests/${j3.request_id}`, { cookie });
  assert.match(d3.text, /Show original message/); assert.match(d3.text, /Full verbatim text/); assert.match(d3.text, /Hi &lt;b&gt;x&lt;\/b&gt;/);
});

test('integration API safeguards: audit log, key rotation, rate limits, bad-key throttle, supplier review flag', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  const K1 = 'a'.repeat(32); const K2 = 'b'.repeat(32);
  Object.assign(process.env, { INTEGRATION_API_KEY: K1, API_MAX_CALLS_PER_HOUR: '4', API_MAX_NEW_SUPPLIERS_PER_DAY: '2', API_MAX_FAILED_PER_15MIN: '3' });
  t.after(() => { for (const k of ['INTEGRATION_API_KEY', 'INTEGRATION_API_KEY_NEXT', 'API_MAX_CALLS_PER_HOUR', 'API_MAX_NEW_SUPPLIERS_PER_DAY', 'API_MAX_FAILED_PER_15MIN']) delete process.env[k]; server.close(); });
  const call = (body, key) => fetch(`${base}/api/v1/rfq`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body) });
  const rfq = (n) => ({ supplier: { name: `Supplier ${n}` }, title: `RFQ ${n}`, follow_up_days: 0 });

  // key rotation: the next key works alongside the current one, and is recorded as such
  process.env.INTEGRATION_API_KEY_NEXT = K2;
  assert.equal((await call(rfq(1), K1)).status, 201);
  assert.equal((await call(rfq(2), K2)).status, 201);
  assert.deepEqual(db.tables.api_log.map((x) => x.key_label), ['current', 'next']);
  // new suppliers are flagged for review and capped per day
  assert.ok(db.tables.suppliers.every((s) => s.needs_review === true && s.created_via === 'api'));
  const capped = await call(rfq(3), K1);
  assert.equal(capped.status, 429); assert.match((await capped.json()).error, /new suppliers/);
  assert.equal(db.tables.suppliers.length, 2);
  // existing suppliers are still fine under the supplier cap (counts only new ones)
  assert.equal((await call(rfq(1), K1)).status, 201);
  // hourly cap (4 successful calls so far counts 3; one more allowed, then refused)
  assert.equal((await call(rfq(2), K1)).status, 201);
  assert.equal((await call(rfq(1), K1)).status, 429);
  // repeated bad keys from one address get throttled, even for a later correct key
  for (let i = 0; i < 3; i++) assert.equal((await call(rfq(1), 'nope')).status, 401);
  assert.equal((await call(rfq(1), K1)).status, 429);

  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const log = await req(base, 'GET', '/admin/api-log', { cookie });
  assert.equal(log.status, 200); assert.match(log.text, /203\.0\.113\.9/); assert.match(log.text, /LB-\d+/); assert.match(log.text, /401/); assert.match(log.text, /429/);
  assert.equal((await req(base, 'GET', '/admin/api-log')).status, 303); // admin only

  // review banner, list badge, approve
  const s = db.tables.suppliers[0];
  assert.match((await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie })).text, /Created automatically/);
  assert.match((await req(base, 'GET', '/admin/suppliers', { cookie })).text, /Review/);
  await req(base, 'POST', `/admin/suppliers/${s.id}/approve`, { cookie, form: {} });
  assert.equal(db.tables.suppliers[0].needs_review, false);
  assert.doesNotMatch((await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie })).text, /Created automatically/);
});

// ── Import review: check and approve before anything is saved ─────
test('import review: edits are applied, unticked rows are skipped, duplicates start unticked, bad input and stale tokens are refused', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const s = await db.insert('suppliers', { name: 'Review Factory' });
  const s2 = await db.insert('suppliers', { name: 'Other Factory' });
  const upload = async (supplierId) => {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx'))]), 'quote.xlsx');
    return (await fetch(`${base}/admin/suppliers/${supplierId}/import`, { method: 'POST', body: fd, headers: { cookie } })).text();
  };
  const tokenOf = (h) => /name="token" value="([a-f0-9]{24})"/.exec(h)[1];
  const rowsOf = (h) => [...h.matchAll(/name="r_(\d+)_product_name" data-sync="[^"]*" value="([^"]*)"/g)].map((x) => ({ rn: x[1], name: x[2] }));

  // 1. Upload shows the review with the main fields; nothing is saved yet
  const r1 = await upload(s.id);
  assert.match(r1, /Review before importing/); assert.match(r1, /Approve &amp; import <span data-count>2<\/span>/);
  const rows = rowsOf(r1);
  assert.equal(rows.length, 2);
  assert.equal(db.tables.products?.length || 0, 0);
  // standard file header overview, company check against the supplier we import for
  assert.match(r1, /File header/); assert.match(r1, /Company name/); assert.match(r1, /Ningbo Happy Baby Co\./);
  assert.match(r1, /Payment terms/); assert.match(r1, /30% deposit/); assert.match(r1, /Validity/);
  assert.match(r1, /Company does not match/); assert.match(r1, /Review Factory/);
  // no row-number column; a picture preview opens a pop-up with every field
  assert.doesNotMatch(r1, /<th>Row<\/th>/);
  assert.match(r1, /data-rv-open="rv-dlg-\d+"/); assert.match(r1, /<dialog class="rv-dialog" id="rv-dlg-\d+"/);
  assert.match(r1, /name="x_\d+_description"/); assert.match(r1, /name="x_\d+_materials"/);
  assert.match(r1, /data-rv-cat-apply/);
  const srcLink = /href="([^"]*\/import\/source\?token=[a-f0-9]{24})"/.exec(r1);
  assert.ok(srcLink, 'source file link in the review');
  const pre = await fetch(`${base}${srcLink[1].replace(/&amp;/g, '&')}`, { headers: { cookie } });
  assert.equal(pre.status, 200); assert.equal((await pre.arrayBuffer()).byteLength, fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx')).length);
  // modal: prev/next, calculated packing panel, description tools, AI endpoint refuses without a key
  assert.match(r1, /data-rv-nav=/); assert.match(r1, /data-calc data-rn=/); assert.match(r1, /data-containers=/); assert.match(r1, /data-rv-ai/); assert.match(r1, /Physical specifications/); assert.match(r1, /Compliance/); assert.match(r1, /Container loading/);
  const aiRes = await req(base, 'POST', `/admin/suppliers/${s.id}/import/ai-describe`, { cookie, form: new URLSearchParams({ token: tokenOf(r1), row: rows[0].rn, text: 'hello' }) });
  assert.equal(aiRes.status, 503);
  const aiGone = await req(base, 'POST', `/admin/suppliers/${s.id}/import/ai-describe`, { cookie, form: new URLSearchParams({ token: 'a'.repeat(24), row: '1', text: 'x' }) });
  assert.equal(aiGone.status, 410);
  // file-level terms are not repeated in the pop-up; units live inside the fields
  assert.doesNotMatch(r1, /name="x_\d+_(incoterm|fob_port|payment_terms|quote_valid_until)"/);
  assert.match(r1, /data-unit-group/); assert.match(r1, /class="rv-u-sel"/); assert.match(r1, /class="rv-u">pcs</);
  assert.doesNotMatch(r1, /<dialog[^>]*>[\s\S]*?name="r_\d+_unit_price"[\s\S]*?<\/dialog>/, 'pop-up copies of main fields are not submitted twice');
  const imgSrc = /src="([^"]*\/import\/image\?[^"]*)"/.exec(r1);
  if (imgSrc) {
    const u = imgSrc[1].replace(/&amp;/g, '&');
    const im = await fetch(`${base}${u}`, { headers: { cookie } });
    assert.equal(im.status, 200); assert.equal(im.headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${base}${u.replace(`/suppliers/${s.id}/`, `/suppliers/${s2.id}/`)}`, { headers: { cookie } })).status, 404, 'preview is bound to the supplier');
  }

  // 2. Approve only the first row, with an edited name and price
  const f2 = new URLSearchParams({ token: tokenOf(r1), [`use_${rows[0].rn}`]: '1' });
  for (const { rn, name } of rows) { f2.set(`r_${rn}_product_name`, name); }
  f2.set(`r_${rows[0].rn}_product_name`, 'Edited Name'); f2.set(`r_${rows[0].rn}_unit_price`, '9.99');
  f2.set(`x_${rows[0].rn}_materials`, 'Edited material');
  const ok = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: f2 });
  assert.match(ok.text, /<strong>1<\/strong> products added/);
  assert.equal(db.tables.products.length, 1);
  assert.equal(db.tables.products[0].product_name, 'Edited Name'); assert.equal(db.tables.products[0].unit_price, 9.99);
  assert.equal(db.tables.products[0].supplier_id, s.id);
  assert.equal(db.tables.products[0].materials, 'Edited material');

  // the original file is kept and reachable by link (supplier page, product page, document URL)
  assert.equal(db.tables.supplier_documents.length, 1);
  const doc = db.tables.supplier_documents[0];
  assert.equal(doc.name, 'quote.xlsx'); assert.equal(doc.supplier_id, s.id); assert.equal(db.tables.products[0].source_document_id, doc.id);
  const dl = await fetch(`${base}/admin/documents/${doc.id}`, { headers: { cookie } });
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /quote\.xlsx/);
  assert.equal(Buffer.compare(Buffer.from(await dl.arrayBuffer()), fs.readFileSync(path.join(FIX, 'factory_quotation_filled.xlsx'))), 0);
  const anon = await req(base, 'GET', `/admin/documents/${doc.id}`);
  assert.notEqual(anon.status, 200, 'needs admin login'); assert.match(anon.location || '', /login/);
  assert.match((await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie })).text, new RegExp(`/admin/documents/${doc.id}`));
  assert.match((await req(base, 'GET', `/admin/products/${db.tables.products[0].id}`, { cookie })).text, /Source file: quote\.xlsx/);

  // 3. The same token cannot be used twice
  const again = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: f2 });
  assert.match(again.text, /review expired/); assert.equal(db.tables.products.length, 1);

  // 4. Uploading again: a row whose name is already in the list starts unticked
  await db.insert('products', { supplier_id: s.id, product_name: rows[1].name, is_draft: false, status: 'New' });
  const r2 = await upload(s.id);
  const tick = (h, rn) => new RegExp(`name="use_${rn}" value="1" checked`).test(h);
  assert.equal(tick(r2, rows[0].rn), true); assert.equal(tick(r2, rows[1].rn), false);
  assert.match(r2, /Already in the list/);

  // 5. A bad value is refused with the review shown again, nothing saved
  const before = db.tables.products.length;
  const f5 = new URLSearchParams({ token: tokenOf(r2), [`use_${rows[0].rn}`]: '1', [`r_${rows[0].rn}_unit_price`]: 'abc', [`r_${rows[0].rn}_product_name`]: rows[0].name });
  const bad = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: f5 });
  assert.match(bad.text, /not a valid number/); assert.match(bad.text, /Review before importing/);
  assert.equal(db.tables.products.length, before);
  // ...and ticking nothing is refused too
  const none = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: new URLSearchParams({ token: tokenOf(r2) }) });
  assert.match(none.text, /Tick at least one product/); assert.equal(db.tables.products.length, before);

  // 6. A token belongs to one supplier only
  const other = await req(base, 'POST', `/admin/suppliers/${s2.id}/import/confirm`, { cookie, form: new URLSearchParams({ token: tokenOf(r2), [`use_${rows[0].rn}`]: '1' }) });
  assert.match(other.text, /review expired/); assert.equal(db.tables.products.length, before);

  // 7. Cancel discards the staged file
  const c = await req(base, 'POST', `/admin/suppliers/${s.id}/import/cancel`, { cookie, form: new URLSearchParams({ token: tokenOf(r2) }) });
  assert.equal(c.status, 303);
  const gone = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: new URLSearchParams({ token: tokenOf(r2), [`use_${rows[0].rn}`]: '1' }) });
  assert.match(gone.text, /review expired/);

  // 8. A file with nothing readable goes straight to the problem list (no review to approve)
  const fdBad = new FormData(); fdBad.append('file', new Blob(['just,some,text\n1,2,3\n']), 'bad.csv');
  const bd = await (await fetch(`${base}/admin/suppliers/${s.id}/import`, { method: 'POST', body: fdBad, headers: { cookie } })).text();
  assert.match(bd, /Could not find the header row/); assert.doesNotMatch(bd, /Review before importing/);
});

test('archive, bulk delete and duplicate alert', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const s = await db.insert('suppliers', { name: 'Dup Co' });
  const mk = (n, extra = {}) => db.insert('products', { supplier_id: s.id, product_name: n, is_draft: false, status: 'New', ...extra });
  const a = await mk('Cute Animal Shape Design');
  const a2 = await mk('  cute animal  shape design ');
  const b = await mk('Unique Item');
  const c = await mk('Another');
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((x) => x.split(';')[0]).join('; ');
  const bulk = (action, ids, back) => req(base, 'POST', '/admin/products/bulk', { cookie, form: new URLSearchParams([['action', action], ...(back ? [['back', back]] : []), ...ids.map((i) => ['ids', i])]) });

  // Duplicate alert on both lists; the newer copy is the one pre-marked as "extra"
  for (const url of ['/admin/products', `/admin/suppliers/${s.id}`]) {
    const p = await req(base, 'GET', url, { cookie });
    assert.match(p.text, /Possible duplicates/);
    assert.match(p.text, /data-select-dups/);
    assert.match(p.text, /Duplicate ×2/);
    assert.equal((p.text.match(/data-dupextra/g) || []).length, 1);
    assert.match(p.text, /value="delete"/);
  }
  const only = await req(base, 'GET', '/admin/products?dupes=1', { cookie });
  assert.ok(!only.text.includes('Unique Item'));

  // Archive: hidden from lists, shown in the Archive, restorable
  let r = await bulk('archive', [a2.id, b.id]);
  assert.equal(r.status, 303);
  assert.ok(db.tables.products.find((p) => p.id === b.id).archived_at);
  const list = await req(base, 'GET', '/admin/products', { cookie });
  assert.ok(!list.text.includes('Unique Item'));
  assert.doesNotMatch(list.text, /Possible duplicates/, 'archiving the extra copy clears the alert');
  assert.match(list.text, /Archive \(2\)/);
  const arch = await req(base, 'GET', '/admin/archive', { cookie });
  assert.match(arch.text, /Unique Item/); assert.ok(!arch.text.includes('>Another<'));
  const sp = await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie });
  assert.ok(!sp.text.includes('Unique Item'));
  r = await bulk('unarchive', [b.id], '/admin/archive');
  assert.equal(r.location, '/admin/archive');
  assert.equal(db.tables.products.find((p) => p.id === b.id).archived_at, null);

  // Delete only removes ticked products; nothing ticked is refused
  assert.equal((await bulk('delete', [])).status, 303);
  assert.equal(db.tables.products.length, 4);
  r = await bulk('delete', [c.id, a2.id]);
  assert.deepEqual(db.tables.products.map((p) => p.product_name).sort(), ['Cute Animal Shape Design', 'Unique Item']);
  assert.ok(!db.tables.products.some((p) => p.id === c.id));
});

test('importer reads a standard file header; company names are compared loosely', () => {
  const { readHeader } = require('../src/importer');
  const { companyMatch } = require('../src/import-review');
  const h = readHeader([['Shenzhen Youdeshun Technology Co., Ltd'], ['Add: Building 3, Longgang, Shenzhen'], ['Tel: 0755-123456   Email: admin@youdeshun.cn'], ['Contact: Jack Lee'], ['QUOTATION'], ['Product', 'Price']], 5);
  assert.deepEqual(h, { address: 'Building 3, Longgang, Shenzhen', phone: '0755-123456', contact_name: 'Jack Lee', email: 'admin@youdeshun.cn', company: 'Shenzhen Youdeshun Technology Co., Ltd' });
  assert.equal(readHeader([['FACTORY DETAILS'], ['Phone / WhatsApp', 'Website'], ['Product']], 2).company, undefined);
  assert.equal(companyMatch('Ningbo Happy Baby Co., Ltd', 'Ningbo Happy Baby'), 'match');
  assert.equal(companyMatch('Shenzhen Youdeshun Technology Co., Ltd', 'Youdeshun'), 'match');
  assert.equal(companyMatch('Ningbo Happy Baby Co.', 'Review Factory'), 'mismatch');
  assert.equal(companyMatch('', 'Review Factory'), 'unknown');
});

test('favicon: linked in every page and served at /favicon.ico', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const login = await req(base, 'GET', '/admin/login');
  assert.match(login.text, /rel="icon" href="\/static\/favicon\.svg/); assert.match(login.text, /apple-touch-icon/);
  const ico = await fetch(`${base}/favicon.ico`); assert.equal(ico.status, 200); assert.equal(ico.headers.get('content-type'), 'image/x-icon');
  assert.equal((await fetch(`${base}/static/favicon.svg`)).status, 200);
});

test('staff accounts: owner adds users, roles are enforced, invite flow, last-admin guard, audit', async (t) => {
  const db = seedDb();
  db.tables.suppliers = [{ id: 'sup1', name: 'Acme', active: true }];
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const ck = (r) => r.cookies.map((c) => c.split(';')[0]).join('; ');
  const flashOf = (r) => { const c = r.cookies.find((x) => x.startsWith('lb_flash=')); return c ? decodeURIComponent(c.split(';')[0].slice(9)) : ''; };

  const owner = ck(await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } }));
  assert.match((await req(base, 'GET', '/admin/users', { cookie: owner })).text, /Users &amp; roles/);
  assert.match((await req(base, 'GET', '/admin', { cookie: owner })).text, /user-menu/); // top-right menu

  // Add an admin with a temporary password, a director by invite, a manager with a temporary password
  const add = (form) => req(base, 'POST', '/admin/users', { cookie: owner, form });
  assert.match(flashOf(await add({ name: 'Marsel', username: 'marsel', email: 'Marsel@Lulyboo.com', role: 'admin', password: 'temp-pass-1234' })), /temporary password/);
  const inv = flashOf(await add({ name: 'Dana', username: 'dana', email: 'dana@lulyboo.com', role: 'director' }));
  const token = inv.match(/\/admin\/invite\/([\w-]+)/)[1];
  await add({ name: 'Max', username: 'max', email: 'max@lulyboo.com', role: 'manager', password: 'manager-pass-1' });
  assert.match(flashOf(await add({ name: 'Dup', username: 'MARSEL', email: 'x@y.com', role: 'manager' })), /already used/);
  assert.match(flashOf(await add({ name: 'Bad', username: 'bad user', email: 'x@y.com', role: 'manager' })), /Username/);
  const u = (n) => db.tables.staff_users.find((x) => x.username === n);
  assert.equal(u('marsel').email, 'marsel@lulyboo.com');
  assert.ok(!JSON.stringify(db.tables.staff_users).includes(token), 'invite token stored only as a hash');
  assert.ok(!JSON.stringify(db.tables.staff_users).includes('temp-pass-1234'), 'passwords are hashed');

  // Login: wrong password / by email / must change temp password
  assert.equal((await req(base, 'POST', '/admin/login', { form: { username: 'marsel', password: 'nope' } })).location, '/admin/login');
  const lm = await req(base, 'POST', '/admin/login', { form: { username: 'marsel@lulyboo.com', password: 'temp-pass-1234' } });
  assert.equal(lm.location, '/admin/profile?force=1');
  const marsel = ck(lm);
  assert.equal((await req(base, 'GET', '/admin/products', { cookie: marsel })).location, '/admin/profile?force=1'); // blocked until changed
  const chg = await req(base, 'POST', '/admin/profile/password', { cookie: marsel, form: { password: 'brand-new-pass-1', confirm: 'brand-new-pass-1' } });
  const marsel2 = ck(chg);
  assert.equal((await req(base, 'GET', '/admin/products', { cookie: marsel2 })).status, 200);
  assert.equal((await req(base, 'GET', '/admin/products', { cookie: marsel })).status, 303, 'old session ended after password change');

  // Invite: set password, then signed in as Director
  assert.match((await req(base, 'GET', `/admin/invite/${token}`)).text, /Welcome, Dana/);
  assert.match(flashOf(await req(base, 'POST', `/admin/invite/${token}`, { form: { password: 'short', confirm: 'short' } })), /at least/);
  const set = await req(base, 'POST', `/admin/invite/${token}`, { form: { password: 'dana-secret-123', confirm: 'dana-secret-123' } });
  assert.equal(set.location, '/admin');
  const dana = ck(set);
  assert.equal((await req(base, 'GET', `/admin/invite/${token}`)).status, 410, 'invite link works once');

  // Roles
  const max = ck(await req(base, 'POST', '/admin/login', { form: { username: 'max', password: 'manager-pass-1' } }));
  const maxMain = ck(await req(base, 'POST', '/admin/profile/password', { cookie: max, form: { password: 'manager-pass-2x', confirm: 'manager-pass-2x' } }));
  for (const [c, name, want] of [[owner, 'owner', 200], [marsel2, 'admin', 200], [dana, 'director', 200], [maxMain, 'manager', 200]]) assert.equal((await req(base, 'GET', '/admin/products', { cookie: c })).status, want, name);
  assert.equal((await req(base, 'GET', '/admin/users', { cookie: dana })).status, 403);
  assert.equal((await req(base, 'GET', '/admin/settings', { cookie: dana })).status, 403);
  assert.equal((await req(base, 'GET', '/admin/audit', { cookie: dana })).status, 200); // director may read it
  assert.equal((await req(base, 'GET', '/admin/audit', { cookie: maxMain })).status, 403);
  assert.equal((await req(base, 'POST', '/admin/suppliers/sup1/delete', { cookie: dana })).status, 403);
  assert.equal((await req(base, 'POST', '/admin/suppliers/sup1/delete', { cookie: maxMain })).status, 403);
  assert.equal(db.tables.suppliers.length, 1);
  assert.equal((await req(base, 'GET', '/admin/pricing', { cookie: maxMain })).status, 200); // view-only
  assert.equal((await req(base, 'POST', '/admin/pricing', { cookie: maxMain, form: {} })).status, 403);
  const bulk = await req(base, 'POST', '/admin/products/bulk', { cookie: dana, form: { action: 'delete', ids: 'x' } });
  assert.match(flashOf(bulk), /Only an Admin can delete/);
  assert.doesNotMatch((await req(base, 'GET', '/admin/suppliers/sup1', { cookie: maxMain })).text, /Delete supplier/);
  assert.match((await req(base, 'GET', '/admin/suppliers/sup1', { cookie: marsel2 })).text, /Delete supplier/);
  const menu = (await req(base, 'GET', '/admin', { cookie: maxMain })).text;
  assert.match(menu, /Manager/); assert.doesNotMatch(menu, /Users &amp; roles/); assert.doesNotMatch(menu, /href="\/admin\/settings"/);

  // Last active admin cannot be demoted or deactivated; deactivating signs the user out at once
  const edit = (id, form) => req(base, 'POST', `/admin/users/${id}`, { cookie: marsel2, form });
  assert.match(flashOf(await edit(u('marsel').id, { name: 'Marsel', username: 'marsel', email: 'marsel@lulyboo.com', role: 'manager' })), /last active Admin/);
  assert.match(flashOf(await req(base, 'POST', `/admin/users/${u('marsel').id}/toggle`, { cookie: marsel2 })), /cannot deactivate yourself/);
  await req(base, 'POST', `/admin/users/${u('max').id}/toggle`, { cookie: marsel2 });
  assert.equal((await req(base, 'GET', '/admin/products', { cookie: maxMain })).status, 303);
  assert.equal((await req(base, 'POST', '/admin/login', { form: { username: 'max', password: 'manager-pass-2x' } })).location, '/admin/login');
  await edit(u('dana').id, { name: 'Dana', username: 'dana', email: 'dana@lulyboo.com', role: 'manager' });
  assert.equal((await req(base, 'GET', '/admin/audit', { cookie: dana })).status, 303, 'role change ends the session');

  // Forgot password gives the same answer for any email
  const f1 = await req(base, 'POST', '/admin/forgot', { form: { email: 'dana@lulyboo.com' } });
  const f2 = await req(base, 'POST', '/admin/forgot', { form: { email: 'nobody@x.com' } });
  assert.equal(flashOf(f1), flashOf(f2));
  assert.ok(u('dana').invite_hash, 'reset link created');

  // Audit trail
  const audit = (await req(base, 'GET', '/admin/audit', { cookie: marsel2 })).text;
  for (const w of ['Added user', 'Signed in', 'Failed login', 'Deactivated user', 'Changed role', 'Changed password']) assert.match(audit, new RegExp(w), w);
  assert.ok(db.tables.staff_audit.some((r) => r.action === 'Deleted supplier') === false);
});

test('owner login keeps working when the staff tables do not exist yet', async (t) => {
  const db = seedDb();
  const real = db.list; db.list = async (tbl, ...a) => { if (tbl.startsWith('staff_')) throw new Error('relation does not exist'); return real(tbl, ...a); };
  const g = db.get; db.get = async (tbl, ...a) => { if (tbl.startsWith('staff_')) throw new Error('relation does not exist'); return g(tbl, ...a); };
  const ins = db.insert; db.insert = async (tbl, ...a) => { if (tbl.startsWith('staff_')) throw new Error('relation does not exist'); return ins(tbl, ...a); };
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const owner = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  assert.equal((await req(base, 'GET', '/admin/products', { cookie: owner })).status, 200);
  assert.match((await req(base, 'GET', '/admin/users', { cookie: owner })).text, /staff SQL|staff tables/i);
  assert.equal((await req(base, 'POST', '/admin/login', { form: { username: 'someone', password: 'x' } })).location, '/admin/login');
});

test('dashboard: grouped nav, KPIs, attention counts and filters match the data', async (t) => {
  const db = seedDb();
  const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  db.tables.suppliers = [{ id: 's1', name: 'Acme Co', active: true, crm_status: 'Active' }];
  const mk = (id, over) => ({ id, supplier_id: 's1', product_name: 'P' + id, status: 'New', currency: 'USD', unit_price: 1, is_draft: false, target_stores: [], source: 'form', created_at: new Date().toISOString(), ...over });
  db.tables.products = [mk('a', { category: 'Kitchen' }), mk('b', { category: null }), mk('c', { category: 'Kitchen', status: 'Sample requested' }), mk('d', { category: 'Pet', status: 'Rejected' })];
  db.tables.crm_tasks = [{ id: 't1', supplier_id: 's1', title: 'Late one', due_date: day(-2), done: false, type: 'Follow-up' }, { id: 't2', supplier_id: 's1', title: 'Soon one', due_date: day(2), done: false, type: 'Follow-up' }, { id: 't3', supplier_id: 's1', title: 'Far away', due_date: day(30), done: false, type: 'Follow-up' }];
  db.tables.info_requests = [{ id: 'r1', ref: 'LB-1001', supplier_id: 's1', status: 'Sent', created_at: new Date().toISOString() }];
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const d = (await req(base, 'GET', '/admin', { cookie })).text;
  for (const g of ['Sourcing', 'Catalog', 'Operations', 'AI Tools']) assert.match(d, new RegExp(`class="nav-btn"[^>]*>${g}`));
  assert.match(d, /href="\/admin\/settings"/); assert.doesNotMatch(d, />Orders<|>Purchasing<|>Automations</);
  assert.match(d, /Product development &amp; sourcing overview/);
  assert.match(d, /<span>Awaiting review<\/span><b>2<\/b>/); // a and b are New
  assert.match(d, /<span>Follow-ups due<\/span><b>1<\/b>/); // one overdue, none today
  assert.match(d, /<span>Total products<\/span><b>4<\/b>/);
  assert.match(d, /Late one/); assert.match(d, /Soon one/); assert.doesNotMatch(d, /Far away/); // 7-day window
  assert.doesNotMatch(d, /Image storage/);
  assert.match(d, /Uncategorized products<\/span><b>1<\/b>/);
  assert.match(d, /Sample requests outstanding<\/span><b>1<\/b>/);
  assert.match(d, /awaiting a reply<\/span><b>1<\/b>/);
  // The links the dashboard offers show the same numbers
  const rows = (html) => (html.match(/name="ids" value="/g) || []).length;
  assert.equal(rows((await req(base, 'GET', '/admin/products?status=New', { cookie })).text), 2);
  assert.equal(rows((await req(base, 'GET', '/admin/products?uncategorized=1', { cookie })).text), 1);
  assert.equal(rows((await req(base, 'GET', '/admin/products?status=Sample%20requested', { cookie })).text), 1);
  // Date range only narrows the latest submissions
  db.tables.products[0].created_at = '2020-01-01T00:00:00.000Z';
  const old = (await req(base, 'GET', '/admin?range=7', { cookie })).text;
  assert.doesNotMatch(old, /href="\/admin\/products\/a"/); assert.match(old, /<span>Total products<\/span><b>4<\/b>/);
  // Missing data does not break the page when an optional source fails
  const real = db.list; db.list = async (tbl, ...a) => { if (tbl === 'info_requests') throw new Error('boom'); return real(tbl, ...a); };
  const bad = await req(base, 'GET', '/admin', { cookie });
  assert.equal(bad.status, 200); assert.match(bad.text, /could not be loaded/);
});

test('product workspace: five tabs, split saves, product documents and inline preview', async (t) => {
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const login = await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } });
  const cookie = login.cookies.map((c) => c.split(';')[0]).join('; ');
  const s = await db.insert('suppliers', { name: 'WS Co', active: true });
  const p = await db.insert('products', { supplier_id: s.id, product_name: 'Widget', is_draft: false, status: 'New', unit_price: 2, currency: 'USD', description: 'one\ntwo', target_stores: ['Ross'], review_notes: 'keep' });
  const page = (await req(base, 'GET', `/admin/products/${p.id}`, { cookie })).text;
  for (const id of ['overview', 'costing', 'logistics', 'review', 'documents']) assert.match(page, new RegExp(`id="tab-${id}"`));
  assert.match(page, /AI review/); assert.match(page, /Find similar/); assert.match(page, /data-confirm="Archive this product/);

  // costing save must not touch review fields; review save must not touch pricing
  await req(base, 'POST', `/admin/products/${p.id}/review`, { cookie, form: { section: 'costing', our_wholesale_usd: '5', planned_qty: '1000', logistics_option_id: '' } });
  let row = db.tables.products.find((x) => x.id === p.id);
  assert.equal(row.our_wholesale_usd, 5); assert.equal(row.planned_qty, 1000); assert.deepEqual(row.target_stores, ['Ross']); assert.equal(row.review_notes, 'keep');
  await req(base, 'POST', `/admin/products/${p.id}/review`, { cookie, form: { section: 'review', stores_present: '1', status: 'Shortlisted', score: '4', review_notes: 'good' } });
  row = db.tables.products.find((x) => x.id === p.id);
  assert.equal(row.status, 'Shortlisted'); assert.equal(row.score, 4); assert.deepEqual(row.target_stores, []); assert.equal(row.our_wholesale_usd, 5); assert.equal(row.unit_price, 2);
  await req(base, 'POST', `/admin/products/${p.id}/review`, { cookie, form: { section: 'review', status: 'Rejected' } });
  row = db.tables.products.find((x) => x.id === p.id);
  assert.equal(row.status, 'Rejected'); assert.equal(row.review_notes, 'good', 'quick action leaves notes alone');

  // approved description is saved only through the explicit endpoint
  await req(base, 'POST', `/admin/products/${p.id}/description`, { cookie, form: { description: 'Clean text' } });
  assert.equal(db.tables.products.find((x) => x.id === p.id).description, 'Clean text');

  // product documents: upload, listed with category, preview inline, download, delete
  const fd = new FormData(); fd.append('kind', 'certificate'); fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')]), 'cert.pdf');
  const up = await fetch(`${base}/admin/products/${p.id}/documents`, { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
  assert.equal(up.status, 303);
  const doc = db.tables.supplier_documents.find((d) => d.product_id === p.id);
  assert.ok(doc); assert.equal(doc.kind, 'certificate'); assert.equal(doc.name, 'cert.pdf');
  const after = (await req(base, 'GET', `/admin/products/${p.id}`, { cookie })).text;
  assert.match(after, /cert\.pdf/); assert.match(after, new RegExp(`/admin/documents/${doc.id}\\?inline=1`));
  const inl = await fetch(`${base}/admin/documents/${doc.id}?inline=1`, { headers: { cookie } });
  assert.match(inl.headers.get('content-disposition'), /^inline/); assert.equal(inl.headers.get('content-type'), 'application/pdf');
  assert.match((await fetch(`${base}/admin/documents/${doc.id}`, { headers: { cookie } })).headers.get('content-disposition'), /^attachment/);
  const bad = new FormData(); bad.append('kind', 'other'); bad.append('file', new Blob(['x']), 'run.exe');
  await fetch(`${base}/admin/products/${p.id}/documents`, { method: 'POST', headers: { cookie }, body: bad, redirect: 'manual' });
  assert.equal(db.tables.supplier_documents.filter((d) => d.product_id === p.id).length, 1, 'exe refused');
  await req(base, 'POST', `/admin/products/${p.id}/documents/${doc.id}/delete`, { cookie });
  assert.equal(db.tables.supplier_documents.filter((d) => d.product_id === p.id).length, 0);

  // make a photo the main one
  await db.insert('product_images', { id: 'i1', product_id: p.id, path: 'a', thumb_path: 'a', sort: 0 });
  await db.insert('product_images', { id: 'i2', product_id: p.id, path: 'b', thumb_path: 'b', sort: 1 });
  await req(base, 'POST', `/admin/products/${p.id}/photos/i2/primary`, { cookie });
  assert.equal(db.tables.product_images.find((i) => i.id === 'i2').sort, 0);
  assert.equal(db.tables.product_images.find((i) => i.id === 'i1').sort, 1);
});

test('development projects: private threads, NDA, versions, quotes, milestones and reminders', async (t) => {
  const { hashPassword } = require('../src/auth');
  const P = require('../src/projects');
  const db = seedDb();
  const { server, base } = await startServer(db);
  t.after(() => server.close());
  const admin = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const mk = async (name, email) => {
    const s = await db.insert('suppliers', { name, email, active: true });
    await db.insert('supplier_users', { supplier_id: s.id, email, name, status: 'active', password_hash: await hashPassword('correct horse battery') });
    const c = (await req(base, 'POST', '/login', { form: { email, password: 'correct horse battery' } })).cookies.filter((x) => x.startsWith('lb_sup=')).map((x) => x.split(';')[0]).join('; ');
    return { s, c };
  };
  const A = await mk('Factory A', 'a@a.com'); const B = await mk('Factory B', 'b@b.com');

  // create project + spec + file
  const created = await req(base, 'POST', '/admin/projects', { cookie: admin, form: { name: 'Cat fountain', category: 'Pet', summary: 'Quiet pump fountain' } });
  const proj = db.tables.dev_projects[0]; assert.match(created.location, /^\/admin\/projects\//); assert.equal(proj.ref, 'DP-1001');
  await req(base, 'POST', `/admin/projects/${proj.id}`, { cookie: admin, form: { name: 'Cat fountain', requirements: 'BPA-free PP, 2L', certifications: 'ASTM F963', extra_fields: 'Motor warranty\nRecycled %', target_price_usd: '4.5', internal_notes: 'SECRET-NOTE', nda_required: '1', status: 'Draft' } });
  assert.equal(db.tables.dev_projects[0].extra_fields.length, 2);
  const fd = new FormData(); fd.append('kind', 'drawing'); fd.append('controlling', '1'); fd.append('files', new Blob(['%PDF-1.4 d']), 'drawing-A.pdf');
  fd.append('files', new Blob(['x']), 'bad.exe');
  assert.equal((await fetch(`${base}/admin/projects/${proj.id}/files`, { method: 'POST', headers: { cookie: admin }, body: fd, redirect: 'manual' })).status, 303);
  const fd2 = new FormData(); fd2.append('kind', 'spec'); fd2.append('internal', '1'); fd2.append('files', new Blob(['internal']), 'cost-sheet.pdf');
  await fetch(`${base}/admin/projects/${proj.id}/files`, { method: 'POST', headers: { cookie: admin }, body: fd2, redirect: 'manual' });
  assert.equal(db.tables.dev_files.length, 2); assert.ok(db.tables.dev_files[0].controlling);
  // described upload (per-file meta) and later edit: pages show the description, never the file name
  const fd3 = new FormData(); fd3.append('meta', JSON.stringify([{ kind: 'image', label: 'Colour reference photo', internal: false }])); fd3.append('files', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]), 'IMG_4471.png');
  await fetch(`${base}/admin/projects/${proj.id}/files`, { method: 'POST', headers: { cookie: admin }, body: fd3, redirect: 'manual' });
  const img = db.tables.dev_files.find((x) => x.name === 'IMG_4471.png'); assert.equal(img.kind, 'image'); assert.equal(img.label, 'Colour reference photo');
  await req(base, 'POST', `/admin/projects/${proj.id}/files/${db.tables.dev_files[0].id}/update`, { cookie: admin, form: { label: 'Housing 2D drawing rev B', kind: 'drawing', controlling: '1' } });
  assert.equal(db.tables.dev_files[0].label, 'Housing 2D drawing rev B');
  const filesTab = await req(base, 'GET', `/admin/projects/${proj.id}?tab=files`, { cookie: admin });
  assert.match(filesTab.text, /Housing 2D drawing rev B/); assert.match(filesTab.text, /Colour reference photo/); assert.doesNotMatch(filesTab.text, />\s*drawing-A\.pdf\s*</); assert.doesNotMatch(filesTab.text, />\s*IMG_4471\.png\s*</);
  db.tables.dev_files.splice(db.tables.dev_files.indexOf(img), 1);

  // invite both suppliers
  await req(base, 'POST', `/admin/projects/${proj.id}/invite`, { cookie: admin, body: new URLSearchParams([['supplier_ids', A.s.id], ['supplier_ids', B.s.id], ['message', 'Please quote']]).toString().length ? undefined : undefined, form: { supplier_ids: A.s.id, message: 'Please quote' } });
  await req(base, 'POST', `/admin/projects/${proj.id}/invite`, { cookie: admin, form: { supplier_ids: B.s.id } });
  assert.equal(db.tables.dev_invitations.length, 2); assert.equal(db.tables.dev_projects[0].status, 'Sourcing');
  const invA = db.tables.dev_invitations.find((i) => i.supplier_id === A.s.id); const invB = db.tables.dev_invitations.find((i) => i.supplier_id === B.s.id);

  // supplier A must accept the NDA first and sees only its own stuff
  const gate = await req(base, 'GET', `/portal/projects/${invA.id}`, { cookie: A.c });
  assert.match(gate.text, /Accept and continue/); assert.doesNotMatch(gate.text, /BPA-free/);
  assert.equal((await req(base, 'GET', `/portal/projects/${invA.id}/files/${db.tables.dev_files[0].id}`, { cookie: A.c })).status, 403);
  await req(base, 'POST', `/portal/projects/${invA.id}/nda`, { cookie: A.c, form: { agree: '1' } });
  const view = await req(base, 'GET', `/portal/projects/${invA.id}`, { cookie: A.c });
  assert.match(view.text, /BPA-free PP/); assert.match(view.text, /Housing 2D drawing rev B/); assert.doesNotMatch(view.text, />\s*drawing-A\.pdf\s*</); assert.match(view.text, /Motor warranty/);
  assert.doesNotMatch(view.text, /SECRET-NOTE|cost-sheet|4\.5|Factory B/);
  assert.equal(db.tables.dev_invitations.find((i) => i.id === invA.id).status, 'Viewed');
  assert.equal((await req(base, 'GET', `/portal/projects/${invA.id}/files/${db.tables.dev_files[1].id}`, { cookie: A.c })).status, 404, 'internal file hidden');
  assert.equal((await req(base, 'GET', `/portal/projects/${invB.id}`, { cookie: A.c })).status, 404, 'cannot open another supplier thread');
  assert.equal((await req(base, 'GET', `/portal/projects/${invA.id}/files/${db.tables.dev_files[0].id}`, { cookie: A.c })).status, 200);

  // question and answer
  await req(base, 'POST', `/portal/projects/${invA.id}/message`, { cookie: A.c, form: { body: 'Is wall thickness 2mm ok?' } });
  assert.equal(db.tables.dev_invitations.find((i) => i.id === invA.id).status, 'Questions');
  await req(base, 'POST', `/admin/projects/${proj.id}/suppliers/${invA.id}/message`, { cookie: admin, form: { body: 'Yes, 2mm is fine' } });
  assert.match((await req(base, 'GET', `/portal/projects/${invA.id}`, { cookie: A.c })).text, /Yes, 2mm is fine/);
  assert.doesNotMatch((await req(base, 'GET', `/admin/projects/${proj.id}/suppliers/${invB.id}`, { cookie: admin })).text, /wall thickness/, 'thread of B has no A messages');

  // quote with extra field, then revised quote
  const q1 = await req(base, 'POST', `/portal/projects/${invA.id}/quote`, { cookie: A.c, form: { currency: 'USD', incoterm: 'FOB', qty0: '1000', price0: '4.2', qty1: '3000', price1: '3.9', tooling_cost: '2500', moq: '1000', production_lead_days: '35', sample_lead_days: '10', validity_date: '2026-12-31', x_motor_warranty: '12 months' } });
  assert.equal(q1.status, 303);
  assert.equal(db.tables.dev_quotes.length, 1); assert.equal(db.tables.dev_quotes[0].custom[0].value, '12 months'); assert.equal(db.tables.dev_quotes[0].tiers.length, 2);
  assert.equal(db.tables.dev_invitations.find((i) => i.id === invA.id).status, 'Quoted');
  await req(base, 'POST', `/portal/projects/${invA.id}/quote`, { cookie: A.c, form: { currency: 'USD', qty0: '1000', price0: '4.0', x_motor_warranty: '18 months' } });
  assert.equal(db.tables.dev_quotes.at(-1).revision, 2);
  const noPrice = await req(base, 'POST', `/portal/projects/${invA.id}/quote`, { cookie: A.c, form: { qty0: '1000' } }); assert.equal(db.tables.dev_quotes.length, 2);
  // B declines, then the admin comparison shows only quoted suppliers
  await req(base, 'POST', `/portal/projects/${invB.id}/nda`, { cookie: B.c, form: { agree: '1' } });
  await req(base, 'POST', `/portal/projects/${invB.id}/decline`, { cookie: B.c, form: {} });
  assert.equal(db.tables.dev_invitations.find((i) => i.id === invB.id).status, 'Declined');
  const cmp = (await req(base, 'GET', `/admin/projects/${proj.id}?tab=quotes`, { cookie: admin })).text;
  assert.match(cmp, /Factory A/); assert.match(cmp, /Motor warranty/); assert.doesNotMatch(cmp, /Factory B/);

  // new spec version needs confirmation
  await req(base, 'POST', `/admin/projects/${proj.id}/publish`, { cookie: admin, form: { change_note: 'Wall 2.0mm', notify: '1' } });
  assert.equal(db.tables.dev_projects[0].current_version, 2);
  assert.match((await req(base, 'GET', `/portal/projects/${invA.id}`, { cookie: A.c })).text, /updated to v2/);
  await req(base, 'POST', `/portal/projects/${invA.id}/ack`, { cookie: A.c, form: {} });
  assert.equal(db.tables.dev_invitations.find((i) => i.id === invA.id).ack_version, 2);

  // milestones + reminders
  await req(base, 'POST', `/admin/projects/${proj.id}/milestones`, { cookie: admin, form: { title: 'Samples', due_date: P.addDays(P.today(), 1), remind_days: '2' } });
  await req(base, 'POST', `/admin/projects/${proj.id}/milestones`, { cookie: admin, form: { title: 'Far away', due_date: P.addDays(P.today(), 30), remind_days: '2' } });
  await req(base, 'POST', `/admin/projects/${proj.id}/milestones`, { cookie: admin, form: { title: 'Late', due_date: P.addDays(P.today(), -3) } });
  await req(base, 'POST', `/admin/projects/${proj.id}/milestones/standard`, { cookie: admin, form: {} });
  assert.equal(db.tables.dev_milestones.length, 3 + P.STD_MILESTONES.length);
  const config = { publicUrl: 'http://test' };
  const r1 = await P.runMilestoneReminders({ db, config }); assert.ok(r1.sent >= 2);
  const r2 = await P.runMilestoneReminders({ db, config }); assert.equal(r2.sent, 0, 'no duplicate notices the same day');
  const later = new Date(Date.now() + 86400_000 * 1); const r3 = await P.runMilestoneReminders({ db, config, now: later }); assert.ok(r3.sent >= 1, 'overdue repeats the next day');
  const late = db.tables.dev_milestones.find((x) => x.title === 'Late');
  await req(base, 'POST', `/admin/projects/${proj.id}/milestones/${late.id}/toggle`, { cookie: admin, form: {} });
  assert.ok(db.tables.dev_milestones.find((x) => x.id === late.id).done_at);
  for (const tab of ['spec', 'files', 'suppliers', 'quotes', 'milestones']) assert.equal((await req(base, 'GET', `/admin/projects/${proj.id}?tab=${tab}`, { cookie: admin })).status, 200, tab);
  assert.equal((await req(base, 'GET', '/admin/projects', { cookie: admin })).status, 200);
  assert.equal((await req(base, 'GET', '/portal/projects', { cookie: A.c })).status, 200);
  assert.doesNotMatch((await req(base, 'GET', '/portal/projects', { cookie: B.c })).text, /Factory A/);
});

test('business license: credit code check, upload, AI check saved on the profile', async (t) => {
  const LIC = require('../src/license');
  assert.equal(LIC.checkUSCC('91350100M000100Y43').valid, true);
  assert.equal(LIC.checkUSCC('91350100M000100Y43').province, 'Fujian');
  assert.equal(LIC.checkUSCC('91350100M000100Y44').valid, false);
  assert.equal(LIC.checkUSCC('9135').valid, false);

  const db = seedDb();
  const { server, base } = await startServer(db);
  const realFetch = global.fetch; const prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-key';
  const calls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
    const body = JSON.parse(opts.body); calls.push(body);
    const isLookup = body.tools.some((x) => x.type === 'web_search_20250305');
    const content = isLookup
      ? [{ type: 'web_search_tool_result', content: [{ url: 'https://www.qcc.com/firm/abc.html', title: 'Qichacha' }] }, { type: 'tool_use', name: 'record_registry', input: { found: true, registry_status_en: 'Active (存续)', name_en: 'Fujian Test Toys Co., Ltd.', name_original: '福建测试玩具有限公司', credit_code: '91350100M000100Y43', legal_representative: '张三 (Zhang San)', sources: [{ title: 'Qichacha', url: 'https://www.qcc.com/firm/abc.html' }] } }]
      : [{ type: 'tool_use', name: 'record_license', input: { is_business_license: true, credit_code: '91350100M000100Y43', name_original: '福建测试玩具有限公司', name_en: 'Fujian Test Toys Co., Ltd.', address_en: 'No. 1 Test Road, Fuzhou' } }];
    return new Response(JSON.stringify({ model: 'claude-test', content, stop_reason: 'tool_use', usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { server.close(); global.fetch = realFetch; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  const admin = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const s = await db.insert('suppliers', { name: 'Fujian Test Toys Co., Ltd.', email: 'f@t.com', country: 'China', active: true });
  const fd = new FormData(); fd.append('business_license_no', '9135 0100 M000 100Y43'); fd.append('license_file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'license.jpg');
  assert.equal((await fetch(`${base}/admin/suppliers/${s.id}/license`, { method: 'POST', headers: { cookie: admin }, body: fd, redirect: 'manual' })).status, 303);
  let row = db.tables.suppliers.find((x) => x.id === s.id);
  assert.equal(row.business_license_no, '91350100M000100Y43'); assert.match(row.business_license_path, /^licenses\//);
  const page1 = await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie: admin });
  assert.match(page1.text, /✓ valid · Fujian/);
  assert.equal((await req(base, 'GET', `/admin/suppliers/${s.id}/license-file?inline=1`, { cookie: admin })).status, 200);

  await req(base, 'POST', `/admin/suppliers/${s.id}/license/check`, { cookie: admin, form: {} });
  row = db.tables.suppliers.find((x) => x.id === s.id);
  assert.equal(row.license_info.verdict, 'ok'); assert.equal(row.license_info.registry.registry_status_en, 'Active (存续)');
  assert.equal(calls.length, 2); assert.equal(calls[0].messages[0].content[0].type, 'image');
  const page2 = await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie: admin });
  assert.match(page2.text, /Verified by AI/); assert.match(page2.text, /No. 1 Test Road, Fuzhou/); assert.match(page2.text, /qcc\.com\/firm\/abc/); assert.match(page2.text, /Company name matches the profile/);

  // A different number typed later clears the old check
  await req(base, 'POST', `/admin/suppliers/${s.id}/license`, { cookie: admin, form: { business_license_no: '91350100M000100Y44' } });
  row = db.tables.suppliers.find((x) => x.id === s.id);
  assert.equal(row.license_info, null);
  assert.match((await req(base, 'GET', `/admin/suppliers/${s.id}`, { cookie: admin })).text, /Credit code is not valid/);
});

test('carriers: number detection and DHL / FedEx / UPS answers normalised', async (t) => {
  const CR = require('../src/carriers');
  assert.equal(CR.detect('3471 829 104'), 'dhl');
  assert.equal(CR.detect('778120439925'), 'fedex');
  assert.equal(CR.detect('1Z9X84A04127736512'), 'ups');
  assert.equal(CR.detect('SF1428339022'), null);
  const env = { ...process.env };
  Object.assign(process.env, { DHL_API_KEY: 'k', FEDEX_CLIENT_ID: 'i', FEDEX_CLIENT_SECRET: 's', UPS_CLIENT_ID: 'i', UPS_CLIENT_SECRET: 's' });
  CR._tokens.clear();
  const realFetch = global.fetch; const seen = [];
  global.fetch = async (url, opts = {}) => {
    seen.push(String(url));
    const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/oauth\/token/.test(url)) return J({ access_token: 'tok', expires_in: 3600 });
    if (/api-eu\.dhl\.com/.test(url)) { assert.equal(opts.headers['DHL-API-Key'], 'k'); return J({ shipments: [{ id: '3471829104', status: { timestamp: '2026-11-09T09:42:00Z', statusCode: 'transit', description: 'Customs clearance status updated', location: { address: { addressLocality: 'CINCINNATI HUB - USA', countryCode: 'US' } } }, estimatedTimeOfDelivery: '2026-11-11T18:00:00Z', events: [{ timestamp: '2026-11-09T09:42:00Z', statusCode: 'transit', description: 'Customs clearance status updated', location: { address: { addressLocality: 'CINCINNATI HUB - USA' } } }, { timestamp: '2026-11-04T08:02:00Z', statusCode: 'transit', description: 'Shipment picked up', location: { address: { addressLocality: 'HUIZHOU - CHINA' } } }] }] }); }
    if (/track\/v1\/trackingnumbers/.test(url)) { assert.equal(opts.headers.authorization, 'Bearer tok'); return J({ output: { completeTrackResults: [{ trackResults: [{ latestStatusDetail: { code: 'DL', derivedCode: 'DL', description: 'Delivered', scanLocation: { city: 'LAKE FOREST', stateOrProvinceCode: 'CA', countryCode: 'US' } }, dateAndTimes: [{ type: 'ACTUAL_DELIVERY', dateTime: '2026-11-08T14:02:00-08:00' }], deliveryDetails: { receivedByName: 'M.RAKH' }, scanEvents: [{ date: '2026-11-08T14:02:00-08:00', eventType: 'DL', derivedStatusCode: 'DL', eventDescription: 'Delivered', scanLocation: { city: 'LAKE FOREST' } }] }] }] } }); }
    if (/api\/track\/v1\/details/.test(url)) return J({ trackResponse: { shipment: [{ package: [{ currentStatus: { code: '021', description: 'Out For Delivery Today' }, deliveryDate: [{ type: 'SDD', date: '20261110' }], activity: [{ date: '20261110', time: '071500', status: { type: 'I', code: 'OT', description: 'Out For Delivery Today', statusCode: '021' }, location: { address: { city: 'Irvine', stateProvince: 'CA', countryCode: 'US' } } }] }] }] } });
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; for (const k of ['DHL_API_KEY', 'FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'UPS_CLIENT_ID', 'UPS_CLIENT_SECRET']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } CR._tokens.clear(); });
  const d = await CR.track('dhl', '3471829104');
  assert.equal(d.status, 'customs'); assert.equal(d.events.length, 2); assert.equal(d.eta, '2026-11-11T18:00:00Z'); assert.match(d.location, /CINCINNATI/);
  const f = await CR.track('fedex', '778120439925');
  assert.equal(f.status, 'delivered'); assert.equal(f.signedBy, 'M.RAKH'); assert.equal(f.deliveredAt, '2026-11-08T14:02:00-08:00');
  const u = await CR.track('ups', '1Z9X84A04127736512');
  assert.equal(u.status, 'out_for_delivery'); assert.equal(u.events[0].at, '2026-11-10T07:15:00'); assert.match(u.eta, /^2026-11-10/);
  assert.ok(seen.some((x) => /apis\.fedex\.com\/oauth\/token/.test(x)) && seen.some((x) => /onlinetools\.ups\.com\/security\/v1\/oauth\/token/.test(x)));
  // Tokens are reused
  const n = seen.length; await CR.track('fedex', '778120439925'); assert.equal(seen.length, n + 1);
});

test('samples: request, supplier confirms and ships, carrier tracking moves status, evaluation, reminders', async (t) => {
  const { hashPassword } = require('../src/auth');
  const S = require('../src/samples');
  const CR = require('../src/carriers');
  const db = seedDb();
  const { server, base } = await startServer(db);
  const env = { DHL_API_KEY: process.env.DHL_API_KEY };
  process.env.DHL_API_KEY = 'k'; CR._tokens.clear();
  let dhlState = 'transit';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!/api-eu\.dhl\.com/.test(String(url))) return realFetch(url, opts);
    const ev = [{ timestamp: '2026-11-05T08:00:00Z', statusCode: 'transit', description: 'Shipment picked up', location: { address: { addressLocality: 'HUIZHOU - CHINA' } } }];
    if (dhlState === 'delivered') ev.unshift({ timestamp: '2026-11-09T19:00:00Z', statusCode: 'delivered', description: 'Delivered', location: { address: { addressLocality: 'LAKE FOREST - USA' } } });
    return new Response(JSON.stringify({ shipments: [{ status: ev[0], events: ev, details: dhlState === 'delivered' ? { proofOfDelivery: { signed: { name: 'MARSEL' } } } : {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { server.close(); global.fetch = realFetch; if (env.DHL_API_KEY === undefined) delete process.env.DHL_API_KEY; else process.env.DHL_API_KEY = env.DHL_API_KEY; });

  const admin = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const sup = await db.insert('suppliers', { name: 'Melikey Silicone', email: 'm@melikey.cn', country: 'China' });
  const other = await db.insert('suppliers', { name: 'Other Co', email: 'o@o.cn' });
  const login = async (s, email) => { await db.insert('supplier_users', { supplier_id: s.id, email, name: 'X', status: 'active', password_hash: await hashPassword('correct horse battery') }); return (await req(base, 'POST', '/login', { form: { email, password: 'correct horse battery' } })).cookies.filter((x) => x.startsWith('lb_sup=')).map((x) => x.split(';')[0]).join('; '); };
  const supCookie = await login(sup, 'm@melikey.cn'); const otherCookie = await login(other, 'o@o.cn');

  // Admin requests a sample
  const created = await req(base, 'POST', '/admin/samples', { cookie: admin, form: { title: 'Teether set', supplier_id: sup.id, stage: 'PVT', qty: '3', due_ship_date: '2026-11-05', request_note: 'Pink + mint', internal_notes: 'SECRET-SMP', send_email: '1' } });
  assert.equal(created.status, 303);
  const s0 = db.tables.samples[0]; assert.equal(s0.ref, 'SMP-1001'); assert.equal(s0.status, 'Requested'); assert.equal(s0.eval_checks.length, S.DEFAULT_CHECKS.length);
  assert.match((await req(base, 'GET', '/admin/samples', { cookie: admin })).text, /Teether set/);

  // Supplier: badge, list, own sample only, internal notes hidden
  const plist = await req(base, 'GET', '/portal/samples', { cookie: supCookie });
  assert.match(plist.text, /nav-badge[^>]*>1</); assert.match(plist.text, /Teether set/);
  const pview = await req(base, 'GET', `/portal/samples/${s0.id}`, { cookie: supCookie });
  assert.equal(pview.status, 200); assert.doesNotMatch(pview.text, /SECRET-SMP/); assert.match(pview.text, /Pink \+ mint/);
  assert.equal((await req(base, 'GET', `/portal/samples/${s0.id}`, { cookie: otherCookie })).status, 404);
  assert.doesNotMatch((await req(base, 'GET', '/portal/samples', { cookie: supCookie })).text, /nav-badge[^>]*>1</, 'badge clears after opening');

  // Confirm with a fee → admin sees "Pay sample fee"
  await req(base, 'POST', `/portal/samples/${s0.id}/confirm`, { cookie: supCookie, form: { sample_fee: '30', currency: 'USD', freight_by: 'supplier', due_ship_date: '2026-11-06' } });
  let s = db.tables.samples[0]; assert.equal(s.status, 'Confirmed'); assert.equal(Number(s.sample_fee), 30);
  assert.match((await req(base, 'GET', '/admin/samples?f=action', { cookie: admin })).text, /Pay sample fee/);
  await req(base, 'POST', `/admin/samples/${s0.id}/fee-paid`, { cookie: admin, form: {} });
  assert.ok(db.tables.samples[0].fee_paid_at);

  // Ship with a DHL number (carrier detected) → first check runs immediately
  await req(base, 'POST', `/portal/samples/${s0.id}/ship`, { cookie: supCookie, form: { tracking_no: '3471 829 104', boxes: '1', weight_kg: '0.8', shipped_at: '2026-11-05' } });
  s = db.tables.samples[0];
  assert.equal(s.carrier, 'dhl'); assert.equal(s.tracking_no, '3471829104'); assert.equal(s.status, 'In transit'); assert.equal(s.tracking_status, 'in_transit');
  assert.equal(db.tables.sample_events.filter((e) => e.source === 'dhl').length, 1);
  assert.ok(s.next_check_at > s.last_checked_at, 'next check scheduled');

  // Poller: not due yet → nothing; later → delivered, signed, owner + supplier notified
  assert.equal((await S.runTracking({ db, config: { publicUrl: 'http://test' }, now: s.last_checked_at })).checked, 0);
  dhlState = 'delivered';
  assert.equal((await S.runTracking({ db, config: { publicUrl: 'http://test' }, now: '2099-01-01T00:00:00Z' })).checked, 1);
  s = db.tables.samples[0];
  assert.equal(s.status, 'Delivered'); assert.equal(s.signed_by, 'MARSEL'); assert.equal(s.next_check_at, null);
  assert.equal(db.tables.sample_events.filter((e) => e.source === 'dhl').length, 2, 'only new events stored');
  const detail = await req(base, 'GET', `/admin/samples/${s0.id}`, { cookie: admin });
  assert.match(detail.text, /Evaluate sample/); assert.match(detail.text, /Shipment picked up/);

  // Evaluate → Revise, supplier sees the result and fails
  await req(base, 'POST', `/admin/samples/${s0.id}/evaluate`, { cookie: admin, form: { label_0: 'Dimensions vs drawing', r_0: 'pass', label_1: 'Colour vs reference', r_1: 'fail', label_6: 'Drop test 1 m', r_6: 'pass', eval_notes: 'Mint is too dark', eval_score: '6', result: 'Revise', notify: '1' } });
  s = db.tables.samples[0]; assert.equal(s.status, 'Revise'); assert.equal(s.eval_checks.length, 3); assert.equal(s.eval_score, 6);
  const pres = await req(base, 'GET', `/portal/samples/${s0.id}`, { cookie: supCookie });
  assert.match(pres.text, /Mint is too dark/); assert.match(pres.text, /Colour vs reference/);
  assert.match((await req(base, 'GET', `/admin/samples/new?from=${s0.id}`, { cookie: admin })).text, /Mint is too dark/, 'revised sample request prefilled');

  // Reminders: a late, unshipped sample gets one reminder per day
  const late = await db.insert('samples', { ref: 'SMP-1002', title: 'Bib', supplier_id: sup.id, status: 'Confirmed', due_ship_date: '2026-11-01' });
  const r1 = await S.runReminders({ db, config: { publicUrl: 'http://test' }, now: '2026-11-09T18:00:00Z' });
  assert.ok(r1.sent >= 1); assert.equal(db.tables.samples.find((x) => x.id === late.id).late_reminders, 1);
  await S.runReminders({ db, config: { publicUrl: 'http://test' }, now: '2026-11-09T19:00:00Z' });
  assert.equal(db.tables.samples.find((x) => x.id === late.id).late_reminders, 1, 'not twice the same day');

  // Delete is Admin-only path rule includes samples
  assert.equal((await req(base, 'POST', `/admin/samples/${late.id}/delete`, { cookie: admin, form: {} })).status, 303);
  assert.equal(db.tables.samples.length, 1);
});

test('samples: add an already shipped sample (tracking starts, no request email)', async (t) => {
  const CR = require('../src/carriers');
  const db = seedDb(); const { server, base } = await startServer(db);
  const prev = process.env.DHL_API_KEY; process.env.DHL_API_KEY = 'k';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => (/api-eu\.dhl\.com/.test(String(url)) ? new Response(JSON.stringify({ shipments: [{ status: { timestamp: '2026-11-08T10:00:00Z', statusCode: 'transit', description: 'Arrived at Sort Facility', location: { address: { addressLocality: 'SHENZHEN - CHINA' } } }, events: [{ timestamp: '2026-11-08T10:00:00Z', statusCode: 'transit', description: 'Arrived at Sort Facility' }] }] }), { status: 200 }) : realFetch(url, opts));
  t.after(() => { server.close(); global.fetch = realFetch; if (prev === undefined) delete process.env.DHL_API_KEY; else process.env.DHL_API_KEY = prev; CR._tokens.clear(); });
  const admin = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const sup = await db.insert('suppliers', { name: 'Kangde Silicone', email: 'k@k.cn' });
  assert.match((await req(base, 'GET', '/admin/samples/new?mode=shipped', { cookie: admin })).text, /Add shipped sample/);
  const r0 = await req(base, 'POST', '/admin/samples', { cookie: admin, form: { mode: 'shipped', title: 'Bib', supplier_id: sup.id, tracking_no: '' } });
  assert.match(r0.location, /mode=shipped/); assert.equal((db.tables.samples || []).length, 0, 'tracking number required');
  await req(base, 'POST', '/admin/samples', { cookie: admin, form: { mode: 'shipped', title: 'Bib', supplier_id: sup.id, tracking_no: '3471829104', shipped_at: '2026-11-07', sample_fee: '20', fee_paid: '1' } });
  const s = db.tables.samples[0];
  assert.equal(s.status, 'In transit'); assert.equal(s.carrier, 'dhl'); assert.ok(s.fee_paid_at); assert.equal(String(s.shipped_at).slice(0, 10), '2026-11-07');
  assert.equal(s.due_ship_date, null);
  assert.equal(db.tables.sample_events.filter((e) => e.source === 'dhl').length, 1);
});

test('samples: carrier alert emails to samples@ update the matching sample', async (t) => {
  const crypto = require('node:crypto');
  const S = require('../src/samples');
  assert.equal(S.emailStatus('UPS Update: Package Scheduled for Delivery Tomorrow'), 'in_transit');
  assert.equal(S.emailStatus('Your UPS package was delivered'), 'delivered');
  assert.equal(S.emailStatus('UPS Update: delivery attempted, package not delivered'), 'exception');
  assert.equal(S.emailStatus('Your package is out for delivery'), 'out_for_delivery');
  assert.equal(S.emailStatus('Import duties are due: action required'), 'exception');
  const db = seedDb(); const { server, base } = await startServer(db);
  const prev = process.env.MAILGUN_SIGNING_KEY; process.env.MAILGUN_SIGNING_KEY = 'mg-key';
  t.after(() => { server.close(); if (prev === undefined) delete process.env.MAILGUN_SIGNING_KEY; else process.env.MAILGUN_SIGNING_KEY = prev; });
  const sup = await db.insert('suppliers', { name: 'Lier Baby', email: 'l@l.cn' });
  const s = await db.insert('samples', { ref: 'SMP-1009', title: 'Bowl', supplier_id: sup.id, status: 'Shipped', carrier: 'ups', tracking_no: '1Z9X84A04127736512' });
  const post = async (path, fields) => {
    const ts = String(Math.floor(Date.now() / 1000)); const token = 'tok' + Math.random();
    const body = new URLSearchParams({ timestamp: ts, token, signature: crypto.createHmac('sha256', 'mg-key').update(ts + token).digest('hex'), ...fields });
    return (await fetch(base + path, { method: 'POST', body })).json();
  };
  const r1 = await post('/hooks/mailgun-inbound', { recipient: 'samples@in.lulyboo.space', from: 'UPS <mcinfo@ups.com>', subject: 'UPS Update: Package Scheduled for Delivery Tuesday, 11/10/2026', 'body-plain': 'Tracking Number: 1Z9X 84A0 4127 7365 12\nScheduled Delivery: Tuesday 11/10/2026', 'Message-Id': '<a1@ups.com>' });
  assert.equal(r1.matched, true); assert.equal(db.tables.samples.find((x) => x.id === s.id).status, 'In transit');
  const again = await post('/hooks/mailgun-samples', { from: 'UPS <mcinfo@ups.com>', subject: 'UPS Update: Package Scheduled for Delivery Tuesday, 11/10/2026', 'body-plain': '1Z9X84A04127736512', 'Message-Id': '<a1@ups.com>' });
  assert.equal(again.updated.length, 0, 'same email is not applied twice');
  await post('/hooks/mailgun-samples', { from: 'UPS <mcinfo@ups.com>', subject: 'Your UPS Package was delivered', 'body-plain': 'Tracking Number 1Z9X84A04127736512 delivered at front door', 'Message-Id': '<a2@ups.com>' });
  const row = db.tables.samples.find((x) => x.id === s.id);
  assert.equal(row.status, 'Delivered'); assert.ok(row.delivered_at);
  assert.equal(db.tables.sample_events.filter((e) => e.source === 'email').length, 2);
  const none = await post('/hooks/mailgun-samples', { subject: 'Random', 'body-plain': 'nothing here' });
  assert.equal(none.matched, false);
  const bad = await fetch(base + '/hooks/mailgun-samples', { method: 'POST', body: new URLSearchParams({ timestamp: '1', token: 'x', signature: 'y', subject: 'x' }) });
  assert.equal(bad.status, 404);
});

test('import: a non-standard supplier file (proforma invoice) is read by AI, reviewed, then imported with its pictures', async (t) => {
  const db = seedDb(); const { server, base } = await startServer(db);
  const prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-key';
  const realFetch = global.fetch; let sent = null;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
    sent = JSON.parse(opts.body);
    const p = (row, name, size, price, mat) => ({ source_row: row, product_name: name, supplier_sku: name.slice(0, 5), product_size_cm: size, materials: mat, hs_code: '7323.93.00', packaging_type: 'opp bag', unit_price: price, category: 'Pet' });
    const input = { document_type: 'proforma invoice', currency: 'CNY', incoterm: 'EXW', payment_terms: '100% T/T before delivery', products: [
      p(11, 'PA602 stainless steel pet bowl, anti-slip rubber ring, 18 cm', '18x18x3.9', 5, 'SS201, rubber'), p(12, 'PA602 stainless steel pet bowl, anti-slip rubber ring, 22 cm', '22x22x4.6', 7, 'SS201, rubber'),
      p(13, 'PA855 pet bowl, half silicone base, 14 cm', '14x14x4.3', 9, 'SS201, silicone'), p(14, 'PA855 pet bowl, half silicone base, 18 cm', '18x18x5.6', 12, 'SS201, silicone'),
      p(15, 'PA851 pet bowl, silicone base, 14 cm', '14x14x4.3', 9.5, 'SS201, silicone'), p(16, 'PA851 pet bowl, silicone base, 18 cm', '18x18x5.6', 12.5, 'SS201, silicone')], skipped: ['Freight charge 25 RMB', 'Total 80 RMB'] };
    return new Response(JSON.stringify({ model: 'claude-test', content: [{ type: 'tool_use', name: 'record_products', input }], stop_reason: 'tool_use', usage: {} }), { status: 200 });
  };
  t.after(() => { server.close(); global.fetch = realFetch; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });
  const cookie = (await req(base, 'POST', '/admin/login', { form: { password: 'pw-test', next: '/admin' } })).cookies.map((c) => c.split(';')[0]).join('; ');
  const s = await db.insert('suppliers', { name: 'Guangdong Youdeshun Technology' });
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'proforma_invoice.xlsx'))]), 'Sample_PI.xlsx');
  const res = await fetch(`${base}/admin/suppliers/${s.id}/import`, { method: 'POST', headers: { cookie }, body: fd });
  const page = await res.text();
  assert.match(page, /Read by AI from a proforma invoice/); assert.match(page, /Freight charge/);
  assert.match(sent.messages[0].content.at(-1).text, /R11: +\| 1 \| PA602 \| PA602 Pet bowl/, 'the sheet is sent as numbered rows');
  const token = /name="token" value="([0-9a-f]+)"/.exec(page)[1];
  const rns = [...new Set([...page.matchAll(/name="use_(\d+)"/g)].map((x) => x[1]))];
  assert.deepEqual(rns, ['11', '12', '13', '14', '15', '16']);
  const f2 = new URLSearchParams({ token }); for (const rn of rns) f2.set(`use_${rn}`, '1');
  const ok = await req(base, 'POST', `/admin/suppliers/${s.id}/import/confirm`, { cookie, form: f2 });
  assert.match(ok.text, /<strong>6<\/strong> products added/);
  const made = db.tables.products.filter((x) => x.supplier_id === s.id);
  assert.equal(made.length, 6); assert.equal(made[0].currency, 'CNY'); assert.equal(made[0].incoterm, 'EXW'); assert.equal(Number(made[0].unit_price), 5);
  assert.equal(made[0].units_per_carton ?? null, null, '"opp bag" is not read as a carton quantity');
  assert.ok((db.tables.product_images || []).length >= 6, 'pictures from the sheet are attached');
});
