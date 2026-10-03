import { describe, expect, it } from 'vitest';
import type { AgentRole, AgentState } from '@galactic/protocol';
import {
  ArchetypeHold,
  classifyActivity,
  deriveArchetype,
  EDIT_WINDOW,
  HOLD,
  MANY_EDITS,
  type HoldInput,
} from './archetype.js';
import type { ActivityArchetype } from './machine.js';

/**
 * Real `currentActivity` lines: the server's `describeTool` (`"<Tool>: <detail>"`, detail = the
 * input's command / file_path / pattern / path / url), the fake adapter's scenarios and the Claude
 * SDK adapter's progress summaries, plus summariser-style sentences (TECHNOLOGY §4).
 */
const TABLE: readonly [string | undefined, ActivityArchetype | undefined][] = [
  // Gathering: reading and searching.
  ['Read: README.md', 'gathering'],
  ['Read: /Users/me/repo/src/session.ts', 'gathering'],
  ['Grep: TODO', 'gathering'],
  ['Grep: function\\s+describeTool', 'gathering'],
  ['Glob: src/**/*.test.ts', 'gathering'],
  ['LS: /Users/me/repo/apps', 'gathering'],
  ['WebFetch: https://threejs.org/docs/', 'gathering'],
  ['WebSearch', 'gathering'],
  ['NotebookRead: analysis.ipynb', 'gathering'],
  ['Bash: git status', 'gathering'],
  ['Bash: git diff --stat main', 'gathering'],
  ['Bash: git log --oneline -20', 'gathering'],
  ['Bash: ls -la src', 'gathering'],
  ['Bash: cat test/fixtures.json', 'gathering'],
  ['Bash: rg "useFrame" apps/web/src', 'gathering'],
  ['Bash: find . -name "*.ts" -path "*build*"', 'gathering'],
  ['Bash: cd apps/web && grep -rn archetype src', 'gathering'],
  ['mcp__github__get_issue', 'gathering'],
  ['mcp__linear__list_issues', 'gathering'],
  ['Reading the satellite director', 'gathering'],
  ['Searching for the status store', 'gathering'],
  ['Looking into the failing hover test', 'gathering'],
  ['Exploring the codebase', 'gathering'],
  ['Investigating why the beam washes out Jupiter', 'gathering'],
  // Transporting: producing output — an edit, a commit, a push, a PR, a report.
  ['Edit: src/index.ts', 'transporting'],
  ['Write: docs/tasks/notes/P4-03-archetypes.md', 'transporting'],
  ['MultiEdit: apps/web/src/scene/satellites/look.ts', 'transporting'],
  ['NotebookEdit: analysis.ipynb', 'transporting'],
  ['Editing src/session.ts', 'transporting'], // the protocol fixture
  ['Editing src/index.ts', 'transporting'], // the fake adapter's scenario
  ['Bash: git commit -m "P4-03: add archetypes"', 'transporting'],
  ['Bash: git add -A && git commit -m wip', 'transporting'],
  ['Bash: git push origin p4-03-archetypes', 'transporting'],
  ['Bash: gh pr create --fill', 'transporting'],
  ['mcp__github__create_pull_request', 'transporting'],
  ['mcp__slack__send_message', 'transporting'],
  ['Committing the changes', 'transporting'],
  ['Opening a PR for review', 'transporting'],
  ['Writing the summary for the Waykeeper', 'transporting'],
  ['Reporting back', 'transporting'],
  // Building: builds, tests, linters, installs, many files.
  ['Bash: pnpm test', 'building'],
  ['Bash: pnpm build && pnpm typecheck', 'building'],
  ['Bash: cd apps/web && pnpm vitest run src/scene', 'building'],
  ['Bash: npx tsc --noEmit -p .', 'building'],
  ['Bash: pnpm lint', 'building'],
  ['Bash: pnpm install --frozen-lockfile', 'building'],
  ['Bash: cargo test --workspace', 'building'],
  ['Bash: go test ./...', 'building'],
  ['Bash: make -j8', 'building'],
  ['Bash: ./gradlew assembleDebug', 'building'],
  ['Bash: pytest -q tests/', 'building'],
  ['Running tests', 'building'], // the fake adapter's scenario
  ['Running the full gates', 'building'],
  ['Refactoring auth module, 3 files edited, running tests', 'building'], // TECHNOLOGY §4
  ['Editing 5 files', 'building'],
  ['Updating several files', 'building'],
  ['Building the web app', 'building'],
  ['Type-checking the server', 'building'],
  ['Implementing the activity layer', 'building'],
  // Unclear: none (plain orbit and scan).
  [undefined, undefined],
  ['', undefined],
  ['TodoWrite', undefined],
  ['Task', undefined],
  ['ExitPlanMode', undefined],
  ['Bash: sleep 5', undefined],
  ['Bash: node scripts/seed.mjs', undefined],
  ['step 3 of 20', undefined], // the fake adapter's long scenario
  ['wrapping up', undefined],
  ['restarting claude after a crash (1/3)', undefined], // the SDK adapter
  ['Permission: Bash rm -rf dist', undefined],
  ['Question: Which database should the cache use?', undefined],
  ['Finished', undefined],
  ['Thinking about the approach', undefined],
];

