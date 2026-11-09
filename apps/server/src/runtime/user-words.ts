import type { Agent, Id } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';

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
export type EventLogReader = Pick<EventLog, 'tables' | 'latestOf'>;

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
 *   - his answers (`answeredBy` the user) to questions of the project's agents;
 *   - his last `HARMONIZER_WINDOW` messages to the Harmonizer before the project's proposal.
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
  const messagesTo = (agentId: Id, limit: number, until?: string): Said[] =>
    log
      .latestOf('message.sent', agentId, limit, until)
      .flatMap(({ seq, at, event }) =>
        event.type === 'message.sent' && event.sender.type === 'user' && event.text.trim()
          ? [{ at, seq, text: event.text }]
          : [],
      );
  for (const a of [...stewards, ...waykeepers]) {
    said.push(...messagesTo(a.id, SCAN_LIMIT));
  }

  const asking = new Set(agents.filter(inProject).map((a) => a.id));
  for (const q of tables.questions.all()) {
    if (
      q.status === 'answered' &&
      q.answeredBy?.type === 'user' &&
      typeof q.answer === 'string' &&
      q.answer.trim() &&
      asking.has(q.originAgentId)
    ) {
      said.push({ at: q.updatedAt, seq: Number.MAX_SAFE_INTEGER, text: q.answer });
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

const byTime = (said: Said[]): Said[] =>
  [...said].sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));
