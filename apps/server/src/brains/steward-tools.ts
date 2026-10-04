import { DomainError } from '../domain/errors.js';
import { isLive } from './common-tools.js';
import type { Agent } from '@galactic/protocol';
import type { BrainTool, BrainToolContext } from './definition.js';

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

/**
 * A Steward's processes (P4-14; SPEC decision 53): the dev servers, watchers and headless browsers
 * it started and left running. Its supervisor lists them and stops the leftovers before it merges
 * or closes the task, and when the Steward stopped or failed; the server sweeps what is left when
 * the Steward ends or its task closes, as a safety net. Reach: the caller's own Stewards (direct
 * reports), like `tell_steward`; which processes are a Steward's is the server's attribution
 * (`runtime/process-attribution.ts`), never the model's — a pid outside it is refused.
 */
function ownSteward(ctx: BrainToolContext, agentId: unknown): Agent {
  if (typeof agentId !== 'string' || agentId === '') {
    throw new DomainError('invalid', 'agentId must be a non-empty string');
  }
  const agent = ctx.queries.agent(agentId);
  if (!agent) throw new DomainError('not_found', `no agent ${agentId}`);
  if (agent.role !== 'steward' || agent.supervisorId !== ctx.brainId) {
    throw new DomainError('invalid', `agent ${agentId} is not one of your Stewards`);
  }
  return agent;
}

function processControl(ctx: BrainToolContext) {
  if (!ctx.processes) {
    throw new DomainError('invalid', 'this server cannot inspect processes');
  }
  return ctx.processes;
}

export const listStewardProcessesTool: BrainTool = {
  name: 'list_steward_processes',
  description:
    'Lists the processes one of your Stewards started that are still running (dev servers, ' +
    'watchers, headless browsers, background jobs): pid, command, working directory, listening ' +
    "ports, start time and why it counts as the Steward's. Its own session is not listed. Without " +
    'agentId: every Steward of yours that has any.',
  inputSchema: {
    type: 'object',
    properties: { agentId: { type: 'string', description: 'The Steward (a-…).' } },
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const control = processControl(ctx);
    if (input['agentId'] !== undefined) {
      const agent = ownSteward(ctx, input['agentId']);
      const listed = await control.list(agent.id);
      return {
        ...listed,
        ...(agent.taskId ? { taskId: agent.taskId } : {}),
        state: ctx.queries.status(agent.id)?.state ?? 'unknown',
      };
    }
    const stewards = ctx.queries
      .supervisedAgents(ctx.brainId)
      .filter(({ agent }) => agent.role === 'steward');
    const listed = await Promise.all(
      stewards.map(async ({ agent, status }) => ({
        ...(await control.list(agent.id)),
        ...(agent.taskId ? { taskId: agent.taskId } : {}),
        state: status?.state ?? 'unknown',
      })),
    );
    const withProcesses = listed.filter((s) => s.processes.length > 0);
    return {
      supported: listed.every((s) => s.supported),
      stewards: withProcesses,
      total: withProcesses.reduce((n, s) => n + s.processes.length, 0),
    };
  },
};

export const stopStewardProcessesTool: BrainTool = {
  name: 'stop_steward_processes',
  description:
    'Stops processes one of your Stewards left running: SIGTERM, then SIGKILL after a few ' +
    'seconds. Give the pids from list_steward_processes (their child processes go too), or none ' +
    "to stop all of them. Only the Steward's own processes can be stopped; any other pid is " +
    'refused. Does not stop the Steward itself (stop_agent does).',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The Steward (a-…).' },
      pids: {
        type: 'array',
        items: { type: 'integer', minimum: 2 },
        description: 'The pids to stop; default: all of its processes.',
      },
    },
    required: ['agentId'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const agent = ownSteward(ctx, input['agentId']);
    const pids = input['pids'];
    if (
      pids !== undefined &&
      (!Array.isArray(pids) ||
        pids.length === 0 ||
        !pids.every((p) => typeof p === 'number' && Number.isInteger(p) && p > 1))
    ) {
      throw new DomainError('invalid', 'pids must be a non-empty list of process ids');
    }
    const result = await processControl(ctx).stop(agent.id, {
      by: ctx.actor,
      ...(pids ? { pids: pids as number[] } : {}),
    });
    return {
      ...result,
      ...(result.alive.length > 0
        ? { note: 'Some processes survived SIGKILL; tell the user which.' }
        : {}),
    };
  },
};

export const STEWARD_TOOLS: readonly BrainTool[] = [
  tellStewardTool,
  listStewardProcessesTool,
  stopStewardProcessesTool,
];
