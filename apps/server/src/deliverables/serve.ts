import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { Deliverable, DeliverableFacts, Id } from '@galactic/protocol';
import {
  OCTET_STREAM,
  PREVIEW_IMAGE_BYTES,
  PREVIEW_TEXT_BYTES,
  factsOf,
  readHead,
  type FileFacts,
} from './facts.js';
import {
  identityOf,
  nodePathFs,
  openChecked,
  sameIdentity,
  type CheckOptions,
  type CheckedOpen,
  type DeliverableRoots,
  type FileIdentity,
  type PathFs,
  type PathRefusal,
  type PathRefusalCode,
} from './paths.js';

/**
 * Serving a deliverable's bytes (P9-07; TECHNOLOGY §9.6, SPEC decisions 125, 126, 131). The routes
 * (`http/deliverable-routes.ts`) take a deliverable id, never a path: the stored path is re-checked
 * against the deliverable's roots on every read and read only through the checked descriptor
 * (`openChecked`), so a file swapped for a link after its declaration is refused (409 `changed`).
 *
 * Every file response carries `FILE_HEADERS`: `nosniff`, a sandboxing CSP (an SVG or an HTML file
 * opened directly can run no script on the server's origin), `Cross-Origin-Resource-Policy:
 * same-origin` and `no-store`; `Content-Disposition` is `inline` only for the preview types (text,
 * always `text/plain`, and the images of `IMAGE_TYPES`), `attachment` otherwise. Downloads go
 * through one-time tickets (`DownloadTickets`), so the bearer token never appears in an address.
 */

/** What a sandboxed file response may do: nothing but show itself (TECHNOLOGY §9.6). */
export const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** The headers every file response carries, whatever its type (TECHNOLOGY §9.6). */
export const FILE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': FILE_CSP,
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

/** How long a download ticket is valid (decision 126: one minute). */
export const TICKET_TTL_MS = 60_000;
/** Live tickets kept at most; minting past it drops the oldest (a page cannot grow memory). */
export const MAX_TICKETS = 1_024;

/**
 * `filename*=UTF-8''…` (RFC 6266 / RFC 8187): every byte outside the attribute characters
 * percent-encoded, so no quote, semicolon or line break in a file name reaches the header.
 */
export function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `inline` for a preview, `attachment; filename*=UTF-8''<name>` for anything else. */
export function contentDisposition(how: 'inline' | 'attachment', name: string): string {
  return how === 'inline' ? 'inline' : `attachment; filename*=UTF-8''${encodeFilename(name)}`;
}

/** The headers of one file response: `FILE_HEADERS` plus its type, length and disposition. */
export function fileHeaders(opts: {
  contentType: string;
  how: 'inline' | 'attachment';
  name: string;
  length: number;
}): Record<string, string> {
  return {
    ...FILE_HEADERS,
    'content-type': opts.contentType,
    'content-length': String(opts.length),
    'content-disposition': contentDisposition(opts.how, opts.name),
    // A ticket is used up by its first request, so a resumed range could never be served.
    'accept-ranges': 'none',
  };
}

/** One-time download tickets (TECHNOLOGY §9.6): 32 random bytes, 60 s, bound to the file. */
export interface Ticket {
  deliverableId: Id;
  /** The file's `(dev, ino, size, mtime)` when the ticket was minted. */
  identity: FileIdentity;
  expiresAt: number;
}

export class DownloadTickets {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A new ticket for the deliverable's file as it is now. */
  mint(deliverableId: Id, identity: FileIdentity): string {
    this.prune();
    const max = this.opts.max ?? MAX_TICKETS;
    while (this.tickets.size >= max) {
      const oldest = this.tickets.keys().next().value as string;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      deliverableId,
      identity,
      expiresAt: this.now() + (this.opts.ttlMs ?? TICKET_TTL_MS),
    });
    return ticket;
  }

  /** Uses a ticket up: its binding, or `undefined` for an unknown, used or expired one. */
  take(ticket: string): Ticket | undefined {
    const found = this.tickets.get(ticket);
    if (!found) return undefined;
    this.tickets.delete(ticket);
    return found.expiresAt > this.now() ? found : undefined;
  }

  /** Live tickets (tests). */
  get size(): number {
    this.prune();
    return this.tickets.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(key);
  }
}

/** A ticket as minted: 32 bytes, base64url without padding. */
export const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The re-check's rules for a stored row: an agent's row keeps the agents' rules (secret names,
 * hard links) on every read (TECHNOLOGY §9.2), the user's and detected rows do not.
 */
export function checkOptionsOf(d: Pick<Deliverable, 'source'>): CheckOptions {
  return d.source === 'agent' ? { secretNames: true } : {};
}

/** The HTTP status and code of a path refusal on a read (TECHNOLOGY §9.6). */
export function refusalStatus(code: PathRefusalCode): number {
  switch (code) {
    case 'missing':
      return 410;
    case 'invalid':
      return 400;
    default:
      return 409;
  }
}

