import { z } from 'zod';
import { Id } from './primitives.js';
import { QuestionKind } from './enums.js';
import { isRetiredBody, type Body, type Project } from './domain.js';

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
  /**
   * P9-12: the project's folder is a real one, prepared like a user's project (a fresh folder
   * under the server's projects root, `prepareProject`): detection scans it and its commands run.
   * Without it the folder is a name under `/tmp/galactic-harness` that is never prepared.
   */
  prepare: z.boolean().default(false),
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

/**
 * `POST /dev/harness/agents/:id/declare` (P9-12): a fake Steward or Waykeeper declares a
 * deliverable for its own work through the same service an agent's `declare_deliverable` uses —
 * every rule of an agent's declaration applies.
 */
export const HarnessDeclareBody = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type HarnessDeclareBody = z.infer<typeof HarnessDeclareBody>;

/** `POST /dev/harness/questions/:id/answer`. */
export const HarnessAnswerBody = z.object({ answer: z.string().trim().min(1).max(300).optional() });
export type HarnessAnswerBody = z.infer<typeof HarnessAnswerBody>;

/** `POST /dev/harness/tasks/:id/move`: a standalone task joins a project. */
export const HarnessMoveBody = z.object({ projectId: Id });
export type HarnessMoveBody = z.infer<typeof HarnessMoveBody>;

/**
 * `POST /dev/harness/brains/waykeeper` (P8-21): a new project with a **real Waykeeper brain** on
 * the fake runtime, under the running Harmonizer — unlike a harness agent, it has a session, a
 * mailbox and turns (the fake runtime echoes each turn's prompt into its transcript).
 */
export const HarnessBrainWaykeeperBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});
export type HarnessBrainWaykeeperBody = z.infer<typeof HarnessBrainWaykeeperBody>;

export interface HarnessBrainWaykeeperResponse {
  seq: number;
  projectId: Id;
  waykeeperId: Id;
  harmonizerId: Id;
}

/**
 * `POST /dev/harness/brains/:id/tool` (P8-21): a running brain on the fake runtime calls one of
 * its tools as its model would — the same handler, context and turn rules. The fake runtime never
 * chooses a tool itself; this is how a test makes a brain act.
 */
export const HarnessBrainToolBody = z.object({
  name: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type HarnessBrainToolBody = z.input<typeof HarnessBrainToolBody>;

/** The tool's own result (a refusal is `{ error, message }`, as the model would read it). */
export interface HarnessBrainToolResponse {
  result: unknown;
}

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

// ---------------------------------------------------------------------------
// Demo work (P0-16 `/dev/seed`, P7-07)
// ---------------------------------------------------------------------------

/**
 * The key of the `meta` flag on the planet and the project `/dev/seed` makes (P7-07). A demo body
 * is never chosen or assigned for real work and is retired (`body.retired`) once its project is
 * archived; the ops console's "Clear demo projects" (`POST /dev/demo/clear`) archives every demo
 * project. Harness rows (`meta.harness`) are never demo rows: the harness has its own Clear.
 */
export const DEMO_META_KEY = 'demo';

/** The names and workspace `/dev/seed` has always used (P0-16), for rows made before the flag. */
const DEMO_PLANET_NAME = /^Demo planet \d+$/;
const DEMO_PROJECT_NAME = /^Demo project \d+$/;
const DEMO_WORKSPACE = /^\/tmp\/galactic-demo-\d+$/;

/**
 * Whether a body is a demo planet: flagged `meta.demo`, or — made before the flag (P7-07's
 * legacy rule) — a planet outside the catalogue (no parent, no `meta.orbit`, not reserved) named
 * exactly "Demo planet n". Catalogue bodies always carry `meta.orbit` (migration 0005), so none
 * ever matches.
 */
export function isDemoBody(body: Body): boolean {
  if (body.meta?.[DEMO_META_KEY] === true) return true;
  return (
    body.kind === 'planet' &&
    body.parentId === undefined &&
    typeof body.meta?.['orbit'] !== 'number' &&
    body.meta?.['reserved'] !== true &&
    DEMO_PLANET_NAME.test(body.name)
  );
}

/**
 * A body the catalogue may hand out (P7-07): a seeded planet or moon (it has a `meta.orbit`,
 * migration 0005), never a demo body (`/dev/seed`, `isDemoBody`) or a retired one. A planet or
 * moon made outside the catalogue is never chosen for real work: it would silently raise decision
 * 1's planet cap and bring a made-up planet back into the scene. One rule for both sides: the
 * server's body choice (`domain/catalogue.ts`, `domain/parking.ts`) and the proposal card's list
 * of free bodies, so the card never offers a body the server would refuse.
 */
export const isCatalogued = (body: Body): boolean =>
  typeof body.meta?.['orbit'] === 'number' && !isDemoBody(body) && !isRetiredBody(body);

/**
 * Whether a project is seeded demo work: flagged `meta.demo`, or — made before the flag — named
 * exactly "Demo project n" with `/dev/seed`'s workspace `/tmp/galactic-demo-n`. Never a harness
 * project.
 */
export function isDemoProject(project: Project): boolean {
  if (isHarnessMeta(project.meta)) return false;
  if (project.meta?.[DEMO_META_KEY] === true) return true;
  return DEMO_PROJECT_NAME.test(project.name) && DEMO_WORKSPACE.test(project.workspace);
}

/** `POST /dev/demo/clear`: what "Clear demo projects" archived and retired. */
export interface DemoClearResponse {
  seq: number;
  /** Tasks of demo projects closed (when open) and archived. */
  tasks: Id[];
  /** Demo projects closed or cancelled (when open) and archived. */
  projects: Id[];
  /** Demo bodies retired (`body.retired`): gone from the world, never reused. */
  retired: Id[];
  /** What could not be cleared and why (a demo project with a running agent, a demo body still
   * hosting real work). */
  skipped: { id: Id; reason: string }[];
}
