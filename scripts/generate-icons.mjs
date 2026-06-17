// Generate the PWA icons (no image deps) — amber field with a dark Blue Ridge
// mountain silhouette and a road centerline. Run: node scripts/generate-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS = path.join(ROOT, 'icons');
fs.mkdirSync(ICONS, { recursive: true });

function crc32(buf) { return zlib.crc32(buf) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// point in triangle
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const c = 1 - a - b;
  return a >= 0 && b >= 0 && c >= 0;
}

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b) => { const i = (y * size + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; };
  const amber = [0xff, 0xb0, 0x2e], dark = [0x16, 0x13, 0x0c], paint = [0xff, 0xc9, 0x40];
  const S = size;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let c = amber;
    // sky/field amber; two mountains
    const m1 = inTri(x, y, 0.50 * S, 0.26 * S, 0.10 * S, 0.78 * S, 0.62 * S, 0.78 * S);
    const m2 = inTri(x, y, 0.72 * S, 0.36 * S, 0.42 * S, 0.78 * S, 0.94 * S, 0.78 * S);
    if (m1 || m2) c = dark;
    // ground band (road) below the mountains
    if (y > 0.78 * S) c = dark;
    set(x, y, c[0], c[1], c[2]);
  }
  // dashed road centerline on the ground band
  const set2 = (x, y, col) => { if (x >= 0 && x < S && y >= 0 && y < S) { const i = (y * S + x) * 4; rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = 255; } };
  const cy = Math.round(0.89 * S), h = Math.max(2, Math.round(0.02 * S)), dash = Math.round(0.10 * S), gap = Math.round(0.06 * S);
  for (let x = Math.round(0.08 * S); x < 0.92 * S; x += dash + gap)
    for (let dx = 0; dx < dash; dx++) for (let dy = -h; dy <= h; dy++) set2(x + dx, cy + dy, paint);
  return png(S, rgba);
}

for (const s of [192, 512]) {
  const buf = makeIcon(s);
  fs.writeFileSync(path.join(ICONS, `icon-${s}.png`), buf);
  console.log(`wrote icons/icon-${s}.png (${Math.round(buf.length / 1024)} KB)`);
}
