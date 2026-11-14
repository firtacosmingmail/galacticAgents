import {
  isJudgedKind,
  markLabel,
  needsUserQuote,
  quoteFound,
  SIMILAR_APPROVALS_THRESHOLD,
  type ApprovalMark,
  type CommandPart,
  type Id,
  type PermissionAction,
  type RecordedApproval,
  type RequestJudge,
  type RequestJudgeInput,
  type RequestVerdict,
  type StandingApproval,
  type ToolCall,
  type WaykeeperForward,
} from '@galactic/protocol';
import { markCovers } from '../domain/approval-marks.js';
import { partsOfCall } from '../domain/command-parts.js';
import { classifyToolCall, mentionsPush, type PolicyContext } from '../domain/permissions.js';
import { HeldJudgeCalls } from './held-judge.js';
import { redactSecrets, redactValue } from './redact.js';
import { SCOPE_JUDGE_TIMEOUT_MS } from './scope-watch.js';

/** The longest kind kept on a forward (`RecordedApproval.kind` takes at most 200). */
const MAX_KIND_CHARS = 200;
/** The longest judge reason kept (events, the activity line, the transcript, the card). */
export const MAX_REASON_CHARS = 300;

/** What the judge is told about the task and the project, read when the request arrives. */
export interface ApprovalFacts {
  task: { title: string; description: string };
  /** The user's own words (`userWordsFor`): the only grant of a push or an upload. */
  userWords: string[];
  /** The Steward's recent allowed actions, one redacted line each. */
  recentActions: string[];
  standingApprovals: StandingApproval[];
  recordedApprovals: RecordedApproval[];
}

/** An approval in the Waykeeper's name. */
export interface WaykeeperApproval {
  reason: string;
  /** The project's standing approval the judge relied on. */
  standingApprovalId?: Id;
  /** The user's words that grant a push, an upload, a send or a spend, found in them by the server. */
  quote?: string;
  /** The request's parts, their texts redacted: logged on the approval (P13-16). */
  parts: CommandPart[];
}

/**
 * One Steward permission request the gate rated `ask`, on a project whose Waykeeper approves
 * (P13-04). The call stays blocked in the adapter meanwhile; the runtime's callbacks answer it
 * (`approve`) or ask the user (`forward`).
 */
export interface ApprovalWatchCall {
  agentId: Id;
  projectId: Id;
  /** The raw call: the watch redacts what the judge and the card see. */
  toolCall: ToolCall;
  /** The categories the gate classified the call under. */
  categories: PermissionAction[];
  /** The Steward's policy context: `cwd` is its worktree. */
  ctx: PolicyContext;
  /**
   * A project Steward's scratch folder (P13-09): a delete inside it counts as inside, like one in
   * its worktree. Absent for an asteroid's Steward.
   */
  scratch?: string;
  /** The task, the user's words, the recent actions and the project's approvals; may throw. */
  facts: () => ApprovalFacts | undefined;
  /** False once the agent ended or is stopping, or the call was withdrawn: nothing is done. */
  active: () => boolean;
  /** Whether the project's switch is still on: read again when the verdict arrives. */
  switchOn: () => boolean;
  /** Whether the project is in Auto mode (P13-16): read when the request arrives and again after. */
  auto: () => boolean;
  /** The project's "Always asks me" marks (P13-16): read before the judge and again after; may throw. */
  marks: () => readonly ApprovalMark[];
  approve: (d: WaykeeperApproval) => void;
  forward: (context: WaykeeperForward) => void;
}

