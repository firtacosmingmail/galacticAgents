import type { Id, Question, QuestionKind } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { agentLabel } from '../../console/hierarchy/shared.js';
import { bodyName, headquartersBody } from '../picking/body-action.js';
import { oneLine } from '../picking/satellite-card.js';

/**
 * The question beacons as data (P4-05, P4-13; SPEC §4.1 "a body with an open question for the user
 * carries a visible beacon", §2.6, decisions 55, 58, 74). No three.js, no React: the renderer
 * (`Beacons.tsx`), picking and the hover card read what this returns.
 *
 * - **Which questions:** open (`status === 'open'`) and held by the user (`holder.type === 'user'`)
 *   — the inbox's "Waiting for you" questions (decision 58). A clarification a supervisor still
 *   holds is not the user's yet; one escalated to the user lights up, and goes dark once it is
 *   answered, cancelled (withdrawn, its agent ended) or reassigned away from the user.
 * - **Which body:** the body of the asking agent's work (`questionBody`): a Steward's task's body
 *   (a project task lives on its project's planet, decision 9), a Waykeeper's project's body, the
 *   Harmonizer's headquarters (Earth). Falls back to the agent's own `bodyId`, then to the
 *   question's recorded origin (task, project, body) when the agent is not loaded.
 * - **One beacon per question** (P4-13, Cosmin's answer to P4-05's "one per body"): each has its
 *   own glyph and its own lifecycle, keyed by the question's id. Several on one body stand side by
 *   side in a row above it (`slot` of `slots`, laid out by `beacon-look.ts`), in the inbox's order:
 *   permissions first, then clarifications, each oldest first. At most `MAX_BEACONS_PER_BODY` per
 *   body: past that, the last one carries a "+n" badge for the questions without a beacon of their
 *   own (`more`), which the inbox lists after it.
 */
export interface BeaconSpec {
  questionId: Id;
  bodyId: Id;
  kind: QuestionKind;
  /** Its place in its body's row, from 0 (the inbox's order). */
  slot: number;
  /** How many beacons stand on its body. */
  slots: number;
  /** Questions on its body without a beacon of their own (only on the last beacon of a full row). */
  more: number;
}

/** The most beacons one body carries side by side; further questions show as "+n" on the last. */
export const MAX_BEACONS_PER_BODY = 6;

/**
 * What the beacons read. Not the status records: they change many times a second (every status
 * flush) and the only thing beacons need from them is which Harmonizer is the current one, whose
 * body is headquarters — `hqBodyId` (`beaconHq`: a string, so a store selector over it re-renders
 * only when headquarters moves). Without it, the newest Harmonizer's body.
 */
export type BeaconWorld = Pick<
  WorldState,
  'questions' | 'agents' | 'tasks' | 'projects' | 'bodies'
> & {
  hqBodyId?: Id;
};

/** Headquarters' body for the beacons: the current Harmonizer's (it reads the status records). */
export const beaconHq = (world: Pick<WorldState, 'agents' | 'statuses'>): Id =>
  headquartersBody(world);

const NO_STATUSES: WorldState['statuses'] = {};
const hqOf = (world: Pick<BeaconWorld, 'agents' | 'hqBodyId'>): Id =>
  world.hqBodyId ?? headquartersBody({ agents: world.agents, statuses: NO_STATUSES });

/** Whether a question lights a beacon: open and held by the user. */
export function waitsForUser(q: Question): boolean {
  return q.status === 'open' && q.holder.type === 'user';
}

