/**
 * 生成应用图标（PNG）。
 *
 * 为什么自己画：环境里没有图像库，而 AndroidManifest 引用了 @mipmap/ic_launcher，
 * 缺图标会直接导致 aapt2 link 失败。Node 自带 zlib，手写一个 PNG 编码器最省事。
 *
 * 图案：深色圆角底 + 四道竖线（四条线路）+ 中央盾形（国王）。
 *
 * 用法：node tools/make-icon.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const RES = path.join(ROOT, 'android', 'app', 'res');

// ── 极简 PNG 编码器 ───────────────────────────────────────
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(width*height*4) → PNG Buffer */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 画图标 ────────────────────────────────────────────────
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    px[i] = Math.round(px[i] * (1 - sa) + r * sa);
    px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
    px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
    px[i + 3] = Math.max(px[i + 3], a);
  };

  const cx = (size - 1) / 2;
  const radius = size * 0.22;
  const ss = 3; // 超采样抗锯齿

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0, accG = 0, accB = 0, accA = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;

          // 圆角矩形遮罩
          const dx = Math.max(Math.abs(fx - cx) - (size / 2 - radius), 0);
          const dy = Math.max(Math.abs(fy - cx) - (size / 2 - radius), 0);
          const outside = Math.hypot(dx, dy) - radius;
          if (outside > 0) continue; // 透明

          // 底色：深蓝渐变
          const t = fy / size;
          let r = Math.round(13 + t * 10);
          let g = Math.round(20 + t * 22);
          let b = Math.round(30 + t * 34);

          // 四道竖线（四条线路）
          const laneW = size * 0.035;
          for (let i = 0; i < 4; i++) {
            const lx = size * (0.2 + i * 0.2);
            if (Math.abs(fx - lx) < laneW / 2 && fy > size * 0.2 && fy < size * 0.8) {
              r = 42; g = 60; b = 82;
            }
          }

          // 中央盾形
          if (isInShield(fx / size, fy / size)) {
            const grad = 1 - (fy / size);
            r = Math.round(200 + grad * 40);
            g = Math.round(150 + grad * 40);
            b = Math.round(50 + grad * 30);
          }

          accR += r; accG += g; accB += b; accA += 255;
        }
      }
      const n = ss * ss;
      if (accA > 0) set(x, y, accR / n, accG / n, accB / n, accA / n);
    }
  }
  return px;
}

/** 归一化坐标下的盾形判定 */
function isInShield(u, v) {
  const cx = 0.5;
  const top = 0.26;
  const bottom = 0.76;
  if (v < top || v > bottom) return false;
  const t = (v - top) / (bottom - top);
  // 上半部近似矩形，下半部收窄成尖角
  const halfW = t < 0.55 ? 0.155 : 0.155 * (1 - Math.pow((t - 0.55) / 0.45, 1.6));
  return Math.abs(u - cx) < halfW;
}

// ── 输出各密度 ────────────────────────────────────────────
const DENSITIES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

for (const { dir, size } of DENSITIES) {
  const outDir = path.join(RES, dir);
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePNG(size, size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), png);
  console.log(`  ${dir}/ic_launcher.png  ${size}x${size}  ${png.length} B`);
}
console.log('✅ 图标生成完成');
