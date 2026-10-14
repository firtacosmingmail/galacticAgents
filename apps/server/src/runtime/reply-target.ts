import type { Database } from 'better-sqlite3';
import {
  excerpt,
  parseReplyEntryId,
  proposalPlan,
  REPLY_QUOTE_MAX,
  threadShowsProposal,
  threadShowsQuestion,
  type Actor,
  type Event,
  type Id,
  type Question,
  type ReplyQuote,
  type ReplyRef,
  type ThreadLookup,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { redactSecrets } from './redact.js';
import { readCompaction } from './transcript-retention.js';

/**
 * Resolves what a reply quotes (P8-17; SPEC decision 139) from the log and the tables — never from
 * the client's text. The target must be a line or a card of the chat with `agentId`, as the panel
 * shows it:
 *
 * - `message`: a `message.sent` to the agent (not a brain's turn prompt), by `messageId`;
 * - `reply`: a non-blank `text` chunk of the agent's own transcript (`r:<agentId>:<chunkSeq>`) —
 *   one that transcript retention removed is `gone` (409), not unknown;
 * - `question` / `proposal`: a card the agent's thread shows (`threadShowsQuestion`,
 *   `threadShowsProposal`: the same rules as the panel's `threadCards`).
 *
 * Anything else — unknown, another agent's, a turn prompt — is refused (400 `reply_target`). The
 * quote is capped at `REPLY_QUOTE_MAX` characters and redacted like any text leaving the server
 * (agent text already was when it was logged; the user's own text was not).
 */
export type ReplyTarget =
  | { ok: true; quote: ReplyQuote; question?: Question }
  | { ok: false; status: 400 | 409; error: 'reply_target' | 'reply_target_gone'; message: string };

const refused = (message: string): ReplyTarget => ({
  ok: false,
  status: 400,
  error: 'reply_target',
  message,
});

export function resolveReplyTarget(
  db: Database,
  tables: Tables,
  agentId: Id,
  ref: ReplyRef,
): ReplyTarget {
  const agent = tables.agents.get(agentId);
  if (!agent) return refused(`There is no agent ${agentId} to reply in the chat of.`);
  const quote = (sender: Actor, text: string): ReplyQuote => ({
    kind: ref.kind,
    id: ref.id,
    sender,
    text: excerpt(redactSecrets(text), REPLY_QUOTE_MAX),
  });
  const lookup: ThreadLookup = {
    agent: (id) => tables.agents.get(id),
    task: (id) => tables.tasks.get(id),
  };
  switch (ref.kind) {
    case 'message': {
      // Through migration 0007's `events_message_agent_at`: this agent's messages only.
      const row = db
        .prepare(
          `SELECT payload FROM events
            WHERE type = 'message.sent' AND json_extract(payload, '$.agentId') = ?
              AND json_extract(payload, '$.messageId') = ?
            LIMIT 1`,
        )
        .get(agentId, ref.id) as { payload: string } | undefined;
      const event = row ? (JSON.parse(row.payload) as Event) : undefined;
      if (event?.type !== 'message.sent' || event.turn) {
        return refused(`Message ${ref.id} is not in this chat.`);
      }
      return { ok: true, quote: quote(event.sender, event.text) };
    }
    case 'reply': {
      const parsed = parseReplyEntryId(ref.id);
      if (!parsed || parsed.agentId !== agentId) {
        return refused(`Reply ${ref.id} is not in this chat.`);
      }
      const row = db
        .prepare(`SELECT chunk FROM transcript_chunks WHERE agent_id = ? AND seq = ?`)
        .get(agentId, parsed.chunkSeq) as { chunk: string } | undefined;
      if (!row) {
        const compacted = readCompaction(db, agentId);
        if (compacted && parsed.chunkSeq <= compacted.throughSeq) {
          return {
            ok: false,
            status: 409,
            error: 'reply_target_gone',
            message: 'The reply is no longer in the history (transcript retention removed it).',
          };
        }
        return refused(`Reply ${ref.id} is not in this chat.`);
      }
      let chunk: { kind?: unknown; text?: unknown };
      try {
        chunk = JSON.parse(row.chunk) as typeof chunk;
      } catch {
        return refused(`Reply ${ref.id} is not in this chat.`);
      }
      if (chunk.kind !== 'text' || typeof chunk.text !== 'string' || chunk.text.trim() === '') {
        return refused(`Reply ${ref.id} is not in this chat.`);
      }
      return { ok: true, quote: quote({ type: 'agent', id: agentId }, chunk.text) };
    }
    case 'question': {
      const question = tables.questions.get(ref.id);
      if (!question || !threadShowsQuestion(lookup, agent, question)) {
        return refused(`Question ${ref.id} is not in this chat.`);
      }
      return {
        ok: true,
        quote: quote({ type: 'agent', id: question.originAgentId }, question.context.text),
        question,
      };
    }
    case 'proposal': {
      const proposal = tables.proposals.get(ref.id);
      if (!proposal || !threadShowsProposal(agent, proposal)) {
        return refused(`Proposal ${ref.id} is not in this chat.`);
      }
      // A plan card is its Waykeeper's; any other card was proposed by the chat's brain.
      const by = proposalPlan(proposal)?.waykeeperId ?? agentId;
      return { ok: true, quote: quote({ type: 'agent', id: by }, proposal.requestText) };
    }
  }
}

/**
 * The message of `agentId`'s chat that answered `questionId` by replying to it (P8-17 review): a
 * clarification is answered once, so at most one `message.sent` carries `replyTo.answered` for
 * it. A retry of a reply whose answer was recorded under its `answerId` returns this message
 * instead of logging the same line again; none (the first send failed after the answer) → the
 * retry sends it.
 */
export function answeredReplyOf(db: Database, agentId: Id, questionId: Id): Id | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.messageId') AS messageId FROM events
        WHERE type = 'message.sent' AND json_extract(payload, '$.agentId') = ?
          AND json_extract(payload, '$.replyTo.kind') = 'question'
          AND json_extract(payload, '$.replyTo.id') = ?
          AND json_extract(payload, '$.replyTo.answered') = 1
        LIMIT 1`,
    )
    .get(agentId, questionId) as { messageId: string } | undefined;
  return row?.messageId;
}
