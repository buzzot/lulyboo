'use strict';
// Local demo with sample data and no Supabase: `npm run demo`, then open http://localhost:3000/admin
// (password: demo). Supplier logins are printed on start. Emails (codes) are printed to the console.
// Data lives in memory only.
const http = require('node:http');
const sharp = require('sharp');
const { createApp, buildConfig } = require('../src/server');
const { seedDb } = require('../test/memory-db');
const S = require('../src/services');
const { saveProductImages } = require('../src/images');

(async () => {
  const db = seedDb();
  const config = { ...buildConfig({ ...process.env, ADMIN_PASSWORD: 'demo', SESSION_SECRET: 'demo', SUPABASE_URL: '' }), showDevCodes: true };
  delete process.env.RESEND_API_KEY;
  // Serve stored images locally in demo mode
  db.storage.signedUrls = async (paths) => Object.fromEntries(paths.filter(Boolean).map((p) => [p, `data:image/webp;base64,${(db.files.get(p) || Buffer.alloc(0)).toString('base64')}`]));

  const A = require('../src/auth');
  const inviteToken = 'demo-invite-link-000000000000';
  const today = new Date();
  const d = (days) => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const sups = await db.insert('suppliers', [
    { name: 'Ningbo Happy Baby Textile Co.', contact_name: 'Lily Chen', email: 'lily@example.com', country: 'China', crm_status: 'Quoting', rating: 4, categories_supplied: 'Swaddles, bibs, blankets', next_follow_up: d(-1), registered_at: new Date().toISOString(), phone: '+86 138 0000 0000', address: 'Yinzhou District, Ningbo, Zhejiang' },
    { name: 'Shenzhen SoftNest Products', contact_name: 'Kevin Wu', email: 'kevin@example.com', country: 'China', crm_status: 'Active', rating: 5, categories_supplied: 'Baby textiles, pet beds' },
    { name: 'Hangzhou PawPal Pet Supplies', contact_name: 'Amy Zhao', country: 'China', crm_status: 'Contacted', rating: 3, categories_supplied: 'Pet toys, tunnels' },
    { name: 'Pending: minh@example.com', email: 'minh@example.com', country: 'Vietnam', crm_status: 'Contacted' },
  ]);
  await db.insert('supplier_users', [
    { supplier_id: sups[0].id, email: 'lily@example.com', name: 'Lily Chen', status: 'active', password_hash: await A.hashPassword('demo-password'), last_login_at: new Date().toISOString() },
    { supplier_id: sups[3].id, email: 'minh@example.com', status: 'invited', invite_token_hash: A.sha256(inviteToken), invite_expires_at: d(14) + 'T00:00:00Z' },
  ]);
  const base = (o) => ({ currency: 'USD', incoterm: 'FOB', fob_port: 'Ningbo', country_of_origin: 'China', ...o });
  const products = await db.insert('products', [
    base({ supplier_id: sups[0].id, product_name: 'Organic muslin swaddle 2-pack', supplier_sku: 'NB-SW2', category: 'Infant/Toddler', subcategory: 'Swaddles', materials: '100% organic cotton muslin', product_size_cm: '120 x 120', certifications: 'CPSIA, OEKO-TEX', unit_price: 3.2, moq: 1000, production_lead_days: 45, units_per_carton: 24, carton_l_cm: 50, carton_w_cm: 35, carton_h_cm: 30, carton_nw_kg: 9.6, carton_gw_kg: 10.6, supplier_qty_40hq: 28000, status: 'Shortlisted', our_wholesale_usd: 7.5, our_retail_usd: 16.99, target_stores: ['Ross', 'TJ Maxx'], score: 4 }),
    base({ supplier_id: sups[1].id, product_name: 'Muslin swaddle blanket set (2 pcs)', supplier_sku: 'SN-1102', category: 'Infant/Toddler', subcategory: 'Swaddles', materials: 'Cotton muslin (not organic)', product_size_cm: '115 x 115', certifications: 'CPSIA', currency: 'CNY', unit_price: 19.5, moq: 2000, production_lead_days: 35, units_per_carton: 30, carton_l_cm: 55, carton_w_cm: 38, carton_h_cm: 32, carton_gw_kg: 12.4, fob_port: 'Shenzhen', status: 'Reviewing' }),
    base({ supplier_id: sups[0].id, product_name: 'Silicone bib with food catcher', supplier_sku: 'NB-B01', category: 'Infant/Toddler', subcategory: 'Feeding', materials: 'Food-grade silicone', certifications: 'FDA, CPSIA', unit_price: 1.15, moq: 3000, production_lead_days: 30, units_per_carton: 100, carton_l_cm: 45, carton_w_cm: 32, carton_h_cm: 28, carton_gw_kg: 9.5, status: 'New' }),
    base({ supplier_id: sups[2].id, product_name: '3-way collapsible cat tunnel', supplier_sku: 'PP-T3', category: 'Pet', subcategory: 'Cat toys', materials: 'Polyester, spring steel', unit_price: 2.85, moq: 500, production_lead_days: 40, units_per_carton: 20, carton_l_cm: 60, carton_w_cm: 40, carton_h_cm: 35, carton_gw_kg: 8, fob_port: 'Shanghai', status: 'New', our_wholesale_usd: 4.25 }),
    base({ supplier_id: sups[1].id, product_name: 'Calming donut pet bed, 60 cm', supplier_sku: 'SN-PB60', category: 'Pet', subcategory: 'Beds', materials: 'Faux fur, PP cotton', unit_price: 6.9, moq: 300, production_lead_days: 35, units_per_carton: 4, carton_l_cm: 62, carton_w_cm: 62, carton_h_cm: 45, carton_gw_kg: 6.8, status: 'Sample requested', our_wholesale_usd: 13, our_retail_usd: 29.99 }),
    base({ supplier_id: sups[3].id, product_name: 'Bamboo baby blanket', category: 'Infant/Toddler', subcategory: 'Blankets', materials: 'Bamboo viscose', unit_price: 4.1, moq: 800, fob_port: 'Ho Chi Minh', country_of_origin: 'Vietnam', status: 'New' }),
  ]);
  const colors = ['#e8b4a8', '#cfd8e3', '#f2d49b', '#b9d6c2', '#d8c7e8', '#f1c6c6'];
  for (const [i, p] of products.entries()) {
    const img = await sharp({ create: { width: 900, height: 900, channels: 3, background: colors[i] } }).jpeg().toBuffer();
    await saveProductImages(db, { supplierId: p.supplier_id, productId: p.id, files: [{ name: 'p.jpg', type: 'image/jpeg', buffer: img }] });
  }
  await db.insert('supplier_activities', [
    { supplier_id: sups[0].id, type: 'WeChat/WhatsApp', summary: 'Asked for CPC and lab test report for swaddles', activity_date: d(-5), follow_up_date: d(-1) },
    { supplier_id: sups[1].id, type: 'Sample', summary: 'Pet bed sample shipped via DHL', activity_date: d(-2) },
  ]);

  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp({ db, config })).listen(port, () => {
    console.log(`Demo running: http://localhost:${port}/admin  (password: demo)`);
    console.log(`Supplier sign-in: http://localhost:${port}/login  (lily@example.com / demo-password)`);
    console.log(`New-supplier invitation: http://localhost:${port}/s/${inviteToken}  (the code is shown on screen in demo mode)`);
  });
})();
