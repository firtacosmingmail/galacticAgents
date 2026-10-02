/** Programmatic surface of the server (tests, `galactic` scripts). `index.ts` is the executable. */
export { buildApp, type App, type AppOptions } from './app.js';
export { loadConfig, type ServerConfig, type LoadedConfig } from './config/config.js';
export { openDatabase } from './db/database.js';
export { migrate, loadMigrations } from './db/migrate.js';
export { tables, type Tables } from './db/tables.js';
export { EventLog, type CommandContext, type CommandOutcome } from './domain/event-log.js';
export {
  evaluate as evaluatePermission,
  classifyToolCall,
  classifyCommand,
  decide as decidePermission,
  resolvePolicy,
  isInsideWorkspace,
  type PolicyContext,
  type PolicyVerdict,
} from './domain/permissions.js';
export { createSessionHandler } from './ws/session.js';
export { WsGateway, send, type SessionHandler } from './ws/gateway.js';
export {
  ProcessSupervisor,
  INHERITED_ENV,
  isAlive,
  signalGroup,
  type ProcessOutcome,
  type ProcessSpec,
  type ManagedProcess,
  type StopProcessOptions,
  type RestartPolicy,
  type ExitInfo,
  type ReconcileResult,
} from './runtime/supervisor.js';
export {
  MemoryProcessStore,
  SqliteProcessStore,
  type ProcessRecord,
  type ProcessStore,
} from './runtime/process-store.js';
export { EventQueue } from './lib/event-queue.js';
export { TranscriptPipeline, type TranscriptListener } from './runtime/transcripts.js';
export { redactSecrets, redactEvent, containsSecret, REDACTION_RULES } from './runtime/redact.js';
export { AgentRuntime, type SpawnRequest, type SpawnResult } from './runtime/agent-runtime.js';
export { AgentInbox, type InboxMessage } from './runtime/inbox.js';
export { createPermissionGate, type GateOptions } from './runtime/permission-gate.js';
export { createAgent, recordSpawned, updateAgent } from './domain/agents.js';
export {
  openQuestion,
  answerQuestion,
  escalateQuestion,
  reassignQuestion,
  openQuestionsOf,
} from './domain/questions.js';
export { Commands, type AgentControl, type CommandsOptions } from './domain/commands.js';
export {
  agentEffect,
  agentsOf,
  applyControlState,
  concernedSupervisors,
  retentionDue,
} from './domain/cascade.js';
export { DomainError } from './domain/errors.js';
export { TRANSITIONS, canTransition } from './domain/states.js';
export { buildSnapshot } from './ws/snapshot.js';
export { CapsEnforcer, DEFAULT_CAPS, type CapUsage } from './runtime/caps.js';
export { StatusStore, type StatusListener } from './runtime/status-store.js';
export { WorkStateDeriver } from './runtime/work-state-deriver.js';
export {
  PROJECT_RULES,
  TASK_RULES,
  deriveProjectState,
  deriveTaskState,
  type AgentFact,
  type AgentPhase,
  type WorkFacts,
} from './domain/work-states.js';
export { composeRuntime, STALL_THRESHOLDS_MS, type ComposedRuntime } from './runtime/compose.js';
export { FakeAdapter, SCENARIOS, type FakeScenario, type FakeStep } from './adapters/fake/index.js';
export {
  ClaudeSdkAdapter,
  CLAUDE_PASS_ENV,
  type ClaudeSdkAdapterOptions,
} from './adapters/claude-sdk/index.js';
export {
  BrainRunner,
  WAKE_RULES,
  TURN_ENDING_TOOLS,
  CARRY_SUMMARY_TOOL,
  wakeLine,
  createBrainQueries,
  createWakeScope,
  renderSeed,
  type BrainDefinition,
  type BrainTool,
  type BrainToolContext,
  type BrainQueries,
  type BrainPlacement,
  type BrainRunnerOptions,
  type SessionResetPolicy,
  type WakeRule,
  type WakeRules,
  type WakeScope,
} from './brains/index.js';
export {
  Workspaces,
  WorkspaceMeta,
  stewardsSerialised,
  workspaceMeta,
  branchName,
  slugify,
  type WorkspaceInfo,
  type WorkspacesOptions,
  type WorktreeInfo,
  type MergeResult,
  type MergeConflict,
  type MergeRecord,
  type ExternalCommit,
  EXTERNAL_COMMITS_SHOWN,
} from './workspace/workspaces.js';
export { gitRunner, GitError, SAFE_GIT_CONFIG, type Git } from './workspace/git.js';
