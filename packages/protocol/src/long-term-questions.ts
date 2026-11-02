import { z } from 'zod';
import { Id } from './primitives.js';

/**
 * The limits and question contexts of long-term projects (P10-01; SPEC decisions 142–145) that
 * `domain.ts` needs: a leaf module so that `domain.ts` can use them without importing
 * `long-term.ts` (which needs `domain.ts`'s `PermissionRule`). Everything here is re-exported from
 * `long-term.ts`; import it from there.
 */

/** The limits of long-term projects, areas and jobs (plan Global Constraints). */
export const LONG_TERM_LIMITS = {
  maxPurpose: 2000,
  maxGoals: 10,
  maxGoal: 300,
  maxAreaName: 60,
  maxJobName: 80,
  maxInstructions: 8000,
  maxAreasPerProject: 12,
  maxJobsPerArea: 10,
  maxUnattendedRules: 10,
  /** Runs kept per job; older rows are deleted when a run is recorded. */
  runsKept: 200,
  /** Findings one run may report (`report_finding`). */
  maxFindingsPerRun: 20,
  /** A run report's `numbers`: at most this many keys, each 1–60 characters. */
  maxRunNumbers: 30,
  maxRunNumberKey: 60,
  /** A run report's summary and failure reason. */
  maxRunSummary: 2000,
  maxRunFailureReason: 500,
} as const;

/** A job run's finding brought to the user: a suggested feature or improvement, or a drafted reply. */
export const FindingContext = z.object({
  jobId: Id,
  runId: Id,
  kind: z.enum(['suggestion', 'reply']),
  title: z.string().min(1).max(200),
  /** A reply's draft, which the user may edit before "Send". */
  draft: z.string().max(8000).optional(),
});
export type FindingContext = z.infer<typeof FindingContext>;

/** The one failure question of a paused job: which run failed and why. */
export const JobFailureContext = z.object({
  jobId: Id,
  runId: Id,
  reason: z.string().min(1),
});
export type JobFailureContext = z.infer<typeof JobFailureContext>;

/** What a `spend` question asks to spend, and on whose behalf (a job's run, or a task Steward). */
export const SpendContext = z.object({
  amount: z.number().positive(),
  /** ISO 4217 code. */
  currency: z.string().length(3).default('USD'),
  purpose: z.string().min(1).max(500),
  /** Set when the asker is a job-run Steward: the question is job-owned. */
  jobId: Id.optional(),
  runId: Id.optional(),
});
export type SpendContext = z.infer<typeof SpendContext>;

/** One file of a publish request: a workspace path and the hash of its content. */
export const PublishFile = z.object({
  path: z.string().min(1).max(500),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PublishFile = z.infer<typeof PublishFile>;

/** What a `publish` question asks to publish: where, what text, which files, and its fingerprint. */
export const PublishContext = z.object({
  platform: z.string().min(1).max(80),
  account: z.string().min(1).max(120),
  text: z.string().max(8000),
  files: z.array(PublishFile).max(10),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  jobId: Id.optional(),
  runId: Id.optional(),
  taskId: Id.optional(),
});
export type PublishContext = z.infer<typeof PublishContext>;

/** The fixed answers of a `publish` question. */
export const PUBLISH_ACTIONS = ['Approve', 'Refuse'] as const;

/**
 * The fingerprint of a publish request: the hasher applied to its platform, account, text and file
 * hashes. The server passes `node:crypto`'s sha256; the web never computes it.
 */
export function publishFingerprint(
  input: { platform: string; account: string; text: string; files: PublishFile[] },
  sha256: (s: string) => string,
): string {
  return sha256(
    JSON.stringify([
      input.platform,
      input.account,
      input.text,
      input.files.map((f) => [f.path, f.sha256]),
    ]),
  );
}
