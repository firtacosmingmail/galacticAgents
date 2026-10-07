import type { Event, Id } from '@galactic/protocol';
import type { EventLog } from '../../domain/event-log.js';

/**
 * The drills' "no data loss" check (P8-04; TECHNOLOGY §6.1, corner case 33): the domain tables
 * must be exactly what the event log says. Every row has the event that created it, every
 * created entity has its row, and each row's state is the last state its events give it — a
 * mutation committed without its event, or an event without its mutation, shows up here. The
 * fold covers what a crash or a failed write could leave half-done: agents (rows and session
 * refs), projects and tasks (states), questions (status, holder, version) and cards (state).
 * The client's reducer (`apps/web/src/state/reduce.ts`) folds the whole log the same way; its
 * conformance test checks every field on a recorded log.
 */

interface Folded {
  agents: Map<Id, { sessionRef?: string }>;
  projects: Map<Id, { state: string }>;
  tasks: Map<Id, { state: string }>;
  questions: Map<Id, { status: string; holder: unknown; version: number }>;
  proposals: Map<Id, { state: string }>;
}

export function foldLog(events: readonly { event: Event }[]): Folded {
  const f: Folded = {
    agents: new Map(),
    projects: new Map(),
    tasks: new Map(),
    questions: new Map(),
    proposals: new Map(),
  };
  const set = <T extends object>(m: Map<Id, T>, id: Id, patch: Partial<T>) => {
    const row = m.get(id);
    if (row) m.set(id, { ...row, ...patch });
  };
  for (const { event: e } of events) {
    switch (e.type) {
      case 'agent.created':
        f.agents.set(e.agent.id, e.agent.sessionRef ? { sessionRef: e.agent.sessionRef } : {});
        break;
      case 'agent.spawned':
        if (e.sessionRef) set(f.agents, e.agentId, { sessionRef: e.sessionRef });
        break;
      case 'project.created':
        f.projects.set(e.project.id, { state: e.project.state });
        break;
      case 'project.state_changed':
        set(f.projects, e.projectId, { state: e.to });
        break;
      case 'task.created':
        f.tasks.set(e.task.id, { state: e.task.state });
        break;
      case 'task.state_changed':
        set(f.tasks, e.taskId, { state: e.to });
        break;
      case 'question.opened':
        f.questions.set(e.question.id, {
          status: e.question.status,
          holder: e.question.holder,
          version: e.question.version,
        });
        break;
      case 'question.escalated':
      case 'question.reassigned':
        set(f.questions, e.questionId, { holder: e.to, version: e.version });
        break;
      case 'question.cancelled':
        set(f.questions, e.questionId, { status: 'cancelled', version: e.version });
        break;
      case 'question.answered':
        set(f.questions, e.questionId, { status: 'answered', version: e.version });
        break;
      case 'proposal.created':
        f.proposals.set(e.proposal.id, { state: e.proposal.state });
        break;
      case 'proposal.approved':
        set(f.proposals, e.proposalId, { state: 'approved' });
        break;
      case 'proposal.edited':
        set(f.proposals, e.proposalId, { state: 'edited' });
        break;
      case 'proposal.rejected':
        set(f.proposals, e.proposalId, { state: 'rejected' });
        break;
      case 'proposal.parked':
        set(f.proposals, e.proposalId, { state: 'parked' });
        break;
      case 'proposal.unparked':
        set(f.proposals, e.proposalId, { state: 'pending' });
        break;
      default:
        break;
    }
  }
  return f;
}

/**
 * Every difference between the tables and the folded log, as readable lines (empty: consistent).
 */
export function logDrift(log: EventLog): string[] {
  const f = foldLog(log.eventsSince(0, Number.MAX_SAFE_INTEGER));
  const drift: string[] = [];
  const compare = <R extends { id: Id }, F>(
    kind: string,
    rows: readonly R[],
    folded: Map<Id, F>,
    pick: (row: R) => F,
  ) => {
    const seen = new Set<Id>();
    for (const row of rows) {
      seen.add(row.id);
      const want = folded.get(row.id);
      if (!want) {
        drift.push(`${kind} ${row.id}: a row without the event that created it`);
        continue;
      }
      const got = pick(row);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        drift.push(`${kind} ${row.id}: row ${JSON.stringify(got)} ≠ log ${JSON.stringify(want)}`);
      }
    }
    for (const id of folded.keys()) {
      if (!seen.has(id)) drift.push(`${kind} ${id}: created in the log but no row`);
    }
  };
  const t = log.tables;
  compare('agent', t.agents.all(), f.agents, (a) =>
    a.sessionRef ? { sessionRef: a.sessionRef } : {},
  );
  compare('project', t.projects.all(), f.projects, (p) => ({ state: p.state }));
  compare('task', t.tasks.all(), f.tasks, (x) => ({ state: x.state }));
  compare('question', t.questions.all(), f.questions, (q) => ({
    status: q.status,
    holder: q.holder,
    version: q.version,
  }));
  compare('proposal', t.proposals.all(), f.proposals, (p) => ({ state: p.state }));
  return drift;
}

/** Whether a process with this pid exists (signal 0); a zombie counts as gone. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

/** Polls `check` every 25 ms until it holds; `false` after `ms`. */
export async function eventually(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** SIGKILL to a pid or a whole group we started (never anything else); gone already is fine. */
export function kill(pidOrGroup: number): void {
  try {
    process.kill(pidOrGroup, 'SIGKILL');
  } catch {
    // already gone
  }
}
