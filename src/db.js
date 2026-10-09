'use strict';
// Supabase access over its REST APIs (PostgREST + Storage) using fetch.
// Interface (also implemented by test/memory-db.js):
//   list(table, { filters, order, limit, offset, select })  → rows
//   get(table, id) → row | null
//   insert(table, row | rows) → inserted row(s)
//   update(table, filters, patch) → updated rows
//   remove(table, filters) → void
//   storage.upload(path, buffer, contentType), storage.signedUrls(paths, seconds), storage.remove(paths)
//
// filters: { col: value }            → col = value
//          { col: ['in', [a,b]] }     → col in (a,b)
//          { col: ['is', null] }      → col is null
//          { col: ['ilike', '%x%'] }  → case-insensitive match
//          { col: ['lte', v] } etc.   → eq, neq, lt, lte, gt, gte, cs (array contains)

const BUCKET = 'product-images';

function createSupabaseDb({ url, key }) {
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const base = url.replace(/\/$/, '');
  const authHeaders = { apikey: key };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only use apikey.
  if (key.startsWith('eyJ')) authHeaders.Authorization = `Bearer ${key}`;

  async function call(method, path, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...authHeaders, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Supabase ${method} ${path.split('?')[0]} failed: ${res.status} ${text.slice(0, 300)}`);
      err.status = 500;          // never show database details to visitors; full text goes to the server log
      err.upstreamStatus = res.status;
      throw err;
    }
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const fmtVal = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '(' + v.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',') + ')';
    return String(v);
  };
  function qs({ filters = {}, order, limit, offset, select } = {}) {
    const p = new URLSearchParams();
    p.set('select', select || '*');
    for (const [col, f] of Object.entries(filters)) {
      if (f === undefined) continue;
      if (Array.isArray(f)) {
        const [op, v] = f;
        if (op === 'cs') p.append(col, `cs.{${[].concat(v).map((x) => `"${x}"`).join(',')}}`);
        else p.append(col, `${op}.${fmtVal(v)}`);
      } else p.append(col, f === null ? 'is.null' : `eq.${f}`);
    }
    if (order) p.set('order', order);
    if (limit) p.set('limit', String(limit));
    if (offset) p.set('offset', String(offset));
    return p.toString();
  }

  const db = {
    async list(table, opts = {}) {
      if (opts.limit) return call('GET', `/rest/v1/${table}?${qs(opts)}`);
      // Page through everything (PostgREST caps responses at 1000 rows by default).
      const all = []; const page = 1000;
      for (let off = 0; ; off += page) {
        const rows = await call('GET', `/rest/v1/${table}?${qs({ ...opts, limit: page, offset: off })}`);
        all.push(...rows);
        if (rows.length < page) break;
      }
      return all;
    },
    async get(table, id) {
      const rows = await call('GET', `/rest/v1/${table}?${qs({ filters: { id }, limit: 1 })}`);
      return rows[0] || null;
    },
    async insert(table, rows) {
      const many = Array.isArray(rows);
      const out = await call('POST', `/rest/v1/${table}`, { body: rows, headers: { Prefer: 'return=representation' } });
      return many ? out : out[0];
    },
    async update(table, filters, patch) {
      if (!filters || !Object.keys(filters).length) throw new Error('update requires filters');
      return call('PATCH', `/rest/v1/${table}?${qs({ filters })}`, { body: patch, headers: { Prefer: 'return=representation' } });
    },
    async remove(table, filters) {
      if (!filters || !Object.keys(filters).length) throw new Error('remove requires filters');
      await call('DELETE', `/rest/v1/${table}?${qs({ filters })}`);
    },
    storage: {
      async upload(path, buffer, contentType) {
        await call('POST', `/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
          body: buffer, headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
        });
      },
      async signedUrls(paths, expiresIn = 3600) {
        const uniq = [...new Set(paths.filter(Boolean))];
        if (!uniq.length) return {};
        const out = {};
        for (let i = 0; i < uniq.length; i += 200) {
          const res = await call('POST', `/storage/v1/object/sign/${BUCKET}`, { body: { expiresIn, paths: uniq.slice(i, i + 200) } });
          for (const item of res || []) {
            const u = item.signedURL || item.signedUrl;
            if (u && !item.error) out[item.path] = u.startsWith('http') ? u : `${base}/storage/v1${u}`;
          }
        }
        return out;
      },
      async download(path) {
        const res = await call('GET', `/storage/v1/object/${BUCKET}/${encodeURI(path)}`, { raw: true });
        return Buffer.from(await res.arrayBuffer());
      },
      async remove(paths) {
        const list = paths.filter(Boolean);
        if (list.length) await call('DELETE', `/storage/v1/object/${BUCKET}`, { body: { prefixes: list } });
      },
    },
  };
  return db;
}

module.exports = { createSupabaseDb, BUCKET };
