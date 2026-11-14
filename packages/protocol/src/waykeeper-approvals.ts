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
   * A destructive part whose target path resolves outside the Steward's worktree (`ctx.cwd`) and
   * its scratch folder (P13-09), or that runs from outside both, or whose target cannot be placed
   * (design §5.4a: a delete outside them is never approvable by the judge).
   */
  outsideCwd: z.literal(true).optional(),
});
export type CommandPart = z.infer<typeof CommandPart>;

/** Days an approval mark counts (design 2026-11-14, §4.1). */
export const APPROVAL_MARK_DAYS = 10;
/** Approval marks kept per project. */
export const MAX_APPROVAL_MARKS = 200;

/**
 * What an approval mark matches (Auto mode, design 2026-11-14 §4.1): a folder (a category of
 * action inside these paths), a site (a network host), a command prefix, or a whole tool.
 */
export const ApprovalMarkMatch = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('folder'),
    category: PermissionAction,
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('site'), host: z.string().min(1) }),
  z.object({ kind: z.literal('prefix'), words: z.array(z.string().min(1)).min(1).max(20) }),
  z.object({ kind: z.literal('tool'), toolName: z.string().min(1) }),
]);
export type ApprovalMarkMatch = z.infer<typeof ApprovalMarkMatch>;

/** An approval mark: one request the user approved, kept as a pattern for `APPROVAL_MARK_DAYS`. */
export const ApprovalMark = z.object({
  id: Id,
  projectId: Id,
  match: ApprovalMarkMatch,
  /** The request it was made from, redacted. */
  example: z.string().max(300),
  createdBy: Actor,
  createdAt: Timestamp,
  origin: RequestOrigin,
  /** The `permission.decided` / question event it was made from. */
  fromSeq: z.number().int().positive(),
});
export type ApprovalMark = z.infer<typeof ApprovalMark>;

/** The categories of the approvals log, most serious first. */
export type ApprovalLogCategory =
  'push' | 'delete' | 'outside' | 'network' | 'unreadable' | 'edit' | 'run' | 'read';

export const APPROVAL_LOG_ORDER: readonly ApprovalLogCategory[] = [
  'push',
  'delete',
  'outside',
  'network',
  'unreadable',
  'edit',
  'run',
  'read',
];

const LOG_OF_ACTION: Partial<Record<PermissionAction, ApprovalLogCategory>> = {
  push: 'push',
  destructive: 'delete',
  outside_workspace: 'outside',
  network: 'network',
  edit_workspace: 'edit',
  run_workspace: 'run',
  read_workspace: 'read',
};

/**
 * The approvals-log category of a decision: the first of `APPROVAL_LOG_ORDER` that applies over all
 * its parts' categories (a part running unreadable code is `unreadable`); without parts, from the
 * action alone; nothing known is `run`.
 */
export function approvalLogCategory(e: {
  action?: PermissionAction | undefined;
  parts?: CommandPart[] | undefined;
}): ApprovalLogCategory {
  const found = new Set<ApprovalLogCategory>();
  if (e.parts?.length) {
    for (const part of e.parts) {
      if (part.opaque) found.add('unreadable');
      for (const c of part.categories) {
        const log = LOG_OF_ACTION[c];
        if (log) found.add(log);
      }
    }
  } else if (e.action) {
    const log = LOG_OF_ACTION[e.action];
    if (log) found.add(log);
  }
  return APPROVAL_LOG_ORDER.find((c) => found.has(c)) ?? 'run';
}

const CATEGORY_WORDS: Partial<Record<PermissionAction, string>> = {
  destructive: 'deletes',
  edit_workspace: 'edits',
  run_workspace: 'runs',
  read_workspace: 'reads',
  outside_workspace: 'touches',
  network: 'network calls',
  push: 'pushes',
};

/** A mark in words, for the marks list and the decision lines. */
export function markLabel(match: ApprovalMarkMatch): string {
  switch (match.kind) {
    case 'folder':
      return `${CATEGORY_WORDS[match.category] ?? match.category} in ${match.paths.join(', ')}`;
    case 'site':
      return `calls to ${match.host}`;
    case 'prefix':
      return `${match.words.join(' ')} …`;
    case 'tool':
      return `the tool ${match.toolName}`;
  }
}

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

