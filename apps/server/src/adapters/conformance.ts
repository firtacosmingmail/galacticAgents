import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Agent,
  AgentAdapter,
  AgentRuntime as RuntimeName,
  Event,
  EventEnvelope,
  Id,
  PermissionPolicy,
  StatusRecord,
} from '@galactic/protocol';
import { openDatabase, type Database } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import type { SpawnRequest } from '../runtime/agent-runtime.js';

/**
 * The adapter conformance suite (P1-04; TECHNOLOGY §3, IMPLEMENTATION_PLAN Phase 1). Every
 * adapter — fake, claude-sdk, and later acp / pty — must pass it, run through the real runtime
 * (log, status store, transcripts, inbox, caps) exactly as production wires it. It is the bar
 * for "this runtime is supported": spawn → output → clarification answered → permission answered
 * → pause/resume → interrupt → finish with cost; stop from every state; a session resumed after
 * the adapter went away; stall detection. Two invariants are checked on every run: one terminal
 * event per agent (P1-17) and no message handed to the adapter mid-turn (P1-19: the adapter
 * keeps no queue; a delivery it rejects shows up as an inbox error).
 *
 * A target supplies a fresh adapter per test and the prompts that make its agent do each thing
 * (scenario names for the fake adapter, natural-language instructions for a real one). The fake
 * runs in CI; the claude-sdk target is tagged local-only (P1-12).
 */

/**
 * Cases a target may skip, each with the reason (shown in the test name). `policyDeny` and
 * `toolCalls` (one `agent.tool_call` per tool use) need structured tool calls, which a terminal
 * agent (PTY, P8-08) does not have.
 */
export type OptionalConformanceCase =
  | 'crash'
  | 'spawnFailure'
  | 'concurrentSessions'
  | 'policyDeny'
  | 'toolCalls';

export interface ConformanceInstance {
  adapter: AgentAdapter;
  dispose(): Promise<void>;
  /**
   * Kills the agent's runtime from outside (a crash, `kill -9`): the adapter must report exactly
   * one `agent.failed(reason: crash)`. Required unless the target skips `crash`.
   */
  crash?(agentId: Id): Promise<void> | void;
}

export interface ConformanceTarget {
  name: string;
  runtime: RuntimeName;
  /** A fresh adapter. Called once per test; `dispose` runs after it. */
  create(): Promise<ConformanceInstance>;
  /** Working directory handed to every spawn. */
  cwd: string;
  prompts: {
    /** Produces output and at least one tool call, then finishes (with cost when metered). */
    finish: string;
    /** Asks exactly one clarification question, then finishes. */
    ask: string;
    /** Requests exactly one permission for a tool call, then finishes; `allow` runs the tool. */
    permission: string;
    /** Works for a while with several progress/tool events; must survive pause and interrupt. */
    long: string;
    /** Goes idle after a short first turn and echoes every later message in its output. */
    echo: string;
    /** Falls silent for longer than `stallThresholdMs` while working, then carries on. */
    stall?: string;
  };
  /** Whether `agent.finished` (or the idle that ends a job, see `jobEnd`) carries a cost. */
  metered: boolean;
  /**
   * How a job ends for this runtime. A scripted or process-per-job runtime finishes
   * (`agent.finished`); a long-lived session (the Claude SDK) reports `agent.idle` after the
   * job and waits for the next message — the Waykeeper closes the task later. Default `finished`.
   */
  jobEnd?: 'finished' | 'idle';
  /** Whether `resumeSession` is supported (PTY adapters: no). */
  resumable: boolean;
  /** Silence threshold for the stall test. */
  stallThresholdMs: number;
  /** Per-step wait budget. Real adapters need minutes. */
  timeoutMs?: number;
  /**
   * How a spawn in a directory that does not exist fails. `rejected` (default): `spawn()` itself
   * fails (`ok: false`, one `agent.failed(runtime)`). `event`: the session is created and its
   * runtime then fails to start — `spawn()` may resolve, and `agent.failed(runtime)` follows.
   */
  spawnFailure?: 'rejected' | 'event';
  /** A policy under which the `permission` prompt's tool call is denied without asking. */
  denyPolicy?: PermissionPolicy;
  /**
   * The permission policy every spawn runs under (default: the global default). A runtime that
   * runs only under some tables (PTY: the trusted preset, proposed decision 110) names one here.
   */
  spawnPolicy?: PermissionPolicy;
  /**
   * Whether the runtime reports structured tool calls (default `true`): `agent.tool_call` events
   * and a permission question's `toolCall`. A terminal agent (PTY) has none; its permission
   * questions are checked by `permissionEvidence` instead.
   */
  toolCalls?: boolean;
  /**
   * Transcript text the `permission` prompt's agent writes only when the permission was allowed
   * (checked on both answers). Required when `toolCalls` is `false`.
   */
  permissionEvidence?: string;
  /** Optional cases this target cannot run, with the reason. */
  skip?: Partial<Record<OptionalConformanceCase, string>>;
}

