import { isAbsolute, relative, resolve } from 'node:path';
import {
  type GateCheckOptions,
  type GateVerdict,
  type Id,
  PermissionAction,
  type PermissionGate,
  PermissionPolicy,
  type ToolCall,
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
 * Fail closed (P1-30): `check()` never throws — an exception becomes `deny`; a policy that does
 * not parse is replaced by one that asks for every action; a cwd outside the workspace (or a
 * workspace at the file-system root) makes every call `ask`, because lexical "inside" checks
 * would be meaningless there.
 *
 * Pure apart from the cap counter: no I/O, no LLM (SPEC decision 7).
 */
export interface GateOptions {
  agentId: Id;
  /** The project's policy; parsed here with the protocol schema, so a bad value cannot allow. */
  policy: unknown;
  /** The project workspace root that "inside" is measured against. */
  workspace: string;
  /** Where the agent resolves relative paths from (its worktree). */
  cwd: string;
  caps: CapsEnforcer;
}

/** Every action asks: what the gate falls back to when the policy does not parse. */
export const FAIL_CLOSED_POLICY: PermissionPolicy = {
  rules: Object.fromEntries(PermissionAction.options.map((a) => [a, 'ask'])),
};

export function createPermissionGate(opts: GateOptions): PermissionGate {
  const parsed = PermissionPolicy.safeParse(opts.policy);
  const policy = parsed.success ? parsed.data : FAIL_CLOSED_POLICY;
  const policyNote = parsed.success
    ? undefined
    : 'the project policy is invalid: every action asks';
  const misplaced = misplacedCwd(opts.workspace, opts.cwd);
  const ctx = { workspace: opts.workspace, cwd: opts.cwd };

  const decideCall = (call: ToolCall, reserve: boolean): GateVerdict => {
    if (reserve) {
      const reserved = opts.caps.reserveToolCall(opts.agentId);
      if (!reserved.ok) return { decision: 'deny', reason: reserved.reason };
    }
    if (misplaced) return { decision: 'ask', reasons: [misplaced] };
    const verdict = evaluate(policy, call, ctx);
    switch (verdict.decision) {
      case 'allow':
        return { decision: 'allow' };
      case 'deny':
        return {
          decision: 'deny',
          reason: verdict.reasons[0] ?? `${verdict.dominant ?? 'this action'} is denied by policy`,
        };
      case 'ask': {
        const reasons = policyNote ? [policyNote, ...verdict.reasons] : verdict.reasons;
        return {
          decision: 'ask',
          ...(verdict.dominant ? { action: verdict.dominant } : {}),
          reasons,
        };
      }
      default:
        return { decision: 'deny', reason: 'permission check failed: no decision' };
    }
  };

  return {
    check(call: ToolCall, options?: GateCheckOptions): GateVerdict {
      try {
        return decideCall(call, options?.reserve ?? true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { decision: 'deny', reason: `permission check failed: ${message}` };
      }
    },
  };
}

/**
 * Why `cwd` cannot be judged against `workspace`, or `undefined` when it can: the cwd must
 * resolve inside the workspace (lexically), and the workspace must not be the file-system root.
 */
function misplacedCwd(workspace: string, cwd: string): string | undefined {
  if (!isAbsolute(workspace)) return `workspace ${workspace} is not an absolute path`;
  const root = resolve(workspace);
  if (resolve(root, '..') === root) return `workspace ${workspace} is the file-system root`;
  const rel = relative(root, resolve(root, cwd));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    return `cwd ${cwd} is outside the workspace ${workspace}`;
  }
  return undefined;
}
