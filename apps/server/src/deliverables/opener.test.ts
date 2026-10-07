import { describe, expect, it } from 'vitest';
import { KNOWN_IDES } from '@galactic/protocol';
import { requireLocal } from '../http/security.js';
import {
  MDFIND,
  OPEN,
  Opener,
  OpenerError,
  PLUTIL,
  plistString,
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
  ino?: number;
}

/** A file system of absolute paths; folders are implied by their children or marked `dir`. */
function fakeFs(entries: Record<string, FakeEntry>): OpenerFs & {
  set(path: string, e: FakeEntry): void;
  reads: string[];
} {
  const files = new Map(Object.entries(entries));
  const reads: string[] = [];
  const isDir = (p: string) =>
    files.get(p)?.dir === true || [...files.keys()].some((k) => k.startsWith(p + '/'));
  return {
    reads,
    set: (p, e) => void files.set(p, e),
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
        size: e?.size ?? (e?.data ? Buffer.byteLength(e.data) : 0),
        mtimeMs: e?.mtimeMs ?? 1000,
        isDirectory: () => dir,
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

  it('opens a folder in the IDE by bundle id: open -b <id> <folder>', async () => {
    const { exec, calls } = fakeExec();
    const o = opener(fakeFs(app('/Applications/WebStorm.app', WEBSTORM)), exec);
    const used = await o.openInIde('/Users/me/GalacticProjects/my-app');
    expect(used).toEqual({
      bundleId: WEBSTORM,
      name: 'WebStorm',
      path: '/Applications/WebStorm.app',
    });
    expect(opens(calls)).toEqual([['-b', WEBSTORM, '/Users/me/GalacticProjects/my-app']]);
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
      ['-b', WEBSTORM, '/p'],
      ['-b', VSCODE, '/p'],
    ]);
  });

  it('uses the chosen IDE, and says so when it is gone', async () => {
    const { exec, calls } = fakeExec('off');
    await opener(both(), exec, { ideSetting: () => VSCODE }).openInIde('/p');
    expect(opens(calls)).toEqual([['-b', VSCODE, '/p']]);
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

  it('fingerprints a file by (dev, ino, size, mtime)', async () => {
    const fs = fakeFs({ '/p/run.command': { data: 'echo hi', ino: 7, mtimeMs: 1 } });
    const o = opener(fs, fakeExec('off').exec);
    const a = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi', ino: 8, mtimeMs: 1 }); // replaced in place
    const b = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi!', ino: 8, mtimeMs: 1 });
    const c = await o.fingerprint('/p/run.command');
    fs.set('/p/run.command', { data: 'echo hi!', ino: 8, mtimeMs: 2 });
    const d = await o.fingerprint('/p/run.command');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('plistString', () => {
  it('reads a top-level string and decodes entities', () => {
    expect(plistString(plist('com.a&amp;b'), 'CFBundleIdentifier')).toBe('com.a&b');
    expect(plistString(plist('x'), 'CFBundleName')).toBeUndefined();
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
    expect(requireLocal(remote, { always: true })).toMatchObject({ error: 'remote_never' });
    expect(requireLocal(remote, { always: true, autoApproveRemote: true })).toMatchObject({
      error: 'remote_never',
    });
  });

  it('applies the decision-51 rule without always', () => {
    expect(requireLocal(remote)).toMatchObject({ error: 'remote_control' });
    expect(requireLocal(remote, { autoApproveRemote: true })).toBeUndefined();
    expect(requireLocal(local)).toBeUndefined();
  });
});
