import {
  PICKED_OPTION_PREFIX,
  answerDetailOf,
  quoteFound,
  relayedQuestionOf,
  type Agent,
  type Id,
  type Question,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import { plainLineAnswer } from '../domain/send-grants.js';

/**
 * The user's own words that bear on a task (P13-04; design 2026-11-09-waykeeper-approvals §5.4a,
 * §6): the only text a push or an upload may be granted by. The quote check itself is the
 * protocol's `quoteFound`, shared with the request judge.
 */

/** The most entries `userWordsFor` returns (the newest). */
export const MAX_USER_WORDS = 50;
/** The longest entry `userWordsFor` returns; a longer text is cut. */
export const MAX_USER_WORD_CHARS = 2000;
/** The user's messages to the Harmonizer before the project's proposal that count. */
export const HARMONIZER_WINDOW = 5;

/**
 * How many of an agent's latest messages are read to find the user's among them: a brain's
 * mailbox also logs the system's turn prompts as messages, which crowd the user's out.
 */
const SCAN_LIMIT = 500;

/** What `userWordsFor` reads: the tables and the indexed per-agent event read. */
export type EventLogReader = Pick<EventLog, 'tables' | 'latestOf' | 'db'>;

interface Said {
  at: string;
  /** Tie-break among entries of the same time: log order where known. */
  seq: number;
  text: string;
}

/**
 * Cosmin's own text about `taskId`, newest last, at most `MAX_USER_WORDS` entries of at most
 * `MAX_USER_WORD_CHARS` characters:
 *
 *   - his messages (`message.sent` with a `user` sender) to the task's Stewards and to the
 *     project's Waykeepers;
 *   - his answers (`answeredBy` the user) to questions of the project's agents, and to the
 *     Harmonizer's questions that relay one of theirs (`relayedQuestionOf`, P13-10): what he wrote
 *     (`freeTextOf`), plus each option he picked that names a push or an upload and holds nothing
 *     back (`pickedActionsOf`; a bare "Yes" or "Hold" never counts), marked
 *     `PICKED_OPTION_PREFIX`;
 *   - his last `HARMONIZER_WINDOW` messages to the Harmonizer before the project's proposal.
 *
 * Left out (final review M1): his replies (`replyTo`) and answers to send-permission questions,
 * and (P13-33) every plain chat line the server takes as the answer to one (`plainLineAnswer`: a
 * line to a decider while that decider had exactly one open send-permission question) — however
 * that question later closes (the decider's answer, his own Allow once, the Steward stopping, a
 * refused answer) and before it is answered. Those are for the grant question alone; a denial
 * ("don't post to Instagram today") must never become task words a send is approved by, and a
 * grant's "only today" is enforced by its end time, never by a quote of the same line. The cost,
 * accepted: a new instruction typed to a decider while exactly one send card of its is open is
 * not task words either (it fails closed: a send it would cover gets a card). Likewise (P13-34)
 * his answers and replies to grant-conflict questions, and every line of his to a decider that one
 * of its grant-conflict questions quotes as his new words: how far a send may go is settled by that
 * question and its grants alone.
 *
 * Nothing an agent wrote counts — not a brief, a plan, a task description or an agent's answer.
 * Never throws: whatever cannot be read counts as no words (a push then goes to the user).
 */
export function userWordsFor(log: EventLogReader, taskId: Id): string[] {
  try {
    return collect(log, taskId);
  } catch {
    return [];
  }
}

function collect(log: EventLogReader, taskId: Id): string[] {
  const { tables } = log;
  const task = tables.tasks.get(taskId);
  if (!task) return [];
  const projectId = task.projectId;
  const project = projectId ? tables.projects.get(projectId) : undefined;
  const agents = tables.agents.all();
  const inProject = (a: Agent) =>
    projectId !== undefined &&
    (a.projectId === projectId ||
      (a.taskId !== undefined && tables.tasks.get(a.taskId)?.projectId === projectId));
  const stewards = agents.filter((a) => a.role === 'steward' && a.taskId === taskId);
  const waykeepers = projectId
    ? agents.filter((a) => a.role === 'waykeeper' && a.projectId === projectId)
    : [];

  const said: Said[] = [];
  /**
   * A send-permission question (Auto), or a grant-conflict question (P13-34): his reply to it is
   * for its grants, never a task word.
   */
  const isGrantQuestion = (id: Id) => {
    const context = tables.questions.get(id)?.context;
    return context?.sendPermission !== undefined || context?.grantConflict !== undefined;
  };
  const conflicts = tables.questions.all().flatMap((q) => q.context.grantConflict ?? []);
  const messagesTo = (agentId: Id, limit: number, until?: string): Said[] => {
    /** A plain line the server takes as a send-permission answer (P13-33): that answer's alone. */
    const answers = plainLineAnswer(log.db, agentId);
    /** His words a grant-conflict question of this decider quotes (P13-34): that question's alone. */
    const quoted = conflicts.filter((c) => c.deciderId === agentId).map((c) => c.newWords);
    return log
      .latestOf('message.sent', agentId, limit, until)
      .flatMap(({ seq, at, event }) =>
        event.type === 'message.sent' &&
        event.sender.type === 'user' &&
        event.text.trim() &&
        !(event.replyTo?.kind === 'question' && isGrantQuestion(event.replyTo.id)) &&
        !(event.replyTo?.kind !== 'question' && answers(seq, at) !== undefined) &&
        !quoted.some((words) => quoteFound(words, [event.text]))
          ? [{ at, seq, text: event.text }]
          : [],
      );
  };
  for (const a of [...stewards, ...waykeepers]) {
    said.push(...messagesTo(a.id, SCAN_LIMIT));
  }

  const asking = new Set(agents.filter(inProject).map((a) => a.id));
  const harmonizers = new Set(agents.filter((a) => a.role === 'harmonizer').map((a) => a.id));
  /** A Harmonizer's question that relays a question of the project's agents (P13-10). */
  const relaysProject = (q: Question): boolean => {
    if (!harmonizers.has(q.originAgentId)) return false;
    const relayed = relayedQuestionOf(q);
    const origin = relayed !== undefined ? tables.questions.get(relayed) : undefined;
    return origin !== undefined && asking.has(origin.originAgentId);
  };
  for (const q of tables.questions.all()) {
    if (
      q.status === 'answered' &&
      q.answeredBy?.type === 'user' &&
      typeof q.answer === 'string' &&
      q.context.sendPermission === undefined &&
      q.context.grantConflict === undefined &&
      (asking.has(q.originAgentId) || relaysProject(q))
    ) {
      const texts = [...pickedActionsOf(q, q.answer), freeTextOf(q, q.answer)];
      for (const text of texts) {
        if (text) said.push({ at: q.updatedAt, seq: Number.MAX_SAFE_INTEGER, text });
      }
    }
  }

  const proposalId = project?.meta?.['proposalId'];
  const proposal = typeof proposalId === 'string' ? tables.proposals.get(proposalId) : undefined;
  if (proposal) {
    const before = agents
      .filter((a) => a.role === 'harmonizer')
      .flatMap((a) => messagesTo(a.id, SCAN_LIMIT, proposal.createdAt));
    said.push(...byTime(before).slice(-HARMONIZER_WINDOW));
  }

  return byTime(said)
    .slice(-MAX_USER_WORDS)
    .map((s) => s.text.slice(0, MAX_USER_WORD_CHARS));
}

/**
 * Words that name an action a push or an upload performs (P13-10): an option the user picked
 * counts as his words only when it names one ("Push and post the 4 replies"), never a bare "Yes",
 * "Hold" or "Go ahead". `mentionsPush` (decision 49) reads commands, not prose, so this is its own
 * small list: push, publish, post, upload, merge, comment, reply, send, open/create/raise a PR,
 * release, deploy — in their usual inflections.
 */
const ACTION_WORDS =
  /\b(?:push(?:es|ed|ing)?|publish(?:es|ed|ing)?|post(?:s|ed|ing)?|upload(?:s|ed|ing)?|merg(?:e|es|ed|ing)|comment(?:s|ed|ing)?|repl(?:y|ies|ied|ying)|send(?:s|ing)?|sent|release(?:s|d)?|releasing|deploy(?:s|ed|ing)?|(?:open|create|raise)s?\s+(?:a\s+|the\s+)?(?:pr|pull request)s?)\b/i;

/** The marker an agent puts on its suggested option, dropped before the option counts as words. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/**
 * Words that hold an action back or negate it (P13-10 review): a picked option with one of them
 * ("Hold — do not push the branch yet", "Push only, no replies") never counts, even when it names
 * the action.
 */
const HOLDS = /\b(?:not|don'?t|do not|never|no|hold|wait|skip|cancel|stop|without)\b/i;

/** Whether `option` names a push or upload action (`ACTION_WORDS`). */
export function namesAction(option: string): boolean {
  return ACTION_WORDS.test(option);
}

/**
 * The options the user picked that name a push or upload action and hold nothing back (`HOLDS`)
 * (P13-10, Cosmin 2026-11-14), each without its " (Recommended)" marker and marked
 * `PICKED_OPTION_PREFIX` so the quote check takes it whole only: a single pick, a multi-select pick (joined by `CHOICE_JOIN`)
 * or the options before "<options> — <text>"; a question-set row's `answerDetail.choices`.
 */
function pickedActionsOf(q: Question, answer: string): string[] {
  const options = new Set((q.context.options ?? []).map((o) => o.trim()).filter(Boolean));
  if (options.size === 0) return [];
  const detail = answerDetailOf(q);
  let picked: string[];
  if (detail) {
    picked = detail.skipped ? [] : detail.choices.map((c) => c.trim());
  } else {
    const a = answer.trim();
    picked = splitOptions(a, options) ?? [];
    for (
      let at = a.indexOf(TEXT_JOIN);
      picked.length === 0 && at >= 0;
      at = a.indexOf(TEXT_JOIN, at + 1)
    ) {
      picked = splitOptions(a.slice(0, at).trim(), options) ?? [];
    }
  }
  return [
    ...new Set(
      picked
        .map((o) => o.replace(RECOMMENDED, '').trim())
        .filter((o) => namesAction(o) && !HOLDS.test(o)),
    ),
  ].map((o) => `${PICKED_OPTION_PREFIX}${o}`);
}

/** How a multi-select answer joins its choices, and its choices to its text (`renderSetAnswer`). */
const CHOICE_JOIN = ', ';
const TEXT_JOIN = ' — ';

/**
 * The part of an answer the user wrote himself: an option the asking agent offered is the agent's
 * text (final review I1) — it counts only through `pickedActionsOf`, when it names the action. An answer that is only options (one, or several joined as a
 * multi-select answer) has none; "<options> — <text>" keeps the text; anything else is kept whole.
 */
function freeTextOf(q: Question, answer: string): string | undefined {
  const options = new Set((q.context.options ?? []).map((o) => o.trim()).filter(Boolean));
  if (options.size === 0) return answer.trim() || undefined;
  const detail = answerDetailOf(q);
  if (detail) return detail.skipped ? undefined : detail.text?.trim() || undefined;
  const a = answer.trim();
  if (!a || madeOfOptions(a, options)) return undefined;
  for (let at = a.indexOf(TEXT_JOIN); at >= 0; at = a.indexOf(TEXT_JOIN, at + 1)) {
    if (madeOfOptions(a.slice(0, at).trim(), options)) {
      return a.slice(at + TEXT_JOIN.length).trim() || undefined;
    }
  }
  return a;
}

/** Whether `text` is one or more of `options` joined by `CHOICE_JOIN`. */
function madeOfOptions(text: string, options: ReadonlySet<string>): boolean {
  return splitOptions(text, options) !== undefined;
}

/** The `options` that make up `text` joined by `CHOICE_JOIN`, in order, or `undefined`. */
function splitOptions(text: string, options: ReadonlySet<string>): string[] | undefined {
  const memo = new Map<number, string[] | null>();
  const from = (i: number): string[] | null => {
    const known = memo.get(i);
    if (known !== undefined) return known;
    let found: string[] | null = null;
    for (const o of options) {
      if (!text.startsWith(o, i)) continue;
      const end = i + o.length;
      if (end === text.length) {
        found = [o];
        break;
      }
      const rest = text.startsWith(CHOICE_JOIN, end) ? from(end + CHOICE_JOIN.length) : null;
      if (rest) {
        found = [o, ...rest];
        break;
      }
    }
    memo.set(i, found);
    return found;
  };
  return text.length > 0 ? (from(0) ?? undefined) : undefined;
}

const byTime = (said: Said[]): Said[] =>
  [...said].sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));
