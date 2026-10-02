import {
  proposalPromotion,
  type Actor,
  type Agent,
  type AgentRuntime,
  type BodyChoice,
  type EventEnvelope,
  type Id,
  type Project,
  type PromotionOutcome,
  type PromotionRequest,
  type Proposal,
} from '@galactic/protocol';
import type { Commands } from '../domain/commands.js';
import { describeRefusal } from '../domain/catalogue.js';
import { release } from '../domain/bodies.js';
import { DomainError, must } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import {
  carriedOut,
  createPromotedProject,
  moveProject,
  promotionRoom,
  recordPromotion,
  transferTask,
} from '../domain/promotion.js';
import { FINISHED_WORK, setProjectState } from '../domain/states.js';

/**
 * Carrying out promotion cards (P2-12; SPEC §3.4, decisions 2, 9, 15, 32). The move is the
 * server's, not a brain's: deterministic steps on the user's decision, each one a domain command,
 * and the card's owner (the Harmonizer, or the Waykeeper that asked) is woken by
 * `promotion.carried_out` to report it.
 *
 * - **Card made** (`proposal.created`, a task target): the task's live Stewards are paused while
 *   the user decides (SPEC §3.4), by the actor `system:promotion:<card>`.
 * - **Rejected:** the Stewards it paused resume where they are. Edited or parked: they wait.
 * - **Approved:** a task target gets its new project (a moon or planet on the card's body when it
 *   is still free, else the catalogue's choice; a Waykeeper's moon is a sub-project of its
 *   project), or joins the card's existing project; the project's Waykeeper is started when none
 *   runs; the task moves (`moveTask`: `body.moved` and the asteroid's marker, or `transferTask`
 *   for a project task) and its Stewards are handed over in the same command; the Stewards this
 *   card paused resume. A project target moves to its new body (`moveProject`). Then the card
 *   records the outcome (`meta.carriedOut`) and `promotion.carried_out` is logged.
 * - **Idempotent:** every step checks what is already done, a card is carried out once (by its
 *   record), and `start()` carries out approved cards a previous server life left unrecorded and
 *   pauses again the Stewards of cards still waiting for the user (a pause does not survive a
 *   restart).
 * - **Body:** the approval itself took the card's body (P2-09: the new project is created on it,
 *   a project target moved to it), so nothing can take it while the flow waits.
 * - **Waiting, not failing:** what may pass — no running Harmonizer (or parent Waykeeper) yet, a
 *   spawn cap, a Waykeeper spawn under way (the Harmonizer's own `spawn_waykeeper`, which the
 *   flow then adopts) — leaves the card approved and unrecorded, its Stewards paused, and it is
 *   tried again on the next agent lifecycle event and every `retryMs`, for `giveUpMs`. These
 *   checks come before anything moves.
 * - **Failing:** any other error (or waiting too long) records `ok: false` with the reason and
 *   resumes the paused Stewards; a new project the card made that holds nothing is failed and its
 *   body freed, so a failure never keeps a body. The owner is told.
 */

export interface PromotionFlowOptions {
  log: EventLog;
  commands: Commands;
  /** Agents with a live session (`AgentRuntime.liveAgents`): who runs, who can be paused. */
  liveAgents: () => Agent[];
  /** Starts a project's Waykeeper brain (the server wires P2-10's definition). */
  startWaykeeper: (input: {
    projectId: Id;
    supervisorId: Id;
    runtime: AgentRuntime;
  }) => Promise<{ agentId: Id }>;
  /**
   * The body a card that needs one gets now, when the approval did not already take it (a card
   * approved by an older server). Default `promotionRoom` (P2-09's `roomFor`) with the log's
   * running check: the card's body while it is free, else the catalogue's choice.
   */
  roomFor?: (p: Proposal) => BodyChoice | undefined;
  /** How often cards waiting for a retry are tried again (default 1 min; 0: on events only). */
  retryMs?: number;
  /** How long a card may wait before its failure is recorded (default 2 h). */
  giveUpMs?: number;
  /** Clock for `giveUpMs` (default `Date.now`). */
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

/** A step that may succeed later: the card waits, approved and unrecorded, and is tried again. */
export class RetryLater extends Error {
  override readonly name = 'RetryLater';
}

/** Events after which a waiting card may go through: an agent started, ended or came back. */
const RETRY_ON = new Set([
  'agent.spawned',
  'agent.resumed',
  'agent.finished',
  'agent.failed',
  'agent.stopped',
  'agent.interrupted',
]);

/** Proposal states in which a card still waits for the user. */
const UNDECIDED = new Set(['pending', 'edited', 'parked']);

/** The actor a card pauses and resumes its Stewards as. */
export const promotionActor = (proposalId: Id): Actor => ({
  type: 'system',
  id: `promotion:${proposalId}`,
});

export class PromotionFlow {
  private readonly running = new Map<Id, Promise<PromotionOutcome | undefined>>();
  private readonly work = new Set<Promise<unknown>>();
  /** Cards waiting for a retry: since when, and why. */
  private readonly waiting = new Map<Id, { since: number; reason: string }>();
  private unsubscribe: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: PromotionFlowOptions) {}

