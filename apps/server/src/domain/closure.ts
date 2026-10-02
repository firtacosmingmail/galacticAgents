import type { Id, Project } from '@galactic/protocol';
import type { CommandContext } from './event-log.js';
import { cancelQuestion } from './questions.js';

/**
 * The project closure relay (P2-13; SPEC §2.7, decisions 11 and 36). The Waykeeper's
 * `request_project_closure` records `project.meta.closureRequest = {by, summary, tasks}` and
 * reports to the Harmonizer; the Harmonizer's `ask_closure` asks the user "Anything else on
 * <project>?" and adds the question's id (`questionId`) to the record. Only the user closes the
 * project: `control.close` (the panel, or the Harmonizer carrying out the user's answer) stops the
 * Waykeeper and its Stewards, sets `completed` and starts the retention clock (`retention.ts`).
 * Closing withdraws the "anything else?" question if it is still open: it is answered by the act.
 */

export interface ClosureRequest {
  /** The Waykeeper that asked. */
  by: Id;
  summary: string;
  tasks: number;
  /** The Harmonizer's "anything else?" question, once asked. */
  questionId?: Id;
}

export function closureRequestOf(project: Project | undefined): ClosureRequest | undefined {
  const request = project?.meta?.['closureRequest'];
  return request && typeof request === 'object' ? (request as ClosureRequest) : undefined;
}

/** Withdraws the project's open "anything else?" question (closing answers it). */
export function withdrawClosureQuestion(ctx: CommandContext, projectId: Id, reason: string): void {
  const questionId = closureRequestOf(ctx.tables.projects.get(projectId))?.questionId;
  if (questionId) cancelQuestion(ctx, questionId, reason);
}
