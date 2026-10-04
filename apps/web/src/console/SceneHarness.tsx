import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ENDED_STATES, type HarnessState, type Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { createHarnessApi, type HarnessApi } from './harness-api.js';
import {
  ACTIVITY_BUTTONS,
  EXIT_CRITERIA,
  STATE_BUTTONS,
  harnessRows,
  moveTargets,
  openQuestionsOf,
  settleLatency,
  workActions,
  type HarnessRow,
  type Latency,
} from './harness-model.js';

/**
 * The scene harness (P4-06): a `/debug` tab that drives the solar-system scene through the
 * server's development-only `/dev/harness/*` routes — seed a scenario (a project with a Waykeeper
 * and Stewards, a standalone task on an asteroid), pick an agent, switch its state and activity,
 * move / complete / close its work, ask and answer questions, fail or stop it, and clear what the
 * harness made. Everything is a real event: the panel's scene (open it in another window) shows it
 * as it would show an agent doing it. The tab also lists Phase 4's exit criteria and how to check
 * each one with these buttons.
 */
export function SceneHarness({ token }: { token: string }) {
  const api = useMemo(() => createHarnessApi(token), [token]);
  const world = useAppStore((s) => s.world);
  const live = useAppStore((s) => s.status === 'live');
  const [selected, setSelected] = useState<Id | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState<Latency | undefined>();

  // The click → page time of the last state switch, settled by the status stream as it arrives.
  useEffect(
    () =>
      useAppStore.subscribe((state, prev) => {
        if (state.world.statuses === prev.world.statuses) return;
        setLatency((l) => settleLatency(l, state.world.statuses, performance.now()));
      }),
    [],
  );

  const rows = harnessRows(world);
  const current = rows.find((r) => r.agent.id === selected) ?? rows[0];

  /** Runs one harness call; a refusal is shown, a success may leave a note. */
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setNote(done);
    } catch (e) {
      setNote(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="console harness">
      <h2>Scene harness</h2>
      <p className="muted">
        Development only. Every button writes real events through the server’s commands; open the
        panel (<a href="/">/</a>) in a second window with the scene shown to watch the satellites.
      </p>
      <ScenarioForm api={api} disabled={busy || !live} run={run} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p className="muted">{note}</p>}
      {rows.length === 0 ? (
        <p className="muted">
          No harness agents yet — seed a demo scenario above (real agents are never listed).
        </p>
      ) : (
        <div className="console-grid">
          <ul className="agent-list" aria-label="Agents">
            {rows.map((row) => (
              <li key={row.agent.id}>
                <button
                  className={`agent-row ${current?.agent.id === row.agent.id ? 'selected' : ''}`}
                  aria-pressed={current?.agent.id === row.agent.id}
                  onClick={() => setSelected(row.agent.id)}
                >
                  <span className={`pill state-${row.state ?? 'unknown'}`}>{row.state ?? '…'}</span>
                  <span className="agent-name">{row.label}</span>
                  <span className="muted activity">
                    {row.bodyName ? `${row.bodyName} · ` : ''}
                    {row.activity ?? ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <AgentControls
              key={current.agent.id}
              row={current}
              api={api}
              disabled={busy || !live}
              run={run}
              latency={latency?.agentId === current.agent.id ? latency : undefined}
              onSwitch={(state) =>
                setLatency({ agentId: current.agent.id, state, startedAt: performance.now() })
              }
            />
          )}
        </div>
      )}
      <ExitCriteria />
    </section>
  );
}

type Run = (action: () => Promise<unknown>, done?: string) => Promise<void>;

function ScenarioForm({ api, disabled, run }: { api: HarnessApi; disabled: boolean; run: Run }) {
  const [stewards, setStewards] = useState(3);
  const [kind, setKind] = useState<'planet' | 'moon'>('planet');
  const [asteroid, setAsteroid] = useState(true);
  const seed = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const out = await api.scenario({ stewards, kind, asteroid });
      return out;
    }, 'Scenario seeded: its Waykeeper and Stewards are working.');
  };
  const clear = () =>
    void run(async () => {
      const out = await api.clear();
      if (out.skipped.length > 0) {
        throw new Error(
          `cleared ${out.projects.length} projects and ${out.tasks.length} tasks; not cleared: ` +
            out.skipped.map((s) => `${s.id} (${s.reason})`).join('; '),
        );
      }
    }, 'Harness scenario cleared: fake agents stopped, its tasks and projects archived.');
  return (
    <form className="spawn" onSubmit={seed} aria-label="Scenario">
      <label>
        Stewards
        <input
          type="number"
          min={0}
          max={8}
          value={stewards}
          onChange={(e) => setStewards(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
        />
      </label>
      <label>
        on a
        <select value={kind} onChange={(e) => setKind(e.target.value as 'planet' | 'moon')}>
          <option value="planet">planet</option>
          <option value="moon">moon</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={asteroid} onChange={(e) => setAsteroid(e.target.checked)} />
        plus an asteroid task
      </label>
      <button type="submit" disabled={disabled}>
        Seed demo scenario
      </button>
      <button type="button" className="secondary" disabled={disabled} onClick={clear}>
        Clear harness scenario
      </button>
    </form>
  );
}

function AgentControls({
  row,
  api,
  disabled,
  run,
  latency,
  onSwitch,
}: {
  row: HarnessRow;
  api: HarnessApi;
  disabled: boolean;
  run: Run;
  latency: Latency | undefined;
  onSwitch: (state: HarnessState) => void;
}) {
  const world = useAppStore((s) => s.world);
  const { agent } = row;
  const [text, setText] = useState('');
  const targets = moveTargets(world);
  const [moveTo, setMoveTo] = useState<Id | undefined>();
  const work = workActions(world, agent);
  const questions = openQuestionsOf(world, agent.id);
  const target = moveTo ?? targets[0]?.id;

  const setState = (state: HarnessState) =>
    void run(async () => {
      onSwitch(state);
      await api.setState(agent.id, { state });
    });
  const submitText = (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (!line) return;
    void run(() => api.setActivity(agent.id, { text: line }));
  };

  return (
    <div className="agent-panel" aria-label="Selected agent">
      <header>
        <strong>{row.label}</strong>
        <span className="muted">
          fake agent (no process)
          {row.bodyName ? ` · orbits ${row.bodyName}` : ''}
        </span>
      </header>

      <h3>State</h3>
      <div className="controls" role="group" aria-label="State">
        {STATE_BUTTONS.map((b) => (
          <button
            key={b.state}
            className={row.state === b.state ? '' : 'secondary'}
            aria-pressed={row.state === b.state}
            disabled={disabled}
            onClick={() => setState(b.state)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <p className="muted" aria-live="polite">
        {latency
          ? latency.ms === undefined
            ? `Switching to ${latency.state}…`
            : `${latency.state} reached this page in ${latency.ms} ms (the scene reads the same stream)`
          : 'Each switch is timed from the click to the status reaching this page.'}
      </p>

      {agent.role === 'steward' && (
        <>
          <h3>Activity</h3>
          <div className="controls" role="group" aria-label="Activity">
            {ACTIVITY_BUTTONS.map((b) => (
              <button
                key={b.preset}
                className="secondary"
                title={b.hint}
                disabled={disabled}
                onClick={() => void run(() => api.setActivity(agent.id, { preset: b.preset }))}
              >
                {b.label}
              </button>
            ))}
          </div>
        </>
      )}
      <form className="send" onSubmit={submitText}>
        <input
          aria-label="Progress line"
          placeholder="A progress line, e.g. Running the tests"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={disabled || !text.trim()}>
          Set activity
        </button>
      </form>

      <h3>Events</h3>
      <div className="controls" role="group" aria-label="Events">
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void run(() => api.ask(agent.id, { kind: 'permission' }))}
        >
          Ask permission
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void run(() => api.ask(agent.id, { kind: 'clarification' }))}
        >
          Ask clarification
        </button>
        {work.completeTask && (
          <button
            disabled={disabled}
            onClick={() => void run(() => api.complete(work.completeTask!), 'Task completed.')}
          >
            Complete task
          </button>
        )}
        {work.closeProject && (
          <button
            disabled={disabled}
            onClick={() => void run(() => api.closeProject(work.closeProject!), 'Project closed.')}
          >
            Close project
          </button>
        )}
        <button
          className="danger"
          disabled={disabled}
          onClick={() => {
            onSwitch('failed');
            void run(() => api.setState(agent.id, { state: 'failed' }));
          }}
        >
          Fail
        </button>
        <button
          className="danger"
          disabled={disabled}
          onClick={() => {
            onSwitch('stopped');
            void run(() => api.setState(agent.id, { state: 'stopped' }));
          }}
        >
          Stop
        </button>
      </div>
      {work.moveTask && (
        <div className="send" role="group" aria-label="Move task">
          <label>
            Move task to{' '}
            <select value={target ?? ''} onChange={(e) => setMoveTo(e.target.value)}>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={disabled || !target}
            onClick={() =>
              void run(() => api.move(work.moveTask!, target!), 'Task moved: watch it fly.')
            }
          >
            Move
          </button>
        </div>
      )}
      {questions.length > 0 && (
        <ul className="items" aria-label="Open questions">
          {questions.map((q) => (
            <li key={q.id}>
              <strong>{q.kind}</strong> {q.context.text}{' '}
              <em>{q.holder.type === 'user' ? 'waits for you' : `held by ${q.holder.type}`}</em>{' '}
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void run(() => api.answer(q.id))}
              >
                Answer
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddAgents row={row} api={api} disabled={disabled} run={run} />
    </div>
  );
}

/** More fake agents on the selected agent's work: a Steward on a new task, or a new Waykeeper. */
function AddAgents({
  row,
  api,
  disabled,
  run,
}: {
  row: HarnessRow;
  api: HarnessApi;
  disabled: boolean;
  run: Run;
}) {
  const projectId = row.agent.projectId;
  return (
    <div className="controls" role="group" aria-label="Add agents">
      {projectId && (
        <button
          className="secondary"
          disabled={disabled}
          onClick={() =>
            void run(
              () => api.createAgent({ role: 'steward', projectId }),
              'A Steward on a new task of the project.',
            )
          }
        >
          Add a Steward here
        </button>
      )}
      <button
        className="secondary"
        disabled={disabled}
        onClick={() =>
          void run(() => api.createAgent({ role: 'steward' }), 'A Steward on a new asteroid task.')
        }
      >
        Add an asteroid Steward
      </button>
      {row.agent.role === 'waykeeper' && projectId && !isRunning(row) && (
        <button
          className="secondary"
          disabled={disabled}
          onClick={() =>
            void run(() => api.createAgent({ role: 'waykeeper', projectId }), 'A new Waykeeper.')
          }
        >
          New Waykeeper for the project
        </button>
      )}
    </div>
  );
}

const isRunning = (row: HarnessRow) => row.state !== undefined && !ENDED_STATES.has(row.state);

function ExitCriteria() {
  return (
    <details className="exit-criteria" open>
      <summary>
        <h3>Phase 4 exit criteria — how to check them here</h3>
      </summary>
      <ol>
        {EXIT_CRITERIA.map((c) => (
          <li key={c.id}>
            <label className="check">
              <input type="checkbox" aria-label={`Checked: ${c.criterion}`} />
              <strong>{c.criterion}</strong>
            </label>
            <ol>
              {c.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </details>
  );
}