  /**
   * Subscribes to card decisions, carries out approved cards left unrecorded, and pauses again
   * the Stewards of cards still waiting for the user.
   */
  start(): this {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.opts.log.subscribe((e) => this.onEvent(e));
    for (const p of this.opts.log.tables.proposals.all()) {
      const request = proposalPromotion(p);
      if (!request || carriedOut(p)) continue;
      if (p.state === 'approved') this.track(this.carryOut(p.id));
      else if (UNDECIDED.has(p.state)) this.track(this.pauseStewards(p, request, true));
    }
    const every = this.opts.retryMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => this.retryWaiting(), every);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The cards waiting for a retry, with the reason (tests, diagnostics). */
  waitingCards(): { proposalId: Id; reason: string }[] {
    return [...this.waiting].map(([proposalId, w]) => ({ proposalId, reason: w.reason }));
  }

  private retryWaiting(): void {
    for (const id of this.waiting.keys()) this.track(this.carryOut(id));
  }

  /** Resolves when every step started so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private onEvent({ event }: EventEnvelope): void {
    if (this.waiting.size > 0 && RETRY_ON.has(event.type)) {
      // After the commit that announced it: a Waykeeper just spawned is live by then.
      this.track(Promise.resolve().then(() => this.retryWaiting()));
    }
    const id =
      event.type === 'proposal.created'
        ? event.proposal.id
        : event.type === 'proposal.approved' || event.type === 'proposal.rejected'
          ? event.proposalId
          : undefined;
    if (!id) return;
    const proposal = this.opts.log.tables.proposals.get(id);
    const request = proposalPromotion(proposal);
    if (!proposal || !request) return;
    // Commands run outside the subscriber, after the commit that announced the decision.
    const step: () => Promise<unknown> =
      event.type === 'proposal.created'
        ? () => this.pauseStewards(proposal, request)
        : event.type === 'proposal.approved'
          ? () => this.carryOut(id)
          : () => this.resumeStewards(proposal, request);
    this.track(Promise.resolve().then(step));
  }

  private track(p: Promise<unknown>): void {
    const tracked = p
      .catch((error: unknown) => this.opts.onError?.(error, 'promotion'))
      .finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  /**
   * Carries out an approved promotion card once; a second call (or a concurrent one) gets the
   * same outcome. `undefined` for a card that is not an approved promotion.
   */
  carryOut(proposalId: Id): Promise<PromotionOutcome | undefined> {
    const current = this.running.get(proposalId);
    if (current) return current;
    const run = this.carry(proposalId).finally(() => this.running.delete(proposalId));
    this.running.set(proposalId, run);
    return run;
  }

