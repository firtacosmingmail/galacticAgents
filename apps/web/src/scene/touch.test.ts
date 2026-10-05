// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPhone,
  isSlowConnection,
  isSmallScreen,
  listModeReason,
  liveProbe,
  COARSE_POINTER_QUERY,
  SMALL_SCREEN_QUERY,
  type DeviceProbe,
} from './device.js';
import {
  automaticTier,
  DEVICE_TIER_KEY,
  effectiveTier,
  readDeviceTier,
  writeDeviceTier,
} from './device-tier.js';
import { readSceneChoice, readSceneVisible, SCENE_VISIBLE_KEY } from './visibility.js';
import { blockPageGestures } from './camera/CameraRig.js';
import {
  CLEAR_TARGET_PX,
  pickBodies,
  pickSlop,
  POINTER_SLOP,
  TOUCH_SLOP,
  type PickRay,
} from './picking/pick.js';
import { pickScene } from './picking/scene-pick.js';
import { beaconUnder, type BeaconFrame } from './beacons/registry.js';
import { taskMarkerHit, type TaskMarkerFrame } from './detail/overlay/task-registry.js';
import { ClickTracker, TAP_SLOP_PX } from './picking/click.js';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** A probe: `queries` that match, a viewport, a connection. */
function probe(
  queries: string[],
  width: number,
  height: number,
  connection?: DeviceProbe['connection'],
): DeviceProbe {
  return { matches: (q) => queries.includes(q), viewport: { width, height }, connection };
}

const IPHONE = probe([COARSE_POINTER_QUERY, SMALL_SCREEN_QUERY], 390, 844);
const IPHONE_LANDSCAPE = probe([COARSE_POINTER_QUERY], 844, 390);
const IPAD = probe([COARSE_POINTER_QUERY], 1024, 1366);
const MAC = probe([], 1440, 900);
const NARROW_MAC_WINDOW = probe([SMALL_SCREEN_QUERY], 700, 900);

describe('device detection (P7-03)', () => {
  it('a phone is a coarse pointer on a phone-sized viewport, in either orientation', () => {
    expect(isPhone(IPHONE)).toBe(true);
    expect(isPhone(IPHONE_LANDSCAPE)).toBe(true);
    expect(isPhone(IPAD)).toBe(false);
    expect(isPhone(MAC)).toBe(false);
    // A narrow desktop window is small, not a phone.
    expect(isPhone(NARROW_MAC_WINDOW)).toBe(false);
    expect(isSmallScreen(NARROW_MAC_WINDOW)).toBe(true);
  });

  it('a slow connection is data saver or 3G and slower; unknown is not slow', () => {
    expect(isSlowConnection(probe([], 1440, 900, { saveData: true }))).toBe(true);
    for (const t of ['slow-2g', '2g', '3g'])
      expect(isSlowConnection(probe([], 1440, 900, { effectiveType: t }))).toBe(true);
    expect(isSlowConnection(probe([], 1440, 900, { effectiveType: '4g' }))).toBe(false);
    expect(isSlowConnection(probe([], 1440, 900, {}))).toBe(false);
    expect(isSlowConnection(MAC)).toBe(false); // Safari: no `navigator.connection`
  });

  it('never calls a page served from this machine slow (P7-03 review)', () => {
    const slow = { effectiveType: '2g', saveData: true };
    for (const hostname of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
      const local = { ...probe([], 1440, 900, slow), hostname };
      expect(isSlowConnection(local), hostname).toBe(false);
      expect(listModeReason(local), hostname).toBeUndefined();
    }
    for (const hostname of ['mymac.tail1234.ts.net', '192.168.1.10', '127.example.com']) {
      expect(isSlowConnection({ ...probe([], 1440, 900, slow), hostname }), hostname).toBe(true);
    }
  });

  it('starts in list mode on a small screen or a slow connection, the connection named first', () => {
    expect(listModeReason(MAC)).toBeUndefined();
    expect(listModeReason(IPAD)).toBeUndefined();
    expect(listModeReason(IPHONE)).toBe('small-screen');
    expect(listModeReason(probe([], 1440, 900, { effectiveType: '2g' }))).toBe('slow-connection');
    expect(listModeReason(probe([SMALL_SCREEN_QUERY], 390, 844, { saveData: true }))).toBe(
      'slow-connection',
    );
  });

  it('the live probe reads matchMedia, the window and navigator.connection', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === COARSE_POINTER_QUERY }));
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), { connection: { effectiveType: '3g' } }),
    );
    const live = liveProbe();
    expect(live.matches(COARSE_POINTER_QUERY)).toBe(true);
    expect(live.viewport).toEqual({ width: 390, height: 844 });
    expect(live.connection).toEqual({ effectiveType: '3g' });
    expect(live.hostname).toBe(window.location.hostname);
    expect(isPhone()).toBe(true);
    // jsdom's page is on localhost: never slow (a remote page with this connection is).
    expect(isSlowConnection()).toBe(window.location.hostname !== 'localhost');
    expect(isSlowConnection({ ...live, hostname: 'mymac.tail1234.ts.net' })).toBe(true);
  });
});

