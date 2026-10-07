import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ENDED_STATES, type ChatMessage, type Id, type TranscriptChunk } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import {
  liveEntries,
  mergeEntries,
  messageEntryId,
  threadCards,
  threadItems,
  useConversationStore,
  type ChatEntry,
  type ConversationFetch,
  type Thread,
} from '../../state/conversation.js';
import { HARMONIZER } from '../../state/selection.js';
import {
  actorLabel,
  agentLabel,
  ErrorLine,
  StatePill,
  useAction,
  useApi,
} from '../../console/hierarchy/shared.js';
import { NavLink } from '../Navigation.js';
import { compactionNote } from '../compaction.js';
import { ThreadCard } from './InlineCards.js';
import { useComposerAssist } from '../composer/ComposerAssist.js';
import { composing, type HistoryEntry } from '../composer/assist-model.js';
import './chat.css';

/**
 * The panel's chat with a brain (P25-03; SPEC §2.4, §4.2–4.3, decisions 13, 52): the Harmonizer
 * or a Waykeeper. The thread is the history (paged back on scroll) merged with the live stream,
 * one line per entry id (`state/conversation.ts`), with the cards the brain posted — work cards,
 * plan cards, questions — placed by the time they were created, and its subordinates' status
 * reports set apart. The composer sends to this brain (`POST /api/agents/:id/send`: a mailbox
 * event, handled one turn at a time); the line shows as "sending" until its `message.sent`
 * arrives.
 */

const NO_CHUNKS: TranscriptChunk[] = [];
const NO_MESSAGES: ChatMessage[] = [];
const EMPTY_THREAD: Thread = { entries: [], hasOlder: false, loaded: false, loadingOlder: false };
/** How close to an edge (px) counts as "at" it. */
const EDGE = 48;

/**
 * Opens an agent's thread while mounted: reads the history, then the live transcript from where
 * it ended; catches up after a snapshot; absorbs live lines; closes on unmount.
 */
function useThread(agentId: Id): { thread: Thread; entries: ChatEntry[]; loadOlder: () => void } {
  const api = useApi();
  const fetchPage: ConversationFetch = useCallback(
    (id, query) => api.conversation(id, query),
    [api],
  );
  const logId = useAppStore((s) => s.logId);
  const snapshots = useAppStore((s) => s.snapshots);
  const messages = useAppStore((s) => s.messages[agentId] ?? NO_MESSAGES);
  const chunks = useAppStore((s) => s.transcripts[agentId] ?? NO_CHUNKS);
  const subscribe = useAppStore((s) => s.subscribeTranscript);
  const unsubscribe = useAppStore((s) => s.unsubscribeTranscript);
  const thread = useConversationStore((s) => s.threads[agentId] ?? EMPTY_THREAD);
  const conv = useConversationStore.getState;
  const [ready, setReady] = useState(false);
  const seenSnapshots = useRef(snapshots);

  // Another log (a new database) makes every thread stale.
  useEffect(() => conv().forLog(logId), [conv, logId]);

  // The history first; the live transcript starts where it ended.
  // Reopened when the log changes too: `forLog` (above, so it runs first) dropped the threads,
  // and the history must be read again from the new log (as `useStewardTranscript` does).
  useEffect(() => {
    let cancelled = false;
    seenSnapshots.current = useAppStore.getState().snapshots;
    void conv()
      .open(agentId, fetchPage)
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      setReady(false);
      conv().close(agentId);
      // The transcript buffer now starts mid-way (at the page's `lastSeq`): drop it, so the next
      // view of this agent (the ops console's chat) subscribes from its start again.
      useAppStore.setState((s) => {
        if (!(agentId in s.transcripts)) return {};
        const { [agentId]: _dropped, ...rest } = s.transcripts;
        return { transcripts: rest };
      });
    };
  }, [conv, agentId, fetchPage, logId]);

  useEffect(() => {
    if (!ready) return;
    subscribe?.(agentId);
    return () => unsubscribe?.(agentId);
  }, [ready, agentId, subscribe, unsubscribe]);

  // A snapshot catch-up skipped the events between: read the messages they carried.
  useEffect(() => {
    if (!ready || snapshots === seenSnapshots.current) return;
    seenSnapshots.current = snapshots;
    void conv().catchUp(agentId, fetchPage);
  }, [ready, snapshots, conv, agentId, fetchPage]);

  const live = useMemo(() => liveEntries(agentId, messages, chunks), [agentId, messages, chunks]);
  // The stream's buffers are capped: keep what the thread showed.
  useEffect(() => {
    if (live.length > 0) conv().absorb(agentId, live);
  }, [conv, agentId, live]);

  const entries = useMemo(() => mergeEntries(thread.entries, live), [thread.entries, live]);
  const loadOlder = useCallback(
    () => void conv().loadOlder(agentId, fetchPage),
    [conv, agentId, fetchPage],
  );
  return { thread, entries, loadOlder };
}

