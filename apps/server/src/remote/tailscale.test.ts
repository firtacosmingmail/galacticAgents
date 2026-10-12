import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeTailscale, forwarding, TS_BIN, TS_NAME } from '../test/fake-tailscale.js';
import {
  addRemoteHost,
  classifyServe,
  findTailscale,
  funnelOn,
  parseStatus,
  prepareRemoteHost,
  readTailscale,
  remoteHostState,
  startServe,
  TAILSCALE_APP_CLI,
  tailscaleEnv,
} from './tailscale.js';

const dirs: string[] = [];
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'galactic-remote-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('finding and reading Tailscale (P9-16)', () => {
  it('prefers the Mac app CLI, then Homebrew, then the PATH (logged), else none', async () => {
    const ts = fakeTailscale({ appCli: true, pathDir: '/Users/me/bin' });
    const find = (log?: (line: string) => void) =>
      findTailscale({ ...ts.locate, exec: ts.exec, ...(log ? { log } : {}) });
    expect(await find()).toBe(TAILSCALE_APP_CLI);
    ts.state.appCli = false;
    expect(await find()).toBe(TS_BIN);
    ts.state.installed = false;
    const logged: string[] = [];
    expect(await find((l) => logged.push(l))).toBe('/Users/me/bin/tailscale');
    expect(logged).toEqual(['tailscale: using /Users/me/bin/tailscale (found on the PATH)']);
    delete ts.state.pathDir;
    expect(await find()).toBeUndefined();
    // Never a bare name for execFile to look up.
    expect(ts.calls.some(([file]) => file === 'tailscale')).toBe(false);
  });

  it('skips a binary writable by others, or owned by another user, or not answering', async () => {
    const ts = fakeTailscale({ appCli: true, writable: [TAILSCALE_APP_CLI] });
    const find = () => findTailscale({ ...ts.locate, exec: ts.exec });
    expect(await find()).toBe(TS_BIN);
    ts.state.writable = [TAILSCALE_APP_CLI, '/opt/homebrew/bin'];
    expect(await find()).toBeUndefined();

    const otherOwner = {
      ...ts.fs,
      stat: (p: string) => ({ ...ts.fs.stat(p), uid: 777 }),
    };
    ts.state.writable = [];
    expect(await findTailscale({ ...ts.locate, fs: otherOwner, exec: ts.exec })).toBeUndefined();
    expect(await findTailscale({ ...ts.locate, uid: 777, fs: otherOwner, exec: ts.exec })).toBe(
      TAILSCALE_APP_CLI,
    );

    const silent = () => Promise.reject(new Error('killed'));
    expect(await findTailscale({ ...ts.locate, exec: silent })).toBeUndefined();
  });

  it('runs the real path of a symlink', async () => {
    const ts = fakeTailscale();
    const cellar = '/opt/homebrew/Cellar/tailscale/1.90.0/bin/tailscale';
    const fs = {
      ...ts.fs,
      realpath: (p: string) => (p === TS_BIN ? cellar : ts.fs.realpath(p)),
      stat: (p: string) =>
        ts.fs.stat(p === cellar ? TS_BIN : p === dirname(cellar) ? '/opt/homebrew/bin' : p),
    };
    const exec = (file: string, args: readonly string[]) =>
      ts.exec(file === cellar ? TS_BIN : file, args);
    expect(await findTailscale({ ...ts.locate, fs, exec })).toBe(cellar);
  });

  it('maps BackendState and keeps only a ts.net MagicDNS name', () => {
    expect(
      parseStatus({ BackendState: 'Running', Self: { DNSName: 'MyMac.Tail1234.ts.net.' } }),
    ).toEqual({ state: 'running', backendState: 'Running', name: TS_NAME });
    expect(parseStatus({ BackendState: 'Stopped', Self: { DNSName: `${TS_NAME}.` } })).toEqual({
      state: 'stopped',
      backendState: 'Stopped',
    });
    expect(parseStatus({ BackendState: 'NeedsLogin' }).state).toBe('needs_login');
    expect(parseStatus({ BackendState: 'NeedsMachineAuth' }).state).toBe('needs_login');
    expect(parseStatus({ BackendState: 'Running', Self: { DNSName: '' } }).name).toBeUndefined();
    expect(
      parseStatus({ BackendState: 'Running', Self: { DNSName: 'mymac.example.com.' } }).name,
    ).toBeUndefined();
    expect(parseStatus(undefined).state).toBe('stopped');
  });

  it('a status that cannot be read is stopped, with the detail', async () => {
    const ts = fakeTailscale({ statusFails: true });
    const self = await readTailscale(TS_BIN, ts.exec);
    expect(self.state).toBe('stopped');
    expect(self.detail).toContain('tailscaled');
  });
});

