import type {
  AgentLaunch,
  Id,
  LaunchFlag,
  OffScriptContext,
  ScopeJudge,
  ScopeVerdict,
  ToolCall,
} from '@galactic/protocol';
import { redactSecrets, redactValue } from './redact.js';

/** How long the scope judge may take before the call counts as off-script (P12-06). */
export const SCOPE_JUDGE_TIMEOUT_MS = 20_000;

/** The longest precedent kept in `meta.launch.precedents`. */
export const MAX_PRECEDENT_CHARS = 300;

/**
 * One flag-tool call of a flagged Steward, as the runtime hands it to the watch. The call stays
 * blocked in the adapter meanwhile; the runtime's callbacks answer it (`consistent`) or ask the
 * user (`offScript`).
 */
export interface ScopeWatchCall {
  agentId: Id;
  flag: LaunchFlag;
  /** The raw call: the watch redacts it before the judge sees it. */
  toolCall: ToolCall;
  /** The Steward's approved launch (`launchOf(row)`) as of the call. */
  launch: AgentLaunch | undefined;
  /** False once the agent ended or is stopping: a verdict then does nothing. */
  active: () => boolean;
  consistent: (reason: string) => void;
  offScript: (context: OffScriptContext) => void;
}

/**
 * What a user-approved off-script call adds to the Steward's precedents: the tool name and a
 * one-line summary of the redacted input, at most `MAX_PRECEDENT_CHARS` long.
 */
export function precedentOf(call: ToolCall): string {
  if (call.input === undefined) return call.toolName.slice(0, MAX_PRECEDENT_CHARS);
  const summary = redactSecrets(JSON.stringify(redactValue(call.input)) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const line = summary ? `${call.toolName} ${summary}` : call.toolName;
  return line.length <= MAX_PRECEDENT_CHARS ? line : `${line.slice(0, MAX_PRECEDENT_CHARS - 1)}…`;
}

const offScript = (reason: string): ScopeVerdict => ({ verdict: 'off_script', reason });

/**
 * The runtime scope watch (P12-06; design 2026-11-05-steward-launch-flags §5.4–5.6): every call
 * of a launch flag's tools is judged against what the user approved, under a timeout the judge
 * itself does not have. Fails closed: no judge, an error, a timeout or a malformed verdict is
 * `off_script`. Never answers the adapter itself and never pauses the agent: the runtime's
 * callbacks do, and only while the agent is still active.
 */
export class ScopeWatch {
  private readonly running = new Map<Id, Set<AbortController>>();
  /** Checks `cancel` withdrew — told apart from a timeout, which also aborts the controller. */
  private readonly cancelled = new WeakSet<AbortController>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: { judge: ScopeJudge | undefined; timeoutMs?: number }) {
    this.timeoutMs = deps.timeoutMs ?? SCOPE_JUDGE_TIMEOUT_MS;
  }

  /** Judge calls still waiting for their verdict. */
  get inFlight(): number {
    let n = 0;
    for (const set of this.running.values()) n += set.size;
    return n;
  }

  async handle(call: ScopeWatchCall): Promise<void> {
    const controller = new AbortController();
    let set = this.running.get(call.agentId);
    if (!set) this.running.set(call.agentId, (set = new Set()));
    set.add(controller);
    let verdict: ScopeVerdict | undefined;
    try {
      verdict = await this.judge(call, controller);
    } finally {
      set.delete(controller);
      if (set.size === 0 && this.running.get(call.agentId) === set) {
        this.running.delete(call.agentId);
      }
    }
    // Cancelled (the agent ended, or its call was withdrawn), or the agent is stopping meanwhile.
    // A verdict that settled just before `cancel` (the call withdrawn, the agent idle or ended)
    // does nothing: the agent is no longer waiting on this call.
    if (!verdict || this.cancelled.has(controller) || !call.active()) return;
    // The judge read the (redacted) call; its reason may still quote a secret.
    const reason = redactSecrets(verdict.reason);
    if (verdict.verdict === 'consistent') {
      call.consistent(reason);
      return;
    }
    call.offScript({
      flag: call.flag,
      expectedUse: call.launch?.expectedUse ?? '',
      precedents: [...(call.launch?.precedents ?? [])],
      judgeReason: reason,
    });
  }

  /** Aborts every judge call of `agentId`: their verdicts do nothing. */
  cancel(agentId: Id): void {
    const set = this.running.get(agentId);
    if (!set) return;
    this.running.delete(agentId);
    for (const controller of set) {
      this.cancelled.add(controller);
      controller.abort(new Error('the agent ended or its call was withdrawn'));
    }
  }

  /** The verdict, or `undefined` when the check was cancelled. */
  private judge(
    call: ScopeWatchCall,
    controller: AbortController,
  ): Promise<ScopeVerdict | undefined> {
    const judge = this.deps.judge;
    if (!judge) return Promise.resolve(offScript('no scope judge is configured'));
    const input = {
      flag: call.flag,
      expectedUse: call.launch?.expectedUse ?? '',
      precedents: [...(call.launch?.precedents ?? [])],
      toolCall: {
        toolName: call.toolCall.toolName,
        ...(call.toolCall.input !== undefined ? { input: redactValue(call.toolCall.input) } : {}),
      },
    };
    const seconds = Math.round(this.timeoutMs / 1000);
    return new Promise<ScopeVerdict | undefined>((resolve) => {
      const settle = (verdict: ScopeVerdict | undefined) => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        resolve(verdict);
      };
      // A cancel settles at once: a judge that ignores its signal must not keep the call held.
      const onAbort = () => settle(undefined);
      controller.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        settle(offScript(`the check took longer than ${seconds} s`));
        controller.abort(new Error('scope check timed out'));
      }, this.timeoutMs);
      let pending: Promise<ScopeVerdict>;
      try {
        pending = judge.judge(input, controller.signal);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (verdict) => settle(validVerdict(verdict)),
        (error: unknown) =>
          settle(
            offScript(
              `the check failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
      );
    });
  }
}

function validVerdict(verdict: unknown): ScopeVerdict {
  const v = verdict as Partial<ScopeVerdict> | undefined;
  const reason = typeof v?.reason === 'string' ? v.reason : '';
  if (v?.verdict === 'consistent') return { verdict: 'consistent', reason };
  if (v?.verdict === 'off_script') return offScript(reason || 'off script');
  return offScript('the check gave no verdict');
}
