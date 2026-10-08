import { useContext, useEffect, useState } from 'react';
import { KNOWN_IDES, type IdeResponse } from '@galactic/protocol';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useSettingsData } from './SettingsData.js';
import type { EditorProps, SectionSpec } from './sections.js';

/**
 * The IDE setting (P9-03; SPEC decision 127): which IDE "Open in IDE" uses for a folder.
 * "Automatic" takes the first installed of WebStorm, IntelliJ IDEA, Cursor, Visual Studio Code
 * and Zed; otherwise one of the IDEs `GET /api/ide` lists as installed on the Mac. Changed on the
 * Mac only (decision 51): a remote client sees the choice, read-only.
 */

type IdeState = { kind: 'loading' } | { kind: 'ready'; info: IdeResponse } | { kind: 'error' };

/** What the server found on the Mac; read once per editor. */
function useIdes(): IdeState {
  const api = useContext(ApiContext);
  const [state, setState] = useState<IdeState>({ kind: 'loading' });
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.ide().then(
      (info) => {
        if (!cancelled) {
          setState(Array.isArray(info?.installed) ? { kind: 'ready', info } : { kind: 'error' });
        }
      },
      () => {
        if (!cancelled) setState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return state;
}

const nameOf = (bundleId: string) =>
  KNOWN_IDES.find((i) => i.bundleId === bundleId)?.name ?? bundleId;

type Choice = { value: string; label: string; hint: string };

function IdeEditor({ id, draft, setDraft, disabled, settings }: EditorProps<string>) {
  const state = useIdes();
  const limited = useSettingsData().response?.writable === 'limited';
  const info = state.kind === 'ready' ? state.info : undefined;
  const installed = info?.installed ?? [];
  const first = installed[0];
  const choices: Choice[] = [
    {
      value: 'auto',
      label: 'Automatic',
      hint: first
        ? `now ${first.name}`
        : info
          ? 'no IDE found on this Mac'
          : 'the first installed IDE',
    },
    ...installed.map((i) => ({ value: i.bundleId, label: i.name, hint: i.path })),
  ];
  // A saved IDE that is gone (uninstalled since) stays shown, marked.
  const saved = settings.deliverables?.ide;
  if (saved && saved !== 'auto' && info && !installed.some((i) => i.bundleId === saved)) {
    choices.push({ value: saved, label: nameOf(saved), hint: 'not installed any more' });
  }
  if (info && !info.supported) {
    return (
      <p className="set-note" role="note">
        Mission Control is not running on a Mac, so it opens nothing: Open in IDE is not offered.
      </p>
    );
  }
  return (
    <>
      {limited && (
        <p className="set-note" role="note">
          The IDE is chosen on the Mac itself.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="set-muted">Could not read the IDEs installed on the Mac.</p>
      )}
      {state.kind === 'loading' && <p className="set-muted">Looking for IDEs…</p>}
      <fieldset className="set-field set-radios" disabled={disabled || limited || !info}>
        <legend className="set-visually-hidden">IDE</legend>
        {choices.map((c) => (
          <label key={c.value} className="set-radio">
            <input
              type="radio"
              name={id}
              value={c.value}
              checked={draft === c.value}
              onChange={() => setDraft(c.value)}
            />
            <span>
              <strong>{c.label}</strong> <span className="set-muted">— {c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

export const IDE: SectionSpec<string> = {
  field: 'deliverables',
  title: 'IDE',
  intro:
    'Which IDE “Open in IDE” opens a project’s or a task’s folder in. Automatic takes the first installed of WebStorm, IntelliJ IDEA, Cursor, Visual Studio Code and Zed. Opening happens on the Mac, from its own browser or the desktop app; changed only on the Mac.',
  fromSettings: (s) => s.deliverables?.ide ?? 'auto',
  validate: () => undefined,
  toPatch: (d) => ({ deliverables: { ide: d } }),
  Editor: IdeEditor,
};
