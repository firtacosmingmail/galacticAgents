import { describe, expect, it } from 'vitest';
import {
  attribute,
  isInside,
  serverTree,
  withDescendants,
  worktreeRootOf,
  type AgentGroup,
  type AttributionInput,
  type ProcEntry,
} from './process-attribution.js';
import { parseLsofNames, parseProcNetTcp, parsePs, portOf } from './process-table.js';

/**
 * Process attribution (P4-14), the pure rules over synthetic process tables. The OS layer and real
 * processes are in `steward-processes.test.ts`.
 */

const T0 = Date.parse('2026-10-04T10:00:00Z');
const S = 1_000;
const UID = 501;
const WT = '/home/u/proj/.galactic/worktrees/t-1';

const p = (
  pid: number,
  ppid: number,
  extra: Partial<ProcEntry> & { at?: number } = {},
): ProcEntry => ({
  pid,
  ppid,
  pgid: extra.pgid ?? pid,
  uid: extra.uid ?? UID,
  startedAt: extra.at ?? T0 + 10 * S,
  command: extra.command ?? `cmd-${pid}`,
  ...(extra.zombie ? { zombie: true } : {}),
});

/**
 * The world: launchd (1); the user's terminal (50) and shell (60) from before; the server (100)
 * in the dev group 90 with vite (101); the Steward a-st's CLI (200, group 200) and another
 * agent's CLI (300, group 300).
 */
function world(...more: ProcEntry[]): ProcEntry[] {
  return [
    p(1, 0, { command: '/sbin/launchd', at: T0 - 3600 * S }),
    p(50, 1, { command: '/Applications/Terminal.app/Contents/MacOS/Terminal', at: T0 - 600 * S }),
    p(60, 50, { at: T0 - 600 * S, command: '-zsh' }),
    p(90, 60, { pgid: 90, at: T0 - 300 * S, command: 'pnpm dev' }),
    p(100, 90, { pgid: 90, at: T0 - 300 * S, command: 'node server' }),
    p(101, 90, { pgid: 90, at: T0 - 300 * S, command: 'node vite' }),
    p(200, 100, { pgid: 200, at: T0 + S, command: 'claude' }),
    p(300, 100, { pgid: 300, at: T0 + S, command: 'claude' }),
    ...more,
  ];
}

const GROUPS: AgentGroup[] = [
  { agentId: 'a-st', pgid: 200, startedAt: T0 + S },
  { agentId: 'a-other', pgid: 300, startedAt: T0 + S },
];

function input(procs: ProcEntry[], over: Partial<AttributionInput> = {}): AttributionInput {
  return {
    agentId: 'a-st',
    procs,
    groups: GROUPS,
    self: { pid: 100, uid: UID },
    window: { start: T0, end: T0 + 3600 * S },
    worktree: WT,
    cwdOf: () => new Map(),
    ...over,
  };
}

const pids = async (i: AttributionInput) => (await attribute(i)).map((x) => [x.pid, x.why]);

