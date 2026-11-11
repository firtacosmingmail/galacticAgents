import { z } from 'zod';
import { ActorType } from './enums.js';
import { Id } from './primitives.js';

/**
 * An agent, the user, or the system itself. `id` is absent for user and system. Lives in its own
 * module so schemas that `domain.ts` embeds (`waykeeper-approvals.ts`) can name it without an
 * import cycle; `domain.ts` re-exports it.
 */
export const Actor = z.object({ type: ActorType, id: Id.optional() });
export type Actor = z.infer<typeof Actor>;
