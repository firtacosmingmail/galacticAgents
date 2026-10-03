import type { Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { WorldState } from '../../state/reduce.js';
import { pickingWorld } from '../picking/fixtures.js';

/**
 * Questions for the beacons' tests (P4-05), over picking's world (`pickingWorld`: Earth with the
 * Harmonizer `a-h`, Jupiter with project `p-big` and its Waykeepers `a-wk-old` / `a-wk-new` and
 * project-task Steward `a-st-in`, asteroid `b-ast-7` with Steward `a-st`).
 */
export function question(
  id: string,
  originAgentId: string,
  opts: Partial<Pick<Question, 'kind' | 'status' | 'holder' | 'createdAt'>> & {
    text?: string;
  } = {},
): Question {
  return {
    ...fx.question,
    id,
    originAgentId,
    kind: opts.kind ?? 'clarification',
    status: opts.status ?? 'open',
    holder: opts.holder ?? { type: 'user' },
    context: { text: opts.text ?? `question ${id}` },
    createdAt: opts.createdAt ?? fx.question.createdAt,
  };
}

export function worldWith(...questions: Question[]): WorldState {
  return {
    ...pickingWorld(),
    questions: Object.fromEntries(questions.map((q) => [q.id, q])),
  };
}
