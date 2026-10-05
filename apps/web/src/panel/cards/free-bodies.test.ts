import { describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { freeBodies } from './ProposalCard.js';

/**
 * P7-07 review: the edit form offers only the bodies the server would use — the same
 * `isCatalogued` rule as `domain/catalogue.ts` — never a demo, retired or orbit-less planet.
 */

const body = (id: string, over: Partial<Body> = {}): Body => ({
  id,
  kind: 'planet',
  name: id,
  meta: { orbit: 4 },
  ...over,
});

describe('the proposal card’s free bodies', () => {
  it('lists free catalogued bodies of the kind, by name', () => {
    const bodies = Object.fromEntries(
      [
        body('Venus', { meta: { orbit: 2 } }),
        body('Mars'),
        body('Phobos', { kind: 'moon', parentId: 'Mars', meta: { orbit: 1 } }),
        body('Earth', { meta: { orbit: 3, reserved: true } }),
        body('Jupiter', { host: { kind: 'project', id: 'p-1' } }),
        body('Demo planet 3', { meta: {} }),
        body('Flagged', { meta: { orbit: 7, demo: true } }),
        body('Retired', { meta: { orbit: 8, retired: true } }),
        body('Made up', { meta: {} }),
      ].map((b) => [b.id, b]),
    );
    expect(freeBodies({ bodies }, 'planet').map((b) => b.name)).toEqual(['Mars', 'Venus']);
    expect(freeBodies({ bodies }, 'moon').map((b) => b.name)).toEqual(['Phobos']);
    expect(freeBodies({ bodies }, 'asteroid')).toEqual([]);
  });
});
