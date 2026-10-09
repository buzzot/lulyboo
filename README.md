# Lulyboo Supplier Portal

A bilingual (English / 中文) portal where factories submit products, prices, packing data and photos. Lulyboo's team uses it to review quotes, compare landed cost across logistics options, set pricing and pick products for retail placement.

**Stack:** Node.js 22 on Railway · Supabase (Postgres + Storage) · Claude API (optional AI). The only npm dependency is `sharp`, for image compression.

## What's inside

**Supplier sign-up and sign-in**
1. In **Admin → Suppliers → Add supplier**, enter the contact's email. The portal emails them an invitation link, valid for 14 days. You can also copy the link and send it yourself.
2. The supplier opens the link and clicks **Email me a code**. A 6-digit code arrives at that email; it is valid for 10 minutes, with 5 tries.
3. After entering the code, they reach **Company registration**: company name, contact person, phone/WhatsApp/WeChat, address, country and website, then their name and a password (at least 10 characters).
4. From then on they sign in at `/login` with **email + password**. The invitation link stops working after registration.
5. **Forgot password** emails a code, and they set a new password; this signs them out everywhere else. They can also change their password under **Account**.
6. Admins can invite more users per factory, resend invitations, disable a user (signed out immediately) or block a whole supplier.

**Supplier side** (`/portal`, after sign-in)
- Add or edit products one at a time, with up to 10 photos each. Photos are compressed automatically.
- Bulk upload with the Lulyboo Excel template (`public/Lulyboo_Supplier_Product_Template.xlsx`). Factory details and terms that apply to every product (currency, Incoterm, port, payment, valid-until, origin, sample lead time) are entered **once at the top**; then there is **one row per product**. The older Factory Quotation Request form and flat CSV files are also accepted, and combined cells such as `50x35x30` and `9.6/10.6` are split.
- To change the template, edit `scripts/make_template.py` and run `python3 scripts/make_template.py` (needs Python with openpyxl).
- Live container fit (20GP / 40GP / 40HQ) appears while the factory types carton size.
- Suppliers never see your review fields, prices or notes. A product is locked once it is *Selected* or *Rejected*.

**Admin side** (`/admin`, password login)
| Page | What it does |
|---|---|
| Dashboard | Suppliers, products, what's new to review, the shortlist, follow-ups due, a summary by category and image storage used |
| Products | Filter, sort by landed cost or margin, bulk status changes, side-by-side compare, AI compare, CSV export |
| Product page | Pricing breakdown, review (status, score, target stores, wholesale/retail, planned qty, duty override), every logistics option costed, container fit, photos, AI review / find similar |
| Suppliers (CRM) | CRM status, rating, contacts, activity log with follow-ups, portal links (create / replace / turn off), import on a supplier's behalf |
| Categories | Default HS code, duty % and target margin for each category |
| Logistics | Freight options (FCL 20GP/40GP/40HQ, LCL per CBM, air and express per kg) with rates, fees, transit days and a quick calculator |
| Pricing | Every product's landed cost, suggested wholesale, editable wholesale/retail, your margin and the retailer's margin |
| AI | Match equivalent products across suppliers in a category, plus history of all analyses |
| Settings | Exchange rates, default duty / margin / insurance, storage usage |

## How the numbers work (`src/calc.js`)

- **Container fit:** tries all 6 ways of placing the carton, rounding down along each wall, and keeps the best. Then caps the count by payload. Inside dimensions: 20GP 589×235×239, 40GP 1203×235×239, 40HQ 1203×235×269 cm. Payload uses US road limits: about 17.2 t for a 20' and 20 t for a 40'.
- **FCL freight per unit:** (rate + fees per shipment) × containers ÷ qty. Without a planned qty it assumes one full container.
- **LCL:** rate × max(CBM, tonnes, 1) + fees, divided by the order qty (planned qty, otherwise MOQ).
- **Air / express:** chargeable kg = max(gross weight, L×W×H/6000 for air or /5000 for express), × rate, + fees.
- **Landed cost** = price in USD + freight + duty + US customs fees (MPF 0.3464% + HMF 0.125% for ocean) + insurance. Incoterms are respected: CFR/CIF count only destination fees, DAP excludes freight, DDP excludes freight and duty. EXW is flagged.
- **Suggested wholesale** = landed ÷ (1 − category target margin).
- **Automatic checks:** missing carton data, weight mismatches, expired quotes, special cargo (battery/magnet/liquid), children's products without CPSIA/CPC/ASTM, factory container quantity that differs from the calculation, and margin below target.

