import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  PROVIDER_LABEL,
  PUBLISH_ACTIONS,
  PublishContext,
  publishFingerprint,
  type Id,
  type PublishFile,
  type Question,
  type RequestPublishInput,
  type SetAnswer,
} from '@galactic/protocol';
import type { Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { askerRun, unstoppedJob } from './findings.js';
import { jobOf, writeJob } from './jobs.js';
import { originOf, type QuestionRouting } from './question-service.js';
import { COMMAND_SOURCE, openQuestion } from './questions.js';

/**
 * Publish approvals (P11-06, plan Task 7; SPEC decision 147). Nothing goes out without the user's
 * approval of that exact content: a Steward asks with `request_publish` — the platform, the
 * account, the text and the files (paths in its working folder, hashed here) — and gets a
 * `publish` question held by the user alone, answered `Approve` or `Refuse`. The request's
 * fingerprint (`publishFingerprint`) binds the approval to its content: "Approve" with an edited
 * text stores the edited request with a new fingerprint (carried on `question.answered`).
 *
 * - A job run's Steward may ask on any provider: its question is job-owned and "Approve" queues
 *   a `publish` follow-up on the job; the follow-up's own provider is checked when it starts.
 * - A task Steward asks only on a publishing step (`task.publishes`) and never on Gemini (agy's
 *   actions cannot all be held back yet: `canPublish: false`); "Approve" arms the permission
 *   gate's one-shot allowance for its next network call (`PublishRelay`, `PublishAllowanceStore`).
 *
 * Phase 10's reply findings ("Send") already waiting are answered the old way (`findings.ts`).
 */

const USER = { type: 'user' } as const;

/** The approval's own word, and the refusal's. */
const APPROVE: string = PUBLISH_ACTIONS[0];

/** Runtimes that are never given a publish (global constraint: agy has `canPublish: false`). */
const CANNOT_PUBLISH = new Map([['agy', PROVIDER_LABEL.gemini]]);

/** The sha256 of a text or a file's bytes, hex — the hasher of `publishFingerprint`. */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** What `requestPublish` reads from the machine. */
export interface PublishDeps {
  /** A file's bytes; throws when it cannot be read. */
  readFile: (abs: string) => Buffer;
  /** The folder the asker works in: its task's worktree, else its project's workspace. */
  worktreeOf: (agentId: Id) => string;
}

/**
 * The folder an agent works in, from the rows: its task's worktree, else its project's workspace
 * (a job run's Steward: the project's workspace). Throws when it has neither.
 */
export function folderOfAgent(ctx: Reader, agentId: Id): string {
  const agent = must(ctx.tables.agents.get(agentId), 'agent', agentId);
  const task = agent.taskId ? ctx.tables.tasks.get(agent.taskId) : undefined;
  if (task?.worktreePath) return task.worktreePath;
  const projectId = task?.projectId ?? agent.projectId;
  const project = projectId ? ctx.tables.projects.get(projectId) : undefined;
  if (project) return project.workspace;
  const workspace = task?.meta?.['workspace'];
  if (typeof workspace === 'string' && workspace !== '') return workspace;
  throw new DomainError('invalid', `agent ${agentId} has no working folder to publish from`);
}

/** The file's path inside `root` and its hash; refused outside `root` or when it cannot be read. */
function hashedFile(path: unknown, root: string, readFile: PublishDeps['readFile']): PublishFile {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new DomainError('invalid', 'a file to publish is a path in the task’s folder');
  }
  const abs = resolve(root, path);
  const rel = relative(resolve(root), abs);
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new DomainError('invalid', `${path} is not in the task's folder`);
  }
  let bytes: Buffer;
  try {
    bytes = readFile(abs);
  } catch {
    throw new DomainError('invalid', `${path} is not in the task's folder`);
  }
  return { path: rel, sha256: sha256(bytes) };
}

/**
 * A `publish` question (SPEC decision 147), held by the user whatever the asker's supervisors and
 * answered `Approve` / `Refuse` only. Refused: an asker that is not a Steward; a task Steward on
 * Gemini or on a task that is not a publishing step; a blank platform or account; nothing to
 * publish (no text, no file); more than 10 files; a file outside the asker's folder or unreadable;
 * a run the asker is not the Steward of; a stopped job.
 */
