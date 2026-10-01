import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Agent,
  AgentAdapter,
  AgentRuntime as RuntimeName,
  EventEnvelope,
  StatusRecord,
} from '@galactic/protocol';
import { openDatabase, type Database } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';

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

export interface ConformanceTarget {
  name: string;
  runtime: RuntimeName;
  /** A fresh adapter. Called once per test; `dispose` runs after it. */
  create(): Promise<{ adapter: AgentAdapter; dispose(): Promise<void> }>;
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
}

interface Rig {
  db: Database;
  composed: ComposedRuntime;
  adapterDispose: () => Promise<void>;
  events: EventEnvelope[];
}

export function describeAdapterConformance(target: ConformanceTarget): void {
  const timeoutMs = target.timeoutMs ?? 5_000;
  const USER = { type: 'user' } as const;
  const jobEnd = target.jobEnd ?? 'finished';
  const JOB_END = `agent.${jobEnd}` as const;

  // A real adapter needs minutes per case; the suite's timeout is the target's, not Vitest's.
  describe(`adapter conformance — ${target.name}`, { timeout: timeoutMs * 6 }, () => {
    let rig: Rig;

    beforeEach(async () => {
      const db = openDatabase(':memory:');
      const { adapter, dispose } = await target.create();
      const composed = composeRuntime(db, {
        adapters: [adapter],
        flushMs: 10,
        tickMs: Math.max(20, Math.floor(target.stallThresholdMs / 4)),
        stallThresholdMs: () => target.stallThresholdMs,
        caps: { maxConcurrentAgents: 8 },
      });
      const events: EventEnvelope[] = [];
      composed.log.subscribe((e) => events.push(e));
      rig = { db, composed, adapterDispose: dispose, events };
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
    const spawn = async (prompt: string): Promise<Agent> => {
      const result = await rig.composed.runtime.spawn({
        role: 'steward',
        runtime: target.runtime,
        prompt,
        cwd: target.cwd,
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
      expect(types).toContain('agent.tool_call');
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
      expect(q.question.toolCall?.toolName).toBeTruthy();
      expect(q.question.permissionAction).toBeTruthy();
      const callsBefore = typesOf(agent.id).filter((t) => t === 'agent.tool_call').length;
      await rig.composed.runtime.answer(pendingQuestion(agent.id), 'allow', USER);
      await waitFor(() => typesOf(agent.id).includes(JOB_END), 'job end after allow');
      expect(typesOf(agent.id).filter((t) => t === 'agent.tool_call').length).toBeGreaterThan(
        callsBefore,
      );
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
