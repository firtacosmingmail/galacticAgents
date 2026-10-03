import { describe, expect, it } from 'vitest';
import {
  HARMONIZER,
  locationFromPath,
  parseSelectionKey,
  pathFor,
  selectionKey,
  type PageLocation,
} from './selection.js';

describe('selection model (P25-02)', () => {
  it('round-trips the compact keys', () => {
    expect(selectionKey(HARMONIZER)).toBe('harmonizer');
    expect(selectionKey({ kind: 'waykeeper', id: 'a-1' })).toBe('waykeeper:a-1');
    expect(parseSelectionKey('steward:a-2')).toEqual({ kind: 'steward', id: 'a-2' });
    expect(parseSelectionKey('harmonizer')).toEqual(HARMONIZER);
    expect(parseSelectionKey('planet:x')).toBeUndefined();
  });

  it('maps locations to URLs and back', () => {
    const cases: [PageLocation, string][] = [
      [{ route: 'panel', selection: HARMONIZER }, '/'],
      [{ route: 'panel', selection: { kind: 'waykeeper', id: 'a-1' } }, '/waykeeper/a-1'],
      [{ route: 'panel', selection: { kind: 'steward', id: 'a b/c' } }, '/steward/a%20b%2Fc'],
      [{ route: 'debug', selection: HARMONIZER }, '/debug'],
      [{ route: 'settings', selection: HARMONIZER }, '/settings'],
    ];
    for (const [location, path] of cases) {
      expect(pathFor(location)).toBe(path);
      expect(locationFromPath(path)).toEqual(location);
    }
  });

  it('reads anything unrecognised as the panel with the Harmonizer', () => {
    for (const path of ['/nope', '/steward', '/steward/a/b', '/waykeeper/%E0%A4%A', ''])
      expect(locationFromPath(path)).toEqual({ route: 'panel', selection: HARMONIZER });
    expect(locationFromPath('/debug/')).toEqual({ route: 'debug', selection: HARMONIZER });
    expect(locationFromPath('/settings/')).toEqual({ route: 'settings', selection: HARMONIZER });
    expect(locationFromPath('/settings/x')).toEqual({ route: 'panel', selection: HARMONIZER });
  });
});
