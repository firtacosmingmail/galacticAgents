import type { Actor, Agent, AgentState, EventEnvelope, Id, Task } from '@galactic/protocol';
import type { TurnEnd } from './agent-runtime.js';

/**
 * A Steward's done report (P2-11; SPEC §2.3, §2.7, decision 11). A Steward reports by ending its
 * turn: its last text output is the report, and the server sends it to the Steward's supervisor
 * as a `message.sent` from the Steward, so the supervisor's brain wakes with it (the existing
 * `message.sent` wake rule: a line from an agent it supervises) and decides — close the task, or
 * the Steward is in fact waiting for input and gets an answer.
 *
 * Not every `agent.idle` is a report:
 *   - only a Steward's turn, and only one that ended on its own: a turn cut short by an interrupt,
 *     a pause, a stop or a cap stop is not a report;
 *   - not when a message is already queued for the Steward: its next turn starts at once (it was
 *     sent more work), and that turn's end reports;
 *   - only to a supervisor with a brain mailbox (a live Harmonizer or Waykeeper). Without one the
 *     report is not sent: the task's derived state (`awaiting_closure`) and the supervisor's seed
 *     still show the idle Steward when a supervisor comes back.
 *
 * A Steward that *finishes* (its process exits) is reported by `agent.finished`, which already
 * wakes its supervisor; the runtime fills a missing `result` with the turn's last text.
 *
 * Across a restart (P2-16), with the log:
 *   - a report the supervisor missed (no mailbox when the Steward's turn ended) is sent again when
 *     the supervisor comes back (`resend`), for each idle Steward it supervises that still owes one;
 *   - the first turn of a resumed Steward reports only when its last turn before the restart
 *     still owed one — a resumed idle Steward does not report the same turn twice.
 */

/** What the reports need from the agent runtime (`AgentRuntime` provides it). */
export interface ReportRuntime {
  onTurnEnded(listener: (turn: TurnEnd) => void): () => void;
  hasMailbox(agentId: Id): boolean;
  send(agentId: Id, text: string, opts: { sender: Actor }): { id: string };
}

export interface ReportTables {
  agents: { get(id: Id): Agent | undefined; all(): Agent[] };
  tasks: { get(id: Id): Task | undefined };
}

/** What the restart handling reads (P2-16). Without it, every turn end is reported as before. */
export interface ReportHistory {
  /** The log, paged. */
  eventsSince(seq: number, limit: number): EventEnvelope[];
  /** The agent's state in the status store. */
  stateOf(agentId: Id): AgentState | undefined;
  /** The agent's last text output (its transcript), for a report sent again. */
  lastText?(agentId: Id): string | undefined;
}

/** A report longer than this is cut; the whole text stays in the Steward's transcript. */
export const MAX_REPORT_CHARS = 4_000;

/** The line the supervisor reads ("agent <steward> reported: …"). */
export function reportText(task: Task | undefined, text: string | undefined): string {
  const what = task ? `Task ${task.id} ("${task.description}")` : 'Your Steward';
  const body = text?.trim() ?? '';
  const cut =
    body.length > MAX_REPORT_CHARS
      ? `${body.slice(0, MAX_REPORT_CHARS)} … (cut; the whole report is in its transcript)`
      : body;
  return cut === ''
    ? `${what}: the Steward ended its turn without a report.`
    : `${what}: the Steward ended its turn. Its report: ${cut}`;
}

export interface StewardReports {
  /** Message ids of the reports sent so far (tests). */
  readonly sent: { stewardId: Id; supervisorId: Id; messageId: Id; again?: boolean }[];
  /**
   * The supervisor has a mailbox again (P2-16: resumed, or started): every idle Steward it
   * supervises whose last turn end was never reported gets its report sent now. Returns the
   * Stewards reported.
   */
  resend(supervisorId: Id): Id[];
  dispose(): void;
}

const PAGE = 5_000;

/**
 * Whether the Steward's last turn end still owes its supervisor a report (P2-16): an `agent.idle`
 * with no message from the Steward after it, no new message delivered to it, and no end.
 * `beforeLast`: as of just before its last `agent.idle` (the resumed turn that just ended).
 */
export function owesReport(
  log: Pick<ReportHistory, 'eventsSince'>,
  stewardId: Id,
  beforeLast = false,
): boolean {
  let owed = false;
  let beforeLastIdle = false;
  let since = 0;
  for (;;) {
    const page = log.eventsSince(since, PAGE);
    for (const { seq, event } of page) {
      since = seq;
      switch (event.type) {
        case 'agent.idle':
          if (event.agentId !== stewardId) break;
          beforeLastIdle = owed;
          owed = true;
          break;
        case 'message.sent':
          if (event.sender.type === 'agent' && event.sender.id === stewardId) owed = false;
          break;
        case 'message.delivered':
        case 'agent.finished':
        case 'agent.failed':
        case 'agent.stopped':
          if (event.agentId === stewardId) owed = false;
          break;
        default:
          break;
      }
    }
    if (page.length < PAGE) break;
  }
  return beforeLast ? beforeLastIdle : owed;
}

export function stewardReports(
  runtime: ReportRuntime,
  tables: ReportTables,
  onError: (error: unknown, context: string) => void = () => {},
  history?: ReportHistory,
): StewardReports {
  const sent: StewardReports['sent'] = [];
  const report = (agent: Agent, text: string | undefined, again: boolean): boolean => {
    // The current supervisor: a hand-over (P2-12) re-parents the Steward.
    const supervisorId = agent.supervisorId;
    if (!supervisorId || !runtime.hasMailbox(supervisorId)) return false;
    const task = agent.taskId ? tables.tasks.get(agent.taskId) : undefined;
    const body = reportText(task, text);
    try {
      const { id } = runtime.send(
        supervisorId,
        again ? `${body} (Sent again: you were not running when it ended its turn.)` : body,
        { sender: { type: 'agent', id: agent.id } },
      );
      sent.push({ stewardId: agent.id, supervisorId, messageId: id, ...(again ? { again } : {}) });
      return true;
    } catch (error) {
      // The supervisor is stopping: its replacement reads the idle Steward from its seed.
      onError(error, `report of ${agent.id}`);
      return false;
    }
  };
  const unsubscribe = runtime.onTurnEnded((turn) => {
    if (turn.agent.role !== 'steward' || turn.interrupted || turn.queued > 0) return;
    // A resumed Steward's first turn reports only what the restart kept from its supervisor.
    if (turn.resumed && history && !owesReport(history, turn.agent.id, true)) return;
    report(tables.agents.get(turn.agent.id) ?? turn.agent, turn.text, turn.resumed);
  });
  return {
    sent,
    resend(supervisorId) {
      if (!history || !runtime.hasMailbox(supervisorId)) return [];
      const out: Id[] = [];
      for (const agent of tables.agents.all()) {
        if (agent.role !== 'steward' || agent.supervisorId !== supervisorId) continue;
        if (history.stateOf(agent.id) !== 'idle' || !owesReport(history, agent.id)) continue;
        if (report(agent, history.lastText?.(agent.id), true)) out.push(agent.id);
      }
      return out;
    },
    dispose: unsubscribe,
  };
}
