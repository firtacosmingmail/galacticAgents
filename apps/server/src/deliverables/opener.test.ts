import { describe, expect, it } from 'vitest';
import { KNOWN_IDES } from '@galactic/protocol';
import { requireLocal } from '../http/security.js';
import {
  CODESIGN,
  confirmationCovers,
  ideRequirement,
  MDFIND,
  OPEN,
  Opener,
  OpenerError,
  PLUTIL,
  plistString,
  TOO_LARGE_FINGERPRINT,
  type ExecFile,
  type OpenerFs,
  type OpenerOptions,
} from './opener.js';

/**
 * The opener (P9-03; TECHNOLOGY §9.7). Nothing here opens anything: `execFile` and the file
 * system are fakes, and every argument vector is checked as `open` would get it.
 */

const HOME = '/Users/me';
const WEBSTORM = 'com.jetbrains.WebStorm';
const VSCODE = 'com.microsoft.VSCode';
const CURSOR = 'com.todesktop.230313mzl4w4u92';

const plist = (id: string, exe = 'main') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
  `  <key>CFBundleExecutable</key>\n  <string>${exe}</string>\n` +
  `  <key>CFBundleIdentifier</key>\n  <string>${id}</string>\n</dict></plist>\n`;

interface FakeEntry {
  dir?: boolean;
  data?: string | Buffer;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  ino?: number;
  mode?: number;
}

/**
 * A file system of absolute paths; folders are implied by their children or marked `dir`.
 * `links` maps a symlink's path to its target (`realpath` follows them; nothing else does).
 */
