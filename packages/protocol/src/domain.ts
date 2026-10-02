import { z } from 'zod';
import { Id, Meta, Timestamp } from './primitives.js';
import {
  ActorType,
  AgentRole,
  AgentRuntime,
  AgentState,
  BodyKind,
  HostKind,
  PermissionAction,
  PermissionDecision,
  ProposalState,
  QuestionKind,
  QuestionStatus,
  TaskPriority,
  WorkBodyKind,
  WorkState,
} from './enums.js';

/** A reference to whatever a body hosts. */
export const Host = z.object({ kind: HostKind, id: Id });
export type Host = z.infer<typeof Host>;

/** An agent, the user, or the system itself. `id` is absent for user and system. */
export const Actor = z.object({ type: ActorType, id: Id.optional() });
export type Actor = z.infer<typeof Actor>;

/** Hard caps enforced by the process supervisor (SPEC decision 18, TECHNOLOGY §5.4). */
export const AgentCaps = z.object({
  maxWallClockMs: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
});
export type AgentCaps = z.infer<typeof AgentCaps>;

/**
 * The "moved to …" marker a body keeps after its occupant moved away (SPEC §3.4, decision 15):
 * where it went and when. The body is not free while it shows the marker; the retention sweep
 * frees it (`body.freed`) once the retention period of decision 4 has passed.
 */
export const BodyMarker = z.object({
  /** The body the work moved to. */
  bodyId: Id,
  /** What moved: the project or task that lived here. */
  host: Host,
  at: Timestamp,
});
export type BodyMarker = z.infer<typeof BodyMarker>;

export const Body = z.object({
  id: Id,
  kind: BodyKind,
  /** Moons point at their planet. The Sun, planets and asteroids have no parent. */
  parentId: Id.optional(),
  name: z.string().min(1),
  host: Host.optional(),
  /** Set by `body.moved` on the body the work left; cleared by `body.freed`. */
  movedTo: BodyMarker.optional(),
  /**
   * Catalogue data (P2-02): `reserved: true` (the Sun, Earth, Earth's Moon), `orbit` (a planet's
   * position from the Sun, a moon's around its planet), and for procedural asteroids `number`,
   * `seed` and their generated orbit.
   */
  meta: Meta.optional(),
});
export type Body = z.infer<typeof Body>;

/**
 * Who holds a body that is not free (P2-02): the planets listed by the "no free planet" refusal
 * (decision 16), which offers downsizing or closing a completed project early. `host` is absent
 * for a body that only shows a "moved to …" marker.
 */
export const BodyOccupancy = z.object({
  bodyId: Id,
  bodyName: z.string(),
  host: Host.optional(),
  /** The occupant's name: the project's name or the task's description. */
  occupant: z.string().optional(),
  state: WorkState.optional(),
  movedTo: BodyMarker.optional(),
});
export type BodyOccupancy = z.infer<typeof BodyOccupancy>;

