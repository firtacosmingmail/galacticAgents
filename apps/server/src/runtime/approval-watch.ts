import {
  isGrantLive,
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
  type SendGrant,
  type SendPermissionContext,
  type StandingApproval,
  type AllowedBy,
  type ToolCall,
  type WaykeeperForward,
} from '@galactic/protocol';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { markCovers } from '../domain/approval-marks.js';
import {
  gitPushOf,
  mainBranchesOf,
  movesFolder,
  pushesToMain,
  type GitRead,
} from '../domain/git-push.js';
import { partsOfCall } from '../domain/command-parts.js';
import { classifyToolCall, mentionsPush, type PolicyContext } from '../domain/permissions.js';
import { HeldJudgeCalls } from './held-judge.js';
import { redactSecrets, redactValue } from './redact.js';
import { SCOPE_JUDGE_TIMEOUT_MS } from './scope-watch.js';

/** The longest kind kept on a forward (`RecordedApproval.kind` takes at most 200). */
const MAX_KIND_CHARS = 200;
/** The longest judge reason kept (events, the activity line, the transcript, the card). */
export const MAX_REASON_CHARS = 300;

/**
 * The categories that stay on this machine (P13-26; design 2026-11-18 §4.2 step 2): reads,
 * writes, edits and deletes of files, anywhere. A request whose every part is only these, none
 * opaque, and that is a file tool or only `LOCAL_FILE_COMMANDS` (`onlyFileWork`) is approved in
 * Auto without the judge. Anything else — running a command, the network, a push, an
 * unclassified call — may send or spend and goes to the judge.
 */
export const LOCAL_ONLY_CATEGORIES: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  'read_workspace',
  'edit_workspace',
  'destructive',
  'outside_workspace',
]);

/** The tools that only read or change files: approved in Auto without the judge (P13-26). */
export const LOCAL_FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
]);

/**
 * The shell commands that only read or change files (P13-26): a Bash request each of whose
 * parts runs one of these, by its bare name, is approved in Auto without the judge. A path to a
 * binary, `sudo`/`doas` or any other wrapper or runner in front, an environment assignment other
 * than `LANG`/`LC_*` (`PATH`, `LD_PRELOAD`, … change what runs), `find` with `-exec`/`-execdir`/
 * `-ok`/`-okdir`, and `diff` with `-l`/`--paginate` (it runs `pr`) all go to the judge. Not here:
 * `sed` (its `e` flag and command run shell code) and `rg` (`--pre`, `--hostname-bin` and more
 * run a program).
 */
export const LOCAL_FILE_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'find',
  'grep',
  'diff',
  'stat',
  'file',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'ln',
  'chmod',
]);

