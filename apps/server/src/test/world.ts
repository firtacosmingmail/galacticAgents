import type { Body, EventEnvelope } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import type { CommandContext } from '../domain/event-log.js';
import { EventLog } from '../domain/event-log.js';

/**
 * A small world for domain command tests: a reserved Earth with its reserved Moon, two free
 * planets and a free moon of Mars (P2-02 seeds the real catalogue). The clock ticks one second
 * per reading, so a row stamped with a different reading than its event shows up in a test.
 */
export const BODIES: Body[] = [
  { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { reserved: true } },
  { id: 'b-moon', kind: 'moon', parentId: 'b-earth', name: 'Moon', meta: { reserved: true } },
  { id: 'b-mars', kind: 'planet', name: 'Mars' },
  { id: 'b-jupiter', kind: 'planet', name: 'Jupiter' },
  { id: 'b-phobos', kind: 'moon', parentId: 'b-mars', name: 'Phobos' },
];

export function tickingClock(start = Date.parse('2026-10-01T09:00:00.000Z')): () => string {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

export function world() {
  const log = new EventLog(openDatabase(':memory:'), { now: tickingClock() });
  for (const body of BODIES) log.tables.bodies.insert(body);
  const seen: EventEnvelope[] = [];
  log.subscribe((e) => seen.push(e));
  /** Runs a command and returns its value plus the event types it appended. */
  const run = <T>(fn: (ctx: CommandContext) => T) => {
    const out = log.runCommand(fn);
    return { value: out.value, events: out.events.map((e) => e.event), types: out.events.map((e) => e.event.type) };
  };
  return { log, tables: log.tables, seen, run };
}
