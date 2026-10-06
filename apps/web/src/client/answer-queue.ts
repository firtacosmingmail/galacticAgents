import { create } from 'zustand';
import { isStorageErrorCode, type Id, type Question } from '@galactic/protocol';
import { ApiError, type Api } from '../console/api.js';
import type { ConnectionStatus } from './client.js';
import { useAppStore } from '../state/store.js';
import type { WorldState } from '../state/reduce.js';
import { actorLabel, agentLabel } from '../console/hierarchy/shared.js';

/**
 * Offline answers (P7-05; IMPLEMENTATION_PLAN corner case 28, TECHNOLOGY §6.3). Every answer the
 * panel sends goes through this queue with the question's `version` and a fresh `answerId` (the
 * server's idempotency key). Online it is sent at once; while the stream is down (or when the send
 * itself fails on the network) it waits here, persisted in `localStorage`, and is sent when the
 * stream is live again — that is, after the snapshot or the replay up to `caught_up` was applied,
 * so the page already knows whether someone answered first. The server decides: `ok` (or
 * `duplicate`, the retry of a send whose acknowledgement was lost) resolves it, 409 `stale` or a
 * withdrawn question leaves it "not sent" with who answered, worded from the folded world.
 *
 * Only answers are queued. Card decisions (approve / edit / reject / park) have no version to
 * check a stale view against and start work, so they need a live connection (SPEC decision 96;
 * `docs/tasks/notes/P7-05-offline.md`).
 *
 * What is stored: the answer text, the question's id, version and text, and a fingerprint of the
 * token (FNV-1a, not the token): a session with another token clears the queue when it goes live,
 * and so does forgetting the token. Every storage access is in try/catch; without storage the
 * queue lives for the page.
 */

export const QUEUE_KEY = 'galactic.answers.queue';

/** How long a "sent" confirmation stays listed before it goes by itself. */
export const SENT_NOTICE_MS = 15_000;
/** The retry after a send that failed on the network while the stream still looked live. */
export const RETRY_MS = 5_000;

/** The connection states in which an answer is queued rather than sent. */
const QUEUE_WHILE: ReadonlySet<ConnectionStatus> = new Set([
  'disconnected',
  'connecting',
  'catching_up',
]);

export type QueuedAnswerState = 'queued' | 'sending' | 'not_sent' | 'sent';
/** Why an answer was not sent. */
export type NotSentReason = 'stale' | 'withdrawn' | 'gone' | 'refused';

export interface QueuedAnswer {
  /** The idempotency key sent with every try (`AnswerBody.answerId`). */
  answerId: string;
  questionId: Id;
  answer: string;
  /** The question's version the user answered. */
  version: number;
  /** The question's text, to name it while the world does not hold it (a reload before the snapshot). */
  text: string;
  /** This device's clock, for ordering the queue only. */
  queuedAt: string;
  state: QueuedAnswerState;
  /** It waited in the queue (a direct send that is merely in flight shows no queued state). */
  wasQueued?: boolean;
  reason?: NotSentReason;
  /** The server's refusal, as it said it. */
  message?: string;
}

interface QueueStore {
  /** The token fingerprint the stored entries belong to. */
  scope: string | undefined;
  /** One entry per question: the newest answer the user gave it on this device. */
  entries: Record<Id, QueuedAnswer>;
  /** The latest polite announcement (a counter, so the same words are said again). */
  announcement: { n: number; text: string } | undefined;
}

export const useAnswerQueue = create<QueueStore>(() => ({
  scope: undefined,
  entries: {},
  announcement: undefined,
}));

// -- persistence -------------------------------------------------------------------------------

interface Stored {
  v: 1;
  scope?: string;
  entries: QueuedAnswer[];
}

function readStored(): Stored | undefined {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return undefined;
    return {
      v: 1,
      ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
      entries: parsed.entries.filter(isEntry),
    };
  } catch {
    return undefined;
  }
}

function isEntry(e: unknown): e is QueuedAnswer {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x['answerId'] === 'string' &&
    typeof x['questionId'] === 'string' &&
    typeof x['answer'] === 'string' &&
    typeof x['version'] === 'number' &&
    typeof x['text'] === 'string' &&
    typeof x['queuedAt'] === 'string' &&
    typeof x['state'] === 'string'
  );
}

