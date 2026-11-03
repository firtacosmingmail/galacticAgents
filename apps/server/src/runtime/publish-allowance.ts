import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Id, PermissionAction, PublishContext, ToolCall } from '@galactic/protocol';
import { sha256 } from '../domain/publish.js';

/**
 * The one-shot allowance an approved publish arms (P11-06, plan Task 7; SPEC decision 147). A
 * publishing run works without a job's unattended rules, so every outward call asks; the user's
 * "Approve" on the publish card lets that agent's next call the policy table asks about for the
 * network, carrying the approved text (or, with no text, naming an approved file — ruling R15),
 * through once — as long as every approved file still has the hash that was approved (a
 * changed file disarms it: the call asks, and a fresh publish request brings a fresh card). An
 * allowance lasts 30 minutes and ends with its agent. The gate consults it (`allowOnce`) only
 * where the table says `ask`, so it never turns a deny into an allow.
 */

/** How long an armed allowance waits for its call. */
export const PUBLISH_ALLOWANCE_TTL_MS = 30 * 60_000;

interface Armed {
  publish: PublishContext;
  worktree: string;
  at: number;
}

export interface PublishAllowanceOptions {
  /** A file's bytes (tests); default the file system. */
  readFile?: (abs: string) => Buffer;
  /** Milliseconds now (tests); default `Date.now`. */
  now?: () => number;
}

export class PublishAllowanceStore {
  private readonly armed = new Map<Id, Armed>();
  private readonly readFile: (abs: string) => Buffer;
  private readonly now: () => number;

  constructor(opts: PublishAllowanceOptions = {}) {
    this.readFile = opts.readFile ?? ((abs) => readFileSync(abs));
    this.now = opts.now ?? Date.now;
  }

  /** Arms (or re-arms) the agent's allowance for `publish`, its files read from `worktree`. */
  arm(agentId: Id, publish: PublishContext, worktree: string): void {
    this.armed.set(agentId, { publish, worktree, at: this.now() });
  }

  /**
   * `allow` exactly once: for the first call the table asks about whose every category is
   * `network` and that carries the approved content (ruling R15, `carriesContent`: a string
   * value of its input holds the approved text of at least 12 characters — verbatim, JSON-escaped
   * or URL-encoded — or, with no or a shorter text, names an approved file as a whole path
   * token), while the allowance is armed and fresh and every file still matches
   * its approved hash. A mismatch (or a file gone) disarms it; any other call leaves it armed and
   * asks as usual. `none` otherwise.
   */
  check(agentId: Id, call: ToolCall, categories: PermissionAction[]): 'allow' | 'none' {
    const entry = this.armed.get(agentId);
    if (!entry) return 'none';
    if (this.now() - entry.at > PUBLISH_ALLOWANCE_TTL_MS) {
      this.armed.delete(agentId);
      return 'none';
    }
    if (categories.length === 0 || !categories.every((c) => c === 'network')) return 'none';
    if (!carriesContent(call, entry)) return 'none';
    this.armed.delete(agentId);
    return this.filesMatch(entry) ? 'allow' : 'none';
  }

  disarm(agentId: Id): void {
    this.armed.delete(agentId);
  }

  /** Whether the agent has a fresh allowance armed. */
  isArmed(agentId: Id): boolean {
    const entry = this.armed.get(agentId);
    return entry !== undefined && this.now() - entry.at <= PUBLISH_ALLOWANCE_TTL_MS;
  }

  private filesMatch(entry: Armed): boolean {
    return entry.publish.files.every((f) => {
      try {
        return sha256(this.readFile(resolve(entry.worktree, f.path))) === f.sha256;
      } catch {
        return false;
      }
    });
  }
}

/** The shortest approved text matched in a call: a shorter one is a substring of almost anything. */
export const MIN_MATCHED_TEXT = 12;

/** Every string value inside a tool call's input, recursively — never its keys or serialization. */
function stringValues(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 20) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(input, 0);
  return out;
}

/** The forms the approved text may take in a call: verbatim, JSON-escaped, URL-encoded. */
function textForms(text: string): string[] {
  const uri = encodeURIComponent(text);
  return [...new Set([text, JSON.stringify(text).slice(1, -1), uri, uri.replace(/%20/g, '+')])];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `path` as a whole token of `value`: bounded by start/end, whitespace, quotes, `=` or `@`. */
function hasPathToken(value: string, path: string): boolean {
  if (path === '') return false;
  return new RegExp(`(?:^|[\\s"'=@])${escapeRegExp(path)}(?:$|[\\s"'])`).test(value);
}

/**
 * Whether the call carries the approved content (rulings R15, round 2), judged on the input's
 * string values only: the approved text in one of its forms when it is at least
 * `MIN_MATCHED_TEXT` characters; else (no text, or a short one) one of the approved files named
 * as a whole path token, worktree-relative or absolute. Anything else asks as usual.
 */
function carriesContent(call: ToolCall, entry: Armed): boolean {
  const values = stringValues(call.input);
  const { text, files } = entry.publish;
  if (text.trim().length >= MIN_MATCHED_TEXT) {
    return textForms(text).some((form) => values.some((v) => v.includes(form)));
  }
  return files.some((f) =>
    [f.path, resolve(entry.worktree, f.path)].some((p) => values.some((v) => hasPathToken(v, p))),
  );
}
