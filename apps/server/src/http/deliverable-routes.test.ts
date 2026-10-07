import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  ftruncateSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeliverablesResponse,
  DownloadTicketResponse,
  OpenConfirmation,
  type Actor,
  type AddDeliverableInput,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { Commands } from '../domain/commands.js';
import { EventLog } from '../domain/event-log.js';
import { createProject } from '../domain/projects.js';
import { createTask } from '../domain/tasks.js';
import { PREVIEW_TEXT_BYTES } from '../deliverables/facts.js';
import {
  MDFIND,
  OPEN,
  Opener,
  nodeOpenerFs,
  type ExecFile,
  type OpenerFs,
} from '../deliverables/opener.js';
import { FILE_CSP, TICKET_TTL_MS } from '../deliverables/serve.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * P9-07 — the deliverables' routes (TECHNOLOGY §9.6, §9.7, §9.9; SPEC decisions 125–128, 131):
 * every route from the Mac, from a remote client and without the token; the re-check of the path
 * on every read; the download tickets; the headers that keep a served file from running; the
 * application's confirmation. Files are real (a temporary folder); `open` never runs — the
 * opener's `execFile` is a recorder.
 */

const USER: Actor = { type: 'user' };
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };
const WEBSTORM_APP = '/Applications/WebStorm.app';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * The real file system for the project's files (the fingerprint walks a real bundle), a fake one
 * for the Applications folders: WebStorm is "installed" at `/Applications/WebStorm.app`.
 */
const appsFs: OpenerFs = {
  ...nodeOpenerFs,
  readdir: (p) => (p.includes('Applications') ? Promise.resolve([]) : nodeOpenerFs.readdir(p)),
  realpath: (p) =>
    p === '/Applications' || p === WEBSTORM_APP ? Promise.resolve(p) : nodeOpenerFs.realpath(p),
  exists: (p) => (p === WEBSTORM_APP ? Promise.resolve(true) : nodeOpenerFs.exists(p)),
};

