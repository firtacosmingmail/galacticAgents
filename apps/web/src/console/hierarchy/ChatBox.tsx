import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ENDED_STATES, type ChatMessage, type Id, type TranscriptChunk } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { actorLabel, agentLabel, ErrorLine, StatePill, useAction, useApi } from './shared.js';

/**
 * A chat box with a supervisor (P2-18; decision 13: the user talks to the Harmonizer and the
 * Waykeepers only). The conversation is the messages sent to the brain (`message.sent`: the
 * user's lines, its Stewards' reports, system notices) interleaved by time with what the brain
 * said (its transcript's text). Sending goes through `POST /api/agents/:id/send`.
 */

const NO_CHUNKS: TranscriptChunk[] = [];
const NO_MESSAGES: ChatMessage[] = [];

type Line =
  | { kind: 'in'; at: string; key: string; message: ChatMessage }
  | { kind: 'out'; at: string; key: string; chunk: TranscriptChunk };

/** Subscribes to an agent's transcript while mounted (the session wires the stream). */
export function useTranscript(agentId: Id): TranscriptChunk[] {
  const chunks = useAppStore((s) => s.transcripts[agentId] ?? NO_CHUNKS);
  const subscribe = useAppStore((s) => s.subscribeTranscript);
  const unsubscribe = useAppStore((s) => s.unsubscribeTranscript);
  useEffect(() => {
    subscribe?.(agentId);
    return () => unsubscribe?.(agentId);
  }, [agentId, subscribe, unsubscribe]);
  return chunks;
}

export function ChatBox({ agentId, title }: { agentId: Id; title?: string }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const messages = useAppStore((s) => s.messages[agentId] ?? NO_MESSAGES);
  const addMessages = useAppStore((s) => s.addMessages);
  const snapshots = useAppStore((s) => s.snapshots);
  const chunks = useTranscript(agentId);
  const { run, error, busy } = useAction();
  const [text, setText] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const [showWork, setShowWork] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  const ended = status !== undefined && ENDED_STATES.has(status.state);

  // The history before this page's stream: after a reload, and after every snapshot catch-up
  // (the messages sent between the two never came on the stream; TECHNOLOGY §6.3).
  useEffect(() => {
    let cancelled = false;
    void api
      .messages(agentId)
      .then((r) => {
        if (!cancelled && Array.isArray(r.messages)) addMessages(agentId, r.messages);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, agentId, addMessages, snapshots]);

  const lines: Line[] = [
    ...messages.map((m): Line => ({ kind: 'in', at: m.at, key: `m-${m.messageId}`, message: m })),
    ...chunks
      .filter((c) => showWork || c.kind === 'text')
      .map((c): Line => ({ kind: 'out', at: c.at, key: `c-${c.seq}`, chunk: c })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (await run(() => api.send(agentId, t, interrupt))) {
      setText('');
      setInterrupt(false);
    }
  };
  const name = title ?? agentLabel(agent, world);

  return (
    <section className="chat" aria-label={`chat with ${name}`}>
      <header>
        <StatePill state={status?.state} />
        <strong>{name}</strong>
        <span className="muted">{status?.currentActivity ?? ''}</span>
        <label className="check">
          <input
            type="checkbox"
            checked={showWork}
            onChange={(e) => setShowWork(e.target.checked)}
          />
          show tools and thinking
        </label>
      </header>
      <div className="chat-lines" ref={scroller} role="log">
        {lines.length === 0 && <p className="muted">No conversation yet.</p>}
        {lines.map((l) =>
          l.kind === 'in' ? (
            <p key={l.key} className={`chat-line from-${l.message.sender.type}`}>
              <span className="who">{actorLabel(l.message.sender, world)}:</span> {l.message.text}
            </p>
          ) : (
            <p key={l.key} className={`chat-line from-agent chunk-${l.chunk.kind}`}>
              <span className="who">
                {l.chunk.kind === 'text' ? agentLabel(agent, world) : l.chunk.kind}:
              </span>{' '}
              {l.chunk.text}
            </p>
          ),
        )}
      </div>
      <form className="send" onSubmit={send}>
        <input
          aria-label={`message to ${name}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ended ? 'it has ended' : `message to ${name}`}
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
        <button type="submit" disabled={busy || ended || !text.trim()}>
          Send
        </button>
      </form>
      <ErrorLine error={error} />
    </section>
  );
}