/** The only environment assignments a file command may carry: the locale. */
const LOCALE_ASSIGNMENT = /^(?:LANG|LC_[A-Za-z0-9_]*)=/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** What may run something else or reach the network from inside a file command's words. */
const HIDDEN_RUN = /\$\(|`|<\(|>\(|\/dev\/(?:tcp|udp)\//;
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/**
 * `diff -l`/`--paginate` pipes through `pr` (GNU and BSD): a short-option group holding `l`, or
 * any long option starting `--p` (GNU takes an unambiguous prefix: `--pag` is `--paginate`).
 */
const DIFF_RUNS = (a: string) => /^-[a-zA-Z0-9]*l/.test(a) || a.startsWith('--p');

/** The file tools that write: their target must not be a program folder. */
const WRITING_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether a path is in a program folder (P13-26, review): a directory on PATH (or the folder
 * itself), or any path with a segment named `bin` or `sbin`. A file put there shadows a command
 * the next call runs. `~` and relative paths resolve against the Steward's home and cwd; on macOS
 * the comparison ignores case, as its file system does.
 */
export type ProgramFolderTest = (path: string) => boolean;

export function programFolderTest(
  ctx: PolicyContext,
  pathEnv: string | undefined,
  caseInsensitive: boolean,
): ProgramFolderTest {
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const cwd = ctx.cwd ?? ctx.workspace;
  const absolute = (p: string): string => {
    if (p === '~' || p.startsWith('~/')) return resolve(ctx.home ?? homedir(), p.slice(2));
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  };
  const dirs = (pathEnv ?? '')
    .split(':')
    .filter((d) => d.length > 0)
    .map((d) => fold(absolute(d)));
  return (raw: string) => {
    if (raw.length === 0) return false;
    const p = fold(absolute(raw));
    if (p.split(sep).some((seg) => seg === 'bin' || seg === 'sbin')) return true;
    return dirs.some((d) => p === d || p.startsWith(d.endsWith(sep) ? d : d + sep));
  };
}

/**
 * The path a shell word names, or `undefined` for an option: a redirect's target (`>x`, `2>>x`,
 * `&>x`) and a long option's value (`--target-directory=x`) count.
 */
function pathOfWord(word: string): string | undefined {
  const w = word.replace(/^(?:\d*>>?|&>>?|<)/, '');
  if (w.startsWith('--')) {
    const eq = w.indexOf('=');
    return eq >= 0 ? w.slice(eq + 1) : undefined;
  }
  if (w.startsWith('-')) return undefined;
  return w;
}

/**
 * Whether one readable shell part runs a `LOCAL_FILE_COMMANDS` command and nothing else, naming
 * no program folder (any path word: a copy, link, move, touch, mkdir or chmod target, a redirect).
 */
function isFileCommand(text: string, inProgramFolder: ProgramFolderTest): boolean {
  if (HIDDEN_RUN.test(text)) return false;
  const words = text.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i]!)) {
    if (!LOCALE_ASSIGNMENT.test(words[i]!)) return false;
    i++;
  }
  const head = words[i];
  if (head === undefined || !LOCAL_FILE_COMMANDS.has(head)) return false;
  // Quotes do not hide an option from the shell: `'-exec'` is `-exec`.
  const args = words.slice(i + 1).map((a) => a.replace(/['"]/g, ''));
  if (head === 'find' && args.some((a) => FIND_RUNS.has(a))) return false;
  if (head === 'diff' && args.some(DIFF_RUNS)) return false;
  return !args.some((a) => {
    const path = pathOfWord(a);
    return path !== undefined && inProgramFolder(path);
  });
}

/**
 * Whether a request only reads or changes files (P13-26, review C1): a file tool, or a Bash
 * request whose every part is a readable `LOCAL_FILE_COMMANDS` command. The categories alone do
 * not tell: the gate tags any command naming a path outside the workspace `outside_workspace`.
 */
function onlyFileWork(
  toolCall: ToolCall,
  parts: readonly CommandPart[],
  inProgramFolder: ProgramFolderTest,
): boolean {
  const { toolName } = toolCall;
  if (LOCAL_FILE_TOOLS.has(toolName)) {
    if (!WRITING_FILE_TOOLS.has(toolName)) return true;
    const input = (toolCall.input ?? {}) as Record<string, unknown>;
    const target = input['file_path'] ?? input['notebook_path'];
    return typeof target === 'string' && !inProgramFolder(target);
  }
  if (toolName !== 'Bash') return false;
  return parts.every((p) => p.opaque === undefined && isFileCommand(p.text, inProgramFolder));
}

/** The held summary when the check fails: treated as a send or a spend with no grant. */
export const UNCHECKED_SEND_SUMMARY = 'The check could not tell whether this sends or spends.';

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
  /** Auto (P13-26): what allowed it, for the approvals log. Absent in task mode. */
  allowedBy?: AllowedBy;
  /** Auto (P13-26): the send grant that covered it, live when the verdict arrived. */
  grantId?: Id;
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
  /**
   * Runs `git` in the Steward's worktree (P13-20): where a push goes. Absent or failing, a push
   * that needs the current branch is forwarded.
   */
  git?: GitRead;
  /**
   * The project's live send grants (P13-26): read when the request arrives (for the judge) and
   * again when the verdict does (the grant it names must still be among them); may throw.
   */
  grants: () => SendGrant[];
  approve: (d: WaykeeperApproval) => void;
  forward: (context: WaykeeperForward) => void;
  /** Auto (P13-26): a send or a spend no grant and no words cover: the call stays held. */
  hold: (context: SendPermissionContext) => void;
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
 * Marks (P13-16; design 2026-11-14-waykeeper-auto-mode §4.5): after the hard rules and before
 * the judge, a request one of the project's "Always asks me" marks covers is forwarded.
 * The judge's reason is cut to `MAX_REASON_CHARS`.
 * Every failure — no judge, an error, a timeout, a malformed answer, a throw anywhere before a
 * callback — forwards. Never throws into the runtime.
 *
 * Auto (P13-26; design 2026-11-18-auto-approves-all §4.2) replaces all of the above: no hard
 * rules, no push checks. A mark still forwards; a request that only touches files is approved
 * without the judge; anything else goes to the judge in `grants` mode and is approved when it
 * neither sends nor spends, when a grant live at verdict time covers it, or when the user's own
 * words ask for it (a quote the server finds); otherwise — or when the check fails — it is held
 * (`hold`) for the grant question. The switch or Auto turned off, or a mark added, while it was
 * judged forwards, as in task mode. A throw before any callback still forwards.
 */
export class ApprovalWatch {
  private readonly calls: HeldJudgeCalls;

  constructor(
    private readonly deps: {
      judge: RequestJudge | undefined;
      timeoutMs?: number;
      onError?: (error: unknown) => void;
      /** Epoch ms, for whether a grant is live (default `Date.now`). */
      now?: () => number;
      /** The PATH whose folders are program folders (default `process.env.PATH`). */
      pathEnv?: string;
      /** Whether paths compare ignoring case (default: on macOS). */
      caseInsensitivePaths?: boolean;
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
      hold: (context) => {
        settled = true;
        call.hold(context);
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

  /**
   * The request's git pushes (P13-20, decision 161): `forward` for a push to the main branch
   * (`main`, `master`, the remote's default) or one whose branch cannot be told; otherwise the
   * indexes of the parts that are a single git push to other branches (`cleared`). Other pushes
   * (`gh pr create`, `npm publish`) are neither.
   */
  private async gitPushes(
    call: ApprovalWatchCall,
    parts: readonly CommandPart[],
  ): Promise<{ cleared: number[] } | { forward: string; part: number }> {
    const cleared: number[] = [];
    if (call.toolCall.toolName !== 'Bash') return { cleared };
    let mains: string[] | undefined;
    for (const [i, part] of parts.entries()) {
      if (!part.categories.includes('push')) continue;
      const moved = parts.slice(0, i + 1).some((p) => movesFolder(p.text));
      const push = await gitPushOf(part.text, call.git, moved);
      if (push === undefined) continue;
      if ('unknown' in push) {
        return {
          forward: `it pushes and the Waykeeper cannot tell which branch (${push.unknown})`,
          part: i,
        };
      }
      mains ??= await mainBranchesOf(call.git);
      if (pushesToMain(push.branches, mains)) {
        return { forward: 'it pushes to the main branch, which only the user can allow', part: i };
      }
      cleared.push(i);
    }
    return { cleared };
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

    // -- Auto (P13-26): its own path, without the hard rules or the push checks ---------------
    if (call.auto()) return this.decideAuto(call, parts, shown, forward, unjudged);

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
    // -- git pushes (P13-20, decision 161): never to the main branch --------------------------
    const pushes = await this.gitPushes(call, parts);
    if ('forward' in pushes) {
      return forward(`Never approved by the Waykeeper: ${pushes.forward}.`, unjudged, pushes.part);
    }
    const mode: RequestJudgeInput['mode'] = 'task';
    const quoteNeeded = parts.map((p) => needsUserQuote(p));
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
    // A mark added while the request was judged still makes it ask.
    let markedNow: ReturnType<typeof markForward>;
    try {
      markedNow = markForward(call, parts);
    } catch {
      return forward("The project's marks could not be read.", kind, undefined, similar);
    }
    if (markedNow) return forward(markedNow.reason, kind, markedNow.part, similar);
    const failing = quotePart >= 0 ? quotePart : undefined;
    const needsQuote = callNeedsQuote;
    if (needsQuote) {
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

  /** The project's live send grants as of now; none when they cannot be read. */
  private liveGrants(call: ApprovalWatchCall): SendGrant[] {
    const now = (this.deps.now ?? Date.now)();
    try {
      return call.grants().filter((g) => isGrantLive(g, now));
    } catch {
      return [];
    }
  }

  /**
   * Auto (P13-26; design 2026-11-18-auto-approves-all §4.2), in this order: a mark forwards; a
   * request that only touches files (`LOCAL_ONLY_CATEGORIES`, no opaque part) is approved
   * without the judge; else the judge, in `grants` mode, says whether it sends or spends. Not a
   * send → approved; a grant still live when the verdict arrives → approved with it; the user's
   * own words (a quote the server finds) → approved for this call; else held. A failed check
   * holds too. The switch or Auto turned off, or a mark added, while judged → forwarded.
   */
  private async decideAuto(
    call: ApprovalWatchCall,
    parts: CommandPart[],
    shown: CommandPart[],
    forward: (reason: string, kind: string, failingPart?: number) => void,
    unjudged: string,
  ): Promise<void> {
    let marked: ReturnType<typeof markForward>;
    try {
      marked = markForward(call, parts);
    } catch {
      return forward("The project's marks could not be read.", unjudged);
    }
    if (marked) return forward(marked.reason, unjudged, marked.part);

    let whole: ReturnType<typeof classifyToolCall> | undefined;
    try {
      whole = classifyToolCall(call.toolCall, call.ctx);
    } catch {
      whole = undefined;
    }
    const categories = [...new Set([...call.categories, ...(whole?.actions ?? [])])];
    const localOnly = (cs: readonly PermissionAction[]) =>
      cs.length > 0 && cs.every((c) => LOCAL_ONLY_CATEGORIES.has(c));
    if (
      whole !== undefined &&
      whole.unclassified !== true &&
      parts.length > 0 &&
      parts.every((p) => p.opaque === undefined && localOnly(p.categories)) &&
      localOnly(categories) &&
      onlyFileWork(
        call.toolCall,
        parts,
        programFolderTest(
          call.ctx,
          'pathEnv' in this.deps ? this.deps.pathEnv : process.env['PATH'],
          this.deps.caseInsensitivePaths ?? process.platform === 'darwin',
        ),
      )
    ) {
      if (!call.active()) return;
      call.approve({
        reason: 'Auto: it only reads or changes files.',
        allowedBy: 'auto',
        parts: shown,
      });
      return;
    }

    const hold = (summary: string) => {
      if (!call.active()) return;
      call.hold({ summary: redactSecrets(summary), parts: shown, grants: this.liveGrants(call) });
    };
    const judge = this.deps.judge;
    if (!judge) return hold(UNCHECKED_SEND_SUMMARY);
    let facts: ApprovalFacts | undefined;
    try {
      facts = call.facts();
    } catch {
      facts = undefined;
    }
    if (!facts) return hold(UNCHECKED_SEND_SUMMARY);
    const known = facts;

    const input: RequestJudgeInput = {
      mode: 'grants',
      grants: this.liveGrants(call),
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
        categories,
        parts: shown,
      },
    };
    const outcome = await this.calls.run(call.agentId, (signal) => judge.judge(input, signal));
    if (outcome === 'cancelled' || !call.active()) return;
    const verdict = outcome.ok ? validVerdict(outcome.value, parts.length, 'grants') : undefined;
    const kind = verdict?.kind ?? unjudged;

    // -- changes while it was judged: as in task mode, a card -----------------------------------
    if (!call.switchOn()) {
      return forward('Waykeeper approvals were turned off while the request was judged.', kind);
    }
    if (!call.auto()) {
      return forward('Auto mode was turned off while the request was judged.', kind);
    }
    let markedNow: ReturnType<typeof markForward>;
    try {
      markedNow = markForward(call, parts);
    } catch {
      return forward("The project's marks could not be read.", kind);
    }
    if (markedNow) return forward(markedNow.reason, kind, markedNow.part);

    if (!verdict) return hold(UNCHECKED_SEND_SUMMARY);
    const reason = redactSecrets(verdict.reason);
    if (verdict.sendsOrSpends !== true) {
      call.approve({ reason, allowedBy: 'auto', parts: shown });
      return;
    }
    const grantId = verdict.grantId;
    if (grantId !== undefined && this.liveGrants(call).some((g) => g.id === grantId)) {
      call.approve({ reason, allowedBy: 'grant', grantId, parts: shown });
      return;
    }
    if (verdict.quote !== undefined && quoteFound(verdict.quote, known.userWords)) {
      call.approve({ reason, allowedBy: 'task_words', quote: verdict.quote, parts: shown });
      return;
    }
    hold(verdict.summary || verdict.kind || verdict.reason);
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
  if (mode !== 'task' && typeof v.sendsOrSpends !== 'boolean') return undefined;
  if (v.grantId !== undefined && typeof v.grantId !== 'string') return undefined;
  if (v.summary !== undefined && typeof v.summary !== 'string') return undefined;
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
    ...(typeof v.grantId === 'string' ? { grantId: v.grantId } : {}),
    ...(typeof v.summary === 'string' && v.summary.trim()
      ? { summary: v.summary.trim().slice(0, 200) }
      : {}),
  };
}
