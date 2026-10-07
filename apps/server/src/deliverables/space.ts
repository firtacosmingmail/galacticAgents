import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { diskFree } from '../db/vacuum.js';

/**
 * The free-space guard of the deliverables folder (P9-02 for P9-06's copies; TECHNOLOGY §9.4,
 * SPEC decision 122, corner case 43): no size limit on files, only the disk. A copy that would
 * leave less than the backups' reserve free (1 GiB, decision 105) is refused with how much it
 * needs and how much is free. Reuses `diskFree` (`statfs`, P8-02/P8-03).
 */

/** The backups' free-space reserve (`backups.reserveMiB`, §6.4). */
export const DEFAULT_RESERVE_BYTES = 2 ** 30;

/** `1.5 GiB`, `320 MiB`, `12 KiB`, `5 bytes`. */
export function formatBytes(bytes: number): string {
  const units = ['GiB', 'MiB', 'KiB'] as const;
  for (const [i, unit] of units.entries()) {
    const size = 2 ** (10 * (3 - i));
    if (bytes >= size) {
      const n = bytes / size;
      return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${unit}`;
    }
  }
  return `${bytes} bytes`;
}

/** Entries `treeSize` visits before it gives up (a copy of more is refused, §9.4). */
export const TREE_MAX_ENTRIES = 100_000;

export interface TreeSize {
  /** The regular files' bytes summed (of the entries visited). */
  bytes: number;
  /** Entries visited (files, folders, links and the rest). */
  entries: number;
  /** False when the walk stopped at the entry cap: `bytes` is then a lower bound. */
  complete: boolean;
}

/**
 * Bytes a copy of `path` takes: a file's size, or the regular files under a folder summed by an
 * `lstat` walk that never follows a link (copies leave links out, §9.4). Asynchronous, so a big
 * folder never blocks the event loop, and bounded: past `maxEntries` it stops (`complete: false`).
 */
export async function treeSize(
  path: string,
  opts: { maxEntries?: number } = {},
): Promise<TreeSize> {
  const max = opts.maxEntries ?? TREE_MAX_ENTRIES;
  let bytes = 0;
  let entries = 0;
  const stack = [path];
  while (stack.length > 0) {
    if (entries >= max) return { bytes, entries, complete: false };
    const at = stack.pop()!;
    const st = await lstat(at);
    entries += 1;
    if (st.isFile()) bytes += st.size;
    else if (st.isDirectory()) {
      for (const name of await readdir(at)) stack.push(join(at, name));
    }
  }
  return { bytes, entries, complete: true };
}

export type SpaceCheck =
  | { ok: true; needed: number; free: number }
  | { ok: false; needed: number; free: number; reserve: number; message: string };

export interface SpaceOptions {
  /** Default `DEFAULT_RESERVE_BYTES`. */
  reserveBytes?: number;
  /** Free bytes on the file system holding a folder; default `diskFree` (`statfs`). */
  freeBytes?: (dir: string) => number;
}

/**
 * Whether `bytes` more can be written under `dir` (which need not exist yet: the nearest existing
 * parent is measured) and still leave the reserve free.
 */
export function checkFreeSpace(bytes: number, dir: string, opts: SpaceOptions = {}): SpaceCheck {
  const reserve = opts.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  const freeBytes = opts.freeBytes ?? diskFree;
  let at = resolve(dir);
  let free: number | undefined;
  for (;;) {
    try {
      free = freeBytes(at);
      break;
    } catch {
      const parent = dirname(at);
      if (parent === at) throw new Error(`cannot measure the free space for ${dir}`);
      at = parent;
    }
  }
  const needed = bytes + reserve;
  if (free >= needed) return { ok: true, needed, free };
  return {
    ok: false,
    needed,
    free,
    reserve,
    message:
      `not enough space: needs ${formatBytes(needed)}, ${formatBytes(free)} free ` +
      `(${formatBytes(bytes)} to copy, ${formatBytes(reserve)} kept free)`,
  };
}