/** The body a question belongs to in the scene (see above); `undefined` when none is known. */
export function questionBody(
  world: Pick<BeaconWorld, 'agents' | 'tasks' | 'projects' | 'hqBodyId'>,
  q: Question,
): Id | undefined {
  const agent = world.agents[q.originAgentId];
  if (agent) {
    if (agent.role === 'harmonizer') return hqOf(world);
    if (agent.role === 'waykeeper') {
      const project = agent.projectId ? world.projects[agent.projectId] : undefined;
      return project?.bodyId ?? agent.bodyId;
    }
    const task = agent.taskId ? world.tasks[agent.taskId] : undefined;
    return task?.bodyId ?? agent.bodyId;
  }
  const origin = q.context.origin;
  if (!origin) return undefined;
  if (origin.role === 'harmonizer') return hqOf(world);
  const task = origin.taskId ? world.tasks[origin.taskId] : undefined;
  if (task) return task.bodyId;
  const project = origin.projectId ? world.projects[origin.projectId] : undefined;
  return project?.bodyId ?? origin.bodyId;
}

/** The inbox's order (decision 58): permissions first, then clarifications; each oldest first. */
function inboxOrder(a: Question, b: Question): number {
  const rank = (q: Question) => (q.kind === 'permission' ? 0 : 1);
  return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Every beacon of the world: bodies in id order, each body's beacons in the inbox's order (a stable
 * order for the renderer: the same questions always get the same slots).
 */
export function beaconList(world: BeaconWorld): BeaconSpec[] {
  const byBody = new Map<Id, Question[]>();
  for (const q of Object.values(world.questions)) {
    if (!waitsForUser(q)) continue;
    const bodyId = questionBody(world, q);
    if (!bodyId) continue;
    const list = byBody.get(bodyId);
    if (list) list.push(q);
    else byBody.set(bodyId, [q]);
  }
  return [...byBody.keys()].sort().flatMap((bodyId) => {
    const questions = byBody.get(bodyId)!.sort(inboxOrder);
    const shown = questions.slice(0, MAX_BEACONS_PER_BODY);
    const more = questions.length - shown.length;
    return shown.map<BeaconSpec>((q, slot) => ({
      questionId: q.id,
      bodyId,
      kind: q.kind,
      slot,
      slots: shown.length,
      more: slot === shown.length - 1 ? more : 0,
    }));
  });
}

/** The beacon of one question, if it has one. */
export function beaconFor(world: BeaconWorld, questionId: Id): BeaconSpec | undefined {
  return beaconList(world).find((b) => b.questionId === questionId);
}

/** Whether two beacon lists draw the same (same questions, bodies, kinds and places). */
export function sameBeacons(a: readonly BeaconSpec[], b: readonly BeaconSpec[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.questionId === y.questionId &&
      x.bodyId === y.bodyId &&
      x.kind === y.kind &&
      x.slot === y.slot &&
      x.slots === y.slots &&
      x.more === y.more
    );
  });
}

/** What hovering a beacon says: its question, who asks, and the "+n" of a full row's last one. */
export interface BeaconCard {
  bodyId: Id;
  /** The body's name ("Jupiter"). */
  where: string;
  /** "Permission" or "Question" (a clarification). */
  heading: string;
  kind: QuestionKind;
  /** The question's text on one line, shortened. */
  text: string;
  /** Who asks, as the panel names it ("Steward · Fix the date test"). */
  asker: string;
  /** Questions on this body without a beacon of their own (the "+n" badge). */
  more: number;
  questionId: Id;
}

/** The question text's length on the hover card before it is cut. */
export const CARD_TEXT_CHARS = 80;

/** The hover card of one question's beacon; `undefined` when it has none (any more). */
export function beaconCard(world: BeaconWorld, questionId: Id): BeaconCard | undefined {
  const beacon = beaconFor(world, questionId);
  const q = world.questions[questionId];
  if (!beacon || !q) return undefined;
  return {
    bodyId: beacon.bodyId,
    where: bodyName(world, beacon.bodyId),
    heading: q.kind === 'permission' ? 'Permission' : 'Question',
    kind: q.kind,
    text: oneLine(q.context.text, CARD_TEXT_CHARS),
    asker: agentLabel(world.agents[q.originAgentId], world),
    more: beacon.more,
    questionId: q.id,
  };
}
