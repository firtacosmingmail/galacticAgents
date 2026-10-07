import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, Id, Task } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
import { brainHarness, type BrainHarness } from '../brains/testing/index.js';
import { MAX_REPORT_CHARS, reportText } from './steward-reports.js';

/**
 * P2-11: which turn ends are a Steward's report. The harness's lenient Harmonizer is the
 * supervisor with a mailbox; the reports are `message.sent` from the Steward to it.
 */

let h: BrainHarness;
let scenarios: Record<string, FakeScenario>;
beforeEach(() => {
  scenarios = { ...SCENARIOS };
  h = brainHarness({ adapter: { scenarios } });
});
afterEach(() => h.dispose().catch(() => {}));

const events = (): Event[] => h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
const reportsFrom = (stewardId: Id) =>
  events().filter(
    (e): e is Extract<Event, { type: 'message.sent' }> =>
      e.type === 'message.sent' && e.sender.type === 'agent' && e.sender.id === stewardId,
  );
const isIdle = (id: Id) => () => h.statuses.get(id)?.state === 'idle';

async function steward(supervisorId: Id, prompt: string): Promise<Id> {
  const task = (await h.commands.createTask({ description: 'a small job' })).value;
  const { value } = await h.commands.spawnAgent({
    role: 'steward',
    runtime: 'fake',
    taskId: task.id,
    supervisorId,
    cwd: '/w/job',
    prompt,
  });
  return value.id;
}