describe('process attribution (P4-14)', () => {
  it("takes the Steward's group members, never another agent's or the server's", async () => {
    const procs = world(
      p(201, 200, { pgid: 200, command: 'node dev-server' }),
      p(202, 201, { pgid: 200 }),
      p(301, 300, { pgid: 300 }),
    );
    expect(await pids(input(procs))).toEqual([
      [200, 'group'],
      [201, 'group'],
      [202, 'group'],
    ]);
  });

  it('leaves out its own CLI when asked (the Steward still runs)', async () => {
    const procs = world(p(201, 200, { pgid: 200 }));
    expect(await pids(input(procs, { exclude: new Set([200]) }))).toEqual([[201, 'group']]);
  });

  it("does not take a recycled pgid: a member started after the group's leader ended", async () => {
    const procs = world(p(201, 1, { pgid: 200, at: T0 + 20 * S }));
    const groups: AgentGroup[] = [
      { agentId: 'a-st', pgid: 200, startedAt: T0, endedAt: T0 + 5 * S },
    ];
    // Started after the group ended, outside the worktree: not the Steward's.
    expect(
      await pids(
        input(
          procs.filter((x) => x.pid !== 200),
          { groups },
        ),
      ),
    ).toEqual([]);
  });

  it('takes a process that escaped the group (setsid) while it descends from it', async () => {
    const procs = world(
      p(210, 200, { pgid: 210, command: 'sleep 300' }), // setsid child of the CLI
      p(211, 210, { pgid: 210 }), // and its child
    );
    expect(await pids(input(procs, { exclude: new Set([200]) }))).toEqual([
      [210, 'descendant'],
      [211, 'descendant'],
    ]);
  });

  it('takes an orphan started in the session inside the worktree; its children follow', async () => {
    const procs = world(
      p(400, 1, { pgid: 400, command: 'node server.js' }),
      p(401, 400, { pgid: 400, command: 'esbuild --service' }),
    );
    const asked: number[][] = [];
    const i = input(procs, {
      exclude: new Set([200]),
      cwdOf: (ps) => {
        asked.push([...ps]);
        return new Map([[400, `${WT}/web`]]);
      },
    });
    const found = await attribute(i);
    expect(found.map((x) => [x.pid, x.why])).toEqual([
      [400, 'worktree'],
      [401, 'descendant'],
    ]);
    expect(found[0]!.cwd).toBe(`${WT}/web`);
    // Working directories are read only for orphans of ours started in the session.
    expect(asked).toEqual([[400]]);
  });

  it('an orphan reparented to a systemd subreaper counts as an orphan', async () => {
    const procs = world(
      p(5, 1, { command: '/lib/systemd/systemd --user', at: T0 - 3600 * S }),
      p(400, 5, { pgid: 400 }),
    );
    const i = input(procs, { cwdOf: () => new Map([[400, WT]]) });
    expect(await pids(i)).toEqual([
      [200, 'group'],
      [400, 'worktree'],
    ]);
  });

  it('never takes an orphan from before the session, outside the worktree, or without a worktree', async () => {
    const before = p(400, 1, { at: T0 - 5 * S });
    const outside = p(401, 1);
    const inside = p(402, 1);
    const cwdOf = () =>
      new Map([
        [400, WT],
        [401, '/home/u/other'],
        [402, WT],
      ]);
    const procs = world(before, outside, inside);
    expect(await pids(input(procs, { cwdOf, exclude: new Set([200]) }))).toEqual([
      [402, 'worktree'],
    ]);
    // A serialised project (the Steward works in the workspace itself): no worktree rule at all.
    const { worktree: _w, ...noWorktree } = input(procs, { cwdOf, exclude: new Set([200]) });
    expect(await pids(noWorktree)).toEqual([]);
    // After the Steward ended, an orphan started later is not its.
    const later = p(403, 1, { at: T0 + 7200 * S });
    expect(
      await pids(
        input(world(later), {
          cwdOf: () => new Map([[403, WT]]),
          window: { start: T0, end: T0 + 3600 * S },
          exclude: new Set([200]),
        }),
      ),
    ).toEqual([]);
  });

  it("never takes what the user's shell or the server started in the worktree", async () => {
    const procs = world(
      p(500, 60, { pgid: 500, command: 'npm run dev' }), // the user's terminal, in the session
      p(501, 100, { pgid: 501, command: 'git status' }), // the server's own (Workspaces' git)
      p(502, 100, { pgid: 90 }), // the server's group
    );
    const cwdOf = () => new Map(procs.map((x) => [x.pid, WT]));
    expect(await pids(input(procs, { cwdOf, exclude: new Set([200]) }))).toEqual([]);
    expect(serverTree(procs, 100)).toEqual(new Set([100, 90, 60, 50, 101, 502]));
  });

  it("never takes another agent's processes, escaped or not, nor another user's or a zombie", async () => {
    const procs = world(
      p(310, 300, { pgid: 310 }), // escaped from the other agent
      p(600, 200, { pgid: 200, uid: 0 }), // root's, somehow in the group
      p(601, 200, { pgid: 200, zombie: true }),
    );
    expect(await pids(input(procs, { exclude: new Set([200]) }))).toEqual([]);
  });

  it('a pgid two agents could claim is nobody’s', async () => {
    const procs = world(p(201, 1, { pgid: 200 }));
    const groups: AgentGroup[] = [...GROUPS, { agentId: 'a-x', pgid: 200, startedAt: T0 }];
    expect(await pids(input(procs, { groups, exclude: new Set([200]) }))).toEqual([]);
  });

  it('expands chosen pids to their attributed descendants', async () => {
    const procs = world(
      p(201, 200, { pgid: 200 }),
      p(202, 201, { pgid: 200 }),
      p(203, 200, { pgid: 200 }),
    );
    const found = await attribute(input(procs, { exclude: new Set([200]) }));
    expect(withDescendants(found, [201]).map((x) => x.pid)).toEqual([201, 202]);
  });
});

describe('process table parsing (P4-14)', () => {
  it('parses ps output with lstart and commands with spaces', () => {
    const out = [
      '    1     0     1     0 Ss   Sat Oct  3 18:38:47 2026     /sbin/launchd',
      '84665 11988 84665   501 Ss   Sun Oct  4 09:19:56 2026     /bin/zsh -c echo hi there',
      '  777   776   776   501 Z    Sun Oct  4 09:20:00 2026     (node)',
      'garbage',
    ].join('\n');
    const rows = parsePs(out);
    expect(rows.map((r) => [r.pid, r.ppid, r.pgid, r.uid, r.command, r.zombie ?? false])).toEqual([
      [1, 0, 1, 0, '/sbin/launchd', false],
      [84665, 11988, 84665, 501, '/bin/zsh -c echo hi there', false],
      [777, 776, 776, 501, '(node)', true],
    ]);
    expect(rows[1]!.startedAt).toBe(Date.parse('Sun Oct 4 09:19:56 2026'));
  });

  it('parses lsof -F output and listening addresses', () => {
    const names = parseLsofNames('p12\nfcwd\nn/a/b\np13\nf5\nn*:5173\nf6\nn[::1]:4321\n');
    expect(names.get(12)).toEqual(['/a/b']);
    expect(names.get(13)?.map(portOf)).toEqual([5173, 4321]);
    expect(portOf('127.0.0.1:8080')).toBe(8080);
    expect(portOf('nonsense')).toBeUndefined();
  });

  it('parses /proc/net/tcp listening sockets', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1',
      '   1: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4243 1',
    ].join('\n');
    expect(parseProcNetTcp(text)).toEqual(new Map([['4242', 8080]]));
  });

  it('finds the worktree root of a working directory', () => {
    expect(worktreeRootOf(`${WT}/apps/web`)).toBe(WT);
    expect(worktreeRootOf(WT)).toBe(WT);
    expect(worktreeRootOf('/home/u/proj')).toBeUndefined();
    expect(isInside(`${WT}/x`, WT)).toBe(true);
    expect(isInside(`${WT}-2`, WT)).toBe(false);
  });
});
