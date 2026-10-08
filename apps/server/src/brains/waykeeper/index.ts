import { commonTools } from '../common-tools.js';
import { DELIVERABLE_TOOLS } from '../deliverable-tools.js';
import type { BrainDefinition } from '../definition.js';
import { STEWARD_TOOLS } from '../steward-tools.js';
import { WAYKEEPER_SYSTEM_PROMPT } from './prompt.js';
import { WAYKEEPER_TOOLS } from './tools.js';

/**
 * The Waykeeper brain (P2-10; SPEC §2.2): one per project, started with
 * `composed.startBrain(waykeeperDefinition(), { runtime, projectId, supervisorId })`.
 */
export function waykeeperDefinition(): BrainDefinition {
  return {
    role: 'waykeeper',
    systemPrompt: WAYKEEPER_SYSTEM_PROMPT,
    tools: [...WAYKEEPER_TOOLS, ...commonTools(), ...STEWARD_TOOLS, ...DELIVERABLE_TOOLS],
  };
}

export * from './prompt.js';
export * from './tools.js';
