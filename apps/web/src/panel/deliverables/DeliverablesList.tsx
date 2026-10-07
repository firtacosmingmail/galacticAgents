import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DELIVERABLE_DESCRIPTION_MAX,
  DELIVERABLE_TITLE_MAX,
  PATH_KINDS,
  type AddDeliverableBody,
  type DeliverableKind,
  type DeliverableListItem,
  type Id,
} from '@galactic/protocol';
import { ErrorLine, useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { focusElement } from '../a11y.js';
import { DeliverableRow, formatBytes } from './DeliverableRow.js';
import {
  groupForProject,
  KIND_LABEL,
  orderTask,
  relativeTo,
  type ClientRules,
} from './deliverables-model.js';
import {
  scopeKey,
  useClientRules,
  useDeliverables,
  useDeliverablesFocus,
  useIdeName,
  type DeliverablesScope,
} from './use-deliverables.js';
import './deliverables.css';

/**
 * The deliverables views (P9-09; SPEC §4.7, decisions 118–134; TECHNOLOGY §9.5):
 *
 * - `ProjectDeliverables` — the Waykeeper dock's third view ("Chat | Status | Deliverables"): the
 *   project's own first (its folder, its run commands, what was declared for it), then its tasks'
 *   grouped by task, newest first, then its sub-projects' (folded, each read when unfolded); the
 *   project's `deliverables/` folder with Reveal in Finder once it exists; Rescan, Add, "Show
 *   removed".
 * - `TaskDeliverables` — the Steward view's section: the task's own.
 * - `HistoryDeliverables` — the history inspector's list (decision 132): removed rows included,
 *   "removed by …".
 *
 * Every row's actions follow the client's rules (`useClientRules`, decisions 131 and 134).
 */

export function ProjectDeliverables({ projectId }: { projectId: Id }) {
  return <DeliverablesBlock scope={{ projectId }} mode="project" />;
}

export function TaskDeliverables({ taskId }: { taskId: Id }) {
  return <DeliverablesBlock scope={{ taskId }} mode="task" />;
}

export function HistoryDeliverables({ target }: { target: { kind: 'project' | 'task'; id: Id } }) {
  return (
    <DeliverablesBlock
      scope={target.kind === 'task' ? { taskId: target.id } : { projectId: target.id }}
      mode="history"
    />
  );
}

type Mode = 'project' | 'task' | 'history' | 'sub';

function DeliverablesBlock({ scope, mode }: { scope: DeliverablesScope; mode: Mode }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const rules = useClientRules();
  const ideName = useIdeName();
  const [showRemoved, setShowRemoved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rescan, setRescan] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const list = useDeliverables(scope, mode === 'history' || showRemoved);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const take = useDeliverablesFocus((s) => s.take);
  const request = useDeliverablesFocus((s) => s.request);
  const key = scopeKey(scope);

  // The navigation's "⋯ Deliverables": bring this view into sight and put the focus on it.
  useEffect(() => {
    if (request === key && take(key)) focusElement(heading.current);
  }, [request, key, take]);

  const project =
    scope.projectId !== undefined
      ? world.projects[scope.projectId]
      : world.projects[world.tasks[scope.taskId]?.projectId ?? ''];
  const task = scope.taskId !== undefined ? world.tasks[scope.taskId] : undefined;
  const places = {
    workspace: project?.workspace ?? (task?.meta?.['workspace'] as string | undefined),
    worktree: task?.worktreePath,
  };
  const subProjects =
    mode === 'project' || mode === 'history'
      ? scope.projectId !== undefined
        ? Object.values(world.projects)
            .filter((p) => p.parentProjectId === scope.projectId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : []
      : [];
  const canEdit = rules.edit && mode !== 'history' && mode !== 'sub';
  const Heading = mode === 'history' ? 'h3' : mode === 'sub' ? 'h4' : 'h2';
  const label =
    mode === 'task'
      ? 'Deliverables of this task'
      : mode === 'project'
        ? `Deliverables of ${project?.name ?? 'the project'}`
        : 'Deliverables';

  const rows = list.status === 'ready' ? list.data.deliverables : [];
  const active = rows.filter((d) => d.removedAt === undefined).length;

  const doRescan = async () => {
    if (scope.projectId === undefined) return;
    setRescan({ busy: true });
    try {
      await api.rescanDeliverables(scope.projectId);
      setRescan({ busy: false });
      list.reload();
    } catch (e) {
      setRescan({ busy: false, error: (e as Error).message });
    }
  };

  if (list.status === 'unavailable') return null;
  return (
    <section
      className={`dlv dlv-${mode}`}
      {...(mode === 'sub'
        ? { 'aria-label': `deliverables of ${project?.name ?? 'the sub-project'}` }
        : { 'aria-labelledby': headingId })}
      data-testid={mode === 'sub' ? undefined : `deliverables-${mode}`}
    >
      {mode !== 'sub' && (
        <div className="dlv-head">
          <Heading
            id={headingId}
            ref={heading}
            tabIndex={-1}
            className={mode === 'history' ? 'his-subtitle' : 'pnl-eyebrow dlv-heading'}
          >
            {label}
            {list.status === 'ready' && <span className="dlv-count"> ({active})</span>}
          </Heading>
          <span className="pnl-spacer" />
          {mode !== 'history' && (
            <label className="pnl-check dlv-check">
              <input
                type="checkbox"
                checked={showRemoved}
                onChange={(e) => setShowRemoved(e.target.checked)}
              />
              Show removed
            </label>
          )}
          <button type="button" className="secondary" onClick={list.reload}>
            Refresh
          </button>
          {mode === 'project' && canEdit && (
            <button
              type="button"
              className="secondary"
              disabled={rescan.busy}
              title="Look for run scripts in the project folder again"
              onClick={() => void doRescan()}
            >
              Rescan
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="secondary"
              aria-expanded={adding}
              onClick={() => setAdding((a) => !a)}
            >
              Add…
            </button>
          )}
        </div>
      )}
      <ErrorLine error={rescan.error} />
      {adding && (
        <AddForm
          scope={scope}
          rules={rules}
          onDone={() => {
            setAdding(false);
            list.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {list.status === 'ready' && list.data.folder && mode !== 'sub' && (
        <FolderLine
          folder={list.data.folder}
          workspace={places.workspace}
          scope={project ? { projectId: project.id } : scope}
          rules={rules}
        />
      )}
      {list.status === 'loading' && <p className="muted dlv-empty">Reading the deliverables…</p>}
      {list.status === 'error' && (
        <p className="error" role="alert">
          Could not read the deliverables: {list.error}{' '}
          <button type="button" className="secondary" onClick={list.reload}>
            Try again
          </button>
        </p>
      )}
      {list.status === 'ready' && (
        <Rows
          rows={rows}
          mode={mode}
          rules={rules}
          ideName={ideName}
          places={places}
          onChanged={list.reload}
        />
      )}
      {subProjects.map((p) => (
        <SubProject key={p.id} projectId={p.id} name={p.name} />
      ))}
    </section>
  );
}

/** A sub-project, folded (decision 124): its own view, read when unfolded. */
function SubProject({ projectId, name }: { projectId: Id; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="dlv-sub" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Sub-project <strong>{name}</strong>
      </summary>
      {open && <DeliverablesBlock scope={{ projectId }} mode="sub" />}
    </details>
  );
}

function Rows({
  rows,
  mode,
  rules,
  ideName,
  places,
  onChanged,
}: {
  rows: DeliverableListItem[];
  mode: Mode;
  rules: ClientRules;
  ideName: string | undefined;
  places: { workspace?: string | undefined; worktree?: string | undefined };
  onChanged: () => void;
}) {
  const world = useAppStore((s) => s.world);
  const row = (d: DeliverableListItem) => (
    <DeliverableRow
      key={d.id}
      row={d}
      rules={rules}
      places={{
        ...places,
        worktree: d.taskId !== undefined ? world.tasks[d.taskId]?.worktreePath : places.worktree,
      }}
      ideName={ideName}
      onChanged={onChanged}
    />
  );
  if (rows.length === 0) {
    return (
      <p className="muted dlv-empty">
        {mode === 'task'
          ? 'No deliverables yet: the Steward declares them, usually when it finishes.'
          : 'No deliverables yet.'}
      </p>
    );
  }
  if (mode === 'task') {
    return <ul className="dlv-list">{orderTask(rows).map(row)}</ul>;
  }
  const groups = groupForProject(rows, world);
  return (
    <>
      {groups.own.length > 0 && (
        <ul className="dlv-list" aria-label="the project's own">
          {groups.own.map(row)}
        </ul>
      )}
      {groups.tasks.map((g) => (
        <div key={g.taskId} className="dlv-group">
          <h3 className="dlv-group-title">
            <span className="muted">Task</span> {g.label}
          </h3>
          <ul className="dlv-list" aria-label={`deliverables of task ${g.label}`}>
            {g.rows.map(row)}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * The project's `deliverables/` folder, once it exists (decision 122): where it is, that it is
 * excluded from git on this Mac, how much it holds, and Reveal in Finder (the Mac only).
 */
function FolderLine({
  folder,
  workspace,
  scope,
  rules,
}: {
  folder: string;
  workspace: string | undefined;
  scope: DeliverablesScope;
  rules: ClientRules;
}) {
  const api = useApi();
  const [bytes, setBytes] = useState<number>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (typeof api.deliverablesUsage !== 'function') return;
    let live = true;
    api.deliverablesUsage().then(
      (u) => {
        const hit = u.folders.find((f) => f.path === folder);
        if (live && hit) setBytes(hit.bytes);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, folder]);
  const rel = relativeTo(folder, workspace);
  const reveal = async () => {
    setError(undefined);
    try {
      await api.revealDeliverablesFolder(
        scope.taskId !== undefined ? { taskId: scope.taskId } : { projectId: scope.projectId },
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="dlv-folder">
      <p>
        Deliverables folder <code>{rel ?? folder}</code>
        {bytes !== undefined && <span className="muted"> · {formatBytes(bytes)}</span>}
        <span className="muted"> · excluded from git on this Mac</span>
      </p>
      {rules.local ? (
        <button type="button" className="secondary" onClick={() => void reveal()}>
          Reveal in Finder
        </button>
      ) : (
        <span className="dlv-mac-only muted">Reveal in Finder: on the Mac</span>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

const ADD_KINDS: DeliverableKind[] = ['file', 'image', 'folder', 'app', 'command', 'url'];

/**
 * Add by hand (decisions 119, 121, 131): a file, image, folder or application by its path on the
 * Mac (one outside the project's folder is copied into its `deliverables/` folder — the Mac's own
 * page only), a command and the folder it runs in, or a web address.
 */
function AddForm({
  scope,
  rules,
  onDone,
  onCancel,
}: {
  scope: DeliverablesScope;
  rules: ClientRules;
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const id = useId();
  const [kind, setKind] = useState<DeliverableKind>('file');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [line, setLine] = useState('');
  const [cwd, setCwd] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pathKind = PATH_KINDS.has(kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const body: AddDeliverableBody = {
      ...(scope.taskId !== undefined ? { taskId: scope.taskId } : { projectId: scope.projectId }),
      kind,
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(pathKind ? { path: path.trim() } : {}),
      ...(kind === 'command'
        ? { command: { line: line.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) } }
        : {}),
      ...(kind === 'url' ? { url: url.trim() } : {}),
    };
    try {
      await api.addDeliverable(body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (name: string, input: ReactNode, hint?: ReactNode) => (
    <>
      <label htmlFor={`${id}-${name}`}>{FIELD_LABEL[name]}</label>
      {input}
      {hint && <p className="dlv-hint muted">{hint}</p>}
    </>
  );

  return (
    <form
      className="dlv-form dlv-add"
      aria-label="add a deliverable"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {field(
        'kind',
        <select
          id={`${id}-kind`}
          value={kind}
          autoFocus
          onChange={(e) => setKind(e.target.value as DeliverableKind)}
        >
          {ADD_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>,
      )}
      {field(
        'title',
        <input
          id={`${id}-title`}
          value={title}
          required
          maxLength={DELIVERABLE_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
        />,
      )}
      {pathKind &&
        field(
          'path',
          <input
            id={`${id}-path`}
            className="dlv-mono"
            value={path}
            required
            spellCheck={false}
            placeholder="/Users/…/my-app/dist/report.html"
            onChange={(e) => setPath(e.target.value)}
          />,
          rules.addOutside
            ? 'The full path on the Mac. A path outside the project’s folder is copied into its deliverables/ folder.'
            : 'The full path on the Mac, inside the project’s folder. A path from elsewhere on the Mac can be added on the Mac only.',
        )}
      {kind === 'command' &&
        field(
          'line',
          <input
            id={`${id}-line`}
            className="dlv-mono"
            value={line}
            required
            spellCheck={false}
            placeholder="pnpm dev"
            onChange={(e) => setLine(e.target.value)}
          />,
        )}
      {kind === 'command' &&
        field(
          'cwd',
          <input
            id={`${id}-cwd`}
            className="dlv-mono"
            value={cwd}
            spellCheck={false}
            placeholder="the project folder"
            onChange={(e) => setCwd(e.target.value)}
          />,
          'Leave empty to run it in the project folder.',
        )}
      {kind === 'url' &&
        field(
          'url',
          <input
            id={`${id}-url`}
            type="url"
            value={url}
            required
            placeholder="http://localhost:5173"
            onChange={(e) => setUrl(e.target.value)}
          />,
        )}
      {field(
        'description',
        <textarea
          id={`${id}-description`}
          value={description}
          rows={2}
          maxLength={DELIVERABLE_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
        />,
      )}
      <p className="dlv-hint muted">
        What you add can be viewed and downloaded from your other devices too.
      </p>
      <div className="dlv-form-buttons">
        <button type="submit" disabled={busy || title.trim() === ''}>
          Add
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

const FIELD_LABEL: Record<string, string> = {
  kind: 'Kind',
  title: 'Title',
  path: 'Path',
  line: 'Command',
  cwd: 'Folder',
  url: 'Address',
  description: 'Description (optional)',
};
