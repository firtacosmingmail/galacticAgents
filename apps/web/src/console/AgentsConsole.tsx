import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ENDED_STATES,
  type Agent,
  type AgentRuntime,
  type Question,
  type RuntimesInfo,
  type PermissionPolicyPreset,
  type StatusRecord,
  type TranscriptChunk,
  wallClockLimit,
} from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { createApi, type Api } from './api.js';

/**
 * The ops console (P1-11): everything the Phase 1 exit criteria ask for, on one plain page —
 * spawn an agent, watch its status, answer its questions, message it, pause/resume/stop it,
 * read its transcript. State comes from the stream (the store); actions go through `/api`.
 */
export function AgentsConsole({ token }: { token: string }) {
  const api = useMemo(() => createApi(token), [token]);
  const agents = useAppStore((s) => s.world.agents);
  const statuses = useAppStore((s) => s.world.statuses);
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** Runs an action; a failure is shown. Resolves to whether it succeeded. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      setError(undefined);
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const rows = Object.values(agents)
    .map((agent) => ({ agent, status: statuses[agent.id] }))
    .sort(
      (a, b) =>
        b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.id.localeCompare(b.agent.id),
    );
  const current = selected ? rows.find((r) => r.agent.id === selected) : rows[0];

  return (
    <section className="console">
      <h2>Agents</h2>
      <SpawnForm api={api} onSpawned={(id) => setSelected(id)} onError={setError} />
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted">No agents yet — spawn one above.</p>
      ) : (
        <div className="console-grid">
          <ul className="agent-list">
            {rows.map(({ agent, status }) => (
              <li key={agent.id}>
                <button
                  className={`agent-row ${current?.agent.id === agent.id ? 'selected' : ''}`}
                  onClick={() => setSelected(agent.id)}
                >
                  <span className={`pill state-${status?.state ?? 'unknown'}`}>
                    {status?.state ?? '…'}
                  </span>
                  <span className="agent-name">
                    {agent.role} · {agent.runtime}
                  </span>
                  <span className="muted agent-id">{agent.id.slice(0, 10)}</span>
                  <span className="muted activity">{status?.currentActivity ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <AgentPanel agent={current.agent} status={current.status} api={api} run={run} />
          )}
        </div>
      )}
    </section>
  );
}

