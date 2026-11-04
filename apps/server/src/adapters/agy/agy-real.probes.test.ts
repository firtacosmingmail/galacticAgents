import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, GateVerdict, ToolCall } from '@galactic/protocol';
import { registerAgyHookRoutes } from '../../http/agy-hook-routes.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { AgyAdapter } from './agy-adapter.js';
import { hooksFile } from './global-entries.js';
import { HookBridge } from './hook-bridge.js';

/**
 * Two one-off probes of the real Antigravity CLI (P11-05 fix round 1; rulings R12 and the
 * reviewer's hook-combination question). Local-only, env-gated, and they touch the real
 * `~/.gemini/config/hooks.json` — every change is undone and the file restored to its exact
 * original bytes (or removed when it was absent):
 *
 *   GALACTIC_REAL_AGY_PROBES=1 npx vitest run src/adapters/agy/agy-real.probes.test.ts
 *
 * 1. **Several PreToolUse hooks**: a user hook group that answers `auto_approve` to everything,
 *    placed before and after Mission Control's; the gate denies `touch marker.txt`. Does the
 *    command run (another hook overrides our deny)?
 * 2. **MCP `tools/call` timeout**: `ask_user` left unanswered for up to 12 minutes; when does agy
 *    give up on the call (the agent speaks or the turn ends while the question is open)?
 *
 * Results go to the console and, with `GALACTIC_REAL_AGY_PROBE_OUT=<file>`, one JSON line each.
 */
const enabled = process.env['GALACTIC_REAL_AGY_PROBES'] === '1';
const WAIT_MS = Number(process.env['GALACTIC_REAL_AGY_PROBE_WAIT_MS'] ?? 12 * 60_000);

const report = (entry: Record<string, unknown>) => {
  console.log('[probe]', JSON.stringify(entry));
  const out = process.env['GALACTIC_REAL_AGY_PROBE_OUT'];
  if (out) appendFileSync(out, `${JSON.stringify(entry)}\n`);
};

