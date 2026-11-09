import {
  isJudgedKind,
  needsUserQuote,
  quoteFound,
  SIMILAR_APPROVALS_THRESHOLD,
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
import { partsOfCall } from '../domain/command-parts.js';
import { classifyToolCall, type PolicyContext } from '../domain/permissions.js';
import { HeldJudgeCalls } from './held-judge.js';
import { redactSecrets, redactValue } from './redact.js';
import { SCOPE_JUDGE_TIMEOUT_MS } from './scope-watch.js';

/** The longest kind kept on a forward (`RecordedApproval.kind` takes at most 200). */
const MAX_KIND_CHARS = 200;

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
  /** The user's words that grant a push or an upload, found in them by the server. */
  quote?: string;
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
  /** The task, the user's words, the recent actions and the project's approvals; may throw. */
  facts: () => ApprovalFacts | undefined;
  /** False once the agent ended or is stopping, or the call was withdrawn: nothing is done. */
  active: () => boolean;
  /** Whether the project's switch is still on: read again when the verdict arrives. */
  switchOn: () => boolean;
  approve: (d: WaykeeperApproval) => void;
  forward: (context: WaykeeperForward) => void;
}

/** Why a part can never be approved by the judge, or `undefined` (design §5.4a). */
function hardRule(part: CommandPart): string | undefined {
  if (part.guarded) return 'it writes agent or git configuration, or the deliverables folder';
  if (part.outsideCwd) return "it deletes outside the Steward's worktree";
  if (part.categories.includes('destructive') && /\$\(|`/.test(part.text)) {
    return 'it deletes a target that a command substitution decides';
  }
  if (part.opaque === 'unreadable') return 'it cannot be read';
  return undefined;
}

/**
 * The approval watch (P13-04; design 2026-11-09-waykeeper-approvals §5.2–5.5): a Steward's `ask`
 * request is held while the request judge looks at it, then approved in the Waykeeper's name or
 * forwarded to the user with the reason. Shares the scope watch's held-call machinery: the same
 * timeout, fail-closed failures and cancel race.
 *
 * The judge is not trusted. The hard rules are decided here, before it is called and without it:
 * a guarded write (by a part or by the whole call), a delete outside the worktree, a delete whose
 * target a substitution decides, and an unreadable part are always forwarded. After it, an
 * approval is kept only if every push or upload part is granted by a quote the server finds in
 * the user's own words, any standing approval it names exists on the project (and never covers a
 * push or upload), and the switch is still on. Every failure — no judge, an error, a timeout, a
 * malformed answer — forwards. Never throws into the runtime.
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
    const parts = partsOfCall(call.toolCall, call.ctx);
    const shown = parts.map((p) => ({ ...p, text: redactSecrets(p.text) }));
    const unjudged = `not judged: ${call.toolCall.toolName}`.slice(0, MAX_KIND_CHARS);
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
        ...(similar && isJudgedKind(named) ? { similar } : {}),
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
    const verdict = validVerdict(outcome.value, parts.length);
    if (!verdict) return forward('The check gave a malformed answer: no verdict.', unjudged);

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
    const failing = quotePart >= 0 ? quotePart : undefined;
    if (callNeedsQuote) {
      if (verdict.quote === undefined || !quoteFound(verdict.quote, known.userWords)) {
        return forward(
          `A push or an upload needs the user's own words asking for it. The judge said: ${verdict.reason}`,
          kind,
          failing,
          similar,
        );
      }
      if (verdict.standingApprovalId !== undefined) {
        return forward(
          `A standing approval never covers a push or an upload. The judge said: ${verdict.reason}`,
          kind,
          failing,
          similar,
        );
      }
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
      ...(callNeedsQuote && verdict.quote !== undefined ? { quote: verdict.quote } : {}),
    });
  }
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
function validVerdict(answer: unknown, partCount: number): RequestVerdict | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const v = answer as Partial<Record<keyof RequestVerdict, unknown>>;
  if (v.verdict !== 'approve' && v.verdict !== 'forward') return undefined;
  if (typeof v.reason !== 'string' || !v.reason.trim()) return undefined;
  if (v.similarTo !== undefined && !Array.isArray(v.similarTo)) return undefined;
  if (v.standingApprovalId !== undefined && typeof v.standingApprovalId !== 'string') {
    return undefined;
  }
  if (v.quote !== undefined && typeof v.quote !== 'string') return undefined;
  return {
    verdict: v.verdict,
    reason: v.reason,
    kind: typeof v.kind === 'string' ? v.kind.trim() : '',
    similarTo:
      (v.similarTo as unknown[] | undefined)?.map((i) => (typeof i === 'number' ? i : -1)) ?? [],
    ...(isIndex(v.failingPart, partCount) ? { failingPart: v.failingPart } : {}),
    ...(typeof v.standingApprovalId === 'string'
      ? { standingApprovalId: v.standingApprovalId }
      : {}),
    ...(typeof v.quote === 'string' ? { quote: v.quote } : {}),
  };
}