describe('classifyActivity', () => {
  it.each(TABLE)('%j → %s', (activity, archetype) => {
    expect(classifyActivity(activity).archetype).toBe(archetype);
  });

  it('names the rule that matched, and the file an edit touched', () => {
    expect(classifyActivity('Edit: src/a.ts')).toEqual({
      archetype: 'transporting',
      rule: 'edit tool',
      edited: 'src/a.ts',
    });
    expect(classifyActivity('Editing src/index.ts').edited).toBe('src/index.ts');
    expect(classifyActivity('Bash: pnpm test').rule).toBe('build / test / lint');
    expect(classifyActivity('Read: x').edited).toBeUndefined();
  });
});

describe('deriveArchetype (the satellite-model hook)', () => {
  const status = (state: AgentState, currentActivity?: string) => ({ state, currentActivity });
  it('only working Stewards have one', () => {
    expect(deriveArchetype('steward', status('working', 'Read: a'))).toBe('gathering');
    for (const state of ['idle', 'waiting_for_input', 'paused', 'stalled', 'starting'] as const)
      expect(deriveArchetype('steward', status(state, 'Read: a'))).toBeUndefined();
    for (const role of ['waykeeper', 'harmonizer'] as const)
      expect(deriveArchetype(role, status('working', 'Bash: pnpm test'))).toBeUndefined();
  });
});

/** One Steward's spec at a given activity, as `satelliteList` builds it. */
function input(
  activity: string | undefined,
  state: AgentState = 'working',
  role: AgentRole = 'steward',
): HoldInput {
  return {
    agentId: 'a-s1',
    role,
    state,
    activity,
    archetype: deriveArchetype(role, { state, currentActivity: activity }),
  };
}

/** Drives a hold the way `useHeldArchetypes` does: on each change, and when a switch is due. */
class Harness {
  readonly hold = new ArchetypeHold();
  private spec: HoldInput = input(undefined);
  now = 0;
  set(activity: string | undefined, state: AgentState = 'working'): void {
    this.spec = input(activity, state);
    this.hold.apply([this.spec], this.now);
  }
  /** Advances the clock in small steps, re-applying at every due time; returns the shown history. */
  run(seconds: number, step = 0.05): { at: number; shown: ActivityArchetype | undefined }[] {
    const out: { at: number; shown: ActivityArchetype | undefined }[] = [];
    const end = this.now + seconds;
    while (this.now < end - 1e-9) {
      this.now = Math.min(end, this.now + step);
      const due = this.hold.nextDue();
      if (due !== undefined && due <= this.now) this.hold.apply([this.spec], this.now);
      out.push({ at: this.now, shown: this.shown });
    }
    return out;
  }
  get shown(): ActivityArchetype | undefined {
    return this.hold.shown('a-s1');
  }
}

const firstAt = (h: { at: number; shown: unknown }[], value: unknown) =>
  h.find((x) => x.shown === value)?.at;
const changes = (h: { shown: unknown }[]) =>
  h.reduce((n, x, i) => (i > 0 && x.shown !== h[i - 1]?.shown ? n + 1 : n), 0);