describe('the scene starts hidden on phones until the user chooses (P7-03)', () => {
  it('follows the device with no choice, the choice once made', () => {
    expect(readSceneChoice()).toBeUndefined();
    expect(readSceneVisible(MAC)).toBe(true);
    expect(readSceneVisible(IPHONE)).toBe(false);
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    expect(readSceneVisible(IPHONE)).toBe(true);
    localStorage.setItem(SCENE_VISIBLE_KEY, '0');
    expect(readSceneVisible(MAC)).toBe(false);
  });
});

describe('the quality tier per device (P7-03)', () => {
  it('is the server tier by default, mobile on a phone, the device choice above both', () => {
    expect(automaticTier('high', MAC)).toBe('high');
    expect(automaticTier('high', IPHONE)).toBe('mobile');
    expect(automaticTier('high', IPAD)).toBe('high');
    expect(automaticTier(undefined, MAC)).toBeUndefined();
    expect(effectiveTier('high', 'balanced', IPHONE)).toBe('balanced');
    expect(effectiveTier('mobile', 'high', MAC)).toBe('high');
    expect(effectiveTier('balanced', undefined, MAC)).toBe('balanced');
  });

  it('remembers the device choice in this browser; Automatic clears it; junk is ignored', () => {
    expect(readDeviceTier()).toBeUndefined();
    writeDeviceTier('mobile');
    expect(localStorage.getItem(DEVICE_TIER_KEY)).toBe('mobile');
    expect(readDeviceTier()).toBe('mobile');
    writeDeviceTier(undefined);
    expect(localStorage.getItem(DEVICE_TIER_KEY)).toBeNull();
    localStorage.setItem(DEVICE_TIER_KEY, 'ultra');
    expect(readDeviceTier()).toBeUndefined();
  });
});

