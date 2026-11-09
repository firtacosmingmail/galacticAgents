import { useEffect, useId, useRef, useState } from 'react';
import type {
  Id,
  Project,
  Question,
  SimilarOption,
  SimilarPreviewResponse,
} from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import type { WorldState } from '../../state/reduce.js';
import { useClientRules } from '../deliverables/use-deliverables.js';

/**
 * "Allow similar" on a permission card (P9-17, SPEC decision 138): next to "Allow once", for a
 * request whose agent belongs to a project (a Waykeeper, or a Steward of one of its tasks), a
 * button opens a small chooser (`POST …/similar-preview`): the call that asked with the parts
 * that triggered the question marked, then one tickable row per reason (P14) — a folder, a site,
 * a command prefix, a category — each with the server's preview of exactly what it will cover and
 * a widen choice on a folder; "Allow and remember ticked" answers the request "allow" and stores
 * one rule per ticked row on the project in one command. Never for a push, never for the Harmonizer's or an
 * asteroid's requests (no project), never for a publishing run's (P11-12: it takes no rules), and only on a client that may write settings: the Mac's own
 * page, or any client when the server sets `autoApproveRemote` (decisions 37, 90). The menu bar
 * keeps Allow once and Deny only (decision 136).
 */

/** The project a request's rule would go to, or `undefined` (no project: none is offered). */
export function similarProject(
  q: Question,
  world: Pick<WorldState, 'agents' | 'tasks' | 'projects'>,
): Project | undefined {
  if (q.kind !== 'permission' || q.status !== 'open') return undefined;
  // A push always asks (decision 49); a request without a tool call has nothing to match.
  if (q.context.permissionAction === 'push' || !q.context.toolCall) return undefined;
  // A publishing run works without rules (P11-12, ruling R26): a rule would only mislead.
  if (q.context.origin?.publishingRun) return undefined;
  const agent = world.agents[q.originAgentId];
  const taskId = agent?.taskId ?? q.context.origin?.taskId;
  const projectId =
    agent?.projectId ??
    (taskId ? world.tasks[taskId]?.projectId : undefined) ??
    (agent ? undefined : q.context.origin?.projectId);
  const project = projectId ? world.projects[projectId] : undefined;
  if (!project || project.state === 'completed' || project.state === 'archived') return undefined;
  return project;
}

/** Whether this card offers "Allow similar" at all (the client may write, the server can preview). */
export function useOffersSimilar(q: Question, world: WorldState): Project | undefined {
  const api = useApi();
  const rules = useClientRules();
  const project = similarProject(q, world);
  if (!project || !rules.edit || typeof api.similarPreview !== 'function') return undefined;
  return project;
}

const KIND_WORDS: Record<SimilarOption['kind'], string> = {
  folder: 'Access to',
  site: 'Site',
  prefix: 'Command prefix',
  category: 'Whole category',
};

type Preview =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: SimilarPreviewResponse };

/** One choice of a row: the row's own (narrowest), then each wider one. */
interface Level {
  label?: string | undefined;
  preview?: string | undefined;
  digest?: string | undefined;
}

function levelsOf(o: SimilarOption): Level[] {
  return [{ label: o.label, preview: o.preview, digest: o.digest }, ...(o.widen ?? [])];
}

/** `call` split into plain and marked pieces; every occurrence of every part is marked. */
export function markedParts(
  call: string,
  parts: { text: string; refused: boolean }[],
): { text: string; marked: boolean; refused: boolean }[] {
  const flags: (boolean | undefined)[] = new Array(call.length).fill(undefined);
  for (const { text, refused } of parts) {
    if (!text) continue;
    for (let at = call.indexOf(text); at >= 0; at = call.indexOf(text, at + 1)) {
      for (let i = at; i < at + text.length; i++) flags[i] = (flags[i] ?? true) && refused;
    }
  }
  const out: { text: string; marked: boolean; refused: boolean }[] = [];
  for (let i = 0; i < call.length; i++) {
    const marked = flags[i] !== undefined;
    const refused = flags[i] === true;
    const last = out[out.length - 1];
    if (last && last.marked === marked && last.refused === refused) last.text += call[i];
    else out.push({ text: call[i]!, marked, refused });
  }
  return out;
}

