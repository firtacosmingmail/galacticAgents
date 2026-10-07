import { lazy, Suspense, useRef, useState, type FormEvent, type ReactNode } from 'react';

import {
  DELIVERABLE_DESCRIPTION_MAX,
  DELIVERABLE_TITLE_MAX,
  type Deliverable,
  type DeliverableListItem,
  type EditDeliverableBody,
  type OpenAction,
} from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { actorLabel, ErrorLine, useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { ConfirmBox } from '../controls.js';
import {
  addedByText,
  KIND_LABEL,
  rowActions,
  runStateText,
  safeLink,
  skippedOf,
  skippedText,
  whereText,
  type ClientRules,
  type DeliverableAction,
  type Places,
} from './deliverables-model.js';

/** The viewer and its libraries load on the first "View" (TECHNOLOGY §9.5). */
const DeliverableViewer = lazy(() => import('./DeliverableViewer.js'));

/** Starts a browser download of a one-time link (`/files/<ticket>`, no token in it). */
export function startDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const ACTION_LABEL: Partial<Record<DeliverableAction, string>> = {
  open: 'Open',
  reveal: 'Reveal in Finder',
  ide: 'Open in IDE',
  app: 'Open',
};

/** What an application's open asks first (decision 128). */
interface AppConfirm {
  fingerprint: string;
  name: string;
  who: string;
  changed: boolean;
}

/**
 * One deliverable (SPEC §4.7): its kind, title, who added it, where it is ("in the deliverables
 * folder", "missing — …"), what a copy left out, a command's line, folder and state, and its
 * actions on this client — the Mac's opening actions shown as "on the Mac" elsewhere (decision
 * 131). A removed row (history, "Show removed") says who removed it and offers Restore only.
 */
export function DeliverableRow({
  row,
  rules,
  places,
  ideName,
  onChanged,
}: {
  row: DeliverableListItem;
  rules: ClientRules;
  places: Places;
  ideName: string | undefined;
  /** A write went through: read the list again. */
  onChanged: () => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [viewing, setViewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmApp, setConfirmApp] = useState<AppConfirm>();
  const viewButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const appButton = useRef<HTMLButtonElement>(null);

  const { actions, macOnly } = rowActions(row, rules);
  const where = whereText(row, places);
  const skipped = skippedOf(row.meta);
  const removed = row.removedAt !== undefined;
  const has = (a: DeliverableAction) => actions.includes(a);

  const act = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await what();
      if (done) setNote(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const open = (action: OpenAction, fingerprint?: string) =>
    act(async () => {
      try {
        await api.openDeliverable(row.id, { action, ...(fingerprint ? { fingerprint } : {}) });
        onChanged();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'confirm' && action === 'app') {
          const body = e.body ?? {};
          setConfirmApp({
            fingerprint: String(body['fingerprint'] ?? ''),
            name: String(body['name'] ?? row.title),
            who: row.source === 'detected' ? 'detected' : actorLabel(row.addedBy, world),
            changed: row.meta?.['confirmedOpen'] !== undefined,
          });
          return;
        }
        throw e;
      }
    });

  const download = () =>
    act(async () => {
      const { url } = await api.downloadDeliverable(row.id);
      startDownload(url);
    }, 'Download started.');

  const openButtons = (inViewer: boolean): ReactNode => (
    <>
      {has('open') && (
        <button type="button" disabled={busy} onClick={() => void open('open')}>
          Open
        </button>
      )}
      {has('download') && (
        <button
          type="button"
          className={inViewer ? 'secondary' : undefined}
          disabled={busy}
          onClick={() => void download()}
        >
          Download
        </button>
      )}
    </>
  );

  const name = row.title;
  return (
    <li
      className={`dlv-row${removed ? ' is-removed' : ''}${where.missing ? ' is-missing' : ''}`}
      aria-label={`${KIND_LABEL[row.kind]} ${name}`}
      data-deliverable={row.id}
    >
      <div className="dlv-row-head">
        <span className={`dlv-kind kind-${row.kind}`}>{KIND_LABEL[row.kind]}</span>
        {/* Agent text is shown as plain text (decision 120). */}
        <span className="dlv-title">{name}</span>
        <span className="dlv-by muted">added by {addedByText(row, world)}</span>
      </div>
      {row.description && <p className="dlv-desc">{row.description}</p>}
      {row.kind === 'command' && row.command ? (
        <>
          <p className="dlv-line">
            <code className="dlv-cmd">{row.command.line}</code>
          </p>
          <p className="dlv-where muted">
            {where.text} {where.path !== undefined && <code>{where.path}</code>}
            {row.command.detectedFrom && <> · from {row.command.detectedFrom}</>} ·{' '}
            <span className="dlv-run">{runStateText(row.lastRun)}</span>
          </p>
        </>
      ) : row.kind === 'url' ? (
        <p className="dlv-where">
          <code className="dlv-url">{row.url}</code>
        </p>
      ) : (
        <p className="dlv-where muted">
          {where.text} {where.path !== undefined && where.path !== '' && <code>{where.path}</code>}
          {row.facts?.size !== undefined && !row.facts.isDirectory && (
            <> · {formatBytes(row.facts.size)}</>
          )}
        </p>
      )}
      {where.missing && !removed && (
        <p className="dlv-missing">
          <strong>missing</strong> — {where.missing}
        </p>
      )}
      {skipped && (
        <details className="dlv-skipped">
          <summary>{skippedText(skipped)}</summary>
          <ul>
            {skipped.entries.map((e) => (
              <li key={e.path}>
                <code>{e.path}</code> — {e.reason.replace(/_/g, ' ')}
              </li>
            ))}
            {skipped.count > skipped.entries.length && (
              <li className="muted">and {skipped.count - skipped.entries.length} more</li>
            )}
          </ul>
        </details>
      )}
      {removed && (
        <p className="dlv-removed muted">
          removed by {actorLabel(row.removedBy, world)}
          {row.removedReason && <>: {row.removedReason}</>}
        </p>
      )}

      {(actions.length > 0 || macOnly.length > 0) && (
        <div className="dlv-actions" role="group" aria-label={`actions for ${name}`}>
          {has('view') && (
            <button
              type="button"
              ref={viewButton}
              aria-expanded={viewing}
              onClick={() => setViewing((v) => !v)}
            >
              {viewing ? 'Close preview' : 'View'}
            </button>
          )}
          {!viewing && openButtons(false)}
          {has('app') && (
            <button type="button" ref={appButton} disabled={busy} onClick={() => void open('app')}>
              Open
            </button>
          )}
          {has('ide') && (
            <button type="button" disabled={busy} onClick={() => void open('ide')}>
              Open in {ideName ?? 'IDE'}
            </button>
          )}
          {has('reveal') && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void open('reveal')}
            >
              Reveal in Finder
            </button>
          )}
          {has('link') && safeLink(row.url) && (
            <a
              className="dlv-link"
              href={safeLink(row.url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open address
            </a>
          )}
          {has('edit') && (
            <button
              type="button"
              className="secondary"
              aria-expanded={editing}
              onClick={() => setEditing((e) => !e)}
            >
              Edit
            </button>
          )}
          {has('remove') && (
            <button
              type="button"
              className="secondary"
              ref={removeButton}
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              Remove
            </button>
          )}
          {has('restore') && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.restoreDeliverable(row.id);
                  onChanged();
                })
              }
            >
              Restore
            </button>
          )}
          {macOnly.length > 0 && (
            <span className="dlv-mac-only muted">
              {[
                ...new Set(
                  macOnly.map((a) =>
                    a === 'ide' ? `Open in ${ideName ?? 'IDE'}` : ACTION_LABEL[a],
                  ),
                ),
              ].join(', ')}
              : on the Mac
            </span>
          )}
        </div>
      )}

      {confirmApp && (
        <ConfirmBox
          question={`Open ${confirmApp.name}? Added by ${confirmApp.who}; ${
            confirmApp.changed
              ? 'it changed since it was last opened'
              : 'it has not been opened before'
          }. Opening it runs its code on the Mac.`}
          yes={`Open ${confirmApp.name}`}
          busy={busy}
          opener={appButton}
          onConfirm={() => {
            const fp = confirmApp.fingerprint;
            setConfirmApp(undefined);
            void open('app', fp);
          }}
          onKeep={() => setConfirmApp(undefined)}
        />
      )}
      {removing && (
        <ConfirmBox
          question={`Remove ${name} from the list? Nothing is deleted: the files stay where they are.`}
          yes="Remove"
          busy={busy}
          opener={removeButton}
          onConfirm={() => {
            setRemoving(false);
            void act(async () => {
              await api.removeDeliverable(row.id);
              onChanged();
            });
          }}
          onKeep={() => setRemoving(false)}
        />
      )}
      {editing && (
        <EditForm
          row={row}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {note && (
        <p className="dlv-note muted" role="status">
          {note}
        </p>
      )}
      <ErrorLine error={error} />
      {viewing && (
        <Suspense fallback={<p className="muted">Loading the viewer…</p>}>
          <DeliverableViewer
            row={row}
            actions={openButtons(true)}
            onClose={() => {
              setViewing(false);
              viewButton.current?.focus();
            }}
          />
        </Suspense>
      )}
    </li>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Edit by hand (decision 131 rule): title, description, and a command's line or an address,
 * against the version the panel showed. A stale edit (someone changed it meanwhile) shows the
 * current version in the form, says so, and is sent again only by the user.
 */
function EditForm({
  row,
  onDone,
  onCancel,
}: {
  row: Deliverable;
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [base, setBase] = useState<Deliverable>(row);
  const [title, setTitle] = useState(row.title);
  const [description, setDescription] = useState(row.description ?? '');
  const [line, setLine] = useState(row.command?.line ?? '');
  const [url, setUrl] = useState(row.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const id = `dlv-edit-${row.id}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const body: EditDeliverableBody = { version: base.version };
    if (title.trim() !== base.title) body.title = title.trim();
    const desc = description.trim();
    if (desc !== (base.description ?? '')) body.description = desc === '' ? null : desc;
    if (base.command && line.trim() !== base.command.line) body.command = { line: line.trim() };
    if (base.kind === 'url' && url.trim() !== (base.url ?? '')) body.url = url.trim();
    try {
      await api.editDeliverable(base.id, body);
      onDone();
    } catch (err) {
      const current = err instanceof ApiError ? err.body?.['deliverable'] : undefined;
      if (err instanceof ApiError && err.code === 'stale' && current) {
        const now = current as Deliverable;
        setBase(now);
        setTitle(now.title);
        setDescription(now.description ?? '');
        setLine(now.command?.line ?? '');
        setUrl(now.url ?? '');
        setStale(true);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="dlv-form"
      aria-label={`edit ${row.title}`}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {stale && (
        <p className="dlv-stale" role="alert">
          It was changed meanwhile: the form now shows the current version. Check it and save again.
        </p>
      )}
      <label htmlFor={`${id}-title`}>Title</label>
      <input
        id={`${id}-title`}
        value={title}
        maxLength={DELIVERABLE_TITLE_MAX}
        required
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor={`${id}-desc`}>Description</label>
      <textarea
        id={`${id}-desc`}
        value={description}
        maxLength={DELIVERABLE_DESCRIPTION_MAX}
        rows={2}
        onChange={(e) => setDescription(e.target.value)}
      />
      {base.command && (
        <>
          <label htmlFor={`${id}-line`}>Command</label>
          <input
            id={`${id}-line`}
            className="dlv-mono"
            value={line}
            required
            spellCheck={false}
            onChange={(e) => setLine(e.target.value)}
          />
        </>
      )}
      {base.kind === 'url' && (
        <>
          <label htmlFor={`${id}-url`}>Address</label>
          <input
            id={`${id}-url`}
            type="url"
            value={url}
            required
            onChange={(e) => setUrl(e.target.value)}
          />
        </>
      )}
      <div className="dlv-form-buttons">
        <button type="submit" disabled={busy || title.trim() === ''}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
