import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Id, PermissionAction, PublishContext, ToolCall } from '@galactic/protocol';
import { sha256 } from '../domain/publish.js';

/**
 * The one-shot allowance an approved publish arms (P11-06, plan Task 7; SPEC decision 147). A
 * publishing run works without a job's unattended rules, so every outward call asks; the user's
 * "Approve" on the publish card lets that agent's next call the policy table asks about for the
 * network through once — as long as every approved file still has the hash that was approved (a
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
   * `network`, while the allowance is armed and fresh and every file still matches its approved
   * hash. A mismatch (or a file gone) disarms it; any other call leaves it armed. `none` otherwise.
   */
  check(agentId: Id, _call: ToolCall, categories: PermissionAction[]): 'allow' | 'none' {
    const entry = this.armed.get(agentId);
    if (!entry) return 'none';
    if (this.now() - entry.at > PUBLISH_ALLOWANCE_TTL_MS) {
      this.armed.delete(agentId);
      return 'none';
    }
    if (categories.length === 0 || !categories.every((c) => c === 'network')) return 'none';
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
