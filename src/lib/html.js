'use strict';
// Tiny HTML templating: html`...` escapes every interpolated value
// unless it is itself html`` output (or wrapped with raw()).

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += esc(vals[i]); });
  return new Raw(out);
}

// Formatting helpers
const fmt = {
  money(n, cur = 'USD', digits = 2) {
    if (n === null || n === undefined || n === '') return '—';
    const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : cur === 'EUR' ? '€' : '';
    return sym + Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 3) }) + (sym ? '' : ` ${cur}`);
  },
  num(n, digits = 0) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  pct(n) { return n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`; },
  date(d) { if (!d) return '—'; const s = String(d); return s.length > 10 ? new Date(s).toISOString().slice(0, 10) : s; },
  bytes(b) {
    b = Number(b || 0);
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  },
};

module.exports = { html, raw, esc, Raw, fmt };