describe('ArchetypeHold', () => {
  it('a stable new activity shows within a second (the acceptance)', () => {
    const h = new Harness();
    h.set('Read: a.ts');
    const first = h.run(2);
    expect(firstAt(first, 'gathering')).toBeLessThanOrEqual(HOLD.confirm + 0.05);
    h.run(HOLD.minDwell); // the gathering has been on screen long enough
    const switchAt = h.now;
    h.set('Bash: pnpm test');
    const second = h.run(2);
    expect((firstAt(second, 'building') ?? Infinity) - switchAt).toBeLessThan(1);
  });

  it('never flickers: activities alternating every 0.2 s change what shows at most every dwell', () => {
    const h = new Harness();
    const lines = ['Read: a.ts', 'Bash: pnpm test', 'Edit: b.ts', 'TodoWrite'];
    const history: { at: number; shown: ActivityArchetype | undefined }[] = [];
    for (let i = 0; i < 100; i++) {
      h.set(lines[i % lines.length]);
      history.push(...h.run(0.2));
    }
    // 20 s of churn: nothing is confirmed (no line stays 0.4 s), so nothing shows at all.
    expect(changes(history)).toBe(0);
  });

  it('a change confirms only after it stays the latest; the shown one holds its dwell', () => {
    const h = new Harness();
    h.set('Read: a.ts');
    h.run(0.5);
    expect(h.shown).toBe('gathering');
    h.set('Bash: pnpm test');
    h.run(0.6); // confirmed after 0.4 s, but gathering has been shown only 0.6 + 0.1 s
    expect(h.shown).toBe('gathering');
    const history = h.run(2);
    const at = firstAt(history, 'building') ?? Infinity;
    // Gathering appeared at ≈ 0.4 s; building waits for its 2 s dwell.
    expect(at).toBeGreaterThanOrEqual(0.4 + HOLD.minDwell - 0.05);
    expect(at).toBeLessThanOrEqual(0.4 + HOLD.minDwell + 0.1);
  });

  it('an unclear activity between two edits does not drop the archetype (release delay)', () => {
    const h = new Harness();
    h.set('Edit: a.ts');
    h.run(3);
    h.set('TodoWrite');
    h.run(HOLD.release - 0.5);
    expect(h.shown).toBe('transporting');
    h.set('Edit: a.ts');
    h.run(1);
    expect(h.shown).toBe('transporting');
    h.set('Thinking about it');
    const history = h.run(HOLD.release + 0.5);
    expect(firstAt(history, undefined)).toBeGreaterThanOrEqual(h.now - 0.5 - 0.05);
  });

  it('stopping work drops the archetype at once', () => {
    const h = new Harness();
    h.set('Bash: pnpm test');
    h.run(1);
    expect(h.shown).toBe('building');
    h.set('Bash: pnpm test', 'paused');
    expect(h.shown).toBeUndefined();
    expect(h.hold.nextDue()).toBeUndefined();
  });

  it(`edits to ${MANY_EDITS} distinct files within ${EDIT_WINDOW} s escalate to building`, () => {
    const h = new Harness();
    h.set('Edit: a.ts');
    h.run(3);
    h.set('Edit: a.ts'); // the same file again counts once
    h.run(3);
    expect(h.shown).toBe('transporting');
    h.set('Edit: b.ts');
    h.run(3);
    expect(h.shown).toBe('transporting');
    h.set('Write: c.ts');
    h.run(1);
    expect(h.shown).toBe('building');
    // Once the window has passed with no new edits, one more edit is transporting again.
    h.set('Read: d.ts');
    h.run(EDIT_WINDOW + 1, 0.5);
    h.set('Edit: e.ts');
    h.run(3);
    expect(h.shown).toBe('transporting');
  });

  it('apply returns the same objects when nothing changed, and forgets agents that left', () => {
    const hold = new ArchetypeHold();
    const a = input('Read: a.ts');
    expect(hold.apply([a], 0)[0]?.archetype).toBeUndefined(); // not confirmed yet
    const [held] = hold.apply([a], 1);
    expect(held).toBe(a); // gathering confirmed: the spec already says gathering
    hold.apply([], 2);
    expect(hold.shown('a-s1')).toBeUndefined();
    expect(hold.nextDue()).toBeUndefined();
  });

  it('nextDue tells when a pending switch lands', () => {
    const hold = new ArchetypeHold();
    hold.apply([input('Read: a.ts')], 10);
    expect(hold.nextDue()).toBeCloseTo(10 + HOLD.confirm);
  });
});
