import type { PanelData, PanelDisplay } from '@galactic/protocol';

/** "12", "4.1", "1,284": at most two decimals, thousands separated. */
export const plainNumber = (n: number): string =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(n);

/** A number the way the panel's `display` asks for it (number, percent, money; a short unit). */
export function formatValue(n: number, display: PanelDisplay | undefined): string {
  switch (display?.format) {
    case 'percent':
      return `${plainNumber(n)}%`;
    case 'money':
      try {
        if (display.currency)
          return new Intl.NumberFormat('en', {
            style: 'currency',
            currency: display.currency,
            maximumFractionDigits: 2,
          }).format(n);
      } catch {
        // an unknown currency code: fall through to the plain number
      }
      return plainNumber(n);
    default:
      return display?.unit ? `${plainNumber(n)} ${display.unit}` : plainNumber(n);
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "2 h ago", "3 days ago" (an unreadable time: ""). */
export function ageText(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const days = Math.floor(ms / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * The verdict a panel shows: only an `ok` panel has one. A stale value, a stopped job and a value
 * that is no longer reported are never coloured, whatever the data carries (decision 156).
 */
export function shownVerdict(data: PanelData | undefined): PanelData['verdict'] | undefined {
  return data?.status === 'ok' ? data.verdict : undefined;
}

export const verdictWord = (kind: 'very_bad' | 'very_good'): string =>
  kind === 'very_bad' ? 'very bad' : 'very good';
export const verdictArrow = (arrow: 'up' | 'down'): string => (arrow === 'up' ? '▲' : '▼');
