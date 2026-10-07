import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPath,
  deliverableRoots,
  identityOf,
  isSecretName,
  nodePathFs,
  openChecked,
  sameIdentity,
  type DeliverableRoots,
  type PathFs,
} from './paths.js';

let tmp: string;
let home: string;
let dataDir: string;
let ws: string;
let outside: string;
let roots: DeliverableRoots;

function file(path: string, content = 'hello\n'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Whether the temporary folder's volume ignores case (APFS's default). */
function caseInsensitive(): boolean {
  const probe = file(join(tmp, 'CaseProbe'));
  const result = existsSync(join(tmp, 'caseprobe'));
  rmSync(probe);
  return result;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-paths-')));
  home = join(tmp, 'home');
  dataDir = join(tmp, 'home', '.galactic');
  ws = join(tmp, 'home', 'GalacticProjects', 'proj');
  outside = join(tmp, 'outside');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(join(ws, '.galactic', 'worktrees', 'T1'), { recursive: true });
  mkdirSync(join(ws, '.galactic', 'worktrees', 'T2'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  file(join(ws, 'src', 'app.ts'));
  file(join(ws, '.git', 'config'));
  file(join(ws, '.galactic', 'worktrees', 'T1', 'shot.png'));
  file(join(ws, '.galactic', 'worktrees', 'T1', '.git'), 'gitdir: ../../../.git/worktrees/T1\n');
  file(join(ws, '.galactic', 'worktrees', 'T2', 'other.txt'));
  file(join(outside, 'secret.txt'));
  roots = deliverableRoots({ workspace: ws, taskId: 'T1' }, { dataDir, home });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkPath: the roots', () => {
  it('accepts a file inside the workspace and returns its real path', () => {
    const r = checkPath(join(ws, 'src', 'app.ts'), roots);
    expect(r).toMatchObject({ ok: true, path: join(ws, 'src', 'app.ts'), where: 'workspace' });
    expect(r.ok && r.type).toBe('file');
  });

  it('accepts the workspace itself as a folder', () => {
    expect(checkPath(ws, roots)).toMatchObject({ ok: true, type: 'folder', where: 'workspace' });
  });

  it("resolves a relative path against the agent's working folder", () => {
    const wt = join(ws, '.galactic', 'worktrees', 'T1');
    expect(checkPath('shot.png', roots, { cwd: wt })).toMatchObject({
      ok: true,
      path: join(wt, 'shot.png'),
      where: 'worktree',
    });
    expect(checkPath('shot.png', roots)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses a path outside the project', () => {
    expect(checkPath(join(outside, 'secret.txt'), roots)).toMatchObject({
      ok: false,
      code: 'outside',
    });
  });

  it('resolves .. before checking', () => {
    expect(checkPath(join(ws, '..', '..', '..', 'outside', 'secret.txt'), roots)).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(checkPath(join(ws, 'src', '..', 'src', 'app.ts'), roots)).toMatchObject({ ok: true });
    expect(checkPath('../../../outside/secret.txt', roots, { cwd: ws })).toMatchObject({
      ok: false,
      code: 'outside',
    });
  });

  it('refuses a symlink whose target leaves the project (a file and a parent folder)', () => {
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'notes.txt'));
    symlinkSync(outside, join(ws, 'docs'));
    expect(checkPath(join(ws, 'notes.txt'), roots)).toMatchObject({ ok: false, code: 'outside' });
    expect(checkPath(join(ws, 'docs', 'secret.txt'), roots)).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(checkPath(join(ws, 'docs'), roots)).toMatchObject({ ok: false, code: 'outside' });
  });

  it('follows a symlink that stays inside and stores the target', () => {
    symlinkSync(join(ws, 'src', 'app.ts'), join(ws, 'entry.ts'));
    expect(checkPath(join(ws, 'entry.ts'), roots)).toMatchObject({
      ok: true,
      path: join(ws, 'src', 'app.ts'),
    });
  });

  it('canonicalises the roots: a workspace reached through a link still holds its files', () => {
    symlinkSync(ws, join(tmp, 'ws-link'));
    const viaLink = deliverableRoots({ workspace: join(tmp, 'ws-link') }, { dataDir, home });
    expect(viaLink.workspace).toBe(ws);
    expect(checkPath(join(tmp, 'ws-link', 'src', 'app.ts'), viaLink)).toMatchObject({
      ok: true,
      path: join(ws, 'src', 'app.ts'),
    });
  });

  it('accepts the repository root of a workspace in a sub-folder', () => {
    const repo = join(tmp, 'repo');
    const sub = join(repo, 'packages', 'web');
    mkdirSync(join(repo, '.git'), { recursive: true });
    file(join(repo, 'README.md'));
    file(join(sub, 'index.html'));
    const r = deliverableRoots({ workspace: sub, repoRoot: repo }, { dataDir, home });
    expect(checkPath(join(repo, 'README.md'), r)).toMatchObject({ ok: true, where: 'repository' });
    expect(checkPath(join(sub, 'index.html'), r)).toMatchObject({ ok: true, where: 'workspace' });
    expect(checkPath(join(repo, '.git'), r)).toMatchObject({ ok: false, code: 'refused_area' });
  });

  it('refuses something that is neither a file nor a folder', () => {
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    expect(checkPath(join(ws, 'pipe'), roots)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reports a missing path, a symlink loop and malformed input', () => {
    expect(checkPath(join(ws, 'nope.txt'), roots)).toMatchObject({ ok: false, code: 'missing' });
    symlinkSync(join(ws, 'loop-b'), join(ws, 'loop-a'));
    symlinkSync(join(ws, 'loop-a'), join(ws, 'loop-b'));
    expect(checkPath(join(ws, 'loop-a'), roots)).toMatchObject({ ok: false, code: 'invalid' });
    expect(checkPath('', roots)).toMatchObject({ ok: false, code: 'invalid' });
    expect(checkPath(`${ws}/a\0b`, roots)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses very long paths without throwing', () => {
    expect(checkPath(join(ws, 'a'.repeat(5000)), roots)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    // One component past NAME_MAX (255): ENAMETOOLONG from the file system.
    expect(checkPath(join(ws, 'b'.repeat(300)), roots)).toMatchObject({ ok: false });
    // Many components past PATH_MAX (1024 on macOS), each short.
    const deep = join(ws, ...Array.from({ length: 200 }, () => 'segment'));
    expect(checkPath(deep, roots)).toMatchObject({ ok: false });
  });

  it('accepts a hard link inside the project (known limit: realpath cannot tell)', () => {
    linkSync(join(outside, 'secret.txt'), join(ws, 'hard.txt'));
    expect(checkPath(join(ws, 'hard.txt'), roots)).toMatchObject({ ok: true });
  });
});

describe('checkPath: refused areas', () => {
  it('refuses .git and anything in it', () => {
    expect(checkPath(join(ws, '.git'), roots)).toMatchObject({ ok: false, code: 'refused_area' });
    expect(checkPath(join(ws, '.git', 'config'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
  });

  it("refuses another task's worktree and .galactic, accepts the task's own worktree", () => {
    expect(checkPath(join(ws, '.galactic', 'worktrees', 'T2', 'other.txt'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    expect(checkPath(join(ws, '.galactic'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    expect(checkPath(join(ws, '.galactic', 'worktrees', 'T1', 'shot.png'), roots)).toMatchObject({
      ok: true,
      where: 'worktree',
    });
    expect(checkPath(join(ws, '.galactic', 'worktrees', 'T1'), roots)).toMatchObject({
      ok: true,
      type: 'folder',
    });
    // The worktree's own `.git` file.
    expect(checkPath(join(ws, '.galactic', 'worktrees', 'T1', '.git'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    // Without a task, no worktree is allowed.
    const projectRoots = deliverableRoots({ workspace: ws }, { dataDir, home });
    expect(
      checkPath(join(ws, '.galactic', 'worktrees', 'T1', 'shot.png'), projectRoots),
    ).toMatchObject({ ok: false, code: 'refused_area' });
  });

  it("refuses the server's data folder even inside a root", () => {
    // A repository holding the whole home folder (dotfiles) makes the data folder "inside".
    file(join(dataDir, 'galactic.sqlite'));
    const r = deliverableRoots({ workspace: ws, repoRoot: home }, { dataDir, home });
    expect(checkPath(join(dataDir, 'galactic.sqlite'), r)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    expect(checkPath(home, r)).toMatchObject({ ok: false, code: 'refused_area' });
    expect(checkPath(dataDir, r)).toMatchObject({ ok: false, code: 'refused_area' });
    expect(checkPath(join(home, 'GalacticProjects'), r)).toMatchObject({ ok: true });
  });

  it('compares the refused areas without case on a case-insensitive volume', () => {
    if (!caseInsensitive()) return;
    expect(checkPath(join(ws, '.GIT', 'config'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    expect(checkPath(join(ws, '.Galactic', 'worktrees', 'T2', 'other.txt'), roots)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
    const upper = deliverableRoots(
      { workspace: ws, repoRoot: home },
      { dataDir: join(home, '.GALACTIC'), home },
    );
    file(join(dataDir, 'config.json'));
    expect(checkPath(join(dataDir, 'config.json'), upper)).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
  });
});

describe('checkPath: on-disk names (macOS)', () => {
  it('answers the on-disk case for a path spelled in another case', () => {
    if (!caseInsensitive()) return;
    const spelled = join(ws, 'SRC', 'APP.TS');
    expect(checkPath(spelled, roots)).toMatchObject({ ok: true, path: join(ws, 'src', 'app.ts') });
    // Roots given in another case are canonicalised to the disk's case too.
    const shouted = deliverableRoots({ workspace: ws.toUpperCase() }, { dataDir, home });
    expect(shouted.workspace).toBe(ws);
  });

  it('answers the on-disk Unicode form for an NFD spelling of an NFC name', () => {
    const nfc = join(ws, 'café', 'menu.md');
    file(nfc);
    const nfd = join(ws, 'café', 'menu.md');
    if (!existsSync(nfd)) return; // a normalisation-sensitive file system
    expect(checkPath(nfd, roots)).toMatchObject({ ok: true, path: nfc });
  });
});

describe('checkPath: secret names (agents)', () => {
  const names = [
    '.env',
    '.env.local',
    '.ENV',
    'server.pem',
    'tls.key',
    'cert.p12',
    'cert.pfx',
    'login.keychain-db',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519.pub',
    '.npmrc',
    '.netrc',
    '.pypirc',
    '.git-credentials',
    'credentials.json',
    'Credentials',
  ];

  it.each(names)('refuses %s to an agent and accepts it from the user', (name) => {
    const path = file(join(ws, 'conf', name));
    expect(checkPath(path, roots, { secretNames: true })).toMatchObject({
      ok: false,
      code: 'secret',
    });
    expect(checkPath(path, roots)).toMatchObject({ ok: true });
  });

  it.each([
    '.ssh/config',
    '.aws/credentials',
    '.gnupg/pubring.kbx',
    '.docker/config.json',
    '.kube/config',
  ])('refuses %s (a secret configuration folder)', (rel) => {
    const path = file(join(ws, 'home-copy', rel));
    expect(checkPath(path, roots, { secretNames: true })).toMatchObject({
      ok: false,
      code: 'secret',
    });
  });

  it('refuses a folder that is a secret folder, accepts one that contains secrets', () => {
    file(join(ws, 'conf', '.env'));
    file(join(ws, 'conf', '.ssh', 'id_rsa'));
    expect(checkPath(join(ws, 'conf', '.ssh'), roots, { secretNames: true })).toMatchObject({
      ok: false,
      code: 'secret',
    });
    expect(checkPath(join(ws, 'conf'), roots, { secretNames: true })).toMatchObject({ ok: true });
  });

  it('refuses an innocent name linking to a secret and a secret name linking to anything', () => {
    file(join(ws, '.env'), 'TOKEN=x\n');
    symlinkSync(join(ws, '.env'), join(ws, 'notes.txt'));
    symlinkSync(join(ws, 'src', 'app.ts'), join(ws, 'deploy.key'));
    expect(checkPath(join(ws, 'notes.txt'), roots, { secretNames: true })).toMatchObject({
      ok: false,
      code: 'secret',
    });
    expect(checkPath(join(ws, 'deploy.key'), roots, { secretNames: true })).toMatchObject({
      ok: false,
      code: 'secret',
    });
  });

  it('leaves ordinary names alone', () => {
    for (const name of ['env.ts', 'keyboard.ts', 'monkey.png', 'README.md', 'my-credentials-ui']) {
      expect(isSecretName(name)).toBe(false);
    }
  });
});

describe('checkPath: the deliverables folder', () => {
  it('accepts a file already in the project’s deliverables folder, in place', () => {
    const folder = join(ws, 'deliverables');
    const path = file(join(folder, 'add-login', 'report.md'));
    const r = deliverableRoots(
      { workspace: ws, taskId: 'T1', deliverablesFolder: folder },
      { dataDir, home },
    );
    expect(checkPath(path, r, { secretNames: true })).toMatchObject({
      ok: true,
      where: 'deliverables',
      path,
    });
    // Before the folder is recorded it is still inside the workspace.
    expect(checkPath(path, roots)).toMatchObject({ ok: true, where: 'workspace' });
  });

  it('accepts galactic-deliverables/ the same way', () => {
    const folder = join(ws, 'galactic-deliverables');
    const path = file(join(folder, 'shot.png'));
    const r = deliverableRoots({ workspace: ws, deliverablesFolder: folder }, { dataDir, home });
    expect(checkPath(path, r)).toMatchObject({ ok: true, where: 'deliverables' });
  });
});

describe('checkPath: strays in a temporary folder (decision 122)', () => {
  let strays: string;
  const stray = (extra: Partial<{ firstSpawnAt: number; uid: number }> = {}) => ({
    secretNames: true,
    stray: { firstSpawnAt: Date.now() - 60_000, tmpDirs: [strays], ...extra },
  });

  beforeEach(() => {
    strays = join(tmp, 'T');
    mkdirSync(strays);
    file(join(strays, 'chart.png'));
  });

  it('accepts a fresh file the server’s user owns', () => {
    expect(checkPath(join(strays, 'chart.png'), roots, stray())).toMatchObject({
      ok: true,
      where: 'stray',
      path: join(strays, 'chart.png'),
    });
  });

  it('refuses a stray to the user and without the stray rule', () => {
    expect(checkPath(join(strays, 'chart.png'), roots)).toMatchObject({
      ok: false,
      code: 'outside',
    });
  });

  it('refuses a file older than the agent’s first session', () => {
    const old = file(join(strays, 'old.png'));
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(checkPath(old, roots, stray({ firstSpawnAt: Date.now() + 60_000 }))).toMatchObject({
      ok: false,
      code: 'stray_refused',
    });
  });

  it('refuses a link, another owner, the temporary folder itself and a secret', () => {
    symlinkSync(join(strays, 'chart.png'), join(strays, 'link.png'));
    expect(checkPath(join(strays, 'link.png'), roots, stray())).toMatchObject({
      ok: false,
      code: 'stray_refused',
    });
    expect(
      checkPath(join(strays, 'chart.png'), roots, stray({ uid: (process.getuid?.() ?? 0) + 1 })),
    ).toMatchObject({ ok: false, code: 'stray_refused' });
    expect(checkPath(strays, roots, stray())).toMatchObject({ ok: false, code: 'outside' });
    const key = file(join(strays, 'deploy.pem'));
    expect(checkPath(key, roots, stray())).toMatchObject({ ok: false, code: 'secret' });
  });

  it('refuses a link from the temporary folder into the rest of the Mac', () => {
    symlinkSync(join(outside, 'secret.txt'), join(strays, 'out.txt'));
    expect(checkPath(join(strays, 'out.txt'), roots, stray())).toMatchObject({
      ok: false,
      code: 'outside',
    });
  });

  it('refuses the data folder when it lies in the temporary folder', () => {
    const tmpData = join(strays, 'galactic-home');
    file(join(tmpData, 'config.json'));
    const r = deliverableRoots({ workspace: ws }, { dataDir: tmpData, home });
    expect(checkPath(join(tmpData, 'config.json'), r, stray())).toMatchObject({
      ok: false,
      code: 'refused_area',
    });
  });

  it('finds the system temporary folders by default', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-stray-')));
    try {
      file(join(real, 'out.txt'));
      expect(
        checkPath(join(real, 'out.txt'), roots, {
          stray: { firstSpawnAt: Date.now() - 60_000 },
        }),
      ).toMatchObject({ ok: true, where: 'stray' });
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('openChecked', () => {
  function readAll(fd: number): string {
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  }

  it('opens the checked file and reads through the descriptor', () => {
    const r = openChecked(join(ws, 'src', 'app.ts'), roots);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      expect(readAll(r.fd)).toBe('hello\n');
      expect(r.stat.ino).toBe(nodePathFs.stat(join(ws, 'src', 'app.ts')).ino);
    } finally {
      nodePathFs.close(r.fd);
    }
  });

  it('passes the refusal of the check through', () => {
    expect(openChecked(join(outside, 'secret.txt'), roots)).toMatchObject({
      ok: false,
      code: 'outside',
    });
  });

  /** A facade that runs `swap` between the check and the open. */
  function racing(swap: () => void): PathFs & { closed: number[] } {
    const closed: number[] = [];
    return {
      ...nodePathFs,
      open: (p, flags) => {
        swap();
        return nodePathFs.open(p, flags);
      },
      close: (fd) => {
        closed.push(fd);
        nodePathFs.close(fd);
      },
      closed,
    };
  }

  it('refuses a file replaced between the check and the open (changed)', () => {
    const path = join(ws, 'src', 'app.ts');
    const fs = racing(() => {
      file(join(ws, 'src', 'other.ts'), 'swapped\n');
      renameSync(join(ws, 'src', 'other.ts'), path);
    });
    const r = openChecked(path, roots, {}, fs);
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(fs.closed).toHaveLength(1);
  });

  it('refuses a file swapped for a link after the check (changed)', () => {
    const path = join(ws, 'src', 'app.ts');
    const fs = racing(() => {
      rmSync(path);
      symlinkSync(join(outside, 'secret.txt'), path);
    });
    expect(openChecked(path, roots, {}, fs)).toMatchObject({ ok: false, code: 'changed' });
  });

  it('refuses a parent folder swapped for a link after the check (changed)', () => {
    file(join(outside, 'app.ts'), 'outside\n');
    const fs = racing(() => {
      renameSync(join(ws, 'src'), join(ws, 'src-old'));
      symlinkSync(outside, join(ws, 'src'));
    });
    expect(openChecked(join(ws, 'src', 'app.ts'), roots, {}, fs)).toMatchObject({
      ok: false,
      code: 'changed',
    });
  });

  it('reports a file deleted between the check and the open as missing', () => {
    const path = join(ws, 'src', 'app.ts');
    const fs = racing(() => rmSync(path));
    expect(openChecked(path, roots, {}, fs)).toMatchObject({ ok: false, code: 'missing' });
  });
});

describe('file identity (download tickets)', () => {
  it('changes when the file is rewritten', () => {
    const path = join(ws, 'src', 'app.ts');
    const before = identityOf(nodePathFs.stat(path));
    expect(sameIdentity(before, identityOf(nodePathFs.stat(path)))).toBe(true);
    writeFileSync(path, 'a longer body\n');
    expect(sameIdentity(before, identityOf(nodePathFs.stat(path)))).toBe(false);
  });
});