export function Conversation({ agentId }: { agentId: Id }) {
  const world = useAppStore((s) => s.world);
  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  const name = agent?.role === 'harmonizer' ? 'Harmonizer' : agentLabel(agent, world);
  const { thread, entries, loadOlder } = useThread(agentId);
  const cards = useMemo(() => threadCards(world, agent), [world, agent]);
  const items = useMemo(
    () => threadItems(entries, cards, thread.hasOlder),
    [entries, cards, thread.hasOlder],
  );
  const [pending, setPending] = useState<{ messageId: Id; text: string }[]>([]);
  const known = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
  const waiting = pending.filter((p) => !known.has(messageEntryId(p.messageId)));

  // Scrolling: follow the bottom while the user is there; page back near the top, keeping the
  // lines in view where they were.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Where the user last left the thread while it was visible (see the resize observer). */
  const lastTop = useRef<number | undefined>(undefined);
  const restore = useRef<{ height: number; top: number } | undefined>(undefined);
  const first = entries[0]?.id;
  const count = items.length + waiting.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = restore.current.top + (el.scrollHeight - restore.current.height);
      restore.current = undefined;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [first, count]);
  // The thread changes height (the dock resized, minimised and restored, P4-10): stay at the
  // bottom when the user was there, else where they left it (a browser may reset a box's scroll
  // position when it collapses). Collapsed (minimised: no height), there is nothing to keep.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight <= 0) return;
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      else if (lastTop.current !== undefined && el.scrollTop !== lastTop.current)
        el.scrollTop = lastTop.current;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const older = () => {
    const el = scroller.current;
    if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
    loadOlder();
  };
  const onScroll = () => {
    const el = scroller.current;
    // Collapsed (the dock minimised): a scroll event then says nothing about where the user is.
    if (!el || el.clientHeight <= 0) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE;
    lastTop.current = el.scrollTop;
    if (el.scrollTop < EDGE && thread.hasOlder && !thread.loadingOlder) older();
  };

  const ended = status !== undefined && ENDED_STATES.has(status.state);
  // What ↑ recalls (P8-14): the user's own lines in the loaded conversation, then those still
  // being sent, oldest first.
  const sentByUser = [
    ...entries
      .filter((e) => e.kind === 'message' && e.sender.type === 'user')
      .map((e) => ({ id: e.id, text: e.text })),
    ...waiting.map((p) => ({ id: messageEntryId(p.messageId), text: p.text })),
  ];
  const working = status?.state === 'working' ? status.currentActivity : undefined;

  return (
    <section className="chat pnl-chat" aria-label={`chat with ${name}`}>
      <header className="pnl-chat-head">
        <StatePill state={status?.state} />
        <span className="muted pnl-chat-activity">{status?.currentActivity ?? ''}</span>
      </header>
      <div
        className="pnl-thread"
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label={`conversation with ${name}`}
      >
        {thread.hasOlder && (
          <button
            type="button"
            className="secondary pnl-older"
            disabled={thread.loadingOlder}
            onClick={older}
          >
            {thread.loadingOlder ? 'Loading…' : 'Load earlier messages'}
          </button>
        )}
        {/* P8-02: retention removed older replies (messages stay); said, not silently missing. */}
        {thread.compacted && (
          <p className="muted pnl-compacted" role="note">
            {compactionNote(thread.compacted, 'replies')}
          </p>
        )}
        {!thread.loaded && entries.length === 0 && (
          <p className="muted">Loading the conversation…</p>
        )}
        {thread.loaded && items.length === 0 && waiting.length === 0 && (
          <p className="muted">
            {agent?.role === 'waykeeper'
              ? 'No conversation yet. Ask the Waykeeper about its project.'
              : 'No conversation yet. Ask for something to be built, or how things are going.'}
          </p>
        )}
        {items.map((item) =>
          item.kind === 'card' ? (
            <ThreadCard key={item.key} kind={item.card.kind} id={item.card.id} />
          ) : (
            <Line key={item.key} entry={item.entry} agentId={agentId} name={name} />
          ),
        )}
        {waiting.map((p) => (
          <div key={p.messageId} className="pnl-line pnl-line-user is-pending">
            <p className="pnl-bubble">{p.text}</p>
            <span className="pnl-meta muted">sending…</span>
          </div>
        ))}
        {working && (
          <p className="pnl-typing muted" aria-live="polite">
            {name} is working: {working}
          </p>
        )}
      </div>
      <ErrorLine error={thread.error ? `History: ${thread.error}` : undefined} />
      <Composer
        agentId={agentId}
        name={name}
        ended={ended}
        history={sentByUser}
        onSent={(messageId, text) => setPending((all) => [...all, { messageId, text }])}
      />
    </section>
  );
}

