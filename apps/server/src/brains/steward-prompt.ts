import type { Id, Project, Task, WorkState } from '@galactic/protocol';

/**
 * The Steward's prompt template (P2-11; SPEC §2.3, §2.6, §2.7, §3.5, §3.6): the one first prompt
 * every Steward gets, whoever spawns it — a Waykeeper for a project task (`spawn_steward`, and
 * the respawn that sends a Steward back after a merge conflict), the Harmonizer for an asteroid
 * task. It carries what the supervisor said first (a fake Steward picks its scenario from the
 * prompt's first line), then the task's facts, then the etiquette:
 *
 *   - **report done** by ending the turn with a final message: the server hands the turn's last
 *     text to the supervisor as the Steward's report (`runtime/steward-reports.ts`);
 *   - **ask when unsure** through the runtime's question tool (a clarification question, held by
 *     the supervisor, decision 26), never in prose;
 *   - **never ask permission in prose**: the permission gate decides every tool call (decision 31);
 *   - **declare deliverables** (P9-04, decision 120): what the user will want to open, with
 *     `declare_deliverable` on a runtime that serves the server's tools, else as a "Deliverables:"
 *     list in the "Done:" report (`deliverables/report-block.ts` reads it for the supervisor).
 *
 * Pure text: no SDK, no database. Callers pass what they read from the queries.
 */

export type StewardSupervisor = 'waykeeper' | 'harmonizer';

export interface StewardBrief {
  task: Pick<Task, 'id' | 'description'> & Partial<Pick<Task, 'priority'>>;
  /** The task's project; absent for a standalone (asteroid) task. */
  project?: Pick<Project, 'id' | 'name'>;
  supervisor: StewardSupervisor;
  /** Where the Steward works: its worktree, the project's workspace, or the asteroid's folder. */
  cwd: string;
  /** The task's branch in its own git worktree. */
  branch?: string;
  /** A project without worktrees: the Steward works in the workspace itself, alone. */
  serialised?: boolean;
  /** The supervisor's instructions: what to do and how to know it is done. */
  instructions?: string;
  /** Text that goes before everything else (the send-back after a merge conflict). */
  lead?: string;
  /** Other tasks of the project, so the Steward stays out of their way. */
  related?: Pick<Task, 'id' | 'description' | 'state'>[];
  /**
   * The Steward has `declare_deliverable` (its runtime serves the server's tools: `claude-sdk`,
   * `fake`); `false`: it lists its deliverables in its report (ACP, PTY). Default true.
   */
  declares?: boolean;
}

/** At most this many related tasks are listed. */
export const RELATED_SHOWN = 8;

const SUPERVISOR_NAME: Record<StewardSupervisor, string> = {
  waykeeper: "your project's Waykeeper",
  harmonizer: 'the Harmonizer',
};

const DONE_STATES: ReadonlySet<WorkState> = new Set(['completed', 'archived', 'moved']);

/** The etiquette every Steward follows (exported for tests and the docs). */
export function stewardEtiquette(
  brief: Pick<StewardBrief, 'supervisor' | 'branch' | 'declares'>,
): string[] {
  const boss = SUPERVISOR_NAME[brief.supervisor];
  return [
    'How you work:',
    '- Work on this task only, inside your working directory. Leave other tasks and unrelated files alone.',
    `- Ask when unsure. If the task or the instructions leave a real decision open (a requirement, a choice between approaches, anything you would otherwise guess), ask ONE clear question with your question tool (AskUserQuestion), with options when you can, and wait for the answer. It goes to ${boss}, who answers it or passes it on to the user. Never ask in plain text: nobody reads your messages until your turn ends.`,
    '- Never ask for permission in prose. Make the tool call you need: the project’s permission policy allows it, refuses it with a reason, or asks the user and holds your call until they answer. If a call is refused, do not work around it; say so in your report.',
    '- You run under hard limits (time and tool calls). Work efficiently and do not loop.',
    ...(brief.branch
      ? [
          '- Commit your work on your branch before you report done, and leave the worktree clean. Never switch branches, never push, never merge into the base branch yourself (unless you are told to merge the base branch into yours).',
        ]
      : []),
    ...deliverableEtiquette(brief.declares ?? true),
    `- Report when you stop. End your turn with a final message that is your report to ${boss}: begin it with "Done:" when the task is complete (what you changed, how you checked it — tests, build — and anything left over or risky), or "Not done:" with what stops you. That last message is delivered as your report; ${boss} decides whether the task is closed or gives you more to do. Every end of your turn counts as a report, so do not stop half-way unless you are blocked.`,
  ];
}

/** The line that asks for deliverables: the tool, or the report's list (decision 120). */
export function deliverableEtiquette(declares: boolean): string[] {
  const what =
    'what the user will want to open when you are done — an app, a report, a screenshot, a generated folder, a command to run (a dev server, a script), an address — not every file you changed, and never a secret (.env, keys)';
  return declares
    ? [
        `- Deliverables. Before your final report, declare ${what} with declare_deliverable (kind, title, and the path inside your working directory, the command or the address). Prefer declaring a command such as the dev server to leaving one running. list_deliverables shows what your task already has.`,
      ]
    : [
        `- Deliverables. You cannot declare deliverables yourself, so list ${what} in your "Done:" report under a line "Deliverables:", one per line, exactly: "- <kind> | <path, command or address> | <title>", where kind is file, image, folder, app, command or url and a path is relative to your working directory. Example: "- image | screenshots/home.png | Home page screenshot". ${'Your supervisor declares them.'}`,
      ];
}

export function stewardPrompt(brief: StewardBrief): string {
  const { task, project, cwd } = brief;
  const head = [brief.lead?.trim(), brief.instructions?.trim()].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  const facts = [
    `Your task (${task.id})${task.priority && task.priority !== 'normal' ? `, priority ${task.priority}` : ''}: ${task.description}`,
    project
      ? `Project: "${project.name}" (${project.id}). You report to ${SUPERVISOR_NAME[brief.supervisor]}.`
      : `A standalone task, not part of a project. You report to ${SUPERVISOR_NAME[brief.supervisor]}.`,
    `Working directory: ${cwd}. Stay inside it.`,
    brief.branch
      ? `You are on branch ${brief.branch} in your own git worktree of the project's repository.`
      : brief.serialised
        ? 'This workspace has no worktrees: you are the only Steward working in it right now.'
        : project
          ? 'You work in the project workspace itself.'
          : 'This folder may be someone’s working copy: do not commit, push or switch branches unless your instructions say so.',
  ];
  const related = relatedLines(task.id, brief.related ?? []);
  return [
    ...(head.length > 0 ? [head.join('\n\n'), '', '---'] : []),
    ...facts,
    ...(related.length > 0 ? ['', 'Other tasks of the project (not yours):', ...related] : []),
    '',
    ...stewardEtiquette(brief),
  ].join('\n');
}

function relatedLines(self: Id, tasks: Pick<Task, 'id' | 'description' | 'state'>[]): string[] {
  const others = tasks.filter((t) => t.id !== self && t.state !== 'archived');
  // Open work first: that is what the Steward could collide with.
  const ordered = [
    ...others.filter((t) => !DONE_STATES.has(t.state)),
    ...others.filter((t) => DONE_STATES.has(t.state)),
  ];
  const lines = ordered
    .slice(0, RELATED_SHOWN)
    .map((t) => `- ${t.id} [${t.state}]: ${t.description}`);
  if (ordered.length > RELATED_SHOWN) lines.push(`- … and ${ordered.length - RELATED_SHOWN} more`);
  return lines;
}