  private async carry(proposalId: Id): Promise<PromotionOutcome | undefined> {
    const { log } = this.opts;
    const proposal = log.tables.proposals.get(proposalId);
    const request = proposalPromotion(proposal);
    if (!proposal || !request || proposal.state !== 'approved') return undefined;
    const done = carriedOut(proposal);
    if (done) return done;
    let outcome: PromotionOutcome;
    try {
      outcome =
        request.target.kind === 'project'
          ? this.promoteProject(proposal, request)
          : await this.promoteTask(proposal, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = (this.opts.now ?? Date.now)();
      const since = this.waiting.get(proposalId)?.since ?? now;
      if (error instanceof RetryLater && now - since < (this.opts.giveUpMs ?? 2 * 60 * 60_000)) {
        // The card waits, its Stewards paused (their wall clocks stopped), and is tried again.
        this.waiting.set(proposalId, { since, reason: message });
        return undefined;
      }
      outcome = { ok: false, target: request.target, error: message };
      this.undo(proposal, request);
    }
    this.waiting.delete(proposalId);
    await this.resumeStewards(proposal, request);
    return carriedOut(log.runCommand((ctx) => recordPromotion(ctx, proposalId, outcome)).value);
  }

  // -- a task grows into a project, or joins one ----------------------------------------------

  private async promoteTask(p: Proposal, req: PromotionRequest): Promise<PromotionOutcome> {
    const { log, commands } = this.opts;
    const tables = log.tables;
    // The card may predate this server life: the Stewards wait for the move either way.
    await this.pauseStewards(p, req);
    const task = must(tables.tasks.get(req.target.id), 'task', req.target.id);
    // Checked before anything starts: finished work does not move (a final failure).
    if (FINISHED_WORK.has(task.state)) {
      throw new DomainError('invalid_transition', `task ${task.id} is ${task.state}`);
    }
    const fromBodyId = req.fromBodyId ?? task.bodyId;
    const project = req.toProjectId
      ? must(tables.projects.get(req.toProjectId), 'project', req.toProjectId)
      : this.projectFor(p);
    const waykeeperId = await this.ensureWaykeeper(project, req);
    const handOver = { isLiving: this.isLive() };
    const now = must(tables.tasks.get(task.id), 'task', task.id);
    if (now.projectId !== project.id) {
      if (now.projectId) log.runCommand((ctx) => transferTask(ctx, now.id, project.id, handOver));
      else await commands.moveTask(now.id, project.id, promotionActor(p.id));
    }
    // The Stewards that were handed over and resume: the live ones (an ended row moved too).
    const live = this.isLive();
    const stewardIds = tables.agents
      .all()
      .filter((a) => a.role === 'steward' && a.taskId === task.id && live(a.id))
      .map((a) => a.id);
    return {
      ok: true,
      target: req.target,
      fromBodyId,
      toBodyId: must(tables.projects.get(project.id), 'project', project.id).bodyId,
      projectId: project.id,
      waykeeperId,
      ...(stewardIds.length > 0 ? { stewardIds } : {}),
    };
  }

  /**
   * The card's new project: one an earlier attempt (or, after the P2-09 merge, the approval
   * transaction) created for it, else created now on the body `room` gives.
   */
  private projectFor(p: Proposal): Project {
    const { log } = this.opts;
    const existing = log.tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id);
    if (existing) return existing;
    const body = this.room(p);
    return log.runCommand((ctx) => createPromotedProject(ctx, p, body)).value;
  }

  /** The body a card needing one gets now, or a refusal naming what is occupied. */
  private room(p: Proposal) {
    const { log } = this.opts;
    // The approval took the body; this is for a card approved before it did (an older server).
    const choice = this.opts.roomFor ? this.opts.roomFor(p) : promotionRoom(log, p, log.choose);
    if (!choice) throw new DomainError('invalid', `proposal ${p.id} needs no new body`);
    if (!choice.ok) throw new DomainError('conflict', describeRefusal(choice));
    return choice.body;
  }

  /** The project's running Waykeeper, if one runs. */
  private runningWaykeeper(projectId: Id): Id | undefined {
    const live = this.isLive();
    return this.opts.log.tables.agents
      .all()
      .find((a) => a.role === 'waykeeper' && a.projectId === projectId && live(a.id))?.id;
  }

