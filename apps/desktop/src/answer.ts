import { randomUUID } from 'node:crypto';
import { cleanMenuText } from './tray-menu.js';

/**
 * Answers a permission request from the menu bar (P9-15): the panel's route,
 * `POST /api/questions/:id/answer`, with the token as the page sends it (`Authorization: Bearer`)
 * and the question's version the menu showed. The answer is the panel's own: `allow` (Allow once)
 * or `no` (Deny) — never an "always" (no such answer exists, and the menu offers none).
 *
 * - 200 → `answered` (the stream brings `question.answered`; the menu and the panel update).
 * - 409 `stale` → `stale`: someone answered first, or the question moved since the menu showed it;
 *   the server's message ("already answered by …") is kept, made safe for a notification.
 *   A withdrawn (dismissed) question is `stale` too ("was already withdrawn").
 * - 404 or 409 `rejected` → `gone`; anything else (another refusal, no server, a timeout) → `failed`.
 *
 * Neither the token nor the request's input is ever logged or returned.
 */

export type TrayDecision = 'allow' | 'deny';

export interface TrayAnswer {
  questionId: string;
  version: number;
  decision: TrayDecision;
}

export type AnswerOutcome =
  | { kind: 'answered' }
  | { kind: 'stale'; message: string }
  | { kind: 'gone' }
  | { kind: 'failed'; reason: string };

/** The panel's answers (`QuestionCard`): `allow` runs the call, `no` refuses it. */
export const ANSWER_TEXT: Record<TrayDecision, string> = { allow: 'allow', deny: 'no' };

export interface AnswerDeps {
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The idempotency key (P7-05); a fresh one per menu click by default. */
  answerId?: string;
}

export async function answerQuestion(answer: TrayAnswer, deps: AnswerDeps): Promise<AnswerOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${deps.baseUrl}/api/questions/${encodeURIComponent(answer.questionId)}/answer`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
      body: JSON.stringify({
        answer: ANSWER_TEXT[answer.decision],
        version: answer.version,
        answerId: deps.answerId ?? `tray:${randomUUID()}`,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch {
    return { kind: 'failed', reason: 'Mission Control did not answer' };
  }
  if (response.ok) return { kind: 'answered' };
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // no body
  }
  const message = typeof body.message === 'string' ? cleanMenuText(body.message, 200) : '';
  if (response.status === 409 && body.error === 'stale') {
    return { kind: 'stale', message: message || 'already answered' };
  }
  // A question that is no longer open (an older server's "is cancelled" refusal) is gone too.
  if (response.status === 404 || (response.status === 409 && body.error === 'rejected')) {
    return { kind: 'gone' };
  }
  if (response.status === 401) return { kind: 'failed', reason: 'the token was refused' };
  return {
    kind: 'failed',
    reason: message || `Mission Control refused it (${response.status})`,
  };
}

/** The notification an outcome posts (none for a plain success: the menu and the panel update). */
export function outcomeNotice(
  outcome: AnswerOutcome,
  decision: TrayDecision,
): { title: string; body: string } | undefined {
  switch (outcome.kind) {
    case 'answered':
      return undefined;
    case 'stale':
      return {
        // Answered first by someone else, or withdrawn or moved since the menu showed it.
        title: /already answered/i.test(outcome.message)
          ? 'Permission request already answered'
          : 'Permission request is no longer waiting',
        body: `Your ${decision === 'allow' ? 'Allow' : 'Deny'} was not sent: ${outcome.message.replace(/[.\s]+$/, '')}.`,
      };
    case 'gone':
      return {
        title: 'Permission request no longer exists',
        body: 'Open GalacticAgents to see what waits for you.',
      };
    case 'failed':
      return {
        title: 'Could not answer the permission request',
        body: `${cleanMenuText(outcome.reason, 160).replace(/[.\s]+$/, '')}. Answer it in GalacticAgents.`,
      };
  }
}
