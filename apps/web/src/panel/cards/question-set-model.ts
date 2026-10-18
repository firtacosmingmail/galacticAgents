import {
  checkSetAnswer,
  draftOf,
  type Agent,
  type AnswerSetBody,
  type Id,
  type Question,
  type SetAnswer,
} from '@galactic/protocol';

/**
 * The question-set card's model (P8-21, SPEC decision 141), pure: which rows are pages to answer,
 * where a returning user resumes, whether the set can be sent and what the send carries. A set is
 * N ordinary question rows sharing `context.set` (`questionSetRows` orders them).
 */

/** The user's local answers per row (seeded from `meta.draft`). */
export type SetDrafts = Record<Id, SetAnswer | undefined>;

/**
 * The card's pages: the open rows (to answer, one page each), and the rows a supervisor answered
 * from context (decision 12) — shown read-only on the review page, already delivered.
 */
export function pagesOf(rows: Question[]): {
  asking: Question[];
  answeredBySupervisor: Question[];
} {
  return {
    asking: rows.filter((q) => q.status === 'open'),
    answeredBySupervisor: rows.filter(
      (q) => q.status === 'answered' && q.answeredBy?.type === 'agent',
    ),
  };
}

/** Whether a draft says something: a skip, a choice or some written text. */
export function isAnswered(d: SetAnswer | undefined): d is SetAnswer {
  return !!d && (d.skipped === true || d.choices.length > 0 || (d.text?.trim() ?? '') !== '');
}

/** Whether a row's draft can be sent: a skip, or an answer that fits the question. */
export function isValid(q: Question, d: SetAnswer | undefined): boolean {
  return isAnswered(d) && checkSetAnswer(q, d) === undefined;
}

/** The page a returning user resumes on: the first open row without a draft, else the review. */
export function resumeIndex(rows: Question[], drafts: SetDrafts): number {
  const { asking } = pagesOf(rows);
  const i = asking.findIndex((q) => !isAnswered(drafts[q.id]));
  return i === -1 ? asking.length : i;
}

/** Every row to answer has a valid answer or a skip (the server refuses a partial send). */
export function canSend(asking: Question[], drafts: SetDrafts): boolean {
  return asking.length > 0 && asking.every((q) => isValid(q, drafts[q.id]));
}

/** How many answers the send carries (skips are not counted): "Send N answers". */
export function sendCount(asking: Question[], drafts: SetDrafts): number {
  return asking.filter((q) => isAnswered(drafts[q.id]) && !drafts[q.id]!.skipped).length;
}

/** A draft as it is sent: a skip is only a skip; written text trimmed, empty dropped. */
export function normalised(d: SetAnswer): SetAnswer {
  if (d.skipped) return { choices: [], skipped: true };
  const text = d.text?.trim() ?? '';
  return { choices: d.choices, ...(text ? { text } : {}) };
}

/** The send's body: one entry per row to answer, with the version the card shows. */
export function toAnswers(asking: Question[], drafts: SetDrafts): AnswerSetBody['answers'] {
  return asking.map((q) => ({
    questionId: q.id,
    version: q.version,
    answer: normalised(drafts[q.id] ?? { choices: [] }),
  }));
}

/**
 * An option pressed: on a single-choice row it becomes the choice (pressed again, it is
 * cleared); on a multi-select row it toggles. Choosing un-skips and keeps the written text.
 */
export function toggleChoice(q: Question, d: SetAnswer | undefined, option: string): SetAnswer {
  const choices = d?.choices ?? [];
  const has = choices.includes(option);
  const next = q.context.multiSelect
    ? has
      ? choices.filter((c) => c !== option)
      : [...choices, option]
    : has
      ? []
      : [option];
  return { choices: next, ...(d?.text !== undefined ? { text: d.text } : {}) };
}

/** The drafts the server keeps for the rows (`meta.draft`). */
export function serverDrafts(rows: Question[]): SetDrafts {
  return Object.fromEntries(rows.map((q) => [q.id, draftOf(q)]));
}

/** A stable key of a draft, to compare two of them. */
export const draftKey = (d: SetAnswer | undefined): string =>
  isAnswered(d) ? JSON.stringify(forDraft(d)) : '';

/**
 * A draft as it is saved: what the user chose and wrote is kept even on a skipped row (the skip
 * wins on send, `normalised`), so Back shows it again — on this device or another.
 */
export function forDraft(d: SetAnswer): SetAnswer {
  const text = d.text?.trim() ?? '';
  return { choices: d.choices, ...(text ? { text } : {}), ...(d.skipped ? { skipped: true } : {}) };
}

/** The row skipped, keeping what was chosen and written. */
export const skipped = (d: SetAnswer | undefined): SetAnswer => ({
  ...d,
  choices: d?.choices ?? [],
  skipped: true,
});

/** Open questions in order, each set's rows as one entry at its first row (P8-21). */
export type QuestionOrSet = { kind: 'question'; question: Question } | { kind: 'set'; setId: Id };

export function groupBySet(questions: Question[]): QuestionOrSet[] {
  const seen = new Set<Id>();
  const out: QuestionOrSet[] = [];
  for (const question of questions) {
    const set = question.context.set;
    if (!set) out.push({ kind: 'question', question });
    else if (!seen.has(set.id)) {
      seen.add(set.id);
      out.push({ kind: 'set', setId: set.id });
    }
  }
  return out;
}

/**
 * Who the set came to the user through ("via …"). The store does not keep a row's holder
 * history, so it is inferred: an open row's `version` counts its holder changes (drafts do not
 * bump it), and a set climbs its asker's supervisor chain one living level at a time — so a row
 * at version v passed the first v supervisors up the chain. Any agent that answered a row is
 * named too (it held the set). Supervisors first, nearest first.
 */
export function viaAgentIds(rows: Question[], agents: Record<Id, Agent>): Id[] {
  const first = rows[0];
  if (!first) return [];
  const ids: Id[] = [];
  const hops = Math.max(0, ...rows.filter((q) => q.status === 'open').map((q) => q.version));
  let agent = agents[first.originAgentId];
  for (let i = 0; i < hops && agent?.supervisorId; i++) {
    const next: Agent | undefined = agents[agent.supervisorId];
    if (!next || ids.includes(next.id)) break;
    ids.push(next.id);
    agent = next;
  }
  for (const q of rows) {
    const by = q.answeredBy;
    if (q.status === 'answered' && by?.type === 'agent' && by.id && !ids.includes(by.id)) {
      if (by.id !== first.originAgentId) ids.push(by.id);
    }
  }
  return ids;
}