function fakeFs(
  entries: Record<string, FakeEntry>,
  links: Record<string, string> = {},
): OpenerFs & {
  set(path: string, e: FakeEntry): void;
  remove(path: string): void;
  reads: string[];
} {
  const files = new Map(Object.entries(entries));
  const reads: string[] = [];
  const isDir = (p: string) =>
    files.get(p)?.dir === true || [...files.keys()].some((k) => k.startsWith(p + '/'));
  return {
    reads,
    set: (p, e) => void files.set(p, e),
    remove: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k);
    },
    async realpath(path) {
      for (const [link, target] of Object.entries(links)) {
        if (path === link || path.startsWith(link + '/')) return target + path.slice(link.length);
      }
      return path;
    },
    async readdir(path) {
      if (!isDir(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(path + '/')) names.add(k.slice(path.length + 1).split('/')[0]!);
      }
      return [...names];
    },
    async readFile(path) {
      reads.push(path);
      const e = files.get(path);
      if (!e || e.data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    },
    async lstat(path) {
      const e = files.get(path);
      if (!e && !isDir(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const dir = e?.dir === true || (!e && isDir(path)) || (e?.data === undefined && isDir(path));
      return {
        dev: 1,
        ino: e?.ino ?? 1,
        mode: e?.mode ?? (dir ? 0o755 : 0o644),
        size: e?.size ?? (e?.data ? Buffer.byteLength(e.data) : 0),
        mtimeMs: e?.mtimeMs ?? 1000,
        ctimeMs: e?.ctimeMs ?? 1000,
        isDirectory: () => dir,
        isFile: () => !dir,
        isSymbolicLink: () => false,
      };
    },
    async exists(path) {
      return files.has(path) || isDir(path);
    },
  };
}

/** An installed app: its `Info.plist` and its executable. */
const app = (path: string, id: string, exe = 'main'): Record<string, FakeEntry> => ({
  [`${path}/Contents/Info.plist`]: { data: plist(id, exe) },
  [`${path}/Contents/MacOS/${exe}`]: { data: 'binary', size: 100, mtimeMs: 5000 },
});

interface Call {
  file: string;
  args: readonly string[];
  env: Record<string, string>;
  timeout: number;
}

/** A fake `execFile`: records calls; `mdfind` answers from `spotlight`, `open` succeeds. */
function fakeExec(
  spotlight: Record<string, string[]> | 'off' = {},
  over: Partial<Record<string, ExecFile>> = {},
): { exec: ExecFile; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFile = async (file, args, options) => {
    calls.push({ file, args: [...args], env: options.env, timeout: options.timeout });
    const own = over[file];
    if (own) return own(file, args, options);
    if (file === MDFIND) {
      if (spotlight === 'off') throw new Error('Spotlight is off');
      const id = /'([^']+)'/.exec(args[0]!)?.[1] ?? '';
      return { stdout: (spotlight[id] ?? []).map((p) => p + '\n').join(''), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function opener(fs: OpenerFs, exec: ExecFile, over: Partial<OpenerOptions> = {}): Opener {
  return new Opener({ execFile: exec, fs, platform: 'darwin', home: HOME, ...over });
}

const opens = (calls: Call[]) => calls.filter((c) => c.file === OPEN).map((c) => c.args);

describe('Opener: argument vectors (never a shell)', () => {
  it('opens, reveals and launches with /usr/bin/open, the path after the options', async () => {
    const { exec, calls } = fakeExec();
    const o = opener(fakeFs({}), exec);
    await o.open('/Users/me/proj/notes.md');
    await o.reveal('/Users/me/proj/a file with spaces; and "quotes".png');
    await o.openApp('/Users/me/proj/deliverables/t/My App.app');
    expect(opens(calls)).toEqual([
      ['/Users/me/proj/notes.md'],
      ['-R', '/Users/me/proj/a file with spaces; and "quotes".png'],
      ['/Users/me/proj/deliverables/t/My App.app'],
    ]);
    for (const c of calls) {
      expect(c.file).toBe('/usr/bin/open');
      expect(c.timeout).toBe(10_000);
    }
  });

  it('opens a folder in the detected IDE by its path: open -a <app> <folder>', async () => {
    const { exec, calls } = fakeExec();
    const o = opener(fakeFs(app('/Applications/WebStorm.app', WEBSTORM)), exec);
    const used = await o.openInIde('/Users/me/GalacticProjects/my-app');
    expect(used).toEqual({
      bundleId: WEBSTORM,
      name: 'WebStorm',
      path: '/Applications/WebStorm.app',
    });
    expect(opens(calls)).toEqual([
      ['-a', '/Applications/WebStorm.app', '/Users/me/GalacticProjects/my-app'],
    ]);
  });

  it('refuses to Open what would run code, whatever the caller checked (use_app)', async () => {
    const { exec, calls } = fakeExec();
    const fs = fakeFs({
      '/p/tool': { data: 'echo hi', mode: 0o755 },
      '/p/notes': { data: 'hello', mode: 0o644 },
      '/p/run.sh': { data: '#!/bin/sh', mode: 0o755 },
    });
    const o = opener(fs, exec);
    for (const bad of ['/p/My.app', '/p/My.app/', '/p/Site.webloc', '/p/x.command', '/p/tool']) {
      await expect(o.open(bad)).rejects.toMatchObject({ code: 'use_app', status: 409 });
    }
    await o.open('/p/notes');
    await o.open('/p/run.sh');
    expect(opens(calls)).toEqual([['/p/notes'], ['/p/run.sh']]);
  });

  it('refuses a relative path, an option-looking path and a line break before running anything', async () => {
    const { exec, calls } = fakeExec();
    const o = opener(fakeFs({}), exec);
    for (const bad of ['-a', 'notes.md', '--args', '', '/tmp/a\nb', '/tmp/a\0b']) {
      await expect(o.open(bad)).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(o.reveal(bad)).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(o.openInIde(bad)).rejects.toMatchObject({ code: 'invalid_path' });
    }
    expect(opens(calls)).toEqual([]);
  });

  it('passes a small environment: no token, no keys', async () => {
    const saved = { ...process.env };
    process.env['GALACTIC_TOKEN'] = 'secret-token-value';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    try {
      const { exec, calls } = fakeExec();
      await opener(fakeFs({}), exec).open('/tmp/x.txt');
      const env = calls[0]!.env;
      expect(
        Object.keys(env).every((k) =>
          ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(k),
        ),
      ).toBe(true);
      expect(JSON.stringify(env)).not.toContain('secret-token-value');
      expect(JSON.stringify(env)).not.toContain('sk-ant');
    } finally {
      process.env = saved;
    }
  });

  it('reports a failing open as open_failed with the first line of its error', async () => {
    const { exec } = fakeExec(
      {},
      {
        [OPEN]: async () => {
          throw Object.assign(new Error('Command failed'), {
            stderr: 'LSOpenURLsWithRole() failed with error -10810\nmore',
          });
        },
      },
    );
    const err = await opener(fakeFs({}), exec)
      .open('/tmp/x.txt')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenerError);
    expect(err).toMatchObject({ code: 'open_failed', status: 502 });
    expect((err as Error).message).toContain('-10810');
    expect((err as Error).message).not.toContain('more');
  });

  it('refuses every open with 501 not_mac off macOS, and detects nothing there', async () => {
    const { exec, calls } = fakeExec({ [WEBSTORM]: ['/Applications/WebStorm.app'] });
    const o = opener(fakeFs(app('/Applications/WebStorm.app', WEBSTORM)), exec, {
      platform: 'linux',
    });
    expect(o.supported).toBe(false);
    for (const attempt of [
      () => o.open('/tmp/x'),
      () => o.reveal('/tmp/x'),
      () => o.openApp('/tmp/x.app'),
      () => o.openInIde('/tmp/x'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'not_mac', status: 501 });
    }
    expect(await o.ides()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('Opener: IDE detection', () => {
  it('finds IDEs by bundle id through Spotlight, in decision 127 order', async () => {
    const fs = fakeFs({
      ...app('/Applications/Visual Studio Code.app', VSCODE),
      ...app('/Users/me/Applications/JetBrains Toolbox/WebStorm.app', WEBSTORM),
    });
    const { exec } = fakeExec({
      [VSCODE]: ['/Applications/Visual Studio Code.app'],
      [WEBSTORM]: ['/Users/me/Applications/JetBrains Toolbox/WebStorm.app'],
    });
    expect((await opener(fs, exec).ides()).map((i) => i.name)).toEqual([
      'WebStorm',
      'Visual Studio Code',
    ]);
  });

  it('scans /Applications, ~/Applications and the Toolbox folder when Spotlight is off', async () => {
    const fs = fakeFs({
      ...app('/Applications/Cursor.app', CURSOR),
      ...app('/Applications/Zed.app', 'dev.zed.Zed'),
      ...app('/Applications/Slack.app', 'com.tinyspeck.slackmacgap'),
      ...app(
        '/Users/me/Applications/JetBrains Toolbox/IntelliJ IDEA CE.app',
        'com.jetbrains.intellij.ce',
      ),
      // Renamed: found by bundle id, not by name.
      ...app('/Users/me/Applications/My Editor.app', WEBSTORM),
    });
    const { exec } = fakeExec('off');
    const ides = await opener(fs, exec).ides();
    expect(ides).toEqual([
      { bundleId: WEBSTORM, name: 'WebStorm', path: '/Users/me/Applications/My Editor.app' },
      {
        bundleId: 'com.jetbrains.intellij.ce',
        name: 'IntelliJ IDEA CE',
        path: '/Users/me/Applications/JetBrains Toolbox/IntelliJ IDEA CE.app',
      },
      { bundleId: CURSOR, name: 'Cursor', path: '/Applications/Cursor.app' },
      { bundleId: 'dev.zed.Zed', name: 'Zed', path: '/Applications/Zed.app' },
    ]);
  });

  it('accepts only apps really inside /Applications or ~/Applications (S1)', async () => {
    // A fake WebStorm in a project, a link from ~/Applications into a worktree, and a real one
    // in ~/Applications reached by Spotlight only.
    const { exec, calls } = fakeExec({
      [WEBSTORM]: [
        '/Users/me/GalacticProjects/app/WebStorm.app',
        '/Users/me/Applications/WebStorm.app',
        '/Users/me/Applications/Real WebStorm.app',
      ],
    });
    const fs = fakeFs(
      {
        ...app('/Users/me/GalacticProjects/app/WebStorm.app', WEBSTORM),
        ...app('/Users/me/GalacticProjects/app/.galactic/worktrees/t/WebStorm.app', WEBSTORM),
        ...app('/Users/me/Applications/Real WebStorm.app', WEBSTORM),
      },
      {
        '/Users/me/Applications/WebStorm.app':
          '/Users/me/GalacticProjects/app/.galactic/worktrees/t/WebStorm.app',
      },
    );
    const o = opener(fs, exec);
    expect(await o.ides()).toEqual([
      { bundleId: WEBSTORM, name: 'WebStorm', path: '/Users/me/Applications/Real WebStorm.app' },
    ]);
    await o.openInIde('/p');
    expect(opens(calls)).toEqual([['-a', '/Users/me/Applications/Real WebStorm.app', '/p']]);
  });

  it("checks the IDE's signature with its maker's Team ID, cached while the bundle is unchanged", async () => {
    let now = 0;
    const signed = new Set(['/Applications/Visual Studio Code.app']);
    const { exec, calls } = fakeExec('off', {
      [CODESIGN]: async (_f, args) => {
        if (!signed.has(args.at(-1)!)) throw new Error('code failed to satisfy requirement');
        return { stdout: '', stderr: '' };
      },
    });
    const fs = fakeFs({
      ...app('/Applications/WebStorm.app', WEBSTORM),
      ...app('/Applications/Visual Studio Code.app', VSCODE),
    });
    const o = opener(fs, exec, { now: () => now });
    // The fake WebStorm fails its signature check: Automatic falls to VS Code.
    expect((await o.ides()).map((i) => i.bundleId)).toEqual([VSCODE]);
    const codesigns = () => calls.filter((c) => c.file === CODESIGN);
    expect(codesigns().map((c) => c.args)).toEqual(
      expect.arrayContaining([
        [
          '--verify',
          '-R=anchor apple generic and identifier "com.jetbrains.WebStorm" and certificate leaf[subject.OU] = "2ZEFAR8TH3"',
          '/Applications/WebStorm.app',
        ],
        [
          '--verify',
          '-R=anchor apple generic and identifier "com.microsoft.VSCode" and certificate leaf[subject.OU] = "UBF8T346G9"',
          '/Applications/Visual Studio Code.app',
        ],
      ]),
    );
    expect(codesigns()).toHaveLength(2);
    // Cached: a new detection re-checks nothing while the bundles are unchanged...
    now = 61_000;
    await o.ides();
    await o.openInIde('/p');
    expect(codesigns()).toHaveLength(2);
    // ...and checks again once the executable's folder changed.
    fs.set('/Applications/Visual Studio Code.app/Contents/MacOS', { dir: true, mtimeMs: 9 });
    await o.openInIde('/p');
    expect(codesigns()).toHaveLength(3);
    // Re-signed by someone else: refused at the open, though the detection is cached.
    signed.clear();
    fs.set('/Applications/Visual Studio Code.app/Contents/MacOS', { dir: true, mtimeMs: 10 });
    await expect(o.openInIde('/p')).rejects.toMatchObject({ code: 'ide_not_installed' });
  });

  it('refuses at the open an IDE removed since the detection', async () => {
    const { exec, calls } = fakeExec('off');
    const fs = fakeFs(app('/Applications/WebStorm.app', WEBSTORM));
    const o = opener(fs, exec);
    expect(await o.ides()).toHaveLength(1);
    fs.remove('/Applications/WebStorm.app');
    await expect(o.openInIde('/p')).rejects.toMatchObject({ code: 'ide_not_installed' });
    expect(opens(calls)).toEqual([]);
  });

  it('builds the requirement without a Team ID for an IDE whose maker is not recorded', () => {
    expect(ideRequirement('dev.zed.Zed')).toBe('anchor apple generic and identifier "dev.zed.Zed"');
    expect(() => ideRequirement('x" or true')).toThrow();
  });

  it('ignores a stale Spotlight hit, one in the Trash and one on another volume', async () => {
    const { exec } = fakeExec({
      [WEBSTORM]: [
        '/Volumes/Backup/Applications/WebStorm.app',
        '/Users/me/.Trash/WebStorm.app',
        '/Applications/Gone.app',
      ],
    });
    const fs = fakeFs({
      ...app('/Volumes/Backup/Applications/WebStorm.app', WEBSTORM),
      ...app('/Users/me/.Trash/WebStorm.app', WEBSTORM),
    });
    expect(await opener(fs, exec).ides()).toEqual([]);
  });

  it('never touches a Spotlight hit outside the Applications folders (no macOS folder prompts)', async () => {
    const outside = [
      '/Users/me/Downloads/WebStorm.app',
      '/Users/me/Desktop/WebStorm.app',
      '/Users/me/Library/CloudStorage/GoogleDrive-me/WebStorm.app',
    ];
    const { exec } = fakeExec({ [WEBSTORM]: outside });
    const base = fakeFs(Object.assign({}, ...outside.map((p) => app(p, WEBSTORM))));
    const touched: string[] = [];
    const fs = {
      ...base,
      realpath: async (p: string) => (touched.push(p), base.realpath(p)),
      lstat: async (p: string) => (touched.push(p), base.lstat(p)),
      readFile: async (p: string) => (touched.push(p), base.readFile(p)),
      exists: async (p: string) => (touched.push(p), base.exists(p)),
    };
    expect(await opener(fs, exec).ides()).toEqual([]);
    expect(
      touched.filter(
        (p) => !p.startsWith('/Applications') && !p.startsWith('/Users/me/Applications'),
      ),
    ).toEqual([]);
  });

  it('reads a binary Info.plist through plutil, only when it names a wanted id', async () => {
    const binary = (id: string) => Buffer.concat([Buffer.from('bplist00'), Buffer.from(id)]);
    const fs = fakeFs({
      '/Applications/WebStorm.app/Contents/Info.plist': { data: binary(WEBSTORM) },
      '/Applications/Other.app/Contents/Info.plist': { data: binary('com.example.other') },
    });
    const { exec, calls } = fakeExec('off', {
      [PLUTIL]: async (_f, args) => {
        expect(args.slice(0, 4)).toEqual(['-convert', 'xml1', '-o', '-']);
        return { stdout: plist(WEBSTORM), stderr: '' };
      },
    });
    expect((await opener(fs, exec).ides()).map((i) => i.bundleId)).toEqual([WEBSTORM]);
    expect(calls.filter((c) => c.file === PLUTIL).map((c) => c.args[4])).toEqual([
      '/Applications/WebStorm.app/Contents/Info.plist',
    ]);
  });

  it('asks Spotlight with an argument array, one query per known IDE', async () => {
    const { exec, calls } = fakeExec();
    await opener(fakeFs({}), exec).ides();
    expect(calls.filter((c) => c.file === MDFIND).map((c) => c.args)).toEqual(
      KNOWN_IDES.map((i) => [`kMDItemCFBundleIdentifier == '${i.bundleId}'`]),
    );
  });

  it('caches a detection for 60 s and shares one in flight', async () => {
    let now = 0;
    const { exec, calls } = fakeExec({ [WEBSTORM]: ['/Applications/WebStorm.app'] });
    const fs = fakeFs(app('/Applications/WebStorm.app', WEBSTORM));
    const o = opener(fs, exec, { now: () => now });
    expect(o.installedBundleIds()).toBeUndefined();
    await Promise.all([o.ides(), o.ides()]);
    const mdfinds = () => calls.filter((c) => c.file === MDFIND).length;
    expect(mdfinds()).toBe(KNOWN_IDES.length);
    now = 59_000;
    await o.ides();
    expect(mdfinds()).toBe(KNOWN_IDES.length);
    now = 61_000;
    await o.ides();
    expect(mdfinds()).toBe(2 * KNOWN_IDES.length);
    expect(o.installedBundleIds()).toEqual([WEBSTORM]);
  });
});

describe('Opener: the IDE setting', () => {
  const both = () =>
    fakeFs({
      ...app('/Applications/WebStorm.app', WEBSTORM),
      ...app('/Applications/Visual Studio Code.app', VSCODE),
    });

  it('auto picks WebStorm when installed, the next one when not', async () => {
    const { exec, calls } = fakeExec('off');
    await opener(both(), exec).openInIde('/p');
    const vsOnly = fakeFs(app('/Applications/Visual Studio Code.app', VSCODE));
    await opener(vsOnly, exec).openInIde('/p');
    expect(opens(calls)).toEqual([
      ['-a', '/Applications/WebStorm.app', '/p'],
      ['-a', '/Applications/Visual Studio Code.app', '/p'],
    ]);
  });

  it('uses the chosen IDE, and says so when it is gone', async () => {
    const { exec, calls } = fakeExec('off');
    await opener(both(), exec, { ideSetting: () => VSCODE }).openInIde('/p');
    expect(opens(calls)).toEqual([['-a', '/Applications/Visual Studio Code.app', '/p']]);
    const gone = opener(fakeFs(app('/Applications/WebStorm.app', WEBSTORM)), exec, {
      ideSetting: () => VSCODE,
    });
    await expect(gone.openInIde('/p')).rejects.toMatchObject({
      code: 'ide_not_installed',
      status: 409,
    });
    expect(await gone.effectiveIde()).toBeUndefined();
  });

  it('refuses with no_ide when none is installed', async () => {
    const { exec, calls } = fakeExec('off');
    await expect(opener(fakeFs({}), exec).openInIde('/p')).rejects.toMatchObject({
      code: 'no_ide',
    });
    expect(opens(calls)).toEqual([]);
  });
});

describe('Opener: application fingerprints (decision 128)', () => {
  it('changes when a bundle’s executable or Info.plist changes, not otherwise', async () => {
    const fs = fakeFs(app('/p/My.app', 'com.example.my', 'my'));
    const { exec } = fakeExec('off');
    const o = opener(fs, exec);
    const first = await o.fingerprint('/p/My.app');
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await o.fingerprint('/p/My.app')).toBe(first);

    fs.set('/p/My.app/Contents/MacOS/my', { data: 'binary', size: 101, mtimeMs: 5000 });
    const exeSize = await o.fingerprint('/p/My.app');
    expect(exeSize).not.toBe(first);
    fs.set('/p/My.app/Contents/MacOS/my', { data: 'binary', size: 101, mtimeMs: 6000 });
    const exeTime = await o.fingerprint('/p/My.app');
    expect(exeTime).not.toBe(exeSize);
    fs.set('/p/My.app/Contents/Info.plist', {
      data: plist('com.example.my', 'my').replace(
        '</dict>',
        '<key>X</key><string>1</string></dict>',
      ),
    });
    expect(await o.fingerprint('/p/My.app')).not.toBe(exeTime);
  });

  it('changes when any file of the bundle changes: added, touched (ctime) or resized', async () => {
    const fs = fakeFs(app('/p/My.app', 'com.example.my', 'my'));
    const o = opener(fs, fakeExec('off').exec);
    const first = await o.fingerprint('/p/My.app');
    fs.set('/p/My.app/Contents/Resources/payload.js', { data: 'evil()' });
    const added = await o.fingerprint('/p/My.app');
    expect(added).not.toBe(first);
    fs.set('/p/My.app/Contents/Resources/payload.js', { data: 'evil()', ctimeMs: 2000 });
    const touched = await o.fingerprint('/p/My.app');
    expect(touched).not.toBe(added);
    fs.set('/p/My.app/Contents/Resources/payload.js', { data: 'evil()!', ctimeMs: 2000 });
    expect(await o.fingerprint('/p/My.app')).not.toBe(touched);
  });

  it('marks a bundle past the entry cap as too large: a confirmation never covers it', async () => {
    const entries: Record<string, FakeEntry> = app('/p/Big.app', 'com.example.big');
    for (let i = 0; i < 30; i++) entries[`/p/Big.app/Contents/Resources/f${i}`] = { data: 'x' };
    const fs = fakeFs(entries);
    const o = opener(fs, fakeExec('off').exec, { fingerprintMaxEntries: 10 });
    const fp = await o.fingerprint('/p/Big.app');
    expect(fp.startsWith(TOO_LARGE_FINGERPRINT)).toBe(true);
    expect(await o.fingerprint('/p/Big.app')).toBe(fp); // deterministic, so a fresh confirm works
    expect(confirmationCovers(fp, fp)).toBe(false);
    const small = await opener(fs, fakeExec('off').exec).fingerprint('/p/Big.app');
    expect(small).toMatch(/^sha256:/);
    expect(confirmationCovers(small, small)).toBe(true);
    expect(confirmationCovers(undefined, small)).toBe(false);
  });

  it('follows the plist when it names another executable', async () => {
    const fs = fakeFs({
      ...app('/p/My.app', 'com.example.my', 'a'),
      '/p/My.app/Contents/MacOS/b': { data: 'other', size: 7, mtimeMs: 1 },
    });
    const o = opener(fs, fakeExec('off').exec);
    const before = await o.fingerprint('/p/My.app');
    fs.set('/p/My.app/Contents/Info.plist', { data: plist('com.example.my', 'b') });
    expect(await o.fingerprint('/p/My.app')).not.toBe(before);
  });

  it('fingerprints a file by (dev, ino, size, mtime, ctime)', async () => {
    const fs = fakeFs({ '/p/run.command': { data: 'echo hi', ino: 7, mtimeMs: 1 } });
    const o = opener(fs, fakeExec('off').exec);
    const a = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi', ino: 8, mtimeMs: 1 }); // replaced in place
    const b = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi!', ino: 8, mtimeMs: 1 });
    const c = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi!', ino: 8, mtimeMs: 2 });
    const d = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi!', ino: 8, mtimeMs: 2, ctimeMs: 3 }); // chmod
    const e = await o.fingerprint('/p/run.command');
    expect(new Set([a, b, c, d, e]).size).toBe(5);
  });
});

describe('plistString', () => {
  it('reads a top-level string and decodes entities', () => {
    expect(plistString(plist('com.a&amp;b'), 'CFBundleIdentifier')).toBe('com.a&b');
    expect(plistString(plist('x'), 'CFBundleName')).toBeUndefined();
  });

  it('reads top-level keys only, not a nested one of the same name', () => {
    const xml =
      '<plist version="1.0"><dict>' +
      '<key>CFBundleDocumentTypes</key><array><dict>' +
      '<key>CFBundleIdentifier</key><string>com.evil.nested</string>' +
      '</dict></array>' +
      '<key>Flag</key><true/>' +
      '<key>Empty</key><dict/>' +
      '<key>CFBundleIdentifier</key><string>com.real.app</string>' +
      '<key>Count</key><integer>3</integer>' +
      '</dict></plist>';
    expect(plistString(xml, 'CFBundleIdentifier')).toBe('com.real.app');
    expect(plistString(xml, 'Count')).toBeUndefined();
    expect(plistString(xml, 'Flag')).toBeUndefined();
    const nestedOnly =
      '<plist><dict><key>Inner</key><dict><key>CFBundleExecutable</key><string>x</string></dict></dict></plist>';
    expect(plistString(nestedOnly, 'CFBundleExecutable')).toBeUndefined();
  });
});

describe('requireLocal (decision 131)', () => {
  const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:4321' } };
  const remote = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'mac.tail1234.ts.net', 'x-forwarded-for': '100.64.0.2' },
  };

  it('lets the Mac open, never a remote client, autoApproveRemote or not', () => {
    expect(requireLocal(local, { always: true })).toBeUndefined();
    expect(requireLocal(remote, { always: true })).toMatchObject({
      error: 'remote_control',
      message: expect.stringMatching(/never from a remote client/),
    });
    expect(requireLocal(remote, { always: true, autoApproveRemote: true })).toMatchObject({
      error: 'remote_control',
    });
  });

  it('applies the decision-51 rule without always', () => {
    expect(requireLocal(remote)).toMatchObject({ error: 'remote_control' });
    expect(requireLocal(remote, { autoApproveRemote: true })).toBeUndefined();
    expect(requireLocal(local)).toBeUndefined();
  });
});