if (!enabled) {
  describe('agy probes (real CLI)', () => {
    it.skip('run only with GALACTIC_REAL_AGY_PROBES=1 (real ~/.gemini, quota)', () => {});
  });
} else {
  const home = homedir();
  const stateDir = mkdtempSync(join(tmpdir(), 'galactic-agy-probe-state-'));
  const bridge = new HookBridge();
  const app = Fastify();
  registerAgyHookRoutes(app, { bridge });
  let url = '';
  beforeAll(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
  });
  afterAll(() => app.close());

  async function withAdapter<T>(
    gate: (call: ToolCall) => GateVerdict,
    prompt: string,
    body: (ctx: {
      adapter: AgyAdapter;
      events: AgentEvent[];
      cwd: string;
      sessionId: string;
    }) => Promise<T>,
    extra: { askHoldMs?: number } = {},
  ): Promise<T> {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-agy-probe-')));
    const supervisor = new ProcessSupervisor({});
    const adapter = new AgyAdapter({
      supervisor,
      command: process.env['GALACTIC_REAL_AGY_COMMAND'] ?? 'agy',
      hookUrl: () => url,
      bridge,
      home,
      stateDir,
      ...extra,
    });
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const e of adapter.events) events.push(e);
    })();
    try {
      const handle = await adapter.spawn({
        agentId: `probe-${Math.random()}`,
        role: 'steward',
        cwd,
        prompt,
        caps: { maxWallClockMs: 3_600_000, maxToolCalls: 50 },
        gate: { check: gate },
      });
      return await body({ adapter, events, cwd, sessionId: handle.sessionId });
    } finally {
      await adapter.dispose();
      await supervisor.dispose();
    }
  }

  const ended = (events: AgentEvent[]) =>
    events.some((e) => ['agent.idle', 'agent.failed', 'agent.stopped'].includes(e.type));
  const until = async (pred: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 500));
    return pred();
  };

  describe('agy probes (real CLI)', () => {
    for (const order of ['user hook after ours', 'user hook before ours'] as const) {
      it(`several PreToolUse hooks: ${order}`, { timeout: 600_000 }, async () => {
        const file = hooksFile(home);
        const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
        const scripts = mkdtempSync(join(tmpdir(), 'galactic-agy-probe-hook-'));
        const approve = join(scripts, 'approve.mjs');
        writeFileSync(approve, 'process.stdout.write(\'{"decision":"auto_approve"}\');\n');
        const userGroup = {
          enabled: true,
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: `'${process.execPath}' '${approve}'`, timeout: 30 },
              ],
            },
          ],
        };
        const base: Record<string, unknown> =
          order === 'user hook before ours'
            ? { 'probe-user': userGroup }
            : // A placeholder of ours first keeps our key ahead of the user's (replaced in place).
              { galactic: { galactic: true, enabled: false }, 'probe-user': userGroup };
        writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`);
        try {
          const result = await withAdapter(
            (call) =>
              call.toolName === 'Bash'
                ? { decision: 'deny', reason: 'probe: the gate denies this command' }
                : { decision: 'allow' },
            'Run the shell command `touch marker.txt` once (if it is refused, do not try again or another way), then reply with exactly: done',
            async ({ events, cwd }) => {
              await until(() => ended(events), 300_000);
              return {
                order,
                markerCreated: existsSync(join(cwd, 'marker.txt')),
                hookOrder: Object.keys(JSON.parse(readFileSync(file, 'utf8'))),
                transcript: events
                  .filter((e) => e.type === 'agent.output')
                  .map((e) => (e as { text: string }).text)
                  .join(' | ')
                  .slice(0, 1500),
              };
            },
          );
          report({ probe: 'hooks', ...result });
          expect(typeof result.markerCreated).toBe('boolean');
        } finally {
          if (original === null) rmSync(file, { force: true });
          else writeFileSync(file, original);
        }
      });
    }

    it(
      'a deferred ask_user (held 20 s) gets its answer as the next run',
      { timeout: 900_000 },
      async () => {
        const result = await withAdapter(
          () => ({ decision: 'allow' }),
          'Ask me which colour I like using the ask_user tool of the galactic MCP server, wait for my answer, then reply with exactly the colour I chose.',
          async ({ adapter, events }) => {
            await until(
              () => events.some((e) => e.type === 'agent.needs_input') || ended(events),
              300_000,
            );
            const q = events.find((e) => e.type === 'agent.needs_input') as
              Extract<AgentEvent, { type: 'agent.needs_input' }> | undefined;
            if (!q) return { asked: false };
            // Past the hold: the MCP call has returned and the agy run may have ended.
            await new Promise((r) => setTimeout(r, 60_000));
            const idleBeforeAnswer = events.some((e) => e.type === 'agent.idle');
            await adapter.answer(q.questionId, 'teal');
            await until(() => ended(events), 300_000);
            const finalText = events
              .filter((e) => e.type === 'agent.output')
              .map((e) => (e as { text: string }).text)
              .join(' | ')
              .slice(-1500);
            return {
              asked: true,
              idleBeforeAnswer,
              endedIdle: events.some((e) => e.type === 'agent.idle'),
              answerReachedAgent: /teal/i.test(
                finalText.split('has not answered yet').at(-1) ?? '',
              ),
              finalText,
            };
          },
          { askHoldMs: 20_000 },
        );
        report({ probe: 'deferred-ask', ...result });
        expect(result.asked).toBe(true);
      },
    );

    it(
      'MCP tools/call timeout: ask_user left unanswered',
      { timeout: WAIT_MS + 600_000 },
      async () => {
        const result = await withAdapter(
          () => ({ decision: 'allow' }),
          'Ask me which colour I like using the ask_user tool of the galactic MCP server, wait for my answer, then reply with exactly the colour I chose.',
          async ({ adapter, events }) => {
            await until(
              () => events.some((e) => e.type === 'agent.needs_input') || ended(events),
              300_000,
            );
            const q = events.find((e) => e.type === 'agent.needs_input') as
              Extract<AgentEvent, { type: 'agent.needs_input' }> | undefined;
            if (!q) return { asked: false, events: events.map((e) => e.type) };
            const askedAt = Date.now();
            const before = events.length;
            // Anything the agent does after asking means agy gave up on the call.
            await until(
              () => events.slice(before).some((e) => e.type !== 'agent.needs_input'),
              WAIT_MS,
            );
            const after = events.slice(before);
            const heldMs = Date.now() - askedAt;
            const cutOff = after.length > 0;
            let answered: string | undefined;
            if (!ended(events)) {
              try {
                await adapter.answer(q.questionId, 'teal');
                answered = 'teal';
              } catch (error) {
                answered = `not deliverable: ${(error as Error).message}`;
              }
              await until(() => ended(events), 300_000);
            }
            const finalText = events
              .filter((e) => e.type === 'agent.output')
              .map((e) => (e as { text: string }).text)
              .join(' | ')
              .slice(-1500);
            return {
              asked: true,
              heldMs,
              cutOff,
              firstAfter: after.slice(0, 5).map((e) => e.type),
              answered,
              answerReachedAgent: /teal/i.test(finalText),
              finalText,
            };
          },
        );
        report({ probe: 'mcp-timeout', waitMs: WAIT_MS, ...result });
        expect(result.asked).toBe(true);
      },
    );
  });
}
