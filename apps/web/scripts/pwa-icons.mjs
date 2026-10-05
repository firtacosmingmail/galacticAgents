#!/usr/bin/env node
/**
 * Generates the PWA icons (P7-01) into `apps/web/public/icons/`: a blue planet with an orbit ring
 * and an amber satellite on the panel's deep-space slate.
 *
 *   icon.svg                 the vector version (favicon, "any" size)
 *   icon-192.png, icon-512.png   "any" purpose
 *   icon-maskable-512.png    "maskable": the drawing shrunk into the 80 % safe zone
 *   apple-touch-icon.png     180 × 180, iOS Home Screen
 *
 * The PNGs are rasterised here (4 × 4 supersampling) and encoded with `node:zlib`; no
 * dependencies beyond Node ≥ 22.2. Usage (from the repo root):
 *
 *   node apps/web/scripts/pwa-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');

// The panel's tokens (panel.css): background, "here" blue, the beacon amber.
const BG_CENTRE = [0x1d, 0x26, 0x4a];
const BG_EDGE = [0x0b, 0x0e, 0x17];
const PLANET_LIT = [0x9c, 0xbc, 0xff];
const PLANET_DARK = [0x1f, 0x35, 0x80];
const RING = [0xb4, 0xc6, 0xf0];
const SATELLITE = [0xff, 0xb5, 0x47];
const STARS = [
  [0.2, 0.22, 0.008],
  [0.78, 0.17, 0.006],
  [0.86, 0.72, 0.007],
  [0.16, 0.8, 0.006],
  [0.66, 0.88, 0.005],
];

// The drawing, in units of the icon's side (0..1, centre 0.5).
const PLANET_R = 0.21;
const RING_RX = 0.36;
const RING_RY = 0.12;
const RING_W = 0.02;
const TILT = (-20 * Math.PI) / 180;
const SAT_T = 0.35 * Math.PI; // where on the ring the satellite sits (front half)
const SAT_R = 0.04;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v) => Math.max(0, Math.min(1, v));

/** The ring's frame: x along the major axis, y along the minor one. */
function toRing(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const c = Math.cos(-TILT);
  const s = Math.sin(-TILT);
  return [dx * c - dy * s, dx * s + dy * c];
}

function satellitePos() {
  const rx = RING_RX * Math.cos(SAT_T);
  const ry = RING_RY * Math.sin(SAT_T);
  const c = Math.cos(TILT);
  const s = Math.sin(TILT);
  return [0.5 + rx * c - ry * s, 0.5 + rx * s + ry * c];
}

/** The colour at a point (u, v in 0..1 of the drawing). */
function shade(u, v) {
  const d = Math.hypot(u - 0.5, v - 0.5) / 0.75;
  let col = mix(BG_CENTRE, BG_EDGE, clamp(d));
  for (const [sx, sy, sr] of STARS) {
    if (Math.hypot(u - sx, v - sy) < sr) col = [230, 236, 255];
  }
  const [rx, ry] = toRing(u, v);
  // Distance to the ring ellipse, approximately (scaled radial distance).
  const e = Math.hypot(rx / RING_RX, ry / RING_RY);
  const onRing = Math.abs(e - 1) * Math.min(RING_RX, RING_RY) * 1.6 < RING_W / 2;
  const front = ry > 0; // the lower half of the tilted ellipse passes in front of the planet
  const pr = Math.hypot(u - 0.5, v - 0.5);
  const inPlanet = pr < PLANET_R;
  if (onRing && !front) col = mix(col, RING, 0.85);
  if (inPlanet) {
    // Lit from the upper left: a hemisphere's normal against the light direction.
    const nx = (u - 0.5) / PLANET_R;
    const ny = (v - 0.5) / PLANET_R;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const light = clamp(-0.55 * nx - 0.6 * ny + 0.58 * nz);
    col = mix(PLANET_DARK, PLANET_LIT, light);
  }
  if (onRing && front) col = mix(col, RING, 0.9);
  const [sx, sy] = satellitePos();
  if (Math.hypot(u - sx, v - sy) < SAT_R) col = SATELLITE;
  return col;
}

function render(size, scale) {
  const n = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const px = (x + (i + 0.5) / n) / size;
          const py = (y + (j + 0.5) / n) / size;
          // Shrink the drawing about the centre (the maskable icon's safe zone).
          const c = shade(0.5 + (px - 0.5) / scale, 0.5 + (py - 0.5) / scale);
          acc = acc.map((a, k) => a + c[k]);
        }
      }
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(acc[k] / (n * n));
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function svg() {
  const s = 512;
  const [sx, sy] = satellitePos();
  const deg = (TILT * 180) / Math.PI;
  const stars = STARS.map(
    ([x, y, r]) => `<circle cx="${x * s}" cy="${y * s}" r="${r * s}" fill="#e6ecff"/>`,
  ).join('');
  const ring = (half) =>
    `<path d="M ${0.5 * s - RING_RX * s} ${0.5 * s} A ${RING_RX * s} ${RING_RY * s} 0 0 ${half} ${0.5 * s + RING_RX * s} ${0.5 * s}" fill="none" stroke="${hex(RING)}" stroke-width="${RING_W * s}" transform="rotate(${deg} ${0.5 * s} ${0.5 * s})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
<defs>
<radialGradient id="bg" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="${hex(BG_CENTRE)}"/><stop offset="1" stop-color="${hex(BG_EDGE)}"/></radialGradient>
<radialGradient id="planet" cx="32%" cy="30%" r="80%"><stop offset="0" stop-color="${hex(PLANET_LIT)}"/><stop offset="1" stop-color="${hex(PLANET_DARK)}"/></radialGradient>
</defs>
<rect width="${s}" height="${s}" fill="url(#bg)"/>
${stars}
${ring(1)}
<circle cx="${0.5 * s}" cy="${0.5 * s}" r="${PLANET_R * s}" fill="url(#planet)"/>
${ring(0)}
<circle cx="${(sx * s).toFixed(1)}" cy="${(sy * s).toFixed(1)}" r="${SAT_R * s}" fill="${hex(SATELLITE)}"/>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.8],
  ['apple-touch-icon.png', 180, 1],
];
for (const [name, size, scale] of icons) {
  writeFileSync(path.join(OUT, name), png(size, render(size, scale)));
  console.log(`wrote ${name}`);
}
writeFileSync(path.join(OUT, 'icon.svg'), svg());
console.log('wrote icon.svg');