function persist(): void {
  const { scope, entries } = useAnswerQueue.getState();
  // A "sent" confirmation is for this page only.
  const kept = Object.values(entries).filter((e) => e.state !== 'sent');
  try {
    if (kept.length === 0) localStorage.removeItem(QUEUE_KEY);
    else {
      const stored: Stored = { v: 1, ...(scope ? { scope } : {}), entries: kept };
      localStorage.setItem(QUEUE_KEY, JSON.stringify(stored));
    }
  } catch {
    /* private mode, quota: the queue lives for the page */
  }
}

/**
 * Reads the stored queue. On page load (`recover`), an entry caught mid-send — the page that was
 * sending it closed — is queued again (same answerId, so a send that did land is recognised as a
 * duplicate). When another live tab's change is read in, its `sending` entries are left as they
 * are: that tab is sending them, and queuing them here would send them twice at once.
 */
function hydrate(recover: boolean): void {
  const stored = readStored();
  const entries: Record<Id, QueuedAnswer> = {};
  for (const e of stored?.entries ?? []) {
    entries[e.questionId] =
      recover && e.state === 'sending' ? { ...e, state: 'queued', wasQueued: true } : e;
  }
  useAnswerQueue.setState({ scope: stored?.scope, entries });
}

/** FNV-1a (32 bit) of the token: tells tokens apart without storing one. */
export function tokenScope(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// -- entries -----------------------------------------------------------------------------------

function put(entry: QueuedAnswer): void {
  useAnswerQueue.setState((s) => ({
    // The first entry of a session stamps it with the session's token.
    scope: s.scope ?? session?.scope,
    entries: { ...s.entries, [entry.questionId]: entry },
  }));
  persist();
}

function update(questionId: Id, answerId: string, changes: Partial<QueuedAnswer>): void {
  const current = useAnswerQueue.getState().entries[questionId];
  // Another answer replaced it (cancelled and answered again): leave the new one alone.
  if (!current || current.answerId !== answerId) return;
  put({ ...current, ...changes });
}

function remove(questionId: Id, answerId?: string): void {
  const current = useAnswerQueue.getState().entries[questionId];
  if (!current || (answerId !== undefined && current.answerId !== answerId)) return;
  useAnswerQueue.setState((s) => {
    const { [questionId]: _gone, ...rest } = s.entries;
    return { entries: rest };
  });
  persist();
}

function announce(text: string): void {
  useAnswerQueue.setState((s) => ({ announcement: { n: (s.announcement?.n ?? 0) + 1, text } }));
}

const quote = (text: string, n = 60) => `“${text.length > n ? `${text.slice(0, n - 1)}…` : text}”`;

function newAnswerId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* not a secure context */
  }
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Whether the stream is down (or not back yet): answers are queued, card decisions wait. */
export const streamDown = (status: ConnectionStatus): boolean => QUEUE_WHILE.has(status);

