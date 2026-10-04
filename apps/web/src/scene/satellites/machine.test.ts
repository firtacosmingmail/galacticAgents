import { describe, expect, it } from 'vitest';
import {
  advance,
  canTransition,
  createActor,
  easeInOut,
  hashId,
  sampleActor,
  SATELLITE_MODES,
  scanInterval,
  TIMING,
  TRANSITIONS,
  type SatelliteActor,
  type SatelliteInput,
  type SatelliteMode,
} from './machine.js';

const working: SatelliteInput = { bodyId: 'b-mars', state: 'working' };
const idle: SatelliteInput = { bodyId: 'b-mars', state: 'idle' };

/** Runs the machine at a fixed frame rate, checking that every change takes a table edge. */
function run(
  actor: SatelliteActor,
  input: SatelliteInput,
  from: number,
  to: number,
  dt = 1 / 30,
  reducedMotion = false,
): { actor: SatelliteActor; modes: SatelliteMode[] } {
  let a = actor;
  const modes: SatelliteMode[] = [a.mode];
  for (let t = from; t <= to + 1e-9; t += dt) {
    const next = advance(a, input, t, { reducedMotion });
    if (next.mode !== a.mode) {
      expect(canTransition(a.mode, next.mode), `${a.mode} → ${next.mode}`).toBe(true);
      modes.push(next.mode);
    }
    a = next;
  }
  return { actor: a, modes };
}

describe('the transition table', () => {
  it('covers every mode, and every edge goes to a known mode', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SATELLITE_MODES].sort());
    for (const targets of Object.values(TRANSITIONS))
      for (const t of targets) expect(SATELLITE_MODES).toContain(t);
  });

  it('a flight goes only to its arrival or a new destination', () => {
    expect(TRANSITIONS.flying).toEqual(['orbiting', 'flying']);
    expect(canTransition('flying', 'landing')).toBe(false);
    expect(canTransition('flying', 'scanning')).toBe(false);
  });
});

describe('a new satellite', () => {
  it('starts orbiting its body, seeded by the agent id', () => {
    const a = createActor('a-1', working, 10);
    expect(a.mode).toBe('orbiting');
    expect(a.bodyId).toBe('b-mars');
    expect(a.seed).toBe(hashId('a-1'));
    expect(a.nextScanAt).toBeGreaterThan(10);
    expect(createActor('a-1', working, 10)).toEqual(a);
  });

  it('starts landed when its work is already complete', () => {
    expect(createActor('a-1', { ...working, landed: true }, 0).mode).toBe('landed');
  });

  it('returns the same object while nothing changes', () => {
    const a = createActor('a-1', idle, 0);
    expect(advance(a, idle, 1)).toBe(a);
  });
});

describe('scanning', () => {
  it('a working agent scans its body periodically, with seeded pauses', () => {
    const a = createActor('a-scan', working, 0);
    const { modes, actor } = run(a, working, 0, 60);
    const scans = modes.filter((m) => m === 'scanning').length;
    // Every scan + pause takes scan + [5, 10) s: 60 s hold between 4 and 8 scans.
    expect(scans).toBeGreaterThanOrEqual(4);
    expect(scans).toBeLessThanOrEqual(8);
    expect(actor.scans).toBe(scans);
    expect(modes.every((m) => m === 'orbiting' || m === 'scanning')).toBe(true);
  });

  it('a scan lasts TIMING.scan and its beam fades in and out', () => {
    let a = createActor('a-beam', working, 0);
    a = advance(a, working, a.nextScanAt);
    expect(a.mode).toBe('scanning');
    const start = a.scan?.start ?? NaN;
    expect(sampleActor(a, start).beam).toBe(0);
    expect(sampleActor(a, start + TIMING.beamFade / 2).beam).toBeCloseTo(0.5);
    expect(sampleActor(a, start + TIMING.scan / 2).beam).toBe(1);
    expect(sampleActor(a, start + TIMING.scan - TIMING.beamFade / 2).beam).toBeCloseTo(0.5);
    const after = advance(a, working, start + TIMING.scan + 0.01);
    expect(after.mode).toBe('orbiting');
    expect(sampleActor(after, start + TIMING.scan + 0.01).beam).toBe(0);
    // The next scan comes after one seeded interval from the end of this one.
    expect(after.nextScanAt).toBeCloseTo(start + TIMING.scan + scanInterval(a.seed, 1));
  });

  it('agents that are not working never scan, and a scan stops when work stops', () => {
    for (const state of ['idle', 'waiting_for_input', 'paused', 'stalled', 'starting'] as const) {
      const { modes } = run(createActor('a-x', { ...idle, state }, 0), { ...idle, state }, 0, 40);
      expect(modes).toEqual(['orbiting']);
    }
    let a = createActor('a-stop', working, 0);
    a = advance(a, working, a.nextScanAt);
    expect(a.mode).toBe('scanning');
    expect(advance(a, idle, a.nextScanAt + 0.5).mode).toBe('orbiting');
  });

  it('different agents scan at different times', () => {
    const starts = ['a-1', 'a-2', 'a-3', 'a-4'].map((id) => createActor(id, working, 0).nextScanAt);
    expect(new Set(starts.map((s) => s.toFixed(3))).size).toBe(4);
  });
});

