import { z } from 'zod';
import { Id, Timestamp } from './primitives.js';
import { AgentRole, AgentRuntime, HostKind, QuestionKind, WorkState } from './enums.js';
import {
  Actor,
  Agent,
  PermissionPolicy,
  Project,
  Question,
  Task,
  TranscriptChunk,
} from './domain.js';
import type { EventEnvelope } from './events.js';

// ---------------------------------------------------------------------------
// The side panel's REST surface (P25-01; SPEC §4.2–4.6, TECHNOLOGY §2.2 "a small REST surface
// for history"). Bearer-guarded like every `/api` route; live state still arrives on the
// WebSocket stream, these endpoints fill in history, settings, preflight and missed
// notifications.
// ---------------------------------------------------------------------------

/** A page size: 1–200, default 50. Query strings arrive as text, so it is coerced. */
const Limit = z.coerce.number().int().min(1).max(200).default(50);

// --- conversation history ---------------------------------------------------------------------

/**
 * One line of a conversation with an agent (P25-01): either a message sent **to** it
 * (`message.sent`: the user's lines, a subordinate's report, a system notice) or a text block it
 * wrote (`reply`: a `text` transcript chunk — how a brain's answers reach the user, since the
 * SDK adapter emits one chunk per assistant text block). Thinking and tool chunks are not part of
 * the conversation; the transcript endpoint has them.
 *
 * The order is (`at`, messages before replies at the same instant, `seq`/`chunkSeq`); `cursor`
 * is that position, opaque to clients, for paging in either direction.
 */
export const ConversationEntry = z.object({
  /** `m:<messageId>` for a message, `r:<agentId>:<chunkSeq>` for a reply: stable, for dedup. */
  id: z.string().min(1),
  agentId: Id,
  kind: z.enum(['message', 'reply']),
  at: Timestamp,
  /** Who wrote it: for a reply, the agent itself (`{type: 'agent', id: agentId}`). */
  sender: Actor,
  text: z.string(),
  /** A message's `messageId` (as `ChatMessage.messageId` and the stream's `message.sent`). */
  messageId: Id.optional(),
  /** A message's event `seq`. */
  seq: z.number().int().positive().optional(),
  /** A reply's transcript `seq` (as the `transcript` stream numbers it). */
  chunkSeq: z.number().int().positive().optional(),
  cursor: z.string().min(1),
});
export type ConversationEntry = z.infer<typeof ConversationEntry>;

/**
 * `GET /api/agents/:id/conversation?before=&after=&limit=`: without a cursor, the newest page;
 * `before` pages back (older), `after` pages forward (newer). Not both.
 */
export const ConversationQuery = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    limit: Limit,
  })
  .refine((q) => !(q.before && q.after), { message: 'before and after are exclusive' });
export type ConversationQuery = z.input<typeof ConversationQuery>;

// --- transcript retention (P8-02) ---------------------------------------------------------------

/**
 * What transcript retention removed from one agent's transcript (P8-02; TECHNOLOGY §6.2): every
 * chunk up to `throughSeq` (written up to `throughAt`) is gone, last removed at `removedAt`.
 * `reason`: `age` — older than the transcript age limit; `archived` — the agent's work was
 * archived longer ago than the archived-work limit. Only `transcript_chunks` are compacted; the
 * event log (messages, tool calls, states) is kept whole.
 */
export const TranscriptCompaction = z.object({
  throughSeq: z.number().int().positive(),
  throughAt: Timestamp,
  removedAt: Timestamp,
  reason: z.enum(['age', 'archived']),
});
export type TranscriptCompaction = z.infer<typeof TranscriptCompaction>;

/**
 * The transcript retention policy (P8-02; settings, decision 51), in days (fractions allowed),
 * `null` = keep forever. `maxAgeDays`: any agent's chunks older than this are removed (a running
 * Harmonizer's too). `archivedDays`: an agent's whole transcript is removed this long after its
 * work (task or project) was archived. Pinned work is never compacted.
 */
