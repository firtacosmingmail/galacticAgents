import type {
  AgentLaunch,
  Id,
  LaunchFlag,
  OffScriptContext,
  ScopeJudge,
  ScopeVerdict,
  ToolCall,
} from '@galactic/protocol';
import { HeldJudgeCalls } from './held-judge.js';
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
  private readonly calls: HeldJudgeCalls;

  constructor(private readonly deps: { judge: ScopeJudge | undefined; timeoutMs?: number }) {
    this.calls = new HeldJudgeCalls(deps.timeoutMs ?? SCOPE_JUDGE_TIMEOUT_MS);
  }

  /** Judge calls still waiting for their verdict. */
  get inFlight(): number {
    return this.calls.inFlight;
  }

  async handle(call: ScopeWatchCall): Promise<void> {
    const verdict = await this.judge(call);
    if (!verdict || !call.active()) return;
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
    this.calls.cancel(agentId);
  }

  /** The verdict, or `undefined` when the check was cancelled. */
  private async judge(call: ScopeWatchCall): Promise<ScopeVerdict | undefined> {
    const judge = this.deps.judge;
    if (!judge) return offScript('no scope judge is configured');
    const input = {
      flag: call.flag,
      expectedUse: call.launch?.expectedUse ?? '',
      precedents: [...(call.launch?.precedents ?? [])],
      toolCall: {
        toolName: call.toolCall.toolName,
        ...(call.toolCall.input !== undefined ? { input: redactValue(call.toolCall.input) } : {}),
      },
    };
    const outcome = await this.calls.run(call.agentId, (signal) => judge.judge(input, signal));
    if (outcome === 'cancelled') return undefined;
    return outcome.ok ? validVerdict(outcome.value) : offScript(outcome.reason);
  }
}

function validVerdict(verdict: unknown): ScopeVerdict {
  const v = verdict as Partial<ScopeVerdict> | undefined;
  const reason = typeof v?.reason === 'string' ? v.reason : '';
  if (v?.verdict === 'consistent') return { verdict: 'consistent', reason };
  if (v?.verdict === 'off_script') return offScript(reason || 'off script');
  return offScript('the check gave no verdict');
}
