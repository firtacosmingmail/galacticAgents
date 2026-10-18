/**
 * @galactic/protocol — the shared vocabulary of GalacticAgents.
 *
 * Everything the server and the web client agree on lives here: domain schemas,
 * event schemas, the WebSocket message schemas, the AgentAdapter interface and the
 * DomainCommands interface. Nothing outside this package redeclares one of these types.
 */
export const PROTOCOL_VERSION = 1 as const;

export * from './primitives.js';
export * from './enums.js';
export * from './domain.js';
export * from './events.js';
export * from './ws.js';
export * from './rest.js';
export * from './adapter.js';
export * from './commands.js';
export * from './summary.js';
export * from './panel.js';
export * from './belt.js';
export * from './dev.js';
export * from './replay.js';
export * from './push.js';
export * from './budget.js';
export * from './storage.js';
export * from './world.js';
export * from './backup.js';
export * from './slash.js';
export * from './deliverables.js';
export * from './remote.js';
export * from './reply.js';
export * from './question-set.js';
