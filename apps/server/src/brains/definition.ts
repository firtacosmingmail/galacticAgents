import type {
  Actor,
  Agent,
  AgentRole,
  AgentRuntime,
  Body,
  DomainCommands,
  Id,
  Project,
  Proposal,
  Question,
  RequestOrigin,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import type { Workspaces } from '../workspace/workspaces.js';
import type { WakeRules } from './wake.js';

/**
 * The brain registration seam (P2-06; TECHNOLOGY §5.1): a brain is a system prompt, a tool list
 * and handlers written against `DomainCommands` and read-only `BrainQueries` — never an SDK or
 * runtime import. P2-08 (Harmonizer) and P2-10 (Waykeeper) supply definitions; the runner
 * (`runner.ts`) spawns them through the runtime and drives their turns.
 */

/** What the brain may read about the world without asking anyone (TECHNOLOGY §4.3). */
export interface BrainQueries {
  agent(agentId: Id): Agent | undefined;
  /** The status store's record; reading it costs the supervised agent nothing. */
  status(agentId: Id): StatusRecord | undefined;
  /** Agents whose `supervisorId` is `brainId`, with their status records. */
  supervisedAgents(brainId: Id): { agent: Agent; status?: StatusRecord }[];
  project(projectId: Id): Project | undefined;
  /** Any task, by id (P2-10). */
  task(taskId: Id): Task | undefined;
  /** The tasks of a project, in creation order. */
  projectTasks(projectId: Id): Task[];
  /** Open clarification questions the brain holds or one of its agents asked. */
  openQuestions(brainId: Id): Question[];
  // The whole world, for the Harmonizer's related-work search and status reports (P2-08).
  agents(): Agent[];
  projects(): Project[];
  /** Every task, in creation order. */
  tasks(): Task[];
  task(taskId: Id): Task | undefined;
  body(bodyId: Id): Body | undefined;
  proposal(proposalId: Id): Proposal | undefined;
  proposals(): Proposal[];
  question(questionId: Id): Question | undefined;
  /** Every open question, of any kind and holder. */
  allOpenQuestions(): Question[];
}

/** What a tool handler gets besides its input. */
export interface BrainToolContext {
  brainId: Id;
  role: AgentRole;
  projectId?: Id;
  /** The brain as an actor, for `by` arguments. */
  actor: Actor;
  /**
   * Where the turn's messages came from (P2-21, `originOfMessages`): `local` only when every
   * `message.sent` folded into the turn is a local user's; absent (unknown, floored as remote)
   * otherwise. A tool passes it to the policy-writing commands it calls (`control`, P5-07).
   */
  origin?: RequestOrigin;
  /**
   * The command surface. Every event a call appends is the brain's own side effect: it never
   * wakes the brain, neither mid-turn nor afterwards.
   */
  commands: DomainCommands;
  queries: BrainQueries;
  /**
   * A chat line from the brain to another agent (P2-10): its report to its supervisor, or an
   * instruction to a live Steward it supervises. Logged as `message.sent` with the brain as the
   * sender; refused (throws) when the agent is not running.
   */
  send(agentId: Id, text: string): { messageId: Id };
  /**
   * Workspaces and worktrees (P2-05), when the server was composed with its paths (`index.ts`
   * passes `projectsRoot` and `dataDir`; tests pass temp folders). Absent: tools that need git
   * refuse, and Stewards run in the project's workspace.
   */
  workspaces?: Workspaces;
  /**
   * A Steward's processes (P4-14): list and stop them. Present when the server was composed with
   * the supervisor (`index.ts`; tests inject one). Absent: the process tools refuse.
   */
  processes?: StewardProcessControl;
  /**
   * The runtime new Stewards run on, as the settings say now (P8-07: `stewardRuntime`);
   * `undefined` (or absent) = the brain's own runtime. Read at every Steward spawn.
   */
  stewardRuntime?: () => AgentRuntime | undefined;
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  inputSchema: Record<string, unknown>;
  /**
   * A non-blocking user-facing tool (`ask_user`, `escalate`, `propose`,
   * `request_project_closure`): it creates its object and ends the turn; the answer arrives later
   * as a mailbox event. The names in `TURN_ENDING_TOOLS` end the turn whatever this says.
   */
  endsTurn?: boolean;
  /**
   * Runs in the server. The resolved value is the tool result the model reads; a thrown
   * `DomainError` (or any error) comes back to it as `{ error, message }`, never as a crash.
   */
  handler(input: unknown, ctx: BrainToolContext): Promise<unknown>;
}

export interface BrainDefinition {
  role: Exclude<AgentRole, 'steward'>;
  systemPrompt: string;
  tools: BrainTool[];
  /** An extended wake table (default `WAKE_RULES`). */
  wakeRules?: WakeRules;
  /**
   * Lines for the brain's first turn of a session that starts or resumes (P2-16): what happened
   * while it was not running that no wake event tells it (the Harmonizer: closure requests
   * recorded while it was down). It may act (withdraw a stale question) before the turn starts.
   */
  startNotes?: (ctx: BrainStartContext) => Promise<string[]> | string[];
}

/** What `startNotes` gets. */
export interface BrainStartContext {
  /** Absent for a brain being spawned for the first time (its id is not known yet). */
  brainId?: Id;
  role: AgentRole;
  /** The brain comes back after a restart (or the panel's resume), not a first spawn. */
  resumed: boolean;
  commands: DomainCommands;
  queries: BrainQueries;
}

/** Tools that are non-blocking and end the turn (TECHNOLOGY §5.2). */
export const TURN_ENDING_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'escalate',
  'propose',
  'request_project_closure',
]);

/** The runner's own tool: the summary carried into the next session (session reset). */
export const CARRY_SUMMARY_TOOL = 'carry_summary';
