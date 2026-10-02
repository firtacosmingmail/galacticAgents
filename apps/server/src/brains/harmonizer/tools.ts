import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentRuntime,
  Body,
  BodyChoice,
  BodyRequest,
  Id,
  Project,
  Proposal,
  ProposedBody,
  Task,
  WorkBodyKind,
} from '@galactic/protocol';
import { DomainError, must } from '../../domain/errors.js';
import { slugify } from '../../workspace/workspaces.js';
import type { BrainQueries, BrainTool, BrainToolContext } from '../definition.js';
import { asInput, isLiving, oneOf, S, str, strings } from './input.js';
import { findRelated, words } from './related.js';

/**
 * The Harmonizer's own tools (P2-08; TECHNOLOGY §5.3). Handlers call `DomainCommands` and read
 * `BrainQueries`; a refusal is a thrown `DomainError`, which the runner hands to the model as
 * `{error, message}`. Decision 3 is enforced here, not left to the prompt: projects, tasks and
 * agents for new work exist only once their proposal card is approved.
 */

/** What a work request asks for, kept on its proposal as `meta.request`. */
export type HarmonizerRequest =
  | { type: 'new_project'; name: string; parentProjectId?: Id }
  | { type: 'standalone_task'; name: string; description: string; relatedProjectId?: Id }
  | { type: 'project_task'; name: string; description: string; projectId: Id }
  | {
      type: 'promotion';
      name: string;
      target: { kind: 'task' | 'project'; id: Id };
      fromBodyId: Id;
      /** A standalone task joining an existing project's body (P2-12 does the move). */
      toProjectId?: Id;
    };

export const REQUEST_TYPES = ['new_project', 'standalone_task', 'project_task'] as const;

export interface HarmonizerDeps {
  /** Where new project folders and standalone scratch folders go (SPEC §3.5). */
  projectsRoot: string;
  /**
   * Validates a workspace and returns its canonical path (the server passes
   * `Workspaces.checkPath`). Default: absolute, not `/`, not the projects root itself.
   */
  checkPath?: (path: string) => string;
  /** Creates a standalone task's folder before its Steward starts. Default `mkdir -p`. */
  ensureDir?: (path: string) => void;
  /**
   * Starts a project's Waykeeper brain (P2-10's definition, wired by the server). Without it,
   * `spawn_waykeeper` is refused.
   */
  startWaykeeper?: (input: {
    projectId: Id;
    supervisorId: Id;
    runtime: AgentRuntime;
  }) => Promise<{ agentId: Id }>;
  /** The first prompt of an asteroid Steward (P2-11 owns the template). */
  stewardPrompt?: (task: Task, extra: { workspace: string; instructions?: string }) => string;
  /** The runtime of the agents the Harmonizer spawns. Default: its own. */
  runtime?: AgentRuntime;
}

/** SPEC §3.5: a standalone task without a related project works in a scratch folder. */
export const SCRATCH_DIR = 'scratch';

/** The default asteroid Steward prompt; P2-11 replaces it with the full template. */
export function defaultStewardPrompt(
  task: Task,
  extra: { workspace: string; instructions?: string },
): string {
  return [
    `Your task (${task.id}): ${task.description}`,
    `You work in ${extra.workspace}. Stay inside it.`,
    ...(extra.instructions ? [extra.instructions] : []),
    'When you are unsure, ask a question instead of guessing. When the task is done, say so ' +
      'clearly and summarise what you did; your supervisor decides whether the task is closed.',
  ].join('\n\n');
}

function defaultCheckPath(projectsRoot: string) {
  return (path: string) => {
    if (!isAbsolute(path)) {
      throw new DomainError('invalid', `a workspace must be an absolute path: ${path}`);
    }
    const abs = resolve(path);
    if (abs === '/') throw new DomainError('invalid', 'the workspace cannot be /');
    if (abs === resolve(projectsRoot)) {
      throw new DomainError('invalid', 'the workspace cannot be the projects root itself');
    }
    return abs;
  };
}

/** Free means: no host and no "moved to …" marker (decision 25). */
const isFree = (b: Body | undefined) => b !== undefined && !b.host && !b.movedTo;

const requestOf = (p: Proposal): HarmonizerRequest | undefined =>
  p.meta?.['request'] as HarmonizerRequest | undefined;

