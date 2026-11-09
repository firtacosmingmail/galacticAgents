import { useRef, useSyncExternalStore } from 'react';
import {
  SIMILAR_APPROVALS_THRESHOLD,
  type Id,
  type Question,
  type WaykeeperForward as Forward,
} from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * A permission card the Waykeeper forwarded (P13-06, design §5.6): why it sent it, the command's
 * parts (each on its own line, the failing one marked) and, after three or more similar earlier
 * approvals, what a standing approval would cover (the kind and the similar requests) and "let
 * the Waykeeper approve these". The block and the button are the same on the Mac and the phone
 * (Cosmin, 2026-11-09). The legacy console shows the block only, without the button; the menu bar
 * never offers the button.
 */

export const forwardedHeading = (reason: string) => `The Waykeeper sent this to you: ${reason}`;

/** The reason and the command's parts, with the failing part marked `← this part`. */
export function ForwardedBlock({ forward }: { forward: Forward }) {
  return (
    <div className="waykeeper-forward">
      <p>
        <strong>{forwardedHeading(forward.reason)}</strong>
      </p>
      {forward.parts.length > 0 && (
        <ul className="command-parts" aria-label="the command’s parts">
          {forward.parts.map((part, i) => {
            const failing = i === forward.failingPart;
            return (
              <li key={i} {...(failing ? { 'data-failing': 'true' } : {})}>
                <code>{part.text}</code>
                {failing && <strong className="failing-part"> ← this part</strong>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * "Answered, but no standing approval stored: …" (the route's `notStored`), kept by question id:
 * the answer turns the card into the answered one, which unmounts the button, so the note lives
 * outside it and the answered card shows it too (as a stale refusal survives the flip).
 */
const notes = new Map<Id, string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export function setStandingNote(questionId: Id, note: string | undefined): void {
  if (note === undefined) notes.delete(questionId);
  else notes.set(questionId, note);
  for (const l of [...listeners]) l();
}

/** The not-stored note of a question, wherever its card is shown. */
export function StandingNote({ questionId }: { questionId: Id }) {
  const note = useSyncExternalStore(subscribe, () => notes.get(questionId));
  return note ? (
    <p className="muted" role="status">
      {note}
    </p>
  ) : null;
}

function newAnswerId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The standing-approval button: answers the card "allow" and stores the kind as a standing
 * approval of the project. Open to every client; a `notStored` note says the answer went through
 * without one.
 */
export function StandingApprovalButton({
  question: q,
  forward,
  busy: outerBusy,
}: {
  question: Question;
  forward: Forward;
  busy: boolean;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  // The same key on every retry of this card's press.
  const answerId = useRef<string | undefined>(undefined);
  const n = forward.similar?.length ?? 0;
  if (n < SIMILAR_APPROVALS_THRESHOLD || typeof api.standingApproval !== 'function') return null;
  const press = async () => {
    answerId.current ??= newAnswerId();
    const key = answerId.current;
    await run(async () => {
      const result = await api.standingApproval(q.id, q.version, key);
      setStandingNote(q.id, result.notStored);
    });
  };
  return (
    <>
      {/* What the button grants, before it is pressed (design §5.5: "with the matched examples"). */}
      <p className="standing-covers">{`Covers: ${forward.kind}`}</p>
      <ul className="command-parts" aria-label="the similar approved requests">
        {forward.similar!.map((r, i) => (
          <li key={`${r.questionId}-${i}`}>
            <code>{r.summary}</code>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="secondary"
        disabled={outerBusy || busy}
        onClick={() => void press()}
      >
        {`Approved ${n} times before — let the Waykeeper approve these`}
      </button>
      <StandingNote questionId={q.id} />
      <ErrorLine error={error} />
    </>
  );
}
