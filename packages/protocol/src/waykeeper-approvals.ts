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

/** The shortest quote of the user's words that grants a push or an upload. */
export const QUOTE_MIN_LENGTH = 15;

const normaliseWords = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Whether `quote` appears verbatim in one of the user's own `words`, whitespace runs collapsed and
 * both sides trimmed, and is at least `QUOTE_MIN_LENGTH` characters (design 5.4a, 6).
 */
export function quoteFound(quote: string, words: readonly string[]): boolean {
  const q = normaliseWords(quote);
  return q.length >= QUOTE_MIN_LENGTH && words.some((w) => normaliseWords(w).includes(q));
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic)\b/i;

/** A part only the user's own words can grant: a push, or an upload of a screenshot or image. */
export function needsUserQuote(part: CommandPart): boolean {
  if (part.categories.includes('push')) return true;
  return (
    part.categories.includes('network') &&
    (IMAGE_FILE.test(part.text) || /screenshot/i.test(part.text))
  );
}

/**
 * The line a Waykeeper approval leaves in the Steward's activity and transcript (P13-06, design
 * §5.6): "Approved by <Waykeeper name>: <reason>", plus `— you asked: "<quote>"` when the user's
 * words carried it.
 */
export function approvalActivity(name: string, reason?: string, quote?: string): string {
  return `Approved by ${name}${reason ? `: ${reason}` : ''}${quote ? ` — you asked: "${quote}"` : ''}`;
}

/** "Waykeeper · <project name>" (the panel's label for a project's Waykeeper). */
export function waykeeperLabel(
  agent: { id: Id; projectId?: Id | undefined },
  projectName?: string,
): string {
  return `Waykeeper · ${projectName ?? agent.projectId ?? agent.id}`;
}
