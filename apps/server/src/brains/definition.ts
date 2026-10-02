import type {
  Actor,
  Agent,
  AgentRole,
  Body,
  DomainCommands,
  Id,
  Project,
  Proposal,
  Question,
  StatusRecord,
  Task,
} from '@galactic/protocol';
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
   * The command surface. Every event a call appends is the brain's own side effect: it never
   * wakes the brain, neither mid-turn nor afterwards.
   */
  commands: DomainCommands;
  queries: BrainQueries;
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