describe('flights', () => {
  it('a new body starts a flight that ends orbiting there after TIMING.flight', () => {
    let a = createActor('a-fly', idle, 0);
    const moved = { ...idle, bodyId: 'b-jupiter' };
    a = advance(a, moved, 5);
    expect(a.mode).toBe('flying');
    expect(a.flight).toEqual({
      fromBodyId: 'b-mars',
      toBodyId: 'b-jupiter',
      start: 5,
      duration: TIMING.flight,
    });
    expect(a.bodyId).toBe('b-jupiter');
    expect(sampleActor(a, 5).flight).toBe(0);
    expect(sampleActor(a, 5 + TIMING.flight / 2).flight).toBeCloseTo(0.5);
    expect(advance(a, moved, 5 + TIMING.flight - 0.01).mode).toBe('flying');
    const arrived = advance(a, moved, 5 + TIMING.flight);
    expect(arrived.mode).toBe('orbiting');
    expect(arrived.flight).toBeUndefined();
  });

  it('completes even when no frame was drawn during it (camera elsewhere, scene hidden)', () => {
    let a = createActor('a-away', working, 0);
    const moved = { ...working, bodyId: 'b-europa' };
    a = advance(a, moved, 1);
    expect(a.mode).toBe('flying');
    // The next call comes a minute later: the flight ended at 1 + TIMING.flight, not now.
    const later = advance(a, moved, 61);
    expect(later.mode === 'orbiting' || later.mode === 'scanning').toBe(true);
    expect(later.bodyId).toBe('b-europa');
    expect(later.flight).toBeUndefined();
  });

  it('a flight is not interrupted by an activity or completion; those wait for the arrival', () => {
    let a = createActor('a-wait', working, 0);
    a = advance(a, { ...working, bodyId: 'b-io' }, 1);
    const during = advance(a, { ...working, bodyId: 'b-io', archetype: 'building' }, 2);
    expect(during.mode).toBe('flying');
    expect(advance(a, { ...working, bodyId: 'b-io', landed: true }, 2).mode).toBe('flying');
    const after = advance(during, { ...working, bodyId: 'b-io', archetype: 'building' }, 5);
    expect(after.mode).toBe('building');
  });

  it('a new destination mid-flight retargets it from there', () => {
    let a = createActor('a-re', idle, 0);
    a = advance(a, { ...idle, bodyId: 'b-io' }, 1);
    a = advance(a, { ...idle, bodyId: 'b-titan' }, 2);
    expect(a.mode).toBe('flying');
    expect(a.flight).toMatchObject({ fromBodyId: 'b-io', toBodyId: 'b-titan', start: 2 });
    expect(advance(a, { ...idle, bodyId: 'b-titan' }, 2 + TIMING.flight).bodyId).toBe('b-titan');
  });
});

