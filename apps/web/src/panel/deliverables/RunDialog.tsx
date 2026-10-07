import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { Deliverable, DeliverableRun, RunPreviewResponse } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { actorLabel, useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import {
  addedByLine,
  blockingRefusal,
  bodyLines,
  initialFocus,
  previewRefusalText,
  refusalText,
  warningsOf,
} from './runs-model.js';

/** How long the dialog waits after the last keystroke before it reads an edited line again. */
export const REPREVIEW_MS = 400;

/** The edited line's own preview, for exactly `line` (or why it cannot run). */
type Edited =
  | { line: string; status: 'reading' }
  | { line: string; status: 'ready'; preview: RunPreviewResponse }
  | { line: string; status: 'invalid'; error: string };

const tabStops = (root: HTMLElement): HTMLElement[] =>
  [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.closest('[hidden]'));

/**
 * The Run confirmation (SPEC decision 129; TECHNOLOGY §9.8): the exact command (editable for this
 * run, one line), the folder it runs in, the environment's keys, who added it, the permission
 * engine's warnings and — for a detected command — what it runs as its file says now, with the
 * lines "changed since the last run" marked. Run sends the version and the preview's
 * `confirmation` for exactly the line shown; an edited line is read again (debounced) and Run
 * waits for its own warnings and token. A stale version, an expired token or any other refusal
 * says why; a stale one shows the new command and asks again. `mode: 'restart'` is the same
 * confirmation for Restart (Stop, then Run).
 *
 * A modal dialog: the focus stays inside it (Tab cycles), Escape cancels, and the focus returns
 * to the button that opened it. The focus starts on Cancel when there are warnings or the body
 * changed, else on Run (`initialFocus`). Enter in the command field re-reads it; it never runs.
 */
export function RunDialog({
  row,
  mode,
  runId,
  opener,
  onClose,
  onStarted,
}: {
  row: Deliverable;
  mode: 'run' | 'restart';
  /** The run a restart replaces. */
  runId?: string | undefined;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  onStarted: (run: DeliverableRun) => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const titleId = useId();
  const fieldId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [base, setBase] = useState<RunPreviewResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [field, setField] = useState('');
  const [edited, setEdited] = useState<Edited>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const focused = useRef(false);

  /** Reads the stored command's preview (on open, and again after a stale or expired refusal). */
  const readBase = useCallback(
    (why?: string): Promise<RunPreviewResponse | undefined> =>
      api.runPreview(row.id).then(
        (preview) => {
          setBase(preview);
          setField(preview.line);
          setEdited(undefined);
          setLoadError(undefined);
          if (why) setNotice(why);
          return preview;
        },
        (e: unknown) => {
          setLoadError(refusalText(e));
          return undefined;
        },
      ),
    [api, row.id],
  );

  useEffect(() => {
    void readBase();
  }, [readBase]);

  // The row changed under the open dialog (its version moved on the stream): read it again.
  const behind = base !== undefined && row.version > base.version;
  useEffect(() => {
    if (behind) {
      void readBase(
        'The command changed since the dialog opened: it now shows the new one. Read it again.',
      );
    }
  }, [behind, readBase]);

  // The focus: on Cancel when the line warns or the body changed, else on Run (decided in P9-10).
  useEffect(() => {
    if (focused.current) return;
    if (!base) {
      heading.current?.focus();
      return;
    }
    focused.current = true;
    const to = initialFocus(base) === 'cancel' ? cancelButton.current : runButton.current;
    (to && !(to as HTMLButtonElement).disabled ? to : cancelButton.current)?.focus();
  }, [base]);

  // Back to the opener when the dialog goes.
  useEffect(() => {
    const from = opener.current;
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      if (from?.isConnected) from.focus();
    };
  }, [opener]);

  const line = field.trim();
  const isEdited = base !== undefined && line !== base.line.trim();

  // An edited line is read again after a pause in the typing: its warnings, its token.
  useEffect(() => {
    if (!base || !isEdited || line === '') return;
    let live = true;
    const timer = setTimeout(() => {
      setEdited({ line, status: 'reading' });
      api.runPreview(row.id, line).then(
        (preview) => live && setEdited({ line, status: 'ready', preview }),
        (e: unknown) => live && setEdited({ line, status: 'invalid', error: refusalText(e) }),
      );
    }, REPREVIEW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, row.id, base, isEdited, line]);

  /** The preview that covers what the field shows now (none while an edit is being read). */
  const current: RunPreviewResponse | undefined = !base
    ? undefined
    : !isEdited
      ? base
      : edited?.line === line && edited.status === 'ready'
        ? edited.preview
        : undefined;
  const reading =
    isEdited && line !== '' && !(edited?.line === line && edited.status !== 'reading');
  const editError =
    isEdited && line === ''
      ? 'Type a command, or cancel.'
      : edited?.line === line && edited.status === 'invalid'
        ? edited.error
        : undefined;
  const refusal = current ? blockingRefusal(current, mode) : undefined;
  const canRun =
    current?.confirmation !== undefined && !refusal && !reading && !editError && !sending;

  const send = async () => {
    if (!current?.confirmation || !canRun) return;
    setSending(true);
    setError(undefined);
    setNotice(undefined);
    const body = {
      version: current.version,
      confirmation: current.confirmation,
      ...(isEdited ? { line } : {}),
    };
    try {
      const { run } =
        mode === 'restart' && runId
          ? await api.restartRun(runId, body)
          : await api.startRun(row.id, body);
      onStarted(run);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'stale' || code === 'unconfirmed') {
        // The dialog shows what would run now and asks again (decision 129).
        await readBase(refusalText(e));
        cancelButton.current?.focus();
      } else {
        setError(refusalText(e));
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const stops = tabStops(dialog.current);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (
      e.shiftKey &&
      (document.activeElement === first || !dialog.current.contains(document.activeElement))
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const shown = current ?? base;
  const warnings = shown ? warningsOf(shown) : [];
  const who = shown ? actorLabel(shown.addedBy, world) : '';
  const verb = mode === 'restart' ? 'Restart' : 'Run';

  return (
    <div className="run-scrim">
      <div
        ref={dialog}
        className="run-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} ref={heading} tabIndex={-1} className="run-dialog-title">
          {verb} {row.title}?
        </h2>
        {mode === 'restart' && (
          <p className="muted">
            Restart stops the run and everything it started, then runs the command again — if it can
            start again; otherwise nothing is stopped.
          </p>
        )}
        {!base && !loadError && <p className="muted">Reading the command…</p>}
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {notice && (
          <p className="run-notice" role="alert">
            {notice}
          </p>
        )}
        {base && (
          <>
            <label className="run-label" htmlFor={fieldId}>
              The exact command
            </label>
            <input
              id={fieldId}
              className="run-line dlv-mono"
              value={field}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-describedby={`${fieldId}-hint`}
              onChange={(e) => setField(e.target.value.replace(/[\r\n]+/g, ' '))}
              onKeyDown={(e) => {
                // Enter never runs: Run is a click (or Space/Enter on the button) on purpose.
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
            <p id={`${fieldId}-hint`} className="dlv-hint muted">
              {isEdited
                ? 'Edited for this run only: the stored command stays as it is.'
                : 'You may edit it for this run (one line). A hidden secret has to be typed again.'}
              {reading && ' Reading the edited command…'}
            </p>
            {editError && (
              <p className="error" role="alert">
                {editError}
              </p>
            )}
            <dl className="run-facts">
              <dt>Runs in</dt>
              <dd>
                <code>{shown!.cwd}</code>
              </dd>
              <dt>Added</dt>
              <dd>{addedByLine(shown!, who)}</dd>
              <dt>Environment</dt>
              <dd>
                {shown!.envKeys.length === 0 ? (
                  'none'
                ) : (
                  <span className="run-env">
                    {shown!.envKeys.map((k) => (
                      <code key={k}>{k}</code>
                    ))}
                  </span>
                )}
                <span className="muted"> (the keys only: the values are never shown)</span>
              </dd>
            </dl>
            {warnings.length > 0 ? (
              <div className="run-warnings" role="group" aria-label="warnings">
                <p className="run-warnings-head">The permission engine reads in this command:</p>
                <ul>
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                {shown!.reasons && shown!.reasons.length > 0 && (
                  <details>
                    <summary>Why</summary>
                    <ul className="muted">
                      {shown!.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <p className="muted run-no-warnings">No warnings read in this command.</p>
            )}
            {shown!.body !== undefined && (
              <div className="run-body">
                <p className="run-body-head">
                  What it runs, as {shown!.detectedFrom ?? 'its file'} says now
                  {shown!.bodyChanged && (
                    <strong className="run-changed"> · changed since the last run</strong>
                  )}
                </p>
                <pre
                  className="run-body-text"
                  tabIndex={0}
                  role="region"
                  aria-label="the script's body"
                >
                  {bodyLines(shown!.body, shown!.bodyChanged ? shown!.lastRunBody : undefined).map(
                    (l, i) =>
                      l.changed ? (
                        <mark key={i} className="run-body-changed">
                          {l.text}
                          {'\n'}
                        </mark>
                      ) : (
                        <span key={i}>
                          {l.text}
                          {'\n'}
                        </span>
                      ),
                  )}
                </pre>
                {shown!.bodyChanged && shown!.lastRunBody !== undefined && (
                  <details>
                    <summary>What the last run ran</summary>
                    <pre className="run-body-text">{shown!.lastRunBody}</pre>
                  </details>
                )}
              </div>
            )}
            {refusal && (
              <p className="error" role="alert">
                {previewRefusalText(refusal)}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="run-buttons">
          <button
            type="button"
            ref={runButton}
            className={warnings.length > 0 ? 'danger' : undefined}
            disabled={!canRun}
            onClick={() => void send()}
          >
            {sending ? (mode === 'restart' ? 'Restarting…' : 'Starting…') : verb}
          </button>
          <button type="button" ref={cancelButton} className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
