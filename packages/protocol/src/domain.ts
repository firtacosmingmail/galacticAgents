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
 * A retired body (P7-07): a body made outside the catalogue (a `/dev/seed` demo planet) whose
 * work was archived. It never hosts anything again: the server keeps its row with
 * `meta.retired: true` only so archived work still names it (`projects.body_id`, the history),
 * leaves it out of every snapshot, and the client drops it on `body.retired`.
 */
export const isRetiredBody = (body: Body): boolean => body.meta?.['retired'] === true;

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

/**
 * Per-project permission policy (SPEC §3.6, decision 7). Missing actions fall back to the default
 * policy. `unclassified` decides a call the engine cannot classify — an opaque command, an unknown
 * tool (decision 49); absent means `ask`, and so does any value the engine does not know.
 */
export const PermissionPolicy = z.object({
  rules: z.partialRecord(PermissionAction, PermissionDecision),
  unclassified: PermissionDecision.optional(),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

/**
 * A dollar budget (P8-01; SPEC decision 18): a positive amount of US dollars, compared with the
 * cost the runtimes report (an estimate; notional under a subscription login, P1-08).
 */
export const BudgetUsd = z.number().positive().finite().max(1_000_000);
export type BudgetUsd = z.infer<typeof BudgetUsd>;

/** What a budget belongs to (P8-01): a project or a task. */
export const BudgetTarget = z.object({ kind: z.enum(['project', 'task']), id: Id });
export type BudgetTarget = z.infer<typeof BudgetTarget>;

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
  /**
   * The project's dollar budget (P8-01): its agents', its tasks' and its sub-projects' reported
   * cost together. Absent: no budget. Set through `setBudget` (logged as `budget.set`).
   */
  budgetUsd: BudgetUsd.optional(),
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
  /** The task's dollar budget (P8-01): its Stewards' reported cost together. Absent: none. */
  budgetUsd: BudgetUsd.optional(),
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
  changes: ProposalMetaChanges,
): Meta | undefined {
  const next: Record<string, unknown> = { ...(meta ?? {}) };
  if (changes.parked === null) delete next['parked'];
  else if (changes.parked !== undefined) next['parked'] = changes.parked;
  if (changes.initGit === true) next['initGit'] = true;
  else if (changes.initGit === false) delete next['initGit'];
  if (changes.trust === 'default') delete next['trust'];
  else if (changes.trust !== undefined) next['trust'] = changes.trust;
  if (changes.budgetUsd === null) delete next['budgetUsd'];
  else if (changes.budgetUsd !== undefined) next['budgetUsd'] = changes.budgetUsd;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** What a decision changes in a proposal's `meta` (`foldProposalMeta`). */
export interface ProposalMetaChanges {
  parked?: ProposalParking | null;
  initGit?: boolean;
  /** The trust level the user chose on the card (decision 49): `default` drops `meta.trust`. */
  trust?: TrustLevel;
  /**
   * The budget the user gave the work on the card (P8-01): `meta.budgetUsd`, applied to the
   * project or task the approval creates (a plan card: to its project). `null` drops it.
   */
  budgetUsd?: number | null;
}

/** The budget the user gave a card (P8-01): `meta.budgetUsd`, when it is a valid amount. */
export function proposalBudget(proposal: Pick<Proposal, 'meta'> | undefined): number | undefined {
  const parsed = BudgetUsd.safeParse(proposal?.meta?.['budgetUsd']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The trust level the user chose on a work card (decision 49): `meta.trust`, read fail-closed —
 * anything that is not a known level is `default`.
 */
export function proposalTrust(proposal: Pick<Proposal, 'meta'> | undefined): TrustLevel {
  const parsed = TrustLevel.safeParse(proposal?.meta?.['trust']);
  return parsed.success ? parsed.data : 'default';
}

/**
 * What a promotion card moves (P2-12; SPEC §3.4, decision 2), read from either card shape: the
 * Harmonizer's `meta.request = {type: 'promotion', target, toProjectId?}` (P2-08) or a Waykeeper's
 * `meta.promotion = {taskId, fromProjectId, requestedBy}` (P2-10). `toProjectId`: a standalone
 * task joins that existing project; otherwise the target grows to the card's `kind` (a task
 * becomes a project of its own, a project moves to a bigger body). `fromProjectId` /
 * `requestedBy`: a Waykeeper asked for its project's task.
 */
export const PromotionRequest = z.object({
  target: Host,
  toProjectId: Id.optional(),
  fromProjectId: Id.optional(),
  requestedBy: Id.optional(),
  /** The name on the card, for a new project. */
  name: z.string().optional(),
  /** The body the work was on when the card was made (the Harmonizer's cards). */
  fromBodyId: Id.optional(),
});
export type PromotionRequest = z.infer<typeof PromotionRequest>;

/** The promotion a proposal asks for, when it is a promotion card (either shape). */
export function proposalPromotion(
  proposal: Pick<Proposal, 'meta'> | undefined,
): PromotionRequest | undefined {
  const meta = proposal?.meta;
  const request = meta?.['request'] as Record<string, unknown> | undefined;
  if (request?.['type'] === 'promotion') {
    const parsed = PromotionRequest.safeParse({
      target: request['target'],
      toProjectId: request['toProjectId'],
      name: request['name'],
      fromBodyId: request['fromBodyId'],
    });
    if (parsed.success) return parsed.data;
  }
  const promotion = meta?.['promotion'] as Record<string, unknown> | undefined;
  if (promotion && typeof promotion['taskId'] === 'string') {
    const parsed = PromotionRequest.safeParse({
      target: { kind: 'task', id: promotion['taskId'] },
      fromProjectId: promotion['fromProjectId'],
      requestedBy: promotion['requestedBy'],
    });
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * How an approved promotion was carried out (P2-12), kept on the card as `meta.carriedOut` and
 * announced by `promotion.carried_out`: the work's old and new body, the project it belongs to
 * now, the Waykeeper that runs it and the Stewards handed over — or why it could not be done.
 */
export const PromotionOutcome = z.object({
  ok: z.boolean(),
  target: Host,
  fromBodyId: Id.optional(),
  toBodyId: Id.optional(),
  projectId: Id.optional(),
  waykeeperId: Id.optional(),
  stewardIds: z.array(Id).optional(),
  error: z.string().optional(),
});
export type PromotionOutcome = z.infer<typeof PromotionOutcome>;

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
/**
 * The wall clock. `limit` is always present (the agent's configured cap), so the previous build's
 * parser still reads the record (TECHNOLOGY §6.3, protocol evolution); `capped: false` marks an
 * agent the wall-clock cap does not apply to (a brain, SPEC decision 103) — the meter is hidden and
 * the agent is never "near its cap". Absent means capped. Read it through `wallClockLimit()`.
 */
const WallClockUsage = z.object({
  used: z.number().nonnegative(),
  limit: z.number().positive(),
  capped: z.boolean().optional(),
});

/** The wall-clock limit that applies to the agent, or `undefined` when it is not capped (decision 103). */
export function wallClockLimit(usage: {
  limit: number;
  capped?: boolean | undefined;
}): number | undefined {
  return usage.capped === false ? undefined : usage.limit;
}

/**
 * Whether the per-agent wall-clock cap applies to an agent (SPEC decision 103, P8-10): it does to
 * Stewards and to free-form agents (the ops console's, `meta.freeForm`, whatever role they were
 * given); it does not to the Harmonizer and the Waykeepers, which are idle most of their life and
 * bounded by the hierarchy and their tool-call cap instead. An agent of unknown role is capped.
 */
export function wallClockCapApplies(agent: {
  role?: AgentRole | undefined;
  meta?: Meta | undefined;
}): boolean {
  if (agent.role !== 'harmonizer' && agent.role !== 'waykeeper') return true;
  return agent.meta?.freeForm === true;
}

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
  caps: z.object({ wallClockMs: WallClockUsage, toolCalls: CapUsage }),
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
  /**
   * `terminal` (P8-08): a PTY agent's raw terminal bytes (ANSI escapes kept) for the terminal
   * view only; its `text` chunks carry the same output stripped, for the conversation and history.
   */
  kind: z.enum(['text', 'tool', 'thinking', 'terminal']),
  text: z.string(),
});
export type TranscriptChunk = z.infer<typeof TranscriptChunk>;

/**
 * The terminal size every PTY agent runs in (P8-08): the terminal view in the panel draws its
 * `terminal` chunks at exactly this size, so cursor movement lands where the CLI meant it.
 */
export const PTY_TERMINAL_SIZE = { cols: 120, rows: 32 } as const;

/**
 * A project's trust level (decision 49): the name of the policy preset the user chose for it on
 * the proposal card or the project's edit form.
 */
export const TrustLevel = z.enum(['default', 'trusting', 'cautious', 'trusted']);
export type TrustLevel = z.infer<typeof TrustLevel>;

/**
 * Named policy presets the panel offers (SPEC §3.6): `default` is the table in the SPEC;
 * `trusting` lets a Steward install and talk to the network on its own but still asks before
 * destroying or pushing; `cautious` asks for every change; `trusted` (decision 49) allows
 * everything — calls the engine cannot classify included — except a push, which asks.
 */
export const PERMISSION_POLICY_PRESETS: Record<TrustLevel, PermissionPolicy> = {
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
  trusted: {
    rules: {
      read_workspace: 'allow',
      edit_workspace: 'allow',
      run_workspace: 'allow',
      destructive: 'allow',
      outside_workspace: 'allow',
      network: 'allow',
      push: 'ask',
    },
    unclassified: 'allow',
  },
};
export type PermissionPolicyPreset = keyof typeof PERMISSION_POLICY_PRESETS;

/**
 * The trust level a project's policy amounts to (decision 49): the preset whose table it equals
 * once merged over the global default (no policy is `default`), or `custom`.
 */
export function trustLevelOf(policy: PermissionPolicy | undefined | null): TrustLevel | 'custom' {
  const merged = (p: PermissionPolicy | undefined | null) => ({
    rules: { ...DEFAULT_PERMISSION_POLICY.rules, ...(p?.rules ?? {}) },
    unclassified: p?.unclassified ?? 'ask',
  });
  const own = merged(policy);
  for (const level of TrustLevel.options) {
    const preset = merged(PERMISSION_POLICY_PRESETS[level]);
    if (
      own.unclassified === preset.unclassified &&
      PermissionAction.options.every((a) => own.rules[a] === preset.rules[a])
    ) {
      return level;
    }
  }
  return 'custom';
}
