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
