import { describe, expect, it } from 'vitest';
import {
  DownloadTickets,
  MAX_TICKETS_PER_CLIENT,
  TICKET_PATTERN,
  TICKET_TTL_MS,
  contentDisposition,
  fileHeaders,
  refusalStatus,
  utf8Prefix,
} from './serve.js';

/** P9-07 — the pure parts of file serving (TECHNOLOGY §9.6). */

const ID = { dev: 1, ino: 2, size: 3, mtimeMs: 4 };

describe('DownloadTickets', () => {
  it('mints 32 random bytes in base64url, usable once', () => {
    const tickets = new DownloadTickets();
    const a = tickets.mint('d-1', ID);
    const b = tickets.mint('d-1', ID);
    expect(a).toMatch(TICKET_PATTERN);
    expect(a).not.toBe(b);
    expect(tickets.take(a)).toMatchObject({ deliverableId: 'd-1', identity: ID });
    expect(tickets.take(a)).toBeUndefined();
    expect(tickets.take('unknown')).toBeUndefined();
  });

  it('expires after 60 s', () => {
    let now = 1_000;
    const tickets = new DownloadTickets({ now: () => now });
    const a = tickets.mint('d-1', ID);
    const b = tickets.mint('d-1', ID);
    now += TICKET_TTL_MS - 1;
    expect(tickets.take(a)).toBeDefined();
    now += 1;
    expect(tickets.take(b)).toBeUndefined();
    expect(tickets.size).toBe(0);
  });

  it('keeps at most `max` live tickets, dropping the oldest', () => {
    const tickets = new DownloadTickets({ max: 2 });
    const first = tickets.mint('d-1', ID);
    tickets.mint('d-2', ID);
    tickets.mint('d-3', ID);
    expect(tickets.size).toBe(2);
    expect(tickets.take(first)).toBeUndefined();
  });

  it('keeps at most 64 live tickets per client, dropping that client’s oldest only', () => {
    expect(MAX_TICKETS_PER_CLIENT).toBe(64);
    const tickets = new DownloadTickets({ maxPerClient: 2 });
    const local = tickets.mint('d-1', ID);
    const phone1 = tickets.mint('d-1', ID, 'remote:phone');
    const phone2 = tickets.mint('d-2', ID, 'remote:phone');
    const phone3 = tickets.mint('d-3', ID, 'remote:phone');
    expect(tickets.size).toBe(3);
    expect(tickets.take(phone1)).toBeUndefined();
    expect(tickets.take(phone2)).toMatchObject({ deliverableId: 'd-2', client: 'remote:phone' });
    expect(tickets.take(phone3)).toBeDefined();
    expect(tickets.take(local)).toMatchObject({ client: 'local' });
  });
});

describe('headers', () => {
  it('is inline for a preview and an encoded attachment otherwise', () => {
    expect(contentDisposition('inline', 'a.txt')).toBe('inline');
    expect(contentDisposition('attachment', "rapport d'été (1).pdf")).toBe(
      "attachment; filename*=UTF-8''rapport%20d%27%C3%A9t%C3%A9%20%281%29.pdf",
    );
  });

  it('carries nosniff, the sandbox, same-origin and no-store on every file', () => {
    expect(
      fileHeaders({ contentType: 'image/svg+xml', how: 'inline', name: 'a.svg', length: 3 }),
    ).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
      'content-type': 'image/svg+xml',
      'content-length': '3',
      'content-disposition': 'inline',
    });
  });

  it('maps path refusals: missing 410, invalid 400, the rest 409', () => {
    expect(refusalStatus('missing')).toBe(410);
    expect(refusalStatus('invalid')).toBe(400);
    expect(refusalStatus('changed')).toBe(409);
    expect(refusalStatus('outside')).toBe(409);
  });
});

describe('utf8Prefix', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('drops a character cut at the end, keeps a whole one', () => {
    expect(utf8Prefix(bytes('aé').subarray(0, 2))).toEqual(bytes('a'));
    expect(utf8Prefix(bytes('aé'))).toEqual(bytes('aé'));
    expect(utf8Prefix(bytes('a😀').subarray(0, 4))).toEqual(bytes('a'));
    expect(utf8Prefix(bytes('a😀'))).toEqual(bytes('a😀'));
    expect(utf8Prefix(bytes('abc'))).toEqual(bytes('abc'));
  });
});
