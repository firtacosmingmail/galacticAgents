import { describe, expect, it } from 'vitest';
import {
  LAUNCH_ID_ENV,
  launchCandidates,
  matchLaunch,
  type LaunchMatchInput,
} from './launch-intents.js';
import { AGENT_ID_ENV, type ProcEntry } from './process-attribution.js';
import type { LaunchIntent } from './process-store.js';

/**
 * P8-11: which processes of the snapshot are a launch's that the killed server never recorded.
 * Pure tests over scripted process tables (the real-process drill is
 * `test/drills/unrecorded-launch.test.ts`).
 */

const UID = 501;
const T = Date.parse('2026-10-06T10:00:00.400Z');
const WT = '/p/.galactic/worktrees/t1';
const SELF = { pid: 9000, uid: UID };

const intent: LaunchIntent = {
  id: 'launch-1',
  agentId: 'a-s1',
  command: '/usr/local/bin/node',
  args: ['cli.js'],
  cwd: WT,
  runId: 'run-killed',
  bootAt: '2026-10-06T08:00:00.000Z',
  intendedAt: new Date(T).toISOString(),
};

const launchd: ProcEntry = {
  pid: 1,
  ppid: 0,
  pgid: 1,
  uid: 0,
  startedAt: T - 9e6,
  command: '/sbin/launchd',
};
/** The new server, started after the kill. */
const server: ProcEntry = {
  pid: 9000,
  ppid: 8000,
  pgid: 8000,
  uid: UID,
  startedAt: T + 60_000,
  command: 'node index.js',
};
const userShell: ProcEntry = {
  pid: 8000,
  ppid: 1,
  pgid: 8000,
  uid: UID,
  startedAt: T - 3600_000,
  command: '-zsh',
};

/** `ps lstart` floors to the second. */
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;

function proc(p: Partial<ProcEntry> & Pick<ProcEntry, 'pid'>): ProcEntry {
  return {
    ppid: 1,
    pgid: p.pid,
    uid: UID,
    startedAt: sec(T),
    command: '/usr/local/bin/node cli.js',
    ...p,
  };
}

const ENV_LAUNCH = new Map([
  [AGENT_ID_ENV, 'a-s1'],
  [LAUNCH_ID_ENV, 'launch-1'],
]);

function input(
  procs: ProcEntry[],
  env: Record<number, Map<string, string>>,
  cwd: Record<number, string>,
  extra: Partial<LaunchMatchInput> = {},
): LaunchMatchInput {
  return {
    intent,
    procs: [launchd, userShell, server, ...procs],
    self: SELF,
    envOf: new Map(Object.entries(env).map(([k, v]) => [Number(k), v])),
    cwdOf: new Map(Object.entries(cwd).map(([k, v]) => [Number(k), v])),
    ...extra,
  };
}

const takenGroups = (i: LaunchMatchInput) => matchLaunch(i).map((t) => [t.pgid, t.kind]);

