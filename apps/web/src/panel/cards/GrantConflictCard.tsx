import { useState } from 'react';
import type { GrantConflictContext } from '@galactic/protocol';
import { when } from '../status/ApprovalsLog.js';

/**
 * A grant-conflict question's card (P13-34, SPEC decision 166): Cosmin's new words about what may
 * be sent conflict with grants in force, which are paused until he answers. It quotes each
 * earlier grant's words and end, the new words, then the options — the three fixed ones first,
 * then the decider's own — and a box for an answer in his own words. `QuestionCard` gives it its
 * shell (the ×, the offline queue).
 */

/** The earlier grants and the new words. */
export function GrantConflictDetails({ conflict }: { conflict: GrantConflictContext }) {
  return (
    <div className="grant-conflict">
      <p className="send-title">
        <strong>Your new words conflict with an earlier grant</strong>
      </p>
      <p className="muted">Earlier you said (paused while you decide):</p>
      <ul className="items" aria-label="earlier grants">
        {conflict.grants.map((g) => (
          <li key={g.id}>
            <blockquote>“{g.words}”</blockquote>
            <span className="muted">{g.endsAt ? `until ${when(g.endsAt)}` : 'no end'}</span>
          </li>
        ))}
      </ul>
      <p className="muted">Now you said:</p>
      <blockquote aria-label="new words">“{conflict.newWords}”</blockquote>
    </div>
  );
}

/** The options as buttons, and an answer in his own words. */
export function GrantConflictActions({
  options,
  busy,
  onAnswer,
}: {
  options: readonly string[];
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <div className="controls">
        {options.map((o) => (
          <button key={o} type="button" disabled={busy} onClick={() => onAnswer(o)}>
            {o}
          </button>
        ))}
      </div>
      <form
        className="send"
        onSubmit={(e) => {
          e.preventDefault();
          const text = value.trim();
          if (!text) return;
          onAnswer(text);
          setValue('');
        }}
      >
        <input
          aria-label="answer"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="or say what you want instead"
        />
        <button type="submit" disabled={busy || !value.trim()}>
          Answer
        </button>
      </form>
    </>
  );
}
