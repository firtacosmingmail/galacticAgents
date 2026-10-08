import { extname } from 'node:path';
import {
  nodePathFs,
  openChecked,
  type CheckOptions,
  type DeliverableRoots,
  type PathFs,
  type PathRefusalCode,
  type PathStat,
} from './paths.js';

/**
 * File facts (P9-02; TECHNOLOGY §9.2 "File facts", SPEC decisions 125, 126, 128): what the panel
 * shows next to a file deliverable, computed on every read and never stored as truth. The
 * classification is pure (`factsOf` over a `stat` and the file's first bytes); `fileFacts` reads
 * them through the checked descriptor of `paths.ts`.
 */

/** Bytes read to tell text from binary: no NUL and valid UTF-8 → text. */
export const SNIFF_BYTES = 8 * 1024;
/** The page's preview limits, not the files' (decision 125). */
export const PREVIEW_TEXT_BYTES = 2 * 2 ** 20;
export const PREVIEW_IMAGE_BYTES = 20 * 2 ** 20;

export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const OCTET_STREAM = 'application/octet-stream';

/** Image previews by extension (decision 125): the only image types a blob is ever given. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/**
 * Files (or bundles) that run something when the Finder opens them: applications, not files
 * (decision 128), opened only after a confirmation. Besides programs and scripts: installers and
 * system add-ons (`.pkg`, `.prefpane`, `.saver`, `.osax`, `.mobileconfig` — a configuration
 * profile —, `.service`, `.action`, `.shortcut`), disk images (`.dmg`: mounting one may show its
 * own installer) and location files (`.fileloc`, `.inetloc`, `.webloc`, `.url`), which open
 * whatever file, app or address they name.
 */
export const APP_EXTENSIONS: readonly string[] = [
  '.app',
  '.command',
  '.tool',
  '.terminal',
  '.scpt',
  '.scptd',
  '.workflow',
  '.action',
  '.service',
  '.shortcut',
  '.pkg',
  '.mpkg',
  '.dmg',
  '.jar',
  '.prefpane',
  '.saver',
  '.osax',
  '.mobileconfig',
  '.fileloc',
  '.inetloc',
  '.webloc',
  '.url',
];

export type KindGuess = 'text' | 'image' | 'pdf' | 'binary' | 'folder';

export interface FileFacts {
  exists: boolean;
  /** Why it cannot be read when `exists` is false (or the check refused it). */
  missing?: { code: PathRefusalCode; reason: string };
  type?: 'file' | 'folder';
  size?: number;
  mtimeMs?: number;
  kindGuess?: KindGuess;
  /** The `Content-Type` a file response uses (text is always `text/plain`, decision 126). */
  contentType?: string;
  /** What the viewer may show; `none` past the limits, for binaries, PDFs and folders. */
  preview?: 'text' | 'image' | 'none';
  /** Text past `PREVIEW_TEXT_BYTES`: the viewer gets its first part. */
  truncated?: boolean;
  /** Opening it would run code (decision 128): Open refuses it. */
  runsCode: boolean;
  /** `app`: an application, opened after a confirmation; `command`: suggest a command deliverable. */
  runsAs?: 'app' | 'command';
}

const MACH_O_MAGIC = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
];

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.length <= head.length && bytes.every((b, i) => head[i] === b);
}

/** The extension, lower case, NFC (`.PNG` is `.png`). */
export function extensionOf(name: string): string {
  return extname(name).normalize('NFC').toLowerCase();
}

/**
 * Text or binary from the first bytes: a NUL, or bytes that are not UTF-8, make it binary.
 * `complete` says `head` is the whole file; otherwise a multi-byte character cut at the end of
 * `head` is not counted against it.
 */
export function sniffText(head: Uint8Array, complete: boolean): 'text' | 'binary' {
  if (head.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !complete });
    return 'text';
  } catch {
    return 'binary';
  }
}

/** An application by its name (decision 128): an `.app` bundle or a Finder-runnable extension. */
export function isAppName(name: string): boolean {
  return APP_EXTENSIONS.includes(extensionOf(name.replace(/\/+$/, '')));
}

