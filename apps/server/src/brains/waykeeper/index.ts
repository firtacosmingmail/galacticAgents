import { commonTools } from '../common-tools.js';
import { DELIVERABLE_TOOLS } from '../deliverable-tools.js';
import type { BrainDefinition } from '../definition.js';
import { projectProviderNote } from '../provider-input.js';
import { STEWARD_TOOLS } from '../steward-tools.js';
import { WAYKEEPER_JOB_TOOLS } from './job-tools.js';
import { WAYKEEPER_PANEL_TOOLS } from './panel-tools.js';
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
    // What the user said about which AI does what is in the planning turn itself (P11-08).
    startNotes: (ctx) => {
      const project = ctx.projectId ? ctx.queries.project(ctx.projectId) : undefined;
      const note = project ? projectProviderNote(ctx.queries, project) : undefined;
      return !ctx.resumed && note ? [`Provider note on the approved request: ${note}`] : [];
    },
    tools: [
      ...WAYKEEPER_TOOLS,
      ...WAYKEEPER_JOB_TOOLS,
      ...WAYKEEPER_PANEL_TOOLS,
      ...commonTools(),
      ...STEWARD_TOOLS,
      ...DELIVERABLE_TOOLS,
    ],
  };
}

export * from './prompt.js';
export * from './tools.js';
export * from './job-tools.js';
export * from './panel-tools.js';
