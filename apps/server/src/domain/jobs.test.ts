import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applySnapshot,
  nextOccurrence,
  type Actor,
  type EventEnvelope,
  type Id,
  type JobDraft,
  type Snapshot,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { checkPlacement, createAgent } from './agents.js';
import { freeBody } from './bodies.js';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';
import { areaMoonFor, createArea, createJob, jobOf, setJobState, updateJob } from './jobs.js';
import { archiveProject, closeProject, createProject } from './projects.js';
import { transferTask } from './promotion.js';
import { openQuestion } from './questions.js';

/**
 * P10-03 — areas on moons and recurring jobs (SPEC decisions 143, 144): areas take free moons of
 * their project's planet, then share the one with the fewest areas; jobs (with their hidden task
 * on the area's moon) only on long-term projects, within the limits, without push rules or
 * secrets; stopping clears what a stopped job no longer needs; closing or archiving the project
 * stops its jobs and frees its area moons. Every command's rows equal the protocol fold.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const LONG_TERM = { purpose: 'Run the shop', goals: ['grow'] };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

function setup() {
  const w = world();
  const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
  const recorded: EventEnvelope[] = [];
  w.log.subscribe((e) => recorded.push(e));
  const cmd = <T>(fn: (ctx: CommandContext) => T): T => w.log.runCommand(fn).value;
  const longTerm = (bodyId: Id, name = 'Shop') =>
    cmd((ctx) =>
      createProject(ctx, { name, workspace: `/w/${name}`, bodyId, longTerm: LONG_TERM }),
    );
  const err = (fn: () => unknown): DomainError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  /** The protocol fold of everything logged equals the server's tables (areas, jobs, tasks, bodies). */
  const conforms = () => {
    let folded = applySnapshot(start);
    for (const env of recorded) folded = applyEvent(folded, env);
    const snap = w.log.snapshot();
    const byId = <T extends { id: Id }>(rows: T[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(folded.areas).toEqual(byId(snap.areas ?? []));
    expect(folded.jobs).toEqual(byId(snap.jobs ?? []));
    expect(folded.tasks).toEqual(byId(snap.tasks));
    expect(folded.bodies).toEqual(byId(snap.bodies));
    expect(folded.questions).toEqual(byId(snap.questions));
  };
  return { ...w, cmd, longTerm, err, conforms, recorded };
}

describe('areas on moons', () => {
  it('five areas on Saturn take five distinct free moons, hosted by the project’s areas', () => {
    const { cmd, longTerm, tables, conforms } = setup();
    const p = longTerm('b-saturn');
    const names = ['Feedback', 'Marketing', 'Sales', 'Finance', 'Research'];
    const areas = names.map((n) => cmd((ctx) => createArea(ctx, p.id, n)));
    expect(areas.map((a) => a.bodyId)).toEqual([
      'b-mimas',
      'b-enceladus',
      'b-tethys',
      'b-dione',
      'b-rhea',
    ]);
    for (const a of areas) {
      expect(tables.bodies.get(a.bodyId)?.host).toEqual({ kind: 'areas', id: p.id });
    }
    conforms();
  });

  it('on Mars the third area shares the moon with the fewest areas; the host stays areas', () => {
    const { cmd, longTerm, tables, conforms } = setup();
    const p = longTerm('b-mars');
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => cmd((ctx) => createArea(ctx, p.id, n)));
    expect([a!.bodyId, b!.bodyId]).toEqual(['b-phobos', 'b-deimos']);
    expect(c!.bodyId).toBe('b-phobos'); // a tie: catalogue order
    expect(d!.bodyId).toBe('b-deimos'); // Deimos now has fewer
    expect(tables.bodies.get('b-phobos')?.host).toEqual({ kind: 'areas', id: p.id });
    conforms();
  });

  it('reuses an area named the same, whatever the case', () => {
    const { cmd, longTerm, tables } = setup();
    const p = longTerm('b-saturn');
    const first = cmd((ctx) => createArea(ctx, p.id, 'Feedback'));
    expect(cmd((ctx) => createArea(ctx, p.id, ' feedback '))).toEqual(first);
    expect(tables.areas.all()).toHaveLength(1);
  });

  it('never takes a moon hosting an independent small project', () => {
    const { cmd, longTerm, err, log } = setup();
    cmd((ctx) => createProject(ctx, { name: 'Tiny', workspace: '/w/tiny', bodyId: 'b-phobos' }));
    const p = longTerm('b-mars');
    expect(areaMoonFor(log, 'b-mars').id).toBe('b-deimos');
    const areas = ['A', 'B', 'C'].map((n) => cmd((ctx) => createArea(ctx, p.id, n)));
    expect(areas.every((a) => a.bodyId === 'b-deimos')).toBe(true);
    // With Deimos taken by other work as well, nothing is left for a first area.
    const q = longTerm('b-neptune', 'Other');
    for (const id of ['b-proteus', 'b-triton', 'b-nereid']) {
      cmd((ctx) => createProject(ctx, { name: id, workspace: `/w/${id}`, bodyId: id }));
    }
    expect(err(() => cmd((ctx) => createArea(ctx, q.id, 'X'))).code).toBe('conflict');
  });

  it('refuses areas of a project that is not long-term, and more than 12 areas', () => {
    const { cmd, longTerm, err } = setup();
    const plain = cmd((ctx) =>
      createProject(ctx, { name: 'Plain', workspace: '/w/plain', bodyId: 'b-jupiter' }),
    );
    expect(err(() => cmd((ctx) => createArea(ctx, plain.id, 'A'))).code).toBe('invalid');
    const p = longTerm('b-saturn');
    for (let i = 0; i < 12; i++) cmd((ctx) => createArea(ctx, p.id, `Area ${i}`));
    expect(err(() => cmd((ctx) => createArea(ctx, p.id, 'One more'))).message).toMatch(/12 areas/);
  });

  it('an area moon of an active project is not freed by hand', () => {
    const { cmd, longTerm, err } = setup();
    const p = longTerm('b-saturn');
    const area = cmd((ctx) => createArea(ctx, p.id, 'Feedback'));
    expect(err(() => cmd((ctx) => freeBody(ctx, area.bodyId))).code).toBe('conflict');
  });

  it('a job’s hidden task stays with its job: never transferred to another project', () => {
    const { cmd, longTerm, err } = setup();
    const p = longTerm('b-saturn');
    const other = cmd((ctx) =>
      createProject(ctx, { name: 'Other', workspace: '/w/other', bodyId: 'b-jupiter' }),
    );
    const { job } = cmd((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
    );
    expect(err(() => cmd((ctx) => transferTask(ctx, job.taskId, other.id))).code).toBe('invalid');
  });
});

describe('createJob', () => {
  it('emits area.created, task.created (the hidden task on the moon) and job.created in one command', () => {
    const { log, longTerm, tables, conforms } = setup();
    const p = longTerm('b-saturn');
    const out = log.runCommand((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
    );
    const types = out.events.map((e) => e.event.type);
    expect(types).toEqual(['area.created', 'body.assigned', 'task.created', 'job.created']);
    expect(new Set(out.events.map((e) => e.at)).size).toBe(1);
    const at = out.events[0]!.at;
    const { job, area } = out.value;
    expect(area).toMatchObject({ name: 'Feedback', bodyId: 'b-mimas', createdAt: at });
    expect(tables.tasks.get(job.taskId)).toMatchObject({
      projectId: p.id,
      bodyId: 'b-mimas',
      description: 'Recurring job: Read the feedback',
      state: 'approved',
      meta: { jobId: job.id },
      createdAt: at,
    });
    expect(job).toMatchObject({ state: 'active', areaId: area.id, followUps: [], createdAt: at });
    const next = new Date(job.nextRunAt!);
    expect(job.nextRunAt).toBe(nextOccurrence(DRAFT.schedule, new Date(at)).toISOString());
    expect([next.getHours(), next.getMinutes()]).toEqual([9, 0]);
    expect(next.getTime()).toBeGreaterThan(Date.parse(at));
    expect(tables.jobs.get(job.id)).toEqual(job);
    conforms();
  });

  it('puts a job in an existing area by id or by name, and assigns rule ids', () => {
    const { cmd, longTerm } = setup();
    const p = longTerm('b-saturn');
    const first = cmd((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
    );
    const byId = cmd((ctx) =>
      createJob(ctx, {
        projectId: p.id,
        area: { areaId: first.area.id },
        draft: {
          ...DRAFT,
          unattendedRules: [
            {
              scope: 'prefix',
              tool: 'Bash',
              match: { kind: 'words', words: ['gh', 'issue', 'list'] },
              categories: ['run_workspace'],
              label: 'gh issue list …',
            },
          ],
        },
        by: USER,
      }),
    );
    const byName = cmd((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'FEEDBACK' }, draft: DRAFT, by: USER }),
    );
    expect(byId.area.id).toBe(first.area.id);
    expect(byName.area.id).toBe(first.area.id);
    expect(byId.job.unattendedRules[0]!.id).toMatch(/^r-[0-9a-f-]{36}$/);
  });

  it('refuses a project that is not long-term, the 11th job of an area, a push rule and a secret', () => {
    const { cmd, longTerm, err, tables } = setup();
    const plain = cmd((ctx) =>
      createProject(ctx, { name: 'Plain', workspace: '/w/plain', bodyId: 'b-jupiter' }),
    );
    const job = (projectId: Id, draft: JobDraft = DRAFT, area = 'Feedback') =>
      cmd((ctx) => createJob(ctx, { projectId, area: { name: area }, draft, by: USER }));
    const e = err(() => job(plain.id));
    expect(e.code).toBe('invalid');
    expect(e.message).toBe('jobs live on long-term projects');

    const p = longTerm('b-saturn');
    for (let i = 0; i < 10; i++) job(p.id, { ...DRAFT, name: `Job ${i}` });
    expect(err(() => job(p.id)).message).toMatch(/at most 10 jobs/);

    const push = {
      ...DRAFT,
      unattendedRules: [
        {
          scope: 'category' as const,
          tool: '*',
          match: { kind: 'categories' as const },
          categories: ['push' as const],
          label: 'push',
        },
      ],
    };
    expect(err(() => job(p.id, push, 'Sales')).code).toBe('invalid');
    const secret = {
      ...DRAFT,
      instructions: 'Call the API with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234',
    };
    expect(err(() => job(p.id, secret, 'Sales')).message).toMatch(/secret/);
    const secretRule = {
      ...DRAFT,
      unattendedRules: [
        {
          scope: 'exact' as const,
          tool: 'Bash',
          match: {
            kind: 'text' as const,
            text: 'curl -H "Authorization: Bearer abcdefghijklmnop1234"',
          },
          categories: ['network' as const],
          label: 'curl',
        },
      ],
    };
    expect(err(() => job(p.id, secretRule, 'Sales')).code).toBe('invalid');
    // Nothing of a refused job was written: no Sales area, no stray task.
    expect(tables.areas.all().map((a) => a.name)).toEqual(['Feedback']);
    expect(tables.tasks.all()).toHaveLength(10);
  });
});

describe('updateJob', () => {
  it('recomputes the next run for a new schedule and moves the task with its area', () => {
    const { cmd, longTerm, tables, conforms, log } = setup();
    const p = longTerm('b-saturn');
    const { job } = cmd((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
    );
    const sales = cmd((ctx) => createArea(ctx, p.id, 'Sales'));
    const out = log.runCommand((ctx) =>
      updateJob(ctx, {
        jobId: job.id,
        changes: { schedule: { kind: 'weekly', days: [1], at: '07:30' }, areaId: sales.id },
        by: USER,
      }),
    );
    const at = out.events[0]!.at;
    const updated = out.value;
    expect(updated.areaId).toBe(sales.id);
    expect(updated.nextRunAt).toBe(
      nextOccurrence({ kind: 'weekly', days: [1], at: '07:30' }, new Date(at)).toISOString(),
    );
    expect(tables.tasks.get(job.taskId)?.bodyId).toBe(sales.bodyId);
    expect(out.events.map((e) => e.event.type)).toEqual(['job.updated', 'task.updated']);
    // Unchanged fields change nothing.
    expect(
      log.runCommand((ctx) =>
        updateJob(ctx, { jobId: job.id, changes: { name: DRAFT.name }, by: USER }),
      ).events,
    ).toEqual([]);
    conforms();
  });
});

describe('setJobState', () => {
  function withFailure() {
    const s = setup();
    const p = s.longTerm('b-saturn');
    const { job } = s.cmd((ctx) =>
      createJob(ctx, { projectId: p.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
    );
    const question = s.cmd((ctx) => {
      const hq = createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS });
      const wk = createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        projectId: p.id,
        supervisorId: hq.id,
      });
      const steward = createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: job.taskId,
        projectId: p.id,
        supervisorId: wk.id,
      });
      const q = openQuestion(ctx, {
        id: 'q-failure',
        kind: 'clarification',
        originAgentId: steward.id,
        context: {
          text: 'The job failed',
          options: ['Fixed — retry now', 'Stop the job'],
          jobFailure: { jobId: job.id, runId: 'jr-1', reason: 'no network' },
        },
      });
      // What a failed run leaves (P10-04): paused, the question, a queued follow-up.
      const changes = {
        state: 'paused' as const,
        pausedReason: 'no network',
        failureQuestionId: q.id,
        followUps: [{ questionId: 'q-send', kind: 'send' as const, text: 'Thanks!' }],
      };
      ctx.tables.jobs.upsert({ ...ctx.tables.jobs.get(job.id)!, ...changes, updatedAt: ctx.now });
      ctx.emit({ type: 'job.updated', jobId: job.id, changes });
      return q;
    });
    return { ...s, p, job, question };
  }

  it('stopping cancels the open failure question, empties the follow-ups and clears the next run', () => {
    const { cmd, job, question, tables, conforms } = withFailure();
    const stopped = cmd((ctx) => setJobState(ctx, { jobId: job.id, state: 'stopped', by: USER }));
    expect(stopped.state).toBe('stopped');
    expect(stopped.followUps).toEqual([]);
    expect(stopped.nextRunAt).toBeUndefined();
    expect(stopped.failureQuestionId).toBeUndefined();
    expect(stopped.pausedReason).toBeUndefined();
    expect(tables.questions.get(question.id)?.status).toBe('cancelled');
    expect(jobOf({ tables }, job.id)).toEqual(stopped);
    conforms();
  });

  it('resuming a paused job makes it due now; a stopped one at its next occurrence', () => {
    const { log, job, tables, conforms } = withFailure();
    const resumed = log.runCommand((ctx) =>
      setJobState(ctx, { jobId: job.id, state: 'active', by: USER }),
    );
    expect(resumed.value.nextRunAt).toBe(resumed.events.at(-1)!.at);
    expect(resumed.value.pausedReason).toBeUndefined();
    expect(tables.questions.get('q-failure')?.status).toBe('cancelled');
    log.runCommand((ctx) => setJobState(ctx, { jobId: job.id, state: 'stopped', by: USER }));
    const again = log.runCommand((ctx) =>
      setJobState(ctx, { jobId: job.id, state: 'active', by: USER }),
    );
    expect(again.value.nextRunAt).toBe(
      nextOccurrence(DRAFT.schedule, new Date(again.events[0]!.at)).toISOString(),
    );
    // The same state is a no-op.
    expect(
      log.runCommand((ctx) => setJobState(ctx, { jobId: job.id, state: 'active', by: USER }))
        .events,
    ).toEqual([]);
    conforms();
  });

  it('a job task’s Steward answers to its project’s Waykeeper row, whatever that row’s state', () => {
    const { log, job, tables } = withFailure();
    const wk = tables.agents.all().find((a) => a.role === 'waykeeper')!;
    expect(() =>
      checkPlacement(log, {
        role: 'steward',
        taskId: job.taskId,
        projectId: job.projectId,
        supervisorId: wk.id,
      }),
    ).not.toThrow();
  });
});

