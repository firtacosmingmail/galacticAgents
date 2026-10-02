import type { Actor, Agent, Id, Task } from '@galactic/protocol';
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
 */

/** What the reports need from the agent runtime (`AgentRuntime` provides it). */
export interface ReportRuntime {
  onTurnEnded(listener: (turn: TurnEnd) => void): () => void;
  hasMailbox(agentId: Id): boolean;
  send(agentId: Id, text: string, opts: { sender: Actor }): { id: string };
}

export interface ReportTables {
  agents: { get(id: Id): Agent | undefined };
  tasks: { get(id: Id): Task | undefined };
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
  readonly sent: { stewardId: Id; supervisorId: Id; messageId: Id }[];
  dispose(): void;
}

export function stewardReports(
  runtime: ReportRuntime,
  tables: ReportTables,
  onError: (error: unknown, context: string) => void = () => {},
): StewardReports {
  const sent: StewardReports['sent'] = [];
  const unsubscribe = runtime.onTurnEnded((turn) => {
    if (turn.agent.role !== 'steward' || turn.interrupted || turn.queued > 0) return;
    const agent = tables.agents.get(turn.agent.id) ?? turn.agent;
    // The current supervisor: a hand-over (P2-12) re-parents the Steward.
    const supervisorId = agent.supervisorId;
    if (!supervisorId || !runtime.hasMailbox(supervisorId)) return;
    const task = agent.taskId ? tables.tasks.get(agent.taskId) : undefined;
    try {
      const { id } = runtime.send(supervisorId, reportText(task, turn.text), {
        sender: { type: 'agent', id: agent.id },
      });
      sent.push({ stewardId: agent.id, supervisorId, messageId: id });
    } catch (error) {
      // The supervisor is stopping: its replacement reads the idle Steward from its seed.
      onError(error, `report of ${agent.id}`);
    }
  });
  return { sent, dispose: unsubscribe };
}