/** Whether an answer given now is queued: the stream is down or the browser says it is offline. */
export function isOffline(status: ConnectionStatus = useAppStore.getState().status): boolean {
  if (streamDown(status)) return true;
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

/**
 * A passing failure: the server (or a proxy before it) is restarting, overloaded or timed out —
 * 5xx, 408, 429. Like a request that never got an answer, the answer stays queued and is retried
 * with the same answerId; it is not a decision about the answer. A storage refusal (507
 * `storage_full`, 503 `storage_unavailable` / `storage_unwritable`, P8-09) is not passing in this
 * sense: decision 99 refuses the action whole and never queues it — the card shows "the disk is
 * full" and the user answers again once there is room.
 */
const isTransient = (e: ApiError): boolean =>
  !isStorageErrorCode(e.code) && (e.status >= 500 || e.status === 408 || e.status === 429);

/** A refusal from the server, as opposed to a request that never got an answer or a passing failure. */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && !isTransient(e);

// -- the card's send ---------------------------------------------------------------------------

export type SubmitOutcome = 'sent' | 'queued';

/**
 * Answers `question` as the user: sent now when online (a refusal is thrown as before, an
 * `ApiError`, so the card shows it), queued when offline or when the send fails on the network.
 */
export async function submitAnswer(
  api: Api,
  question: Question,
  text: string,
): Promise<SubmitOutcome> {
  const entry: QueuedAnswer = {
    answerId: newAnswerId(),
    questionId: question.id,
    answer: text,
    version: question.version,
    text: question.context.text,
    queuedAt: new Date().toISOString(),
    state: 'sending',
  };
  if (isOffline()) {
    put({ ...entry, state: 'queued', wasQueued: true });
    announce(`Answer queued: it will be sent when the connection is back.`);
    return 'queued';
  }
  put(entry);
  try {
    await api.answer(question.id, text, question.version, entry.answerId);
  } catch (e) {
    if (isRefusal(e)) {
      remove(question.id, entry.answerId);
      throw e;
    }
    update(question.id, entry.answerId, { state: 'queued', wasQueued: true });
    announce(
      e instanceof ApiError
        ? `The server could not take the answer just now: it is queued and will be sent again shortly.`
        : `No connection: the answer is queued and will be sent when the connection is back.`,
    );
    scheduleRetry();
    return 'queued';
  }
  remove(question.id, entry.answerId);
  return 'sent';
}

/** Cancels a queued answer (not one being sent: that one is already on its way). */
export function cancelQueuedAnswer(questionId: Id): boolean {
  const entry = useAnswerQueue.getState().entries[questionId];
  if (!entry || entry.state !== 'queued') return false;
  remove(questionId, entry.answerId);
  announce(`Queued answer cancelled.`);
  return true;
}

/** Removes a "not sent" or "sent" notice. */
export function dismissAnswerNotice(questionId: Id): void {
  const entry = useAnswerQueue.getState().entries[questionId];
  if (entry && (entry.state === 'not_sent' || entry.state === 'sent')) remove(questionId);
}

/** Empties the queue (the token was forgotten). */
export function clearAnswerQueue(): void {
  useAnswerQueue.setState({ entries: {}, scope: undefined });
  persist();
}

// -- reconnect ---------------------------------------------------------------------------------

let session:
  | {
      api: Api;
      scope: string;
      retry: ReturnType<typeof setTimeout> | undefined;
      sentTimers: Set<ReturnType<typeof setTimeout>>;
    }
  | undefined;
let flushing: Promise<void> | undefined;
let flushAgain = false;

function scheduleRetry(): void {
  if (!session || session.retry) return;
  session.retry = setTimeout(() => {
    if (!session) return;
    session.retry = undefined;
    if (useAppStore.getState().status === 'live') void flushAnswerQueue();
  }, RETRY_MS);
}

/**
 * Starts the queue for a session with `token` (from `startSession`): reads the stored queue and
 * sends it every time the stream goes live — after the snapshot or the catch-up — or the browser
 * comes back online; another tab's change to it is read in. Returns the stop function.
 */
export function startAnswerQueue(token: string, api: Api): () => void {
  hydrate(true);
  const sentTimers = new Set<ReturnType<typeof setTimeout>>();
  session = { api, scope: tokenScope(token), retry: undefined, sentTimers };
  let previous = useAppStore.getState().status;
  const unsubscribe = useAppStore.subscribe((s) => {
    const status = s.status;
    if (status === previous) return;
    previous = status;
    if (status === 'live') onLive();
  });
  const onStorage = (e: StorageEvent) => {
    if (e.key !== QUEUE_KEY) return;
    // Another tab queued, cancelled or sent something; what this tab is sending stays as it is.
    const local = useAnswerQueue.getState().entries;
    hydrate(false);
    const merged = { ...useAnswerQueue.getState().entries };
    for (const e of Object.values(local)) {
      if (e.state !== 'sending' && e.state !== 'sent') continue;
      const other = merged[e.questionId];
      if (!other || other.answerId === e.answerId) merged[e.questionId] = e;
    }
    useAnswerQueue.setState({ entries: merged });
    // One queue per browser: a tab that is live sends what an offline tab queued (same answerId).
    if (useAppStore.getState().status === 'live') void flushAnswerQueue();
  };
  // The browser is back online while the stream never noticed it was gone (a short drop, or an
  // emulated one): send what was queued meanwhile.
  const onOnline = () => {
    if (useAppStore.getState().status === 'live') void flushAnswerQueue();
  };
  try {
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
  } catch {
    /* no window */
  }
  if (previous === 'live') onLive();
  return () => {
    unsubscribe();
    try {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
    } catch {
      /* no window */
    }
    if (session?.retry) clearTimeout(session.retry);
    for (const t of sentTimers) clearTimeout(t);
    session = undefined;
  };
}

function onLive(): void {
  if (!session) return;
  const { scope } = useAnswerQueue.getState();
  if (scope !== session.scope) {
    // Another token (another server, or a reset one): what was queued for it is not ours to send.
    useAnswerQueue.setState({
      scope: session.scope,
      entries: scope === undefined ? useAnswerQueue.getState().entries : {},
    });
    persist();
  }
  void flushAnswerQueue();
}

/**
 * Sends every queued answer, oldest first, one at a time, while the stream is live. Concurrent
 * calls share one run (and ask for another pass when something was queued meanwhile).
 */
export function flushAnswerQueue(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false;
        await flushOnce();
      } while (flushAgain);
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

async function flushOnce(): Promise<void> {
  const queued = Object.values(useAnswerQueue.getState().entries)
    .filter((e) => e.state === 'queued')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.answerId.localeCompare(b.answerId));
  for (const entry of queued) {
    if (!session || useAppStore.getState().status !== 'live') return;
    // Cancelled meanwhile?
    if (useAnswerQueue.getState().entries[entry.questionId]?.answerId !== entry.answerId) continue;
    update(entry.questionId, entry.answerId, { state: 'sending', wasQueued: true });
    try {
      await session.api.answer(entry.questionId, entry.answer, entry.version, entry.answerId);
    } catch (e) {
      if (!isRefusal(e)) {
        // No reply, or a passing 5xx/408/429: try again later (the same answerId), not in a
        // tight loop.
        update(entry.questionId, entry.answerId, { state: 'queued' });
        flushAgain = false;
        scheduleRetry();
        return;
      }
      if (e.status === 401) {
        // The token is being refused: the session ends; keep the answer for the next one.
        update(entry.questionId, entry.answerId, { state: 'queued' });
        flushAgain = false;
        return;
      }
      const reason: NotSentReason =
        e.code === 'stale'
          ? 'stale'
          : e.status === 404
            ? 'gone'
            : /cancelled/.test(e.message)
              ? 'withdrawn'
              : 'refused';
      update(entry.questionId, entry.answerId, { state: 'not_sent', reason, message: e.message });
      const world = useAppStore.getState().world;
      announce(
        `Your queued answer ${quote(entry.answer)} was not sent: ${notSentLine(world, { ...entry, state: 'not_sent', reason, message: e.message })}.`,
      );
      continue;
    }
    update(entry.questionId, entry.answerId, { state: 'sent' });
    announce(`Your queued answer ${quote(entry.answer)} to ${quote(entry.text)} was sent.`);
    const timer = setTimeout(() => {
      session?.sentTimers.delete(timer);
      const now = useAnswerQueue.getState().entries[entry.questionId];
      if (now?.answerId === entry.answerId && now.state === 'sent') remove(entry.questionId);
    }, SENT_NOTICE_MS);
    session.sentTimers.add(timer);
  }
}

