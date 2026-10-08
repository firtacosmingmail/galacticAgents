import { SUPERSEDED_BY_MESSAGE } from '@galactic/protocol';

/**
 * A question the user dismissed (P9-14, SPEC decision 135), as an adapter's pending question
 * resolves with it: distinct from an answer (a string) and from an interruption (`undefined`).
 */
export interface Dismissed {
  dismissed: string;
}

export const isDismissed = (value: unknown): value is Dismissed =>
  typeof value === 'object' && value !== null && 'dismissed' in value;

/**
 * What the agent reads when its clarification is dismissed: the tool result of its question
 * tool, so it carries on (or asks again) instead of waiting.
 */
export function dismissedClarification(reason: string): string {
  return (
    `The user did not answer this question: it was ${reason}. Do not wait for an answer: ` +
    'carry on with what you know, or ask again later if it still matters.' +
    (reason === SUPERSEDED_BY_MESSAGE ? ' Their new message reaches you next: read it.' : '')
  );
}

/** What the agent reads when its permission request is dismissed: a refusal, never an allow. */
export function dismissedPermission(reason: string): string {
  return `The user refused: the permission request was ${reason}.`;
}