async function setup(opts: { autoApproveRemote?: boolean; platform?: NodeJS.Platform } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-p907-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, 'app');
  const outside = join(root, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');

  const config = testConfig({ autoApproveRemote: opts.autoApproveRemote ?? false });
  const log = new EventLog(openDatabase(':memory:'));
  const project = log.runCommand((ctx) =>
    createProject(ctx, { name: 'App', workspace: ws, bodyId: 'b-saturn' }),
  ).value;
  const task = log.runCommand((ctx) =>
    createTask(ctx, { projectId: project.id, description: 'login page' }),
  ).value;
  const commands = new Commands({ log, autoApproveRemote: opts.autoApproveRemote ?? false });

  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecFile = async (file, args) => {
    calls.push({ file, args });
    if (file === MDFIND && args[0]?.includes('com.jetbrains.WebStorm')) {
      return { stdout: `${WEBSTORM_APP}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const opener = new Opener({
    execFile: exec,
    fs: appsFs,
    platform: opts.platform ?? 'darwin',
    home: '/Users/nobody',
    verifySignatures: false,
  });
  const t = await startTestApp({ config, log, commands, opener });
  cleanups.push(() => t.stop());

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    token: string | null = TEST_TOKEN,
  ) => {
    const res = await fetch(`${t.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json: Record<string, unknown> = {};
    if (text && (res.headers.get('content-type') ?? '').startsWith('application/json')) {
      json = JSON.parse(text) as Record<string, unknown>;
    }
    return { status: res.status, headers: res.headers, bytes, text, json };
  };

  /** A file in the workspace and its deliverable, added by the user on the Mac. */
  const add = async (
    rel: string,
    content: string | Buffer | undefined,
    over: Partial<AddDeliverableInput> = {},
  ) => {
    const path = join(ws, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    if (content !== undefined) writeFileSync(path, content);
    const { value } = await commands.addDeliverable(
      {
        projectId: project.id,
        kind: 'file',
        title: rel,
        source: 'user',
        location: { storage: 'in_place', path },
        ...over,
      },
      USER,
      { origin: 'local' },
    );
    return { row: value, path };
  };
  const events = (type: string) =>
    (log.db.prepare('SELECT type FROM events WHERE type = ?').all(type) as unknown[]).length;
  return { root, ws, outside, config, log, project, task, commands, calls, call, add, events, t };
}

const opens = (calls: { file: string; args: readonly string[] }[]) =>
  calls.filter((c) => c.file === OPEN);

/** The headers every file response carries (TECHNOLOGY §9.6). */
function expectFileHeaders(headers: Headers) {
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('content-security-policy')).toBe(FILE_CSP);
  expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(headers.get('cache-control')).toBe('no-store');
}

describe('GET /api/deliverables (P9-07)', () => {
  it('lists the rows with live file facts, from the Mac and from the phone', async () => {
    const s = await setup();
    const { row } = await s.add('notes.md', '# hi');
    await s.add('gone.txt', 'x');
    rmSync(join(s.ws, 'gone.txt'));
    for (const headers of [{}, REMOTE]) {
      const res = await s.call(
        'GET',
        `/api/deliverables?projectId=${s.project.id}`,
        undefined,
        headers,
      );
      expect(res.status).toBe(200);
      const body = DeliverablesResponse.parse(res.json);
      expect(body.deliverables).toHaveLength(2);
      const notes = body.deliverables.find((d) => d.id === row.id)!;
      expect(notes.facts).toMatchObject({
        exists: true,
        size: 4,
        kindGuess: 'text',
        contentType: 'text/plain; charset=utf-8',
        runsCode: false,
      });
      const gone = body.deliverables.find((d) => d.id !== row.id)!;
      expect(gone.facts).toEqual({ exists: false, problem: 'missing' });
    }
  });

  it('hides removed rows unless asked, and 404s an unknown project', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'a');
    await s.commands.removeDeliverable(row.id, USER, 'scratch', { origin: 'local' });
    const shown = await s.call('GET', `/api/deliverables?projectId=${s.project.id}`);
    expect(DeliverablesResponse.parse(shown.json).deliverables).toEqual([]);
    const all = await s.call('GET', `/api/deliverables?projectId=${s.project.id}&removed=1`);
    expect(DeliverablesResponse.parse(all.json).deliverables.map((d) => d.id)).toEqual([row.id]);
    expect((await s.call('GET', '/api/deliverables?projectId=p-nope')).status).toBe(404);
  });

  it('lists a task with its deliverables', async () => {
    const s = await setup();
    await s.add('a.txt', 'a', { taskId: s.task.id });
    await s.add('b.txt', 'b');
    const res = await s.call('GET', `/api/deliverables?taskId=${s.task.id}`);
    expect(DeliverablesResponse.parse(res.json).deliverables.map((d) => d.title)).toEqual([
      'a.txt',
    ]);
  });

  it('needs the token', async () => {
    const s = await setup();
    expect((await s.call('GET', '/api/deliverables', undefined, {}, null)).status).toBe(401);
  });
});

describe('GET /api/deliverables/:id/content (P9-07)', () => {
  it('sends text as text/plain, HTML and Markdown included, with the safe headers', async () => {
    const s = await setup();
    for (const [name, content] of [
      ['page.html', '<script>alert(1)</script>'],
      ['README.md', '# Title <img src=x onerror=alert(1)>'],
      ['main.ts', 'export const x = 1;'],
    ] as const) {
      const { row } = await s.add(name, content);
      const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(res.headers.get('x-truncated')).toBeNull();
      expectFileHeaders(res.headers);
      expect(res.text).toBe(content);
    }
  });

  it('sends an SVG only as an image, sandboxed so its script cannot run if opened directly', async () => {
    const s = await setup();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { row } = await s.add('logo.svg', svg, { kind: 'image' });
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expectFileHeaders(res.headers);
    expect(res.text).toBe(svg);
  });

  it('sends a binary file as an attachment with an encoded file name', async () => {
    const s = await setup();
    const { row } = await s.add('data "x";\r\n.bin', Buffer.from([0, 1, 2, 3, 0]));
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''data%20%22x%22%3B%0D%0A.bin",
    );
    expectFileHeaders(res.headers);
    expect([...res.bytes]).toEqual([0, 1, 2, 3, 0]);
  });

  it('sends the first 2 MiB of a large text with X-Truncated, never cutting a character', async () => {
    const s = await setup();
    // "é" is two bytes: an odd prefix would cut one.
    const { row } = await s.add('big.log', `x${'é'.repeat(PREVIEW_TEXT_BYTES)}`);
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-truncated')).toBe('1');
    expect(res.bytes.length).toBe(PREVIEW_TEXT_BYTES - 1);
    expect(res.text.endsWith('é')).toBe(true);
    expect(res.text).not.toContain('�');
  });

  it('answers 413 past the image preview limit (Download has none)', async () => {
    const s = await setup();
    const { row, path } = await s.add('huge.png', undefined);
    const fd = openSync(path, 'w');
    ftruncateSync(fd, 21 * 2 ** 20);
    closeSync(fd);
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res).toMatchObject({ status: 413, json: { error: 'too_large' } });
  });

  it('may be read from the phone, never without the token', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'hello');
    expect(
      (await s.call('GET', `/api/deliverables/${row.id}/content`, undefined, REMOTE)).text,
    ).toBe('hello');
    const anon = await s.call('GET', `/api/deliverables/${row.id}/content`, undefined, {}, null);
    expect(anon.status).toBe(401);
  });

  it('re-checks the path on every read: a file swapped for a link out is refused', async () => {
    const s = await setup();
    const { row, path } = await s.add('report.txt', 'mine');
    expect((await s.call('GET', `/api/deliverables/${row.id}/content`)).text).toBe('mine');
    rmSync(path);
    symlinkSync(join(s.outside, 'secret.txt'), path);
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res.status).toBe(409);
    expect(['outside', 'changed']).toContain(res.json['error']);
    expect(res.text).not.toContain('TOP SECRET');
  });

  it('re-checks the parent folders too: a folder swapped for a link out is refused', async () => {
    const s = await setup();
    const { row } = await s.add('sub/report.txt', 'mine');
    renameSync(join(s.ws, 'sub'), join(s.ws, 'sub-old'));
    writeFileSync(join(s.outside, 'report.txt'), 'TOP SECRET');
    symlinkSync(s.outside, join(s.ws, 'sub'));
    const res = await s.call('GET', `/api/deliverables/${row.id}/content`);
    expect(res.status).toBe(409);
    expect(res.text).not.toContain('TOP SECRET');
  });

  it('answers 410 for a missing file, 409 for a folder, 404 for an unknown or removed id', async () => {
    const s = await setup();
    const { row, path } = await s.add('a.txt', 'a');
    rmSync(path);
    expect((await s.call('GET', `/api/deliverables/${row.id}/content`)).json).toMatchObject({
      error: 'missing',
    });
    expect((await s.call('GET', `/api/deliverables/${row.id}/content`)).status).toBe(410);
    mkdirSync(join(s.ws, 'dist'));
    const folder = await s.add('dist', undefined, { kind: 'folder' });
    expect(await s.call('GET', `/api/deliverables/${folder.row.id}/content`)).toMatchObject({
      status: 409,
      json: { error: 'folder' },
    });
    expect((await s.call('GET', '/api/deliverables/d-nope/content')).status).toBe(404);
    const removed = await s.add('b.txt', 'b');
    await s.commands.removeDeliverable(removed.row.id, USER, undefined, { origin: 'local' });
    expect((await s.call('GET', `/api/deliverables/${removed.row.id}/content`)).status).toBe(404);
  });

  it("keeps an agent's row to the agents' rules on every read (a secret name is refused)", async () => {
    const s = await setup();
    s.log.runCommand((ctx) =>
      createAgent(ctx, {
        agentId: 'a-steward',
        role: 'steward',
        runtime: 'fake',
        caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
        taskId: s.task.id,
      }),
    );
    writeFileSync(join(s.ws, 'id_rsa'), 'KEY');
    const { value } = await s.commands.addDeliverable(
      {
        taskId: s.task.id,
        kind: 'file',
        title: 'key',
        source: 'agent',
        location: { storage: 'in_place', path: join(s.ws, 'id_rsa') },
      },
      { type: 'agent', id: 'a-steward' },
    );
    const res = await s.call('GET', `/api/deliverables/${value.id}/content`);
    expect(res).toMatchObject({ status: 409, json: { error: 'secret' } });
    expect(res.text).not.toContain('KEY');
  });
});

