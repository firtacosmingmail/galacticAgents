import { z } from 'zod';
import { Id } from './primitives.js';
import { QuestionKind } from './enums.js';

/**
 * The scene harness (P4-06): development-only routes under `/dev/harness/*` (registered only with
 * `GALACTIC_DEV=1`, bearer-guarded and refused to remote clients) that drive the scene through the
 * real event log — the states, activities, moves, completions and questions an agent would cause —
 * without running any agent process. The `/debug` console's "Scene harness" tab calls them.
 *
 * Everything the harness creates (projects, tasks, fake agents) carries `meta.harness: true`, so
 * "clear" archives exactly that, recovery never reopens a fake agent, and a fake agent never goes
 * `stalled` on its own (it has no process to fall silent).
 */

/** The key of the `meta` flag on every row the harness created. */
export const HARNESS_META_KEY = 'harness';

/** Whether a row's `meta` marks it as made by the scene harness. */
export function isHarnessMeta(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[HARNESS_META_KEY] === true;
}

/** The agent states the harness can put an agent in (every `AgentState` but `interrupted`). */
export const HARNESS_STATES = [
  'starting',
  'working',
  'idle',
  'waiting_for_input',
  'paused',
  'stalled',
  'finished',
  'failed',
  'stopped',
] as const;
export const HarnessState = z.enum(HARNESS_STATES);
export type HarnessState = z.infer<typeof HarnessState>;

/** Activity presets: one tool call per Steward archetype (P4-03), `none` for a neutral one. */
export const HARNESS_ACTIVITIES = ['gathering', 'transporting', 'building', 'none'] as const;
export const HarnessActivity = z.enum(HARNESS_ACTIVITIES);
export type HarnessActivity = z.infer<typeof HarnessActivity>;

/** `POST /dev/harness/agents/:id/state`. `activity`: the progress line of a `working` agent. */
export const HarnessStateBody = z.object({
  state: HarnessState,
  activity: z.string().trim().min(1).max(200).optional(),
});
export type HarnessStateBody = z.infer<typeof HarnessStateBody>;

/** `POST /dev/harness/agents/:id/activity`: a preset tool call, or a free progress line. */
export const HarnessActivityBody = z
  .object({
    preset: HarnessActivity.optional(),
    text: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => (b.preset === undefined) !== (b.text === undefined), {
    message: 'give a preset or a text',
  });
export type HarnessActivityBody = z.infer<typeof HarnessActivityBody>;

/**
 * `POST /dev/harness/scenario`: a project (on `bodyId`, or a free body of `kind`) with a fake
 * Waykeeper and `stewards` project tasks each with a fake Steward, plus (with `asteroid`) a
 * standalone task on a fresh asteroid with its own Steward — ready to be moved into the project.
 */
export const HarnessScenarioBody = z.object({
  stewards: z.number().int().min(0).max(8).default(2),
  kind: z.enum(['planet', 'moon']).default('planet'),
  bodyId: Id.optional(),
  asteroid: z.boolean().default(true),
});
export type HarnessScenarioBody = z.input<typeof HarnessScenarioBody>;

export interface HarnessScenarioResponse {
  seq: number;
  projectId: Id;
  bodyId: Id;
  waykeeperId: Id;
  taskIds: Id[];
  stewardIds: Id[];
  asteroidTaskId?: Id;
  asteroidStewardId?: Id;
}

/**
 * `POST /dev/harness/agents`: a fake agent with no process. A Waykeeper for `projectId`; a Steward
 * for `taskId`, or for a new task in `projectId`, or (neither) for a new standalone task on a
 * fresh asteroid.
 */
export const HarnessAgentBody = z.object({
  role: z.enum(['waykeeper', 'steward']),
  projectId: Id.optional(),
  taskId: Id.optional(),
});
export type HarnessAgentBody = z.infer<typeof HarnessAgentBody>;

export interface HarnessAgentResponse {
  seq: number;
  agentId: Id;
  taskId?: Id;
}

/**
 * `POST /dev/harness/agents/:id/question`: the agent asks. A permission goes to the user (the
 * runtime's path: `agent.needs_input`); a clarification is opened for the user too (`toUser`), so
 * it shows in the inbox and as a beacon whoever supervises the agent.
 */
export const HarnessQuestionBody = z.object({
  kind: QuestionKind,
  text: z.string().trim().min(1).max(300).optional(),
});
export type HarnessQuestionBody = z.infer<typeof HarnessQuestionBody>;

/** `POST /dev/harness/questions/:id/answer`. */
export const HarnessAnswerBody = z.object({ answer: z.string().trim().min(1).max(300).optional() });
export type HarnessAnswerBody = z.infer<typeof HarnessAnswerBody>;

/** `POST /dev/harness/tasks/:id/move`: a standalone task joins a project. */
export const HarnessMoveBody = z.object({ projectId: Id });
export type HarnessMoveBody = z.infer<typeof HarnessMoveBody>;

/** What a harness action did: the last event's `seq` (0 when nothing was logged). */
export interface HarnessActionResponse {
  seq: number;
  questionId?: Id;
}

/** `GET /dev/harness`: what the harness made that is still around. */
export interface HarnessListResponse {
  projects: Id[];
  tasks: Id[];
  agents: Id[];
}

/** `POST /dev/harness/clear`: fake agents ended, tasks and projects archived. */
export interface HarnessClearResponse {
  seq: number;
  stopped: Id[];
  tasks: Id[];
  projects: Id[];
  /** What could not be cleared and why (e.g. a harness project holding a real, open task). */
  skipped: { id: Id; reason: string }[];
}