// -- wording -----------------------------------------------------------------------------------

type WorldView = Pick<WorldState, 'questions' | 'agents' | 'projects' | 'tasks'>;

/**
 * Who answered a question first, as a queued answer's owner should read it: "you, on another
 * device or tab", a supervisor by name, the permission policy.
 */
export function answeredByLine(world: WorldView, q: Question, entry?: QueuedAnswer): string {
  const by = q.answeredBy;
  const what = q.answer ? `: ${quote(q.answer)}` : '';
  if (!by || by.type === 'user') {
    const mine = entry && q.meta?.['answerId'] === entry.answerId;
    return mine ? `sent${what}` : `already answered by you on another device or tab${what}`;
  }
  if (by.type === 'agent') {
    const agent = by.id ? world.agents[by.id] : undefined;
    const role = agent && agent.role !== 'steward' ? ' (its supervisor, from context)' : '';
    return `already answered by ${agentLabel(agent, world)}${role}${what}`;
  }
  return `already answered by ${q.kind === 'permission' ? 'the permission policy' : 'the system'}${what}`;
}

/** Why a queued answer was not sent, from the folded world when it knows more than the refusal. */
export function notSentLine(world: WorldView, entry: QueuedAnswer): string {
  const q = world.questions[entry.questionId];
  if (q?.status === 'answered') return answeredByLine(world, q, entry);
  if (q?.status === 'cancelled' || entry.reason === 'withdrawn')
    return 'the question was withdrawn';
  if (entry.reason === 'gone' || (!q && entry.reason !== 'refused' && entry.reason !== 'stale')) {
    return 'the question no longer exists';
  }
  if (q && entry.reason === 'stale') {
    return `the question changed while you were offline (it is now held by ${actorLabel(q.holder, world)}); answer it again if it still applies`;
  }
  if (entry.reason === 'stale') {
    // The page does not hold the question (yet: a reload before the snapshot): the refusal says.
    const m = entry.message ?? '';
    if (/already answered by the user/.test(m))
      return 'already answered by you on another device or tab';
    if (/already answered by agent/.test(m)) return 'already answered by a supervisor';
    if (/already answered by the system/.test(m)) return 'already answered by the system';
    return 'the question changed while you were offline';
  }
  return entry.message ?? 'the server refused it';
}
