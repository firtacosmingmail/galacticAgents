import { describe, expect, it } from 'vitest';
import { isCatalogued, isDemoBody, isDemoProject } from './dev.js';
import { isRetiredBody, type Body, type Project } from './domain.js';

/** P7-07 — which rows are seeded demo work, flagged or (made before the flag) by `/dev/seed`'s names. */

const planet = (over: Partial<Body> = {}): Body => ({
  id: 'b-x',
  kind: 'planet',
  name: 'Demo planet 1',
  ...over,
});
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p-x',
  name: 'Demo project 1',
  workspace: '/tmp/galactic-demo-1',
  bodyId: 'b-x',
  state: 'in_progress',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  ...over,
});

describe('isCatalogued', () => {
  it('is a seeded planet or moon (meta.orbit), never a demo, retired or orbit-less body', () => {
    expect(isCatalogued(planet({ name: 'Mars', meta: { orbit: 4 } }))).toBe(true);
    expect(
      isCatalogued(planet({ kind: 'moon', name: 'Phobos', parentId: 'b-mars', meta: { orbit: 1 } })),
    ).toBe(true);
    expect(isCatalogued(planet({ name: 'Mars' }))).toBe(false); // no orbit: made outside
    expect(isCatalogued(planet())).toBe(false); // a legacy demo planet
    expect(isCatalogued(planet({ name: 'X', meta: { orbit: 9, demo: true } }))).toBe(false);
    expect(isCatalogued(planet({ name: 'Mars', meta: { orbit: 4, retired: true } }))).toBe(false);
  });
});

describe('isDemoBody', () => {
  it('takes a flagged body, and a legacy orbit-less "Demo planet n"', () => {
    expect(isDemoBody(planet({ name: 'Anything', meta: { demo: true } }))).toBe(true);
    expect(isDemoBody(planet())).toBe(true);
    expect(isDemoBody(planet({ name: 'Demo planet 12' }))).toBe(true);
  });

  it('never takes a catalogue body, a moon, a reserved body or another name', () => {
    expect(isDemoBody(planet({ meta: { orbit: 4 } }))).toBe(false);
    expect(isDemoBody(planet({ meta: { reserved: true } }))).toBe(false);
    expect(isDemoBody(planet({ kind: 'moon', parentId: 'b-mars' }))).toBe(false);
    expect(isDemoBody(planet({ kind: 'asteroid' }))).toBe(false);
    expect(isDemoBody(planet({ name: 'Mars' }))).toBe(false);
    expect(isDemoBody(planet({ name: 'Demo planet' }))).toBe(false);
    expect(isDemoBody(planet({ name: 'My Demo planet 1' }))).toBe(false);
  });

  it('isRetiredBody reads `meta.retired`', () => {
    expect(isRetiredBody(planet({ meta: { demo: true, retired: true } }))).toBe(true);
    expect(isRetiredBody(planet())).toBe(false);
  });
});

describe('isDemoProject', () => {
  it('takes a flagged project, and a legacy "Demo project n" in /tmp/galactic-demo-n', () => {
    expect(isDemoProject(project({ name: 'X', workspace: '/w', meta: { demo: true } }))).toBe(true);
    expect(isDemoProject(project())).toBe(true);
  });

  it('never takes real work or a harness project', () => {
    expect(isDemoProject(project({ workspace: '/Users/me/demo' }))).toBe(false);
    expect(isDemoProject(project({ name: 'csv2parquet' }))).toBe(false);
    expect(isDemoProject(project({ meta: { harness: true } }))).toBe(false);
    expect(isDemoProject(project({ meta: { harness: true, demo: true } }))).toBe(false);
  });
});
