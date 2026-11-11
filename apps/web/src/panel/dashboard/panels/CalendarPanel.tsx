import type { PanelData } from '@galactic/protocol';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const SHOWN = 8;

/**
 * A month grid: this month if it has entries, else the month of the entry nearest to now. The
 * entries are listed below it, soonest first, so the grid is never the only way to read them.
 */
export function CalendarPanel({
  calendar,
  now,
}: {
  calendar: NonNullable<PanelData['calendar']>;
  now: Date;
}) {
  const entries = [...calendar].sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length === 0) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthOf = (d: string) => d.slice(0, 7);
  const month = entries.some((e) => monthOf(e.date) === today)
    ? today
    : monthOf(
        entries.find((e) => e.date.slice(0, 7) >= today)?.date ?? entries[entries.length - 1]!.date,
      );
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1;
  const days = new Date(year, m + 1, 0).getDate();
  const lead = (new Date(year, m, 1).getDay() + 6) % 7; // Monday first
  const marked = new Set(
    entries.filter((e) => monthOf(e.date) === month).map((e) => Number(e.date.slice(8))),
  );
  return (
    <div className="dash-calendar">
      <div className="dash-cal-title">
        {MONTHS[m]} {year}
      </div>
      <div className="dash-cal" role="presentation">
        {WEEKDAYS.map((d, i) => (
          <div key={`h${i}`} className="dash-cal-head" aria-hidden="true">
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`l${i}`} aria-hidden="true" />
        ))}
        {Array.from({ length: days }, (_, i) => (
          <div key={i} className={marked.has(i + 1) ? 'is-marked' : undefined} aria-hidden="true">
            {i + 1}
          </div>
        ))}
      </div>
      <ul className="dash-feed">
        {entries.slice(0, SHOWN).map((e, i) => (
          <li key={i}>
            <span className="dash-tag">{e.date.slice(5)}</span>
            <span className="dash-feed-title">{e.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