/** Why a part can never be approved by the judge, or `undefined` (design §5.4a). */
function hardRule(part: CommandPart): string | undefined {
  if (part.guarded) return 'it writes agent or git configuration, or the deliverables folder';
  if (part.outsideCwd)
    return "it deletes outside the Steward's worktree and scratch folder, or a target it cannot place (a variable the command does not set)";
  if (part.categories.includes('destructive') && /\$\(|`/.test(part.text)) {
    return 'it deletes a target that a command substitution decides';
  }
  if (part.opaque === 'unreadable') return 'it cannot be read';
  // A push the gate's raw-text detector sees in code the splitter cannot read (final review M5).
  if (
    (part.opaque === 'inline_code' || part.opaque === 'script_file') &&
    mentionsPush(part.text).length > 0
  ) {
    return 'it runs code that may push, which only the user can allow';
  }
  return undefined;
}

/**
 * The approval watch (P13-04; design 2026-11-09-waykeeper-approvals §5.2–5.5): a Steward's `ask`
 * request is held while the request judge looks at it, then approved in the Waykeeper's name or
 * forwarded to the user with the reason. Shares the scope watch's held-call machinery: the same
 * timeout, fail-closed failures and cancel race.
 *
 * The judge is not trusted. The hard rules are decided here, before it is called and without it:
 * a guarded write (by a part or by the whole call), a delete outside the worktree and the
 * Steward's scratch folder, a delete whose
 * target a substitution decides, an unreadable part, and inline code or a script file whose raw
 * text mentions a push (`mentionsPush`) are always forwarded. After it, an approval is kept only
 * if every push or upload part is granted by a quote the server finds in the user's own words,
 * any standing approval it names exists on the project (and never covers a push, an upload or an
 * opaque part), and the switch is still on.
 *
 * Auto mode and marks (P13-16; design 2026-11-14-waykeeper-auto-mode §4.2, §4.5): after the hard
 * rules and before the judge, a request one of the project's "Always asks me" marks covers is
 * forwarded, in either mode. In Auto the judge is asked in `auto` mode and must say whether the
 * request sends or spends; an approval is kept only if Auto is still on, no mark covers it by
 * now, and a send or a spend is granted by a quote in the user's own words, like a push. The
 * judge's reason is cut to `MAX_REASON_CHARS`.
 * Every failure — no judge, an error, a timeout, a malformed answer, a throw anywhere before a
 * callback — forwards. Never throws into the runtime.
 */
export class ApprovalWatch {
  private readonly calls: HeldJudgeCalls;

  constructor(
    private readonly deps: {
      judge: RequestJudge | undefined;
      timeoutMs?: number;
      onError?: (error: unknown) => void;
    },
  ) {
    this.calls = new HeldJudgeCalls(deps.timeoutMs ?? SCOPE_JUDGE_TIMEOUT_MS);
  }

  /** Judge calls still waiting for their verdict. */
  get inFlight(): number {
    return this.calls.inFlight;
  }

  async handle(call: ApprovalWatchCall): Promise<void> {
    // Set once a callback starts: a callback that throws is never followed by another.
    let settled = false;
    const once: ApprovalWatchCall = {
      ...call,
      approve: (d) => {
        settled = true;
        call.approve(d);
      },
      forward: (context) => {
        settled = true;
        call.forward(context);
      },
    };
    try {
      await this.decide(once);
    } catch (error) {
      this.deps.onError?.(error);
      // A throw before either callback (splitting, classifying, redacting): the Steward's call
      // is still blocked in the adapter, so it goes to the user rather than hang (final review I2).
      if (!settled) this.forwardUnjudged(once);
    }
  }

  /** The fallback forward after a throw: no parts, no judge, the tool's name as the kind. */
  private forwardUnjudged(call: ApprovalWatchCall): void {
    try {
      if (!call.active()) return;
      let toolName = 'the request';
      try {
        toolName = call.toolCall.toolName;
      } catch {
        // The name stays generic.
      }
      call.forward({
        reason: 'the request could not be judged',
        kind: `not judged: ${toolName}`.slice(0, MAX_KIND_CHARS),
        parts: [],
      });
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  /** Aborts every judge call of `agentId`: their verdicts do nothing. */
  cancel(agentId: Id): void {
    this.calls.cancel(agentId);
  }

  private async decide(call: ApprovalWatchCall): Promise<void> {
    const parts = partsOfCall(
      call.toolCall,
      call.ctx,
      call.scratch !== undefined ? { scratch: call.scratch } : {},
    );
    const shown = parts.map((p) => ({ ...p, text: redactSecrets(p.text) }));
    const unjudged = `not judged: ${call.toolCall.toolName}`.slice(0, MAX_KIND_CHARS);
    // A push or an upload is never a standing approval (P13-10): its card never offers one.
    /** A push, an upload, a send or a spend: its card never offers a standing approval. */
    let allowOnce = false;
    const forward = (
      reason: string,
      kind: string,
      failingPart?: number,
      similar?: RecordedApproval[],
    ) => {
      if (!call.active()) return;
      const named = redactSecrets(kind).slice(0, MAX_KIND_CHARS) || unjudged;
      call.forward({
        reason: redactSecrets(reason),
        kind: named,
        parts: shown,
        ...(failingPart !== undefined ? { failingPart } : {}),
        // A placeholder kind never offers a standing approval: it would cover nothing nameable.
        ...(similar && isJudgedKind(named) && !allowOnce ? { similar } : {}),
      });
    };

    // -- the hard rules: decided here, never by the judge ------------------------------------
    for (const [i, part] of parts.entries()) {
      const rule = hardRule(part);
      if (rule) return forward(`Never approved by the Waykeeper: ${rule}.`, unjudged, i);
    }
    let whole: ReturnType<typeof classifyToolCall>;
    try {
      whole = classifyToolCall(call.toolCall, call.ctx);
    } catch {
      return forward('Never approved by the Waykeeper: the request cannot be read.', unjudged);
    }
    if (whole.guarded) {
      return forward(
        'Never approved by the Waykeeper: it writes agent or git configuration, or the deliverables folder.',
        unjudged,
      );
    }
    const quoteNeeded = parts.map(needsUserQuote);
    // A push the gate saw in the whole call (an unsplit tool's input) needs the user's words too.
    const callNeedsQuote =
      quoteNeeded.some(Boolean) ||
      needsUserQuote({
        text: parts.map((p) => p.text).join(' '),
        categories: [...new Set([...call.categories, ...whole.actions])],
      });
    const quotePart = quoteNeeded.indexOf(true);
    allowOnce = callNeedsQuote;

    let marked: ReturnType<typeof markForward>;
    try {
      marked = markForward(call, parts);
    } catch {
      return forward("The project's marks could not be read.", unjudged);
    }
    if (marked) return forward(marked.reason, unjudged, marked.part);

    const mode: RequestJudgeInput['mode'] = call.auto() ? 'auto' : 'task';
    const judge = this.deps.judge;
    if (!judge) return forward('No request judge is configured.', unjudged);
    let facts: ApprovalFacts | undefined;
    try {
      facts = call.facts();
    } catch {
      facts = undefined;
    }
    if (!facts) return forward('The task could not be read.', unjudged);
    const known = facts;

    const input: RequestJudgeInput = {
      mode,
      task: known.task,
      workspace: call.ctx.workspace,
      cwd: call.ctx.cwd ?? call.ctx.workspace,
      userWords: [...known.userWords],
      recentActions: [...known.recentActions],
      standingApprovals: [...known.standingApprovals],
      recordedApprovals: [...known.recordedApprovals],
      request: {
        toolName: call.toolCall.toolName,
        ...(call.toolCall.input !== undefined ? { input: redactValue(call.toolCall.input) } : {}),
        categories: [...new Set([...call.categories, ...whole.actions])],
        parts: shown,
      },
    };
    const outcome = await this.calls.run(call.agentId, (signal) => judge.judge(input, signal));
    if (outcome === 'cancelled' || !call.active()) return;
    if (!outcome.ok) return forward(outcome.reason, unjudged);
    const verdict = validVerdict(outcome.value, parts.length, mode);
    if (!verdict) return forward('The check gave a malformed answer: no verdict.', unjudged);

    const sendsOrSpends = mode === 'auto' && verdict.sendsOrSpends === true;
    if (sendsOrSpends) allowOnce = true;
    const similar = similarOf(verdict.similarTo, known.recordedApprovals);
    const kind = verdict.kind;
    if (verdict.verdict === 'forward') {
      return forward(verdict.reason, kind, verdict.failingPart, similar);
    }

    // -- an approval, checked again here --------------------------------------------------------
    if (!call.switchOn()) {
      return forward(
        'Waykeeper approvals were turned off while the request was judged.',
        kind,
        undefined,
        similar,
      );
    }
    if (mode === 'auto' && !call.auto()) {
      return forward(
        'Auto mode was turned off while the request was judged.',
        kind,
        undefined,
        similar,
      );
    }
    // A mark added while the request was judged still makes it ask.
    let markedNow: ReturnType<typeof markForward>;
    try {
      markedNow = markForward(call, parts);
    } catch {
      return forward("The project's marks could not be read.", kind, undefined, similar);
    }
    if (markedNow) return forward(markedNow.reason, kind, markedNow.part, similar);
    const failing = quotePart >= 0 ? quotePart : undefined;
    const needsQuote = callNeedsQuote || sendsOrSpends;
    if (needsQuote) {
      const what = callNeedsQuote ? 'a push or an upload' : 'a send or a spend';
      const What = callNeedsQuote ? 'A push or an upload' : 'A send or a spend';
      if (verdict.quote === undefined || !quoteFound(verdict.quote, known.userWords)) {
        return forward(
          `${What} needs the user's own words asking for it. The judge said: ${verdict.reason}`,
          kind,
          failing,
          similar,
        );
      }
      if (verdict.standingApprovalId !== undefined) {
        return forward(
          `A standing approval never covers ${what}. The judge said: ${verdict.reason}`,
          kind,
          failing,
          similar,
        );
      }
    }
    // A standing approval never covers code the splitter cannot read (final review M4).
    const opaquePart = parts.findIndex((p) => p.opaque !== undefined);
    if (verdict.standingApprovalId !== undefined && opaquePart >= 0) {
      return forward(
        `A standing approval never covers code it cannot read. The judge said: ${verdict.reason}`,
        kind,
        opaquePart,
        similar,
      );
    }
    // Read again: a standing approval removed while the judge ran no longer covers anything.
    if (
      verdict.standingApprovalId !== undefined &&
      !standingNow(call).some((a) => a.id === verdict.standingApprovalId)
    ) {
      return forward(
        `The standing approval the judge relied on is not one of the project's. The judge said: ${verdict.reason}`,
        kind,
        undefined,
        similar,
      );
    }
    call.approve({
      reason: redactSecrets(verdict.reason),
      ...(verdict.standingApprovalId !== undefined
        ? { standingApprovalId: verdict.standingApprovalId }
        : {}),
      ...(needsQuote && verdict.quote !== undefined ? { quote: verdict.quote } : {}),
      parts: shown,
    });
  }
}