describe('no page zoom under the scene (P7-03)', () => {
  it("cancels iOS's gesture events on the controls' element, until cleaned up", () => {
    const el = document.createElement('div');
    const stop = blockPageGestures(el);
    const fire = (type: string) => {
      const e = new Event(type, { cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire('gesturestart')).toBe(true);
    expect(fire('gesturechange')).toBe(true);
    stop();
    expect(fire('gesturestart')).toBe(false);
  });
});

describe('a tap vs a drag (P3-05, verified for touch in P7-03)', () => {
  it('a finger may wander TAP_SLOP_PX; a second finger makes it a pinch', () => {
    const t = new ClickTracker();
    t.down({ pointerId: 1, button: 0, x: 0, y: 0, at: 0, pointerType: 'touch' });
    expect(t.up({ pointerId: 1, x: TAP_SLOP_PX, y: 0, at: 100 })).toBe(true);
    t.down({ pointerId: 1, button: 0, x: 0, y: 0, at: 0, pointerType: 'touch' });
    expect(t.up({ pointerId: 1, x: TAP_SLOP_PX + 1, y: 0, at: 100 })).toBe(false);
    t.down({ pointerId: 1, button: 0, x: 0, y: 0, at: 0, pointerType: 'touch' });
    t.down({ pointerId: 2, button: 0, x: 50, y: 0, at: 10, pointerType: 'touch' });
    expect(t.up({ pointerId: 1, x: 0, y: 0, at: 100 })).toBe(false);
  });
});

// The camera at z = 100 looking down -z; 1000 px per unit at distance 1: 10 px per unit at z = 0.
function rayThrough(x: number, y: number): PickRay {
  const len = Math.hypot(x, y, -100);
  return { origin: [0, 0, 100], direction: [x / len, y / len, -100 / len] };
}
const PX = 1000;

describe('touch-sized hit slop (P7-03)', () => {
  it('a finger gets the touch slop, a mouse or a pen the pointer one', () => {
    expect(pickSlop('touch')).toBe(TOUCH_SLOP);
    expect(pickSlop('mouse')).toBe(POINTER_SLOP);
    expect(pickSlop('pen')).toBe(POINTER_SLOP);
    expect(pickSlop(undefined)).toBe(POINTER_SLOP);
    expect(TOUCH_SLOP.minTargetPx).toBeGreaterThan(CLEAR_TARGET_PX);
  });

  it('a tap 14 px off a speck of an asteroid still finds it; a click there does not', () => {
    const speck = [{ bodyId: 'b-ast', center: [0, 0, 0] as [number, number, number], radius: 0.1 }];
    // 14 px from the 1 px speck: past a mouse's target + cluster (12 px), inside a finger's (24).
    const at = rayThrough(1.4, 0);
    expect(pickBodies(at, speck, PX).choice).toBeUndefined();
    expect(pickBodies(at, speck, PX, TOUCH_SLOP).choice).toBe('b-ast');
    // Too far even for a finger.
    expect(pickBodies(rayThrough(3, 0), speck, PX, TOUCH_SLOP).choice).toBeUndefined();
  });

  it('two specks inside one fingertip make a "what\'s here" list, never a guess', () => {
    const specks = [
      { bodyId: 'b-a', center: [0, 0, 0] as [number, number, number], radius: 0.1 },
      { bodyId: 'b-b', center: [2, 0, 0] as [number, number, number], radius: 0.1 },
    ];
    const tap = pickBodies(rayThrough(1, 0), specks, PX, TOUCH_SLOP);
    expect(tap.choice).toBeUndefined();
    expect(tap.candidates.map((c) => c.bodyId).sort()).toEqual(['b-a', 'b-b']);
  });

  it('a satellite gets the larger target too', () => {
    const sat = [{ agentId: 'a-1', center: [0, 0, 0] as [number, number, number], radius: 0.1 }];
    const at = rayThrough(1.2, 0);
    expect(pickScene(at, [], sat, PX).choice).toBeUndefined();
    expect(pickScene(at, [], sat, PX, TOUCH_SLOP).choice).toEqual({
      kind: 'satellite',
      agentId: 'a-1',
    });
  });

  it("a beacon's and a task marker's targets get the finger's floor", () => {
    // perPx 1/10: 22 px off = 2.2 units at depth 100.
    const beacon: BeaconFrame = {
      questionId: 'q-1',
      bodyId: 'b-mars',
      visible: true,
      center: [0, 0, 0],
      perPx: 0.1,
    };
    expect(beaconUnder(rayThrough(2.2, 0), [beacon])).toBeUndefined();
    expect(beaconUnder(rayThrough(2.2, 0), [beacon], TOUCH_SLOP.beaconPx)?.questionId).toBe('q-1');
    const marker: TaskMarkerFrame = {
      taskId: 't-1',
      bodyId: 'b-mars',
      visible: true,
      center: [0, 0, 0],
      radius: 0.1,
      occluder: 0,
    };
    expect(taskMarkerHit(rayThrough(1.4, 0), PX, [], [marker])).toBeUndefined();
    expect(taskMarkerHit(rayThrough(1.4, 0), PX, [], [marker], TOUCH_SLOP.markerPx)?.frame).toBe(
      marker,
    );
  });
});
