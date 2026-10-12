import { useEffect, useId, useRef, useState } from 'react';
import type {
  Id,
  PermissionRuleScope,
  Project,
  Question,
  SimilarPreviewResponse,
} from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import type { WorldState } from '../../state/reduce.js';
import { useClientRules } from '../deliverables/use-deliverables.js';

/**
 * "Allow similar" on a permission card (P9-17, SPEC decision 138): next to "Allow once", for a
 * request whose agent belongs to a project (a Waykeeper, or a Steward of one of its tasks), a
 * button opens a small chooser with the three scopes — exactly this, this command prefix or
 * folder, this whole category — each with the server's preview of exactly what it will match
 * (`POST …/similar-preview`); "Allow and remember" answers the request "allow" and stores the
 * rule on the project in one command. Never for a push, never for the Harmonizer's or an
 * asteroid's requests (no project), and only on a client that may write settings: the Mac's own
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

const SCOPE_WORDS: Record<PermissionRuleScope, string> = {
  exact: 'Exactly this',
  prefix: 'This command prefix / folder',
  category: 'This whole category',
};

type Preview =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: SimilarPreviewResponse };

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
  const [scope, setScope] = useState<PermissionRuleScope | undefined>();
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
        setPreview({ status: 'ready', data });
        setScope(data.options.find((o) => o.available)?.scope);
      },
      (e: unknown) => live && setPreview({ status: 'error', error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [api, open, q.id, q.version]);

  // The chooser takes the focus when its options arrive; closing gives it back to the opener.
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
  const allow = async () => {
    if (!scope || preview.status !== 'ready') return;
    const digest = preview.data.options.find((o) => o.scope === scope)?.digest;
    if (!digest) return;
    let stale: string | undefined;
    const ok = await run(async () => {
      let result;
      try {
        result = await api.allowSimilar(q.id, scope, digest, q.version);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') stale = e.message;
        throw e;
      }
      // Allowed once, but the rule could not be stored after it (review S6): say so.
      if (result.ruleNotStored) throw new Error(result.ruleNotStored);
    });
    if (ok) setOpen(false);
    else if (stale !== undefined) {
      clear();
      setOpen(false);
      onStale(q.id, stale);
    }
  };

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
          {preview.status === 'ready' && preview.data.refused && (
            <p className="muted">Not offered: {preview.data.refused}.</p>
          )}
          {preview.status === 'ready' && !preview.data.refused && (
            <>
              {preview.data.options.map((o) => (
                <label
                  key={o.scope}
                  className={`allow-similar-option${o.available ? '' : ' is-off'}`}
                >
                  <input
                    type="radio"
                    name={`${chooserId}-scope`}
                    value={o.scope}
                    checked={scope === o.scope}
                    disabled={!o.available || busy}
                    onChange={() => setScope(o.scope)}
                  />
                  <span>
                    <strong>{SCOPE_WORDS[o.scope]}</strong>
                    {o.label ? (
                      <>
                        {': '}
                        <code>{o.label}</code>
                      </>
                    ) : null}
                    <br />
                    <span className="muted">
                      {o.available ? o.preview : `Not offered: ${o.reason ?? 'unavailable'}.`}
                    </span>
                  </span>
                </label>
              ))}
              {!preview.data.allowed && (
                <p className="muted">
                  Only the Mac (or a phone when remote auto-approval is on) can make a rule.
                </p>
              )}
            </>
          )}
          <div className="controls">
            <button
              type="button"
              disabled={
                busy ||
                preview.status !== 'ready' ||
                !!preview.data.refused ||
                !preview.data.allowed ||
                !scope
              }
              onClick={() => void allow()}
            >
              Allow and remember
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
