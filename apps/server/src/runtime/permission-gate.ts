import type {
  GateVerdict,
  Id,
  PermissionGate,
  PermissionPolicy,
  ToolCall,
} from '@galactic/protocol';
import { evaluate } from '../domain/permissions.js';
import type { CapsEnforcer } from './caps.js';

/**
 * The permission gate handed to adapters in `SpawnOptions.gate` (P1-18; TECHNOLOGY §3.1). One
 * implementation for every runtime: the tool-call cap is checked first (a refused call also
 * trips the cap, see `CapsEnforcer.reserveToolCall`), then the project's policy table decides.
 * Adapters never see the policy or the caps; they call `check()` from their permission hook and
 * turn `ask` into `agent.needs_input(kind: permission)`.
 *
 * Pure apart from the cap counter: no I/O, no LLM (SPEC decision 7).
 */
export interface GateOptions {
  agentId: Id;
  policy: PermissionPolicy;
  /** The project workspace root that "inside" is measured against. */
  workspace: string;
  /** Where the agent resolves relative paths from (its worktree). */
  cwd: string;
  caps: CapsEnforcer;
}

export function createPermissionGate(opts: GateOptions): PermissionGate {
  const ctx = { workspace: opts.workspace, cwd: opts.cwd };
  return {
    check(call: ToolCall): GateVerdict {
      const reserved = opts.caps.reserveToolCall(opts.agentId);
      if (!reserved.ok) return { decision: 'deny', reason: reserved.reason };
      const verdict = evaluate(opts.policy, call, ctx);
      switch (verdict.decision) {
        case 'allow':
          return { decision: 'allow' };
        case 'deny':
          return {
            decision: 'deny',
            reason:
              verdict.reasons[0] ?? `${verdict.dominant ?? 'this action'} is denied by policy`,
          };
        case 'ask':
          return {
            decision: 'ask',
            ...(verdict.dominant ? { action: verdict.dominant } : {}),
            reasons: verdict.reasons,
          };
      }
    },
  };
}
