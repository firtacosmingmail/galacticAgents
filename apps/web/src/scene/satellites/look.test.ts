import { describe, expect, it } from 'vitest';
import { AgentState, ENDED_STATES } from '@galactic/protocol';
import {
  BEAM,
  beamTint,
  LEGEND_STATES,
  linearRgb,
  luminance,
  pulseAt,
  ROLE_COLOR,
  SATELLITE_LOOK,
  satelliteBrightness,
  satelliteOrbitRate,
  satelliteScale,
  satelliteTint,
  STATE_LOOK,
  WAITING_AMBER,
} from './look.js';

const STATES = AgentState.options;
const LIVE = STATES.filter((s) => !ENDED_STATES.has(s));
/** The states a satellite shows today: every live one, and `failed` (keepFailed). */
const SHOWN = [...LIVE, 'failed'] as const;

const brightnessOver = (state: AgentState, agentId = 'a-1', reduced = false, seconds = 10) => {
  const values: number[] = [];
  for (let t = 0; t < seconds; t += 0.02)
    values.push(satelliteBrightness({ role: 'steward', state, agentId }, undefined, t, reduced));
  return values;
};

describe('state → look table (P4-02)', () => {
  it('has a complete entry for every StatusRecord state', () => {
    expect(Object.keys(STATE_LOOK).sort()).toEqual([...STATES].sort());
    for (const state of STATES) {
      const look = STATE_LOOK[state];
      expect(look.color === ROLE_COLOR || /^#[0-9a-f]{6}$/i.test(look.color)).toBe(true);
      expect(look.level).toBeGreaterThan(0);
      expect(look.still).toBeGreaterThan(0);
      expect(look.scale).toBeGreaterThan(0);
      expect(look.orbitRate).toBeGreaterThanOrEqual(0);
      expect(look.label.length).toBeGreaterThan(0);
      for (const role of ['harmonizer', 'waykeeper', 'steward'] as const)
        expect(satelliteTint({ role, state })).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('the legend explains every state a satellite shows (but starting, drawn as working)', () => {
    for (const state of SHOWN) if (state !== 'starting') expect(LEGEND_STATES).toContain(state);
  });

  it('working keeps the role colours (decision 68: Waykeeper warmer, Steward cooler)', () => {
    expect(satelliteTint({ role: 'waykeeper', state: 'working' })).toBe(
      SATELLITE_LOOK.waykeeper.color,
    );
    expect(satelliteTint({ role: 'steward', state: 'working' })).toBe(SATELLITE_LOOK.steward.color);
  });

  it('waiting for input is the panel’s amber, used by no other state or role, and the loudest', () => {
    expect(satelliteTint({ role: 'steward', state: 'waiting_for_input' })).toBe(WAITING_AMBER);
    expect(WAITING_AMBER).toBe('#ffb547'); // panel.css --pnl-beacon, labels.css
    for (const state of STATES) {
      if (state === 'waiting_for_input') continue;
      for (const role of ['harmonizer', 'waykeeper', 'steward'] as const)
        expect(satelliteTint({ role, state })).not.toBe(WAITING_AMBER);
    }
    const waitingPeak = Math.max(...brightnessOver('waiting_for_input'));
    for (const state of SHOWN) {
      if (state === 'waiting_for_input') continue;
      expect(Math.max(...brightnessOver(state))).toBeLessThan(waitingPeak);
      expect(satelliteScale({ state })).toBeLessThan(
        satelliteScale({ state: 'waiting_for_input' }),
      );
      expect(STATE_LOOK[state].still).toBeLessThan(STATE_LOOK.waiting_for_input.still);
    }
  });

  it('colour is never the only cue: every shown state differs from every other by pulse, size or motion', () => {
    const cue = (s: AgentState) => {
      const l = STATE_LOOK[s];
      return `${l.pulse}|${l.scale}|${l.orbitRate}|${l.level}`;
    };
    const shown = SHOWN.filter((s) => s !== 'starting');
    expect(new Set(shown.map(cue)).size).toBe(shown.length);
  });

  it('under reduced motion, the problem states still differ by size or brightness alone', () => {
    const still = (s: AgentState) => `${STATE_LOOK[s].scale}|${STATE_LOOK[s].still}`;
    const shown = ['working', 'failed', 'waiting_for_input', 'stalled', 'paused', 'idle'] as const;
    for (const s of shown) for (const t of shown) if (s !== t) expect(still(s)).not.toBe(still(t));
  });

  it('every problem state differs from working in still brightness or size (no pulse to tell)', () => {
    const working = STATE_LOOK.working;
    for (const s of ['waiting_for_input', 'stalled', 'failed', 'paused'] as const) {
      const look = STATE_LOOK[s];
      const apart =
        Math.abs(look.still - working.still) >= 0.2 || Math.abs(look.scale - working.scale) >= 0.1;
      expect(apart, s).toBe(true);
    }
  });

  it('paused holds still, failed drifts, the others orbit at full speed', () => {
    expect(satelliteOrbitRate({ state: 'paused' })).toBe(0);
    expect(satelliteOrbitRate({ state: 'failed' })).toBeGreaterThan(0);
    expect(satelliteOrbitRate({ state: 'failed' })).toBeLessThan(0.5);
    for (const s of ['working', 'waiting_for_input', 'idle', 'stalled', 'starting'] as const)
      expect(satelliteOrbitRate({ state: s })).toBe(1);
  });
});

describe('pulses', () => {
  it('pulsing states vary over time; steady ones do not', () => {
    for (const state of STATES) {
      const values = brightnessOver(state);
      const spread = Math.max(...values) - Math.min(...values);
      if (STATE_LOOK[state].pulse === 'steady') expect(spread).toBe(0);
      else expect(spread).toBeGreaterThan(0.25);
    }
  });

  it('reduced motion: no pulse at all, the state’s still level', () => {
    for (const state of STATES) {
      const values = brightnessOver(state, 'a-1', true);
      expect(new Set(values).size).toBe(1);
      expect(values[0]).toBe(STATE_LOOK[state].still);
    }
  });

  it('blink is synchronised across agents (one alarm); breathing is not', () => {
    for (let t = 0; t < 4; t += 0.1)
      expect(pulseAt('blink', t, 1)).toBe(pulseAt('blink', t, 987654));
    const a = brightnessOver('working', 'a-1');
    const b = brightnessOver('working', 'a-2');
    expect(a.some((v, i) => Math.abs(v - (b[i] ?? 0)) > 0.05)).toBe(true);
  });

  it('blink is a firm on/off at 1.6 s: dim for part of each period, blooming for part', () => {
    const values = brightnessOver('waiting_for_input', 'a-1', false, 1.6);
    expect(Math.min(...values)).toBeLessThan(0.5);
    expect(Math.max(...values)).toBeGreaterThan(1.4);
    expect(pulseAt('blink', 0)).toBeCloseTo(pulseAt('blink', 1.6), 9);
  });

  it('failed flickers: mostly at its level, sometimes dark; deterministic per agent', () => {
    const values = brightnessOver('failed', 'a-9', false, 20);
    const dark = values.filter((v) => v < STATE_LOOK.failed.level * 0.5).length / values.length;
    expect(dark).toBeGreaterThan(0.03);
    expect(dark).toBeLessThan(0.3);
    expect(brightnessOver('failed', 'a-9', false, 20)).toEqual(values);
  });
});

describe('beam tint', () => {
  it('cyan while working; a fading beam takes the state colour at the same luminance', () => {
    expect(beamTint({ role: 'steward', state: 'working' })).toBe(BEAM.color);
    const amber = beamTint({ role: 'steward', state: 'waiting_for_input' });
    expect(luminance(amber as [number, number, number])).toBeCloseTo(luminance(BEAM.color), 6);
    expect(amber[0]).toBeGreaterThan(amber[2]);
  });

  it('is one cached tuple per role and state (no allocation per frame)', () => {
    for (const role of ['steward', 'waykeeper', 'harmonizer'] as const)
      for (const state of STATES) expect(beamTint({ role, state })).toBe(beamTint({ role, state }));
    // The role colour is per role: a finished Waykeeper's fading beam is not a Steward's.
    expect(beamTint({ role: 'waykeeper', state: 'finished' })).not.toEqual(
      beamTint({ role: 'steward', state: 'finished' }),
    );
  });

  it('linearRgb matches the sRGB transfer', () => {
    expect(linearRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(linearRgb('#000000')).toEqual([0, 0, 0]);
    expect(linearRgb('#808080')[0]).toBeCloseTo(0.2159, 3);
  });
});
