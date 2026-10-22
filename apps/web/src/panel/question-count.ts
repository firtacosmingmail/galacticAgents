import type { Question } from '@galactic/protocol';
import { setOf } from '@galactic/protocol';

/**
 * Open questions as the user sees them (P8-22, SPEC decision 141): a question set counts once, as
 * the inbox shows it — once per holder side when some of its rows are still with a supervisor and
 * the rest reached the user. `sets` holds each counted set's number of questions.
 */
export interface QuestionItems {
  singles: number;
  sets: number[];
}

export function questionItems(questions: readonly Question[]): QuestionItems {
  let singles = 0;
  const sets = new Map<string, number>();
  for (const q of questions) {
    const set = setOf(q);
    if (!set) {
      singles++;
      continue;
    }
    const key = `${set.id} ${q.holder.type === 'user' ? 'user' : 'supervisor'}`;
    sets.set(key, (sets.get(key) ?? 0) + 1);
  }
  return { singles, sets: [...sets.values()] };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "1 open question", "3 open questions", "1 question set · 3 questions", "2 question sets",
 * "1 open question + 1 question set"; empty when there are none.
 */
export function openQuestionsLabel({ singles, sets }: QuestionItems): string {
  const single = singles > 0 ? plural(singles, 'open question', 'open questions') : '';
  if (sets.length === 0) return single;
  if (singles === 0 && sets.length === 1)
    return `1 question set · ${plural(sets[0]!, 'question', 'questions')}`;
  const set = plural(sets.length, 'question set', 'question sets');
  return single ? `${single} + ${set}` : set;
}
