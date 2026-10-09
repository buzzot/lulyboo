'use strict';
const m = (en, zh) => `⟪${en}⟫⟦${zh}⟧`; // bilingual message (see lib/html.js)
// Image processing: every upload is auto-rotated, stripped of metadata and stored as
//   • full-size WebP, longest side ≤ 1600 px (~150–400 KB)
//   • thumbnail WebP, longest side ≤ 400 px  (~15–40 KB)
// Originals are not kept, which keeps Supabase storage ~10× smaller than raw phone photos.

const crypto = require('node:crypto');
const sharp = require('sharp');

const FULL_PX = Number(process.env.IMAGE_MAX_PX || 1600);
const THUMB_PX = 400;
const ACCEPT = /^image\/(jpeg|jpg|png|webp|gif|tiff|avif|heic|heif)$/i;

async function processImage(buffer) {
  const img = sharp(buffer, { failOn: 'none', limitInputPixels: 120_000_000 }).rotate();
  const full = await img.clone()
    .resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await img.clone()
    .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
  return { full: full.data, width: full.info.width, height: full.info.height, thumb };
}

/**
 * Process and store uploaded files for a product. Returns { saved: n, errors: [] }.
 * files: [{ name, type, size, buffer }]
 */
async function saveProductImages(db, { supplierId, productId, files, existingCount = 0, maxImages = 10 }) {
  const errors = [];
  let saved = 0;
  let sort = existingCount;
  for (const f of files || []) {
    if (sort >= maxImages) { errors.push(m(`Max ${maxImages} images per product: skipped ${f.name}`, `每个产品最多 ${maxImages} 张图片，已跳过 ${f.name}`)); continue; }
    if (f.type && !ACCEPT.test(f.type)) { errors.push(m(`${f.name}: not a supported image type`, `${f.name}：不支持的图片格式`)); continue; }
    let out;
    try { out = await processImage(f.buffer); } catch (e) { errors.push(m(`${f.name}: could not read image`, `${f.name}：无法读取该图片`)); continue; }
    const id = crypto.randomUUID();
    const path = `${supplierId}/${productId}/${id}.webp`;
    const thumbPath = `${supplierId}/${productId}/${id}_t.webp`;
    await db.storage.upload(path, out.full, 'image/webp');
    await db.storage.upload(thumbPath, out.thumb, 'image/webp');
    await db.insert('product_images', {
      id, product_id: productId, path, thumb_path: thumbPath,
      bytes: out.full.length + out.thumb.length, width: out.width, height: out.height, sort,
    });
    sort++; saved++;
  }
  return { saved, errors };
}

async function deleteImages(db, images) {
  await db.storage.remove(images.flatMap((i) => [i.path, i.thumb_path]));
  for (const i of images) await db.remove('product_images', { id: i.id });
}

module.exports = { processImage, saveProductImages, deleteImages, FULL_PX, THUMB_PX };
