import {
  proposalPromotion,
  type Actor,
  type Agent,
  type AgentRuntime,
  type EventEnvelope,
  type Id,
  type Project,
  type PromotionOutcome,
  type PromotionRequest,
  type Proposal,
} from '@galactic/protocol';
import type { Commands } from '../domain/commands.js';
import { describeRefusal } from '../domain/catalogue.js';
import { DomainError, must } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import {
  carriedOut,
  moveProject,
  recordPromotion,
  transferTask,
  usableBody,
} from '../domain/promotion.js';

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
 *   record), and `start()` carries out approved cards a previous server life left unrecorded.
 *   A step that fails records `ok: false` with the reason and resumes the paused Stewards; what
 *   was done before the failure stays (a new project without its task, say) and the owner is told.
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
  onError?: (error: unknown, context: string) => void;
}

/** The actor a card pauses and resumes its Stewards as. */
export const promotionActor = (proposalId: Id): Actor => ({
  type: 'system',
  id: `promotion:${proposalId}`,
});

export class PromotionFlow {
  private readonly running = new Map<Id, Promise<PromotionOutcome | undefined>>();
  private readonly work = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: PromotionFlowOptions) {}

  /** Subscribes to card decisions and carries out approved cards left unrecorded. */
  start(): this {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.opts.log.subscribe((e) => this.onEvent(e));
    for (const p of this.opts.log.tables.proposals.all()) {
      if (p.state === 'approved' && proposalPromotion(p) && !carriedOut(p)) {
        this.track(this.carryOut(p.id));
      }
    }
    return this;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Resolves when every step started so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private onEvent({ event }: EventEnvelope): void {
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
          ? await this.promoteProject(proposal, request)
          : await this.promoteTask(proposal, request);
    } catch (error) {
      outcome = {
        ok: false,
        target: request.target,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
    const fromBodyId = req.fromBodyId ?? task.bodyId;
    const project = req.toProjectId
      ? must(tables.projects.get(req.toProjectId), 'project', req.toProjectId)
      : await this.projectFor(p, req);
    const waykeeperId = await this.ensureWaykeeper(project, req);
    const handOver = { isLiving: this.isLive() };
    const now = must(tables.tasks.get(task.id), 'task', task.id);
    if (now.projectId !== project.id) {
      if (now.projectId) log.runCommand((ctx) => transferTask(ctx, now.id, project.id, handOver));
      else await commands.moveTask(now.id, project.id, promotionActor(p.id));
    }
    const stewardIds = tables.agents
      .all()
      .filter((a) => a.role === 'steward' && a.taskId === task.id)
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

  /** The card's new project: created once (found again by `meta.proposalId` on a retry). */
  private async projectFor(p: Proposal, req: PromotionRequest): Promise<Project> {
    const { log, commands } = this.opts;
    const tables = log.tables;
    const existing = tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id);
    if (existing) return existing;
    if (p.kind === 'asteroid') {
      throw new DomainError(
        'invalid',
        `proposal ${p.id} was resized to an asteroid: nothing grows`,
      );
    }
    const task = must(tables.tasks.get(req.target.id), 'task', req.target.id);
    const from = req.fromProjectId ? tables.projects.get(req.fromProjectId) : undefined;
    // A Waykeeper's moon is a sub-project of its project (SPEC §3.2) — unless the user put it on
    // a moon of another planet on the card, which makes it a project of its own.
    const named = p.proposedBody.bodyId ? tables.bodies.get(p.proposedBody.bodyId) : undefined;
    const sub =
      from !== undefined && p.kind === 'moon' && (!named || named.parentId === from.bodyId);
    const body = usableBody(log, p.proposedBody.bodyId, p.kind);
    const { value } = await commands.createProject({
      name: req.name ?? nameOf(task.description),
      workspace: p.workspace,
      kind: p.kind,
      ...(body ? { bodyId: body.id } : {}),
      ...(sub ? { parentProjectId: from.id } : {}),
      meta: {
        proposalId: p.id,
        // The permanent link in history (decision 15), besides the `body.moved` event.
        promotedFrom: {
          kind: 'task',
          taskId: task.id,
          bodyId: req.fromBodyId ?? task.bodyId,
          ...(task.projectId ? { projectId: task.projectId } : {}),
        },
      },
    });
    return value;
  }

  /**
   * The project's running Waykeeper, else a new one under the Harmonizer — or, for a sub-project,
   * under the parent project's running Waykeeper (the one that asked, preferably).
   */
  private async ensureWaykeeper(project: Project, req: PromotionRequest): Promise<Id> {
    const live = this.isLive();
    const agents = this.opts.log.tables.agents.all();
    const running = agents.find(
      (a) => a.role === 'waykeeper' && a.projectId === project.id && live(a.id),
    );
    if (running) return running.id;
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
      throw new DomainError(
        'conflict',
        project.parentProjectId
          ? `project ${project.parentProjectId} has no running Waykeeper to supervise ${project.id}'s`
          : `no running Harmonizer to supervise the Waykeeper of ${project.id}`,
      );
    }
    const { agentId } = await this.opts.startWaykeeper({
      projectId: project.id,
      supervisorId: supervisor.id,
      runtime: supervisor.runtime,
    });
    return agentId;
  }

  // -- a project moves to a bigger body --------------------------------------------------------

  private async promoteProject(p: Proposal, req: PromotionRequest): Promise<PromotionOutcome> {
    const { log, commands } = this.opts;
    const project = must(log.tables.projects.get(req.target.id), 'project', req.target.id);
    const fromBodyId = req.fromBodyId ?? project.bodyId;
    if (p.kind === 'asteroid') {
      throw new DomainError('invalid', 'a project lives on a planet or a moon');
    }
    let toBodyId = project.bodyId;
    if (project.bodyId === fromBodyId) {
      const named = usableBody(log, p.proposedBody.bodyId, p.kind);
      if (named) toBodyId = named.id;
      else {
        const choice = await commands.chooseBody({ kind: p.kind });
        if (!choice.ok) throw new DomainError('conflict', describeRefusal(choice));
        toBodyId = choice.body.id;
      }
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

  /** The target task's live Stewards, paused by this card (SPEC §3.4: "the Steward is paused"). */
  private async pauseStewards(p: Proposal, req: PromotionRequest): Promise<void> {
    if (req.target.kind !== 'task' || carriedOut(p)) return;
    const by = promotionActor(p.id);
    for (const agent of this.opts.liveAgents()) {
      if (agent.role !== 'steward' || agent.taskId !== req.target.id) continue;
      // Already paused (by the user, say): the runtime records nothing and this card leaves it.
      await this.opts.commands.pauseAgent(agent.id, by).catch(() => undefined);
    }
  }

  /** The Stewards this card paused and nobody resumed since: resumed by the card. */
  private async resumeStewards(p: Proposal, req: PromotionRequest): Promise<void> {
    if (req.target.kind !== 'task') return;
    const by = promotionActor(p.id);
    const live = this.isLive();
    const last = new Map<Id, Actor | undefined>();
    for (const { event } of this.opts.log.eventsSince(0, Number.MAX_SAFE_INTEGER)) {
      if (event.type !== 'control.pause' && event.type !== 'control.resume') continue;
      if (event.target.kind !== 'agent') continue;
      last.set(event.target.id, event.type === 'control.pause' ? event.by : undefined);
    }
    for (const [agentId, pausedBy] of last) {
      if (pausedBy?.type !== by.type || pausedBy.id !== by.id || !live(agentId)) continue;
      await this.opts.commands.resumeAgent(agentId, by).catch((error: unknown) => {
        this.opts.onError?.(error, `promotion ${p.id}: resume ${agentId}`);
      });
    }
  }

  private isLive(): (id: Id) => boolean {
    const ids = new Set(this.opts.liveAgents().map((a) => a.id));
    return (id) => ids.has(id);
  }
}

/** A project name from a task description: its first line, at most 60 characters. */
function nameOf(description: string): string {
  const line = description.split('\n')[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Promoted task';
}
