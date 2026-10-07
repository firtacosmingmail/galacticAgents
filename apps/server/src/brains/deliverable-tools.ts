import {
  DeliverableKind,
  type Agent,
  type Deliverable,
  type ToolDefinition,
} from '@galactic/protocol';
import { DomainError } from '../domain/errors.js';
import type { DeclareInput, DeliverableService } from '../deliverables/service.js';
import type { BrainTool, BrainToolContext } from './definition.js';

/**
 * Deliverable tools (P9-04; SPEC decision 120; TECHNOLOGY §5.3, §9.3).
 *
 * - The Steward's (`stewardDeliverableTools`): `declare_deliverable` and `list_deliverables` for
 *   its own task, handed to the adapter as `SpawnOptions.tools` on the runtimes that serve them
 *   (`claude-sdk`, and the fake runtime of tests and dev mode; the runtime attaches them,
 *   `AgentRuntime.setStewardTools`). The permission gate allows the server's own tools and
 *   nothing else changes for the Steward's other tools.
 * - The brains' (`DELIVERABLE_TOOLS`, shared by the Waykeeper and the Harmonizer):
 *   `declare_deliverable`, `remove_deliverable` (agent-declared rows only, with a reason) and
 *   `list_deliverables`. Reach: the Waykeeper its own project and its tasks; the Harmonizer
 *   standalone tasks (and reading any project's).
 *
 * Every write goes through `DeliverableService` (target, limits, paths, copies) and then the
 * domain commands, which check the agent's reach again. A refusal is the tool's result
 * (`{error, message}`) with the reason, never a crash.
 */

const KINDS = DeliverableKind.options;

const declareProperties = {
  kind: {
    type: 'string',
    enum: [...KINDS],
    description:
      'file (a report, a document, a build output), image (a screenshot, a chart: png, jpg, gif, ' +
      'webp, avif, svg), folder (a generated site, a package), app (a built .app or program), ' +
      'command (a command the user can run: a dev server, a script), url (a page or a running service).',
  },
  title: { type: 'string', description: 'A short name the user recognises (plain text).' },
  path: {
    type: 'string',
    description:
      'For file, image, folder, app: the path, absolute or relative to your working folder. For ' +
      'command: the folder it runs in (default: your working folder).',
  },
  command: { type: 'string', description: 'For command: the one-line command, e.g. "pnpm dev".' },
  url: { type: 'string', description: 'For url: the http(s) address.' },
  description: {
    type: 'string',
    description: 'Optional: what it is and how to use it (plain text).',
  },
};

/** What the model reads about a deliverable. */
export function deliverableBrief(d: Deliverable): Record<string, unknown> {
  return {
    deliverableId: d.id,
    kind: d.kind,
    title: d.title,
    ...(d.taskId ? { taskId: d.taskId } : {}),
    ...(d.projectId ? { projectId: d.projectId } : {}),
    source: d.source,
    ...(d.addedBy.type === 'agent' ? { addedBy: d.addedBy.id } : { addedBy: d.addedBy.type }),
    ...(d.location
      ? {
          path: d.location.path,
          storage: d.location.storage,
          ...(d.location.missing ? { missing: d.location.missing.reason } : {}),
        }
      : {}),
    ...(d.command ? { command: d.command.line, cwd: d.command.cwd } : {}),
    ...(d.url ? { url: d.url } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.removedAt ? { removed: d.removedReason ?? true } : {}),
  };
}

function declareInput(raw: Record<string, unknown>): DeclareInput {
  const out: DeclareInput = {
    kind: typeof raw['kind'] === 'string' ? raw['kind'] : String(raw['kind'] ?? ''),
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
  };
  for (const key of ['path', 'command', 'url', 'description'] as const) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
    out[key] = v;
  }
  return out;
}

const asInput = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

const optId = (raw: Record<string, unknown>, key: string): string | undefined => {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  return v;
};

/** Runs a handler and returns a refusal as `{error, message}`, as the brains' runner does. */
async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { error: typeof code === 'string' ? code : 'error', message: (error as Error).message };
  }
}

// -- the Steward's -------------------------------------------------------------------------------

export const STEWARD_DELIVERABLE_TOOL_NAMES = ['declare_deliverable', 'list_deliverables'] as const;

/**
 * The Steward's two server tools for its own task (decision 120). `agent` is its row; relative
 * paths resolve against its working folder (`meta.cwd`).
 */