function CallText({ data }: { data: SimilarPreviewResponse }) {
  const pieces = markedParts(data.call, [
    ...data.asking.map((text) => ({ text, refused: false })),
    ...data.notRememberable.map((n) => ({ text: n.part, refused: true })),
  ]);
  return (
    <pre className="allow-similar-call">
      {pieces.map((p, i) =>
        p.marked ? (
          <mark key={i} className={p.refused ? 'is-off' : undefined}>
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </pre>
  );
}

export function AllowSimilar({
  question: q,
  project,
  busy: outerBusy,
  onStale,
}: {
  question: Question;
  project: Project;
  busy: boolean;
  onStale: (questionId: Id, message: string) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [level, setLevel] = useState<Record<string, number>>({});
  const { run, error, busy, clear } = useAction();
  const chooserId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.similarPreview(q.id).then(
      (data) => {
        if (!live) return;
        setTicked({});
        setLevel({});
        setPreview({ status: 'ready', data });
      },
      (e: unknown) => live && setPreview({ status: 'error', error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [api, open, q.id, q.version]);

  useEffect(() => {
    if (open && preview.status === 'ready') {
      box.current?.querySelector<HTMLElement>('input:not([disabled]), button')?.focus();
    }
  }, [open, preview.status]);

  const close = () => {
    setOpen(false);
    clear();
    requestAnimationFrame(() => opener.current?.focus());
  };

  const digests: string[] =
    preview.status === 'ready'
      ? preview.data.options.flatMap((o) => {
          if (!o.available || !ticked[o.key]) return [];
          const d = levelsOf(o)[level[o.key] ?? 0]?.digest;
          return d ? [d] : [];
        })
      : [];

  const allow = async () => {
    if (digests.length === 0 || preview.status !== 'ready') return;
    const { callDigest } = preview.data;
    let stale: string | undefined;
    const ok = await run(async () => {
      let result;
      try {
        result = await api.allowSimilar(q.id, digests, callDigest, q.version);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') stale = e.message;
        throw e;
      }
      if (result.ruleNotStored) throw new Error(result.ruleNotStored);
    });
    if (ok) setOpen(false);
    else if (stale !== undefined) {
      clear();
      setOpen(false);
      onStale(q.id, stale);
    }
  };

  const data = preview.status === 'ready' ? preview.data : undefined;
  const offered = data?.options.filter((o) => o.available) ?? [];
  const unavailable = data?.options.filter((o) => !o.available) ?? [];

  return (
    <>
      <button
        type="button"
        className="secondary"
        ref={opener}
        disabled={outerBusy || busy}
        aria-expanded={open}
        aria-controls={open ? chooserId : undefined}
        onClick={() => {
          if (open) return close();
          setPreview({ status: 'loading' });
          setOpen(true);
        }}
      >
        Allow similar for {project.name}…
      </button>
      {open && (
        <fieldset
          id={chooserId}
          className="allow-similar"
          ref={box}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <legend>
            Allow from now on in {project.name} (its Waykeeper and Stewards), until it closes
          </legend>
          {preview.status === 'loading' && <p className="muted">Reading what it would match…</p>}
          {preview.status === 'error' && <ErrorLine error={preview.error} />}
          {data?.refused && <p className="muted">Not offered: {data.refused}.</p>}
          {data && !data.refused && (
            <>
              {data.call && <CallText data={data} />}
              {data.notRememberable.length > 0 && (
                <ul className="allow-similar-notes muted" aria-label="allowed once only">
                  {data.notRememberable.map((n, i) => (
                    <li key={i}>
                      <code>{n.part}</code>: not offered as a rule, {n.reason}.
                    </li>
                  ))}
                </ul>
              )}
              {offered.map((o) => {
                const levels = levelsOf(o);
                const at = Math.min(level[o.key] ?? 0, levels.length - 1);
                const shown = levels[at]!;
                return (
                  <div key={o.key} className="allow-similar-row">
                    <label className="allow-similar-option">
                      <input
                        type="checkbox"
                        checked={!!ticked[o.key]}
                        disabled={busy}
                        onChange={(e) => setTicked({ ...ticked, [o.key]: e.target.checked })}
                      />
                      <span>
                        <strong>{KIND_WORDS[o.kind]}</strong>
                        {shown.label ? (
                          <>
                            {' '}
                            <code>{shown.label}</code>
                          </>
                        ) : null}
                        <br />
                        <span className="muted">{shown.preview}</span>
                        {o.covers && o.covers.length > 0 && (
                          <>
                            <br />
                            <span className="muted">
                              covers: <code>{o.covers.join(', ')}</code>
                            </span>
                          </>
                        )}
                      </span>
                    </label>
                    {levels.length > 1 && (
                      <select
                        className="allow-similar-widen"
                        aria-label={`How wide: ${o.label ?? o.key}`}
                        value={at}
                        disabled={busy}
                        onChange={(e) => setLevel({ ...level, [o.key]: Number(e.target.value) })}
                      >
                        {levels.map((l, i) => (
                          <option key={i} value={i}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              {unavailable.map((o) => (
                <p key={o.key} className="allow-similar-option is-off muted">
                  <strong>{KIND_WORDS[o.kind]}</strong>
                  {o.label ? (
                    <>
                      {' '}
                      <code>{o.label}</code>
                    </>
                  ) : null}
                  {` Not offered: ${o.reason ?? 'unavailable'}.`}
                </p>
              ))}
              {!data.allowed && (
                <p className="muted">
                  Only the Mac (or a phone when remote auto-approval is on) can make a rule.
                </p>
              )}
            </>
          )}
          <div className="controls">
            <button
              type="button"
              disabled={busy || !data || !!data.refused || !data.allowed || digests.length === 0}
              onClick={() => void allow()}
            >
              Allow and remember ticked
            </button>
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
          </div>
          <ErrorLine error={error} />
        </fieldset>
      )}
    </>
  );
}
