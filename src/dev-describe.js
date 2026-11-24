'use strict';
// New development project: AI reads the reference files (photos, PDF, Word, Excel, text) plus the name and the
// buyer's rough notes, and writes a short plain-English description a factory understands.
// It may suggest a product name and a category when those are empty. Prices are never put in the text.

const AI = require('./ai');
const IM = require('./importer');

const IMG = /^image\/(png|jpeg|webp|gif)$/;
const MAX_FILES = 8; const MAX_TEXT = 12000; const MAX_BYTES = 15 * 1024 * 1024;

const extOf = (n) => (String(n).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
const strip = (x) => IM.xmlDecode(String(x).replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Text of a Word / Excel / text file, or null. */
function textOf(f) {
  const e = extOf(f.name);
  try {
    if (e === '.txt' || e === '.csv' || e === '.md') return f.buffer.toString('utf8');
    if (e === '.docx') { const x = IM.unzipEntries(f.buffer, (n) => n === 'word/document.xml')['word/document.xml']; return x ? strip(x.toString('utf8')) : null; }
    if (e === '.xlsx') return IM.parseXlsx(f.buffer).filter((r) => r.some((c) => c !== '')).map((r) => r.filter((c) => c !== '').join(' | ')).join('\n');
  } catch { return null; }
  return null;
}
const mimeOf = (f) => {
  const e = extOf(f.name);
  if (e === '.pdf') return 'application/pdf';
  if (e === '.png') return 'image/png'; if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'; if (e === '.webp') return 'image/webp'; if (e === '.gif') return 'image/gif';
  return f.type || '';
};

/** Content blocks for the files: images and PDFs as they are, documents as text. Returns { blocks, read, skipped }. */
function fileBlocks(files) {
  const blocks = []; const read = []; const skipped = []; let text = 0;
  for (const f of files.slice(0, MAX_FILES)) {
    if (!f?.buffer?.length) continue;
    const mt = mimeOf(f);
    if ((IMG.test(mt) || mt === 'application/pdf') && f.buffer.length <= MAX_BYTES) {
      const data = f.buffer.toString('base64');
      blocks.push({ type: 'text', text: `File: ${f.name}` }, mt === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mt, data } } : { type: 'image', source: { type: 'base64', media_type: mt, data } });
      read.push(f.name); continue;
    }
    const t = textOf(f);
    if (t && t.trim() && text < MAX_TEXT) { const part = t.slice(0, MAX_TEXT - text); text += part.length; blocks.push({ type: 'text', text: `File: ${f.name}\n---\n${part}\n---` }); read.push(f.name); continue; }
    skipped.push(f.name);
  }
  for (const f of files.slice(MAX_FILES)) skipped.push(f.name);
  return { blocks, read, skipped };
}

const TOOL = {
  name: 'project_brief',
  description: 'Short description of a new product for factories, plus a suggested name and category.',
  input_schema: {
    type: 'object',
    properties: {
      enough: { type: 'boolean', description: 'true only if the files/notes/name say what the physical product actually is (more than a bare name or placeholder text)' },
      description: { type: 'string', description: 'Only when enough is true: 2-4 short sentences in simple English a Chinese factory understands, describing the PRODUCT itself: what it is, material, size or quantity, key features, colours, packaging, age range. Only what the files and notes say. Never mention the buyer, the notes, the files, missing information, quotation or this task. No prices, target costs or margins. No marketing words. Empty string when enough is false.' },
      name: { type: 'string', description: 'Short product name, e.g. "Silicone teether set of 3". Max 8 words.' },
      category: { type: 'string', description: 'One of the given categories, exactly as written, or empty if none fits' },
      missing: { type: 'array', items: { type: 'string' }, description: 'Up to 3 important facts a factory will ask for that are not given (e.g. size, material, packaging)' },
    },
    required: ['enough', 'description'],
  },
};

async function describe({ files = [], name = '', category = '', notes = '', categories = [] }) {
  const { blocks, read, skipped } = fileBlocks(files);
  const text = [
    `Product name: ${name || '(empty: suggest one)'}`,
    `Category: ${category || `(empty: choose one of: ${categories.join(' | ') || 'none given'})`}`,
    `Buyer's rough notes (any language, may include internal prices that must NOT appear in the description):\n${notes || '(none)'}`,
    read.length ? `Reference files above: ${read.join(', ')}.` : 'No reference files.',
    'Write the description for factories.',
  ].join('\n\n');
  const { result } = await AI.callTool({ tool: TOOL, maxTokens: 900, content: [...blocks, { type: 'text', text }],
    system: 'You write product descriptions for Lulyboo, a US brand of infant/toddler and pet products, to send to Chinese factories for quotation. Write clear, short, factual English with simple words. Never invent specifications that the files or notes do not show. Never mention prices, costs, targets or margins. If the input does not say what the product is, set enough=false instead of writing about the input.' });
  if (result.enough === false || !String(result.description || '').trim()) {
    return { enough: false, description: '', name: '', category: '', missing: (Array.isArray(result.missing) ? result.missing : []).slice(0, 3).map(String), read, skipped };
  }
  const cat = categories.find((c) => c.toLowerCase() === String(result.category || '').trim().toLowerCase()) || '';
  const desc = String(result.description || '').replace(/\$\s?\d[\d.,]*/g, '').trim(); // belt and braces: no prices
  return { enough: true, description: desc, name: String(result.name || '').trim().slice(0, 160), category: cat, missing: (Array.isArray(result.missing) ? result.missing : []).slice(0, 3).map(String), read, skipped };
}

module.exports = { describe, fileBlocks, textOf };
