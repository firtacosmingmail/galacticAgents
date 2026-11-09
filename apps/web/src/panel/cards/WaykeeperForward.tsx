import { useRef, useState } from 'react';
import type { Question, WaykeeperForward as Forward } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * A permission card the Waykeeper forwarded (P13-06, design §5.6): why it sent it, the command's
 * parts (each on its own line, the failing one marked) and, after three or more similar earlier
 * approvals, "let the Waykeeper approve these". The block and the button are the same on the Mac,
 * the phone and the legacy console (Cosmin, 2026-11-09); the menu bar never offers the button.
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
  const [note, setNote] = useState<string | undefined>();
  // The same key on every retry of this card's press.
  const answerId = useRef<string | undefined>(undefined);
  const n = forward.similar?.length ?? 0;
  if (n < 3 || typeof api.standingApproval !== 'function') return null;
  const press = async () => {
    answerId.current ??= newAnswerId();
    const key = answerId.current;
    await run(async () => {
      const result = await api.standingApproval(q.id, q.version, key);
      if (result.notStored) setNote(result.notStored);
    });
  };
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={outerBusy || busy}
        onClick={() => void press()}
      >
        {`Approved ${n} times before — let the Waykeeper approve these`}
      </button>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      <ErrorLine error={error} />
    </>
  );
}
