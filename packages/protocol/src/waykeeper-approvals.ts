import { z } from 'zod';
import { Actor } from './actor.js';
import { PermissionAction, RequestOrigin } from './enums.js';
import { Id, Timestamp } from './primitives.js';

/**
 * Waykeeper approvals (P13; design 2026-11-09-waykeeper-approvals, SPEC decision 154): on a project
 * where the user turned it on, a Steward's `ask` permission request is judged on the Waykeeper's
 * behalf and approved without a card when it fits the task, or forwarded to the user with the
 * reason. Repeated similar approvals can become standing approvals of the project.
 */

/** Approvals of one kind that make the card offer a standing approval. */
export const SIMILAR_APPROVALS_THRESHOLD = 3;
/** Recorded approvals kept per project (the newest). */
export const MAX_RECORDED_APPROVALS = 100;

/**
 * One simple command of a request, as the splitter saw it: its text, the permission categories it
 * falls under, whether it runs code the splitter cannot read (`opaque`), and whether it is
 * guarded (never approvable without the user).
 */
export const CommandPart = z.object({
  text: z.string(),
  categories: z.array(PermissionAction),
  opaque: z.enum(['inline_code', 'script_file', 'unreadable']).optional(),
  guarded: z.literal(true).optional(),
  /**
   * A destructive part whose target path resolves outside the Steward's worktree (`ctx.cwd`), or
   * that runs from outside it, or whose target cannot be placed (design §5.4a: a delete outside
   * the worktree is never approvable by the judge).
   */
  outsideCwd: z.literal(true).optional(),
});
export type CommandPart = z.infer<typeof CommandPart>;

/** A standing approval: a kind of request the user approved for the rest of the project. */
export const StandingApproval = z.object({
  id: Id,
  projectId: Id,
  /** The kind in words ("run the test suite"), the unit the judge matches on. */
  kind: z.string().min(1).max(200),
  examples: z.array(z.string().max(300)).min(1).max(10),
  createdBy: Actor,
  createdAt: Timestamp,
  /** Where the request that made it came from (a remote one needs `autoApproveRemote`). */
  origin: RequestOrigin,
  /** The forwarded question it was made from. */
  questionId: Id.optional(),
});
export type StandingApproval = z.infer<typeof StandingApproval>;

/** An approval the Waykeeper (or the user) gave, kept to spot repeats. */
export const RecordedApproval = z.object({
  kind: z.string().min(1).max(200),
  summary: z.string().max(300),
  agentId: Id,
  questionId: Id,
  at: Timestamp,
});
export type RecordedApproval = z.infer<typeof RecordedApproval>;

/**
 * What the Waykeeper forwarded to the user and why (`QuestionContext.waykeeper`). `similar`
 * present (at least `SIMILAR_APPROVALS_THRESHOLD`) means the card offers the standing-approval
 * button.
 */
export const WaykeeperForward = z.object({
  reason: z.string(),
  kind: z.string(),
  parts: z.array(CommandPart),
  /** Index into `parts` of the part that made it forward. */
  failingPart: z.number().int().nonnegative().optional(),
  similar: z.array(RecordedApproval).optional(),
});
export type WaykeeperForward = z.infer<typeof WaykeeperForward>;

/** What the request judge is given (design §5.3). */
export interface RequestJudgeInput {
  task: { title: string; description: string };
  workspace: string;
  cwd: string;
  /** The user's own words that bear on the task. */
  userWords: string[];
  /** The Steward's recent actions, already redacted. */
  recentActions: string[];
  standingApprovals: StandingApproval[];
  recordedApprovals: RecordedApproval[];
  /** Already redacted. */
  request: {
    toolName: string;
    input?: unknown;
    categories: PermissionAction[];
    parts: CommandPart[];
  };
}

export interface RequestVerdict {
  verdict: 'approve' | 'forward';
  reason: string;
  /** The kind in words, for the card and for repeat spotting. */
  kind: string;
  failingPart?: number;
  /** The standing approval that covers the request, when one does. */
  standingApprovalId?: Id;
  /** Indexes into `RequestJudgeInput.recordedApprovals` of the similar earlier approvals. */
  similarTo: number[];
  /** The user's words that grant it, when the verdict leans on them. */
  quote?: string;
}

/** Decides whether a Steward's permission request fits its task. Implementations fail closed. */
export interface RequestJudge {
  judge(input: RequestJudgeInput, signal: AbortSignal): Promise<RequestVerdict>;
}
