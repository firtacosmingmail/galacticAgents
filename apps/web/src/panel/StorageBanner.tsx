import { useState } from 'react';
import type { StorageHealth } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';

/**
 * The storage banner (P8-09; SPEC decision 99): while the server's database refuses writes, a
 * band under the top bar says so — the disk is full and how many agent events wait to be saved,
 * or that the database cannot be written at all — and that the user's actions are refused until
 * it can. It goes when the storage takes writes again (the held events are written).
 *
 * Screen readers hear the changes of condition only, never the count as it moves: an assertive
 * announcement when writes start failing (or fail differently), a polite one when they work again.
 * The band itself is not a live region.
 */

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The banner's words for a refusing storage; undefined while it is `ok`. */
export function storageBannerText(
  h: StorageHealth,
): { title: string; detail: string; announce: string } | undefined {
  if (h.condition === 'ok') return undefined;
  const waiting = h.held > 0 ? `${plural(h.held, 'agent event')} waiting to be saved` : undefined;
  const dropped =
    h.dropped > 0
      ? ` ${plural(h.dropped, 'older tool call or progress line', 'older tool calls and progress lines')} ` +
        'were not kept, to stay within the limit.'
      : '';
  switch (h.condition) {
    case 'full':
      return {
        title: `Disk full — ${waiting ? `${waiting}; ` : ''}your actions are refused until there is space.`,
        detail:
          'Agents keep working and what they do is saved as soon as there is room. Free some ' +
          'space on the disk, then repeat what was refused.' +
          dropped,
        announce: 'Disk full: your actions are refused until there is space.',
      };
    case 'unwritable':
      return {
        title:
          'The database cannot be written (the file is read-only or missing) — ' +
          `${waiting ? `${waiting}; ` : ''}your actions are refused until it is fixed.`,
        detail:
          "This does not pass by itself: fix the database file's permissions or restore it." +
          dropped,
        announce:
          'The database cannot be written: your actions are refused until the file is fixed.',
      };
    case 'unavailable':
      return {
        title:
          'The database cannot be written just now — ' +
          `${waiting ? `${waiting}; ` : ''}your actions are refused until it can.`,
        detail: 'Mission Control keeps trying; repeat what was refused in a moment.' + dropped,
        announce: 'The database cannot be written just now: your actions are refused.',
      };
  }
}

function since(at: string | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : ` Since ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
}

export function StorageBanner() {
  const storage = useAppStore((s) => s.storage);
  const text = storageBannerText(storage);
  return (
    <>
      <StorageAnnouncer storage={storage} />
      {text && (
        <section
          className={`pnl-storage pnl-storage-${storage.condition}`}
          aria-label="Storage problem"
          data-condition={storage.condition}
        >
          <p className="pnl-storage-title">{text.title}</p>
          <p className="pnl-storage-detail">
            {text.detail}
            {since(storage.since)}
          </p>
        </section>
      )}
    </>
  );
}

/**
 * The announcements: assertive when the storage starts refusing (or a page opens on a refusing
 * one) or refuses differently, polite when it takes writes again. Two regions kept in the page,
 * so each change is read once.
 */
function StorageAnnouncer({ storage }: { storage: StorageHealth }) {
  // Adjusted while rendering from the previous condition (React's "storing information from
  // previous renders"), not in an effect.
  const [last, setLast] = useState<StorageHealth['condition'] | undefined>(undefined);
  const [said, setSaid] = useState({ alert: '', status: '' });
  if (last !== storage.condition) {
    setLast(storage.condition);
    if (storage.condition !== 'ok') {
      setSaid({ alert: storageBannerText(storage)?.announce ?? '', status: '' });
    } else if (last !== undefined) {
      setSaid({
        alert: '',
        status: 'The database takes writes again: the waiting agent events are saved.',
      });
    }
  }
  const { alert, status } = said;
  return (
    <>
      <div className="pnl-visually-hidden" role="alert" aria-atomic="true">
        {alert}
      </div>
      <div className="pnl-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </div>
    </>
  );
}