/** The kind the approval watch gives a request it forwarded without the judge naming one. */
export const UNJUDGED_KIND_PREFIX = 'not judged:';

/**
 * Whether `kind` names a kind of request the judge judged, not a placeholder (`not judged: <tool>`
 * or `unknown`): only such a kind is recorded as an approval, counts towards `similar`, or can
 * become a standing approval (final review I4).
 */
export function isJudgedKind(kind: string): boolean {
  const k = kind.trim().toLowerCase();
  return k !== '' && k !== 'unknown' && !k.startsWith(UNJUDGED_KIND_PREFIX);
}

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
 * The marker before an option the user picked among the user's words (P13-10): the option is the
 * asking agent's text, which the user chose whole, so a quote of it must be the whole option.
 */
export const PICKED_OPTION_PREFIX = 'Picked option: ';

/**
 * Whether `quote` appears verbatim in one of the user's own `words`, whitespace runs collapsed and
 * both sides trimmed, and is at least `QUOTE_MIN_LENGTH` characters (design 5.4a, 6). A word that
 * starts with `PICKED_OPTION_PREFIX` is a picked option: only the whole option matches (with or
 * without the marker), never a piece of it ("Hold — do not push …" grants no "push …").
 */
export function quoteFound(quote: string, words: readonly string[]): boolean {
  const q = normaliseWords(quote);
  if (q.length < QUOTE_MIN_LENGTH) return false;
  return words.some((w) => {
    const n = normaliseWords(w);
    const marker = normaliseWords(PICKED_OPTION_PREFIX);
    if (!n.startsWith(marker)) return n.includes(q);
    return q === n || q === normaliseWords(n.slice(marker.length));
  });
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
 * Whether a forwarded request is a push or an upload (P13-10): its permission category is `push`,
 * or a part of it needs the user's own words (`needsUserQuote`). Such a request is never a
 * standing approval, so it is never recorded as a similar approval and its card never offers the
 * standing-approval button: the user allows it once.
 */
export function isPushOrUpload(context: {
  permissionAction?: PermissionAction | undefined;
  waykeeper?: Pick<WaykeeperForward, 'parts'> | undefined;
}): boolean {
  return (
    context.permissionAction === 'push' || (context.waykeeper?.parts ?? []).some(needsUserQuote)
  );
}

/**
 * Whether a forwarded card offers "Approved <n> times before — let the Waykeeper approve these"
 * (P13-10): the Waykeeper forwarded it, the judge named its kind, at least
 * `SIMILAR_APPROVALS_THRESHOLD` similar approvals are on it, and it is no push or upload.
 */
export function offersStandingApproval(context: {
  permissionAction?: PermissionAction | undefined;
  waykeeper?: WaykeeperForward | undefined;
}): boolean {
  const forward = context.waykeeper;
  return (
    forward !== undefined &&
    isJudgedKind(forward.kind) &&
    (forward.similar?.length ?? 0) >= SIMILAR_APPROVALS_THRESHOLD &&
    !isPushOrUpload(context)
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

/**
 * Whether a `permission.decided` is an approval the Waykeeper's request judge gave (P13, final
 * review M2): an allow by an agent marked `waykeeperApproval`. A P12 scope-watch allow, also by an
 * agent, is not one: it gets no "Approved by" line and is not counted.
 */
export function isWaykeeperApproval(event: {
  decision: 'allow' | 'deny';
  decidedBy: { type: string };
  waykeeperApproval?: true | undefined;
}): boolean {
  return (
    event.decision === 'allow' &&
    event.decidedBy.type === 'agent' &&
    event.waykeeperApproval === true
  );
}

/** "Waykeeper · <project name>" (the panel's label for a project's Waykeeper). */
export function waykeeperLabel(
  agent: { id: Id; projectId?: Id | undefined },
  projectName?: string,
): string {
  return `Waykeeper · ${projectName ?? agent.projectId ?? agent.id}`;
}
