import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, DEFAULT_PROJECTS_DIR, loadConfig } from './config.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'galactic-config-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('generates a token on first start, persists it with mode 0600 and reuses it afterwards', () => {
    const first = loadConfig({ GALACTIC_HOME: home });
    expect(first.tokenGenerated).toBe(true);
    expect(first.config.token.length).toBeGreaterThanOrEqual(24);
    expect(first.config.port).toBe(DEFAULT_PORT);
    expect(first.config.host).toBe('127.0.0.1');
    expect(first.config.dbPath).toBe(join(home, 'galactic.sqlite'));

    const onDisk = JSON.parse(readFileSync(first.config.configPath, 'utf8'));
    expect(onDisk.token).toBe(first.config.token);
    if (process.platform !== 'win32') {
      expect(statSync(first.config.configPath).mode & 0o777).toBe(0o600);
    }

    const second = loadConfig({ GALACTIC_HOME: home });
    expect(second.tokenGenerated).toBe(false);
    expect(second.config.token).toBe(first.config.token);
  });

  it('lets the environment override token, port and allowed hosts', () => {
    const { config, tokenGenerated } = loadConfig({
      GALACTIC_HOME: home,
      GALACTIC_TOKEN: 'env-token-0123456789abcdef',
      GALACTIC_PORT: '5000',
      GALACTIC_ALLOWED_HOSTS: 'mymac.tail1234.ts.net, *.ts.net',
    });
    expect(tokenGenerated).toBe(false);
    expect(config.token).toBe('env-token-0123456789abcdef');
    expect(config.port).toBe(5000);
    expect(config.allowedHosts).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'mymac.tail1234.ts.net',
      '*.ts.net',
    ]);
  });

  it('enables the dev routes only with GALACTIC_DEV (P0-16)', () => {
    expect(loadConfig({ GALACTIC_HOME: home }).config.dev).toBe(false);
    expect(loadConfig({ GALACTIC_HOME: home, GALACTIC_DEV: '1' }).config.dev).toBe(true);
    expect(loadConfig({ GALACTIC_HOME: home, GALACTIC_DEV: '0' }).config.dev).toBe(false);
  });

  it('never lets a remote client loosen the policy unless configured (P2-04)', () => {
    expect(loadConfig({ GALACTIC_HOME: home }).config.autoApproveRemote).toBe(false);
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_AUTO_APPROVE_REMOTE: '1' }).config
        .autoApproveRemote,
    ).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as object;
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ ...onDisk, autoApproveRemote: true }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.autoApproveRemote).toBe(true);
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_AUTO_APPROVE_REMOTE: '0' }).config
        .autoApproveRemote,
    ).toBe(false);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_PORT: 'abc' })).toThrow(/Invalid port/);
  });

  it('defaults the projects root to ~/GalacticProjects; the file and the environment override it (P2-05)', () => {
    expect(loadConfig({ GALACTIC_HOME: home }).config.projectsRoot).toBe(
      join(homedir(), DEFAULT_PROJECTS_DIR),
    );
    const first = loadConfig({ GALACTIC_HOME: home });
    const onDisk = JSON.parse(readFileSync(first.config.configPath, 'utf8'));
    writeFileSync(
      first.config.configPath,
      JSON.stringify({ ...onDisk, projectsRoot: '~/code/galactic' }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.projectsRoot).toBe(
      join(homedir(), 'code/galactic'),
    );
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_PROJECTS_ROOT: '/srv/projects/' }).config
        .projectsRoot,
    ).toBe('/srv/projects');
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_PROJECTS_ROOT: 'rel/dir' })).toThrow(
      /absolute/,
    );
  });
});
