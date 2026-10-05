import type { TranscriptCompaction } from '@galactic/protocol';

/**
 * The line a transcript or a chat shows where retention removed older output (P8-02; TECHNOLOGY
 * §6.2): never a silently shorter transcript. `transcript`: the Steward view, shown above the
 * oldest chunk left; `replies`: a chat, whose messages are kept (they are in the event log) while
 * the agent's replies up to `throughAt` are gone.
 */
export function compactionNote(c: TranscriptCompaction, scope: 'transcript' | 'replies'): string {
  const removed = day(c.removedAt);
  if (c.reason === 'archived') {
    return scope === 'transcript'
      ? `Older transcript removed on ${removed} by retention: this work was archived.`
      : `Replies removed on ${removed} by retention: this work was archived. Messages are kept.`;
  }
  const before = day(c.throughAt);
  return scope === 'transcript'
    ? `Older transcript (up to ${before}) removed on ${removed} by retention.`
    : `Replies up to ${before} removed on ${removed} by retention. Messages are kept.`;
}

const day = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
