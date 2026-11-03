import type { ToolCall } from '@galactic/protocol';

/**
 * The server side of the Antigravity hook bridge (P11-05; TECHNOLOGY §3.7). `agy` runs Mission
 * Control's PreToolUse hook (`galactic-agy-hook.mjs`) before every tool call; the hook POSTs the
 * call to `POST /api/agy-hook` with the session's secret in `x-galactic-hook`, and this bridge
 * finds the session that secret belongs to and asks it (`decide`: the spawn's permission gate,
 * which may wait for the user's answer as long as the hook's timeout allows). Fail closed: an
 * unknown secret, a payload without a tool call, a `decide` that throws, and a session that ends
 * while a decision is pending all answer `deny`. The bridge never answers anything but `allow`
 * or `deny` (the hook process turns `allow` into agy's `auto_approve`, see the hook).
 *
 * The same secret also opens the session's tools to Mission Control's tool server
 * (`galactic-agy-tools.mjs` → `POST /api/agy-hook/tools`, `/api/agy-hook/call`).
 */

/** The request header that carries a session's secret. */
export const HOOK_SECRET_HEADER = 'x-galactic-hook';
/** Environment variables of an agy process Mission Control started (inherited by its hooks). */
export const SECRET_ENV = 'GALACTIC_AGY_SECRET';
export const URL_ENV = 'GALACTIC_AGY_URL';
/**
 * The hook's timeout in seconds: the longest P11-01 saw agy accept (24 h). A permission question
 * waits for the user at most this long; the hook process is killed then and agy fails closed.
 */
export const HOOK_TIMEOUT_S = 86_400;

export interface HookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

/** What a session decides about one tool call (`call` is agy's own: its tool name and args). */
export type HookDecide = (
  call: ToolCall,
  payload: Record<string, unknown>,
) => Promise<'allow' | 'deny' | HookDecision>;

/** One tool as an MCP `tools/list` entry. */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP `tools/call` result. */
export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** A session's tools as the tool server serves them. */
export interface HookTools {
  list(): McpToolSpec[];
  call(name: string, args: unknown): Promise<McpCallResult>;
}

interface Registered {
  decide: HookDecide;
  tools: HookTools | undefined;
  /** Decisions in flight: resolved `deny` when the session goes away. */
  inflight: Set<(d: HookDecision) => void>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const deny = (reason: string): HookDecision => ({ decision: 'deny', reason });

export function mcpText(text: string, isError = false): McpCallResult {
  return { content: [{ type: 'text', text }], isError };
}

export class HookBridge {
  private readonly sessions = new Map<string, Registered>();

  register(sessionSecret: string, decide: HookDecide, tools?: HookTools): void {
    if (!sessionSecret) throw new Error('a hook session needs a secret');
    this.unregister(sessionSecret);
    this.sessions.set(sessionSecret, { decide, tools, inflight: new Set() });
  }

  /** Forgets the session; decisions still pending for it answer `deny`. */
  unregister(sessionSecret: string): void {
    const s = this.sessions.get(sessionSecret);
    if (!s) return;
    this.sessions.delete(sessionSecret);
    for (const resolve of [...s.inflight]) resolve(deny('the session ended'));
  }

  /** Whether a secret belongs to a live session (tests, the route's logging). */
  has(sessionSecret: string): boolean {
    return this.sessions.has(sessionSecret);
  }

  /** One hook call: the decision for the tool call in `body` (agy's PreToolUse payload). */
  async handle(secret: string, body: unknown): Promise<HookDecision> {
    const s = typeof secret === 'string' && secret ? this.sessions.get(secret) : undefined;
    if (!s) return deny('no Mission Control session has this secret');
    const payload = asRecord(body);
    const toolCall = asRecord(payload?.['toolCall']);
    const name = toolCall?.['name'];
    if (!payload || typeof name !== 'string' || !name) {
      return deny('the hook payload names no tool call');
    }
    const call: ToolCall = { toolName: name, input: toolCall?.['args'] ?? {} };
    return new Promise<HookDecision>((resolve) => {
      let settled = false;
      const done = (d: HookDecision) => {
        if (settled) return;
        settled = true;
        s.inflight.delete(done);
        resolve(d);
      };
      s.inflight.add(done);
      Promise.resolve()
        .then(() => s.decide(call, payload))
        .then(
          (d) => done(normalize(d)),
          (error: unknown) =>
            done(deny(`permission check failed: ${(error as Error)?.message ?? String(error)}`)),
        );
    });
  }

  /** The session's tools for `tools/list`; none for an unknown secret. */
  tools(secret: string): McpToolSpec[] {
    const s = typeof secret === 'string' && secret ? this.sessions.get(secret) : undefined;
    try {
      return s?.tools?.list() ?? [];
    } catch {
      return [];
    }
  }

  /** One `tools/call`; an unknown secret or a throwing handler is an error result. */
  async callTool(secret: string, name: unknown, args: unknown): Promise<McpCallResult> {
    const s = typeof secret === 'string' && secret ? this.sessions.get(secret) : undefined;
    if (!s?.tools) return mcpText('no Mission Control session has this secret', true);
    if (typeof name !== 'string' || !name) return mcpText('tools/call names no tool', true);
    try {
      return await s.tools.call(name, args ?? {});
    } catch (error) {
      return mcpText((error as Error)?.message || String(error), true);
    }
  }
}

function normalize(d: 'allow' | 'deny' | HookDecision): HookDecision {
  if (d === 'allow') return { decision: 'allow' };
  if (d === 'deny') return { decision: 'deny' };
  if (d && d.decision === 'allow') return { decision: 'allow' };
  return { decision: 'deny', ...(d?.reason ? { reason: d.reason } : {}) };
}