export function requestPublish(
  ctx: CommandContext,
  input: RequestPublishInput,
  routing: Pick<QuestionRouting, 'recentEvents'> | undefined,
  deps: PublishDeps,
): Question {
  const agent = must(ctx.tables.agents.get(input.originAgentId), 'agent', input.originAgentId);
  if (agent.role !== 'steward') {
    throw new DomainError('invalid', 'only a Steward asks to publish');
  }
  const run = askerRun(ctx, agent, input.runId);
  if (run) {
    unstoppedJob(ctx, run.jobId, 'it publishes nothing more');
  } else {
    const label = CANNOT_PUBLISH.get(agent.runtime);
    if (label) throw new DomainError('invalid', `${label} cannot publish`);
    const task = agent.taskId ? ctx.tables.tasks.get(agent.taskId) : undefined;
    if (!task?.publishes) {
      throw new DomainError('invalid', 'this task is not a publishing step; ask your Waykeeper');
    }
  }
  const platform = typeof input.platform === 'string' ? input.platform.trim() : '';
  const account = typeof input.account === 'string' ? input.account.trim() : '';
  if (!platform) throw new DomainError('invalid', 'a publish names the platform');
  if (!account) throw new DomainError('invalid', 'a publish names the account');
  const text = typeof input.text === 'string' ? input.text : '';
  const paths = input.files ?? [];
  if (!Array.isArray(paths)) throw new DomainError('invalid', 'files is a list of paths');
  if (paths.length > 10) throw new DomainError('invalid', 'a publish carries at most 10 files');
  if (text.trim() === '' && paths.length === 0) {
    throw new DomainError('invalid', 'nothing to publish: give the text or the files');
  }
  const root = paths.length > 0 ? deps.worktreeOf(agent.id) : '';
  const files = paths.map((p) => hashedFile(p, root, deps.readFile));
  const content = { platform, account, text, files };
  const publish = PublishContext.safeParse({
    ...content,
    fingerprint: publishFingerprint(content, sha256),
    ...(run ? { jobId: run.jobId, runId: run.id } : agent.taskId ? { taskId: agent.taskId } : {}),
  });
  if (!publish.success) {
    throw new DomainError(
      'invalid',
      `invalid publish: ${publish.error.issues[0]?.path.join('.')} ${publish.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'publish',
    originAgentId: agent.id,
    holder: USER,
    context: {
      text: `Publish to ${platform} (${account})`,
      options: [...PUBLISH_ACTIONS],
      publish: publish.data,
      origin: originOf(ctx, agent.id, routing ?? { recentEvents: () => [] }),
    },
    // Nobody's session waits on it: a task Steward hears the answer as a message (PublishRelay).
    meta: {
      source: COMMAND_SOURCE,
      toUser: true,
      ...(run ? { jobOwned: true } : {}),
    },
  });
}

/**
 * The request as approved: on "Approve" with an edited text (`detail.text`, trimmed, not blank)
 * that differs from the asked one, the request with that text and its recomputed fingerprint;
 * `undefined` otherwise (the request stands as asked). A text over 8000 characters is refused.
 */
export function approvedPublish(
  question: Question,
  answer: string,
  detail: SetAnswer | undefined,
): PublishContext | undefined {
  const publish = question.context.publish;
  if (question.kind !== 'publish' || !publish || answer !== APPROVE) return undefined;
  const edited = detail?.text?.trim();
  if (!edited || edited === publish.text) return undefined;
  const approved = PublishContext.safeParse({
    ...publish,
    text: edited,
    fingerprint: publishFingerprint({ ...publish, text: edited }, sha256),
  });
  if (!approved.success) {
    throw new DomainError('invalid', 'the edited text is longer than 8000 characters');
  }
  return approved.data;
}

/** A job publish's answer: "Approve" queues the follow-up that publishes it; "Refuse" nothing. */
export function applyPublish(ctx: CommandContext, q: Question): void {
  const publish = q.context.publish;
  if (q.answer !== APPROVE || !publish?.jobId) return;
  const job = jobOf(ctx, publish.jobId);
  if (job.state === 'stopped') {
    throw new DomainError('invalid', 'the job is stopped; the publish was not approved');
  }
  writeJob(ctx, job, {
    followUps: [...job.followUps, { questionId: q.id, kind: 'publish', publish }],
  });
}
