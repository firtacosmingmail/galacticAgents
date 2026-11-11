import { randomUUID } from 'node:crypto';
import {
  LONG_TERM_LIMITS,
  PANEL_UNCHANGED_DAYS,
  isLongTerm,
  unchangedSince,
  type Id,
} from '@galactic/protocol';
import type { CommandContext } from './event-log.js';
import { waykeeperOf } from './findings.js';
import { jobRuns } from './job-runs.js';
import { panelsOf, suggestPanelRemoval, updatePanel } from './panels.js';
import { FINISHED_WORK } from './states.js';

/**
 * The unchanged-panel nudge (P15-05; SPEC decision 156), made after any job run of a long-term
 * project ends. For each panel reading a job:
 *
 *  - its value changed again since the last suggestion (`unchangedSince` is newer than
 *    `removalSuggestedAt`): the suggestion is cleared, so a later streak can nudge again;
 *  - unchanged for `PANEL_UNCHANGED_DAYS` days with no suggestion yet: the project's Waykeeper gets
 *    ONE system message (it wakes the brain) and `suggestPanelRemoval` marks the panel, so the
 *    next run does not repeat it. The Waykeeper suggests; only Cosmin's card removes a panel.
 *
 * No Waykeeper row, nothing is marked: the nudge waits for one. Returns the panels nudged.
 */
export function nudgeUnchangedPanels(
  ctx: CommandContext,
  projectId: Id,
  isLiving?: (agentId: Id) => boolean,
): Id[] {
  const project = ctx.tables.projects.get(projectId);
  if (!project || !isLongTerm(project) || FINISHED_WORK.has(project.state)) return [];
  const nudged: Id[] = [];
  const dayMs = 86_400_000;
  for (const panel of panelsOf(ctx, projectId)) {
    if (panel.source.kind !== 'job') continue;
    const since = unchangedSince(
      panel,
      jobRuns(ctx, panel.source.jobId, LONG_TERM_LIMITS.runsKept),
    );
    if (since === undefined) continue;
    let suggested = panel.removalSuggestedAt;
    if (suggested !== undefined && since > suggested) {
      updatePanel(ctx, panel.id, { removalSuggestedAt: null }, { type: 'system' });
      suggested = undefined;
    }
    if (suggested !== undefined) continue;
    if (Date.parse(ctx.now) - Date.parse(since) < PANEL_UNCHANGED_DAYS * dayMs) continue;
    const waykeeper = waykeeperOf(ctx, projectId, isLiving);
    if (!waykeeper) continue;
    suggestPanelRemoval(ctx, panel.id);
    ctx.emit({
      type: 'message.sent',
      messageId: `m-${randomUUID()}`,
      agentId: waykeeper.id,
      sender: { type: 'system' },
      text:
        `Panel '${panel.title}' has not changed since ${since.slice(0, 10)}; ` +
        'propose removing it if it is no longer useful',
      interrupt: false,
      fromPanel: panel.id,
    });
    nudged.push(panel.id);
  }
  return nudged;
}