describe('matchLaunch (P8-11)', () => {
  const cli = proc({ pid: 100 });
  // An MCP server in the CLI's group; a macOS platform binary in it (`/bin/sh`): no environment.
  const mcp = proc({ pid: 101, ppid: 100, pgid: 100, startedAt: sec(T + 800) });
  const sh = proc({ pid: 102, ppid: 100, pgid: 100, startedAt: sec(T + 900), command: '/bin/sh' });

  it('takes the launched CLI and its whole group, unreadable members included', () => {
    const takes = matchLaunch(
      input([cli, mcp, sh], { 100: ENV_LAUNCH, 101: ENV_LAUNCH }, { 100: WT, 101: WT }),
    );
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ pgid: 100, kind: 'leader', leader: cli, agentId: 'a-s1' });
    expect(takes[0]!.members.map((p) => p.pid)).toEqual([100, 101, 102]);
  });

  it('a CLI in a subfolder of the worktree counts; one outside it, or with no known cwd, does not', () => {
    expect(takenGroups(input([cli], { 100: ENV_LAUNCH }, { 100: `${WT}/src` }))).toEqual([
      [100, 'leader'],
    ]);
    expect(takenGroups(input([cli], { 100: ENV_LAUNCH }, { 100: '/Users/me/other' }))).toEqual([]);
    expect(takenGroups(input([cli], { 100: ENV_LAUNCH }, {}))).toEqual([]);
  });

  it('pid reuse: a process in the window without the marker, or whose environment cannot be read, is never taken', () => {
    // The pid the CLI had now belongs to the user's process: right place, right time, no marker.
    expect(takenGroups(input([cli], { 100: new Map() }, { 100: WT }))).toEqual([]);
    // Unreadable environment (another user's, a platform binary): no entry at all.
    expect(takenGroups(input([cli], {}, { 100: WT }))).toEqual([]);
  });

  it('the marker alone is not enough: the launch id must be this launch’s, and the agent this agent', () => {
    const otherLaunch = new Map([
      [AGENT_ID_ENV, 'a-s1'],
      [LAUNCH_ID_ENV, 'launch-0'],
    ]);
    const otherAgent = new Map([
      [AGENT_ID_ENV, 'a-s2'],
      [LAUNCH_ID_ENV, 'launch-1'],
    ]);
    const markerOnly = new Map([[AGENT_ID_ENV, 'a-s1']]);
    for (const env of [otherLaunch, otherAgent, markerOnly]) {
      expect(takenGroups(input([cli], { 100: env }, { 100: WT }))).toEqual([]);
    }
  });

  it('the CLI must have started in the launch window', () => {
    const early = proc({ pid: 100, startedAt: sec(T) - 2_000 });
    const late = proc({ pid: 100, startedAt: T + 6_000 });
    const edge = proc({ pid: 100, startedAt: sec(T) }); // floored below the intent's ms
    expect(takenGroups(input([early], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([]);
    expect(takenGroups(input([late], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([]);
    expect(takenGroups(input([edge], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([[100, 'leader']]);
  });

  it('a group leader whose parent is alive is not the launched CLI (an escaped child of it)', () => {
    const escaped = proc({ pid: 110, ppid: 100, pgid: 110 });
    const takes = matchLaunch(
      input([cli, escaped], { 100: ENV_LAUNCH, 110: ENV_LAUNCH }, { 100: WT, 110: WT }),
    );
    expect(takes.map((t) => t.pgid)).toEqual([100]);
    // Below the user's shell: not ours to take either.
    const underShell = proc({ pid: 120, ppid: 8000 });
    expect(takenGroups(input([underShell], { 120: ENV_LAUNCH }, { 120: WT }))).toEqual([]);
  });

  it('never a user-facing app, nor a group holding one or anything below one', () => {
    const electron = proc({
      pid: 100,
      command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron .',
    });
    expect(takenGroups(input([electron], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([]);
    const tmux = proc({ pid: 101, ppid: 100, pgid: 100, command: 'tmux new -d' });
    expect(
      takenGroups(input([cli, tmux], { 100: ENV_LAUNCH, 101: ENV_LAUNCH }, { 100: WT })),
    ).toEqual([]);
    // A member whose parent (outside the group) is an app.
    const app = proc({
      pid: 200,
      pgid: 200,
      startedAt: T - 3600_000,
      command: '/Applications/iTerm.app/Contents/MacOS/iTerm2',
    });
    const inApp = proc({ pid: 101, ppid: 200, pgid: 100 });
    expect(
      takenGroups(input([app, cli, inApp], { 100: ENV_LAUNCH, 101: ENV_LAUNCH }, { 100: WT })),
    ).toEqual([]);
  });

  it('a group with a member of another user, or a zombie-only group, is left whole', () => {
    const root = proc({ pid: 101, ppid: 100, pgid: 100, uid: 0 });
    expect(takenGroups(input([cli, root], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([]);
    const zombie = proc({ pid: 100, zombie: true });
    expect(takenGroups(input([zombie], { 100: ENV_LAUNCH }, { 100: WT }))).toEqual([]);
  });

  it('never the new server’s group, nor a group excluded by the caller (this run’s own)', () => {
    const inServerGroup = proc({ pid: 9001, ppid: 9000, pgid: 8000 });
    expect(takenGroups(input([inServerGroup], { 9001: ENV_LAUNCH }, { 9001: WT }))).toEqual([]);
    expect(
      takenGroups(
        input([cli], { 100: ENV_LAUNCH }, { 100: WT }, { excludeGroups: new Set([100]) }),
      ),
    ).toEqual([]);
  });

  describe('the CLI exited and left its group (leftover)', () => {
    const child = proc({ pid: 101, pgid: 100, startedAt: sec(T + 300) });

    it('is taken when a member names this launch and runs in the worktree', () => {
      const takes = matchLaunch(input([child], { 101: ENV_LAUNCH }, { 101: WT }));
      expect(takes).toMatchObject([{ pgid: 100, kind: 'leftover' }]);
      expect(takes[0]!.leader).toBeUndefined();
    });

    it('is not taken without a marked member, outside the worktree, or from before the intent', () => {
      expect(takenGroups(input([child], {}, { 101: WT }))).toEqual([]);
      expect(takenGroups(input([child], { 101: ENV_LAUNCH }, { 101: '/tmp' }))).toEqual([]);
      const before = proc({ pid: 101, pgid: 100, startedAt: sec(T) - 5_000 });
      expect(takenGroups(input([before], { 101: ENV_LAUNCH }, { 101: WT }))).toEqual([]);
    });

    it('only the CLI’s own group: a group a tool moved out to (its leader exited) is left alone', () => {
      // The CLI is alive: a leaderless group carrying the launch is one a descendant moved out to.
      const cliAlive = proc({ pid: 100 });
      const nohupChild = proc({ pid: 131, ppid: 1, pgid: 130, startedAt: sec(T + 2_000) });
      expect(
        takenGroups(
          input([cliAlive, nohupChild], { 100: ENV_LAUNCH, 131: ENV_LAUNCH }, { 100: WT, 131: WT }),
        ),
      ).toEqual([[100, 'leader']]);
      // The CLI is gone too: two leaderless groups carry the launch and the CLI's cannot be told
      // apart, so neither is taken (fail closed; the Steward's sweep finds them when it ends).
      expect(
        takenGroups(
          input([child, nohupChild], { 101: ENV_LAUNCH, 131: ENV_LAUNCH }, { 101: WT, 131: WT }),
        ),
      ).toEqual([]);
    });

    it('two qualifying leaders: only the earliest-started one (the CLI) is taken', () => {
      const cliAlive = proc({ pid: 100 });
      // A descendant that moved out within the window and whose parent already exited.
      const escapedLeader = proc({ pid: 140, ppid: 1, startedAt: sec(T + 2_000) });
      expect(
        takenGroups(
          input(
            [escapedLeader, cliAlive],
            { 100: ENV_LAUNCH, 140: ENV_LAUNCH },
            { 100: WT, 140: WT },
          ),
        ),
      ).toEqual([[100, 'leader']]);
    });

    it('a pid that is alive under another group is not the leader: the group is still a leftover', () => {
      const stranger = proc({ pid: 100, pgid: 300, startedAt: T + 30_000, ppid: 8000 });
      expect(
        takenGroups(input([stranger, child], { 101: ENV_LAUNCH }, { 101: WT })).map((t) => t),
      ).toEqual([[100, 'leftover']]);
    });
  });
});

describe('launchCandidates (P8-11)', () => {
  it('only the server user’s live processes started after the intent, outside the server’s tree', () => {
    const procs = [
      launchd,
      userShell,
      server,
      proc({ pid: 100 }),
      proc({ pid: 101, startedAt: T - 10_000 }),
      proc({ pid: 102, uid: 0 }),
      proc({ pid: 103, zombie: true }),
      proc({ pid: 9001, ppid: 9000, pgid: 8000 }),
    ];
    expect(launchCandidates(intent, procs, SELF).map((p) => p.pid)).toEqual([100]);
  });
});