interface Rig {
  db: Database;
  composed: ComposedRuntime;
  adapterDispose: () => Promise<void>;
  crash: ((agentId: Id) => Promise<void> | void) | undefined;
  events: EventEnvelope[];
}

const DENY_DESTRUCTIVE: PermissionPolicy = { rules: { destructive: 'deny' } };

export function describeAdapterConformance(target: ConformanceTarget): void {
  const timeoutMs = target.timeoutMs ?? 5_000;
  const USER = { type: 'user' } as const;
  const jobEnd = target.jobEnd ?? 'finished';
  const JOB_END = `agent.${jobEnd}` as const;
  const structured = target.toolCalls !== false;
  if (!structured && !target.permissionEvidence) {
    throw new Error(`target ${target.name} has no tool calls: it needs permissionEvidence`);
  }

  // A real adapter needs minutes per case; the suite's timeout is the target's, not Vitest's.
  describe(`adapter conformance — ${target.name}`, { timeout: timeoutMs * 6 }, () => {
    let rig: Rig;

    beforeEach(async () => {
      const db = openDatabase(':memory:');
      const { adapter, dispose, crash } = await target.create();
      const composed = composeRuntime(db, {
        adapters: [adapter],
        flushMs: 10,
        tickMs: Math.max(20, Math.floor(target.stallThresholdMs / 4)),
        stallThresholdMs: () => target.stallThresholdMs,
        caps: { maxConcurrentAgents: 8 },
      });
      const events: EventEnvelope[] = [];
      composed.log.subscribe((e) => events.push(e));
      rig = { db, composed, adapterDispose: dispose, crash, events };
    });
    afterEach(async () => {
      await rig.composed.dispose();
      await rig.adapterDispose();
      rig.db.close();
    });

    const typesOf = (agentId: string) =>
      rig.events
        .filter((e) => 'agentId' in e.event && e.event.agentId === agentId)
        .map((e) => e.event.type);
    const status = (agentId: string): StatusRecord | undefined =>
      rig.composed.statuses.get(agentId);
    const waitFor = (pred: () => boolean, what: string, ms = timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          if (pred()) resolve();
          else if (Date.now() - t0 > ms)
            reject(
              new Error(
                `timed out waiting for ${what}; events: ${JSON.stringify(rig.events.map((e) => e.event.type))}`,
              ),
            );
          else setTimeout(tick, 10);
        };
        tick();
      });
    const transcript = (agentId: string) => {
      rig.composed.transcripts.flush();
      return rig.composed.transcripts.read(agentId);
    };
    const spawn = async (prompt: string, extra: Partial<SpawnRequest> = {}): Promise<Agent> => {
      const result = await rig.composed.runtime.spawn({
        role: 'steward',
        runtime: target.runtime,
        prompt,
        cwd: target.cwd,
        ...(target.spawnPolicy ? { permissionPolicy: target.spawnPolicy } : {}),
        ...extra,
      });
      if (!result.ok) throw new Error(result.reason);
      return result.agent;
    };
    const waitState = (agentId: string, state: StatusRecord['state']) =>
      waitFor(() => status(agentId)?.state === state, `state ${state} of ${agentId}`);
    const pendingQuestion = (agentId: string) => {
      const id = status(agentId)?.pendingQuestionId;
      if (!id) throw new Error(`no pending question on ${agentId}`);
      return id;
    };
    const eventsOf = <T extends Event['type']>(agentId: string, type: T) =>
      rig.events
        .map((e) => e.event)
        .filter((e) => e.type === type && 'agentId' in e && e.agentId === agentId) as Extract<
        Event,
        { type: T }
      >[];
    const indexOf = (pred: (e: Event) => boolean) => rig.events.findIndex((e) => pred(e.event));
    const transcriptText = (agentId: string) =>
      transcript(agentId)
        .map((c) => c.text)
        .join('\n');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const firstWork = (agentId: string) =>
      waitFor(
        () => typesOf(agentId).some((t) => t === 'agent.progress' || t === 'agent.tool_call'),
        'first work',
      );
    /** No `toolUseId` is reported twice: one `agent.tool_call` per tool use. */
    const expectOneCallPerToolUse = (agentId: string) => {
      const ids = eventsOf(agentId, 'agent.tool_call')
        .map((e) => e.toolUseId)
        .filter((id): id is string => id !== undefined);
      expect(ids).toEqual([...new Set(ids)]);
    };
    /** Whether the agent ran a tool call with exactly this tool and input. */
    const ran = (agentId: string, call: { toolName: string; input?: unknown }) =>
      eventsOf(agentId, 'agent.tool_call').some(
        (e) =>
          e.toolName === call.toolName && JSON.stringify(e.input) === JSON.stringify(call.input),
      );
    /**
     * Waits for the job end, answering every permission question with `deny` meanwhile (a real
     * model may try the refused call again, or another way).
     */
    const denyUntilJobEnd = async (agentId: string) => {
      const answered = new Set<string>();
      await waitFor(
        () => {
          const q = status(agentId)?.pendingQuestionId;
          if (q && !answered.has(q)) {
            answered.add(q);
            void rig.composed.runtime.answer(q, 'deny', USER).catch(() => {});
          }
          return typesOf(agentId).includes(JOB_END);
        },
        `${JOB_END} after deny`,
        timeoutMs * 3,
      );
    };
    const TERMINAL = ['agent.finished', 'agent.failed', 'agent.stopped'];
    /** After an agent ended: exactly one terminal event, and it stays that way. */
    const expectOneTerminal = async (agentId: string) => {
      await new Promise((r) => setTimeout(r, 100));
      expect(typesOf(agentId).filter((t) => TERMINAL.includes(t))).toHaveLength(1);
    };
    /** The inbox never had a delivery refused (the adapter was only ever sent while idle). */
    const expectCleanDeliveries = (agentId: string) => {
      const inbox = rig.composed.runtime.inbox(agentId);
      if (!inbox) return; // ended: the runtime forgot the session, the log has the messages
      expect(inbox.history().filter((m) => m.error !== undefined)).toEqual([]);
    };

    it(`spawns, streams output and tool calls, ends the job with ${JOB_END}`, async () => {
      const agent = await spawn(target.prompts.finish);
      expect(typesOf(agent.id)[0]).toBe('agent.spawned');
      await waitFor(() => typesOf(agent.id).includes(JOB_END), JOB_END);
      const types = typesOf(agent.id);
      if (structured) expect(types).toContain('agent.tool_call');
      expect(types.at(-1)).toBe(JOB_END);
      expect(types).not.toContain('agent.output'); // output never enters the log
      expect(transcript(agent.id).length).toBeGreaterThan(0);
      const end = rig.events.find((e) => e.event.type === JOB_END)!.event as {
        cost?: { usd?: number };
        result?: string;
      };
      if (target.metered) expect(end.cost?.usd).toBeGreaterThan(0);
      await waitState(agent.id, jobEnd);
      if (target.metered) expect(status(agent.id)?.costSoFar?.usd).toBeGreaterThan(0);
      if (jobEnd === 'finished') {
        expect(rig.composed.runtime.liveAgents()).toEqual([]);
        await expectOneTerminal(agent.id);
      }
    });

    it('asks a clarification question, waits, and continues with the answer', async () => {
      const agent = await spawn(target.prompts.ask);
      await waitState(agent.id, 'waiting_for_input');
      const q = rig.events.find((e) => e.event.type === 'agent.needs_input')!.event as {
        kind: string;
        questionId: string;
        question: { text: string };
      };
      expect(q.kind).toBe('clarification');
      expect(q.question.text.length).toBeGreaterThan(0);
      const before = typesOf(agent.id).length;
      await new Promise((r) => setTimeout(r, 50));
      expect(typesOf(agent.id).length).toBe(before); // blocked, no busy-waiting events
      const questionId = pendingQuestion(agent.id);
      // The server owns the question: a row was opened with the event (P1-23).
      expect(rig.composed.log.tables.questions.get(questionId)).toMatchObject({
        status: 'open',
        kind: 'clarification',
        originAgentId: agent.id,
      });
      await rig.composed.runtime.answer(questionId, 'the first option', USER);
      await waitFor(() => typesOf(agent.id).includes(JOB_END), 'job end after the answer');
      expect(rig.events.map((e) => e.event.type)).toContain('question.answered');
      expect(rig.composed.log.tables.questions.get(questionId)?.status).toBe('answered');
    });

    it('requests a permission with the tool call attached; allow runs it', async () => {
      const agent = await spawn(target.prompts.permission);
      await waitState(agent.id, 'waiting_for_input');
      const q = rig.events.find((e) => e.event.type === 'agent.needs_input')!.event as {
        kind: string;
        question: { toolCall?: { toolName: string }; permissionAction?: string };
      };
      expect(q.kind).toBe('permission');
      if (structured) {
        expect(q.question.toolCall?.toolName).toBeTruthy();
        expect(q.question.permissionAction).toBeTruthy();
      }
      const callsBefore = typesOf(agent.id).filter((t) => t === 'agent.tool_call').length;
      await rig.composed.runtime.answer(pendingQuestion(agent.id), 'allow', USER);
      await waitFor(() => typesOf(agent.id).includes(JOB_END), 'job end after allow');
      if (structured) {
        expect(typesOf(agent.id).filter((t) => t === 'agent.tool_call').length).toBeGreaterThan(
          callsBefore,
        );
      }
      if (target.permissionEvidence) {
        expect(transcriptText(agent.id)).toContain(target.permissionEvidence);
      }
    });

    it('pauses without events and resumes to completion', async () => {
      const agent = await spawn(target.prompts.long);
      await waitFor(
        () => typesOf(agent.id).some((t) => t === 'agent.progress' || t === 'agent.tool_call'),
        'first work',
      );
      await rig.composed.runtime.pause(agent.id, USER);
      await waitState(agent.id, 'paused');
      await new Promise((r) => setTimeout(r, 150));
      const frozen = typesOf(agent.id).length;
      await new Promise((r) => setTimeout(r, 250));
      expect(typesOf(agent.id).length).toBe(frozen);
      await rig.composed.runtime.resumeAgent(agent.id, USER);
      await waitFor(() => typesOf(agent.id).includes('agent.resumed'), 'agent.resumed');
      await waitFor(
        () => typesOf(agent.id).includes(JOB_END),
        'finish after resume',
        timeoutMs * 3,
      );
    });

    it('interrupt ends the turn with idle; queued messages are delivered in order, interrupts first', async () => {
      const agent = await spawn(target.prompts.long);
      await waitFor(
        () => typesOf(agent.id).some((t) => t === 'agent.progress' || t === 'agent.tool_call'),
        'first work',
      );
      rig.composed.runtime.send(agent.id, 'please reply with the word alpha', { sender: USER });
      rig.composed.runtime.send(agent.id, 'please reply with the word beta', { sender: USER });
      rig.composed.runtime.send(agent.id, 'please reply with the word gamma', {
        sender: USER,
        interrupt: true,
      });
      await waitFor(
        () => typesOf(agent.id).filter((t) => t === 'agent.idle').length >= 4,
        'four idles',
        timeoutMs * 3,
      );
      const history = rig.composed.runtime
        .inbox(agent.id)!
        .history()
        .map((m) => m.text);
      expect(history.map((t) => t.split(' ').at(-1))).toEqual(['gamma', 'alpha', 'beta']);
      const text = transcript(agent.id)
        .map((c) => c.text)
        .join('\n');
      expect(text.indexOf('gamma')).toBeGreaterThan(-1);
      expect(text.indexOf('gamma')).toBeLessThan(text.indexOf('alpha'));
      expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'));
      expect(typesOf(agent.id)).not.toContain('agent.finished');
      expectCleanDeliveries(agent.id);
      expect(typesOf(agent.id).filter((t) => t === 'message.sent')).toHaveLength(3);
    });

    it('echoes a message sent while idle', async () => {
      const agent = await spawn(target.prompts.echo);
      await waitState(agent.id, 'idle');
      rig.composed.runtime.send(agent.id, 'please reply with the word delta', { sender: USER });
      await waitFor(
        () => transcript(agent.id).some((c) => c.text.includes('delta')),
        'echo of delta',
      );
      await waitFor(
        () => typesOf(agent.id).filter((t) => t === 'agent.idle').length >= 2,
        'idle again',
      );
      expectCleanDeliveries(agent.id);
    });

    describe('stop from every state', () => {
      const expectStopped = async (agentId: string) => {
        await rig.composed.runtime.stop(agentId, USER);
        await waitFor(() => typesOf(agentId).includes('agent.stopped'), 'agent.stopped');
        await waitState(agentId, 'stopped');
        const n = typesOf(agentId).length;
        await new Promise((r) => setTimeout(r, 100));
        expect(typesOf(agentId).length).toBe(n);
        expect(typesOf(agentId)).not.toContain('agent.finished');
        expect(rig.composed.runtime.liveAgents().map((a) => a.id)).not.toContain(agentId);
        await expectOneTerminal(agentId);
      };

      it('while working', async () => {
        const agent = await spawn(target.prompts.long);
        await waitFor(
          () => typesOf(agent.id).some((t) => t === 'agent.progress' || t === 'agent.tool_call'),
          'first work',
        );
        await expectStopped(agent.id);
      });

      it('while waiting for an answer', async () => {
        const agent = await spawn(target.prompts.ask);
        await waitState(agent.id, 'waiting_for_input');
        await expectStopped(agent.id);
      });

      it('while paused', async () => {
        const agent = await spawn(target.prompts.long);
        await waitFor(
          () => typesOf(agent.id).some((t) => t === 'agent.progress' || t === 'agent.tool_call'),
          'first work',
        );
        await rig.composed.runtime.pause(agent.id, USER);
        await waitState(agent.id, 'paused');
        await expectStopped(agent.id);
      });

      it('while idle', async () => {
        const agent = await spawn(target.prompts.echo);
        await waitState(agent.id, 'idle');
        await expectStopped(agent.id);
      });

      if (jobEnd === 'finished') {
        it('after it finished is a no-op', async () => {
          const agent = await spawn(target.prompts.finish);
          await waitFor(() => typesOf(agent.id).includes('agent.finished'), 'agent.finished');
          const n = rig.events.length;
          await rig.composed.runtime.stop(agent.id, USER);
          await new Promise((r) => setTimeout(r, 50));
          expect(rig.events.length).toBe(n);
        });
      }
    });

    describe('failure paths', () => {
      const optional = (name: OptionalConformanceCase, title: string, fn: () => Promise<void>) => {
        const reason = target.skip?.[name];
        if (reason) it.skip(`${title} — skipped for ${target.name}: ${reason}`, () => {});
        else it(title, fn);
      };

      it('a permission answered deny: the tool does not run and the agent carries on', async () => {
        const agent = await spawn(target.prompts.permission);
        await waitState(agent.id, 'waiting_for_input');
        const q = eventsOf(agent.id, 'agent.needs_input')[0]!;
        expect(q.kind).toBe('permission');
        const call = q.question.toolCall;
        if (structured) expect(call?.toolName).toBeTruthy();
        await denyUntilJobEnd(agent.id);
        if (call) expect(ran(agent.id, call)).toBe(false);
        if (target.permissionEvidence) {
          expect(transcriptText(agent.id)).not.toContain(target.permissionEvidence);
        }
        expect(rig.composed.log.tables.questions.get(q.questionId)?.status).toBe('answered');
        expect(typesOf(agent.id)).not.toContain('agent.failed');
        expectOneCallPerToolUse(agent.id);
        if (jobEnd === 'finished') await expectOneTerminal(agent.id);
      });

      optional('policyDeny', 'a policy deny: the tool does not run, no question is asked, the reason is visible', async () => {
        const agent = await spawn(target.prompts.permission, {
          permissionPolicy: target.denyPolicy ?? DENY_DESTRUCTIVE,
        });
        // A model may retry another way that still needs asking: refuse that too.
        await denyUntilJobEnd(agent.id);
        const asked = eventsOf(agent.id, 'agent.needs_input').filter(
          (e) => e.kind === 'permission',
        );
        expect(asked).toEqual([]);
        expect(typesOf(agent.id)).not.toContain('agent.failed');
        // The refusal is explained to the agent and lands in its transcript.
        expect(transcriptText(agent.id)).toMatch(/denied/i);
        expectOneCallPerToolUse(agent.id);
        if (jobEnd === 'finished') await expectOneTerminal(agent.id);
      });

      optional('toolCalls', 'one agent.tool_call per tool use', async () => {
        const agent = await spawn(target.prompts.permission);
        await waitState(agent.id, 'waiting_for_input');
        const call = eventsOf(agent.id, 'agent.needs_input')[0]!.question.toolCall!;
        await rig.composed.runtime.answer(pendingQuestion(agent.id), 'allow', USER);
        await waitFor(() => typesOf(agent.id).includes(JOB_END), 'job end after allow');
        // The allowed call ran once — not once for the hook and again for the permission callback.
        const same = eventsOf(agent.id, 'agent.tool_call').filter(
          (e) =>
            e.toolName === call.toolName && JSON.stringify(e.input) === JSON.stringify(call.input),
        );
        expect(same).toHaveLength(1);
        expectOneCallPerToolUse(agent.id);
        // The status store counts exactly the reported calls.
        expect(status(agent.id)?.caps.toolCalls.used).toBe(
          eventsOf(agent.id, 'agent.tool_call').length,
        );
      });

      it('interrupt while paused: the agent is resumed, ends the turn and goes idle', async () => {
        const agent = await spawn(target.prompts.long);
        await firstWork(agent.id);
        await rig.composed.runtime.pause(agent.id, USER);
        await waitState(agent.id, 'paused');
        const idles = eventsOf(agent.id, 'agent.idle').length;
        await rig.composed.runtime.interrupt(agent.id);
        await waitFor(
          () => eventsOf(agent.id, 'agent.idle').length > idles,
          'idle after the interrupt',
        );
        await waitState(agent.id, 'idle');
        const resumed = indexOf((e) => e.type === 'agent.resumed' && e.agentId === agent.id);
        const idle = indexOf((e) => e.type === 'agent.idle' && e.agentId === agent.id);
        expect(resumed).toBeGreaterThan(-1);
        expect(resumed).toBeLessThan(idle);
        expect(typesOf(agent.id)).not.toContain('agent.finished');
        expect(rig.composed.runtime.liveAgents().map((a) => a.id)).toContain(agent.id);
        // Still a working session: it takes the next message.
        rig.composed.runtime.send(agent.id, 'please reply with the word zeta', { sender: USER });
        await waitFor(() => transcriptText(agent.id).includes('zeta'), 'echo of zeta');
        expectCleanDeliveries(agent.id);
      });

      it('interrupt while a question is open: the turn ends idle and the question is cancelled', async () => {
        const agent = await spawn(target.prompts.ask);
        await waitState(agent.id, 'waiting_for_input');
        const questionId = pendingQuestion(agent.id);
        await rig.composed.runtime.interrupt(agent.id);
        await waitState(agent.id, 'idle');
        expect(status(agent.id)?.pendingQuestionId).toBeUndefined();
        await waitFor(
          () => rig.composed.log.tables.questions.get(questionId)?.status === 'cancelled',
          'question cancelled',
        );
        expect(
          rig.events.some(
            (e) => e.event.type === 'question.cancelled' && e.event.questionId === questionId,
          ),
        ).toBe(true);
        await expect(rig.composed.runtime.answer(questionId, 'too late', USER)).rejects.toThrow();
        expect(typesOf(agent.id)).not.toContain('agent.finished');
        expect(rig.events.map((e) => e.event.type)).not.toContain('question.answered');
      });

      it('a message sent while paused is held, then delivered after resume', async () => {
        const agent = await spawn(target.prompts.echo);
        await waitState(agent.id, 'idle');
        await rig.composed.runtime.pause(agent.id, USER);
        await waitState(agent.id, 'paused');
        const m = rig.composed.runtime.send(agent.id, 'please reply with the word epsilon', {
          sender: USER,
        });
        await sleep(300);
        const deliveredOf = (e: Event) => e.type === 'message.delivered' && e.messageId === m.id;
        expect(indexOf(deliveredOf)).toBe(-1);
        expect(transcriptText(agent.id)).not.toContain('epsilon');
        await rig.composed.runtime.resumeAgent(agent.id, USER);
        await waitFor(() => indexOf(deliveredOf) > -1, 'message.delivered');
        const resume = indexOf(
          (e) =>
            e.type === 'control.resume' && e.target.kind === 'agent' && e.target.id === agent.id,
        );
        expect(resume).toBeGreaterThan(-1);
        expect(indexOf(deliveredOf)).toBeGreaterThan(resume);
        await waitFor(() => transcriptText(agent.id).includes('epsilon'), 'echo of epsilon');
        expectCleanDeliveries(agent.id);
      });

      optional(
        'crash',
        'an external kill ends the agent with exactly one agent.failed(crash)',
        async () => {
          if (!rig.crash)
            throw new Error(`target ${target.name} has no crash() and does not skip it`);
          const agent = await spawn(target.prompts.long);
          await firstWork(agent.id);
          await rig.crash(agent.id);
          await waitFor(() => typesOf(agent.id).includes('agent.failed'), 'agent.failed');
          await waitState(agent.id, 'failed');
          const failed = eventsOf(agent.id, 'agent.failed');
          expect(failed).toHaveLength(1);
          expect(failed[0]!.reason).toBe('crash');
          expect(rig.composed.runtime.liveAgents().map((a) => a.id)).not.toContain(agent.id);
          await expectOneTerminal(agent.id);
          // A stop after the crash is a no-op.
          const n = rig.events.length;
          await rig.composed.runtime.stop(agent.id, USER);
          await sleep(50);
          expect(rig.events.length).toBe(n);
        },
      );

      optional(
        'spawnFailure',
        'a spawn that cannot start (bad cwd) fails once, leaving no live agent',
        async () => {
          const agentId = `conformance-bad-cwd-${randomUUID()}`;
          const cwd = join(tmpdir(), `galactic-missing-${randomUUID()}`, 'nowhere');
          const result = await rig.composed.runtime.spawn({
            role: 'steward',
            runtime: target.runtime,
            prompt: target.prompts.finish,
            cwd,
            agentId,
          });
          if ((target.spawnFailure ?? 'rejected') === 'rejected') {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
          }
          await waitFor(() => typesOf(agentId).includes('agent.failed'), 'agent.failed');
          const failed = eventsOf(agentId, 'agent.failed');
          expect(failed).toHaveLength(1);
          expect(failed[0]!.reason).toBe('runtime');
          await waitState(agentId, 'failed');
          expect(rig.composed.runtime.liveAgents().map((a) => a.id)).not.toContain(agentId);
          expect(typesOf(agentId)).not.toContain('agent.tool_call');
          await expectOneTerminal(agentId);
        },
      );

      optional(
        'concurrentSessions',
        'two sessions at once do not cross events or output',
        async () => {
          const [a, b] = await Promise.all([
            spawn(target.prompts.echo),
            spawn(target.prompts.echo),
          ]);
          await Promise.all([waitState(a.id, 'idle'), waitState(b.id, 'idle')]);
          const ma = rig.composed.runtime.send(a.id, 'please reply with the word kilo', {
            sender: USER,
          });
          const mb = rig.composed.runtime.send(b.id, 'please reply with the word lima', {
            sender: USER,
          });
          await Promise.all([
            waitFor(() => transcriptText(a.id).includes('kilo'), 'kilo from a'),
            waitFor(() => transcriptText(b.id).includes('lima'), 'lima from b'),
          ]);
          await Promise.all([
            waitFor(() => eventsOf(a.id, 'agent.idle').length >= 2, 'a idle again'),
            waitFor(() => eventsOf(b.id, 'agent.idle').length >= 2, 'b idle again'),
          ]);
          expect(transcriptText(a.id)).not.toContain('lima');
          expect(transcriptText(b.id)).not.toContain('kilo');
          expect(eventsOf(a.id, 'message.delivered').map((e) => e.messageId)).toEqual([ma.id]);
          expect(eventsOf(b.id, 'message.delivered').map((e) => e.messageId)).toEqual([mb.id]);
          expect(eventsOf(a.id, 'agent.spawned')).toHaveLength(1);
          expect(eventsOf(b.id, 'agent.spawned')).toHaveLength(1);
          expectCleanDeliveries(a.id);
          expectCleanDeliveries(b.id);
        },
      );

      if (target.resumable) {
        /** An agent the server shut down: `interrupted`, its session gone. */
        const interruptedAgent = async () => {
          const agent = await spawn(target.prompts.echo);
          await waitState(agent.id, 'idle');
          await rig.composed.runtime.shutdown();
          await waitState(agent.id, 'interrupted');
          return agent;
        };
        const expectStaysInterrupted = async (agentId: string, sessionRef: string | undefined) => {
          const { sessionRef: _saved, ...row } = rig.composed.log.tables.agents.get(agentId)!;
          rig.composed.log.tables.agents.upsert(
            sessionRef === undefined ? row : { ...row, sessionRef },
          );
          const spawned = eventsOf(agentId, 'agent.spawned').length;
          const result = await rig.composed.runtime.recoverAgent(agentId);
          expect(result.ok).toBe(false);
          await sleep(100);
          expect(status(agentId)?.state).toBe('interrupted');
          expect(rig.composed.runtime.liveAgents().map((a) => a.id)).not.toContain(agentId);
          expect(eventsOf(agentId, 'agent.spawned')).toHaveLength(spawned);
          expect(typesOf(agentId)).not.toContain('agent.failed');
          expect(typesOf(agentId)).not.toContain('agent.finished');
        };

        it('a resume from an invalid session ref fails cleanly and the agent stays interrupted', async () => {
          const agent = await interruptedAgent();
          await expectStaysInterrupted(agent.id, 'not a session ref');
        });

        it('a resume without a session ref is refused and the agent stays interrupted', async () => {
          const agent = await interruptedAgent();
          await expectStaysInterrupted(agent.id, undefined);
        });
      }
    });

    if (target.resumable) {
      it('resumes a session from its ref after the adapter went away', async () => {
        const agent = await spawn(target.prompts.ask);
        await waitState(agent.id, 'waiting_for_input');
        const row = rig.composed.log.tables.agents.get(agent.id)!;
        expect(row.sessionRef).toBeTruthy();
        // The server goes down: the agent is interrupted (its question cancelled), then the
        // adapter (and with it the session) is gone.
        await rig.composed.runtime.shutdown();
        await rig.adapterDispose();
        const fresh = await target.create();
        rig.adapterDispose = fresh.dispose;
        const composed = composeRuntime(rig.db, {
          adapters: [fresh.adapter],
          flushMs: 10,
          stallThresholdMs: () => target.stallThresholdMs,
        });
        const old = rig.composed;
        rig.composed = composed;
        composed.log.subscribe((e) => rig.events.push(e));
        // The new server finds the agent live in the log: recovery marks it interrupted
        // (cancelling its question) and reopens it from the session ref.
        const report = await composed.recover();
        expect(report.resumed).toContain(agent.id);
        await waitFor(
          () => typesOf(agent.id).filter((t) => t === 'agent.spawned').length === 2,
          'second agent.spawned',
        );
        await waitFor(
          () => composed.statuses.get(agent.id)?.pendingQuestionId !== undefined,
          'question after resume',
        );
        await composed.runtime.answer(
          composed.statuses.get(agent.id)!.pendingQuestionId!,
          'the first option',
          USER,
        );
        await waitFor(() => typesOf(agent.id).includes(JOB_END), 'job end after resume');
        await old.dispose();
      });
    }

    if (target.prompts.stall) {
      it('a silent agent is reported stalled, then recovers', async () => {
        const agent = await spawn(target.prompts.stall!);
        await waitFor(() => status(agent.id)?.state === 'working', 'working');
        await waitFor(
          () =>
            status(agent.id)?.state === 'stalled' || typesOf(agent.id).includes('agent.stalled'),
          'stalled',
          target.stallThresholdMs * 4 + timeoutMs,
        );
        await waitFor(
          () => ['working', 'idle', 'finished'].includes(status(agent.id)?.state ?? ''),
          'recovery',
          timeoutMs * 3,
        );
      });
    }
  });
}
