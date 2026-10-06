import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setGlobalDefaultPolicy } from '../domain/permissions.js';
import { loadConfig } from './config.js';
import type { TranscriptRetention as TranscriptRetentionPolicy } from '@galactic/protocol';
import type { TranscriptRetention } from '../runtime/transcript-retention.js';
import { SettingsError, SettingsService, writableFor } from './settings.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setGlobalDefaultPolicy(null);
});
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** A fresh data dir with a loaded config, and a fake home beside it. */
function setup() {
  const home = temp('galactic-home-');
  const dataDir = join(home, '.galactic');
  const env = { GALACTIC_HOME: dataDir } as NodeJS.ProcessEnv;
  const { config } = loadConfig(env);
  const settings = new SettingsService({ config, home });
  const file = () => JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, unknown>;
  return { home, dataDir, env, config, settings, file };
}
const local = { origin: 'local' as const };
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SettingsError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
};

describe('SettingsService (P25-01)', () => {
  it('saves the cleaned projects root, so the next start still loads the config', () => {
    const { env, settings, file } = setup();
    const target = join(temp('galactic-root-'), 'x');
    const res = settings.update({ projectsRoot: `  ${target}/ ` }, local);
    expect(res.settings.projectsRoot).toBe(target);
    expect(file()['projectsRoot']).toBe(target);
    expect(loadConfig(env).config.projectsRoot).toBe(target); // the restart works
  });

  it('refuses a projects root a workspace could not be either (decision 27)', () => {
    const { home, dataDir, settings, file } = setup();
    const before = file();
    const outside = temp('galactic-link-');
    const link = join(outside, 'to-data');
    symlinkSync(dataDir, link);
    mkdirSync(join(home, 'etc-like'));
    for (const [path, why] of [
      ['/', /cannot be \//],
      [home, /home directory/],
      [dataDir, /data directory/],
      [join(dataDir, 'projects'), /data directory/],
      [link, /data directory/], // through a symlink
      [join(link, 'inside'), /data directory/],
    ] as const) {
      const r = refusal(() => settings.update({ projectsRoot: path }, local));
      expect(r?.code, path).toBe('invalid');
      expect(r?.message, path).toMatch(why);
    }
    expect(file()).toEqual(before);
    // A folder in the home directory is fine.
    expect(
      settings.update({ projectsRoot: join(home, 'etc-like') }, local).settings.projectsRoot,
    ).toBe(join(home, 'etc-like'));
  });

  it('refuses `~` itself as the projects root', () => {
    const dataDir = join(temp('galactic-data-'), 'd');
    const { config } = loadConfig({ GALACTIC_HOME: dataDir } as NodeJS.ProcessEnv);
    const settings = new SettingsService({ config });
    expect(refusal(() => settings.update({ projectsRoot: '~' }, local))?.message).toMatch(
      /home directory/,
    );
  });

  it('a remote or unknown-origin request may only change the tier and tighten the policy (decision 51)', () => {
    const { settings, file } = setup();
    const before = file();
    const root = temp('galactic-root-');
    for (const patch of [
      { caps: { maxConcurrentAgents: 64 } },
      { caps: { maxSpawnsPerHour: 10_000 } },
      { caps: { maxToolCalls: 100_000 } },
      { caps: { maxWallClockMs: 60_000 } }, // even a stricter cap: settings are local-only
      { retentionDays: 0.0001 },
      { stewardsLoadUserSettings: true },
      { projectsRoot: root },
      { qualityTier: 'mobile' as const, retentionDays: 3 }, // one refused field refuses all
    ]) {
      for (const write of [{ origin: 'remote' as const }, {}]) {
        const r = refusal(() => settings.update(patch, write));
        expect(r?.code, JSON.stringify([patch, write])).toBe('remote_settings');
      }
    }
    expect(file()).toEqual(before);

    const tier = settings.update({ qualityTier: 'balanced' }, { origin: 'remote' });
    expect(tier.settings.qualityTier).toBe('balanced');
    const policy = settings.update(
      { defaultPermissionPolicy: { rules: { push: 'allow', network: 'deny' } } },
      { origin: 'remote' },
    );
    expect(policy.floored).toBe(true);
    expect(policy.settings.defaultPermissionPolicy.rules).toMatchObject({
      push: 'ask',
      network: 'deny',
    });
    // `autoApproveRemote` lifts the rule.
    const trusted = settings.update(
      { caps: { maxConcurrentAgents: 8 } },
      { origin: 'remote', autoApproveRemote: true },
    );
    expect(trusted.settings.caps.maxConcurrentAgents).toBe(8);
  });

  it('saves and applies the budget warning threshold, locally only (P8-01)', () => {
    const home = temp('galactic-home-');
    const env = { GALACTIC_HOME: join(home, '.galactic') } as NodeJS.ProcessEnv;
    const { config } = loadConfig(env);
    const watcher = { warnAtPercent: 80 };
    const settings = new SettingsService({ config, home, budgets: watcher });
    expect(settings.current().budgets).toEqual({ warnAtPercent: 80 });
    expect(refusal(() => settings.update({ budgets: { warnAtPercent: 50 } }, {}))?.code).toBe(
      'remote_settings',
    );
    const res = settings.update({ budgets: { warnAtPercent: 65 } }, local);
    expect(res.settings.budgets).toEqual({ warnAtPercent: 65 });
    expect(watcher.warnAtPercent).toBe(65);
    expect(loadConfig(env).config.budgets).toEqual({ warnAtPercent: 65 }); // the restart keeps it
    // The environment decides it: read-only in the panel.
    const locked = loadConfig({ ...env, GALACTIC_BUDGET_WARN_PERCENT: '90' }).config;
    expect(locked.budgets).toEqual({ warnAtPercent: 90 });
    expect(locked.envOverrides).toContain('budgets');
    expect(() => loadConfig({ ...env, GALACTIC_BUDGET_WARN_PERCENT: '0' })).toThrow(
      /budget warning threshold/,
    );
  });

  it('reports a hand-edited first-run marker as a timestamp, still done (P25-08)', () => {
    const { config, settings } = setup();
    config.setupCompletedAt = '2026-10-01';
    expect(settings.response().setupCompletedAt).toBe('2026-10-01T00:00:00.000Z');
    config.setupCompletedAt = 'yesterday';
    expect(settings.response().setupCompletedAt).toBe('1970-01-01T00:00:00.000Z');
    config.setupCompletedAt = '2026-10-02T10:00:00.000Z';
    expect(settings.response().setupCompletedAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('decides what a client may write as the patch does (P25-08)', () => {
    expect(writableFor({ origin: 'local' })).toBe('all');
    expect(writableFor({ origin: 'remote' })).toBe('limited');
    expect(writableFor({})).toBe('limited'); // unknown origin fails closed
    expect(writableFor({ origin: 'remote', autoApproveRemote: true })).toBe('all');
  });
});

describe('transcript retention settings (P8-02)', () => {
  it('defaults, saves key by key, applies live and survives a restart', () => {
    const { env, config, home, file } = setup();
    const job = { policy: { maxAgeDays: 90, archivedDays: 30 } as TranscriptRetentionPolicy };
    const settings = new SettingsService({
      config,
      home,
      transcriptRetention: job as unknown as TranscriptRetention,
    });
    expect(settings.current().transcriptRetention).toEqual({ maxAgeDays: 90, archivedDays: 30 });
    const res = settings.update({ transcriptRetention: { maxAgeDays: null } }, local);
    expect(res.settings.transcriptRetention).toEqual({ maxAgeDays: null, archivedDays: 30 });
    expect(job.policy).toEqual({ maxAgeDays: null, archivedDays: 30 });
    expect(file()['transcriptRetention']).toEqual({ maxAgeDays: null, archivedDays: 30 });
    expect(loadConfig(env).config.transcriptRetention).toEqual({
      maxAgeDays: null,
      archivedDays: 30,
    });
  });

  it('is changed only from this machine (decisions 51, 90)', () => {
    const { settings, file } = setup();
    const before = file();
    const r = refusal(() =>
      settings.update({ transcriptRetention: { archivedDays: 1 } }, { origin: 'remote' }),
    );
    expect(r?.code).toBe('remote_settings');
    expect(file()).toEqual(before);
    expect(
      settings.update(
        { transcriptRetention: { archivedDays: 1 } },
        { origin: 'remote', autoApproveRemote: true },
      ).settings.transcriptRetention,
    ).toEqual({ maxAgeDays: 90, archivedDays: 1 });
  });

  it('takes whole days from 1, or null (P8-02 review)', () => {
    const { settings, file } = setup();
    const before = file();
    for (const bad of [{ archivedDays: 0 }, { maxAgeDays: 0.5 }, { maxAgeDays: -1 }]) {
      expect(refusal(() => settings.update({ transcriptRetention: bad }, local))).toBeDefined();
    }
    expect(file()).toEqual(before);
  });

  it('sets the runtime of new Stewards live, to a registered runtime only (P8-07)', () => {
    const home = temp('galactic-home-');
    const { config } = loadConfig({ GALACTIC_HOME: join(home, '.galactic') } as NodeJS.ProcessEnv);
    const settings = new SettingsService({ config, home, runtimes: () => ['fake', 'claude-sdk', 'acp'] });
    const file = () => JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, unknown>;
    expect(settings.current().stewardRuntime).toBeUndefined();
    expect(settings.update({ stewardRuntime: 'acp' }, local).settings.stewardRuntime).toBe('acp');
    expect(config.stewardRuntime).toBe('acp'); // live: the brains read the config at each spawn
    expect(file()['stewardRuntime']).toBe('acp');
    expect(settings.response().restartRequired).toEqual([]);
    expect(refusal(() => settings.update({ stewardRuntime: 'pty' }, local))).toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/no pty runtime is set up/),
    });
    expect(refusal(() => settings.update({ stewardRuntime: 'fake' }, { origin: 'remote' }))).toMatchObject(
      { code: 'remote_settings' },
    );
    expect(settings.update({ stewardRuntime: null }, local).settings.stewardRuntime).toBeUndefined();
    expect(config.stewardRuntime).toBeUndefined();
    expect(file()).not.toHaveProperty('stewardRuntime');
  });
});