export const TranscriptRetention = z.object({
  maxAgeDays: z.number().positive().max(3650).nullable(),
  archivedDays: z.number().nonnegative().max(3650).nullable(),
});
export type TranscriptRetention = z.infer<typeof TranscriptRetention>;

export const DEFAULT_TRANSCRIPT_RETENTION: TranscriptRetention = {
  maxAgeDays: 90,
  archivedDays: 30,
};

/** A page of a conversation, always oldest first; `hasMore`: there is more in the paged direction. */
export const ConversationResponse = z.object({
  entries: z.array(ConversationEntry),
  hasMore: z.boolean(),
  /**
   * The agent's newest **persisted** transcript `seq` when the page was read (0 for none): where
   * the live transcript starts (`transcript.subscribe{since: lastSeq}`), so a reply still buffered
   * in the pipeline (not in the page yet) arrives on the stream instead of being missed.
   */
  lastSeq: z.number().int().nonnegative(),
  /**
   * Set when retention removed part of the agent's transcript (P8-02): its replies up to
   * `throughAt` are gone (its messages are not), so the chat says so instead of showing a thread
   * with the replies silently missing. Optional: an older server never sends it.
   */
  compacted: TranscriptCompaction.optional(),
});
export type ConversationResponse = z.infer<typeof ConversationResponse>;

// --- transcript -------------------------------------------------------------------------------

export const TranscriptKind = TranscriptChunk.shape.kind;

/**
 * `GET /api/agents/:id/transcript?before=&after=&limit=&kinds=`: an agent's persisted transcript
 * chunks (P1-06) by per-agent `seq`. Without a cursor the newest page; `after` is what
 * `transcript.subscribe{since}` takes, so a client can backfill by REST and go live by socket.
 * `kinds` filters (comma-separated, e.g. `text,tool`).
 */
export const TranscriptQuery = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().nonnegative().optional(),
    limit: Limit,
    kinds: z
      .string()
      .transform((s) => s.split(',').filter(Boolean))
      .pipe(z.array(TranscriptKind).min(1))
      .optional(),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: 'before and after are exclusive',
  });
export type TranscriptQuery = z.input<typeof TranscriptQuery>;

