'use strict';
// Tiny PDF writer (no dependencies): Helvetica text, filled rectangles and lines on Letter pages.
// Enough for tabular reports. Coordinates: points from the TOP-left (converted internally).
//   const d = pdf.doc(); d.text(x, y, 'Hi', { size: 12, bold: true, color: '#333', align: 'right', width: 100 }); d.rect(...); d.line(...);
//   d.page(); const buf = d.end();

const W = 612; const H = 792; // US Letter

// Helvetica widths (WinAnsi, 1/1000 em) for text measuring / right alignment.
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Characters outside Latin-1 become close ASCII so the standard font can show them.
const ascii = (s) => String(s ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/·/g, '·').replace(/×/g, 'x').replace(/→/g, '->').replace(/✓/g, 'v').replace(/[^\x20-\xff]/g, '?');
const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const rgb = (hex) => { const h = String(hex || '#000').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' '); };

function width(s, size = 10, bold = false) {
  const t = ascii(s); const w = bold ? HBW : HW; let sum = 0;
  for (const ch of t) { const c = ch.charCodeAt(0); sum += c >= 32 && c < 127 ? w[c - 32] : 556; }
  return (sum * size) / 1000;
}
/** Cut text to fit `max` points, adding "...". */
function fit(s, max, size = 10, bold = false) {
  let t = ascii(s); if (width(t, size, bold) <= max) return t;
  while (t.length > 1 && width(t + '...', size, bold) > max) t = t.slice(0, -1);
  return t + '...';
}

function doc() {
  const pages = []; let cur = null;
  const page = () => { cur = []; pages.push(cur); return api; };
  const api = {
    W, H, width, fit,
    page,
    text(x, y, s, { size = 10, bold = false, color = '#222222', align = 'left', width: w = 0 } = {}) {
      let tx = x; const tw = width(s, size, bold);
      if (align === 'right') tx = x + w - tw; else if (align === 'center') tx = x + (w - tw) / 2;
      cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${tx.toFixed(2)} ${(H - y - size).toFixed(2)} Td (${esc(s)}) Tj ET`);
      return api;
    },
    rect(x, y, w, h, { fill = '#eeeeee', stroke = null } = {}) {
      cur.push(`${rgb(fill)} rg ${stroke ? `${rgb(stroke)} RG ` : ''}${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${stroke ? 'B' : 'f'}`);
      return api;
    },
    line(x1, y1, x2, y2, { color = '#dddddd', width: lw = 0.6 } = {}) {
      cur.push(`${rgb(color)} RG ${lw} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`);
      return api;
    },
    end() {
      const objs = [];
      const add = (s) => { objs.push(s); return objs.length; };
      const catalog = add(null); const pagesObj = add(null);
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = [];
      for (const p of pages) {
        const stream = Buffer.from(p.join('\n'), 'latin1');
        const c = add(`<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`);
        kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
      }
      objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
      objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs = [];
      objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = Buffer.byteLength(out, 'latin1');
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return Buffer.from(out, 'latin1');
    },
  };
  page();
  return api;
}

module.exports = { doc, width, fit };
