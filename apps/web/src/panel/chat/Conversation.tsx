import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  ENDED_STATES,
  type ChatMessage,
  type Id,
  type ReplyQuote,
  type TranscriptChunk,
} from '@galactic/protocol';
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
  type ReplyDraft,
  type Thread,
  type ThreadCardItem,
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
import {
  draftOfCard,
  draftOfEntry,
  locate,
  QuoteBlock,
  quoteTitle,
  ReplyBar,
  ReplyButton,
  replyRef,
} from './Reply.js';
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
/** The most pages a jump to a quoted line reads back before it gives up (P8-17). */
const MAX_JUMP_PAGES = 40;
/** How long a line jumped to stays highlighted (ms). */
const HIGHLIGHT_MS = 2_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Opens an agent's thread while mounted: reads the history, then the live transcript from where
 * it ended; catches up after a snapshot; absorbs live lines; closes on unmount.
 */
function useThread(agentId: Id): {
  thread: Thread;
  entries: ChatEntry[];
  loadOlder: () => Promise<void>;
} {
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
    () => conv().loadOlder(agentId, fetchPage),
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
  const [pending, setPending] = useState<
    { messageId: Id; text: string; replyTo?: ReplyQuote | undefined }[]
  >([]);
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
    return loadOlder();
  };

  // Replies (P8-17): the Reply action of a line or card fills the composer's quote bar; a sent
  // reply's quote jumps back to the original, paging back until it is in the thread.
  const field = useRef<HTMLTextAreaElement>(null);
  const setReply = useConversationStore((s) => s.setReply);
  const replyWith = (draft: ReplyDraft) => {
    setReply(agentId, draft);
    field.current?.focus();
  };
  const [missing, setMissing] = useState<Record<string, true>>({});
  // A jump outlives neither the chat nor its highlight timer (P8-17 review).
  const mounted = useRef(true);
  const highlight = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> }>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (highlight.current) clearTimeout(highlight.current.timer);
      highlight.current = undefined;
    };
  }, []);
  const jump = async (from: string, target: Pick<ReplyQuote, 'kind' | 'id'>) => {
    let el = locate(scroller.current, target);
    let failed = false;
    for (let page = 0; !el && page < MAX_JUMP_PAGES;) {
      const t = useConversationStore.getState().threads[agentId];
      if (!mounted.current || !t?.hasOlder || t.oldestCursor === undefined) break;
      if (t.loadingOlder) await pause(50);
      else {
        page++;
        await older();
        await pause(0);
        // A page that failed, or that moved nothing (the cursor stayed), ends the search: never
        // a burst of requests against a failing server.
        const after = useConversationStore.getState().threads[agentId];
        if (!after || after.oldestCursor === t.oldestCursor) {
          el = locate(scroller.current, target);
          failed = !el && after?.hasOlder === true;
          break;
        }
      }
      el = locate(scroller.current, target);
    }
    // A history that could not be read says so itself; the original is not called gone.
    if (!mounted.current || failed) return;
    setMissing((m) => {
      if (Boolean(m[from]) === !el) return m;
      const { [from]: _was, ...rest } = m;
      return el ? rest : { ...m, [from]: true };
    });
    if (!el) return;
    atBottom.current = false;
    el.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    if (highlight.current) {
      clearTimeout(highlight.current.timer);
      highlight.current.el.classList.remove('is-highlighted');
    }
    el.classList.add('is-highlighted');
    const lit = el;
    highlight.current = {
      el: lit,
      timer: setTimeout(() => {
        lit.classList.remove('is-highlighted');
        highlight.current = undefined;
      }, HIGHLIGHT_MS),
    };
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
            <ThreadCard
              key={item.key}
              kind={item.card.kind}
              id={item.card.id}
              onReply={() => replyWith(draftOfCard(item.card, agentId))}
              replyLabel={cardLabel(item.card)}
            />
          ) : (
            <Line
              key={item.key}
              entry={item.entry}
              agentId={agentId}
              name={name}
              onReply={() => replyWith(draftOfEntry(item.entry))}
              missing={missing[item.entry.id] === true}
              onJump={(target) => void jump(item.entry.id, target)}
            />
          ),
        )}
        {waiting.map((p) => (
          <div key={p.messageId} className="pnl-line pnl-line-user is-pending">
            <Bubble
              text={p.text}
              quote={p.replyTo}
              agentId={agentId}
              name={name}
              onJump={() => p.replyTo && void jump(messageEntryId(p.messageId), p.replyTo)}
            />
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
        field={field}
        onSent={(messageId, text, replyTo) =>
          setPending((all) => [...all, { messageId, text, replyTo }])
        }
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

/** The label a card's Reply action names. */
const cardLabel = (card: ThreadCardItem) =>
  card.kind === 'question'
    ? `the question: ${card.question.context.text}`
    : `the proposal: ${card.proposal.requestText}`;

/** A line's bubble; with a quote (P8-17) the quote sits above the text, inside it. */
function Bubble({
  text,
  quote,
  agentId,
  name,
  missing,
  onJump,
}: {
  text: string;
  quote?: Pick<ReplyQuote, 'kind' | 'id' | 'sender' | 'text' | 'answered'> | undefined;
  agentId: Id;
  name: string;
  missing?: boolean;
  onJump?: () => void;
}) {
  const world = useAppStore((s) => s.world);
  if (!quote) return <p className="pnl-bubble">{text}</p>;
  return (
    <div className="pnl-bubble pnl-bubble-quoted">
      <QuoteBlock
        quote={quote}
        title={quoteTitle(quote, agentId, name, world)}
        missing={missing ?? false}
        {...(onJump ? { onJump } : {})}
      />
      <p className="pnl-bubble-text">{text}</p>
    </div>
  );
}

function Line({
  entry: e,
  agentId,
  name,
  onReply,
  missing,
  onJump,
}: {
  entry: ChatEntry;
  agentId: Id;
  name: string;
  onReply: () => void;
  missing: boolean;
  onJump: (target: Pick<ReplyQuote, 'kind' | 'id'>) => void;
}) {
  const world = useAppStore((s) => s.world);
  const excerptOf = e.text.length > 60 ? `${e.text.slice(0, 59)}…` : e.text;
  if (e.kind === 'reply') {
    return (
      <div className="pnl-line pnl-line-brain" data-entry={e.id} tabIndex={-1}>
        <span className="pnl-meta muted">
          {name} · {time(e.at)}
        </span>
        <div className="pnl-line-body">
          <p className="pnl-bubble">{e.text}</p>
          <ReplyButton label={`${name}: ${excerptOf}`} onReply={onReply} />
        </div>
      </div>
    );
  }
  const s = e.sender;
  if (s.type === 'user') {
    const quote = e.replyTo;
    return (
      <div className="pnl-line pnl-line-user" data-entry={e.id} tabIndex={-1}>
        <span className="pnl-meta muted">you · {time(e.at)}</span>
        <div className="pnl-line-body">
          <Bubble
            text={e.text}
            quote={quote}
            agentId={agentId}
            name={name}
            missing={missing}
            {...(quote ? { onJump: () => onJump(quote) } : {})}
          />
          <ReplyButton label={`your message: ${excerptOf}`} onReply={onReply} />
        </div>
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
        tabIndex={-1}
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
        <div className="pnl-line-body">
          <p className="pnl-bubble">{e.text}</p>
          <ReplyButton label={`the report: ${excerptOf}`} onReply={onReply} />
        </div>
      </div>
    );
  }
  return (
    <div className="pnl-line pnl-line-notice" data-entry={e.id} tabIndex={-1}>
      <div className="pnl-line-body">
        <p className="pnl-bubble">
          <span className="muted">{actorLabel(s, world)}:</span> {e.text}
        </p>
        <ReplyButton label={`the notice: ${excerptOf}`} onReply={onReply} />
      </div>
    </div>
  );
}

function Composer({
  agentId,
  name,
  ended,
  history,
  field,
  onSent,
}: {
  agentId: Id;
  name: string;
  ended: boolean;
  /** The user's earlier messages to this agent, oldest first (↑ recalls them, P8-14). */
  history: readonly HistoryEntry[];
  /** The text box (the thread's Reply actions focus it). */
  field: RefObject<HTMLTextAreaElement | null>;
  onSent: (messageId: Id, text: string, replyTo?: ReplyQuote) => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  // What this message replies to (P8-17), kept with the draft in the conversation store.
  const reply = useConversationStore((s) => s.replies[agentId]);
  const setReply = useConversationStore((s) => s.setReply);
  const cancelReply = () => setReply(agentId, undefined);
  const { run, error, busy } = useAction();
  // The draft lives in the conversation store (P4-10): a remount (another agent and back, the
  // stacked layout's breakpoint) finds it again.
  const text = useConversationStore((s) => s.drafts[agentId] ?? '');
  const setDraft = useConversationStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agentId, t);
  const [interrupt, setInterrupt] = useState(false);
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
    const draft = reply;
    const ref = draft ? replyRef(draft, world) : undefined;
    const ok = await run(async () => {
      messageId = (await api.send(agentId, t, interrupt, ref)).messageId;
    });
    if (ok) {
      // The pending line shows the quote as the bar did, until the logged message replaces it.
      if (messageId) {
        onSent(
          messageId,
          t,
          draft && {
            kind: draft.kind,
            id: draft.id,
            sender: draft.sender,
            text: draft.text,
            ...(ref?.version !== undefined ? { answered: true as const } : {}),
          },
        );
      }
      if (draft) cancelReply();
      setText('');
      setInterrupt(false);
      assist.reset();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (assist.onKeyDown(e)) return;
    if (e.key === 'Escape' && reply) {
      e.preventDefault();
      cancelReply();
      return;
    }
    // WebKit's composition-ending Enter has `isComposing` false and keyCode 229 (review S5).
    if (e.key === 'Enter' && !e.shiftKey && !composing(e)) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <form className="pnl-composer" onSubmit={send}>
      {reply && (
        <ReplyBar
          draft={reply}
          title={quoteTitle(reply, agentId, name, world)}
          note={replyNote(reply, world)}
          onCancel={() => {
            cancelReply();
            field.current?.focus();
          }}
        />
      )}
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

/** What the quote bar adds for a question (P8-17): a clarification is answered by the reply. */
function replyNote(
  draft: ReplyDraft,
  world: { questions: Record<Id, { kind: string; status: string }> },
): string | undefined {
  if (draft.kind !== 'question') return undefined;
  const q = world.questions[draft.id];
  if (q?.kind === 'clarification' && q.status === 'open')
    return 'Your reply answers this question.';
  if (q?.kind === 'permission' && q.status === 'open')
    return "A reply does not decide it: use the card's buttons.";
  return undefined;
}
