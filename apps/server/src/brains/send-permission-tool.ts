import { Timestamp } from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { BrainTool } from './definition.js';

/**
 * `answer_send_permission` (P13-28; design 2026-11-18 §4.4 step 4): the decider of a held send —
 * the project's Waykeeper, or the Harmonizer for standalone work — turns Cosmin's reply into an
 * answer. The server checks everything that matters (`DomainCommands.answerSendPermission`): the
 * question is the brain's to decide, an allow comes only after his reply, a grant's words are his
 * verbatim and its end is in the future and at most 90 days ahead.
 */

type Input = Record<string, unknown>;

function text(input: Input, key: string, where = ''): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError('invalid', `${where}${key} must be a non-empty string`);
  }
  return v;
}

/** The Mac's local time `at`, with its UTC offset (e.g. 2026-11-18T21:05:00+02:00). */
export function localStamp(at: Date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

export const answerSendPermissionTool: BrainTool = {
  name: 'answer_send_permission',
  description:
    "Answers a held send or spend (a send permission question you decide) from Cosmin's reply to it. " +
    "decision 'allow' only after he replied and said yes; 'deny' when he said no. With 'allow', add a " +
    'grant when his words cover more than this one call (for how long or for what): words = his exact ' +
    'words, copied from his reply; summary = one line of what it allows; endsAt only when he gave an ' +
    'end. Without a grant, allow lets this one call through. Unclear reply: ask him in chat instead.',
  inputSchema: {
    type: 'object',
    properties: {
      questionId: { type: 'string', description: 'The send permission question.' },
      decision: { type: 'string', enum: ['allow', 'deny'] },
      grant: {
        type: 'object',
        properties: {
          words: { type: 'string', description: "Cosmin's exact words from his reply." },
          summary: {
            type: 'string',
            description: 'What it allows, in one line (e.g. "Instagram posts as @myshop, today").',
          },
          endsAt: {
            type: 'string',
            description:
              'When it ends, an ISO timestamp with the UTC offset of the local time you were given: ' +
              '"today" → the coming local midnight, "this week" → the end of Sunday, a date → the end ' +
              'of that day. Omit when he gave no end.',
          },
        },
        required: ['words', 'summary'],
        additionalProperties: false,
      },
    },
    required: ['questionId', 'decision'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = raw && typeof raw === 'object' ? (raw as Input) : {};
    const questionId = text(input, 'questionId');
    const decision = input['decision'];
    if (decision !== 'allow' && decision !== 'deny') {
      throw new DomainError('invalid', "decision must be 'allow' or 'deny'");
    }
    let grant: { words: string; summary: string; endsAt?: string } | undefined;
    const g = input['grant'];
    if (g !== undefined && g !== null) {
      if (decision === 'deny') throw new DomainError('invalid', 'a deny makes no grant');
      if (typeof g !== 'object') throw new DomainError('invalid', 'grant must be an object');
      const gi = g as Input;
      const endsAt = gi['endsAt'];
      if (endsAt !== undefined && endsAt !== null && !Timestamp.safeParse(endsAt).success) {
        throw new DomainError('invalid', 'grant.endsAt must be an ISO timestamp with its offset');
      }
      grant = {
        words: text(gi, 'words', 'grant.'),
        summary: text(gi, 'summary', 'grant.'),
        ...(typeof endsAt === 'string' ? { endsAt: new Date(endsAt).toISOString() } : {}),
      };
    }
    const { value } = await ctx.commands.answerSendPermission({
      questionId,
      agentId: ctx.brainId,
      decision,
      ...(grant ? { grant } : {}),
    });
    return {
      status: decision === 'allow' ? 'allowed' : 'denied',
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