const time = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function Line({ entry: e, agentId, name }: { entry: ChatEntry; agentId: Id; name: string }) {
  const world = useAppStore((s) => s.world);
  if (e.kind === 'reply') {
    return (
      <div className="pnl-line pnl-line-brain" data-entry={e.id}>
        <span className="pnl-meta muted">
          {name} · {time(e.at)}
        </span>
        <p className="pnl-bubble">{e.text}</p>
      </div>
    );
  }
  const s = e.sender;
  if (s.type === 'user') {
    return (
      <div className="pnl-line pnl-line-user" data-entry={e.id}>
        <span className="pnl-meta muted">you · {time(e.at)}</span>
        <p className="pnl-bubble">{e.text}</p>
      </div>
    );
  }
  if (s.type === 'agent' && s.id && s.id !== agentId) {
    // A subordinate's status report (or a superior's instruction), with a link to its sender.
    const from = world.agents[s.id];
    return (
      <div
        className="pnl-line pnl-line-report"
        data-entry={e.id}
        role="group"
        aria-label="status report"
      >
        <span className="pnl-meta muted">
          report from{' '}
          {from ? (
            <NavLink
              to={{
                route: 'panel',
                selection:
                  from.role === 'harmonizer' ? HARMONIZER : { kind: from.role, id: from.id },
              }}
            >
              {agentLabel(from, world)}
            </NavLink>
          ) : (
            actorLabel(s, world)
          )}{' '}
          · {time(e.at)}
        </span>
        <p className="pnl-bubble">{e.text}</p>
      </div>
    );
  }
  return (
    <div className="pnl-line pnl-line-notice" data-entry={e.id}>
      <p className="pnl-bubble">
        <span className="muted">{actorLabel(s, world)}:</span> {e.text}
      </p>
    </div>
  );
}

function Composer({
  agentId,
  name,
  ended,
  history,
  onSent,
}: {
  agentId: Id;
  name: string;
  ended: boolean;
  /** The user's earlier messages to this agent, oldest first (↑ recalls them, P8-14). */
  history: readonly HistoryEntry[];
  onSent: (messageId: Id, text: string) => void;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  // The draft lives in the conversation store (P4-10): a remount (another agent and back, the
  // stacked layout's breakpoint) finds it again.
  const text = useConversationStore((s) => s.drafts[agentId] ?? '');
  const setDraft = useConversationStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agentId, t);
  const [interrupt, setInterrupt] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Slash commands (P8-13) and ↑ history (P8-14). A message that starts with `/name` goes to the
  // agent as typed: its runtime runs the command (a brain takes it as a turn of its own).
  const assist = useComposerAssist({
    agentId,
    text,
    setText,
    textarea: field,
    history,
    commands: !ended,
    send: () => void send(),
  });
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy || ended) return;
    let messageId: Id | undefined;
    const ok = await run(async () => {
      messageId = (await api.send(agentId, t, interrupt)).messageId;
    });
    if (ok) {
      if (messageId) onSent(messageId, t);
      setText('');
      setInterrupt(false);
      assist.reset();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (assist.onKeyDown(e)) return;
    // WebKit's composition-ending Enter has `isComposing` false and keyCode 229 (review S5).
    if (e.key === 'Enter' && !e.shiftKey && !composing(e)) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <form className="pnl-composer" onSubmit={send}>
      <div className="cmp-field">
        <textarea
          ref={field}
          aria-label={`message to ${name}`}
          value={text}
          rows={2}
          onChange={(e) => assist.onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            ended
              ? 'it has ended'
              : `Message ${name} (Enter sends, Shift+Enter: new line, / for commands, ↑ for earlier messages)`
          }
          disabled={ended}
          {...assist.inputProps}
        />
        {assist.popup}
      </div>
      <div className="pnl-composer-row">
        <label className="check" title="cancel its current turn and handle this first">
          <input
            type="checkbox"
            checked={interrupt}
            onChange={(e) => setInterrupt(e.target.checked)}
            disabled={ended}
          />
          interrupt
        </label>
        <button type="submit" disabled={busy || ended || !text.trim()}>
          Send
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