describe('classifying Serve on 443', () => {
  it('forwarding exactly / to our port over HTTP is ours', () => {
    expect(classifyServe(forwarding(4321), TS_NAME, 4321)).toBe('forwarding_to_us');
  });
  it('nothing served is absent', () => {
    expect(classifyServe({}, TS_NAME, 4321)).toBe('absent');
    expect(classifyServe(undefined, TS_NAME, 4321)).toBe('absent');
  });
  it('another port, another path, another name or a TCP forward is taken', () => {
    expect(classifyServe(forwarding(5173), TS_NAME, 4321)).toBe('taken_by_other');
    const twoPaths = {
      Web: {
        [`${TS_NAME}:443`]: {
          Handlers: {
            '/': { Proxy: 'http://127.0.0.1:4321' },
            '/grafana': { Proxy: 'http://127.0.0.1:3000' },
          },
        },
      },
    };
    expect(classifyServe(twoPaths, TS_NAME, 4321)).toBe('taken_by_other');
    expect(classifyServe(forwarding(4321, 'other.tail1234.ts.net'), TS_NAME, 4321)).toBe(
      'taken_by_other',
    );
    expect(classifyServe({ TCP: { '443': { TCPForward: '127.0.0.1:4321' } } }, TS_NAME, 4321)).toBe(
      'taken_by_other',
    );
  });
  it('Funnel is its own question: a Serve of ours with Funnel on is still ours', () => {
    const withFunnel = { ...forwarding(4321), AllowFunnel: { [`${TS_NAME}:443`]: true } };
    expect(classifyServe(withFunnel, TS_NAME, 4321)).toBe('forwarding_to_us');
    expect(funnelOn(withFunnel)).toBe(true);
    expect(funnelOn({ AllowFunnel: { [`${TS_NAME}:8443`]: true } })).toBe(true);
    expect(classifyServe({ AllowFunnel: { [`${TS_NAME}:8443`]: true } }, TS_NAME, 4321)).toBe(
      'absent',
    );
    expect(funnelOn({ AllowFunnel: { [`${TS_NAME}:443`]: false } })).toBe(false);
    expect(funnelOn(forwarding(4321))).toBe(false);
    expect(funnelOn(undefined)).toBe(false);
  });
});

describe('starting Serve', () => {
  it('runs exactly the HTTP-mode command, with an argument array', async () => {
    const ts = fakeTailscale();
    await startServe(TS_BIN, ts.exec, 4321);
    expect(ts.writes()).toEqual([
      [TS_BIN, 'serve', '--bg', '--https=443', 'http://127.0.0.1:4321'],
    ]);
    await expect(startServe(TS_BIN, ts.exec, 0)).rejects.toThrow('not a port');
  });
});

describe('remoteHost', () => {
  it('matches, mismatch, missing, configured', () => {
    expect(remoteHostState(TS_NAME, TS_NAME)).toBe('matches');
    expect(remoteHostState('MyMac.tail1234.ts.net', TS_NAME)).toBe('matches');
    expect(remoteHostState('other.tail1234.ts.net', TS_NAME)).toBe('mismatch');
    expect(remoteHostState(undefined, TS_NAME)).toBe('missing');
    expect(remoteHostState(TS_NAME, undefined)).toBe('configured');
  });

  it('is added to config.json (0600), keeping the rest', () => {
    const home = tempHome();
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ token: 'tok', port: 4400 }));
    addRemoteHost(configPath, TS_NAME);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      token: 'tok',
      port: 4400,
      remoteHost: TS_NAME,
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(['config.json']);
  });

  it('is written atomically: a failed write leaves config.json as it was, and no temp file', () => {
    const home = tempHome();
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ token: 'tok' }));
    // The temp file's name is taken by a folder: the write fails before config.json is touched.
    mkdirSync(`${configPath}.${process.pid}.tmp`);
    expect(() => addRemoteHost(configPath, TS_NAME)).toThrow();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ token: 'tok' });
  });

  it('before a desktop-started server: added when missing, never changed, skipped without Tailscale', async () => {
    const home = tempHome();
    const configPath = join(home, 'sub', 'config.json');
    const ts = fakeTailscale();
    const prepare = (env: NodeJS.ProcessEnv = {}) =>
      prepareRemoteHost({ configPath, env, exec: ts.exec, locate: ts.locate });
    expect(await prepare()).toContain(TS_NAME);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ remoteHost: TS_NAME });

    writeFileSync(configPath, JSON.stringify({ remoteHost: 'other.tail1234.ts.net' }));
    expect(await prepare()).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf8')).remoteHost).toBe('other.tail1234.ts.net');

    writeFileSync(configPath, '{}');
    expect(await prepare({ GALACTIC_REMOTE_HOST: 'x.ts.net' })).toBeUndefined();
    ts.state.backendState = 'Stopped';
    expect(await prepare()).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
    expect(ts.writes()).toEqual([]);
  });

  it('before a desktop-started server: a hung Tailscale gives up after the deadline, changing nothing', async () => {
    const home = tempHome();
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, '{}');
    const ts = fakeTailscale({ statusHangs: true });
    const started = Date.now();
    await expect(
      prepareRemoteHost({ configPath, env: {}, exec: ts.exec, locate: ts.locate, timeoutMs: 50 }),
    ).rejects.toThrow('did not answer within 50 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
  });
});

describe('the environment tailscale runs with', () => {
  it('always sets TERM: the Mac app binary acts as the CLI only with it', () => {
    expect(tailscaleEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin', TERM: 'dumb' });
    expect(tailscaleEnv({ PATH: '/usr/bin', TERM: '' })['TERM']).toBe('dumb');
    expect(tailscaleEnv({ TERM: 'xterm-256color' })['TERM']).toBe('xterm-256color');
  });
});
