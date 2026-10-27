import type { Schedule } from './long-term.js';

const MAX_DAYS = 400;
const MAX_MISSED = 10_000;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseAt(at: string): [number, number] {
  const [h, m] = at.split(':');
  return [Number(h), Number(m)];
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function dayMatches(schedule: Schedule, date: Date): boolean {
  const iso = date.getDay() === 0 ? 7 : date.getDay();
  switch (schedule.kind) {
    case 'daily':
      return true;
    case 'weekdays':
      return iso <= 5;
    case 'weekly':
      return schedule.days.includes(iso);
    case 'monthly':
      return (
        date.getDate() === Math.min(schedule.day, daysInMonth(date.getFullYear(), date.getMonth()))
      );
  }
}

/** First occurrence strictly after `after`, in local time. */
export function nextOccurrence(schedule: Schedule, after: Date): Date {
  const [hh, mm] = parseAt(schedule.at);
  for (let i = 0; i <= MAX_DAYS; i++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
    if (!dayMatches(schedule, day)) continue;
    // A time inside a spring-forward gap is normalised by Date to the next valid minute.
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('no occurrence found within 400 days');
}

/** Number of occurrences in (from, to]. */
export function missedSince(schedule: Schedule, from: Date, to: Date): number {
  let count = 0;
  let cur = from;
  while (count < MAX_MISSED) {
    cur = nextOccurrence(schedule, cur);
    if (cur.getTime() > to.getTime()) break;
    count++;
  }
  return count;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function scheduleText(schedule: Schedule): string {
  const [hh, mm] = parseAt(schedule.at);
  const time = `${hh}:${String(mm).padStart(2, '0')}`;
  switch (schedule.kind) {
    case 'daily':
      return `every day ${time}`;
    case 'weekdays':
      return `weekdays ${time}`;
    case 'weekly': {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b).map((d) => DAY_NAMES[d - 1]);
      return `${days.join(', ')} ${time}`;
    }
    case 'monthly':
      return `monthly, ${ordinal(schedule.day)} ${time}`;
  }
}