/** A proposal the Harmonizer made, approved by the user (decision 3). */
function approved(
  queries: BrainQueries,
  proposalId: Id,
): Proposal & { request: HarmonizerRequest } {
  const proposal = must(queries.proposal(proposalId), 'proposal', proposalId);
  const request = requestOf(proposal);
  if (!request) {
    throw new DomainError('invalid', `proposal ${proposalId} is not a Harmonizer work request`);
  }
  if (proposal.state !== 'approved') {
    throw new DomainError(
      'invalid_transition',
      `proposal ${proposalId} is ${proposal.state}: nothing is created before the user approves it`,
    );
  }
  return { ...proposal, request };
}

function openProject(queries: BrainQueries, projectId: Id): Project {
  const project = must(queries.project(projectId), 'project', projectId);
  if (['completed', 'archived', 'failed', 'moved'].includes(project.state)) {
    throw new DomainError('invalid_transition', `project ${projectId} is ${project.state}`);
  }
  return project;
}

export function harmonizerTools(deps: HarmonizerDeps): BrainTool[] {
  const root = deps.projectsRoot;
  const checkPath = deps.checkPath ?? defaultCheckPath(root);
  const ensureDir = deps.ensureDir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const stewardPrompt = deps.stewardPrompt ?? defaultStewardPrompt;
  const runtimeOf = (ctx: BrainToolContext): AgentRuntime =>
    deps.runtime ?? ctx.queries.agent(ctx.brainId)?.runtime ?? 'claude-sdk';

  /** `<base>/<slug>`, `-2`, `-3`, … when a folder or a live project already uses it. */
  const suggest = (queries: BrainQueries, base: string, name: string) => {
    const used = new Set(
      queries
        .projects()
        .filter((p) => p.state !== 'archived')
        .map((p) => resolve(p.workspace)),
    );
    for (const t of queries.tasks()) {
      const w = t.meta?.['workspace'];
      if (typeof w === 'string' && t.state !== 'archived') used.add(resolve(w));
    }
    const slug = slugify(name);
    for (let n = 1; ; n++) {
      const candidate = join(base, n === 1 ? slug : `${slug}-${n}`);
      if (!existsSync(candidate) && !used.has(resolve(candidate))) return candidate;
    }
  };

  const describeChoice = (choice: BodyChoice) =>
    choice.ok
      ? { free: true, bodyId: choice.body.id, bodyName: choice.body.name }
      : {
          free: false,
          reason: choice.reason,
          occupied: choice.occupied.map((o) => ({
            bodyId: o.bodyId,
            bodyName: o.bodyName,
            ...(o.occupant ? { occupant: o.occupant } : {}),
            ...(o.state ? { state: o.state } : {}),
            ...(o.movedTo ? { movedTo: o.movedTo.bodyId } : {}),
          })),
        };

  const proposedBodyFor = async (
    ctx: BrainToolContext,
    kind: WorkBodyKind,
    name: string,
    opts: { bodyId?: Id; parentProjectId?: Id },
  ): Promise<{ proposedBody: ProposedBody; choice?: BodyChoice }> => {
    if (kind === 'asteroid') return { proposedBody: { kind, name } };
    if (opts.bodyId) {
      const body = must(ctx.queries.body(opts.bodyId), 'body', opts.bodyId);
      if (body.kind !== kind) {
        throw new DomainError('invalid', `${body.name} is a ${body.kind}, not a ${kind}`);
      }
      if (!isFree(body) || body.meta?.['reserved'] === true) {
        throw new DomainError('conflict', `${body.name} is not free`);
      }
      return {
        proposedBody: {
          kind,
          name,
          bodyId: body.id,
          ...(body.parentId ? { parentId: body.parentId } : {}),
        },
      };
    }
    const request: BodyRequest =
      kind === 'planet'
        ? { kind }
        : { kind, ...(opts.parentProjectId ? { parentProjectId: opts.parentProjectId } : {}) };
    const choice = await ctx.commands.chooseBody(request);
    if (!choice.ok) return { proposedBody: { kind, name }, choice };
    return {
      proposedBody: {
        kind,
        name,
        bodyId: choice.body.id,
        ...(choice.body.parentId ? { parentId: choice.body.parentId } : {}),
      },
      choice,
    };
  };

  // -- informing tools ---------------------------------------------------------------------------

  const findRelatedWork: BrainTool = {
    name: 'find_related_work',
    description:
      'Searches existing projects and tasks for work related to a request (shared words in ' +
      'names, workspaces and task descriptions). Call it before sizing a work request.',
    inputSchema: S.obj(
      {
        request: S.str('The request, in the user’s words.'),
        includeArchived: { type: 'boolean', description: 'Also search archived work.' },
      },
      ['request'],
    ),
    async handler(raw, ctx) {
      const input = asInput(raw);
      return findRelated(
        str(input, 'request'),
        { projects: ctx.queries.projects(), tasks: ctx.queries.tasks() },
        { includeArchived: input['includeArchived'] === true },
      );
    },
  };

  const sizeRequest: BrainTool = {
    name: 'size_request',
    description:
      'Informs the sizing of a work request: for the size you judge (planet, moon, asteroid, or ' +
      'project_task with a projectId), the body the catalogue would give, a suggested name and ' +
      'workspace, the related work, and what is free. You decide; it changes nothing.',
    inputSchema: S.obj(
      {
        request: S.str('The request, in the user’s words.'),
        kind: S.enum(['planet', 'moon', 'asteroid', 'project_task'], 'Your judgement of the size.'),
        name: S.str('A short name for the work (default: derived from the request).'),
        projectId: S.str('For project_task: the project the work belongs to.'),
        parentProjectId: S.str('For a sub-project moon: the planet project.'),
        relatedProjectId: S.str('For an asteroid: the project whose workspace it uses.'),
      },
      ['request'],
    ),
    async handler(raw, ctx) {
      const input = asInput(raw);
      const request = str(input, 'request');
      const kind =
        oneOf(input, 'kind', ['planet', 'moon', 'asteroid', 'project_task'] as const, true) ??
        hintKind(request);
      const suggestedName = str(input, 'name', true) ?? nameFrom(request);
      const related = findRelated(request, {
        projects: ctx.queries.projects(),
        tasks: ctx.queries.tasks(),
      }).slice(0, 3);
      const freePlanets = (await ctx.commands.freePlanets()).map((b) => b.name);
      const freeMoons = (await ctx.commands.freeMoons()).length;
      const base = { request, suggestedName, related, freePlanets, freeMoons };
      if (kind === 'project_task') {
        const project = openProject(ctx.queries, str(input, 'projectId'));
        return {
          ...base,
          kind,
          rationale: `a task of ${project.name}: it lives on the project's body`,
          proposedBody: {
            kind: bodyKind(ctx.queries, project),
            bodyId: project.bodyId,
            name: suggestedName,
          },
          workspace: project.workspace,
        };
      }
      if (kind === 'asteroid') {
        const relatedId = str(input, 'relatedProjectId', true);
        const workspace = relatedId
          ? must(ctx.queries.project(relatedId), 'project', relatedId).workspace
          : suggest(ctx.queries, join(root, SCRATCH_DIR), suggestedName);
        return {
          ...base,
          kind,
          rationale: 'a standalone task: a fresh asteroid in the belt',
          proposedBody: { kind, name: suggestedName },
          workspace,
        };
      }
      const parentProjectId = str(input, 'parentProjectId', true);
      if (parentProjectId) must(ctx.queries.project(parentProjectId), 'project', parentProjectId);
      const { proposedBody, choice } = await proposedBodyFor(ctx, kind, suggestedName, {
        ...(parentProjectId ? { parentProjectId } : {}),
      });
      return {
        ...base,
        kind,
        rationale: rationaleFor(kind, choice, parentProjectId),
        proposedBody,
        ...(choice ? { body: describeChoice(choice) } : {}),
        workspace: suggest(ctx.queries, root, suggestedName),
      };
    },
  };

  const freePlanets: BrainTool = {
    name: 'free_planets',
    description: 'The free planets, in catalogue order (deterministic).',
    inputSchema: S.obj({}),
    async handler(_raw, ctx) {
      return (await ctx.commands.freePlanets()).map((b) => ({ id: b.id, name: b.name }));
    },
  };

  const freeMoons: BrainTool = {
    name: 'free_moons',
    description: 'The free moons, of one planet or all, in catalogue order (deterministic).',
    inputSchema: S.obj({ planetId: S.str('Only the moons of this planet.') }),
    async handler(raw, ctx) {
      const planetId = str(asInput(raw), 'planetId', true);
      return (await ctx.commands.freeMoons(planetId)).map((b) => ({
        id: b.id,
        name: b.name,
        planetId: b.parentId,
      }));
    },
  };

  // -- the one card ------------------------------------------------------------------------------

  const propose: BrainTool = {
    name: 'propose',
    description:
      'Creates the one proposal card of a work request (decision 3): a new project (planet or ' +
      'moon), a standalone task (asteroid), or a task added to an existing project. Ends your ' +
      'turn; the user’s decision arrives as a later event. Never for a conversational request.',
    inputSchema: S.obj(
      {
        type: S.enum(REQUEST_TYPES, 'What the card asks for.'),
        requestText: S.str('The user’s request, verbatim.'),
        name: S.str('The project’s name, or a short name for the task.'),
        rationale: S.str('Why this size and body, in a sentence or two.'),
        kind: S.enum(['planet', 'moon'], 'new_project only: the size.'),
        workspace: S.str(
          'Absolute folder (default: a new folder under the projects root, or for a task the related project’s workspace or a scratch folder).',
        ),
        bodyId: S.str(
          'new_project only: a specific free planet or moon (default: the catalogue’s choice).',
        ),
        parentProjectId: S.str('new_project moon only: the planet project of a sub-project.'),
        projectId: S.str('project_task only: the project the task joins.'),
        relatedProjectId: S.str('standalone_task only: the project whose workspace it uses.'),
        description: S.str('Tasks only: the task description (default: the request).'),
      },
      ['type', 'requestText', 'name', 'rationale'],
    ),
    endsTurn: true,
    async handler(raw, ctx) {
      const input = asInput(raw);
      const type = oneOf(input, 'type', REQUEST_TYPES);
      const requestText = str(input, 'requestText');
      const name = str(input, 'name');
      const rationale = str(input, 'rationale');
      const description = str(input, 'description', true) ?? requestText;
      let kind: WorkBodyKind;
      let workspace: string;
      let request: HarmonizerRequest;
      let proposedBody: ProposedBody;
      let choice: BodyChoice | undefined;
      switch (type) {
        case 'new_project': {
          kind = oneOf(input, 'kind', ['planet', 'moon'] as const);
          const parentProjectId = str(input, 'parentProjectId', true);
          if (parentProjectId) {
            if (kind !== 'moon') throw new DomainError('invalid', 'a sub-project is a moon');
            openProject(ctx.queries, parentProjectId);
          }
          const bodyId = str(input, 'bodyId', true);
          ({ proposedBody, choice } = await proposedBodyFor(ctx, kind, name, {
            ...(bodyId ? { bodyId } : {}),
            ...(parentProjectId ? { parentProjectId } : {}),
          }));
          workspace = checkPath(str(input, 'workspace', true) ?? suggest(ctx.queries, root, name));
          request = { type, name, ...(parentProjectId ? { parentProjectId } : {}) };
          break;
        }
        case 'standalone_task': {
          kind = 'asteroid';
          const relatedProjectId = str(input, 'relatedProjectId', true);
          const related = relatedProjectId
            ? must(ctx.queries.project(relatedProjectId), 'project', relatedProjectId)
            : undefined;
          workspace = checkPath(
            str(input, 'workspace', true) ??
              related?.workspace ??
              suggest(ctx.queries, join(root, SCRATCH_DIR), name),
          );
          proposedBody = { kind, name };
          request = {
            type,
            name,
            description,
            ...(relatedProjectId ? { relatedProjectId } : {}),
          };
          break;
        }
        case 'project_task': {
          const project = openProject(ctx.queries, str(input, 'projectId'));
          kind = bodyKind(ctx.queries, project);
          workspace = project.workspace;
          proposedBody = { kind, name, bodyId: project.bodyId };
          request = { type, name, description, projectId: project.id };
          break;
        }
      }
      const { value } = await ctx.commands.createProposal({
        requestText,
        kind,
        proposedBody,
        workspace,
        rationale,
        meta: {
          request,
          // P2-09 parks the card from this when no planet or moon is free (decision 16).
          ...(choice && !choice.ok ? { bodyChoice: choice } : {}),
        },
      });
      return {
        proposalId: value.id,
        kind: value.kind,
        proposedBody: value.proposedBody,
        workspace: value.workspace,
        ...(choice ? { body: describeChoice(choice) } : {}),
      };
    },
  };

  const proposePromotion: BrainTool = {
    name: 'propose_promotion',
    description:
      'Proposes moving grown work to a bigger body (decision 2): an asteroid task to a moon or ' +
      'planet, a moon project to a planet, or a standalone task into an existing project ' +
      '(toProjectId). Creates the card only; ends your turn. The user confirms.',
    inputSchema: S.obj(
      {
        taskId: S.str('The standalone task to promote or move.'),
        projectId: S.str('The project to promote.'),
        toKind: S.enum(['moon', 'planet'], 'The new size.'),
        toProjectId: S.str('A task only: the project it joins instead.'),
        name: S.str('The name on the card (default: the task or project’s).'),
        rationale: S.str('Why it outgrew its body.'),
      },
      ['rationale'],
    ),
    endsTurn: true,
    async handler(raw, ctx) {
      const input = asInput(raw);
      const rationale = str(input, 'rationale');
      const taskId = str(input, 'taskId', true);
      const projectId = str(input, 'projectId', true);
      if ((taskId === undefined) === (projectId === undefined)) {
        throw new DomainError('invalid', 'give exactly one of taskId and projectId');
      }
      const toProjectId = str(input, 'toProjectId', true);
      let request: HarmonizerRequest;
      let kind: WorkBodyKind;
      let proposedBody: ProposedBody;
      let workspace: string;
      let choice: BodyChoice | undefined;
      if (taskId) {
        const task = must(ctx.queries.task(taskId), 'task', taskId);
        if (task.projectId) {
          throw new DomainError('invalid', `task ${taskId} is a project task: its Waykeeper asks`);
        }
        const name = str(input, 'name', true) ?? nameFrom(task.description);
        if (toProjectId) {
          const project = openProject(ctx.queries, toProjectId);
          kind = bodyKind(ctx.queries, project);
          proposedBody = { kind, name: project.name, bodyId: project.bodyId };
          workspace = project.workspace;
        } else {
          kind = oneOf(input, 'toKind', ['moon', 'planet'] as const);
          ({ proposedBody, choice } = await proposedBodyFor(ctx, kind, name, {}));
          workspace =
            (task.meta?.['workspace'] as string | undefined) ?? suggest(ctx.queries, root, name);
        }
        request = {
          type: 'promotion',
          name,
          target: { kind: 'task', id: taskId },
          fromBodyId: task.bodyId,
          ...(toProjectId ? { toProjectId } : {}),
        };
      } else {
        if (toProjectId) throw new DomainError('invalid', 'only a task joins another project');
        const project = must(ctx.queries.project(projectId!), 'project', projectId!);
        kind = oneOf(input, 'toKind', ['moon', 'planet'] as const);
        if (bodyKind(ctx.queries, project) === kind) {
          throw new DomainError('invalid', `project ${project.id} already is a ${kind}`);
        }
        const name = str(input, 'name', true) ?? project.name;
        ({ proposedBody, choice } = await proposedBodyFor(ctx, kind, name, {}));
        workspace = project.workspace;
        request = {
          type: 'promotion',
          name,
          target: { kind: 'project', id: project.id },
          fromBodyId: project.bodyId,
        };
      }
      const { value } = await ctx.commands.createProposal({
        requestText: `promote ${request.target.kind} ${request.target.id}`,
        kind,
        proposedBody,
        workspace: checkPath(workspace),
        rationale,
        meta: { request, ...(choice && !choice.ok ? { bodyChoice: choice } : {}) },
      });
      return {
        proposalId: value.id,
        kind: value.kind,
        proposedBody: value.proposedBody,
        ...(choice ? { body: describeChoice(choice) } : {}),
      };
    },
  };

  // -- carrying out an approved card -------------------------------------------------------------

  const createProject: BrainTool = {
    name: 'create_project',
    description:
      'Creates the project of an APPROVED new-project proposal (planet or moon, with the user’s ' +
      'edits), on its proposed body or the catalogue’s choice. Then spawn_waykeeper.',
    inputSchema: S.obj({ proposalId: S.str('The approved proposal.') }, ['proposalId']),
    async handler(raw, ctx) {
      const proposal = approved(ctx.queries, str(asInput(raw), 'proposalId'));
      const { request } = proposal;
      if (request.type !== 'new_project' && request.type !== 'standalone_task') {
        throw new DomainError(
          'invalid',
          `proposal ${proposal.id} is a ${request.type}, not a new project`,
        );
      }
      if (proposal.kind === 'asteroid') {
        throw new DomainError('invalid', `proposal ${proposal.id} is an asteroid: use create_task`);
      }
      const done = ctx.queries.projects().find((p) => p.meta?.['proposalId'] === proposal.id);
      if (done) {
        throw new DomainError('conflict', `proposal ${proposal.id} is already project ${done.id}`);
      }
      const bodyId = proposal.proposedBody.bodyId;
      const parentProjectId =
        request.type === 'new_project' && proposal.kind === 'moon'
          ? request.parentProjectId
          : undefined;
      const { value } = await ctx.commands.createProject({
        name: request.name,
        workspace: checkPath(proposal.workspace),
        kind: proposal.kind,
        ...(bodyId && isFree(ctx.queries.body(bodyId)) ? { bodyId } : {}),
        ...(parentProjectId ? { parentProjectId } : {}),
        meta: { proposalId: proposal.id },
      });
      return {
        projectId: value.id,
        name: value.name,
        bodyId: value.bodyId,
        workspace: value.workspace,
        state: value.state,
      };
    },
  };

  const createTask: BrainTool = {
    name: 'create_task',
    description:
      'Creates the task of an APPROVED proposal: a standalone task on a fresh asteroid (then ' +
      'spawn_steward), or a task added to an existing project (its Waykeeper picks it up).',
    inputSchema: S.obj(
      {
        proposalId: S.str('The approved proposal.'),
        description: S.str('The task description (default: the card’s).'),
        priority: S.enum(['low', 'normal', 'high', 'urgent'], 'Default normal.'),
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Blocking task ids.' },
      },
      ['proposalId'],
    ),
    async handler(raw, ctx) {
      const input = asInput(raw);
      const proposal = approved(ctx.queries, str(input, 'proposalId'));
      const { request } = proposal;
      const done = ctx.queries.tasks().find((t) => t.meta?.['proposalId'] === proposal.id);
      if (done) {
        throw new DomainError('conflict', `proposal ${proposal.id} is already task ${done.id}`);
      }
      const priority = oneOf(input, 'priority', ['low', 'normal', 'high', 'urgent'] as const, true);
      const blockedBy = strings(input, 'blockedBy');
      const extra = {
        ...(priority ? { priority } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      };
      let task: Task;
      if (request.type === 'project_task') {
        const { value } = await ctx.commands.createTask({
          description: str(input, 'description', true) ?? request.description,
          projectId: request.projectId,
          meta: { proposalId: proposal.id },
          ...extra,
        });
        task = value;
      } else if (
        (request.type === 'standalone_task' || request.type === 'new_project') &&
        proposal.kind === 'asteroid'
      ) {
        // A standalone task, or a project the user downsized to an asteroid on the card.
        const description =
          str(input, 'description', true) ??
          (request.type === 'standalone_task' ? request.description : proposal.requestText);
        const { value } = await ctx.commands.createTask({
          description,
          meta: {
            proposalId: proposal.id,
            workspace: checkPath(proposal.workspace),
            // Its Steward also works under this project's (stricter) policy (SPEC §3.5).
            ...(request.type === 'standalone_task' && request.relatedProjectId
              ? { relatedProjectId: request.relatedProjectId }
              : {}),
          },
          ...extra,
        });
        task = value;
      } else {
        throw new DomainError(
          'invalid',
          `proposal ${proposal.id} is a ${proposal.kind} ${request.type}: use ${request.type === 'promotion' ? 'nothing (the server moves it)' : 'create_project'}`,
        );
      }
      return {
        taskId: task.id,
        bodyId: task.bodyId,
        state: task.state,
        ...(task.projectId ? { projectId: task.projectId } : {}),
        ...(task.meta?.['workspace'] ? { workspace: task.meta['workspace'] } : {}),
      };
    },
  };

  const assignBody: BrainTool = {
    name: 'assign_body',
    description:
      'Puts a project or a standalone task on a free body (one that has none). Projects and ' +
      'tasks you create already have one; promotions move bodies through their card.',
    inputSchema: S.obj(
      {
        bodyId: S.str('The free body.'),
        projectId: S.str('The project to host.'),
        taskId: S.str('The standalone task to host.'),
      },
      ['bodyId'],
    ),
    async handler(raw, ctx) {
      const input = asInput(raw);
      const bodyId = str(input, 'bodyId');
      const projectId = str(input, 'projectId', true);
      const taskId = str(input, 'taskId', true);
      if ((projectId === undefined) === (taskId === undefined)) {
        throw new DomainError('invalid', 'give exactly one of projectId and taskId');
      }
      const { value } = await ctx.commands.assignBody(
        bodyId,
        projectId ? { kind: 'project', id: projectId } : { kind: 'task', id: taskId! },
      );
      return { bodyId: value.id, name: value.name, host: value.host };
    },
  };

  // -- agents ------------------------------------------------------------------------------------

  const spawnWaykeeper: BrainTool = {
    name: 'spawn_waykeeper',
    description:
      'Starts the Waykeeper of a project (one per project). It answers to you, or for a ' +
      'sub-project to the planet project’s Waykeeper.',
    inputSchema: S.obj({ projectId: S.str('The project.') }, ['projectId']),
    async handler(raw, ctx) {
      const projectId = str(asInput(raw), 'projectId');
      const project = openProject(ctx.queries, projectId);
      if (project.state === 'proposed') {
        throw new DomainError('invalid_transition', `project ${projectId} is not approved yet`);
      }
      const waykeepers = ctx.queries
        .agents()
        .filter((a) => a.role === 'waykeeper' && a.projectId === projectId);
      const running = waykeepers.find((a) => isLiving(ctx.queries, a.id));
      if (running) {
        throw new DomainError(
          'conflict',
          `project ${projectId} already has Waykeeper ${running.id}`,
        );
      }
      let supervisorId = ctx.brainId;
      if (project.parentProjectId) {
        const parent = ctx.queries
          .agents()
          .filter((a) => a.role === 'waykeeper' && a.projectId === project.parentProjectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const living = parent.find((a) => isLiving(ctx.queries, a.id)) ?? parent[0];
        if (!living) {
          throw new DomainError(
            'invalid',
            `sub-project ${projectId} needs the Waykeeper of ${project.parentProjectId} first`,
          );
        }
        supervisorId = living.id;
      }
      if (!deps.startWaykeeper) {
        throw new DomainError('invalid', 'no Waykeeper brain is available on this server');
      }
      const { agentId } = await deps.startWaykeeper({
        projectId,
        supervisorId,
        runtime: runtimeOf(ctx),
      });
      return { agentId, projectId, supervisorId };
    },
  };

  const spawnSteward: BrainTool = {
    name: 'spawn_steward',
    description:
      'Starts the Steward of a standalone (asteroid) task; you are its supervisor. It works in ' +
      'the workspace the user approved on the task’s card (a related project’s workspace or a ' +
      'scratch folder); only the card changes it. Project tasks get their Stewards from their ' +
      'Waykeeper.',
    inputSchema: S.obj(
      {
        taskId: S.str('The standalone task.'),
        instructions: S.str('Extra instructions for the Steward.'),
      },
      ['taskId'],
    ),
    async handler(raw, ctx) {
      const input = asInput(raw);
      const taskId = str(input, 'taskId');
      if (input['workspace'] !== undefined) {
        // Decisions 3 and 34: the workspace is the user's to change, on the card.
        throw new DomainError(
          'invalid',
          'a Steward works in the workspace approved on its card; only the card changes it',
        );
      }
      const task = must(ctx.queries.task(taskId), 'task', taskId);
      if (task.projectId) {
        throw new DomainError(
          'invalid',
          `task ${taskId} belongs to project ${task.projectId}: its Waykeeper spawns its Stewards`,
        );
      }
      if (
        !['approved', 'in_progress', 'paused', 'interrupted', 'blocked_on_user'].includes(
          task.state,
        )
      ) {
        throw new DomainError('invalid_transition', `task ${taskId} is ${task.state}`);
      }
      const running = ctx.queries
        .agents()
        .find((a) => a.taskId === taskId && isLiving(ctx.queries, a.id));
      if (running) {
        throw new DomainError('conflict', `task ${taskId} already has Steward ${running.id}`);
      }
      const approvedWorkspace = task.meta?.['workspace'];
      if (typeof approvedWorkspace !== 'string' || approvedWorkspace === '') {
        throw new DomainError(
          'invalid',
          `task ${taskId} has no workspace approved on a card: propose it as a standalone task first`,
        );
      }
      const workspace = checkPath(approvedWorkspace);
      try {
        ensureDir(workspace);
      } catch (error) {
        throw new DomainError('invalid', `cannot create ${workspace}: ${(error as Error).message}`);
      }
      const instructions = str(input, 'instructions', true);
      const { value } = await ctx.commands.spawnAgent({
        role: 'steward',
        runtime: runtimeOf(ctx),
        taskId,
        supervisorId: ctx.brainId,
        cwd: workspace,
        prompt: stewardPrompt(task, { workspace, ...(instructions ? { instructions } : {}) }),
      });
      return { agentId: value.id, taskId, workspace, bodyId: value.bodyId };
    },
  };

  const closeTask: BrainTool = {
    name: 'close_task',
    description:
      'Closes a standalone (asteroid) task whose Steward really finished it (decision 11); its ' +
      'Steward is stopped if still running. Project tasks are closed by their Waykeeper.',
    inputSchema: S.obj({ taskId: S.str('The standalone task.') }, ['taskId']),
    async handler(raw, ctx) {
      const taskId = str(asInput(raw), 'taskId');
      const task = must(ctx.queries.task(taskId), 'task', taskId);
      if (task.projectId) {
        throw new DomainError(
          'invalid',
          `task ${taskId} belongs to project ${task.projectId}: its Waykeeper closes it`,
        );
      }
      await ctx.commands.control({ kind: 'task', id: taskId }, { action: 'close' }, ctx.actor);
      return { taskId, state: ctx.queries.task(taskId)?.state };
    },
  };

  const askUser: BrainTool = {
    name: 'ask_user',
    description:
      'Asks the user a clarification question (an escalated question, "anything else on ' +
      '<project>?", a choice only they can make). Ends your turn; the answer arrives later.',
    inputSchema: S.obj(
      {
        text: S.str('The question, self-contained: who asks and about what.'),
        options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers.' },
      },
      ['text'],
    ),
    endsTurn: true,
    async handler(raw, ctx) {
      const input = asInput(raw);
      const options = strings(input, 'options');
      const { value } = await ctx.commands.openQuestion({
        kind: 'clarification',
        originAgentId: ctx.brainId,
        context: { text: str(input, 'text'), ...(options ? { options } : {}) },
      });
      return { questionId: value.id };
    },
  };

  return [
    findRelatedWork,
    sizeRequest,
    propose,
    createProject,
    createTask,
    assignBody,
    spawnWaykeeper,
    spawnSteward,
    proposePromotion,
    closeTask,
    askUser,
    freePlanets,
    freeMoons,
  ];
}

function bodyKind(queries: BrainQueries, project: Project): WorkBodyKind {
  const kind = queries.body(project.bodyId)?.kind;
  return kind === 'planet' || kind === 'asteroid' ? kind : 'moon';
}

/** A short name from the request's first words. */
export function nameFrom(text: string): string {
  const w = words(text).slice(0, 4);
  if (w.length === 0) return text.trim().slice(0, 40) || 'work';
  return w.map((x, i) => (i === 0 ? x[0]!.toUpperCase() + x.slice(1) : x)).join(' ');
}

const PLANET_HINTS =
  /\b(app|application|platform|system|service|product|initiative|website|site)\b/i;
const ASTEROID_HINTS =
  /\b(fix|bug|typo|script|investigate|investigation|check|look into|one-off|quick|small|rename|update|bump)\b/i;

/** A hint only, for when the model gives no size: the model decides (SPEC §3.1). */
export function hintKind(request: string): 'planet' | 'moon' | 'asteroid' {
  if (ASTEROID_HINTS.test(request)) return 'asteroid';
  if (PLANET_HINTS.test(request)) return 'planet';
  return 'moon';
}

function rationaleFor(kind: 'planet' | 'moon', choice: BodyChoice | undefined, parent?: Id) {
  if (!choice) return `a ${kind}`;
  if (choice.ok) {
    return parent
      ? `a sub-project on ${choice.body.name}, a moon of its parent's planet`
      : `a ${kind} project on ${choice.body.name}, the catalogue's first choice`;
  }
  return choice.reason === 'no_free_planet'
    ? 'no planet is free: offer a moon or asteroids, or closing a completed project early; the card is parked'
    : parent
      ? "no moon of the parent's planet is free: it stays a task on the planet"
      : 'no moon is free';
}
