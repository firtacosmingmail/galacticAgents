# P8-09 — Storage health in the panel

Branch `p8-09-storage`, from `p8-wave2-smoke-backup-storage-caps` (edbdfbb). 2026-10-06. Follows
P8-04 finding F2 (`P8-04-drills.md`, "Review fixes") and SPEC decision 99.

## What the user sees

- **A banner under the top bar** while the database refuses writes:
  - disk full: "Disk full — 42 agent events waiting to be saved; your actions are refused until
    there is space." (without held events: "Disk full — your actions are refused until there is
    space."), then "Agents keep working and what they do is saved as soon as there is room. Free
    some space on the disk, then repeat what was refused. Since 10:42.";
  - read-only or missing database: "The database cannot be written (the file is read-only or
    missing) — … your actions are refused until it is fixed." / "This does not pass by itself: fix
    the database file's permissions or restore it.";
  - another storage failure (I/O error, lock held too long): "The database cannot be written just
    now — … your actions are refused until it can.";
  - when agent output had to be dropped to stay within the held queue's limit: "N older tool calls
    and progress lines were not kept, to stay within the limit."
- **Announcements:** assertive (`role="alert"`) when writes start failing, when a page opens on a
  refusing storage, or when the condition changes; polite when writes work again ("The database
  takes writes again: the waiting agent events are saved."). The moving count is never announced —
  the band itself is a labelled region ("Storage problem"), not a live region. Colours: the
  `--pnl-failed` hue, never the beacon's amber (that is "blocked on you").
- **A refused action says why, on its control:** the REST reply is 507 `storage_full` ("The disk
  is full: your action was not saved. Free some space on the disk, then try again."), 503
  `storage_unavailable` or 503 `storage_unwritable`; the panel's error line under the control shows
  the server's message (controls strip, cards, chat composer, question cards — every place that
  already showed a refusal's message).
- **An answer refused for a full disk is not queued.** The offline answer queue (P7-05) retried
  every 5xx as a passing failure; a storage code is now a refusal: the card shows "The disk is
  full…" and keeps its answer controls (decision 99: refused whole, never queued; the user repeats).
- **Recovery:** the banner clears once the held events are written (the drill: within a second of
  the queue draining).

## Design

**Not an event.** The storage state cannot be a protocol event: while the disk is full nothing can
be written, so "the disk is full" could never reach the log, and logging "writes work again" after
the fact tells nobody anything. It is runtime state like the status records, sent on the WebSocket:

- `SnapshotMessage.storage?` — the health when the snapshot was built;
- `StatusMessage.storage?` — when it changed. The server always sends it on a **replacing** status
  message (`statuses: all(), replace: true, storage`). Reason: forward compatibility (TECHNOLOGY
  §6.3 rule 5). A new message kind closes every page built before it (unknown kind → 4002 →
  resume → same message → loop until a reload), and a storage-only status message fails an old
  page's refine (no records, no removals, no `replace`). A replacing set with an extra field reads
  on an old page as an ordinary replacing set (zod strips `storage`) — tested in
  `storage.test.ts`. The cost is the record set once per change (at most once a second for count
  changes, a few dozen records). This build's refine accepts `storage` alone, so a later server may
  drop the set.
- After a replay's `caught_up`, the existing replacing status message carries it too.

**`StorageMonitor`** (`apps/server/src/runtime/storage-health.ts`, created by `composeRuntime`,
`ComposedRuntime.storage`):

- source 1: `AgentRuntime.storageState()` — the held queue (count, dropped, since, error, and now
  the SQLite `code`);
- source 2: `EventLog.addStorageObserver` — told after every outermost command whether the storage
  refused it (`isStorageFailure`, including the runtime's before-command refusal) or it committed
  at least one event. A refusal with nothing held still shows the banner (the user acted on a full
  disk while no agent ran); the next commit with an event clears it. Known limit: with nothing
  held and nothing committing (no agent running, the user does not retry), the banner stays until
  the next successful write — conservative (it never claims space that is not there).
- condition from the SQLite code (`storageConditionOf` in `db/database.ts`): FULL → `full`;
  READONLY / CANTOPEN → `unwritable`; IOERR, BUSY, LOCKED, PROTOCOL → `unavailable`;
- publishing: a change of condition at once; a change of counts alone at most once per second
  (trailing timer); while refusing, the held queue is read every 250 ms (held events accumulate
  without any command running); the observer's notifications are read on `setImmediate`, because a
  drained write leaves the queue only after its command returned.

**REST** (`apps/server/src/http/storage-refusal.ts`, codes and words in the protocol's
`STORAGE_ERROR`): the agent routes' `attempt` (pause, resume, stop, interrupt, send, the Phase 1
answer — formerly 409 for any throw) and `refuse` (control, decide, answer, processes — formerly
500 for a non-domain error), the Harmonizer restart, and a root `setErrorHandler` for any storage
failure that escapes a route (push subscriptions, `/dev/*`, spawn). **WebSocket:** the socket
carries no actions (`transcript.subscribe` writes nothing), so there is nothing to refuse on it.

## Push / desktop notification: not done

A push needs no write to send — but the push service writes `last_sent_at` / `last_error` after
each delivery (`PushStore.markSent` / `markFailed`), and a new kind means a new `PushKind`, a new
per-device switch in the settings, the service worker's text, the desktop notifications' kind list
(decision 59) and a "once per episode" ledger — not "simple". Left out; proposed below as a
follow-up decision if wanted. Found on the way: `deliver` calls `markSent` inside the send's
`try`, so on a full disk a push that *was* delivered fails its `markSent` with SQLITE_FULL, is taken
for a network error and **sent again** (up to three attempts), then `markFailed` throws too.
Push only follows committed events, so this needs the log's last pages to take an event while the
`push_subscriptions` update cannot — rare, but real. Proposed task (not appended, to avoid a
conflict with the wave's other branches): **"Push bookkeeping on a full disk"** — move
`markSent` out of the send's `try` and ignore a storage failure of the bookkeeping writes.

## Proposed SPEC text (not edited: §7 belongs to Cosmin)

- **Decision 99, last sentences reworded** — replace "The panel will say the disk is full and how
  many agent events are waiting (P8-09; until then the console logs it)." with: "The panel says
  so in a band under the top bar — the disk is full and how many agent events are waiting to be
  saved, or that the database cannot be written at all and the file must be fixed — and a refused
  action says 'the disk is full' on the control that was refused (P8-09). The band goes once the
  waiting events are written."
- **Decision 104 — Storage health is shown, not logged** (P8-09; decision 99, §4.5):
  whether the database takes writes is shown live in the panel, never kept in the history: a full
  disk cannot record that it is full. A screen reader hears when writes start failing and when
  they work again, not every change of the count. An answer refused for a full disk is not queued
  like an offline answer: the user answers again once there is room. No push or desktop
  notification for a full disk for now (the console line and the banner); open question below.
- **Open question (§8):** should a full disk also send a push / desktop notification, once per
  episode (it may be the only way the user learns of it while away, and a push needs no database
  write to send)? Conservative meanwhile: no notification.

## Tests

- Protocol `storage.test.ts` (4): the schema, the fields on snapshot / status, storage alone
  accepted, what an old page's schema reads, the code/status mapping.
- Server `runtime/storage-health.test.ts` (8): a refused command with nothing held → `full`, the
  next commit → `ok`; held events counted and cleared when written; `unwritable` / `unavailable`;
  permanent held → `unwritable`; the once-a-second throttle; over a real socket: the snapshot, a
  replacing status message with the record set, 507 for pause / control / send with nothing
  written, a late snapshot and a resumed client get it, the banner state clears; 503
  `storage_unwritable` / `storage_unavailable`; an escaping storage error → 507 via the root
  handler. `domain/event-log.test.ts` (+1): observer semantics (outermost only, no-event commits
  and other failures not reported, the before-command hook's refusal reported).
- Drill 4 (`test/drills/disk-full.test.ts`) extended: a socket and the REST surface over the
  drill's world; with the real full file, the storage state reaches the socket **within a second**
  of the first held write (asserted), as a replacing status message; the refused pause through
  `/api/control` is 507 `storage_full` with nothing written; the count on the socket follows the
  queue; after space returns the state goes back to `ok` within a second. The first drill case
  checks a refusal with nothing held shows `full` and clears.
- Web `panel/storage-banner.test.tsx` (7): the words for each condition; no banner while ok; the
  banner appears, follows the count without re-announcing, clears with a polite announcement, and
  the replacing set keeps the records; a page opened on a full disk; the unwritable words; a
  refused control shows the disk-full message under its strip; a refused answer is shown on its
  card and not queued; axe (no serious/critical findings) with the banner up.

## Review fixes (P8 wave 2 review, 2026-10-06)

- `PATCH /api/settings`: a full disk writing `config.json` (ENOSPC / EDQUOT) is now 507 `storage_full` (EIO: 503 `storage_unavailable`) through `fileWriteRefusal` (`http/storage-refusal.ts`), not a 500; nothing is applied (the settings service writes the file before applying) and the truncated temp file is removed. Test in `panel-routes.test.ts`.
- The task text in `PHASE_8_HARDENING.md` now says the push notification is deferred to the §8 question (decision 104).

