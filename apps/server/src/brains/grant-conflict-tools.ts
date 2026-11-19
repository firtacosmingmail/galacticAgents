import { isGrantLive, Timestamp, type Id } from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { BrainTool, BrainToolContext } from './definition.js';

/**
 * Grant conflicts (P13-34, SPEC decision 166): the decider of a scope's sends — the project's
 * Waykeeper, or the Harmonizer for standalone work — compares Cosmin's new words about what may be
 * sent with the grants in force (`list_send_grants`). On a conflict or an overlap it asks him how
 * to reconcile them (`ask_grant_conflict`: the grants are paused meanwhile), then carries out his
 * answer (`resolve_grant_conflict`). The server checks everything that matters.
 */

type Input = Record<string, unknown>;

function text(input: Input, key: string, where = ''): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError('invalid', `${where}${key} must be a non-empty string`);
  }
  return v;
}

function ids(input: Input, key: string, min: number): Id[] {
  const v = input[key] ?? [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new DomainError('invalid', `${key} must be a list of ids`);
  }
  if (v.length < min) throw new DomainError('invalid', `${key} needs at least ${min} id`);
  return v as Id[];
}

/** The scope the brain decides sends for: its project (a Waykeeper), or standalone work. */
const scopeOf = (ctx: BrainToolContext): { projectId?: Id } =>
  ctx.role === 'waykeeper' && ctx.projectId !== undefined ? { projectId: ctx.projectId } : {};

export const listSendGrantsTool: BrainTool = {
  name: 'list_send_grants',
  description:
    "Lists the send grants of your scope that have not ended (your project's, or standalone work's " +
    "for the Harmonizer): id, Cosmin's words, summary, end, and whether a grant-conflict question " +
    'has paused it. Read it before turning his words into a grant, and when he writes about what ' +
    'may be sent.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_raw, ctx) => {
    const now = Date.now();
    const grants = ctx.queries
      .sendGrants(scopeOf(ctx))
      .filter((g) => isGrantLive(g, now))
      .map((g) => ({
        id: g.id,
        words: g.words,
        summary: g.summary,
        endsAt: g.endsAt ?? 'no end',
        ...(g.pausedBy !== undefined ? { pausedBy: g.pausedBy } : {}),
      }));
    return { grants };
  },
};

export const askGrantConflictTool: BrainTool = {
  name: 'ask_grant_conflict',
  description:
    'Asks Cosmin how his new words about what may be sent fit the grants in force, when they ' +
    'conflict or overlap (narrower, wider, another end, contradicting) or you are unsure. The ' +
    'grants are paused until you carry out his answer. newWords = his exact words, copied from his ' +
    'reply on the send permission question (give sendQuestionId) or from his message to you. ' +
    'The card always offers: replace the earlier grant, keep it and ignore the new words, keep ' +
    'both; add up to 3 solutions of your own in options. Do not create a grant or act on his words ' +
    'meanwhile. Ends your turn: his answer arrives later.',
  endsTurn: true,
  inputSchema: {
    type: 'object',
    properties: {
      grantIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'The grants in force his words conflict with (list_send_grants).',
      },
      newWords: { type: 'string', description: "Cosmin's exact new words." },
      sendQuestionId: {
        type: 'string',
        description: 'The send permission question his words answered, when they did.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 solutions of your own, each one line (at most 200 characters).',
      },
    },
    required: ['grantIds', 'newWords'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = raw && typeof raw === 'object' ? (raw as Input) : {};
    const options = input['options'];
    if (
      options !== undefined &&
      (!Array.isArray(options) || options.some((o) => typeof o !== 'string'))
    ) {
      throw new DomainError('invalid', 'options must be a list of strings');
    }
    const sendQuestionId = input['sendQuestionId'];
    const { value } = await ctx.commands.askGrantConflict({
      agentId: ctx.brainId,
      grantIds: ids(input, 'grantIds', 1),
      newWords: text(input, 'newWords'),
      ...(typeof sendQuestionId === 'string' && sendQuestionId !== '' ? { sendQuestionId } : {}),
      ...(Array.isArray(options) ? { options: options as string[] } : {}),
    });
    return {
      questionId: value.id,
      status: 'asked',
      paused: value.context.grantConflict?.grants.map((g) => g.id) ?? [],
    };
  },
};

