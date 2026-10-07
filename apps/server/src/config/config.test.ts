import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_TOKEN } from '@galactic/protocol';
import { DEFAULT_PORT, DEFAULT_PROJECTS_DIR, dataPaths, loadConfig } from './config.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'galactic-config-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('reads the Steward runtime and the ACP agent command (P8-07)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        stewardRuntime: 'acp',
        acp: { command: 'gemini', args: ['--acp'], passEnv: ['GEMINI_API_KEY'] },
      }),
    );
    const fromFile = loadConfig({ GALACTIC_HOME: home }).config;
    expect(fromFile.stewardRuntime).toBe('acp');
    expect(fromFile.acp).toEqual({
      command: 'gemini',
      args: ['--acp'],
      passEnv: ['GEMINI_API_KEY'],
    });
    expect(fromFile.envOverrides).not.toContain('stewardRuntime');
    const fromEnv = loadConfig({
      GALACTIC_HOME: home,
      GALACTIC_STEWARD_RUNTIME: 'claude-sdk',
      GALACTIC_ACP_COMMAND: ' codex-acp  --verbose ',
    }).config;
    expect(fromEnv.stewardRuntime).toBe('claude-sdk');
    expect(fromEnv.envOverrides).toContain('stewardRuntime');
    expect(fromEnv.acp).toEqual({
      command: 'codex-acp',
      args: ['--verbose'],
      passEnv: ['GEMINI_API_KEY'],
    });
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_STEWARD_RUNTIME: 'cursor' })).toThrow(
      /Steward runtime/,
    );
  });

  it('reads acp.mode and allowPermissiveMode; refuses GALACTIC_* in passEnv; a JSON command', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        acp: { command: 'codex-acp', mode: 'read-only', allowPermissiveMode: false },
      }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.acp).toEqual({
      command: 'codex-acp',
      mode: 'read-only',
      allowPermissiveMode: false,
    });
    expect(
      loadConfig({
        GALACTIC_HOME: home,
        GALACTIC_ACP_COMMAND: '["/opt/my agent/bin/acp", "--flag", "a b"]',
      }).config.acp,
    ).toEqual({
      command: '/opt/my agent/bin/acp',
      args: ['--flag', 'a b'],
      mode: 'read-only',
      allowPermissiveMode: false,
    });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        acp: {
          command: 'claude-agent-acp',
          userSettings: true,
          sessionMeta: { claudeCode: { options: { settingSources: ['project'] } } },
        },
      }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.acp).toEqual({
      command: 'claude-agent-acp',
      userSettings: true,
      sessionMeta: { claudeCode: { options: { settingSources: ['project'] } } },
    });
    expect(() =>
      loadConfig({ GALACTIC_HOME: home, GALACTIC_ACP_COMMAND: '["unterminated' }),
    ).toThrow(/not a JSON array/);
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_ACP_COMMAND: '[]' })).toThrow(
      /non-empty JSON array/,
    );
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        acp: { command: 'x', passEnv: ['GEMINI_API_KEY', 'GALACTIC_TOKEN'] },
      }),
    );
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow(/GALACTIC_\*/);
  });

  it('reads the terminal agent (P8-08): file, GALACTIC_PTY_COMMAND, GALACTIC_* refused', () => {
    const pty = {
      command: 'aider',
      args: ['--no-auto-commits'],
      passEnv: ['OPENAI_API_KEY'],
      idlePattern: '^> $',
      questionPatterns: [{ pattern: 'Ready\\s*$', kind: 'permission', yes: 'go' }],
      clarificationPatterns: ['Name:\\s*$'],
      quietMs: 500,
      idleAfterMs: 5_000,
    };
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', pty }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.pty).toEqual(pty);
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_PTY_COMMAND: '["/opt/my cli", "-q"]' }).config.pty,
    ).toEqual({ ...pty, command: '/opt/my cli', args: ['-q'] });
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_PTY_COMMAND: '[]' })).toThrow(
      /GALACTIC_PTY_COMMAND must be/,
    );
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        pty: { command: 'x', passEnv: ['GALACTIC_TOKEN'] },
      }),
    );
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow(/GALACTIC_\*/);
    // Fail closed (decision 112): a free-form shape is a clarification pattern, not a question one.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        pty: { command: 'x', questionPatterns: [{ pattern: 'Name:', kind: 'clarification' }] },
      }),
    );
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow(/clarificationPatterns/);
  });

  it('drops a fake Steward runtime outside dev mode, with a warning (P8 wave 3 review)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', stewardRuntime: 'fake' }),
    );
    const fromFile = loadConfig({ GALACTIC_HOME: home });
    expect(fromFile.config.stewardRuntime).toBeUndefined();
    expect(fromFile.warnings).toContainEqual(expect.stringMatching(/stewardRuntime is fake/));
    const fromEnv = loadConfig({ GALACTIC_HOME: home, GALACTIC_STEWARD_RUNTIME: 'fake' });
    expect(fromEnv.config.stewardRuntime).toBeUndefined();
    expect(fromEnv.warnings).toContainEqual(expect.stringMatching(/development only/));
    const dev = loadConfig({ GALACTIC_HOME: home, GALACTIC_DEV: '1' });
    expect(dev.config.stewardRuntime).toBe('fake');
    expect(dev.warnings.some((w) => w.includes('stewardRuntime'))).toBe(false);
  });

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

  it('reads the retention period in days, default 7 (P2-13, decision 4)', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(loadConfig({ GALACTIC_HOME: home }).config.retentionMs).toBe(7 * day);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', retentionDays: 2 }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.retentionMs).toBe(2 * day);
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_RETENTION_DAYS: '0.5' }).config.retentionMs,
    ).toBe(day / 2);
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_RETENTION_DAYS: '0' })).toThrow(
      /retention/,
    );
  });

  it('reads the spawn caps from the file and the environment, with defaults (P2-17)', () => {
    expect(loadConfig({ GALACTIC_HOME: home }).config.caps).toEqual({
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      defaults: { maxWallClockMs: 7_200_000, maxToolCalls: 500 },
    });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        caps: { maxStewardsPerWaykeeper: 2, maxSpawnsPerHour: 10 },
      }),
    );
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_MAX_SPAWNS_PER_HOUR_PER_BRAIN: '5' }).config.caps,
    ).toEqual({
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 2,
      maxSpawnsPerHour: 10,
      maxSpawnsPerHourPerBrain: 5,
      defaults: { maxWallClockMs: 7_200_000, maxToolCalls: 500 },
    });
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_MAX_CONCURRENT_AGENTS: '8' }).config.caps
        .maxConcurrentAgents,
    ).toBe(8);
    expect(() =>
      loadConfig({ GALACTIC_HOME: home, GALACTIC_MAX_STEWARDS_PER_WAYKEEPER: '0' }),
    ).toThrow(/maxStewardsPerWaykeeper/);
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_MAX_SPAWNS_PER_HOUR: 'x' })).toThrow(
      /maxSpawnsPerHour/,
    );
  });

  it('reads the panel settings and records what the environment decides (P25-01)', () => {
    const plain = loadConfig({ GALACTIC_HOME: home }).config;
    expect(plain.defaultPermissionPolicy).toBeUndefined();
    expect(plain.qualityTier).toBeUndefined();
    expect(plain.stewardsLoadUserSettings).toBeUndefined();
    expect(plain.envOverrides).toEqual([]);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        caps: { maxWallClockMs: 600_000, maxToolCalls: 50 },
        defaultPermissionPolicy: { rules: { network: 'allow' } },
        qualityTier: 'mobile',
        stewardsLoadUserSettings: false,
      }),
    );
    const { config } = loadConfig({
      GALACTIC_HOME: home,
      GALACTIC_RETENTION_DAYS: '3',
      GALACTIC_MAX_SPAWNS_PER_HOUR: '9',
    });
    expect(config.caps.defaults).toEqual({ maxWallClockMs: 600_000, maxToolCalls: 50 });
    expect(config.defaultPermissionPolicy).toEqual({ rules: { network: 'allow' } });
    expect(config.qualityTier).toBe('mobile');
    expect(config.stewardsLoadUserSettings).toBe(false);
    expect(config.envOverrides).toEqual(['retentionDays', 'caps']);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', qualityTier: 'ultra' }),
    );
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow();
  });

  it('reads a hand-edited first-run marker leniently (P25-08)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', setupCompletedAt: 'yesterday' }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.setupCompletedAt).toBe('yesterday');
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

  it('adds remoteHost to the allow-list and accepts identity logins only with it (P7-02)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        remoteHost: 'mymac.tail1234.ts.net',
        tailscaleIdentityLogins: ['Me@Example.com'],
      }),
    );
    const { config, warnings } = loadConfig({ GALACTIC_HOME: home });
    expect(config.remoteHost).toBe('mymac.tail1234.ts.net');
    expect(config.allowedHosts).toContain('mymac.tail1234.ts.net');
    expect(config.allowedHosts).not.toContain('*.ts.net');
    expect(config.tailscaleIdentityLogins).toEqual(['me@example.com']);
    expect(warnings.join('\n')).toMatch(/any process on this machine/);
    expect(warnings.join('\n')).toMatch(/only HTTP-mode Tailscale Serve.*X-Forwarded-For/);
    expect(warnings.join('\n')).not.toContain('file-token-0123456789abcdef');

    // The environment names the host too.
    expect(
      loadConfig({ GALACTIC_HOME: home, GALACTIC_REMOTE_HOST: 'Other.tail1234.ts.net' }).config
        .remoteHost,
    ).toBe('other.tail1234.ts.net');

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'file-token-0123456789abcdef',
        tailscaleIdentityLogins: ['me@example.com'],
      }),
    );
    const without = loadConfig({ GALACTIC_HOME: home });
    expect(without.config.tailscaleIdentityLogins).toBeUndefined();
    expect(without.warnings.join('\n')).toMatch(/ignored: it needs remoteHost/);
  });

  it('refuses a remoteHost that is not an exact name, and warns about a ts.net wildcard', () => {
    for (const bad of [
      '*.ts.net',
      'https://mymac.ts.net',
      'mymac.ts.net:443',
      'mymac',
      'my mac.ts.net',
    ]) {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ token: 'file-token-0123456789abcdef', remoteHost: bad }),
      );
      expect(() => loadConfig({ GALACTIC_HOME: home }), bad).toThrow();
    }
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef' }),
    );
    expect(() =>
      loadConfig({
        GALACTIC_HOME: home,
        GALACTIC_TOKEN: 'env-token-0123456789abcdef',
        GALACTIC_REMOTE_HOST: '*.ts.net',
      }),
    ).toThrow(/Invalid remote host/);

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef', allowedHosts: ['*.ts.net'] }),
    );
    const { config, warnings } = loadConfig({ GALACTIC_HOME: home });
    expect(config.allowedHosts).toContain('*.ts.net');
    expect(warnings.join('\n')).toMatch(/wildcard \*\.ts\.net.*Funnel/);
  });

  it('refuses the identity stand-in as a token, in the file and the environment', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token: IDENTITY_TOKEN }));
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow(/reserved/);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef' }),
    );
    expect(() => loadConfig({ GALACTIC_HOME: home, GALACTIC_TOKEN: IDENTITY_TOKEN })).toThrow(
      /reserved/,
    );
  });

  it('warns about other tunnels only when remote access is set up', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token: 'file-token-0123456789abcdef' }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).warnings.join('\n')).not.toMatch(/HTTP-mode/);
  });

  it('reads the backups setting (P8-03), the environment switching the schedule on or off', () => {
    const token = 'file-token-0123456789abcdef';
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token }));
    expect(loadConfig({ GALACTIC_HOME: home }).config.backups).toBeUndefined();
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ token, backups: { keepDaily: 3, keepWeekly: 2, reserveMiB: 10 } }),
    );
    expect(loadConfig({ GALACTIC_HOME: home }).config.backups).toEqual({
      keepDaily: 3,
      keepWeekly: 2,
      reserveBytes: 10 * 2 ** 20,
    });
    expect(loadConfig({ GALACTIC_HOME: home, GALACTIC_BACKUPS: '0' }).config.backups).toMatchObject(
      {
        enabled: false,
      },
    );
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token, backups: { keepDaily: -1 } }));
    expect(() => loadConfig({ GALACTIC_HOME: home })).toThrow();
  });

  it('names the data paths without touching the disk', () => {
    expect(dataPaths({ GALACTIC_HOME: home })).toEqual({
      dataDir: home,
      configPath: join(home, 'config.json'),
      dbPath: join(home, 'galactic.sqlite'),
    });
    expect(dataPaths({ GALACTIC_HOME: home, GALACTIC_DB: '/x/y.sqlite' }).dbPath).toBe(
      '/x/y.sqlite',
    );
  });
});
