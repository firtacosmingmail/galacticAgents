import type { Project, Question, Task } from './domain.js';

/**
 * The system summary counts (P2-15; SPEC §4.4): what the header badge, the beacon and the
 * Harmonizer's status line show. A pure function of the domain rows, so the server (from its
 * tables or a snapshot) and the client (from its folded world) compute the same numbers from the
 * same state, and nothing extra travels on the wire: task and project states are already rows,
 * written by the server's derivation (TECHNOLOGY §4, §6.2).
 */
export interface SystemSummary {
  /** Every open question, whoever holds it. */
  openQuestions: number;
  /** Open questions the user must answer (`holder.type === 'user'`): permission or escalated. */
  userQuestions: number;
  blockedTasks: number;
  blockedProjects: number;
  /** Tasks plus projects blocked on the user. */
  blockedItems: number;
}

export interface SummaryInput {
  questions: Iterable<Question>;
  tasks: Iterable<Task>;
  projects: Iterable<Project>;
}

export function summarize(input: SummaryInput): SystemSummary {
  let openQuestions = 0;
  let userQuestions = 0;
  for (const q of input.questions) {
    if (q.status !== 'open') continue;
    openQuestions++;
    if (q.holder.type === 'user') userQuestions++;
  }
  let blockedTasks = 0;
  for (const t of input.tasks) if (t.state === 'blocked_on_user') blockedTasks++;
  let blockedProjects = 0;
  for (const p of input.projects) if (p.state === 'blocked_on_user') blockedProjects++;
  return {
    openQuestions,
    userQuestions,
    blockedTasks,
    blockedProjects,
    blockedItems: blockedTasks + blockedProjects,
  };
}
