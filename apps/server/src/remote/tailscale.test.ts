import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeTailscale, forwarding, TS_NAME } from '../test/fake-tailscale.js';
import {
  addRemoteHost,
  classifyServe,
  findTailscale,
  parseStatus,
  prepareRemoteHost,
  readTailscale,
  remoteHostState,
  startServe,
  TAILSCALE_APP_CLI,
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
  it('prefers tailscale on the PATH, then the Mac app CLI, else none', async () => {
    const ts = fakeTailscale();
    expect(await findTailscale(ts.exec, ts.exists)).toBe('tailscale');
    ts.state.installed = false;
    ts.state.appCli = true;
    expect(await findTailscale(ts.exec, ts.exists)).toBe(TAILSCALE_APP_CLI);
    ts.state.appCli = false;
    expect(await findTailscale(ts.exec, ts.exists)).toBeUndefined();
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
    const self = await readTailscale('tailscale', ts.exec);
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
    expect(
      classifyServe({ TCP: { '443': { TCPForward: '127.0.0.1:4321' } } }, TS_NAME, 4321),
    ).toBe('taken_by_other');
  });
  it('Funnel on anywhere wins over everything', () => {
    expect(
      classifyServe(
        { ...forwarding(4321), AllowFunnel: { [`${TS_NAME}:443`]: true } },
        TS_NAME,
        4321,
      ),
    ).toBe('funnel_on');
    expect(classifyServe({ AllowFunnel: { [`${TS_NAME}:8443`]: true } }, TS_NAME, 4321)).toBe(
      'funnel_on',
    );
    expect(classifyServe({ AllowFunnel: { [`${TS_NAME}:443`]: false } }, TS_NAME, 4321)).toBe(
      'absent',
    );
  });
});

describe('starting Serve', () => {
  it('runs exactly the HTTP-mode command, with an argument array', async () => {
    const ts = fakeTailscale();
    await startServe('tailscale', ts.exec, 4321);
    expect(ts.writes()).toEqual([
      ['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:4321'],
    ]);
    await expect(startServe('tailscale', ts.exec, 0)).rejects.toThrow('not a port');
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
  });

  it('before a desktop-started server: added when missing, never changed, skipped without Tailscale', async () => {
    const home = tempHome();
    const configPath = join(home, 'sub', 'config.json');
    const ts = fakeTailscale();
    const prepare = (env: NodeJS.ProcessEnv = {}) =>
      prepareRemoteHost({ configPath, env, exec: ts.exec, exists: ts.exists });
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
});