/**
 * The first of the project's marks the call implies (P13-16), as a forward: "You asked to be
 * asked: <mark> (from “<example>”)." and the first part it implies — the shortest run of parts
 * from the start it covers, so a `cd` before that part still counts. `undefined` when none does;
 * throws when the marks cannot be read.
 */
function markForward(
  call: ApprovalWatchCall,
  parts: CommandPart[],
): { reason: string; part?: number } | undefined {
  const roots = { worktree: call.ctx.cwd, scratch: call.scratch };
  const covers = (match: ApprovalMark['match'], some: CommandPart[]) =>
    markCovers(match, { toolCall: call.toolCall, parts: some, ctx: call.ctx }, roots);
  const mark = call.marks().find((m) => covers(m.match, parts));
  if (!mark) return undefined;
  const part = parts.findIndex((_, n) => covers(mark.match, parts.slice(0, n + 1)));
  return {
    reason: `You asked to be asked: ${markLabel(mark.match)} (from “${mark.example}”).`,
    ...(part >= 0 ? { part } : {}),
  };
}

/** The project's standing approvals as of now; none when they cannot be read. */
function standingNow(call: ApprovalWatchCall): readonly StandingApproval[] {
  try {
    return call.facts()?.standingApprovals ?? [];
  } catch {
    return [];
  }
}

