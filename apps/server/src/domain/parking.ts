import {
  foldProposalMeta,
  proposalParking,
  proposalPlan,
  proposalPromotion,
  type Body,
  type BodyChoice,
  type BodyRequest,
  type Id,
  type ParkOffer,
  type PromotionRequest,
  type Proposal,
  type ProposalParking,
  type ProposedBody,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import {
  chooseBody,
  describeRefusal,
  isCatalogued,
  isFree,
  type ChooseOptions,
  type Reader,
} from './catalogue.js';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Parking (P2-09; SPEC §3.3, decisions 1 and 16). A work card that needs a new planet or moon
 * when none is free is parked by the server — never by the model — with what the card shows: the
 * occupied bodies and their occupants, and the offers (downsize, close a completed project
 * early). It un-parks by itself, deterministically, when a body of its kind frees (`body.freed`,
 * in the freeing transaction) or when the user edits it; a card the user parked by hand stays
 * parked until they decide it again.
 *
 * Which cards need a body is read from `meta.request` (the Harmonizer's record of what the card
 * asks for, P2-08): a new project, a standalone task resized to a moon or planet, and a promotion
 * to a bigger body. A Waykeeper's promotion card (`meta.promotion`) needs one too: a moon of its
 * project's planet, or a planet (`promotionBodyRequest`), so it parks and un-parks like the
 * Harmonizer's cards — one body rule for both. A task added to a project lives on the project's
 * body; a plan card is the Waykeeper's and never parks (decision 35); a card without
 * `meta.request` asks for nothing the server can place, and is left as it is.
 */

/** The part of the Harmonizer's `meta.request` the server reads (brains own the full type). */
export interface CardRequest {
  type: 'new_project' | 'standalone_task' | 'project_task' | 'promotion';
  name: string;
  description?: string;
  parentProjectId?: Id;
  relatedProjectId?: Id;
  projectId?: Id;
  toProjectId?: Id;
  target?: { kind: 'task' | 'project'; id: Id };
}

const TYPES = new Set(['new_project', 'standalone_task', 'project_task', 'promotion']);

/** What the card asks for, when the Harmonizer recorded it. */
export function requestOf(p: Pick<Proposal, 'meta'>): CardRequest | undefined {
  const r = p.meta?.['request'] as Partial<CardRequest> | undefined;
  if (!r || typeof r !== 'object' || !TYPES.has(r.type as string)) return undefined;
  if (typeof r.name !== 'string') return undefined;
  return r as CardRequest;
}

/**
 * The project a Waykeeper's moon becomes a sub-project of (SPEC §3.2): the requesting project —
 * unless the user put the card on a moon of another planet, which makes it a project of its own.
 */
export function promotedParent(ctx: Reader, p: Proposal, req: PromotionRequest): Id | undefined {
  if (req.target.kind !== 'task' || !req.fromProjectId || p.kind !== 'moon') return undefined;
  const from = ctx.tables.projects.get(req.fromProjectId);
  if (!from) return undefined;
  const named = p.proposedBody.bodyId ? ctx.tables.bodies.get(p.proposedBody.bodyId) : undefined;
  return !named || named.parentId === from.bodyId ? from.id : undefined;
}

/** The catalogue request of a promotion that needs a new body (none for a move into a project). */
export function promotionBodyRequest(ctx: Reader, p: Proposal): BodyRequest | undefined {
  const req = proposalPromotion(p);
  if (!req || req.toProjectId || p.kind === 'asteroid') return undefined;
  if (p.kind === 'planet') return { kind: 'planet' };
  const parentProjectId = promotedParent(ctx, p, req);
  return parentProjectId ? { kind: 'moon', parentProjectId } : { kind: 'moon' };
}

/** The body a card needs from the catalogue, or `undefined` when it needs none. */
export function bodyRequestOf(ctx: Reader, p: Proposal): BodyRequest | undefined {
  if (proposalPlan(p) || p.kind === 'asteroid') return undefined;
  // A promotion card of either shape (the Harmonizer's `meta.request`, a Waykeeper's
  // `meta.promotion`): the same request the promotion flow places it with.
  if (proposalPromotion(p)) return promotionBodyRequest(ctx, p);
  const request = requestOf(p);
  if (!request) return undefined;
  if (request.type === 'project_task' || request.type === 'promotion') return undefined;
  if (p.kind === 'planet') return { kind: 'planet' };
  return request.type === 'new_project' && request.parentProjectId
    ? { kind: 'moon', parentProjectId: request.parentProjectId }
    : { kind: 'moon' };
}

/** A reader in which the `claimed` bodies are not free (other cards already propose them). */
function claimedReader(ctx: Reader, claimed: ReadonlySet<Id>): Reader {
  if (claimed.size === 0) return ctx;
  const hide = (b: Body): Body =>
    claimed.has(b.id) ? { ...b, meta: { ...(b.meta ?? {}), reserved: true } } : b;
  const bodies = ctx.tables.bodies;
  return {
    tables: {
      ...ctx.tables,
      bodies: {
        ...bodies,
        all: () => bodies.all().map(hide),
        get: (id: Id) => {
          const b = bodies.get(id);
          return b ? hide(b) : undefined;
        },
      },
    } as unknown as Tables,
  };
}

/**
 * The body a card would get now: the one it names, while that is free, of its kind and (for a
 * sub-project) a moon of the parent's planet; else the catalogue's choice (decision 10).
 */
export function roomFor(
  ctx: Reader,
  p: Proposal,
  opts: ChooseOptions = {},
  claimed: ReadonlySet<Id> = new Set(),
): BodyChoice | undefined {
  const request = bodyRequestOf(ctx, p);
  if (!request) return undefined;
  const reader = claimedReader(ctx, claimed);
  const named = p.proposedBody.bodyId ? reader.tables.bodies.get(p.proposedBody.bodyId) : undefined;
  if (named && named.kind === request.kind && isFree(named) && isCatalogued(named)) {
    const parentPlanet =
      request.kind === 'moon' && request.parentProjectId
        ? ctx.tables.projects.get(request.parentProjectId)?.bodyId
        : undefined;
    if (!parentPlanet || named.parentId === parentPlanet) return { ok: true, body: named };
  }
  return chooseBody(reader, request, opts);
}

const proposed = (p: Proposal, body: Body): ProposedBody => ({
  kind: p.kind,
  name: p.proposedBody.name,
  bodyId: body.id,
  ...(body.parentId ? { parentId: body.parentId } : {}),
});

/** What the parked card shows for a refusal (decision 16). */
export function parkingFor(
  request: BodyRequest,
  choice: Exclude<BodyChoice, { ok: true }>,
): ProposalParking {
  const offers: ParkOffer[] =
    request.kind === 'planet'
      ? ['downsize_moon', 'downsize_asteroid', 'close_early']
      : 'parentProjectId' in request && request.parentProjectId
        ? ['task_on_planet', 'close_early']
        : ['downsize_asteroid', 'close_early'];
  return {
    reason: `${describeRefusal(choice)}; the card waits for a free ${request.kind}`,
    waitingFor: request.kind,
    occupied: choice.occupied,
    offers,
  };
}

function save(ctx: CommandContext, p: Proposal, changes: Partial<Proposal>): Proposal {
  const next: Proposal = { ...p, ...changes, updatedAt: ctx.now };
  if (next.meta === undefined) delete next.meta;
  return ctx.tables.proposals.upsert(next);
}

/** Parks `p` with `parking` (the decision 16 card), in the caller's transaction. */
export function park(ctx: CommandContext, p: Proposal, parking: ProposalParking): Proposal {
  const meta = foldProposalMeta(p.meta, { parked: parking });
  const next = save(ctx, p, { state: 'parked', meta });
  ctx.emit({ type: 'proposal.parked', proposalId: p.id, ...parking });
  return next;
}

/**
 * Parks a card that needs a body when none is free (decision 16); returns the card as it now
 * is. Only a card waiting for the user (`pending`, `edited`) is parked.
 */
export function parkIfNoRoom(ctx: CommandContext, p: Proposal, opts: ChooseOptions = {}): Proposal {
  if (p.state !== 'pending' && p.state !== 'edited') return p;
  const request = bodyRequestOf(ctx, p);
  if (!request) return p;
  const choice = roomFor(ctx, p, opts);
  if (!choice || choice.ok) return p;
  return park(ctx, p, parkingFor(request, choice));
}

/** The bodies the cards waiting for the user already propose (a free body on a live card). */
function claimedBodies(ctx: Reader): Set<Id> {
  const claimed = new Set<Id>();
  for (const p of ctx.tables.proposals.all()) {
    if (p.state !== 'pending' && p.state !== 'edited') continue;
    if (!bodyRequestOf(ctx, p) || !p.proposedBody.bodyId) continue;
    const body = ctx.tables.bodies.get(p.proposedBody.bodyId);
    if (body && isFree(body)) claimed.add(body.id);
  }
  return claimed;
}

/**
 * Un-parks every card the server parked for lack of room that now has room, oldest first, each
 * on its own body: a freed planet goes to one card, never to two (the bodies live cards already
 * propose count as taken). The card is `pending` again and proposes the body it gets; the
 * Harmonizer is woken by `proposal.unparked` to tell the user. Runs inside the transaction that
 * freed the body, so `body.freed` and the un-parking commit together. A card the catalogue cannot
 * place at all (a sub-project whose parent left its planet, say) stays parked: it never fails the
 * command that freed the body.
 */
export function unparkWaiting(ctx: CommandContext, opts: ChooseOptions = {}): Proposal[] {
  const waiting = ctx.tables.proposals
    .all()
    .filter((p) => p.state === 'parked' && proposalParking(p)?.waitingFor !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (waiting.length === 0) return [];
  const claimed = claimedBodies(ctx);
  const out: Proposal[] = [];
  for (const p of waiting) {
    let choice: BodyChoice | undefined;
    try {
      choice = roomFor(ctx, p, opts, claimed);
    } catch (error) {
      if (error instanceof DomainError) continue;
      throw error;
    }
    if (!choice?.ok) continue;
    claimed.add(choice.body.id);
    const proposedBody = proposed(p, choice.body);
    const meta = foldProposalMeta(p.meta, { parked: null });
    out.push(save(ctx, p, { state: 'pending', proposedBody, meta }));
    ctx.emit({
      type: 'proposal.unparked',
      proposalId: p.id,
      proposedBody,
      reason: `${choice.body.name} is free`,
    });
  }
  return out;
}
