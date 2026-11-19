import { useEffect, useState } from 'react';
import { isGrantLive, type SendGrant } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { when } from './ApprovalsLog.js';
import { useAppStore } from '../../state/store.js';

/**
 * A scope's send grants (P13-30; design 2026-11-18 §4.3 "Shown"): a project's, next to its marks,
 * or standalone work's (`projectId` undefined) in the settings. Each live grant shows what it
 * allows, the user's words, its end, how many sends it allowed and Remove — the user's only, from
 * the Mac or the phone. A grant made from the phone says so; while the scope's Auto is off the
 * grants are kept but unused, and shown "paused". A grant a grant-conflict question paused
 * (P13-34) says "Paused — waiting for your answer" while that question is open, "Paused — your
 * answer is being carried out" once answered, and offers Resume grant. Ended and removed grants are not shown.
 */
export function SendGrants({
  grants,
  projectId,
  autoOn,
  uses,
}: {
  grants: readonly SendGrant[];
  projectId: string | undefined;
  autoOn: boolean;
  /** Sends allowed per grant id. */
  uses: ReadonlyMap<string, number>;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const questions = useAppStore((s) => s.world.questions);
  // Read each minute, so a grant that ends while the page is open leaves the list.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const live = grants.filter((g) => isGrantLive(g, now));
  if (live.length === 0) return null;
  return (
    <div className="send-grants">
      <h4>Allowed sends and spends ({live.length})</h4>
      <ul className="permission-rules" aria-label="send grants">
        {live.map((g) => (
          <li key={g.id}>
            <span>
              {`"${g.summary}" · "${g.words}" · ${g.endsAt ? `ends ${when(g.endsAt)}` : 'no end'}`}
            </span>
            <span className="muted">{`used ${uses.get(g.id) ?? 0}×`}</span>
            {g.pausedBy !== undefined && (
              <>
                <span className="pill" data-question={g.pausedBy}>
                  {questions[g.pausedBy]?.status === 'open'
                    ? 'Paused — waiting for your answer'
                    : 'Paused — your answer is being carried out'}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`Resume the grant ${g.summary}`}
                  onClick={() => void run(() => api.resumeSendGrant(projectId, g.id))}
                >
                  Resume grant
                </button>
              </>
            )}
            {!autoOn && <span className="pill">paused (Auto is off)</span>}
            {g.origin === 'remote' && <span className="muted">from the phone</span>}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              aria-label={`Remove the grant ${g.summary}`}
              onClick={() => void run(() => api.removeSendGrant(projectId, g.id))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}
