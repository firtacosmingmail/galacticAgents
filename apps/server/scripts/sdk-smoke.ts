/**
 * P1-09 smoke: runs the real claude-sdk adapter through the runtime, the way the server does.
 * Local-only (needs a logged-in Claude Code). `pnpm --filter @galactic/server exec tsx scripts/sdk-smoke.ts [steps]`
 * Steps: basic ask permission pause stop resume (default: all).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@galactic/protocol';
import { ClaudeSdkAdapter } from '../src/adapters/claude-sdk/index.js';
import { openDatabase } from '../src/db/database.js';
import { composeRuntime } from '../src/runtime/compose.js';
import { ProcessSupervisor } from '../src/runtime/supervisor.js';

const steps = process.argv.slice(2);
const want = (s: string) => steps.length === 0 || steps.includes(s);
const cwd = mkdtempSync(join(tmpdir(), 'galactic-smoke-'));
writeFileSync(join(cwd, 'README.md'), '# smoke\n');
const log = (...a: unknown[]) => console.log(...a);
const USER = { type: 'user' } as const;

const supervisor = new ProcessSupervisor({ defaults: { graceMs: 15_000, termMs: 5_000 } });
const adapter = new ClaudeSdkAdapter({
  supervisor,
  model: process.env['SMOKE_MODEL'] ?? 'claude-sonnet-4-5',
  onError: (e, ctx) =>
    process.env['SMOKE_DEBUG']
      ? console.error(`[adapter ${ctx}]`, (e as Error).message)
      : undefined,
});
const composed = composeRuntime(openDatabase(':memory:'), {
  adapters: [adapter],
  flushMs: 20,
  caps: { maxConcurrentAgents: 3 },
});
const events: EventEnvelope[] = [];
composed.log.subscribe((e) => {
  events.push(e);
  const ev = e.event as Record<string, unknown>;
  const extra =
    ev['summary'] ??
    ev['toolName'] ??
    ev['error'] ??
    ev['result'] ??
    (ev['question'] as { text?: string } | undefined)?.text ??
    '';
  log(`  #${e.seq} ${e.event.type} ${String(extra).slice(0, 90)}`);
});
composed.transcripts.subscribe('*', 0, () => {});
const typesOf = (id: string) =>
  events.filter((e) => 'agentId' in e.event && e.event.agentId === id).map((e) => e.event.type);
const waitFor = (pred: () => boolean, what: string, ms = 120_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () =>
      pred()
        ? resolve()
        : Date.now() - t0 > ms
          ? reject(new Error(`timeout: ${what}`))
          : setTimeout(tick, 50);
    tick();
  });
const status = (id: string) => composed.statuses.get(id);
const transcript = (id: string) => {
  composed.transcripts.flush();
  return composed.transcripts
    .read(id)
    .map((c) => `${c.kind}: ${c.text.slice(0, 100).replace(/\n/g, ' ')}`);
};

async function spawn(prompt: string) {
  const r = await composed.runtime.spawn({ role: 'steward', runtime: 'claude-sdk', prompt, cwd });
  if (!r.ok) throw new Error(r.reason);
  return r.agent;
}

try {
  if (want('basic')) {
    log('\n== basic: spawn, idle, send, idle ==');
    const a = await spawn('Reply with exactly: ready');
    await waitFor(() => status(a.id)?.state === 'idle', 'idle');
    log('  status:', status(a.id)?.state, 'cost', status(a.id)?.costSoFar);
    composed.runtime.send(a.id, 'Now reply with exactly: second', { sender: USER });
    await waitFor(() => typesOf(a.id).filter((t) => t === 'agent.idle').length >= 2, 'second idle');
    log('  transcript:', transcript(a.id));
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
    log('  final:', typesOf(a.id).join(' '));
  }

  if (want('ask')) {
    log('\n== ask: AskUserQuestion → clarification ==');
    const a = await spawn(
      'Use the AskUserQuestion tool to ask me which colour I prefer (options: red, blue). Then reply with exactly the colour I chose.',
    );
    await waitFor(() => status(a.id)?.state === 'waiting_for_input', 'question');
    const q = composed.log.tables.questions.all().find((x) => x.originAgentId === a.id)!;
    log('  question:', q.kind, q.context.text, q.context.options);
    await composed.runtime.answer(q.id, 'blue', USER);
    await waitFor(() => status(a.id)?.state === 'idle', 'idle after answer');
    log('  transcript tail:', transcript(a.id).slice(-2));
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
  }

  if (want('permission')) {
    log('\n== permission: destructive command → ask → allow; outside workspace → ask → deny ==');
    const a = await spawn(
      `Run the shell command \`rm -rf ${join(cwd, 'junk')}\` (it may not exist; that is fine), then run \`cat /etc/hostname\`, then reply with exactly: done`,
    );
    await waitFor(() => status(a.id)?.state === 'waiting_for_input', 'permission 1');
    let q = composed.log.tables.questions
      .all()
      .filter((x) => x.originAgentId === a.id && x.status === 'open')[0]!;
    log(
      '  permission 1:',
      q.context.permissionAction,
      q.context.toolCall?.toolName,
      JSON.stringify(q.context.toolCall?.input).slice(0, 80),
    );
    await composed.runtime.answer(q.id, 'allow', USER);
    await waitFor(
      () =>
        composed.log.tables.questions
          .all()
          .filter((x) => x.originAgentId === a.id && x.status === 'open').length === 1,
      'permission 2',
    );
    q = composed.log.tables.questions
      .all()
      .filter((x) => x.originAgentId === a.id && x.status === 'open')[0]!;
    log(
      '  permission 2:',
      q.context.permissionAction,
      q.context.toolCall?.toolName,
      JSON.stringify(q.context.toolCall?.input).slice(0, 80),
    );
    await composed.runtime.answer(q.id, 'no', USER);
    await waitFor(() => status(a.id)?.state === 'idle', 'idle after permissions');
    log('  events:', typesOf(a.id).join(' '));
    log('  transcript tail:', transcript(a.id).slice(-3));
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
  }

  if (want('pause')) {
    log('\n== pause/resume: SIGSTOP during a long tool call ==');
    const a = await spawn(
      'Run the shell command `for i in 1 2 3 4 5 6; do echo tick $i; sleep 2; done` with the Bash tool, then reply with exactly: finished',
    );
    await waitFor(() => typesOf(a.id).includes('agent.tool_call'), 'tool call started');
    await composed.runtime.pause(a.id, USER);
    const paused = Date.now();
    await new Promise((r) => setTimeout(r, 6_000));
    log('  while paused: state', status(a.id)?.state, 'events', typesOf(a.id).length);
    await composed.runtime.resumeAgent(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'idle', 'idle after resume', 90_000);
    log(
      `  resumed; idle after ${Date.now() - paused} ms; transcript tail:`,
      transcript(a.id).slice(-2),
    );
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
  }

  if (want('stop')) {
    log('\n== stop mid-turn: graceful sequence ==');
    const a = await spawn(
      'Run the shell command `sleep 40 && echo late` with the Bash tool, then reply with exactly: late',
    );
    await waitFor(() => typesOf(a.id).includes('agent.tool_call'), 'tool call started');
    const t0 = Date.now();
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
    log(`  stopped in ${Date.now() - t0} ms; events: ${typesOf(a.id).join(' ')}`);
    log(
      '  process row:',
      supervisor.processRecord(a.id)?.status,
      supervisor.processRecord(a.id)?.signal ?? supervisor.processRecord(a.id)?.exitCode,
    );
  }

  if (want('resume')) {
    log('\n== resumeSession: new adapter, same session ref ==');
    const a = await spawn('Remember the codeword "andromeda". Reply with exactly: stored');
    await waitFor(() => status(a.id)?.state === 'idle', 'idle');
    const row = composed.log.tables.agents.get(a.id)!;
    log('  sessionRef:', row.sessionRef);
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped');
    const r = await composed.runtime.resume(row, {
      prompt: 'What was the codeword? Reply with just the word.',
      cwd,
    });
    if (!r.ok) throw new Error(r.reason);
    await waitFor(
      () => typesOf(a.id).filter((t) => t === 'agent.idle').length >= 2,
      'idle after resume',
    );
    log('  transcript tail:', transcript(a.id).slice(-1));
    await composed.runtime.stop(a.id, USER);
    await waitFor(() => status(a.id)?.state === 'stopped', 'stopped again');
  }
} finally {
  await composed.dispose();
  await supervisor.dispose();
  log('\nlive processes left:', supervisor.runningCount);
}