/** Facts on the wire (`DeliverableFacts`) from the server's `FileFacts`. */
export function factsView(f: FileFacts): DeliverableFacts {
  if (!f.exists) {
    return { exists: false, ...(f.missing ? { problem: f.missing.code } : {}) };
  }
  return {
    exists: true,
    ...(f.type ? { isDirectory: f.type === 'folder' } : {}),
    ...(f.size !== undefined ? { size: f.size } : {}),
    ...(f.mtimeMs !== undefined ? { mtime: new Date(f.mtimeMs).toISOString() } : {}),
    ...(f.kindGuess ? { kindGuess: f.kindGuess } : {}),
    ...(f.contentType ? { contentType: f.contentType } : {}),
    runsCode: f.runsCode,
  };
}

/** A file opened for serving: the checked descriptor, its facts, its name. */
export interface OpenedFile {
  opened: CheckedOpen;
  facts: FileFacts;
  name: string;
}

/**
 * Re-checks and opens a stored path for reading. A folder is refused here (folders are never
 * served, decision 125): the descriptor is closed and `folder` answered. The caller owns the
 * descriptor of a success (`fs.close`, or a stream that closes it).
 */
export function openForServing(
  path: string,
  roots: DeliverableRoots,
  opts: CheckOptions,
  fs: PathFs = nodePathFs,
): OpenedFile | PathRefusal | { ok: false; code: 'folder'; reason: string } {
  const opened = openChecked(path, roots, opts, fs);
  if (!opened.ok) return opened;
  if (opened.type !== 'file') {
    fs.close(opened.fd);
    return { ok: false, code: 'folder', reason: `${path} is a folder: it opens on the Mac only` };
  }
  try {
    const head = readHead(opened.fd, fs);
    return { opened, facts: factsOf(opened.path, opened.stat, head), name: basename(opened.path) };
  } catch (e) {
    fs.close(opened.fd);
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    return { ok: false, code: 'missing', reason: `${path} cannot be read (${code})` };
  }
}

/** A complete prefix of UTF-8 bytes: a character cut at the end is left out. */
export function utf8Prefix(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  // Step back over continuation bytes (10xxxxxx) to the last lead byte, at most 3.
  let back = 0;
  while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1]! & 0xc0) === 0x80) back++;
  const leadAt = end - back - 1;
  if (leadAt < 0) return bytes;
  const lead = bytes[leadAt]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need > back + 1) end = leadAt;
  return bytes.subarray(0, end);
}

/** What the viewer's content route sends (TECHNOLOGY §9.6): its body plan and headers. */
export type ContentPlan =
  | { kind: 'text'; bytes: Uint8Array; truncated: boolean }
  | { kind: 'stream'; how: 'inline' | 'attachment'; contentType: string; size: number }
  | { kind: 'too_large'; limit: number };

/**
 * The viewer's content of a file (decisions 125, 126): text as `text/plain` (HTML and Markdown
 * included), its first `PREVIEW_TEXT_BYTES` with `X-Truncated: 1` past them; an image of
 * `IMAGE_TYPES` inline up to `PREVIEW_IMAGE_BYTES`; anything else (a PDF, a binary) as an
 * attachment up to the same limit. Past it 413: Download has no limit.
 */
export function contentPlan(file: OpenedFile, fs: PathFs = nodePathFs): ContentPlan {
  const { facts, opened } = file;
  const size = opened.stat.size;
  if (facts.preview === 'text' || facts.kindGuess === 'text') {
    const truncated = size > PREVIEW_TEXT_BYTES;
    const bytes = readHead(opened.fd, fs, Math.min(size, PREVIEW_TEXT_BYTES));
    return { kind: 'text', bytes: truncated ? utf8Prefix(bytes) : bytes, truncated };
  }
  if (size > PREVIEW_IMAGE_BYTES) return { kind: 'too_large', limit: PREVIEW_IMAGE_BYTES };
  if (facts.kindGuess === 'image' && facts.contentType) {
    return { kind: 'stream', how: 'inline', contentType: facts.contentType, size };
  }
  return {
    kind: 'stream',
    how: 'attachment',
    contentType: facts.contentType ?? OCTET_STREAM,
    size,
  };
}

/**
 * A stream of the checked descriptor's first `size` bytes (never more, if the file grew), closed
 * at its end, on an error or when the client goes away. No size limit (decision 125). `size` is
 * at least 1 (an empty file is answered without a stream).
 */
export function streamFile(fd: number, size: number): Readable {
  return createReadStream('', { fd, start: 0, end: size - 1, autoClose: true });
}

/** Whether the file a ticket was minted for is still the one at the path. */
export function ticketMatches(ticket: Ticket, opened: CheckedOpen): boolean {
  return sameIdentity(ticket.identity, identityOf(opened.stat));
}