describe('closing and archiving a long-term project', () => {
  it('stops every job and frees every area moon', () => {
    const { cmd, log, longTerm, tables, conforms } = setup();
    const p = longTerm('b-saturn');
    const jobs = ['Feedback', 'Sales', 'Feedback'].map(
      (area, i) =>
        cmd((ctx) =>
          createJob(ctx, {
            projectId: p.id,
            area: { name: area },
            draft: { ...DRAFT, name: `Job ${i}` },
            by: USER,
          }),
        ).job,
    );
    const closed = log.runCommand((ctx) => closeProject(ctx, p.id, USER));
    const freed = closed.events.filter((e) => e.event.type === 'body.freed');
    expect(freed.map((e) => (e.event as { bodyId: Id }).bodyId).sort()).toEqual([
      'b-enceladus',
      'b-mimas',
    ]);
    for (const j of jobs) {
      expect(tables.jobs.get(j.id)).toMatchObject({ state: 'stopped' });
      expect(tables.jobs.get(j.id)?.nextRunAt).toBeUndefined();
    }
    for (const id of ['b-mimas', 'b-enceladus'])
      expect(tables.bodies.get(id)?.host).toBeUndefined();
    // The hidden tasks never finish, and never hold the archive up.
    cmd((ctx) => archiveProject(ctx, p.id, USER));
    expect(tables.projects.get(p.id)?.state).toBe('archived');
    conforms();
  });

  it('archiving frees the area moons of a project whose areas were never closed', () => {
    const { cmd, log, longTerm, tables } = setup();
    const p = longTerm('b-saturn');
    cmd((ctx) => createJob(ctx, { projectId: p.id, area: { name: 'A' }, draft: DRAFT, by: USER }));
    // A cancelled project goes straight to archive from failed (cascade), skipping close.
    cmd((ctx) => {
      ctx.tables.projects.upsert({ ...ctx.tables.projects.get(p.id)!, state: 'failed' });
      ctx.emit({
        type: 'project.state_changed',
        projectId: p.id,
        from: 'approved',
        to: 'failed',
        by: USER,
      });
    });
    const out = log.runCommand((ctx) => archiveProject(ctx, p.id, USER));
    expect(out.events.map((e) => e.event.type)).toContain('body.freed');
    expect(tables.bodies.get('b-mimas')?.host).toBeUndefined();
    expect(tables.jobs.all().every((j) => j.state === 'stopped')).toBe(true);
  });
});
