'use strict';
// Minimal ZIP writer (deflate), for downloading several files at once. No external libraries.
const zlib = require('node:zlib');

function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}

/** files: [{ name, data: Buffer }] → Buffer of a .zip. Duplicate names get " (2)". { paths: true } keeps folders in names (a/b.xml). */
function zip(files, { paths = false } = {}) {
  const parts = []; const central = []; let offset = 0; const seen = new Map();
  for (const f of files) {
    let name = String(f.name || 'file').replace(paths ? /[\\:*?"<>|]+/g : /[\\/:*?"<>|]+/g, '_');
    const n = (seen.get(name) || 0) + 1; seen.set(name, n);
    if (n > 1) name = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(f.data); const comp = zlib.deflateRawSync(data); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

module.exports = { zip, crc32 };
