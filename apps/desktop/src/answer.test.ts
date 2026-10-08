import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerQuestion, outcomeNotice } from './answer.js';
import { parseCommand } from './lines.js';

/** A fake Mission Control: the answer route only, first answer wins, versions checked. */
class FakeServer {
  readonly received: { url: string; auth: string | undefined; body: Record<string, unknown> }[] =
    [];
  questions = new Map<string, { version: number; answer?: string }>();
  status: number | undefined;
  private server: Server | undefined;
  url = '';

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    this.received.push({ url: req.url ?? '', auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (this.status) return send(this.status, { error: 'internal' });
    if (req.headers.authorization !== 'Bearer secret-token') return send(401, { error: 'x' });
    const id = decodeURIComponent(/^\/api\/questions\/([^/]+)\/answer$/.exec(req.url ?? '')?.[1] ?? '');
    const q = this.questions.get(id);
    if (!q) return send(404, { error: 'not_found', message: `unknown question ${id}` });
    if (q.answer !== undefined || body['version'] !== q.version) {
      return send(409, { error: 'stale', message: 'already answered by you: "allow".' });
    }
    q.answer = String(body['answer']);
    q.version++;
    return send(200, { ok: true });
  }
}

let server: FakeServer;
beforeEach(async () => {
  server = new FakeServer();
  await server.start();
});
afterEach(async () => {
  await server.stop();
});

const deps = () => ({ baseUrl: server.url, token: 'secret-token' });

describe('answerQuestion (the menu bar → the answer route)', () => {
  it('Allow once sends the panel’s "allow" with the version and the token', async () => {
    server.questions.set('q-1', { version: 2 });
    const outcome = await answerQuestion({ questionId: 'q-1', version: 2, decision: 'allow' }, deps());
    expect(outcome).toEqual({ kind: 'answered' });
    expect(server.questions.get('q-1')?.answer).toBe('allow');
    const [req] = server.received;
    expect(req?.url).toBe('/api/questions/q-1/answer');
    expect(req?.auth).toBe('Bearer secret-token');
    expect(req?.body).toMatchObject({ answer: 'allow', version: 2 });
    expect(String(req?.body['answerId'])).toMatch(/^tray:/);
  });

  it('Deny sends the panel’s refusal ("no"), never an "always"', async () => {
    server.questions.set('q-1', { version: 0 });
    await answerQuestion({ questionId: 'q-1', version: 0, decision: 'deny' }, deps());
    expect(server.questions.get('q-1')?.answer).toBe('no');
    expect(JSON.stringify(server.received)).not.toMatch(/always/i);
  });

  it('a question answered elsewhere or changed since the menu showed it is stale', async () => {
    server.questions.set('q-1', { version: 3 });
    const outcome = await answerQuestion({ questionId: 'q-1', version: 2, decision: 'allow' }, deps());
    expect(outcome).toEqual({ kind: 'stale', message: 'already answered by you: "allow".' });
    expect(server.questions.get('q-1')?.answer).toBeUndefined();
    expect(outcomeNotice(outcome, 'allow')).toEqual({
      title: 'Permission request already answered',
      body: 'Your Allow was not sent: already answered by you: "allow".',
    });
  });

  it('an unknown question is gone; a server error or no server is a failure', async () => {
    expect(
      await answerQuestion({ questionId: 'q-x', version: 0, decision: 'deny' }, deps()),
    ).toEqual({ kind: 'gone' });
    server.status = 500;
    const failed = await answerQuestion({ questionId: 'q-x', version: 0, decision: 'deny' }, deps());
    expect(failed.kind).toBe('failed');
    await server.stop();
    const down = await answerQuestion(
      { questionId: 'q-x', version: 0, decision: 'deny' },
      { ...deps(), timeoutMs: 2000 },
    );
    expect(down).toEqual({ kind: 'failed', reason: 'Mission Control did not answer' });
    expect(outcomeNotice(down, 'deny')?.body).toBe(
      'Mission Control did not answer. Answer it in GalacticAgents.',
    );
  });

  it('a refused token is a failure that does not echo the token', async () => {
    server.questions.set('q-1', { version: 0 });
    const outcome = await answerQuestion(
      { questionId: 'q-1', version: 0, decision: 'allow' },
      { baseUrl: server.url, token: 'wrong-token' },
    );
    expect(outcome).toEqual({ kind: 'failed', reason: 'the token was refused' });
    expect(JSON.stringify(outcomeNotice(outcome, 'allow'))).not.toContain('wrong-token');
  });

  it('escapes the question id in the path', async () => {
    await answerQuestion({ questionId: 'q/../x', version: 0, decision: 'allow' }, deps());
    expect(server.received[0]?.url).toBe('/api/questions/q%2F..%2Fx/answer');
  });
});

describe('parseCommand', () => {
  it('reads the words and the menu’s answers', () => {
    expect(parseCommand('quit')).toBe('quit');
    expect(parseCommand(' start ')).toBe('start');
    expect(
      parseCommand('{"type":"answer","questionId":"q-1","version":2,"decision":"allow"}'),
    ).toEqual({ type: 'answer', questionId: 'q-1', version: 2, decision: 'allow' });
  });

  it('ignores anything else, an "always" included', () => {
    for (const line of [
      'stop',
      '{"type":"answer","questionId":"q-1","version":2,"decision":"always"}',
      '{"type":"answer","questionId":"q-1","version":-1,"decision":"deny"}',
      '{"type":"answer","questionId":"q-1","version":1.5,"decision":"deny"}',
      '{"type":"answer","questionId":"","version":1,"decision":"deny"}',
      '{"type":"answer","questionId":"q-1","decision":"deny"}',
      '{"type":"quit"}',
      '{not json',
      'null',
    ]) {
      expect(parseCommand(line)).toBeUndefined();
    }
  });
});
