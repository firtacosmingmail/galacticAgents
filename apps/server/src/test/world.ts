import type { EventEnvelope } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import type { CommandContext } from '../domain/event-log.js';
import { EventLog } from '../domain/event-log.js';

/**
 * A world for domain command tests: a fresh database holding the seeded catalogue (migration
 * 0005: the Sun, Earth and its Moon reserved, seven free planets — Mercury first — and their
 * moons). The clock ticks one second per reading, so a row stamped with a different reading
 * than its event shows up in a test; `clock.advance(ms)` jumps it (retention tests).
 */

export function tickingClock(
  start = Date.parse('2026-10-01T09:00:00.000Z'),
): (() => string) & { advance(ms: number): void } {
  let t = start;
  const clock = () => new Date((t += 1000)).toISOString();
  return Object.assign(clock, { advance: (ms: number) => void (t += ms) });
}

export function world() {
  const clock = tickingClock();
  const log = new EventLog(openDatabase(':memory:'), { now: clock });
  const seen: EventEnvelope[] = [];
  log.subscribe((e) => seen.push(e));
  /** Runs a command and returns its value plus the event types it appended. */
  const run = <T>(fn: (ctx: CommandContext) => T) => {
    const out = log.runCommand(fn);
    return {
      value: out.value,
      events: out.events.map((e) => e.event),
      types: out.events.map((e) => e.event.type),
    };
  };
  return { log, tables: log.tables, seen, run, clock };
}