/** A Mach-O binary or a `#!` script: the first bytes say it is a program. */
export function looksExecutable(head: Uint8Array): boolean {
  return startsWith(head, [0x23, 0x21]) || MACH_O_MAGIC.some((m) => startsWith(head, m));
}

/**
 * A file the Finder would run in Terminal: the execute bit and either a Mach-O or `#!` start, or
 * no extension at all (the Finder runs any executable file without one, whatever its bytes).
 */
export function runsAsCommand(name: string, stat: PathStat, head: Uint8Array): boolean {
  if ((stat.mode & 0o111) === 0) return false;
  return looksExecutable(head) || extensionOf(name) === '';
}

/**
 * The facts of a file or folder from its `stat` and its first `SNIFF_BYTES` (empty for a
 * folder). `name` is its basename (or path).
 */
export function factsOf(name: string, stat: PathStat, head: Uint8Array): FileFacts {
  const base = { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.isDirectory()) {
    const app = isAppName(name);
    return {
      ...base,
      type: 'folder',
      kindGuess: 'folder',
      preview: 'none',
      runsCode: app,
      ...(app ? { runsAs: 'app' as const } : {}),
    };
  }
  const ext = extensionOf(name);
  const runsAs = isAppName(name)
    ? ('app' as const)
    : runsAsCommand(name, stat, head)
      ? ('command' as const)
      : undefined;
  const runs = { runsCode: runsAs !== undefined, ...(runsAs ? { runsAs } : {}) };
  const image = IMAGE_TYPES[ext];
  if (image) {
    return {
      ...base,
      type: 'file',
      kindGuess: 'image',
      contentType: image,
      preview: stat.size <= PREVIEW_IMAGE_BYTES ? 'image' : 'none',
      ...runs,
    };
  }
  if (ext === '.pdf' || startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return {
      ...base,
      type: 'file',
      kindGuess: 'pdf',
      contentType: 'application/pdf',
      preview: 'none',
      ...runs,
    };
  }
  if (sniffText(head, head.length >= stat.size) === 'text') {
    return {
      ...base,
      type: 'file',
      kindGuess: 'text',
      contentType: TEXT_CONTENT_TYPE,
      preview: 'text',
      ...(stat.size > PREVIEW_TEXT_BYTES ? { truncated: true } : {}),
      ...runs,
    };
  }
  return {
    ...base,
    type: 'file',
    kindGuess: 'binary',
    contentType: OCTET_STREAM,
    preview: 'none',
    ...runs,
  };
}

/** Reads up to `SNIFF_BYTES` from the start of an open file. */
export function readHead(fd: number, fs: PathFs = nodePathFs, max = SNIFF_BYTES): Uint8Array {
  const buffer = new Uint8Array(max);
  let filled = 0;
  while (filled < max) {
    const n = fs.read(fd, buffer, filled, max - filled, filled);
    if (n <= 0) break;
    filled += n;
  }
  return buffer.subarray(0, filled);
}

/**
 * The live facts of a stored path: re-checked against the roots and read through the checked
 * descriptor (`openChecked`). A refusal (missing, moved out, swapped) is `exists: false` with the
 * reason, so a list never fails for one bad row.
 */
export function fileFacts(
  path: string,
  roots: DeliverableRoots,
  opts: CheckOptions = {},
  fs: PathFs = nodePathFs,
): FileFacts {
  const opened = openChecked(path, roots, opts, fs);
  if (!opened.ok) {
    return {
      exists: false,
      missing: { code: opened.code, reason: opened.reason },
      runsCode: false,
    };
  }
  try {
    const head = opened.type === 'file' ? readHead(opened.fd, fs) : new Uint8Array();
    return factsOf(opened.path, opened.stat, head);
  } catch (e) {
    const reason = `${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    return { exists: false, missing: { code: 'missing', reason }, runsCode: false };
  } finally {
    fs.close(opened.fd);
  }
}
