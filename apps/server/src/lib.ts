/** Programmatic surface of the server (tests, `galactic` scripts). `index.ts` is the executable. */
export { buildApp, type App, type AppOptions } from './app.js';
export { loadConfig, type ServerConfig, type LoadedConfig } from './config/config.js';
export { openDatabase } from './db/database.js';
export { migrate, loadMigrations } from './db/migrate.js';
export { tables, type Tables } from './db/tables.js';
export { EventLog, type CommandContext, type CommandOutcome } from './domain/event-log.js';
export { createSessionHandler } from './ws/session.js';
export { WsGateway, send, type SessionHandler } from './ws/gateway.js';