The AI never calculates. It receives these numbers and is asked to review, match, compare and explain. HS codes and duty rates it suggests must be verified on [hts.usitc.gov](https://hts.usitc.gov). Remember Section 301 tariffs for China-origin goods.

## Image storage

Each upload is auto-rotated, stripped of metadata and saved as WebP: a full image (longest side 1,600 px) plus a 400 px thumbnail. Originals are discarded. A typical product photo comes to **~150–400 KB** for both together (a detailed 12 MP phone photo of 5.7 MB came out at 400 KB in testing), versus 3–8 MB for a raw phone photo.

| Supabase plan | Storage included | Roughly |
|---|---|---|
| Free | 1 GB | ~4,000 photos |
| Pro ($25/mo) | 100 GB, then ~$0.021/GB | ~400,000 photos |

Example: 50 suppliers × 200 products × 5 photos = 50,000 photos ≈ 12–15 GB, which needs Pro. Use Pro for real use anyway: Free projects can be paused when inactive and have smaller egress (5 GB vs 250 GB). Check current terms at supabase.com/pricing. The bucket is private, and the app serves photos through short-lived signed links. Settings shows space used and remaining capacity; set `STORAGE_PLAN_GB` to match your plan.

## Setup

### 1. Supabase
1. Create a project at supabase.com. Pick a US region (e.g. `us-west-1`).
2. Open **SQL Editor**, paste `supabase/schema.sql` and click **Run**. This creates the tables, the private `product-images` bucket, example categories and example logistics options. It's safe to run again.
3. From **Project Settings → API**, copy the **Project URL** and the **secret key** (`sb_secret_…`, or the legacy `service_role` key). Keep the secret key on the server only.

### 2. Email (Resend)
1. Create an account at resend.com and add your domain (e.g. `lulyboo.com`). Add the DNS records Resend shows (SPF/DKIM) at your domain provider and wait until the domain shows as verified. Factory mailboxes (QQ, 163, Alibaba) need these records for mail to arrive.
2. Create an API key and use it as `RESEND_API_KEY`. Set `EMAIL_FROM`, e.g. `Lulyboo Supplier Portal <portal@lulyboo.com>`.
3. Without a key, emails are printed in the Railway logs instead of sent. That's fine for a first test, not for suppliers.

### 3. Railway
1. Push this folder to a GitHub repo, then in Railway choose **New Project → Deploy from GitHub repo**.
2. Under **Variables**, add the values from `.env.example`: at least `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET` (`openssl rand -hex 32`), `RESEND_API_KEY` and `EMAIL_FROM`. Optional: `ANTHROPIC_API_KEY`, `STORAGE_PLAN_GB=100`, `PUBLIC_URL`.
3. Under **Settings → Networking**, generate a domain or add your own (e.g. `portal.lulyboo.com`). Set `PUBLIC_URL` to it so supplier links use the right address.
4. Deploy. Railway runs `npm install` and `npm start`, and checks `/health`.

### 4. First steps
1. Open `/admin` and log in.
2. **Logistics:** replace the example freight rates with your forwarder's quotes and pick the default option.
3. **Categories:** set duty % and target margin for each category. **Settings:** check exchange rates.
4. **Suppliers → Add supplier.** Enter the factory contact's email; they receive the invitation. Test it first with your own second email address.

### Local preview without Supabase
```bash
npm install
npm run demo        # http://localhost:3000/admin  password: demo
                    # supplier: /login  lily@example.com / demo-password
                    # new-supplier invite: /s/demo-invite-link-000000000000 (code shown on screen)
npm test            # 12 tests: calculations, importers, images, full HTTP flow
```
The demo uses sample data in memory.

## Security notes
- **Each supplier sees only its own data.** Every supplier page loads the signed-in user's own supplier from the server-side session; product IDs belonging to another supplier return "not found". The test suite checks this.
- **Passwords** are hashed with scrypt (salted) and never stored or logged in plain text. The minimum length is 10 characters.
- **Email codes** are 6 digits, stored hashed, valid for 10 minutes, with 5 attempts each. There is at most 1 code per minute and 5 per hour, and any new code cancels the old one.
- **Invitation links** use a random 192-bit token, stored only as a hash. They expire after 14 days and work once.
- **Sessions** use an HMAC-signed cookie (30 days, HttpOnly, Secure, SameSite=Lax). A password change, password reset or disabled user ends every session immediately.
- **Rate limits** apply per IP and per email to sign-in, codes and resets. "Forgot password" gives the same answer whether or not an account exists.
- **Cross-site form posts** are rejected (Origin check). `Referrer-Policy: same-origin` keeps tokens from leaking to other sites. Pages are marked `noindex`.
- All tables have Row Level Security turned on with no policies, so the public anon key can read nothing. Only this server, using the secret key, can.
- The admin session is an HMAC-signed cookie that lasts 14 days. Login is rate-limited to 10 attempts per 15 minutes per IP.

## Files
```
src/server.js           HTTP server, security headers, routing
src/calc.js             container fit, freight, landed cost, pricing, checks
src/fields.js           product fields (EN/CN labels, template headers, validation)
src/importer.js         CSV / XLSX reader and column mapping (template + quotation form)
src/images.js           sharp compression and storage upload
src/ai.js               Claude API prompts and structured outputs
src/db.js               Supabase REST and Storage client
src/routes/*.js         supplier portal, admin, admin tools
supabase/schema.sql     database schema and storage bucket
public/                 CSS, JS, Excel template (built by scripts/make_template.py)
scripts/demo.js         local demo with sample data
test/                   node:test suite with fixtures
```
