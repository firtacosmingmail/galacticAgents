import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  Agent,
  HarnessBrainWaykeeperBody,
  HarnessBrainWaykeeperResponse,
  Id,
} from '@galactic/protocol';
import type { Commands } from '../domain/commands.js';
import { DomainError, must } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';

/**
 * The scene harness's real brains (P8-21, development only; `/dev/harness/brains/*`). The harness's
 * own agents (`scene-harness.ts`) have no process: they cannot take a turn, so nothing a brain does
 * on its own — answer from context, hear the answers to its questions — can be seen with them.
 * Here a test starts a **real Waykeeper brain on the fake runtime** for a new project under the
 * running Harmonizer, and makes a fake-runtime brain call one of its tools as its model would
 * (the fake runtime echoes each turn's prompt, but never chooses a tool).
 *
 * Only brains on the fake runtime are driven: a real Claude brain decides its own tool calls.
 */
export interface HarnessBrains {
  startWaykeeper(input: HarnessBrainWaykeeperBody): Promise<HarnessBrainWaykeeperResponse>;
  callTool(agentId: Id, name: string, input: unknown): Promise<unknown>;
}

export interface HarnessBrainsOptions {
  log: EventLog;
  commands: Commands;
  workspaces: { projectsRoot: string; prepareProject(projectId: Id): Promise<unknown> };
  /** The runtime's live agents: the running Harmonizer is found among them. */
  liveAgents: () => Agent[];
  /** The server's Waykeeper starter (`composed.startBrain(waykeeperDefinition(), …)`). */
  startWaykeeper: (input: {
    projectId: Id;
    supervisorId: Id;
    runtime: 'fake';
  }) => Promise<{ agentId: Id }>;
  /** A running brain's runner. */
  runnerOf: (
    agentId: Id,
  ) => { callTool(name: string, input: unknown): Promise<unknown> } | undefined;
}

export function harnessBrains(opts: HarnessBrainsOptions): HarnessBrains {
  return {
    async startWaykeeper(input) {
      const hq = opts.liveAgents().find((a) => a.role === 'harmonizer');
      if (!hq) throw new DomainError('conflict', 'no Harmonizer is running');
      const name = input.name ?? 'Harness brain project';
      const { value: project } = await opts.commands.createProject(
        {
          name,
          workspace: join(
            opts.workspaces.projectsRoot,
            `harness-brain-${randomUUID().slice(0, 8)}`,
          ),
          kind: 'planet',
        },
        { origin: 'local' },
      );
      await opts.workspaces.prepareProject(project.id);
      const { agentId } = await opts.startWaykeeper({
        projectId: project.id,
        supervisorId: hq.id,
        runtime: 'fake',
      });
      return {
        seq: opts.log.currentSeq(),
        projectId: project.id,
        waykeeperId: agentId,
        harmonizerId: hq.id,
      };
    },

    async callTool(agentId, name, input) {
      const agent = must(opts.log.tables.agents.get(agentId), 'agent', agentId);
      if (agent.runtime !== 'fake') {
        throw new DomainError(
          'invalid',
          `agent ${agentId} runs on ${agent.runtime}: only a fake-runtime brain is driven by the harness`,
        );
      }
      const runner = opts.runnerOf(agentId);
      if (!runner) throw new DomainError('conflict', `agent ${agentId} is not a running brain`);
      return runner.callTool(name, input);
    },
  };
}
