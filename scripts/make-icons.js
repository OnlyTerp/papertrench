#!/usr/bin/env node
/* Regenerate every icon in the repo from brand/logo.png.
 *
 *   node scripts/make-icons.js          write the icons
 *   node scripts/make-icons.js --check  verify they match the master (CI-safe)
 *
 * Pure Node — zlib is the only dependency and it ships with the runtime. A
 * build step that needs `npm i sharp` is a build step that rots the first time
 * someone clones on a machine without a toolchain, and this one runs about
 * twice a year.
 *
 * The mark is CROPPED to its own bounding box before scaling. The master is a
 * 1024px square with the plane occupying roughly the middle third; scaled
 * whole, the 16px toolbar icon would be a four-pixel smudge. Cropping to the
 * ink and re-padding by a fixed fraction is what makes the small sizes read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'brand', 'logo.png');

// Every icon the repo serves, and the size it is used at.
const TARGETS = [
  ['extension/icons/icon16.png', 16],
  ['extension/icons/icon48.png', 48],
  ['extension/icons/icon128.png', 128],
  ['site/assets/icon128.png', 128],
];

/* ----------------------------------------------------------------- decode */

function inflate(buf) { return zlib.inflateSync(buf); }

/** Minimal PNG reader: 8-bit truecolour (type 2) or truecolour+alpha (6). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (depth ${depth}, colorType ${colorType})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflate(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2). `a` is the pixel to the
  // left, `b` above, `c` above-left — all zero outside the image.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = (y > 0 && i >= channels) ? out[dst - stride + i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter type ' + filter);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/* ----------------------------------------------------------------- encode */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Write 8-bit RGB. Filter 0 throughout: these are tiny, and a deterministic
 *  byte stream means --check can compare hashes instead of pixels. */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- process */

/**
 * The bounding box of the mark.
 *
 * "Ink" is any pixel meaningfully brighter than the corner colour, which is
 * the background by construction. A fixed RGB threshold would break the moment
 * the brand background shifts a shade; sampling the actual corner does not.
 */
function inkBounds(img) {
  const { width, height, channels, data } = img;
  const at = (x, y) => (y * width + x) * channels;
  const bg = [data[0], data[1], data[2]];
  const far = (i) => (
    Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
  ) > 40;

  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (far(at(x, y))) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('no mark found — is brand/logo.png blank?');
  return { x0, y0, x1, y1, bg };
}

/** Square crop centred on the mark, with `pad` of breathing room each side. */
function squareCrop(img, pad = 0.12) {
  const { x0, y0, x1, y1 } = inkBounds(img);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const side = Math.round(Math.max(w, h) * (1 + pad * 2));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    sx: Math.round(cx - side / 2),
    sy: Math.round(cy - side / 2),
    side,
  };
}

/**
 * Box-filter downsample: every destination pixel averages the full block of
 * source pixels it covers.
 *
 * Nearest-neighbour would alias the plane's long diagonals into a staircase at
 * 16px, which is the size where the icon has to work hardest. Averaging is the
 * cheap correct answer when only ever shrinking.
 */
function resize(img, crop, size) {
  const { width, height, channels, data, } = img;
  const out = Buffer.alloc(size * size * 3);
  const bg = [data[0], data[1], data[2]];
  const scale = crop.side / size;

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const sx0 = Math.floor(crop.sx + dx * scale);
      const sy0 = Math.floor(crop.sy + dy * scale);
      const sx1 = Math.max(sx0 + 1, Math.floor(crop.sx + (dx + 1) * scale));
      const sy1 = Math.max(sy0 + 1, Math.floor(crop.sy + (dy + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          // Outside the master reads as background, so a crop that overhangs
          // the edge pads with the brand colour rather than black or garbage.
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
            r += bg[0]; g += bg[1]; b += bg[2];
          } else {
            const i = (sy * width + sx) * channels;
            r += data[i]; g += data[i + 1]; b += data[i + 2];
          }
          n++;
        }
      }
      const d = (dy * size + dx) * 3;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- main */

const check = process.argv.includes('--check');

if (!fs.existsSync(MASTER)) {
  console.error(`missing master: ${path.relative(ROOT, MASTER)}`);
  process.exit(1);
}

const master = decodePng(fs.readFileSync(MASTER));
const crop = squareCrop(master);
console.log(`master ${master.width}x${master.height} → mark at `
  + `${crop.sx},${crop.sy} ${crop.side}px square`);

let stale = 0;
for (const [rel, size] of TARGETS) {
  const file = path.join(ROOT, rel);
  const png = encodePng(size, size, resize(master, crop, size));
  const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const same = current && current.equals(png);

  if (check) {
    if (!same) { console.error(`  STALE  ${rel}`); stale++; }
    else console.log(`  ok     ${rel} (${size}px, ${png.length}b)`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    console.log(`  ${same ? 'unchanged' : 'wrote'}  ${rel} (${size}px, ${png.length}b)`);
  }
}

if (check && stale) {
  console.error(`\n${stale} icon(s) do not match brand/logo.png — run: node scripts/make-icons.js`);
  process.exit(1);
}
if (check) console.log('\nall icons match the master');