describe('download tickets (P9-07)', () => {
  it('gives a one-time link that works once, without the token, as an attachment', async () => {
    const s = await setup();
    const { row } = await s.add('page.html', '<script>x</script>');
    const minted = await s.call('POST', `/api/deliverables/${row.id}/download`);
    expect(minted.status).toBe(200);
    const { url } = DownloadTicketResponse.parse(minted.json);
    expect(url).not.toContain(TEST_TOKEN);
    const first = await s.call('GET', url, undefined, {}, null);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''page.html");
    expect(first.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expectFileHeaders(first.headers);
    expect(first.text).toBe('<script>x</script>');
    const second = await s.call('GET', url, undefined, {}, null);
    expect(second).toMatchObject({ status: 410, json: { error: 'expired' } });
  });

  it('expires after 60 s', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'a');
    const { url } = DownloadTicketResponse.parse(
      (await s.call('POST', `/api/deliverables/${row.id}/download`)).json,
    );
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + TICKET_TTL_MS + 1);
    expect((await s.call('GET', url, undefined, {}, null)).status).toBe(410);
  });

  it('is refused when the file changed after the link was made', async () => {
    const s = await setup();
    const { row, path } = await s.add('a.txt', 'a');
    const { url } = DownloadTicketResponse.parse(
      (await s.call('POST', `/api/deliverables/${row.id}/download`)).json,
    );
    appendFileSync(path, 'more');
    const res = await s.call('GET', url, undefined, {}, null);
    expect(res).toMatchObject({ status: 410, json: { error: 'changed' } });
  });

  it('is refused when the file was swapped for another one of the same size', async () => {
    const s = await setup();
    const { row, path } = await s.add('a.txt', 'aaaa');
    const { url } = DownloadTicketResponse.parse(
      (await s.call('POST', `/api/deliverables/${row.id}/download`)).json,
    );
    writeFileSync(join(s.ws, 'b.txt'), 'bbbb');
    renameSync(join(s.ws, 'b.txt'), path);
    expect((await s.call('GET', url, undefined, {}, null)).status).toBe(410);
  });

  it('is not used up by a HEAD request, and a malformed or unknown ticket is refused', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'a');
    const { url } = DownloadTicketResponse.parse(
      (await s.call('POST', `/api/deliverables/${row.id}/download`)).json,
    );
    expect((await s.call('HEAD', url, undefined, {}, null)).status).toBe(404);
    expect((await s.call('GET', url, undefined, {}, null)).text).toBe('a');
    expect((await s.call('GET', '/files/nope', undefined, {}, null)).status).toBe(404);
    expect((await s.call('GET', `/files/${'A'.repeat(43)}`, undefined, {}, null)).status).toBe(410);
  });

  it('is minted for the phone too, but the Host allow-list still applies', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'a');
    const minted = await s.call('POST', `/api/deliverables/${row.id}/download`, undefined, REMOTE);
    const { url } = DownloadTicketResponse.parse(minted.json);
    // fetch cannot set Host: a raw request does.
    const evil = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: s.t.port, path: url, headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(evil).toBe(403);
    expect((await s.call('GET', url, undefined, REMOTE, null)).text).toBe('a');
    expect(
      (await s.call('POST', `/api/deliverables/${row.id}/download`, undefined, {}, null)).status,
    ).toBe(401);
  });

  it('streams a large file whole, with no size limit', async () => {
    const s = await setup();
    const { row, path } = await s.add('disk.img', undefined);
    const size = 48 * 2 ** 20 + 7;
    const fd = openSync(path, 'w');
    ftruncateSync(fd, size);
    closeSync(fd);
    const { url } = DownloadTicketResponse.parse(
      (await s.call('POST', `/api/deliverables/${row.id}/download`)).json,
    );
    const res = await fetch(`${s.t.baseUrl}${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(size));
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    let received = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
    }
    expect(received).toBe(size);
  });

  it('refuses a folder (folders open on the Mac only)', async () => {
    const s = await setup();
    mkdirSync(join(s.ws, 'dist'));
    const { row } = await s.add('dist', undefined, { kind: 'folder' });
    expect(await s.call('POST', `/api/deliverables/${row.id}/download`)).toMatchObject({
      status: 409,
      json: { error: 'folder' },
    });
  });
});

describe('adding, editing, removing and restoring by hand (P9-07)', () => {
  it('adds a file from the Mac, never a path outside the project', async () => {
    const s = await setup();
    writeFileSync(join(s.ws, 'out.txt'), 'x');
    const res = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'file',
      title: 'Out',
      path: join(s.ws, 'out.txt'),
    });
    expect(res.status).toBe(200);
    expect(res.json['deliverable']).toMatchObject({
      source: 'user',
      location: { storage: 'in_place', path: join(s.ws, 'out.txt') },
    });
    const outside = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'file',
      title: 'Secret',
      path: join(s.outside, 'secret.txt'),
    });
    expect(outside).toMatchObject({ status: 409, json: { error: 'outside' } });
    const relative = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'file',
      title: 'Rel',
      path: '../outside/secret.txt',
    });
    expect(relative).toMatchObject({ status: 400, json: { error: 'invalid' } });
    const wrongKind = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'folder',
      title: 'Not a folder',
      path: join(s.ws, 'out.txt'),
    });
    expect(wrongKind).toMatchObject({ status: 400, json: { error: 'invalid' } });
  });

  it('adds a command in the project folder by default, and an address', async () => {
    const s = await setup();
    const cmd = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'command',
      title: 'Dev',
      command: { line: 'pnpm dev' },
    });
    expect(cmd.json['deliverable']).toMatchObject({ command: { line: 'pnpm dev', cwd: s.ws } });
    const url = await s.call('POST', '/api/deliverables', {
      projectId: s.project.id,
      kind: 'url',
      title: 'Site',
      url: 'javascript:alert(1)',
    });
    expect(url).toMatchObject({ status: 400, json: { error: 'invalid' } });
  });

  it('is refused to a remote client (403 remote_control) unless autoApproveRemote', async () => {
    const s = await setup();
    const { row } = await s.add('a.txt', 'a');
    writeFileSync(join(s.ws, 'b.txt'), 'b');
    const body = { projectId: s.project.id, kind: 'file', title: 'B', path: join(s.ws, 'b.txt') };
    for (const [method, path, payload] of [
      ['POST', '/api/deliverables', body],
      ['PATCH', `/api/deliverables/${row.id}`, { version: row.version, title: 'New' }],
      ['POST', `/api/deliverables/${row.id}/remove`, {}],
      ['POST', `/api/deliverables/${row.id}/restore`, {}],
    ] as const) {
      const res = await s.call(method, path, payload, REMOTE);
      expect(res, `${method} ${path}`).toMatchObject({
        status: 403,
        json: { error: 'remote_control' },
      });
    }
    expect(s.events('deliverable.updated') + s.events('deliverable.removed')).toBe(0);
    for (const [method, path] of [
      ['POST', '/api/deliverables'],
      ['PATCH', `/api/deliverables/${row.id}`],
      ['POST', `/api/deliverables/${row.id}/remove`],
    ] as const) {
      expect((await s.call(method, path, {}, {}, null)).status).toBe(401);
    }
  });

  it('lets a remote client edit with autoApproveRemote', async () => {
    const s = await setup({ autoApproveRemote: true });
    const { row } = await s.add('a.txt', 'a');
    const edit = await s.call(
      'PATCH',
      `/api/deliverables/${row.id}`,
      { version: row.version, title: 'Renamed' },
      REMOTE,
    );
    expect(edit).toMatchObject({ status: 200, json: { deliverable: { title: 'Renamed' } } });
    const removed = await s.call('POST', `/api/deliverables/${row.id}/remove`, {}, REMOTE);
    expect(removed.status).toBe(200);
    const restored = await s.call('POST', `/api/deliverables/${row.id}/restore`, {}, REMOTE);
    expect(restored).toMatchObject({ status: 200, json: { deliverable: { version: 4 } } });
  });

  it('refuses a stale edit with the current row, and edits a command line in place', async () => {
    const s = await setup();
    const { value: cmd } = await s.commands.addDeliverable(
      {
        projectId: s.project.id,
        kind: 'command',
        title: 'Dev',
        source: 'user',
        command: { line: 'pnpm dev', cwd: s.ws },
      },
      USER,
      { origin: 'local' },
    );
    const ok = await s.call('PATCH', `/api/deliverables/${cmd.id}`, {
      version: 1,
      command: { line: 'pnpm dev --host' },
    });
    expect(ok.json['deliverable']).toMatchObject({
      version: 2,
      command: { line: 'pnpm dev --host', cwd: s.ws },
    });
    const stale = await s.call('PATCH', `/api/deliverables/${cmd.id}`, { version: 1, title: 'X' });
    expect(stale).toMatchObject({
      status: 409,
      json: { error: 'stale', deliverable: { version: 2, title: 'Dev' } },
    });
    const notCmd = await s.add('a.txt', 'a');
    expect(
      await s.call('PATCH', `/api/deliverables/${notCmd.row.id}`, {
        version: 1,
        command: { line: 'x' },
      }),
    ).toMatchObject({ status: 400, json: { error: 'invalid' } });
    expect((await s.call('PATCH', '/api/deliverables/d-nope', { version: 1 })).status).toBe(404);
  });

  it('removes and restores without touching the file', async () => {
    const s = await setup();
    const { row, path } = await s.add('a.txt', 'keep me');
    const removed = await s.call('POST', `/api/deliverables/${row.id}/remove`, { reason: 'old' });
    expect(removed.json['deliverable']).toMatchObject({ removedReason: 'old' });
    expect(await s.call('POST', `/api/deliverables/${row.id}/remove`, {})).toMatchObject({
      status: 409,
      json: { error: 'invalid_transition' },
    });
    expect((await s.call('POST', `/api/deliverables/${row.id}/restore`)).status).toBe(200);
    expect(realpathSync(path)).toBe(path);
  });
});

describe('opening on the Mac (P9-07)', () => {
  it('opens, reveals and opens a folder in the IDE, logging deliverable.opened', async () => {
    const s = await setup();
    const { row, path } = await s.add('report.pdf', '%PDF-1.4');
    mkdirSync(join(s.ws, 'web'));
    const folder = await s.add('web', undefined, { kind: 'folder' });
    expect(
      await s.call('POST', `/api/deliverables/${row.id}/open`, { action: 'open' }),
    ).toMatchObject({ status: 200 });
    await s.call('POST', `/api/deliverables/${row.id}/open`, { action: 'reveal' });
    const ide = await s.call('POST', `/api/deliverables/${folder.row.id}/open`, { action: 'ide' });
    expect(ide.status).toBe(200);
    expect(opens(s.calls).map((c) => c.args)).toEqual([
      [path],
      ['-R', path],
      ['-a', WEBSTORM_APP, folder.path],
    ]);
    expect(s.events('deliverable.opened')).toBe(3);
  });

  it('is refused to a remote client for every action, even with autoApproveRemote', async () => {
    for (const autoApproveRemote of [false, true]) {
      const s = await setup({ autoApproveRemote });
      const { row } = await s.add('a.txt', 'a');
      for (const action of ['open', 'reveal', 'ide', 'app']) {
        const res = await s.call('POST', `/api/deliverables/${row.id}/open`, { action }, REMOTE);
        expect(res, action).toMatchObject({ status: 403, json: { error: 'remote_control' } });
      }
      const anon = await s.call(
        'POST',
        `/api/deliverables/${row.id}/open`,
        { action: 'open' },
        {},
        null,
      );
      expect(anon.status).toBe(401);
      expect(opens(s.calls)).toEqual([]);
      expect(s.events('deliverable.opened')).toBe(0);
    }
  });

  it('never opens what would run code with Open, nor a file as an IDE folder', async () => {
    const s = await setup();
    const tool = await s.add('build.command', '#!/bin/sh\necho hi\n');
    expect(
      await s.call('POST', `/api/deliverables/${tool.row.id}/open`, { action: 'open' }),
    ).toMatchObject({ status: 409, json: { error: 'use_app' } });
    const { row } = await s.add('a.txt', 'a');
    expect(
      await s.call('POST', `/api/deliverables/${row.id}/open`, { action: 'ide' }),
    ).toMatchObject({ status: 409, json: { error: 'not_folder' } });
    expect(
      await s.call('POST', `/api/deliverables/${row.id}/open`, { action: 'app' }),
    ).toMatchObject({ status: 409, json: { error: 'not_app' } });
    expect(opens(s.calls)).toEqual([]);
  });

  it('opens an application only with its current fingerprint, and asks again when it changed', async () => {
    const s = await setup();
    mkdirSync(join(s.ws, 'Demo.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(s.ws, 'Demo.app', 'Contents', 'Info.plist'), '<plist/>');
    writeFileSync(join(s.ws, 'Demo.app', 'Contents', 'MacOS', 'Demo'), 'bin');
    const { row, path } = await s.add('Demo.app', undefined, { kind: 'app' });
    const url = `/api/deliverables/${row.id}/open`;

    const first = await s.call('POST', url, { action: 'app' });
    expect(first.status).toBe(409);
    const ask = OpenConfirmation.parse(first.json);
    expect(ask).toMatchObject({ code: 'confirm', name: 'Demo.app', addedBy: USER });
    expect(opens(s.calls)).toEqual([]);

    const wrong = await s.call('POST', url, { action: 'app', fingerprint: 'sha256:nope' });
    expect(wrong).toMatchObject({ status: 409, json: { code: 'confirm' } });
    expect(opens(s.calls)).toEqual([]);

    const confirmed = await s.call('POST', url, { action: 'app', fingerprint: ask.fingerprint });
    expect(confirmed.status).toBe(200);
    expect(opens(s.calls).map((c) => c.args)).toEqual([[path]]);
    expect(s.log.tables.deliverables.get(row.id)?.meta?.['confirmedOpen']).toMatchObject({
      fingerprint: ask.fingerprint,
      by: USER,
    });

    // Confirmed once: the next open of the same bundle goes straight through.
    expect((await s.call('POST', url, { action: 'app' })).status).toBe(200);
    expect(opens(s.calls)).toHaveLength(2);

    // A changed bundle asks again.
    writeFileSync(join(s.ws, 'Demo.app', 'Contents', 'MacOS', 'Other'), 'new');
    const again = await s.call('POST', url, { action: 'app' });
    expect(again).toMatchObject({ status: 409, json: { code: 'confirm' } });
    expect(OpenConfirmation.parse(again.json).fingerprint).not.toBe(ask.fingerprint);
    expect(opens(s.calls)).toHaveLength(2);
    expect(s.events('deliverable.opened')).toBe(2);
  });

  it('re-checks the path before opening: a swapped file is not opened', async () => {
    const s = await setup();
    const { row, path } = await s.add('a.txt', 'a');
    rmSync(path);
    symlinkSync(join(s.outside, 'secret.txt'), path);
    const res = await s.call('POST', `/api/deliverables/${row.id}/open`, { action: 'open' });
    expect(res.status).toBe(409);
    expect(opens(s.calls)).toEqual([]);
  });

  it('answers 501 not_mac off macOS, 404 for an unknown id, 400 for a command', async () => {
    const linux = await setup({ platform: 'linux' });
    const a = await linux.add('a.txt', 'a');
    expect(
      await linux.call('POST', `/api/deliverables/${a.row.id}/open`, { action: 'open' }),
    ).toMatchObject({ status: 501, json: { error: 'not_mac' } });
    const s = await setup();
    expect((await s.call('POST', '/api/deliverables/d-nope/open', { action: 'open' })).status).toBe(
      404,
    );
    const { value } = await s.commands.addDeliverable(
      {
        projectId: s.project.id,
        kind: 'command',
        title: 'Dev',
        source: 'user',
        command: { line: 'pnpm dev', cwd: s.ws },
      },
      USER,
      { origin: 'local' },
    );
    expect(
      await s.call('POST', `/api/deliverables/${value.id}/open`, { action: 'reveal' }),
    ).toMatchObject({ status: 400, json: { error: 'invalid' } });
    expect(
      await s.call('POST', `/api/deliverables/${value.id}/open`, { action: 'launch' }),
    ).toMatchObject({ status: 400, json: { error: 'invalid_body' } });
  });
});
