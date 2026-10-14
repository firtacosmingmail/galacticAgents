import { z } from 'zod';
import { Id } from './primitives.js';
import {
  Actor,
  proposalPlan,
  proposalPromotion,
  type Agent,
  type Proposal,
  type Question,
  type Task,
} from './domain.js';

// ---------------------------------------------------------------------------
// Replies in a chat (P8-17; SPEC decision 139): the user's message may quote one line of the
// conversation it is sent in — a message, an agent's reply, a question or proposal card — as a
// messaging app does. No sub-thread: the message is an ordinary `message.sent` that carries the
// quote. The server resolves what was quoted from the log and never trusts a client's text.
// ---------------------------------------------------------------------------

/** What a reply may quote: a line or a card of the chat it is sent in. */
export const ReplyTargetKind = z.enum(['message', 'reply', 'question', 'proposal']);
export type ReplyTargetKind = z.infer<typeof ReplyTargetKind>;

/**
 * `SendBody.replyTo`: the line the user replies to. `id` is a `messageId` (`message`), a
 * conversation entry's id `r:<agentId>:<chunkSeq>` (`reply`, an agent's text reply), a
 * `questionId` or a `proposalId`. `version` and `answerId` matter only for an open clarification,
 * which the reply answers: as the card's answer button (P2-18's stale check, P7-05's idempotency).
 */
export const ReplyRef = z.object({
  kind: ReplyTargetKind,
  id: Id,
  version: z.number().int().nonnegative().optional(),
  answerId: z.string().min(1).max(100).optional(),
});
export type ReplyRef = z.infer<typeof ReplyRef>;

/** The longest quote a message stores (characters, with the "…" that marks a cut). */
export const REPLY_QUOTE_MAX = 2_000;

/** `text` cut to `max` characters, ending in "…" when it was longer. */
export function excerpt(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * `message.sent.replyTo` (and `ChatMessage.replyTo`, `ConversationEntry.replyTo`): what the
 * message quotes, as the server resolved it when it was sent — `sender` wrote the quoted line
 * (the asking agent of a question, the proposing brain of a proposal), `text` is the quote (at
 * most `REPLY_QUOTE_MAX` characters, secrets redacted). `answered`: the reply answered that
 * (clarification) question.
 */
export const ReplyQuote = z.object({
  kind: ReplyTargetKind,
  id: Id,
  sender: Actor,
  text: z.string().max(REPLY_QUOTE_MAX),
  answered: z.literal(true).optional(),
});
export type ReplyQuote = z.infer<typeof ReplyQuote>;

/** The id a conversation's reply entry has: `r:<agentId>:<chunkSeq>`. */
export function parseReplyEntryId(id: string): { agentId: Id; chunkSeq: number } | undefined {
  const m = /^r:(.+):(\d+)$/.exec(id);
  if (!m) return undefined;
  const chunkSeq = Number(m[2]);
  return Number.isSafeInteger(chunkSeq) && chunkSeq > 0 ? { agentId: m[1]!, chunkSeq } : undefined;
}

// --- which cards a brain's thread shows (decisions 52, 55) -----------------------------------

/** Row lookups the thread rules need: the client's world, or the server's tables. */
export interface ThreadLookup {
  agent(id: Id): Agent | undefined;
  task(id: Id): Task | undefined;
}

/**
 * Whose thread a question belongs to, by role and project (never by `supervisorId`, so a
 * replacement Waykeeper inherits its predecessor's Stewards' questions, decision 32 — the same
 * rule as the plan cards and the managed-agents cards): the project's Waykeeper for a question
 * asked on a project (by its Waykeeper or by a Steward of one of its tasks), the Harmonizer for
 * its own and for a standalone task's Steward.
 */
export type QuestionOwner = { role: 'harmonizer' } | { role: 'waykeeper'; projectId: Id };

export function questionOwner(look: ThreadLookup, q: Question): QuestionOwner | undefined {
  const origin = look.agent(q.originAgentId);
  if (!origin) return undefined;
  if (origin.role === 'harmonizer') return { role: 'harmonizer' };
  if (origin.role === 'waykeeper')
    return origin.projectId ? { role: 'waykeeper', projectId: origin.projectId } : undefined;
  const taskId = origin.taskId ?? q.context.origin?.taskId;
  const task = taskId ? look.task(taskId) : undefined;
  const projectId = task ? task.projectId : q.context.origin?.projectId;
  return projectId ? { role: 'waykeeper', projectId } : { role: 'harmonizer' };
}

/**
 * A project's clarification that reached the user — held by them now, or answered by them. It
 * shows in the Harmonizer's thread as well as its project's (decision 55): the Harmonizer is the
 * user's single contact, so what it passed on is visible there; it is the same card in both, so
 * an answer in one resolves the other. Permission questions go to the user directly and stay in
 * the inbox and the project's thread.
 */
function reachedUser(q: Question): boolean {
  return q.kind === 'clarification' && (q.holder.type === 'user' || q.answeredBy?.type === 'user');
}

/** The question's card shows in `agent`'s chat. */
export function threadShowsQuestion(look: ThreadLookup, agent: Agent, q: Question): boolean {
  if (agent.role === 'steward') return false;
  const owner = questionOwner(look, q);
  if (!owner) return false;
  return owner.role === 'harmonizer'
    ? agent.role === 'harmonizer'
    : (agent.role === 'waykeeper' && agent.projectId === owner.projectId) ||
        (agent.role === 'harmonizer' && reachedUser(q));
}

/**
 * The proposal's card shows in `agent`'s chat: a Waykeeper's project's plan cards and promotion
 * requests (a successor on the same project owns them too); every other card is the Harmonizer's.
 */
export function threadShowsProposal(agent: Agent, p: Proposal): boolean {
  if (agent.role === 'steward') return false;
  const project = proposalPlan(p)?.projectId ?? proposalPromotion(p)?.fromProjectId;
  return agent.role === 'waykeeper'
    ? project !== undefined && project === agent.projectId
    : project === undefined;
}
