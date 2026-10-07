/**
 * Gera os icones PNG do PWA.
 * Sem dependencia externa: monta o RGBA pixel a pixel e codifica o PNG
 * com zlib (nativo do Node). Mesmo visual do SVG do logo.
 *
 * Execute: node scripts/generate-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../server/config.js';

const OUT = path.join(ROOT, 'web', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------ PNG encoder ------------------------------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------ desenho ----------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 4; // superamostragem para bordas suaves
  const gradientA = [0x25, 0xf4, 0xee];
  const gradientB = [0x7b, 0x5c, 0xff];
  const gradientC = [0xfe, 0x2c, 0x55];
  const bg = [0x0b, 0x0b, 0x0c];
  const fg = [0xf5, 0xf8, 0xff];

  const pad = maskable ? size * 0.14 : size * 0.06;
  const box = size - pad * 2;
  const boxCenter = size / 2;
  const boxHalf = box / 2;
  const radius = box * (maskable ? 0.16 : 0.22);
  const ringWidth = size * 0.03;

  // Glifo: barra vertical + ponto (o "P")
  const barW = box * 0.19;
  const barH = box * 0.42;
  const barCx = pad + box * 0.36;
  const barCy = pad + box * 0.5;
  const dotR = box * 0.062;
  const dotCx = barCx + box * 0.15;
  const dotCy = barCy;
  // "play" triangular a direita
  const triX0 = pad + box * 0.62;
  const triX1 = triX0 + box * 0.17;
  const triCy = pad + box * 0.5;
  const triH = box * 0.26;

  const acc = new Float32Array(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const x = px + (sx + 0.5) / scale;
          const y = py + (sy + 0.5) / scale;

          // fundo arredondado (ou quadrado cheio em maskable)
          const bgDist = maskable
            ? -1
            : roundedRectDistance(x, y, boxCenter, boxCenter, boxHalf, boxHalf, radius);
          const bgAlpha = clamp01(0.5 - bgDist);
          let color = bg;
          let alpha = bgAlpha;

          if (alpha > 0) {
            // anel de gradiente: alpha 1 entre ringInner e ringOuter, 0 fora
            const ringOuter = boxHalf;
            const ringInner = boxHalf - ringWidth;
            const dist = Math.hypot(x - boxCenter, y - boxCenter);
            const holeFade = smooth(ringInner - 0.7, ringInner + 0.7, dist);
            const outerFade = 1 - smooth(ringOuter - 0.7, ringOuter + 0.7, dist);
            const ringAlpha = clamp01(holeFade * outerFade) * bgAlpha;
            if (ringAlpha > 0) {
              const t = clamp01((x - pad) / box + (y - pad) / box) / 2;
              let grad;
              if (t < 0.5) grad = mix(gradientA, gradientB, t * 2);
              else grad = mix(gradientB, gradientC, (t - 0.5) * 2);
              color = mix(color, grad, ringAlpha);
              alpha = Math.max(alpha, ringAlpha * 0.95);
            }

            // glifo "P"
            const inBar = roundedRectDistance(x, y, barCx, barCy, barW / 2, barH / 2, barW * 0.35) < 0;
            const inDot = Math.hypot(x - dotCx, y - dotCy) < dotR;
            const inTri = x >= triX0 && x <= triX1
              && Math.abs(y - triCy) < (triH / 2) * (1 - (x - triX0) / (triX1 - triX0));
            if (inBar || inDot || inTri) {
              const glyphAlpha = 0.96 * bgAlpha;
              color = mix(color, fg, glyphAlpha);
              alpha = Math.max(alpha, glyphAlpha);
            }
          }

          r += color[0] * alpha;
          g += color[1] * alpha;
          b += color[2] * alpha;
          a += alpha;
        }
      }

      const samples = scale * scale;
      const alphaAvg = a / samples;
      const idx = (py * size + px) * 4;
      if (alphaAvg > 0.0001) {
        // des-premultiplica
        acc[idx] = Math.round(r / a);
        acc[idx + 1] = Math.round(g / a);
        acc[idx + 2] = Math.round(b / a);
        acc[idx + 3] = Math.round(clamp01(alphaAvg) * 255);
      }
    }
  }

  for (let i = 0; i < acc.length; i += 1) rgba[i] = Math.max(0, Math.min(255, acc[i]));
  return encodePng(size, size, rgba);
}

const targets = [
  { size: 192, maskable: false },
  { size: 512, maskable: false },
  { size: 512, maskable: true },
  { size: 180, maskable: false }, // apple-touch-icon
];

for (const { size, maskable } of targets) {
  const png = drawIcon(size, { maskable });
  const name = maskable ? `icon-maskable-${size}.png` : `icon-${size}.png`;
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`${name} - ${(png.length / 1024).toFixed(1)} KB`);
}

// Apple touch icon usa o mesmo arquivo 180
if (fs.existsSync(path.join(OUT, 'icon-180.png'))) {
  fs.copyFileSync(path.join(OUT, 'icon-180.png'), path.join(OUT, 'apple-touch-icon.png'));
}

console.log('Icones gerados em web/icons/');
