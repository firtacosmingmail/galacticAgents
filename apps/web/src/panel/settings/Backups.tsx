import { useCallback, useEffect, useState } from 'react';
import { BackupsResponse, type BackupNowResponse } from '@galactic/protocol';

/**
 * Backups and the map export in the settings (P8-03; docs/BACKUP_RESTORE.md): the backup files
 * newest first, the rotation, the last attempt, "Back up now" and "Export the map" (a JSON
 * download; transcripts on request). On the Mac only (decision 90): a remote client gets 403
 * `remote_control` and the section says to use the Mac. Restoring is done from the command line
 * with Mission Control stopped, so it is described here, not offered.
 */

export interface BackupsApi {
  list(): Promise<BackupsResponse>;
  backupNow(): Promise<BackupNowResponse>;
  /** The export as a file (a Blob) and its suggested name. */
  exportMap(transcripts: boolean): Promise<{ blob: Blob; name: string }>;
}

export class BackupsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function createBackupsApi(
  token: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): BackupsApi {
  const call = async (method: 'GET' | 'POST', path: string): Promise<Response> => {
    const res = await fetchImpl(path, { method, headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // not JSON: the status says enough
      }
      throw new BackupsApiError(
        res.status,
        (body['message'] as string | undefined) ??
          (body['error'] as string | undefined) ??
          `${res.status}`,
        body['error'] as string | undefined,
      );
    }
    return res;
  };
  return {
    list: async () => (await (await call('GET', '/api/backups')).json()) as BackupsResponse,
    backupNow: async () => (await (await call('POST', '/api/backups')).json()) as BackupNowResponse,
    exportMap: async (transcripts) => {
      const res = await call('GET', `/api/export${transcripts ? '?transcripts=1' : ''}`);
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'galactic-map.json';
      return { blob: await res.blob(), name };
    },
  };
}

const sizeOf = (bytes: number) =>
  bytes >= 2 ** 20
    ? `${(bytes / 2 ** 20).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const KIND_LABELS: Record<string, string> = {
  auto: 'daily',
  manual: 'manual',
  'pre-import': 'before an import',
};

/** Hands a Blob to the browser as a download. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type State =
  | { kind: 'loading' }
  | { kind: 'remote' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: BackupsResponse };

export function Backups({
  token,
  api: injected,
  onDownload = download,
}: {
  token: string;
  api?: BackupsApi;
  onDownload?: (blob: Blob, name: string) => void;
}) {
  const [api] = useState<BackupsApi>(() => injected ?? createBackupsApi(token));
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<'backup' | 'export' | undefined>();
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [transcripts, setTranscripts] = useState(false);

  const load = useCallback(
    (cancelled: () => boolean = () => false) =>
      api.list().then(
        (data) => {
          if (cancelled()) return;
          // An older or a stand-in server answers something else: no backups here.
          const parsed = BackupsResponse.safeParse(data);
          setState(parsed.success ? { kind: 'ready', data: parsed.data } : { kind: 'unavailable' });
        },
        (error: unknown) => {
          if (cancelled()) return;
          if (error instanceof BackupsApiError && error.code === 'remote_control') {
            setState({ kind: 'remote' });
          } else if (error instanceof BackupsApiError && error.status === 404) {
            setState({ kind: 'unavailable' });
          } else setState({ kind: 'error', message: (error as Error).message });
        },
      ),
    [api],
  );

  useEffect(() => {
    let stop = false;
    void load(() => stop);
    return () => {
      stop = true;
    };
  }, [load]);

  const backUp = async () => {
    setBusy('backup');
    setNotice(undefined);
    setFailure(undefined);
    try {
      const outcome = await api.backupNow();
      if (outcome.outcome === 'ok') setNotice(`Backed up (${sizeOf(outcome.bytes ?? 0)}).`);
      else setFailure(`Not backed up: ${outcome.detail ?? outcome.outcome}.`);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const exportNow = async () => {
    setBusy('export');
    setNotice(undefined);
    setFailure(undefined);
    try {
      const { blob, name } = await api.exportMap(transcripts);
      onDownload(blob, name);
      setNotice(`Exported ${name}.`);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="set-section" aria-label="Backups">
      <div className="set-head">
        <h2 className="set-title">Backups</h2>
      </div>
      <p className="set-intro">
        Mission Control copies its database once a day and keeps the recent copies. To restore one,
        stop Mission Control and run <code>galactic restore &lt;name&gt;</code>; an export goes back
        with <code>galactic import &lt;file&gt;</code> (see <code>docs/BACKUP_RESTORE.md</code>).
      </p>
      {state.kind === 'loading' && <p className="set-muted">Loading the backups…</p>}
      {state.kind === 'remote' && (
        <p className="set-note" role="note">
          Backups and exports are managed on the Mac itself.
        </p>
      )}
      {state.kind === 'unavailable' && (
        <p className="set-note" role="note">
          This Mission Control has no backups endpoint; update it to manage backups here.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="set-error" role="alert">
          Could not read the backups: {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
        <>
          <p className="set-muted">
            {state.data.schedule.enabled
              ? `Daily backup on; keeps ${state.data.schedule.keepDaily} daily, ` +
                `${state.data.schedule.keepWeekly} weekly and ${state.data.schedule.keepManual} manual copies`
              : 'Daily backup off (config.json); "Back up now" still works'}{' '}
            in <code>{state.data.directory}</code>.
          </p>
          {state.data.last && state.data.last.outcome !== 'ok' && (
            <p className="set-error" role="alert">
              The last backup ({new Date(state.data.last.at).toLocaleString()}){' '}
              {state.data.last.outcome === 'skipped' ? 'was skipped' : 'failed'}:{' '}
              {state.data.last.detail}
            </p>
          )}
          {state.data.backups.length === 0 ? (
            <p className="set-muted">No backups yet.</p>
          ) : (
            <ul className="set-backups" aria-label="backup files">
              {state.data.backups.map((b) => (
                <li key={b.name}>
                  <span>{new Date(b.createdAt).toLocaleString()}</span>{' '}
                  <span className="set-muted">
                    {KIND_LABELS[b.kind] ?? b.kind} · {sizeOf(b.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="set-actions">
            <button
              type="button"
              className="set-secondary"
              disabled={busy !== undefined || state.data.running}
              onClick={() => void backUp()}
            >
              {busy === 'backup' || state.data.running ? 'Backing up…' : 'Back up now'}
            </button>
            <button
              type="button"
              className="set-secondary"
              disabled={busy !== undefined}
              onClick={() => void exportNow()}
            >
              {busy === 'export' ? 'Exporting…' : 'Export the map'}
            </button>
            <label className="set-check">
              <input
                type="checkbox"
                checked={transcripts}
                onChange={(e) => setTranscripts(e.target.checked)}
              />{' '}
              with transcripts
            </label>
          </div>
        </>
      )}
      {notice && (
        <p className="set-muted" role="status">
          {notice}
        </p>
      )}
      {failure && (
        <p className="set-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