describe('Steward reports (P2-11)', () => {
  it('a turn that ends on its own is one report, carrying the turn’s last text', async () => {
    scenarios['two-lines'] = {
      steps: [
        { kind: 'output', text: 'working' },
        { kind: 'output', text: 'thinking aloud', output: 'thinking' },
        { kind: 'output', text: 'Done: it works.' },
      ],
    };
    const hq = await h.startHarmonizer();
    const id = await steward(hq.agentId, 'scenario:two-lines');
    await h.until(() => reportsFrom(id).length > 0);
    await h.settle();
    const [report] = reportsFrom(id);
    expect(report).toMatchObject({ agentId: hq.agentId, interrupt: false });
    expect(report!.text).toMatch(/: the Steward ended its turn\. Its report: Done: it works\.$/);
    expect(h.composed.reports.sent).toEqual([
      { stewardId: id, supervisorId: hq.agentId, messageId: report!.messageId },
    ]);
    // The supervisor's brain folded it into a turn and marked it delivered.
    expect(hq.prompts().join('\n')).toContain(`agent ${id} reported:`);
    expect(events()).toContainEqual({
      type: 'message.delivered',
      messageId: report!.messageId,
      agentId: hq.agentId,
    });
  });

  it('an interrupted turn is not a report', async () => {
    scenarios['slow'] = {
      steps: [
        {
          kind: 'script',
          run: async (io) => {
            for (let i = 0; i < 1_000; i++) {
              await sleep(5);
              io.output(`still at it (${i})`);
            }
          },
        },
      ],
      onMessage: () => [],
    };
    const hq = await h.startHarmonizer();
    const id = await steward(hq.agentId, 'scenario:slow');
    await sleep(20);
    await h.runtime.interrupt(id);
    await h.until(isIdle(id));
    await h.settle();
    expect(reportsFrom(id)).toEqual([]);
  });

  it('a turn followed by a queued message is not a report; the next turn’s end is', async () => {
    scenarios['busy'] = {
      steps: [
        { kind: 'script', run: () => sleep(40) },
        { kind: 'output', text: 'first turn over' },
      ],
    };
    const hq = await h.startHarmonizer();
    const id = await steward(hq.agentId, 'scenario:busy');
    h.runtime.send(id, 'one more thing', { sender: { type: 'agent', id: hq.agentId } });
    await h.until(() => reportsFrom(id).length > 0);
    await h.settle();
    const reports = reportsFrom(id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('Its report: received: one more thing');
  });

  it('no report to a supervisor without a brain mailbox', async () => {
    const plain = (
      await h.commands.spawnAgent({
        role: 'harmonizer',
        runtime: 'fake',
        cwd: '/w/hq',
        prompt: 'scenario:echo',
      })
    ).value.id;
    await h.until(isIdle(plain));
    const id = await steward(plain, 'scenario:echo');
    await h.until(isIdle(id));
    await h.until(() => h.log.tables.tasks.all()[0]?.state === 'awaiting_closure');
    expect(reportsFrom(id)).toEqual([]);
    expect(h.runtime.inbox(plain)?.pending()).toEqual([]);
  });

  it('a report missed while the supervisor had no mailbox is sent again when it gets one (P2-16)', async () => {
    const plain = (
      await h.commands.spawnAgent({
        role: 'harmonizer',
        runtime: 'fake',
        cwd: '/w/hq',
        prompt: 'scenario:echo',
      })
    ).value.id;
    await h.until(isIdle(plain));
    scenarios['done'] = { steps: [{ kind: 'output', text: 'Done: all of it.' }] };
    const id = await steward(plain, 'scenario:done');
    await h.until(isIdle(id));
    expect(reportsFrom(id)).toEqual([]);
    h.composed.transcripts.flush();
    // The supervisor comes back as a brain (resumed, or started): the report owed is sent now.
    h.runtime.attachMailbox(plain);
    expect(h.composed.reports.resend(plain)).toEqual([id]);
    const [report] = reportsFrom(id);
    expect(report!.text).toContain('Its report: Done: all of it.');
    expect(report!.text).toContain('Sent again');
    // Once sent, it is not owed any more.
    expect(h.composed.reports.resend(plain)).toEqual([]);
  });

  it('the report text: the task, the report, a cut for very long ones, none for silence', () => {
    const task = { id: 't-1', description: 'fix it' } as Task;
    expect(reportText(task, ' Done: fixed. ')).toBe(
      'Task t-1 ("fix it"): the Steward ended its turn. Its report: Done: fixed.',
    );
    expect(reportText(task, undefined)).toBe(
      'Task t-1 ("fix it"): the Steward ended its turn without a report.',
    );
    const long = reportText(task, 'x'.repeat(MAX_REPORT_CHARS + 10));
    expect(long).toContain('(cut; the whole report is in its transcript)');
    expect(long.length).toBeLessThan(MAX_REPORT_CHARS + 200);
  });

  it('a Steward that cannot declare (ACP, PTY): its "Deliverables:" list is added for the supervisor (P9-04)', () => {
    const task = { id: 't-1', description: 'fix it' } as Task;
    const report =
      'Done: built.\nDeliverables:\n- image | shot.png | Screenshot\n- command | pnpm dev | Dev';
    const meta = { cwd: '/w/wt' };
    for (const runtime of ['acp', 'pty'] as const) {
      const text = reportText(task, report, { runtime, meta });
      expect(text).toContain('Its report: Done: built.');
      expect(text).toContain('declare_deliverable, taskId t-1');
      expect(text).toContain(
        JSON.stringify({
          taskId: 't-1',
          kind: 'image',
          title: 'Screenshot',
          path: '/w/wt/shot.png',
        }),
      );
      expect(text).toContain(
        JSON.stringify({ taskId: 't-1', kind: 'command', title: 'Dev', command: 'pnpm dev' }),
      );
    }
    // A Steward with the tool declared its own: nothing is added.
    expect(reportText(task, report, { runtime: 'claude-sdk', meta })).toBe(
      `Task t-1 ("fix it"): the Steward ended its turn. Its report: ${report}`,
    );
    // The block is read from the whole report, even when the report is cut.
    const long = `${'x'.repeat(MAX_REPORT_CHARS + 10)}\nDeliverables:\n- url | https://x.dev | X`;
    expect(reportText(task, long, { runtime: 'acp', meta })).toContain('"url":"https://x.dev"');
  });
});
