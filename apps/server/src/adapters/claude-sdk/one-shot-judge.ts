import type { SdkSurface } from './sdk-surface.js';

/**
 * What the one-shot judges (launch-flag scope, Waykeeper request) share: one model turn with no
 * tools, no settings and no MCP servers, and the data fence that keeps untrusted text apart from
 * the instructions.
 */

export type OneShotResult = { ok: true; text: string } | { ok: false; error: string };

export interface OneShotOptions {
  sdk: SdkSurface;
  model: string;
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
  /** The refusal handed to any tool call the model tries anyway. */
  denyMessage: string;
}

/** One turn, no tools; the model's text, or why there is none (an error result, a throw, an abort). */
export async function runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  const { signal } = opts;
  if (signal.aborted) return { ok: false, error: 'aborted' };
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let text = '';
    const q = opts.sdk.query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
        abortController,
        canUseTool: async () => ({ behavior: 'deny', message: opts.denyMessage }),
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const block of (m as { message: { content: { type: string; text?: string }[] } })
          .message.content) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      } else if (m.type === 'result' && (m as { is_error?: boolean }).is_error) {
        return { ok: false, error: String((m as { subtype?: string }).subtype) };
      }
    }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A `~` fence longer than any run of `~` in the body, so the body cannot close it. */
export function dataFence(body: string): string {
  const longest = Math.max(0, ...(body.match(/~+/g) ?? []).map((run) => run.length));
  return '~'.repeat(Math.max(8, longest + 1));
}

/** The JSON object a model answered, unwrapped from a code fence; undefined unless a bare object. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1]!;
  try {
    const v = JSON.parse(body) as unknown;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return undefined;
}
