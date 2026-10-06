import type { DemoClearResponse } from '@galactic/protocol';

/** The one-line outcome of "Clear demo projects" (P7-07). */
export function describeDemoClear(out: DemoClearResponse): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  const done =
    out.projects.length + out.tasks.length + out.retired.length === 0
      ? 'No demo projects to clear'
      : `Cleared ${n(out.projects.length, 'demo project')} and ${n(out.tasks.length, 'task')}; ` +
        `retired ${n(out.retired.length, 'demo planet')}`;
  if (out.skipped.length === 0) return `${done}.`;
  return `${done}; not cleared: ${out.skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}.`;
}