/**
 * The records `similarTo` points at — its valid indexes of a judged kind (`isJudgedKind`), each
 * once — when there are at least
 * `SIMILAR_APPROVALS_THRESHOLD` of them; else `undefined` (no standing-approval button).
 */
function similarOf(
  similarTo: readonly number[],
  recorded: readonly RecordedApproval[],
): RecordedApproval[] | undefined {
  const valid = [
    ...new Set(
      similarTo.filter((i) => isIndex(i, recorded.length) && isJudgedKind(recorded[i]!.kind)),
    ),
  ];
  return valid.length >= SIMILAR_APPROVALS_THRESHOLD ? valid.map((i) => recorded[i]!) : undefined;
}

const isIndex = (i: unknown, length: number): i is number =>
  typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < length;

/** The judge's answer when it is well formed, else `undefined` (it then forwards). */
function validVerdict(
  answer: unknown,
  partCount: number,
  mode: RequestJudgeInput['mode'],
): RequestVerdict | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const v = answer as Partial<Record<keyof RequestVerdict, unknown>>;
  if (v.verdict !== 'approve' && v.verdict !== 'forward') return undefined;
  if (typeof v.reason !== 'string' || !v.reason.trim()) return undefined;
  if (v.similarTo !== undefined && !Array.isArray(v.similarTo)) return undefined;
  if (v.standingApprovalId !== undefined && typeof v.standingApprovalId !== 'string') {
    return undefined;
  }
  if (v.quote !== undefined && typeof v.quote !== 'string') return undefined;
  // Auto's one question is whether it sends or spends: an answer without it is no answer.
  if (mode === 'auto' && typeof v.sendsOrSpends !== 'boolean') return undefined;
  const reason =
    v.reason.length <= MAX_REASON_CHARS ? v.reason : `${v.reason.slice(0, MAX_REASON_CHARS - 1)}…`;
  return {
    verdict: v.verdict,
    reason,
    kind: typeof v.kind === 'string' ? v.kind.trim() : '',
    similarTo:
      (v.similarTo as unknown[] | undefined)?.map((i) => (typeof i === 'number' ? i : -1)) ?? [],
    ...(isIndex(v.failingPart, partCount) ? { failingPart: v.failingPart } : {}),
    ...(typeof v.standingApprovalId === 'string'
      ? { standingApprovalId: v.standingApprovalId }
      : {}),
    ...(typeof v.quote === 'string' ? { quote: v.quote } : {}),
    ...(typeof v.sendsOrSpends === 'boolean' ? { sendsOrSpends: v.sendsOrSpends } : {}),
  };
}