describe('landing', () => {
  it('lands over TIMING.landing, stays landed, and takes off when reopened', () => {
    let a = createActor('a-land', working, 0);
    const done = { ...working, landed: true };
    a = advance(a, done, 3);
    expect(a.mode).toBe('landing');
    expect(sampleActor(a, 3 + TIMING.landing / 2).landing).toBeCloseTo(0.5);
    a = advance(a, done, 3 + TIMING.landing);
    expect(a.mode).toBe('landed');
    expect(sampleActor(a, 100).landing).toBe(1);
    expect(advance(a, done, 100)).toBe(a);
    const reopened = advance(a, working, 101);
    expect(reopened.mode).toBe('orbiting');
  });

  it('a move after landing re-creates it landed on the new body (no flight, no landing)', () => {
    let a = createActor('a-l2', { ...idle, landed: true }, 0);
    a = advance(a, { ...idle, bodyId: 'b-io', landed: true }, 1);
    expect(a).toMatchObject({ mode: 'landed', bodyId: 'b-io', flight: undefined });
    expect(sampleActor(a, 1).landing).toBe(1);
    // A move that also reopens the work flies it, as any move does.
    expect(advance(a, { ...idle, bodyId: 'b-titan' }, 2).mode).toBe('flying');
  });
});

describe('activity archetypes (the P4-03 input)', () => {
  it('a working agent with an archetype takes it; switching changes it within one call', () => {
    let a = createActor('a-arch', working, 0);
    a = advance(a, { ...working, archetype: 'gathering' }, 1);
    expect(a.mode).toBe('gathering');
    expect(a.tween).toEqual({ from: 'orbiting', start: 1, duration: TIMING.modeTween });
    a = advance(a, { ...working, archetype: 'transporting' }, 1.2);
    expect(a.mode).toBe('transporting');
    expect(sampleActor(a, 1.2 + TIMING.modeTween / 2).blend).toBeCloseTo(0.5);
    a = advance(a, working, 2);
    expect(a.mode).toBe('orbiting');
  });

  it('an archetype is ignored while the agent is not working', () => {
    const a = createActor('a-arch2', idle, 0);
    expect(advance(a, { ...idle, archetype: 'building' }, 1).mode).toBe('orbiting');
  });
});

describe('reduced motion', () => {
  it('never scans; flights, landings and blends are instant', () => {
    const opts = { reducedMotion: true };
    const { modes } = run(createActor('a-rm', working, 0), working, 0, 60, 1 / 10, true);
    expect(modes).toEqual(['orbiting']);
    let a = createActor('a-rm', working, 0);
    a = advance(a, { ...working, bodyId: 'b-io' }, 1, opts);
    expect(a.mode).toBe('orbiting');
    expect(a.bodyId).toBe('b-io');
    a = advance(a, { ...working, bodyId: 'b-io', landed: true }, 2, opts);
    expect(a.mode).toBe('landed');
    a = advance(a, { ...working, bodyId: 'b-io', archetype: 'building' }, 3, opts);
    expect(a.mode).toBe('building');
    expect(sampleActor(a, 3).blend).toBe(1);
  });

  it('a scan running when reduced motion turns on ends at once', () => {
    let a = createActor('a-rm2', working, 0);
    a = advance(a, working, a.nextScanAt);
    expect(a.mode).toBe('scanning');
    expect(advance(a, working, a.nextScanAt + 0.1, { reducedMotion: true }).mode).toBe('orbiting');
  });

  it('a flight or landing running when reduced motion turns on ends at once', () => {
    let a = createActor('a-rm3', idle, 0);
    a = advance(a, { ...idle, bodyId: 'b-io' }, 1);
    expect(a.mode).toBe('flying');
    a = advance(a, { ...idle, bodyId: 'b-io' }, 1.2, { reducedMotion: true });
    expect(a.mode).toBe('orbiting');
    expect(a.bodyId).toBe('b-io');
    expect(a.tween.start).toBe(1.2); // arrived when asked, not at the flight's planned end
    a = advance(a, { ...idle, bodyId: 'b-io', landed: true }, 2);
    expect(a.mode).toBe('landing');
    a = advance(a, { ...idle, bodyId: 'b-io', landed: true }, 2.1, { reducedMotion: true });
    expect(a.mode).toBe('landed');
  });
});

describe('helpers', () => {
  it('easeInOut is monotonic from 0 to 1 and clamps', () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(2)).toBe(1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(easeInOut(t)).toBeGreaterThanOrEqual(last);
      last = easeInOut(t);
    }
  });

  it('scan intervals stay within TIMING.scanEvery', () => {
    for (let n = 0; n < 50; n++) {
      const s = scanInterval(hashId('a-int'), n);
      expect(s).toBeGreaterThanOrEqual(TIMING.scanEvery[0]);
      expect(s).toBeLessThan(TIMING.scanEvery[1]);
    }
  });
});
