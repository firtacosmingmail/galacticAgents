import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeResponse, SettingsResponse } from '@galactic/protocol';
import { SettingsService } from '../config/settings.js';
import { openDatabase } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { MDFIND, OPEN, Opener, type ExecFile, type OpenerFs } from '../deliverables/opener.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * `GET /api/ide` and the IDE setting through `PATCH /api/settings` (P9-03; TECHNOLOGY §9.7,
 * §9.9). The opener runs on a fake `execFile` and file system: nothing is opened or scanned.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const WEBSTORM = 'com.jetbrains.WebStorm';
const VSCODE = 'com.microsoft.VSCode';
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };

/** Spotlight knows `apps` (bundle id → path); the paths exist; `open` is recorded, never run. */
function fakes(apps: Record<string, string>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecFile = async (file, args) => {
    calls.push({ file, args });
    if (file === MDFIND) {
      const id = /'([^']+)'/.exec(args[0]!)?.[1] ?? '';
      return { stdout: apps[id] ? `${apps[id]}\n` : '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const paths = new Set(Object.values(apps));
  const fs: OpenerFs = {
    readdir: async () => [],
    readFile: async () => {
      throw new Error('ENOENT');
    },
    lstat: async () => {
      throw new Error('ENOENT');
    },
    exists: async (p) => paths.has(p),
  };
  return { exec, fs, calls };
}

async function ideApp(apps: Record<string, string>, platform: NodeJS.Platform = 'darwin') {
  const config = testConfig();
  writeFileSync(config.configPath, JSON.stringify({ token: TEST_TOKEN }), { mode: 0o600 });
  const { exec, fs, calls } = fakes(apps);
  const opener = new Opener({
    execFile: exec,
    fs,
    platform,
    home: '/Users/nobody',
    ideSetting: () => config.deliverables?.ide ?? 'auto',
  });
  const settings = new SettingsService({ config, ides: opener });
  const log = new EventLog(openDatabase(':memory:'));
  const t = await startTestApp({ config, log, settings, opener });
  cleanups.push(() => t.stop());
  const call = async (method: string, path: string, body?: unknown, headers = {}) => {
    const res = await fetch(`${t.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const file = () => JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, unknown>;
  return { t, config, opener, calls, call, file };
}

describe('GET /api/ide (P9-03)', () => {
  it('lists the installed IDEs, the setting and the one Open in IDE uses', async () => {
    const { call, calls } = await ideApp({
      [VSCODE]: '/Applications/Visual Studio Code.app',
      [WEBSTORM]: '/Applications/WebStorm.app',
    });
    const res = IdeResponse.parse((await call('GET', '/api/ide')).body);
    expect(res).toEqual({
      supported: true,
      installed: [
        { bundleId: WEBSTORM, name: 'WebStorm', path: '/Applications/WebStorm.app' },
        {
          bundleId: VSCODE,
          name: 'Visual Studio Code',
          path: '/Applications/Visual Studio Code.app',
        },
      ],
      setting: 'auto',
      effective: { bundleId: WEBSTORM, name: 'WebStorm', path: '/Applications/WebStorm.app' },
    });
    expect(calls.some((c) => c.file === OPEN)).toBe(false);
  });

  it('is open to a remote client (the phone shows it read-only)', async () => {
    const { call } = await ideApp({ [WEBSTORM]: '/Applications/WebStorm.app' });
    const res = await call('GET', '/api/ide', undefined, REMOTE);
    expect(res.status).toBe(200);
    expect(IdeResponse.parse(res.body).installed).toHaveLength(1);
  });

  it('needs the token', async () => {
    const { t } = await ideApp({});
    expect((await fetch(`${t.baseUrl}/api/ide`)).status).toBe(401);
  });

  it('says when the server is not on a Mac', async () => {
    const { call } = await ideApp({ [WEBSTORM]: '/Applications/WebStorm.app' }, 'linux');
    expect(IdeResponse.parse((await call('GET', '/api/ide')).body)).toEqual({
      supported: false,
      installed: [],
      setting: 'auto',
    });
  });
});

describe('the IDE setting over PATCH /api/settings (P9-03)', () => {
  it('detects before checking, so an installed IDE is accepted on the first try', async () => {
    const { call, config, file } = await ideApp({
      [WEBSTORM]: '/Applications/WebStorm.app',
      [VSCODE]: '/Applications/Visual Studio Code.app',
    });
    const res = await call('PATCH', '/api/settings', { deliverables: { ide: VSCODE } });
    expect(res.status).toBe(200);
    expect(SettingsResponse.parse(res.body).settings.deliverables).toEqual({ ide: VSCODE });
    expect(file()['deliverables']).toEqual({ ide: VSCODE });
    expect(config.deliverables?.ide).toBe(VSCODE);
    const ide = IdeResponse.parse((await call('GET', '/api/ide')).body);
    expect(ide.setting).toBe(VSCODE);
    expect(ide.effective?.bundleId).toBe(VSCODE);
  });

  it('refuses an IDE that is not installed (400 invalid) and writes nothing', async () => {
    const { call, file } = await ideApp({ [WEBSTORM]: '/Applications/WebStorm.app' });
    const before = file();
    const res = await call('PATCH', '/api/settings', { deliverables: { ide: VSCODE } });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid' } });
    const path = await call('PATCH', '/api/settings', {
      deliverables: { ide: '/Applications/Terminal.app' },
    });
    expect(path).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(file()).toEqual(before);
  });

  it('refuses a remote client (403 remote_settings) without detecting', async () => {
    const { call, calls, file } = await ideApp({ [WEBSTORM]: '/Applications/WebStorm.app' });
    const before = file();
    const res = await call('PATCH', '/api/settings', { deliverables: { ide: WEBSTORM } }, REMOTE);
    expect(res).toMatchObject({ status: 403, body: { error: 'remote_settings' } });
    expect(calls).toEqual([]);
    expect(file()).toEqual(before);
  });
});
