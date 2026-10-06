#!/usr/bin/env node
/**
 * Generates the menu bar icon (P8-06) into `src-tauri/icons/tray.png`: a planet with a tilted
 * ring, black on transparent, used as a macOS template image (the system tints it for light and
 * dark menu bars). 44 × 44 px (22 pt at 2×), 4 × 4 supersampled, encoded with `node:zlib` — no
 * dependencies (the same approach as apps/web/scripts/pwa-icons.mjs).
 *
 *   node apps/desktop/scripts/tray-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/icons/tray.png');
const SIZE = 44;
const SS = 4;
const TILT = (-20 * Math.PI) / 180;

/** Coverage of one sample point (0..1 units): the planet disc, and the ring outside it. */
function inside(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const planet = dx * dx + dy * dy <= 0.25 * 0.25;
  const c = Math.cos(-TILT);
  const s = Math.sin(-TILT);
  const rx = dx * c - dy * s;
  const ry = dx * s + dy * c;
  const e = (rx / 0.46) ** 2 + (ry / 0.15) ** 2;
  const ring = e <= 1 && e >= 0.62;
  // The ring passes behind the planet's upper half: cut a gap around the disc there.
  const gap = dx * dx + dy * dy <= 0.3 * 0.3 && ry < 0;
  return planet || (ring && !gap);
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++)
        if (inside((x + (sx + 0.5) / SS) / SIZE, (y + (sy + 0.5) / SS) / SIZE)) hit++;
    row[1 + x * 4 + 3] = Math.round((255 * hit) / (SS * SS));
  }
  rows.push(row);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`wrote ${OUT}`);
