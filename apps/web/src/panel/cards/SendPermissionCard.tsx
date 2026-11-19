import { useState, type ReactNode } from 'react';
import type { PublishContext, Question, SendPermissionContext } from '@galactic/protocol';
import { newAnswerId } from '../../client/answer-queue.js';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * A held send's card (P13-30; design 2026-11-18 §4.4 step 3): a send or spend no grant covered.
 * Titled by what it sends; under the decider's text, the held call — the post as the publish card
 * shows it (platform, account, text, files), else the command's parts. **Allow once** / **Don't
 * allow** answer the held call directly (neither makes a grant). When a Waykeeper or the
 * Harmonizer decides (`deciderId`), a reply box sends the user's words to it as a reply to this
 * question: it turns them into a grant ("only today", "this campaign"); without one, the
 * buttons only. `QuestionCard` gives it its shell (the ×, the offline queue).
 */

export const SEND_REPLY_HINT =
  'Reply with how far to allow it (only today, this campaign, these ads), or use the buttons.';

/** The post a held publish would make, as the publish card lists it (no thumbnails). */
function PublishPost({ publish }: { publish: PublishContext }) {
  return (
    <div className="publish">
      <p className="publish-head">
        <span className="publish-badge" aria-hidden="true">
          ↗
        </span>{' '}
        Publish to <strong>{publish.platform}</strong> as <strong>{publish.account}</strong>
      </p>
      <blockquote className="publish-text">{publish.text}</blockquote>
      {publish.files.length > 0 && (
        <div className="publish-files">
          <p className="muted">
            {publish.files.length === 1 ? '1 file' : `${publish.files.length} files`}
          </p>
          <ul className="items" aria-label="files to publish">
            {publish.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The summary, the decider's text, where it comes from, and the held call. */
export function SendPermissionDetails({
  question: q,
  send,
  origin,
}: {
  question: Question;
  send: SendPermissionContext;
  /** Where the question comes from (`OriginContext`). */
  origin: ReactNode;
}) {
  return (
    <div className="send-permission">
      <p className="send-title">
        <strong>{send.summary}</strong>
      </p>
      <p>{q.context.text}</p>
      {origin}
      {send.publish ? (
        <PublishPost publish={send.publish} />
      ) : (
        send.parts.length > 0 && (
          <ul className="command-parts" aria-label="the command’s parts">
            {send.parts.map((part, i) => (
              <li key={i}>
                <code>{part.text}</code>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** The reply to the decider, as a reply to the question (it wakes the decider from any chat). */
function SendReply({ question: q, deciderId }: { question: Question; deciderId: string }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  return (
    <form
      className="send"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = value.trim();
        if (!text) return;
        const ok = await run(() =>
          api.send(deciderId, text, false, {
            kind: 'question',
            id: q.id,
            version: q.version,
            answerId: newAnswerId(),
          }),
        );
        if (ok) setValue('');
      }}
    >
      <input
        aria-label="reply"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="only today, this campaign…"
      />
      <button type="submit" disabled={busy || !value.trim()}>
        Reply
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

/** Allow once / Don't allow, and the reply box when there is a decider. */
export function SendPermissionActions({
  question: q,
  send,
  busy,
  onAnswer,
}: {
  question: Question;
  send: SendPermissionContext;
  busy: boolean;
  onAnswer: (answer: 'allow' | 'deny') => void;
}) {
  return (
    <>
      {send.deciderId !== undefined && <p className="muted">{SEND_REPLY_HINT}</p>}
      <div className="controls">
        <button type="button" disabled={busy} onClick={() => onAnswer('allow')}>
          Allow once
        </button>
        <button type="button" disabled={busy} className="danger" onClick={() => onAnswer('deny')}>
          Don&apos;t allow
        </button>
      </div>
      {send.deciderId !== undefined && <SendReply question={q} deciderId={send.deciderId} />}
    </>
  );
}
