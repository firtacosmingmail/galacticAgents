import { describe, expect, it } from 'vitest';
import type { DeliverableListItem, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import {
  canonicalWorkspace,
  canPreview,
  clientRules,
  groupForProject,
  imageTypeOf,
  languageOf,
  missingText,
  orderOwn,
  rebase,
  rowActions,
  runStateText,
  safeLink,
  skippedOf,
  skippedText,
  whereText,
} from './deliverables-model.js';

/** P9-09 — the deliverables views' pure model (SPEC §4.7, decisions 124–126, 131, 134). */

const WS = '/w/app';
const at = (m: number) => `2026-10-08T10:${String(m).padStart(2, '0')}:00.000Z`;

function row(over: Partial<DeliverableListItem> & Pick<DeliverableListItem, 'id'>) {
  return {
    projectId: 'p-1',
    kind: 'file',
    title: over.id,
    source: 'user',
    addedBy: { type: 'user' },
    location: { storage: 'in_place', path: `${WS}/${over.id}.txt` },
    version: 1,
    createdAt: at(0),
    updatedAt: at(0),
    facts: { exists: true, size: 10, kindGuess: 'text', contentType: 'text/plain' },
    ...over,
  } as DeliverableListItem;
}

const MAC = clientRules({ loopback: true, desktop: false, writable: 'all' });
const PHONE = clientRules({ loopback: false, desktop: false, writable: 'limited' });
const PHONE_AUTO = clientRules({ loopback: false, desktop: false, writable: 'all' });
const DESKTOP = clientRules({ loopback: true, desktop: true, writable: 'all' });

describe('the client rules (decisions 51, 131, 134)', () => {
  it('opens on the Mac only, edits as the server says, downloads outside the desktop app', () => {
    expect(MAC).toEqual({ local: true, download: true, edit: true, addOutside: true });
    expect(PHONE).toEqual({ local: false, download: true, edit: false, addOutside: false });
    // autoApproveRemote lifts edits, never opening nor adding from outside the project.
    expect(PHONE_AUTO).toEqual({ local: false, download: true, edit: true, addOutside: false });
    expect(DESKTOP).toMatchObject({ local: true, download: false });
    // Without the settings: the Mac's own page edits, nobody else.
    expect(clientRules({ loopback: false, desktop: false, writable: undefined }).edit).toBe(false);
    expect(clientRules({ loopback: true, desktop: false, writable: undefined }).edit).toBe(true);
  });
});

describe('grouping and ordering (decision 124)', () => {
  it("puts the project's own first — folder, commands by importance, then declared, newest first", () => {
    const own = orderOwn([
      row({ id: 'notes', createdAt: at(1) }),
      row({ id: 'build', kind: 'command', source: 'detected', meta: { important: 4 } }),
      row({ id: 'spec', createdAt: at(5) }),
      row({ id: 'folder', kind: 'folder', source: 'detected', detectedKey: 'folder' }),
      row({ id: 'lint', kind: 'command', source: 'detected', detectedKey: 'package.json#lint' }),
      row({ id: 'dev', kind: 'command', source: 'detected', meta: { important: 0 } }),
    ]);
    expect(own.map((d) => d.id)).toEqual(['folder', 'dev', 'build', 'lint', 'spec', 'notes']);
  });

  it("groups the tasks' rows by task, newest task first, rows newest first", () => {
    const tasks: Record<string, Task> = {
      't-old': { ...fx.task, id: 't-old', description: 'old task', createdAt: at(1) },
      't-new': { ...fx.task, id: 't-new', description: 'new task', createdAt: at(9) },
    };
    const groups = groupForProject(
      [
        row({ id: 'a', taskId: 't-old', createdAt: at(20) }),
        row({ id: 'b', taskId: 't-new', createdAt: at(11) }),
        row({ id: 'c', taskId: 't-new', createdAt: at(12) }),
        row({ id: 'own' }),
        // A task the world does not know (moved away since): by its newest row, its id as label.
        row({ id: 'd', taskId: 't-gone', createdAt: at(5) }),
      ],
      { tasks },
    );
    expect(groups.own.map((d) => d.id)).toEqual(['own']);
    expect(groups.tasks.map((g) => [g.label, g.rows.map((d) => d.id)])).toEqual([
      ['new task', ['c', 'b']],
      ['t-gone', ['d']],
      ['old task', ['a']],
    ]);
  });
});

describe('the words of a row', () => {
  it('says where it is: project folder, deliverables folder, worktree, a command folder, missing', () => {
    const places = { workspace: WS, worktree: `${WS}/.galactic/worktrees/t-1` };
    expect(whereText(row({ id: 'r' }), places)).toEqual({
      text: 'in the project folder',
      path: 'r.txt',
    });
    expect(
      whereText(
        row({ id: 'c', location: { storage: 'copy', path: `${WS}/deliverables/login/c.png` } }),
        places,
      ),
    ).toEqual({ text: 'in the deliverables folder', path: 'deliverables/login/c.png' });
    expect(
      whereText(
        row({
          id: 'w',
          location: { storage: 'worktree', path: `${WS}/.galactic/worktrees/t-1/out/w.png` },
        }),
        places,
      ),
    ).toEqual({ text: "in the task's worktree", path: 'out/w.png' });
    expect(
      whereText(
        row({ id: 'f', kind: 'folder', location: { storage: 'in_place', path: WS } }),
        places,
      ),
    ).toEqual({ text: 'the project folder' });
    expect(
      whereText(
        row({ id: 'cmd', kind: 'command', location: undefined, command: { line: 'x', cwd: WS } }),
        places,
      ),
    ).toEqual({ text: 'runs in the project folder' });
    expect(
      whereText(
        row({
          id: 'm',
          location: {
            storage: 'worktree',
            path: '/elsewhere/m.png',
            missing: { reason: 'it was in the task’s worktree: not enough space', at: at(0) },
          },
        }),
        places,
      ),
    ).toMatchObject({ path: '/elsewhere/m.png', missing: expect.stringContaining('not enough') });
    expect(whereText(row({ id: 'g', facts: { exists: false } }), places).missing).toBe(
      'not there any more (moved or deleted)',
    );
    expect(missingText({ exists: false, problem: 'outside' })).toBe(
      'it now points outside the project',
    );
  });

  it("lists what a copy left out (wave-2 review S1), counting what isn't listed", () => {
    const meta = {
      copy: {
        bytes: 10,
        skipped: [
          { path: '.env', reason: 'secret' },
          { path: 'keys/id_rsa', reason: 'secret' },
          { path: 'cache', reason: 'symlink' },
          { path: 'big', reason: 'hard_link' },
        ],
        skippedCount: 60,
      },
    };
    const skipped = skippedOf(meta)!;
    expect(skipped.count).toBe(60);
    expect(skippedText(skipped)).toBe(
      '60 entries left out: .env (secret), keys/id_rsa (secret), cache (link), and 57 more',
    );
    expect(skippedOf({ copy: { bytes: 1 } })).toBeUndefined();
    expect(skippedOf({ copy: { skipped: 'nonsense' } })).toBeUndefined();
    expect(skippedOf(undefined)).toBeUndefined();
  });

  it("says a command's state", () => {
    const base = { runId: 'r', startedAt: at(0), ports: [] as number[] };
    expect(runStateText(undefined)).toBe('not run yet');
    expect(runStateText({ ...base, state: 'running', ports: [5173, 24678] })).toBe(
      'running · :5173 :24678',
    );
    expect(runStateText({ ...base, state: 'ended', outcome: 'exited', exitCode: 1 })).toBe(
      'exited 1',
    );
    expect(
      runStateText({ ...base, state: 'ended', outcome: 'stopped', reason: 'server_restarted' }),
    ).toBe('stopped — Mission Control restarted');
    expect(runStateText({ ...base, state: 'ended', outcome: 'failed', signal: 'SIGKILL' })).toBe(
      'failed (SIGKILL)',
    );
  });
});

describe('the actions of a row (SPEC §4.7, decisions 125, 127, 128, 131, 134)', () => {
  it('a file: View, Open, Reveal, Download (+ Edit, Remove) on the Mac', () => {
    expect(rowActions(row({ id: 'r' }), MAC)).toEqual({
      actions: ['view', 'open', 'reveal', 'download', 'edit', 'remove'],
      macOnly: [],
    });
  });

  it('the phone views and downloads; opening is "on the Mac"; no edits without autoApproveRemote', () => {
    expect(rowActions(row({ id: 'r' }), PHONE)).toEqual({
      actions: ['view', 'download'],
      macOnly: ['open', 'reveal'],
    });
    expect(rowActions(row({ id: 'r' }), PHONE_AUTO).actions).toEqual([
      'view',
      'download',
      'edit',
      'remove',
    ]);
  });

  it('the desktop app offers no Download (decision 134)', () => {
    expect(rowActions(row({ id: 'r' }), DESKTOP).actions).not.toContain('download');
  });

  it('a folder opens in the IDE, an app with Open (confirmed), an address as a link', () => {
    const folder = row({ id: 'f', kind: 'folder', facts: { exists: true, isDirectory: true } });
    expect(rowActions(folder, MAC).actions).toEqual(['ide', 'reveal', 'edit', 'remove']);
    const app = row({ id: 'a', kind: 'app', facts: { exists: true, runsCode: true } });
    expect(rowActions(app, MAC).actions).toEqual(['app', 'reveal', 'edit', 'remove']);
    expect(rowActions(app, PHONE)).toEqual({ actions: [], macOnly: ['app', 'reveal'] });
    const url = row({ id: 'u', kind: 'url', location: undefined, url: 'https://example.com' });
    expect(rowActions(url, PHONE).actions).toEqual(['link']);
    const bad = row({ id: 'b', kind: 'url', location: undefined, url: 'javascript:alert(1)' });
    expect(rowActions(bad, PHONE).actions).toEqual([]);
  });

  it('a command offers no Run here (the runs are P9-10); a binary has no View but Open and Download', () => {
    const cmd = row({ id: 'c', kind: 'command', location: undefined, facts: undefined });
    expect(rowActions(cmd, MAC).actions).toEqual(['edit', 'remove']);
    const bin = row({ id: 'b', facts: { exists: true, size: 5e9, kindGuess: 'binary' } });
    expect(rowActions(bin, MAC).actions).toEqual(['open', 'reveal', 'download', 'edit', 'remove']);
    const pdf = row({ id: 'p', facts: { exists: true, kindGuess: 'pdf' } });
    expect(canPreview(pdf)).toBe(false);
    // A large text previews (its first 2 MiB); an image past 20 MiB does not.
    expect(
      canPreview(row({ id: 't', facts: { exists: true, size: 9e9, kindGuess: 'text' } })),
    ).toBe(true);
    expect(
      canPreview(
        row({ id: 'i', kind: 'image', facts: { exists: true, size: 21e6, kindGuess: 'image' } }),
      ),
    ).toBe(false);
  });

  it('a missing file keeps only its edits; a removed row offers Restore only', () => {
    const gone = row({ id: 'g', facts: { exists: false, problem: 'missing' } });
    expect(rowActions(gone, MAC).actions).toEqual(['edit', 'remove']);
    const removed = row({ id: 'r', removedAt: at(3), removedBy: { type: 'user' } });
    expect(rowActions(removed, MAC)).toEqual({ actions: ['restore'], macOnly: [] });
    expect(rowActions(removed, PHONE)).toEqual({ actions: [], macOnly: [] });
  });
});

describe('paths as the server wrote them (canonical)', () => {
  it('finds the canonical project folder and shows paths relative to it', () => {
    const own = row({
      id: 'f',
      kind: 'folder',
      source: 'detected',
      detectedKey: 'folder',
      location: { storage: 'in_place', path: '/private/tmp/p' },
    });
    expect(canonicalWorkspace([own], undefined, '/tmp/p')).toBe('/private/tmp/p');
    expect(canonicalWorkspace([], '/private/tmp/p/deliverables', '/tmp/p')).toBe('/private/tmp/p');
    expect(canonicalWorkspace([], undefined, '/tmp/p')).toBe('/tmp/p');
    expect(
      rebase({ workspace: '/tmp/p', worktree: '/tmp/p/.galactic/worktrees/t' }, '/private/tmp/p'),
    ).toEqual({
      workspace: '/private/tmp/p',
      worktree: '/private/tmp/p/.galactic/worktrees/t',
    });
    // macOS's /tmp, even without a hint from the rows.
    expect(
      whereText(row({ id: 'n', location: { storage: 'in_place', path: '/private/tmp/p/n.md' } }), {
        workspace: '/tmp/p',
      }),
    ).toEqual({ text: 'in the project folder', path: 'n.md' });
  });
});

describe('the viewer (decisions 125, 126)', () => {
  it('shows images of the allow-listed types only, never HTML', () => {
    expect(imageTypeOf('image/svg+xml')).toBe('image/svg+xml');
    expect(imageTypeOf('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(imageTypeOf('text/html')).toBeUndefined();
    expect(imageTypeOf('image/x-icon')).toBeUndefined();
  });

  it('picks the highlighter by the extension', () => {
    expect(languageOf('/w/src/app.tsx')).toBe('typescript');
    expect(languageOf('/w/index.html')).toBe('xml');
    expect(languageOf('/w/Makefile')).toBe('makefile');
    expect(languageOf('/w/notes')).toBeUndefined();
  });

  it('keeps only http(s) and mailto links in Markdown', () => {
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLink('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    expect(safeLink('JaVaScRiPt:alert(1)')).toBeUndefined();
    expect(safeLink('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeLink('docs/other.md')).toBeUndefined();
    expect(safeLink('#top')).toBeUndefined();
  });
});