  /**
   * The project's running Waykeeper, else a new one under the Harmonizer — or, for a sub-project,
   * under the parent project's running Waykeeper (the one that asked, preferably). No supervisor
   * running yet, or a spawn refused (a cap, another spawn of this Waykeeper under way): the card
   * waits (`RetryLater`); one started meanwhile by someone else (the Harmonizer's
   * `spawn_waykeeper`) is adopted.
   */
  private async ensureWaykeeper(project: Project, req: PromotionRequest): Promise<Id> {
    const live = this.isLive();
    const agents = this.opts.log.tables.agents.all();
    const running = this.runningWaykeeper(project.id);
    if (running) return running;
    const supervisors = agents
      .filter((a) =>
        project.parentProjectId
          ? a.role === 'waykeeper' && a.projectId === project.parentProjectId
          : a.role === 'harmonizer',
      )
      .filter((a) => live(a.id))
      .sort((a, b) => Number(b.id === req.requestedBy) - Number(a.id === req.requestedBy));
    const supervisor = supervisors[0];
    if (!supervisor) {
      throw new RetryLater(
        project.parentProjectId
          ? `project ${project.parentProjectId} has no running Waykeeper to supervise ${project.id}'s`
          : `no running Harmonizer to supervise the Waykeeper of ${project.id}`,
      );
    }
    try {
      const { agentId } = await this.opts.startWaykeeper({
        projectId: project.id,
        supervisorId: supervisor.id,
        runtime: supervisor.runtime,
      });
      return agentId;
    } catch (error) {
      const adopted = this.runningWaykeeper(project.id);
      if (adopted) return adopted;
      throw new RetryLater(
        `the Waykeeper of ${project.id} could not start yet: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * After a final failure: the new project this card made, if it holds nothing (no task, no live
   * agent), is failed and its body freed — a failed promotion keeps no body.
   */
  private undo(p: Proposal, req: PromotionRequest): void {
    if (req.target.kind !== 'task' || req.toProjectId) return;
    const { log } = this.opts;
    const project = log.tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id);
    if (!project || project.state === 'failed' || project.state === 'archived') return;
    if (log.tables.tasks.all().some((t) => t.projectId === project.id)) return;
    const live = this.isLive();
    if (log.tables.agents.all().some((a) => a.projectId === project.id && live(a.id))) return;
    try {
      log.runCommand((ctx) => {
        setProjectState(ctx, project.id, 'failed', promotionActor(p.id));
        const body = ctx.tables.bodies.get(project.bodyId);
        if (body?.host?.kind === 'project' && body.host.id === project.id) release(ctx, body);
      });
    } catch (error) {
      this.opts.onError?.(error, `promotion ${p.id}: undo`);
    }
  }

  // -- a project moves to a bigger body --------------------------------------------------------

  private promoteProject(p: Proposal, req: PromotionRequest): PromotionOutcome {
    const { log } = this.opts;
    const project = must(log.tables.projects.get(req.target.id), 'project', req.target.id);
    const fromBodyId = req.fromBodyId ?? project.bodyId;
    if (p.kind === 'asteroid') {
      throw new DomainError('invalid', 'a project lives on a planet or a moon');
    }
    let toBodyId = project.bodyId;
    // Moved already (an earlier attempt that was not recorded): nothing left to move.
    if (project.bodyId === fromBodyId) {
      toBodyId = this.room(p).id;
      log.runCommand((ctx) => moveProject(ctx, project.id, toBodyId, { isLiving: this.isLive() }));
    }
    const live = this.isLive();
    const waykeeper = log.tables.agents
      .all()
      .find((a) => a.role === 'waykeeper' && a.projectId === project.id && live(a.id));
    return {
      ok: true,
      target: req.target,
      fromBodyId,
      toBodyId,
      projectId: project.id,
      ...(waykeeper ? { waykeeperId: waykeeper.id } : {}),
    };
  }

  // -- pausing while the user decides ----------------------------------------------------------

  /**
   * The target task's live Stewards, paused by this card (SPEC §3.4: "the Steward is paused").
   * `again` (a restart: the runtime's pause did not survive it): only the Stewards this card had
   * paused and nobody resumed since.
   */
  private async pauseStewards(p: Proposal, req: PromotionRequest, again = false): Promise<void> {
    if (req.target.kind !== 'task' || carriedOut(p)) return;
    const by = promotionActor(p.id);
    const mine = again ? this.pausedBy(by) : undefined;
    for (const agent of this.opts.liveAgents()) {
      if (agent.role !== 'steward' || agent.taskId !== req.target.id) continue;
      if (mine && !mine.has(agent.id)) continue;
      // Already paused (by the user, say): the runtime records nothing and this card leaves it.
      await this.opts.commands.pauseAgent(agent.id, by).catch(() => undefined);
    }
  }

  /** The Stewards this card paused and nobody resumed since: resumed by the card. */
  private async resumeStewards(p: Proposal, req: PromotionRequest): Promise<void> {
    if (req.target.kind !== 'task') return;
    const by = promotionActor(p.id);
    const live = this.isLive();
    for (const agentId of this.pausedBy(by)) {
      if (!live(agentId)) continue;
      await this.opts.commands.resumeAgent(agentId, by).catch((error: unknown) => {
        this.opts.onError?.(error, `promotion ${p.id}: resume ${agentId}`);
      });
    }
  }

  /** Agents whose last pause or resume (`control.*`) was a pause by `by`. */
  private pausedBy(by: Actor): Set<Id> {
    const last = new Map<Id, Actor | undefined>();
    for (const { event } of this.opts.log.eventsSince(0, Number.MAX_SAFE_INTEGER)) {
      if (event.type !== 'control.pause' && event.type !== 'control.resume') continue;
      if (event.target.kind !== 'agent') continue;
      last.set(event.target.id, event.type === 'control.pause' ? event.by : undefined);
    }
    const out = new Set<Id>();
    for (const [agentId, pausedBy] of last) {
      if (pausedBy?.type === by.type && pausedBy.id === by.id) out.add(agentId);
    }
    return out;
  }

  private isLive(): (id: Id) => boolean {
    const ids = new Set(this.opts.liveAgents().map((a) => a.id));
    return (id) => ids.has(id);
  }
}