/** Per-project permission policy (SPEC §3.6, decision 7). Missing actions fall back to the default policy. */
export const PermissionPolicy = z.object({
  rules: z.partialRecord(PermissionAction, PermissionDecision),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  /** Directory where the project's work happens (SPEC §3.5). */
  workspace: z.string().min(1),
  repoPath: z.string().optional(),
  /** Set for sub-projects living on a moon of the parent's planet (decision 10). */
  parentProjectId: Id.optional(),
  bodyId: Id,
  state: WorkState,
  /** The project's policy table (TECHNOLOGY §6.2); absent = the global default. */
  permissionPolicy: PermissionPolicy.optional(),
  /** Pinned work is never archived by the retention timer (decision 4, 11b). */
  pinned: z.boolean().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Project = z.infer<typeof Project>;

export const Task = z.object({
  id: Id,
  /** Absent for standalone (asteroid) tasks. */
  projectId: Id.optional(),
  bodyId: Id,
  description: z.string().min(1),
  priority: TaskPriority,
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  blockedBy: z.array(Id),
  state: WorkState,
  pinned: z.boolean().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Task = z.infer<typeof Task>;

export const Agent = z.object({
  id: Id,
  role: AgentRole,
  runtime: AgentRuntime,
  /** Runtime-specific session handle used to resume after a restart; absent until the adapter reports it. */
  sessionRef: z.string().optional(),
  /** Absent only for the Harmonizer. */
  supervisorId: Id.optional(),
  bodyId: Id,
  /** The task a Steward works on. */
  taskId: Id.optional(),
  /** The project a Waykeeper runs. */
  projectId: Id.optional(),
  caps: AgentCaps,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Agent = z.infer<typeof Agent>;

/** The body the Harmonizer proposes for a work request (SPEC §3.3). */
export const ProposedBody = z.object({
  kind: WorkBodyKind,
  /** Planet for a proposed moon. */
  parentId: Id.optional(),
  /** An existing free body, when the Harmonizer picked one. */
  bodyId: Id.optional(),
  name: z.string().min(1),
});
export type ProposedBody = z.infer<typeof ProposedBody>;

export const Proposal = z.object({
  id: Id,
  requestText: z.string().min(1),
  /** The proposed size. */
  kind: WorkBodyKind,
  proposedBody: ProposedBody,
  workspace: z.string().min(1),
  rationale: z.string(),
  state: ProposalState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Proposal = z.infer<typeof Proposal>;

/**
 * A Waykeeper's task plan card (P2-10; SPEC §3.3, decision 3), kept in `Proposal.meta.plan`: the
 * plan's tasks exist as `proposed` tasks of the project and are approved (or left as a draft) as
 * one. `kind`, `proposedBody` and `workspace` of the proposal repeat the project's, so a client
 * that does not know plans still shows a sensible card.
 */
export const ProposalPlan = z.object({
  projectId: Id,
  /** The Waykeeper that planned; its successor on the same project owns the card too. */
  waykeeperId: Id,
  /** The plan's tasks, in plan order. */
  taskIds: z.array(Id).min(1),
});
export type ProposalPlan = z.infer<typeof ProposalPlan>;

/** The plan a proposal carries, when it is a Waykeeper's plan card. */
export function proposalPlan(
  proposal: Pick<Proposal, 'meta'> | undefined,
): ProposalPlan | undefined {
  const parsed = ProposalPlan.safeParse(proposal?.meta?.['plan']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What a parked card shows and offers (P2-09; SPEC §3.3, decisions 1 and 16), kept in
 * `Proposal.meta.parked` while the proposal is `parked`. A card the server parked for lack of
 * room carries `waitingFor` (the body kind it needs) and un-parks by itself when one frees; one
 * the user parked by hand has only the `reason` and stays parked until it is decided again.
 */
export const ParkOffer = z.enum([
  /** Make it a moon project instead (an independent moon, decision 10). */
  'downsize_moon',
  /** Make it standalone work on asteroids. */
  'downsize_asteroid',
  /** Close (and archive) a completed project early to free its body. */
  'close_early',
  /** A sub-project without a free moon stays a task on its planet (SPEC §3.2). */
  'task_on_planet',
]);
export type ParkOffer = z.infer<typeof ParkOffer>;

export const ProposalParking = z.object({
  reason: z.string(),
  /** Set when the server parked the card because no body of this kind was free. */
  waitingFor: z.enum(['planet', 'moon']).optional(),
  /** The occupied bodies and their occupants, as the refusal lists them. */
  occupied: z.array(BodyOccupancy).optional(),
  offers: z.array(ParkOffer).optional(),
});
export type ProposalParking = z.infer<typeof ProposalParking>;

/** The parking a proposal shows, when it is parked with one. */
export function proposalParking(
  proposal: Pick<Proposal, 'meta'> | undefined,
): ProposalParking | undefined {
  const parsed = ProposalParking.safeParse(proposal?.meta?.['parked']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A proposal's `meta` after a decision (P2-09), one implementation for the server and every
 * client so the two folds cannot drift: `parked` is set while the card is parked and dropped by
 * any other decision (`null`); `initGit` records the user's consent to turn an existing non-git
 * workspace into a repository (decision 27). An emptied `meta` is `undefined`.
 */
export function foldProposalMeta(
  meta: Meta | undefined,
  changes: { parked?: ProposalParking | null; initGit?: boolean },
): Meta | undefined {
  const next: Record<string, unknown> = { ...(meta ?? {}) };
  if (changes.parked === null) delete next['parked'];
  else if (changes.parked !== undefined) next['parked'] = changes.parked;
  if (changes.initGit === true) next['initGit'] = true;
  else if (changes.initGit === false) delete next['initGit'];
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A tool call an agent wants to make, as the permission gate and the permission card see it. */
export const ToolCall = z.object({ toolName: z.string(), input: z.unknown().optional() });
export type ToolCall = z.infer<typeof ToolCall>;

/** One of the origin agent's last logged events, as a question card shows it (P2-03). */
export const QuestionRecentEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  type: z.string(),
  /** A one-line reading: the tool name, the progress summary, the message text (capped). */
  summary: z.string().optional(),
});
export type QuestionRecentEvent = z.infer<typeof QuestionRecentEvent>;

/**
 * Where a question comes from (P2-03; IMPLEMENTATION_PLAN corner case 11), filled by the server
 * when it opens the question: the origin agent's role, task, project and body, and its last few
 * logged events, so the card makes sense without opening the agent.
 */
export const QuestionOrigin = z.object({
  role: AgentRole,
  taskId: Id.optional(),
  projectId: Id.optional(),
  bodyId: Id.optional(),
  recent: z.array(QuestionRecentEvent),
});
export type QuestionOrigin = z.infer<typeof QuestionOrigin>;

/** What a question is about: the text the agent asked plus optional choices or the tool call awaiting permission. */
export const QuestionContext = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  toolCall: ToolCall.optional(),
  permissionAction: PermissionAction.optional(),
  /** Set by the server on `question.opened`; adapters leave it out. */
  origin: QuestionOrigin.optional(),
});
export type QuestionContext = z.infer<typeof QuestionContext>;

export const Question = z.object({
  id: Id,
  kind: QuestionKind,
  originAgentId: Id,
  /** Who must answer now. Routing follows Agent.supervisorId; permission questions always hold `user`. */
  holder: Actor,
  status: QuestionStatus,
  context: QuestionContext,
  answeredBy: Actor.optional(),
  answer: z.string().optional(),
  /** Bumped on every holder change or answer; offline answers carry it so a stale answer can be refused. */
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Question = z.infer<typeof Question>;

export const Cost = z.object({
  usd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type Cost = z.infer<typeof Cost>;

export const Progress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({ label: z.string(), done: z.boolean() })).optional(),
});
export type Progress = z.infer<typeof Progress>;

const CapUsage = z.object({ used: z.number().nonnegative(), limit: z.number().positive() });

/** Per-agent status record: a projection of the event log, never the source of truth (TECHNOLOGY §4). */
export const StatusRecord = z.object({
  agentId: Id,
  state: AgentState,
  currentActivity: z.string().optional(),
  /** When the current session started (`agent.spawned`); clients derive the running wall clock from it. */
  startedAt: Timestamp,
  lastEventAt: Timestamp,
  pendingQuestionId: Id.optional(),
  progress: Progress.optional(),
  costSoFar: Cost.optional(),
  /** `wallClockMs.used` is as of `lastEventAt` for a live agent; the client extrapolates from `startedAt`. */
  caps: z.object({ wallClockMs: CapUsage, toolCalls: CapUsage }),
});
export type StatusRecord = z.infer<typeof StatusRecord>;

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  rules: {
    read_workspace: 'allow',
    edit_workspace: 'allow',
    run_workspace: 'allow',
    destructive: 'ask',
    outside_workspace: 'ask',
    network: 'ask',
    push: 'ask',
  },
};

/** One batch-written piece of an agent's transcript (TECHNOLOGY §6.2), redacted before it is stored. */
export const TranscriptChunk = z.object({
  agentId: Id,
  /** Per-agent, strictly increasing; the transcript stream is resumed from it. */
  seq: z.number().int().positive(),
  at: Timestamp,
  kind: z.enum(['text', 'tool', 'thinking']),
  text: z.string(),
});
export type TranscriptChunk = z.infer<typeof TranscriptChunk>;

/**
 * Named policy presets the panel offers (SPEC §3.6): `default` is the table in the SPEC;
 * `trusting` lets a Steward install and talk to the network on its own but still asks before
 * destroying or pushing; `cautious` asks for every change.
 */
export const PERMISSION_POLICY_PRESETS: Record<
  'default' | 'trusting' | 'cautious',
  PermissionPolicy
> = {
  default: DEFAULT_PERMISSION_POLICY,
  trusting: {
    rules: {
      read_workspace: 'allow',
      edit_workspace: 'allow',
      run_workspace: 'allow',
      destructive: 'ask',
      outside_workspace: 'ask',
      network: 'allow',
      push: 'ask',
    },
  },
  cautious: {
    rules: {
      read_workspace: 'allow',
      edit_workspace: 'ask',
      run_workspace: 'ask',
      destructive: 'ask',
      outside_workspace: 'ask',
      network: 'ask',
      push: 'deny',
    },
  },
};
export type PermissionPolicyPreset = keyof typeof PERMISSION_POLICY_PRESETS;
