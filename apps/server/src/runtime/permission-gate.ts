import { realpathSync } from 'node:fs';
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
 * The one place a permission is decided (P2-04): adapters call it from their hooks, and the
 * runtime calls it again (`reserve: false`) for an `agent.needs_input(kind: permission)` before
 * any question is opened, so the hook and the question path can never disagree.
 *
 * The policy is read on every check (`policy` may be a function): a change to the project's
 * table applies to the next tool call of agents already running.
 *
 * Pure apart from the cap counter and `onDeny`: no I/O, no LLM (SPEC decision 7).
 */
export interface GateOptions {
  agentId: Id;
  /**
   * The project's policy, or a function returning the current one (read on every check); parsed
   * here with the protocol schema, so a bad value cannot allow.
   */
  policy: unknown;
  /**
   * The project workspace root that "inside" is measured against, or a function returning the
   * current one (read on every check, like the policy: a moved workspace applies at once).
   */
  workspace: string | (() => string);
  /** Where the agent resolves relative paths from (its worktree). */
  cwd: string;
  caps: CapsEnforcer;
  /**
   * The server's own tools handed to a brain (`SpawnOptions.tools`, P2-06): their handlers run in
   * the server against `DomainCommands`, which refuses what the brain may not do, so the policy
   * table (about files, shells and the network) has nothing to say about them. Allowed after the
   * tool-call cap; matched by bare name or as the SDK's `mcp__galactic__<name>`.
   */
  serverTools?: readonly string[];
  /**
   * Told about every refusal the gate makes on its own — the policy table, a check that failed —
   * but not about a tool-call cap refusal, which the cap logs as the agent's failure. The runtime
   * logs these as `permission.decided{deny}` (P2-04). Must not throw (a throw is swallowed).
   */
  onDeny?: (
    call: ToolCall,
    verdict: Extract<GateVerdict, { decision: 'deny' }>,
    action: PermissionAction | undefined,
  ) => void;
}

/** The MCP server name the Claude SDK adapter registers brain tools under. */
export const SERVER_TOOL_PREFIX = 'mcp__galactic__';

/** Every action asks: what the gate falls back to when the policy does not parse. */
export const FAIL_CLOSED_POLICY: PermissionPolicy = {
  rules: Object.fromEntries(PermissionAction.options.map((a) => [a, 'ask'])),
};

export function createPermissionGate(opts: GateOptions): RuntimeGate {
  const current = typeof opts.policy === 'function' ? (opts.policy as () => unknown) : undefined;
  let lastRaw: unknown = Symbol('unset');
  let policy: PermissionPolicy = FAIL_CLOSED_POLICY;
  let policyNote: string | undefined;
  /** The policy as of now, parsed once per distinct value. */
  const policyNow = () => {
    const raw = current ? current() : opts.policy;
    if (raw !== lastRaw) {
      lastRaw = raw;
      const parsed = PermissionPolicy.safeParse(raw);
      policy = parsed.success ? parsed.data : FAIL_CLOSED_POLICY;
      policyNote = parsed.success ? undefined : 'the project policy is invalid: every action asks';
    }
    return policy;
  };
  const workspaceNow = () =>
    typeof opts.workspace === 'function' ? opts.workspace() : opts.workspace;
  const serverTools = new Set(opts.serverTools ?? []);
  const isServerTool = (name: string) =>
    serverTools.has(name) ||
    (name.startsWith(SERVER_TOOL_PREFIX) && serverTools.has(name.slice(SERVER_TOOL_PREFIX.length)));
  /** The verdict, plus the category behind a denial (the gate's verdict does not carry it). */
  const decideCall = (call: ToolCall, reserve: boolean): Decision => {
    if (reserve) {
      const reserved = opts.caps.reserveToolCall(opts.agentId);
      if (!reserved.ok)
        return { verdict: { decision: 'deny', reason: reserved.reason }, cap: true };
    }
    if (isServerTool(call.toolName)) return { verdict: { decision: 'allow' } };
    const workspace = workspaceNow();
    const misplaced = misplacedCwd(workspace, opts.cwd);
    if (misplaced) return { verdict: { decision: 'ask', reasons: [misplaced] } };
    const verdict = evaluate(policyNow(), call, {
      workspace,
      cwd: opts.cwd,
      aliases: aliasesOf(workspace, opts.cwd),
    });
    const action = verdict.dominant ? { action: verdict.dominant } : {};
    switch (verdict.decision) {
      case 'allow':
        return { verdict: { decision: 'allow' }, ...action };
      case 'deny':
        return {
          verdict: {
            decision: 'deny',
            reason:
              verdict.reasons[0] ?? `${verdict.dominant ?? 'this action'} is denied by policy`,
          },
          ...action,
        };
      case 'ask': {
        const reasons = policyNote ? [policyNote, ...verdict.reasons] : verdict.reasons;
        return { verdict: { decision: 'ask', ...action, reasons }, ...action };
      }
      default:
        return { verdict: { decision: 'deny', reason: 'permission check failed: no decision' } };
    }
  };
  const safely = (call: ToolCall, reserve: boolean): Decision => {
    try {
      return decideCall(call, reserve);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { verdict: { decision: 'deny', reason: `permission check failed: ${message}` } };
    }
  };

  return {
    check(call: ToolCall, options?: GateCheckOptions): GateVerdict {
      const decision = safely(call, options?.reserve ?? true);
      const { verdict } = decision;
      if (verdict.decision === 'deny' && !decision.cap && opts.onDeny) {
        try {
          opts.onDeny(call, verdict, decision.action);
        } catch {
          // Logging a refusal never turns it into something else.
        }
      }
      return verdict;
    },
    decide(call: ToolCall): Decision {
      return safely(call, false);
    },
  };
}

/** What the gate decided about one call, with what the runtime logs beside the verdict. */
export interface Decision {
  verdict: GateVerdict;
  /** The policy category behind the verdict, when one was recognised. */
  action?: PermissionAction;
  /** A refusal for the tool-call cap (logged as the agent's failure, not as a permission). */
  cap?: true;
}

/**
 * The gate as the runtime holds it: the adapters' `check()`, plus `decide()` — the same decision
 * without the cap reservation and without `onDeny` — for a permission request that reached the
 * runtime (P2-04).
 */
export interface RuntimeGate extends PermissionGate {
  decide(call: ToolCall): Decision;
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

/**
 * The resolved spellings of the workspace and the cwd, when they differ from the given ones (a
 * symlink on the way: macOS `/var` → `/private/var`, a symlinked projects folder). Claude Code
 * resolves its cwd, so it names resolved paths; the engine judges them as the given ones. The cwd
 * comes first, so a worktree inside the workspace maps to itself. A path that does not exist (yet)
 * has no other spelling.
 */
function aliasesOf(workspace: string, cwd: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const given of [resolve(cwd), resolve(workspace)]) {
    let real: string;
    try {
      real = realpathSync(given);
    } catch {
      continue;
    }
    if (real !== given && !out.some((a) => a.from === real)) out.push({ from: real, to: given });
  }
  return out;
}
