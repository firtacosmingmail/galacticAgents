import { DomainError } from '../domain/errors.js';
import { isLive } from './common-tools.js';
import type { BrainTool } from './definition.js';

/**
 * The supervisor's answer to a Steward's report (P2-11; SPEC §2.7, decision 11). A Steward
 * reports by ending its turn; its supervisor (a Waykeeper, or the Harmonizer for an asteroid
 * task) then decides: the task is done (merge and close, or close), or the Steward is in fact
 * waiting for input — then `tell_steward` gives it what it needs (an answer, more work, a
 * correction) as its next turn.
 *
 * The message is queued, never an interrupt: supervision without interruption (SPEC §2.5). A
 * Steward that is still working gets it when its turn ends. Only the caller's own Stewards
 * (direct reports) can be told, and only while they run.
 *
 * A report → `tell_steward` → report loop is bounded here, not only by the Steward's tool-call
 * and wall-clock caps (a text-only ping-pong makes no tool calls): at most
 * `MAX_TELLS_PER_HOUR` messages to one Steward in any sliding hour, then the tool is refused and
 * the supervisor escalates or closes instead (decision 18; kept in memory, a restart forgets it).
 */
export const MAX_TELLS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const told = new Map<string, number[]>();

/** Counts one message to `agentId` now, or refuses when the hour's quota is used. */
export function noteTell(agentId: string, now: number = Date.now()): void {
  const recent = (told.get(agentId) ?? []).filter((at) => at > now - HOUR_MS);
  if (recent.length >= MAX_TELLS_PER_HOUR) {
    told.set(agentId, recent);
    throw new DomainError(
      'conflict',
      `Steward ${agentId} was told ${recent.length} times in the last hour (limit ${MAX_TELLS_PER_HOUR}): ` +
        'stop the back-and-forth — escalate what it needs, or close the task',
    );
  }
  told.set(agentId, [...recent, now]);
}
export const tellStewardTool: BrainTool = {
  name: 'tell_steward',
  description:
    'Sends one of your Stewards a message that starts its next turn: the answer it was waiting ' +
    'for, more work after a report that was not really done, or a correction. Never an ' +
    'interrupt: a Steward still working gets it when its turn ends. Use it only in reply to a ' +
    'report or a finding; never to ask how it is going (read its status instead).',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The Steward (a-…).' },
      text: { type: 'string', description: 'What the Steward should know or do next.' },
    },
    required: ['agentId', 'text'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const agentId = input['agentId'];
    const text = input['text'];
    if (typeof agentId !== 'string' || agentId === '') {
      throw new DomainError('invalid', 'agentId must be a non-empty string');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new DomainError('invalid', 'text must be a non-empty string');
    }
    const agent = ctx.queries.agent(agentId);
    if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
    if (agent.role !== 'steward' || agent.supervisorId !== ctx.brainId) {
      throw new DomainError('invalid', `agent ${agentId} is not one of your Stewards`);
    }
    const status = ctx.queries.status(agentId);
    if (!isLive(status)) {
      throw new DomainError(
        'invalid_transition',
        `Steward ${agentId} is ${status?.state ?? 'not running'}: it cannot be told anything`,
      );
    }
    noteTell(agentId);
    const { messageId } = ctx.send(agentId, text);
    return { agentId, messageId, state: status?.state };
  },
};

export const STEWARD_TOOLS: readonly BrainTool[] = [tellStewardTool];
