import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFreeSpace, DEFAULT_RESERVE_BYTES, formatBytes, treeSize } from './space.js';

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-space-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const GiB = 2 ** 30;

describe('formatBytes', () => {
  it('names sizes in binary units', () => {
    expect(formatBytes(5)).toBe('5 bytes');
    expect(formatBytes(12 * 1024)).toBe('12 KiB');
    expect(formatBytes(1.5 * GiB)).toBe('1.5 GiB');
    expect(formatBytes(320 * 2 ** 20)).toBe('320 MiB');
  });
});

describe('checkFreeSpace', () => {
  it('accepts a copy that leaves the reserve free', () => {
    const r = checkFreeSpace(100, tmp, { freeBytes: () => DEFAULT_RESERVE_BYTES + 100 });
    expect(r).toEqual({ ok: true, needed: DEFAULT_RESERVE_BYTES + 100, free: GiB + 100 });
  });

  it('refuses one that would not, saying how much it needs and how much is free', () => {
    const r = checkFreeSpace(2 * GiB, tmp, { freeBytes: () => 2.5 * GiB });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(
      'not enough space: needs 3 GiB, 2.5 GiB free (2 GiB to copy, 1 GiB kept free)',
    );
  });

  it('measures the nearest existing parent of a folder not made yet', () => {
    const asked: string[] = [];
    const r = checkFreeSpace(1, join(tmp, 'deliverables', 'task'), {
      reserveBytes: 0,
      freeBytes: (dir) => {
        asked.push(dir);
        if (dir !== tmp) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return 10;
      },
    });
    expect(r.ok).toBe(true);
    expect(asked.at(-1)).toBe(tmp);
  });

  it('uses statfs by default', () => {
    const r = checkFreeSpace(0, tmp, { reserveBytes: 0 });
    expect(r.ok).toBe(true);
    expect(r.free).toBeGreaterThan(0);
  });
});

describe('treeSize', () => {
  it('sums regular files and never follows a link', async () => {
    mkdirSync(join(tmp, 'out', 'sub'), { recursive: true });
    writeFileSync(join(tmp, 'out', 'a.txt'), 'abc');
    writeFileSync(join(tmp, 'out', 'sub', 'b.txt'), 'defgh');
    writeFileSync(join(tmp, 'big.bin'), 'x'.repeat(1000));
    symlinkSync(join(tmp, 'big.bin'), join(tmp, 'out', 'link.bin'));
    symlinkSync(tmp, join(tmp, 'out', 'loop'));
    expect(await treeSize(join(tmp, 'out'))).toEqual({ bytes: 8, entries: 6, complete: true });
    expect(await treeSize(join(tmp, 'out', 'a.txt'))).toEqual({
      bytes: 3,
      entries: 1,
      complete: true,
    });
  });

  it('stops at the entry cap and says the sum is incomplete', async () => {
    mkdirSync(join(tmp, 'many'));
    for (let i = 0; i < 20; i++) writeFileSync(join(tmp, 'many', `f${i}`), 'x');
    expect(await treeSize(join(tmp, 'many'), { maxEntries: 5 })).toMatchObject({
      entries: 5,
      complete: false,
    });
    expect(await treeSize(join(tmp, 'many'), { maxEntries: 21 })).toEqual({
      bytes: 20,
      entries: 21,
      complete: true,
    });
  });
});