function SpawnForm({
  api,
  onSpawned,
  onError,
}: {
  api: Api;
  onSpawned: (agentId: string) => void;
  onError: (message: string | undefined) => void;
}) {
  const [info, setInfo] = useState<RuntimesInfo | undefined>();
  const [runtime, setRuntime] = useState<AgentRuntime>('fake');
  const [prompt, setPrompt] = useState('scenario:happy');
  const [cwd, setCwd] = useState('');
  const [policy, setPolicy] = useState<PermissionPolicyPreset>('default');
  const [busy, setBusy] = useState(false);
  const live = useAppStore((s) => s.status === 'live');

  useEffect(() => {
    void api
      .runtimes()
      .then((i) => {
        if (!Array.isArray(i.runtimes)) throw new Error('unexpected reply');
        setInfo(i);
        if (!i.runtimes.some((r) => r.name === runtime) && i.runtimes[0])
          setRuntime(i.runtimes[0].name);
      })
      .catch((e: Error) => onError(`runtimes: ${e.message}`));
    // The form is filled once per token; `runtime` is state the effect sets, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const scenarios = info?.runtimes.find((r) => r.name === 'fake')?.scenarios ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onError(undefined);
      const { agentId } = await api.spawn({ runtime, prompt, cwd: cwd || '/tmp', policy });
      onSpawned(agentId);
    } catch (err) {
      onError(`spawn: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="spawn" onSubmit={submit}>
      <label>
        runtime
        <select value={runtime} onChange={(e) => setRuntime(e.target.value as AgentRuntime)}>
          {(info?.runtimes ?? [{ name: 'fake' as const }]).map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {runtime === 'fake' && scenarios.length > 0 && (
        <label>
          scenario
          <select value={prompt} onChange={(e) => setPrompt(e.target.value)}>
            {scenarios.map((name) => (
              <option key={name} value={`scenario:${name}`}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="grow">
        prompt
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="what to do"
        />
      </label>
      <label>
        cwd
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/workspace"
        />
      </label>
      <label>
        policy
        <select
          value={policy}
          onChange={(e) => setPolicy(e.target.value as PermissionPolicyPreset)}
        >
          {(info?.policies ?? ['default']).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy || !live || !prompt.trim()}>
        Spawn
      </button>
    </form>
  );
}

/** A stable empty selection result: a fresh `[]` per render would re-render forever. */
const NO_CHUNKS: TranscriptChunk[] = [];

function AgentPanel({
  agent,
  status,
  api,
  run,
}: {
  agent: Agent;
  status: StatusRecord | undefined;
  api: Api;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const questions = useAppStore((s) => s.world.questions);
  const chunks = useAppStore((s) => s.transcripts[agent.id] ?? NO_CHUNKS);
  const subscribe = useAppStore((s) => s.subscribeTranscript);
  const unsubscribe = useAppStore((s) => s.unsubscribeTranscript);
  const [text, setText] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const transcriptRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    subscribe?.(agent.id);
    return () => unsubscribe?.(agent.id);
  }, [agent.id, subscribe, unsubscribe]);
  // Follow the transcript as it grows.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  const state = status?.state ?? 'unknown';
  const ended = status !== undefined && ENDED_STATES.has(status.state);
  const pending: Question | undefined = status?.pendingQuestionId
    ? questions[status.pendingQuestionId]
    : undefined;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    // Keep the text when the send failed (the error is shown), so it can be sent again.
    if (!(await run(() => api.send(agent.id, t, interrupt)))) return;
    setText('');
    setInterrupt(false);
  };

  return (
    <div className="agent-panel">
      <header>
        <span className={`pill state-${state}`}>{state}</span>
        <strong>
          {agent.role} · {agent.runtime}
        </strong>
        <code className="muted">{agent.id}</code>
      </header>
      <dl className="facts">
        <div className="wide">
          <dt>activity</dt>
          <dd>{status?.currentActivity ?? '—'}</dd>
        </div>
        <div>
          <dt>cost</dt>
          <dd>
            {status?.costSoFar?.usd !== undefined ? `$${status.costSoFar.usd.toFixed(4)}` : '—'}
          </dd>
        </div>
        <div>
          <dt>tool calls</dt>
          <dd>{status ? `${status.caps.toolCalls.used} / ${status.caps.toolCalls.limit}` : '—'}</dd>
        </div>
        <div>
          <dt>wall clock</dt>
          <dd>
            {status
              ? wallClockLimit(status.caps.wallClockMs) !== undefined
                ? `${Math.round(status.caps.wallClockMs.used / 1000)} s / ${Math.round(status.caps.wallClockMs.limit / 60000)} min`
                : `${Math.round(status.caps.wallClockMs.used / 1000)} s (no cap)`
              : '—'}
          </dd>
        </div>
        {status?.progress && (
          <div>
            <dt>progress</dt>
            <dd>
              {status.progress.done} / {status.progress.total}
            </dd>
          </div>
        )}
      </dl>

      {pending && pending.status === 'open' && (
        <QuestionCard question={pending} onAnswer={(a) => run(() => api.answer(pending.id, a))} />
      )}

      <div className="controls">
        {state === 'paused' ? (
          <button onClick={() => run(() => api.resume(agent.id))}>Resume</button>
        ) : (
          <button onClick={() => run(() => api.pause(agent.id))} disabled={ended}>
            Pause
          </button>
        )}
        <button onClick={() => run(() => api.interrupt(agent.id))} disabled={ended}>
          Interrupt
        </button>
        <button onClick={() => run(() => api.stop(agent.id))} disabled={ended} className="danger">
          Stop
        </button>
        {state === 'interrupted' && (
          <button onClick={() => run(() => api.recover(agent.id))}>Resume session</button>
        )}
      </div>

      <form className="send" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ended ? 'agent has ended' : 'message to the agent'}
          disabled={ended}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={interrupt}
            onChange={(e) => setInterrupt(e.target.checked)}
          />
          interrupt
        </label>
        <button type="submit" disabled={ended || !text.trim()}>
          Send
        </button>
      </form>

      <h3>Transcript</h3>
      <pre className="transcript" ref={transcriptRef}>
        {chunks.length === 0 ? (
          <span className="muted">nothing yet</span>
        ) : (
          // A terminal agent's raw screen (P8-08) is the panel's terminal view; its text is here.
          chunks
            .flatMap((c) => (c.kind === 'terminal' ? [] : [c]))
            .map((c) => (
              <div key={c.seq} className={`chunk chunk-${c.kind}`}>
                <span className="muted">{c.kind}</span> {c.text}
              </div>
            ))
        )}
      </pre>
    </div>
  );
}

function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState('');
  const permission = question.kind === 'permission';
  const call = question.context.toolCall;
  const set = question.context.set;
  if (set) {
    // A question set's row (P8-21): answered on the set's card in the panel, never one by one.
    return (
      <div className="question question-clarification">
        <strong>Question</strong>
        <p>{question.context.text}</p>
        <p className="muted">Part of the question set “{set.title}”: answer it in the inbox.</p>
      </div>
    );
  }
  return (
    <div className={`question question-${question.kind}`}>
      <strong>{permission ? 'Permission request' : 'Question'}</strong>
      <p>{question.context.text}</p>
      {permission && call && (
        <p className="muted">
          {question.context.permissionAction ? `${question.context.permissionAction}: ` : ''}
          <code>
            {call.toolName} {call.input !== undefined ? JSON.stringify(call.input) : ''}
          </code>
        </p>
      )}
      {permission ? (
        <div className="controls">
          <button onClick={() => onAnswer('allow')}>Allow</button>
          <button onClick={() => onAnswer('no')} className="danger">
            Refuse
          </button>
        </div>
      ) : (
        <form
          className="send"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onAnswer(value.trim());
            setValue('');
          }}
        >
          {question.context.options?.map((o) => (
            <button type="button" key={o} onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="your answer"
          />
          <button type="submit" disabled={!value.trim()}>
            Answer
          </button>
        </form>
      )}
    </div>
  );
}
