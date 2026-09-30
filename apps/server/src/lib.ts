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
  type ToolCallRequest,
} from './domain/permissions.js';
export { createSessionHandler } from './ws/session.js';
export { WsGateway, send, type SessionHandler } from './ws/gateway.js';
export {
  ProcessSupervisor,
  isAlive,
  signalGroup,
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
export { EventQueue, collect } from './runtime/event-queue.js';