export const TranscriptResponse = z.object({
  /** Oldest first. */
  chunks: z.array(TranscriptChunk),
  hasMore: z.boolean(),
  /**
   * The agent's newest persisted `seq` when the page was read (0 for none): the `since` of a
   * `transcript.subscribe` that continues it. Buffered chunks are not counted — they reach the
   * subscriber with the next flush, which a `since` past them would drop.
   */
  lastSeq: z.number().int().nonnegative(),
  /**
   * Set when retention removed the start of the transcript (P8-02): the chunks up to
   * `throughSeq` are gone, so the oldest page says "older transcript removed … by retention".
   */
  compacted: TranscriptCompaction.optional(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponse>;

// --- settings ---------------------------------------------------------------------------------

/** The renderer's quality tier (IMPLEMENTATION_PLAN Phase 3: high / balanced / mobile). */
export const QualityTier = z.enum(['high', 'balanced', 'mobile']);
export type QualityTier = z.infer<typeof QualityTier>;

/** Every cap the settings page edits (decision 18, 43): per agent, concurrency and spawn rates. */
export const SettingsCaps = z.object({
  /** Live Stewards at once (brains not counted, decision 43). */
  maxConcurrentAgents: z.number().int().positive().max(64),
  maxStewardsPerWaykeeper: z.number().int().positive().max(64),
  maxSpawnsPerHour: z.number().int().positive().max(10_000),
  maxSpawnsPerHourPerBrain: z.number().int().positive().max(10_000),
  /** A new agent's wall-clock cap (ms); 1 min – 7 days. */
  maxWallClockMs: z
    .number()
    .int()
    .min(60_000)
    .max(7 * 24 * 60 * 60 * 1000),
  /** A new agent's tool-call cap. */
  maxToolCalls: z.number().int().positive().max(100_000),
});
export type SettingsCaps = z.infer<typeof SettingsCaps>;

/** The settings the panel shows and edits (SPEC §4.6), persisted in `config.json`. */
export const Settings = z.object({
  /** Where new project folders go (SPEC §3.5): an absolute path or `~/…`. */
  projectsRoot: z.string().min(1),
  /** The global default permission table (SPEC §3.6, decision 22): what a project without its own uses. */
  defaultPermissionPolicy: PermissionPolicy,
  /** Decision 4's retention period, in days (fractions allowed); up to 10 years. */
  retentionDays: z.number().positive().max(3650),
  caps: SettingsCaps,
  qualityTier: QualityTier,
  /**
   * Whether Stewards load the user's own Claude Code settings (`~/.claude`) besides the
   * repository's (SPEC §8 open question; default keep). Brains never do.
   */
  stewardsLoadUserSettings: z.boolean(),
  /**
   * Transcript retention (P8-02). Optional so a page reading an older server still parses (the
   * settings page then leaves the section out); this server always sends it.
   */
  transcriptRetention: TranscriptRetention.optional(),
});
export type Settings = z.infer<typeof Settings>;

/** The names of the settings, for `envOverrides` / `restartRequired`. */
export const SettingName = z.enum([
  'projectsRoot',
  'defaultPermissionPolicy',
  'retentionDays',
  'caps',
  'qualityTier',
  'stewardsLoadUserSettings',
  'transcriptRetention',
]);
export type SettingName = z.infer<typeof SettingName>;

/**
 * `PATCH /api/settings`: any subset, validated as a whole before anything is written. `caps` is
 * merged key by key; `defaultPermissionPolicy: null` returns to the SPEC §3.6 table. A remote
 * client's policy is floored at the current default unless `autoApproveRemote` (decision 37).
 */
export const SettingsPatch = z
  .object({
    projectsRoot: Settings.shape.projectsRoot.optional(),
    defaultPermissionPolicy: PermissionPolicy.nullable().optional(),
    retentionDays: Settings.shape.retentionDays.optional(),
    caps: SettingsCaps.partial().strict().optional(),
    qualityTier: QualityTier.optional(),
    stewardsLoadUserSettings: z.boolean().optional(),
    /** Transcript retention (P8-02), merged key by key; local requests only (decision 51, 90). */
    transcriptRetention: TranscriptRetention.partial().strict().optional(),
    /**
     * Marks the first-run setup as done (P25-08): the server stamps `setupCompletedAt` in
     * `config.json` (kept if already set). Local requests only, like every setting but the tier
     * and the policy (decision 51).
     */
    setupCompleted: z.literal(true).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** `GET /api/settings` and the reply to a patch. */
export const SettingsResponse = z.object({
  settings: Settings,
  /**
   * Settings an environment variable decides (`GALACTIC_PROJECTS_ROOT`, `GALACTIC_RETENTION_DAYS`,
   * `GALACTIC_MAX_*`): shown read-only, a patch of them is refused (409 `env_override`).
   */
  envOverrides: z.array(SettingName),
  /** Saved but applied only at the next start (shown as "restart to apply"). */
  restartRequired: z.array(SettingName),
  /** Set on a patch reply when a remote client's policy was floored at the default (decision 37). */
  floored: z.boolean().optional(),
  /**
   * When the first-run setup was finished or skipped (P25-08). Absent: the panel walks the user
   * through the first-run wizard before showing the panel.
   */
  setupCompletedAt: Timestamp.optional(),
  /**
   * What the requesting client may change (P25-08, decision 51), decided from the request's
   * origin as the patch decides it: `all` for a local request (or any request when
   * `autoApproveRemote`), `limited` for a remote or unknown-origin one (the quality tier and a
   * tighter default policy only — not the first-run marker). Absent (an older server): `all`.
   */
  writable: z.enum(['all', 'limited']).optional(),
  /**
   * Remote access as configured (P7-02; `docs/REMOTE_ACCESS.md`): `host` is the Tailscale Serve
   * name (`remoteHost`), from which the settings page builds the phone's address and QR code;
   * `tailscaleIdentity` says whether identity headers are accepted as a credential. Read-only:
   * set in `config.json` / the environment. Absent (an older server): no remote access set up.
   */
  remote: z
    .object({
      host: z.string().min(1).optional(),
      tailscaleIdentity: z.boolean(),
    })
    .optional(),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

// --- runtime preflight ------------------------------------------------------------------------

/** One thing wrong with a runtime, worded for the user, with what fixes it. */
export const PreflightProblem = z.object({
  code: z.enum([
    'not_installed',
    'not_logged_in',
    'auth_unreadable',
    'not_subscription',
    'sdk_missing',
    'check_failed',
  ]),
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
  /** What to do, e.g. "run `claude` and log in with /login". */
  fix: z.string().optional(),
});
export type PreflightProblem = z.infer<typeof PreflightProblem>;

/**
 * What an adapter reports about its runtime (P25-01; SPEC §4.6): installed, logged in, versions.
 * `ok` is false only for an `error` problem; warnings leave it usable.
 */
export const RuntimePreflight = z.object({
  runtime: AgentRuntime,
  ok: z.boolean(),
  installed: z.boolean(),
  /** The runtime's CLI version (`claude --version`). */
  version: z.string().optional(),
  /** The SDK the adapter drives (the `claude-sdk` adapter's Agent SDK version). */
  sdkVersion: z.string().optional(),
  loggedIn: z.boolean().optional(),
  /** `claude auth status`: `claude.ai` for a subscription login, else an API key or a cloud. */
  authMethod: z.string().optional(),
  /** `pro`, `max`, `team`, … for a subscription login. */
  subscriptionType: z.string().optional(),
  apiProvider: z.string().optional(),
  problems: z.array(PreflightProblem),
});
export type RuntimePreflight = z.infer<typeof RuntimePreflight>;

/** `GET /api/preflight`: every registered adapter's check. `ok` when none has an error. */
export const PreflightResponse = z.object({
  ok: z.boolean(),
  runtimes: z.array(RuntimePreflight),
  /** When the checks ran (cached for a short while; `?refresh=1` runs them again). */
  checkedAt: Timestamp,
});
export type PreflightResponse = z.infer<typeof PreflightResponse>;

// --- notifications ----------------------------------------------------------------------------

/** What SPEC §4.5 notifies about. */
export const NotificationKind = z.enum([
  /** A clarification question opened for (or escalated to) the user. */
  'question',
  /** A permission card for the user. */
  'permission',
  'task_completed',
  'task_failed',
  'project_completed',
  'project_failed',
  /**
   * Work interrupted by a restart: recovery left an agent interrupted (`recovery.needs_attention`;
   * it can be resumed from the panel). Not every `agent.interrupted`: a graceful shutdown of an
   * agent that comes back, or a brain's session reset, is not news.
   */
  'interrupted',
  /** A request parked for lack of a free body (decision 16). */
  'no_space',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** What a notification's click focuses. */
export const NotificationTarget = z.object({
  kind: z.enum(['question', 'task', 'project', 'agent', 'proposal']),
  id: Id,
});
export type NotificationTarget = z.infer<typeof NotificationTarget>;

/**
 * One notification, derived from one event (`notificationOf`). `id` is stable — the same event
 * always gives the same id, and a question gives one id however often it reaches the user — so a
 * client that dedupes by id never notifies twice across reconnects or between the REST backfill
 * and the live stream.
 */
export const PanelNotification = z.object({
  id: z.string().min(1),
  kind: NotificationKind,
  seq: z.number().int().positive(),
  at: Timestamp,
  title: z.string().min(1),
  body: z.string().optional(),
  target: NotificationTarget,
  /** The question's kind (`question` / `permission`), the interrupted agent's role. */
  questionKind: QuestionKind.optional(),
  role: AgentRole.optional(),
});
export type PanelNotification = z.infer<typeof PanelNotification>;

/** `GET /api/notifications?after=&limit=`: without `after`, the newest page. */
export const NotificationsQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: Limit,
});
export type NotificationsQuery = z.input<typeof NotificationsQuery>;

export const NotificationsResponse = z.object({
  /** Oldest first. */
  notifications: z.array(PanelNotification),
  /** The last event `seq` looked at: the next `after`. */
  seq: z.number().int().nonnegative(),
  /** More notifications after `seq` (page again with `after = seq`). */
  hasMore: z.boolean(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

/** Names for the text of a notification; both sides pass what their tables / world hold. */
export interface NotificationLookup {
  task?(id: Id): { description?: string } | undefined;
  project?(id: Id): { name?: string } | undefined;
  question?(id: Id): Pick<Question, 'kind' | 'context'> | undefined;
  agent?(id: Id): { role?: AgentRole } | undefined;
}

/** The event types `notificationOf` may turn into a notification (for an indexed scan). */
export const NOTIFYING_EVENT_TYPES = [
  'question.opened',
  'question.escalated',
  'question.reassigned',
  'task.state_changed',
  'project.state_changed',
  'recovery.needs_attention',
  'proposal.parked',
] as const;

const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * The notification one committed event is worth (SPEC §4.5), or `undefined`. Pure: the server's
 * feed and a client folding the live stream call it alike, so both produce the same ids.
 */
export function notificationOf(
  envelope: EventEnvelope,
  lookup: NotificationLookup = {},
): PanelNotification | undefined {
  const { seq, at, event } = envelope;
  const base = { seq, at };
  switch (event.type) {
    case 'question.opened':
    case 'question.escalated':
    case 'question.reassigned': {
      const question = event.type === 'question.opened' ? event.question : undefined;
      const holder = event.type === 'question.opened' ? event.question.holder : event.to;
      if (holder.type !== 'user') return undefined;
      const id = question?.id ?? (event as { questionId: Id }).questionId;
      const known = question ?? lookup.question?.(id);
      const kind = known?.kind ?? 'clarification';
      return {
        ...base,
        id: `question:${id}`,
        kind: kind === 'permission' ? 'permission' : 'question',
        title: kind === 'permission' ? 'Permission needed' : 'A question for you',
        ...(known?.context.text ? { body: clip(known.context.text) } : {}),
        target: { kind: 'question', id },
        questionKind: kind,
      };
    }
    case 'task.state_changed':
    case 'project.state_changed': {
      if (event.to !== 'completed' && event.to !== 'failed') return undefined;
      if (event.from === event.to) return undefined;
      const isTask = event.type === 'task.state_changed';
      const id = isTask ? event.taskId : event.projectId;
      const name = isTask ? lookup.task?.(id)?.description : lookup.project?.(id)?.name;
      const what = isTask ? 'Task' : 'Project';
      const done = event.to === 'completed';
      return {
        ...base,
        id: `${isTask ? 'task' : 'project'}:${id}:${event.to}:${seq}`,
        kind: `${isTask ? 'task' : 'project'}_${done ? 'completed' : 'failed'}`,
        title: `${what} ${done ? 'finished' : 'failed'}`,
        ...(name ? { body: clip(name) } : {}),
        target: { kind: isTask ? 'task' : 'project', id },
      };
    }
    case 'recovery.needs_attention': {
      const role = lookup.agent?.(event.agentId)?.role;
      return {
        ...base,
        id: `interrupted:${event.agentId}:${seq}`,
        kind: 'interrupted',
        title: 'Work interrupted by a restart',
        body: clip(event.reason),
        target: { kind: 'agent', id: event.agentId },
        ...(role ? { role } : {}),
      };
    }
    case 'proposal.parked': {
      if (!event.waitingFor) return undefined; // parked by a decision, not for lack of room
      return {
        ...base,
        id: `no_space:${event.proposalId}:${seq}`,
        kind: 'no_space',
        title: `No free ${event.waitingFor} for a request`,
        body: clip(event.reason),
        target: { kind: 'proposal', id: event.proposalId },
      };
    }
    default:
      return undefined;
  }
}

// --- history (P25-10) -------------------------------------------------------------------------

/**
 * SPEC §4.2's history view: finished and archived work and past questions, read over REST (the
 * snapshot carries every row today, but the history grows without bound and is searched, so the
 * server pages it rather than the client folding it). Both lists are newest first by the row's
 * `updatedAt` — when the work last changed (finished, archived, pinned) or the question was
 * answered or cancelled — and page back with the opaque `cursor` of the last item (`before`).
 */

/** The work states the history lists (SPEC §4.4): finished (closed, failed or cancelled) and archived. */
export const HistoryWorkState = z.enum(['completed', 'failed', 'archived']);
export type HistoryWorkState = z.infer<typeof HistoryWorkState>;

/** The question statuses the history lists: answered, and cancelled (withdrawn, or ended with its agent). */
export const HistoryQuestionStatus = z.enum(['answered', 'cancelled']);
export type HistoryQuestionStatus = z.infer<typeof HistoryQuestionStatus>;

/** Free-text search: trimmed, matched as a case-insensitive substring; blank means no search. */
const SearchText = z
  .string()
  .trim()
  .max(200)
  .transform((s) => (s === '' ? undefined : s))
  .optional();

/**
 * `GET /api/history/work?before=&q=&kind=&state=&limit=`: finished and archived projects and
 * tasks. `q` searches a project's name and a task's description; `kind` keeps projects or tasks
 * only; `state` keeps some of the history states (comma-separated, e.g. `completed,failed`).
 */
export const HistoryWorkQuery = z.object({
  before: z.string().min(1).optional(),
  q: SearchText,
  kind: HostKind.optional(),
  state: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(HistoryWorkState).min(1))
    .optional(),
  limit: Limit,
});
export type HistoryWorkQuery = z.input<typeof HistoryWorkQuery>;

/**
 * One move of a project or task (P5-03; SPEC §3.4, decision 15 "the history view keeps the
 * link"): from the log, oldest first. A `body.moved` gives `fromBodyId` → `toBodyId` (and
 * `intoProjectId` when a standalone task joined that project); a project task handed to another
 * project (a Waykeeper's promotion, `task.updated` with a new `projectId`) gives `intoProjectId`
 * and the body it lives on now. Names are resolved by the server so the link reads even when the
 * client no longer holds the rows.
 */
export const HistoryMove = z.object({
  at: Timestamp,
  fromBodyId: Id.optional(),
  fromBodyName: z.string().optional(),
  toBodyId: Id.optional(),
  toBodyName: z.string().optional(),
  intoProjectId: Id.optional(),
  intoProjectName: z.string().optional(),
});
export type HistoryMove = z.infer<typeof HistoryMove>;

/** A project or task named in a history link: its kind, id and name (a task's description). */
export const HistoryWorkRef = z.object({ kind: HostKind, id: Id, name: z.string() });
export type HistoryWorkRef = z.infer<typeof HistoryWorkRef>;

/**
 * What the log says about a piece of work beyond its row (P5-03), derived from its
 * `*.state_changed`, `body.moved` and `task.updated` events: when it was closed (its last move
 * into `completed`, `failed` or `moved`, while it is still finished), archived (while it is) and
 * last reopened; where it moved; and the promotion link both ways — the project a task was
 * promoted into (`promotedTo`), the task a project was promoted from (`promotedFrom`, from the
 * project's `meta.promotedFrom`).
 */
export const HistoryWorkTrail = z.object({
  closedAt: Timestamp.optional(),
  archivedAt: Timestamp.optional(),
  reopenedAt: Timestamp.optional(),
  moves: z.array(HistoryMove),
  promotedTo: HistoryWorkRef.optional(),
  promotedFrom: HistoryWorkRef.optional(),
});
export type HistoryWorkTrail = z.infer<typeof HistoryWorkTrail>;

/**
 * One finished or archived project or task, as the domain table holds it, with its position, the
 * name of the body it lives (or lived) on, and its trail (P5-03; absent from servers before it).
 */
export const HistoryWorkItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    item: Project,
    cursor: z.string().min(1),
    bodyName: z.string().optional(),
    trail: HistoryWorkTrail.optional(),
  }),
  z.object({
    kind: z.literal('task'),
    item: Task,
    cursor: z.string().min(1),
    bodyName: z.string().optional(),
    trail: HistoryWorkTrail.optional(),
  }),
]);
export type HistoryWorkItem = z.infer<typeof HistoryWorkItem>;

export const HistoryWorkResponse = z.object({
  /** Newest first. */
  items: z.array(HistoryWorkItem),
  /** Older items exist: page again with `before` = the last item's `cursor`. */
  hasMore: z.boolean(),
});
export type HistoryWorkResponse = z.infer<typeof HistoryWorkResponse>;

/**
 * `GET /api/history/questions?before=&q=&kind=&status=&limit=`: answered and cancelled
 * questions. `q` searches the question's text and its answer.
 */
export const HistoryQuestionsQuery = z.object({
  before: z.string().min(1).optional(),
  q: SearchText,
  kind: QuestionKind.optional(),
  status: HistoryQuestionStatus.optional(),
  limit: Limit,
});
export type HistoryQuestionsQuery = z.input<typeof HistoryQuestionsQuery>;

/**
 * One holder of a question, in order (P5-03): the first is who it was routed to when it was asked
 * (the asker's supervisor, or the user for a permission), then one step per `question.escalated`
 * (up the hierarchy, e.g. Waykeeper → Harmonizer → user) or `question.reassigned` (its holder
 * ended; `reason` says why). `at` is when that holder got it.
 */
export const HolderStep = z.object({
  holder: Actor,
  at: Timestamp,
  via: z.enum(['asked', 'escalated', 'reassigned']),
  reason: z.string().optional(),
});
export type HolderStep = z.infer<typeof HolderStep>;

/**
 * One past question as the domain table (and the stream) holds it: who answered (`answeredBy`),
 * the answer, and when (`updatedAt`). A cancelled one carries the `reason` of its
 * `question.cancelled` (withdrawn by its agent, ended with its agent, …).
 */
export const HistoryQuestion = z.object({
  question: Question,
  reason: z.string().optional(),
  cursor: z.string().min(1),
  /** Who held it, in order (P5-03; absent from servers before it). */
  holders: z.array(HolderStep).optional(),
});
export type HistoryQuestion = z.infer<typeof HistoryQuestion>;

export const HistoryQuestionsResponse = z.object({
  /** Newest first. */
  items: z.array(HistoryQuestion),
  hasMore: z.boolean(),
});
export type HistoryQuestionsResponse = z.infer<typeof HistoryQuestionsResponse>;

// --- history detail (P5-03) -------------------------------------------------------------------

/** One state change of a piece of work, from its `*.state_changed` event. */
export const HistoryStateStep = z.object({
  at: Timestamp,
  from: WorkState,
  to: WorkState,
  by: Actor.optional(),
});
export type HistoryStateStep = z.infer<typeof HistoryStateStep>;

/** `GET /api/history/work/:kind/:id`'s path parameters. */
export const HistoryWorkParams = z.object({ kind: HostKind, id: Id });
export type HistoryWorkParams = z.infer<typeof HistoryWorkParams>;

/**
 * `GET /api/history/work/:kind/:id` (P5-03): one project or task inspected from the history, in
 * any state (a moved-to link may lead to live work). Its row and trail, the body name, every
 * state change oldest first, its project (a task's, or a sub-project's parent), a project's tasks
 * and sub-projects, the agents that ran it (a project's Waykeepers and Stewards, a task's
 * Stewards), and the questions those agents asked — newest first, at most 50
 * (`moreQuestions` when there were more) — each with its holder chain.
 */
export const HistoryWorkDetail = z.object({
  work: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project'), item: Project }),
    z.object({ kind: z.literal('task'), item: Task }),
  ]),
  bodyName: z.string().optional(),
  trail: HistoryWorkTrail,
  states: z.array(HistoryStateStep),
  project: Project.optional(),
  tasks: z.array(Task),
  subProjects: z.array(Project),
  agents: z.array(Agent),
  questions: z.array(HistoryQuestion),
  moreQuestions: z.boolean(),
});
export type HistoryWorkDetail = z.infer<typeof HistoryWorkDetail>;
