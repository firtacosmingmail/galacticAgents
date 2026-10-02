import {
  PERMISSION_POLICY_PRESETS,
  proposalPromotion,
  proposalTrust,
  type Body,
  type Project,
  type Proposal,
  type Task,
} from '@galactic/protocol';
import type { ChooseOptions } from './catalogue.js';
import type { CommandContext } from './event-log.js';
import type { HandOverOptions } from './handover.js';
import type { PolicyWrite } from './permissions.js';
import { requestOf } from './parking.js';
import { createProject } from './projects.js';
import { createPromotedProject, moveProject } from './promotion.js';
import { createTask } from './tasks.js';

/**
 * What approving a work card sets in motion (P2-09; SPEC §3.3, decisions 3 and 34). The approval
 * transaction itself creates what the card asks for, as the user left it — the project on the
 * body the card names (or the catalogue's choice when that body was taken meanwhile), or the
 * task — so the body is assigned atomically with the approval and nothing the model does can
 * diverge from the card. The Harmonizer is woken by `proposal.approved` and starts the agents
 * (`spawn_waykeeper`, `spawn_steward`); its `create_project` / `create_task` only return what the
 * approval created.
 */

export interface ProposalOptions extends ChooseOptions {
  /**
   * Validates a card's workspace and returns its canonical path (the server passes
   * `Workspaces.checkPath`): a user's edit and the approval are refused for `/`, the home
   * directory, the projects root or the data directory (decision 27). Default: unchecked.
   */
  checkWorkspace?: (path: string) => string;
  /** Hand-overs of a promotion moved in the approval (P2-12): prefer a living supervisor. */
  handOver?: HandOverOptions;
  /**
   * How the approval's policy write is judged (P2-21): the trust level chosen on the card
   * (decision 49) becomes the new project's policy through `policyForWrite`, so a remote (or
   * unknown) approval is floored at the global default. Absent: unknown origin.
   */
  policyWrite?: PolicyWrite;
}

export type CarriedOut =
  | { kind: 'project'; project: Project }
  | { kind: 'task'; task: Task }
  | { kind: 'moved'; project: Project }
  | { kind: 'nothing' };

/**
 * Creates what the approved card `p` asks for. `body` is the free planet or moon a new project
 * gets (from `roomFor`); `workspace` the card's workspace, already checked. A card without
 * `meta.request` creates nothing here. A promotion (either card shape) takes its body here, so
 * the body is the approval's and nothing can take it before the flow runs: a task's new project
 * is created on it (`createPromotedProject`), a project target moves to it (`moveProject`); the
 * rest — the Waykeeper, the task's move, the Stewards — is `brains/promotion.ts`'s (P2-12).
 */
export function carryOut(
  ctx: CommandContext,
  p: Proposal,
  body: Body | undefined,
  workspace: string,
  opts: ProposalOptions = {},
): CarriedOut {
  const promotion = proposalPromotion(p);
  if (promotion) {
    if (!body || promotion.toProjectId) return { kind: 'nothing' };
    if (promotion.target.kind === 'task') {
      return { kind: 'project', project: createPromotedProject(ctx, { ...p, workspace }, body) };
    }
    moveProject(ctx, promotion.target.id, body.id, opts.handOver ?? {});
    return { kind: 'moved', project: ctx.tables.projects.get(promotion.target.id)! };
  }
  const request = requestOf(p);
  if (!request || request.type === 'promotion') return { kind: 'nothing' };
  const proposalId = p.id;
  if (request.type === 'project_task') {
    if (!request.projectId) return { kind: 'nothing' };
    const task = createTask(ctx, {
      description: request.description ?? p.requestText,
      projectId: request.projectId,
      meta: { proposalId },
    });
    return { kind: 'task', task };
  }
  if (p.kind === 'asteroid') {
    // A standalone task, or a project the user downsized to an asteroid on the card.
    const task = createTask(ctx, {
      description:
        request.type === 'standalone_task' ? (request.description ?? p.requestText) : p.requestText,
      meta: {
        proposalId,
        workspace,
        // Its Steward also works under this project's (stricter) policy (SPEC §3.5).
        ...(request.type === 'standalone_task' && request.relatedProjectId
          ? { relatedProjectId: request.relatedProjectId }
          : {}),
      },
    });
    return { kind: 'task', task };
  }
  const parentProjectId =
    request.type === 'new_project' && p.kind === 'moon' ? request.parentProjectId : undefined;
  // The trust level the user chose on the card (decision 49); `default` writes no policy.
  const trust = proposalTrust(p);
  const project = createProject(
    ctx,
    {
      name: request.name,
      workspace,
      kind: p.kind,
      ...(body ? { bodyId: body.id } : {}),
      ...(parentProjectId ? { parentProjectId } : {}),
      ...(trust !== 'default' ? { permissionPolicy: PERMISSION_POLICY_PRESETS[trust] } : {}),
      // The user's consent on the card (decision 27): `Workspaces.prepareProject` reads it.
      meta: { proposalId, ...(p.meta?.['initGit'] === true ? { initGit: true } : {}) },
    },
    opts,
    opts.policyWrite ?? {},
  );
  return { kind: 'project', project };
}
