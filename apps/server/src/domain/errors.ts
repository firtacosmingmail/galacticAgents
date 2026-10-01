import type { DomainErrorCode } from '@galactic/protocol';

/**
 * A refused domain command (P2-01). Thrown inside `EventLog.runCommand`, so the transaction rolls
 * back and nothing is written; the message is meant for whoever asked — the panel, or a brain as
 * its tool error.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string): DomainError =>
  new DomainError('not_found', `no ${what} ${id}`);

/** Looks an entity up or refuses the command. */
export function must<T>(value: T | undefined, what: string, id: string): T {
  if (value === undefined) throw notFound(what, id);
  return value;
}
