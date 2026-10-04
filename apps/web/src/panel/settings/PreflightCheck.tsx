import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreflightResponse, RuntimePreflight } from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';

const RUNTIME_NAMES: Record<string, string> = {
  'claude-sdk': 'Claude Code (Agent SDK)',
  fake: 'Fake runtime (development)',
};

/**
 * The runtime check (P25-08; SPEC §4.6): is Claude Code installed and logged in, with which
 * versions. A problem is a fixable message — what is wrong and what to do — never a crash; a
 * warning (an API-key login, the SDK's own Claude Code) leaves the runtime usable. "Check again"
 * reruns the checks on the server (`?refresh=1`) instead of reading its cached result.
 */
export function PreflightCheck({
  onResult,
  headingLevel = 2,
}: {
  /** Called with each result (the wizard words its button by it). */
  onResult?: (result: PreflightResponse | undefined) => void;
  headingLevel?: 2 | 3;
}) {
  const api = useApi();
  const [result, setResult] = useState<PreflightResponse>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(true);
  const report = useRef(onResult);
  useEffect(() => {
    report.current = onResult;
  });

  /** Reads the check; state changes only when the answer arrives. */
  const load = useCallback(
    (refresh: boolean, cancelled: () => boolean = () => false) =>
      api.preflight(refresh).then(
        (r) => {
          if (cancelled()) return;
          setResult(r);
          setError(undefined);
          setChecking(false);
          report.current?.(r);
        },
        (e: unknown) => {
          if (cancelled()) return;
          setError((e as Error).message);
          setChecking(false);
          report.current?.(undefined);
        },
      ),
    [api],
  );

  useEffect(() => {
    let stop = false;
    void load(false, () => stop);
    return () => {
      stop = true;
    };
  }, [load]);

  const recheck = () => {
    setChecking(true);
    setError(undefined);
    void load(true);
  };

  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="set-section" aria-label="Runtime check">
      <div className="set-head">
        <Heading className="set-title">Runtime check</Heading>
        {result && !checking && (
          <span className={`set-tag ${result.ok ? 'set-tag-ok' : 'set-tag-bad'}`}>
            {result.ok ? 'ready' : 'needs attention'}
          </span>
        )}
      </div>
      <p className="set-intro">
        Agents run through Claude Code with your subscription login. Mission Control checks that it
        is installed and logged in.
      </p>
      {checking && !result && <p className="set-muted">Checking…</p>}
      {error && (
        <p className="set-error" role="alert">
          Could not run the check: {error}
        </p>
      )}
      {result && result.runtimes.length === 0 && (
        <p className="set-muted">No runtime is registered on this server.</p>
      )}
      {result?.runtimes.map((r) => (
        <RuntimeRow key={r.runtime} runtime={r} />
      ))}
      <div className="set-actions">
        <button type="button" className="set-secondary" disabled={checking} onClick={recheck}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        {result && (
          <span className="set-muted">
            checked {new Date(result.checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </section>
  );
}

function RuntimeRow({ runtime: r }: { runtime: RuntimePreflight }) {
  const facts: [string, string | undefined][] = [
    ['installed', r.installed ? 'yes' : 'no'],
    ['logged in', r.loggedIn === undefined ? undefined : r.loggedIn ? 'yes' : 'no'],
    ['login', [r.authMethod, r.subscriptionType].filter(Boolean).join(' · ') || undefined],
    ['provider', r.apiProvider],
    ['Claude Code', r.version],
    ['Agent SDK', r.sdkVersion],
  ];
  return (
    <div className="set-runtime" role="group" aria-label={`runtime ${r.runtime}`}>
      <p className="set-runtime-name">
        <span className={r.ok ? 'set-ok' : 'set-bad'} aria-hidden="true">
          ●
        </span>{' '}
        {RUNTIME_NAMES[r.runtime] ?? r.runtime} — {r.ok ? 'ready' : 'not ready'}
      </p>
      <dl className="set-facts">
        {facts
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      {r.problems.length > 0 && (
        <ul className="set-problems">
          {r.problems.map((p) => (
            <li key={p.code} className={`set-problem set-problem-${p.severity}`}>
              <strong>{p.severity === 'error' ? 'Problem' : 'Note'}:</strong> {p.message}
              {p.fix && (
                <span className="set-fix">
                  {' '}
                  <strong>Fix:</strong> {p.fix}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
