/**
 * A paging cursor a client sent back that is not one of ours (malformed, or the cursor of another
 * list). The panel routes answer it with 400 `invalid_query`; any other error stays a 500.
 */
export class CursorError extends Error {
  override readonly name = 'CursorError';
}