export const resolveGrantConflictTool: BrainTool = {
  name: 'resolve_grant_conflict',
  description:
    "Carries out Cosmin's answer to your grant-conflict question, only after he answered. " +
    'endGrantIds = the earlier grants his answer ends (replace: all of them; keep: none); the ' +
    'others count again. newGrant when his answer keeps the new words (replace, keep both, or a ' +
    'solution that makes one): words = his exact words, copied from the new words or his answer; ' +
    'summary = one line of what it allows; endsAt only when he gave an end ("today" → the coming ' +
    'local midnight, "this week" → the end of Sunday). Never end a grant he did not ask to end. ' +
    'When his answer is unclear, ask him in chat and do not call this yet: the grants stay paused.',
  inputSchema: {
    type: 'object',
    properties: {
      questionId: { type: 'string', description: 'Your grant-conflict question.' },
      endGrantIds: { type: 'array', items: { type: 'string' } },
      newGrant: {
        type: 'object',
        properties: {
          words: { type: 'string', description: "Cosmin's exact words." },
          summary: { type: 'string', description: 'What it allows, in one line.' },
          endsAt: {
            type: 'string',
            description:
              'When it ends, an ISO timestamp with the UTC offset of the local time you were given. ' +
              'Omit when he gave no end.',
          },
        },
        required: ['words', 'summary'],
        additionalProperties: false,
      },
    },
    required: ['questionId', 'endGrantIds'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = raw && typeof raw === 'object' ? (raw as Input) : {};
    const questionId = text(input, 'questionId');
    let newGrant: { words: string; summary: string; endsAt?: string } | undefined;
    const g = input['newGrant'];
    if (g !== undefined && g !== null) {
      if (typeof g !== 'object') throw new DomainError('invalid', 'newGrant must be an object');
      const gi = g as Input;
      const endsAt = gi['endsAt'];
      if (endsAt !== undefined && endsAt !== null && !Timestamp.safeParse(endsAt).success) {
        throw new DomainError(
          'invalid',
          'newGrant.endsAt must be an ISO timestamp with its offset',
        );
      }
      newGrant = {
        words: text(gi, 'words', 'newGrant.'),
        summary: text(gi, 'summary', 'newGrant.'),
        ...(typeof endsAt === 'string' ? { endsAt: new Date(endsAt).toISOString() } : {}),
      };
    }
    const { value } = await ctx.commands.resolveGrantConflict({
      agentId: ctx.brainId,
      questionId,
      endGrantIds: ids(input, 'endGrantIds', 0),
      ...(newGrant ? { newGrant } : {}),
    });
    const sendQuestionId = ctx.queries.question(questionId)?.context.grantConflict?.sendQuestionId;
    return {
      status: 'resolved',
      ended: value.ended,
      unpaused: value.unpaused,
      ...(sendQuestionId
        ? {
            sendQuestion:
              `${sendQuestionId} is judged again against the grants now in force; if it stays ` +
              'open, his earlier reply no longer counts: wait for a new reply or his Allow once',
          }
        : {}),
      ...(value.grant
        ? {
            grant: {
              id: value.grant.id,
              summary: value.grant.summary,
              endsAt: value.grant.endsAt ?? 'no end',
            },
          }
        : {}),
    };
  },
};

/** The decider's grant tools, beside `answer_send_permission`. */
export const GRANT_CONFLICT_TOOLS: readonly BrainTool[] = [
  listSendGrantsTool,
  askGrantConflictTool,
  resolveGrantConflictTool,
];