export function stewardDeliverableTools(
  service: DeliverableService,
  agent: Pick<Agent, 'id' | 'taskId' | 'meta'>,
): ToolDefinition[] {
  const cwd = (agent.meta as { cwd?: unknown } | undefined)?.cwd;
  return [
    {
      name: 'declare_deliverable',
      description:
        'Declares something you produced that the user will want to open from the app: an app, ' +
        'a report, a screenshot, a generated folder, a command to run (a dev server), an ' +
        'address. Not every file you changed: only what the user would look for. The path ' +
        'must be inside your working folder (secret files such as .env or keys are refused); a ' +
        "file you made in a temporary folder is copied into the project's deliverables folder. " +
        'Declaring the same thing again returns the existing entry. Limited per task and per hour.',
      inputSchema: {
        type: 'object',
        properties: declareProperties,
        required: ['kind', 'title'],
        additionalProperties: false,
      },
      handler: (raw) =>
        guarded(async () => {
          const declared = await service.declare(agent.id, {}, declareInput(asInput(raw)), {
            ...(typeof cwd === 'string' ? { cwd } : {}),
          });
          return {
            ...deliverableBrief(declared.deliverable),
            ...(declared.existing ? { note: 'already declared: nothing new was added' } : {}),
          };
        }),
    },
    {
      name: 'list_deliverables',
      description: "Lists the deliverables of your task (yours, your supervisor's and the user's).",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () =>
        guarded(async () => ({
          deliverables: service.list(agent.id).map(deliverableBrief),
        })),
    },
  ];
}

// -- the brains' ---------------------------------------------------------------------------------

function serviceOf(ctx: BrainToolContext): DeliverableService {
  if (!ctx.deliverables) {
    throw new DomainError('invalid', 'this server does not take deliverable declarations');
  }
  return ctx.deliverables;
}

export const declareDeliverableTool: BrainTool = {
  name: 'declare_deliverable',
  description:
    "Declares a deliverable the user will want to open from the app, for your project's work " +
    '(a Waykeeper: the project itself or one of its tasks; the Harmonizer: a standalone task). ' +
    'Use it for what a Steward on another runtime listed under "Deliverables:" in its report ' +
    '(it cannot declare them itself), and for a project-level command such as the dev server ' +
    "instead of leaving one running. Paths must be inside the project (or the task's " +
    "worktree); relative paths resolve against the task's worktree or the project folder.",
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task it belongs to (omit for the project itself).',
      },
      projectId: {
        type: 'string',
        description: 'The project (default: yours, for a Waykeeper).',
      },
      ...declareProperties,
    },
    required: ['kind', 'title'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const taskId = optId(input, 'taskId');
    const projectId = optId(input, 'projectId');
    const declared = await serviceOf(ctx).declare(
      ctx.brainId,
      { ...(taskId ? { taskId } : {}), ...(projectId ? { projectId } : {}) },
      declareInput(input),
      { commands: ctx.commands },
    );
    return {
      ...deliverableBrief(declared.deliverable),
      ...(declared.existing ? { note: 'already declared: nothing new was added' } : {}),
    };
  },
};

export const removeDeliverableTool: BrainTool = {
  name: 'remove_deliverable',
  description:
    'Removes a deliverable an agent declared that the user will not want (a scratch log, a ' +
    'temporary file), with the reason. It only leaves the list: no file is deleted, and the ' +
    'user can bring it back. Never for what the user added or what the server detected.',
  inputSchema: {
    type: 'object',
    properties: {
      deliverableId: { type: 'string' },
      reason: { type: 'string', description: 'Why it is not worth keeping (shown to the user).' },
    },
    required: ['deliverableId', 'reason'],
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const id = optId(input, 'deliverableId');
    if (!id) throw new DomainError('invalid', 'deliverableId is required');
    const reason = typeof input['reason'] === 'string' ? input['reason'] : '';
    const removed = await serviceOf(ctx).remove(ctx.brainId, id, reason, {
      commands: ctx.commands,
    });
    return deliverableBrief(removed);
  },
};

export const listDeliverablesTool: BrainTool = {
  name: 'list_deliverables',
  description:
    "Lists deliverables: a Waykeeper its project's (or one task's, with taskId); the Harmonizer " +
    "the standalone tasks' (or one task's or project's). includeRemoved shows removed ones too.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      taskId: { type: 'string' },
      includeRemoved: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const taskId = optId(input, 'taskId');
    const projectId = optId(input, 'projectId');
    const rows = serviceOf(ctx).list(
      ctx.brainId,
      { ...(taskId ? { taskId } : {}), ...(projectId ? { projectId } : {}) },
      input['includeRemoved'] === true,
    );
    return { deliverables: rows.map(deliverableBrief) };
  },
};

export const DELIVERABLE_TOOLS: BrainTool[] = [
  declareDeliverableTool,
  removeDeliverableTool,
  listDeliverablesTool,
];
