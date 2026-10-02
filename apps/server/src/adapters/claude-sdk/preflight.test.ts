import { describe, expect, it } from 'vitest';
import { RuntimePreflight } from '@galactic/protocol';
import {
  allowListedEnv,
  bundledCli,
  claudePreflight,
  execCommand,
  sdkVersion,
  type Exec,
} from './preflight.js';

/** An `exec` answering `claude --version` and `claude auth status` as given. */
const exec =
  (
    version: Awaited<ReturnType<Exec>>,
    auth: Awaited<ReturnType<Exec>> = { stdout: '', stderr: '' },
  ): Exec =>
  (_file, args) =>
    Promise.resolve(args[0] === '--version' ? version : auth);
const ok = (stdout: string) => ({ stdout, stderr: '' });
const status = (s: object) => ok(JSON.stringify(s));
const sdk = () => '0.3.285';

describe('claudePreflight (P25-01; SPEC §4.6)', () => {
  it('is ready with a subscription login', async () => {
    const r = await claudePreflight(
      exec(
        ok('2.1.287 (Claude Code)\n'),
        status({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
          email: 'someone@example.com',
        }),
      ),
      sdk,
    );
    expect(RuntimePreflight.parse(r)).toEqual({
      runtime: 'claude-sdk',
      ok: true,
      installed: true,
      version: '2.1.287',
      sdkVersion: '0.3.285',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      apiProvider: 'firstParty',
      problems: [],
    });
    expect(JSON.stringify(r)).not.toContain('someone@example.com');
  });

  it('says how to install a missing CLI', async () => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const r = await claudePreflight(
      exec({ stdout: '', stderr: '', error: missing }),
      sdk,
      'claude',
      () => undefined, // and no CLI bundled with the SDK
    );
    expect(r).toMatchObject({ ok: false, installed: false });
    expect(r.problems).toEqual([
      expect.objectContaining({
        code: 'not_installed',
        severity: 'error',
        fix: expect.stringMatching(/install/i),
      }),
    ]);
  });

  it('says how to log in when logged out (auth status exits non-zero with JSON)', async () => {
    const r = await claudePreflight(
      exec(ok('2.1.0'), {
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: '',
        error: Object.assign(new Error('exit 1'), { code: 1 }),
      }),
      sdk,
    );
    expect(r).toMatchObject({ ok: false, installed: true, loggedIn: false });
    expect(r.problems[0]).toMatchObject({
      code: 'not_logged_in',
      fix: expect.stringMatching(/login/),
    });
  });

  it('warns about an API-key login and reports an unreadable status', async () => {
    const key = await claudePreflight(
      exec(ok('2.1.0'), status({ loggedIn: true, authMethod: 'api_key' })),
      sdk,
    );
    expect(key.ok).toBe(true);
    expect(key.problems).toEqual([
      expect.objectContaining({ code: 'not_subscription', severity: 'warning' }),
    ]);
    const garbled = await claudePreflight(exec(ok('2.1.0'), ok('not json')), sdk);
    expect(garbled.ok).toBe(false);
    expect(garbled.problems[0]!.code).toBe('auth_unreadable');
    const noSdk = await claudePreflight(
      exec(ok('2.1.0'), status({ loggedIn: true, authMethod: 'claude.ai' })),
      () => undefined,
    );
    expect(noSdk.problems.map((p) => p.code)).toEqual(['sdk_missing']);
  });

  it('finds the installed Agent SDK version and its bundled CLI', () => {
    expect(sdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(bundledCli()?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('a missing global `claude` is a warning when the SDK bundles its CLI', async () => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const calls: string[] = [];
    const byFile: Exec = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'claude') return Promise.resolve({ stdout: '', stderr: '', error: missing });
      return Promise.resolve(
        args[0] === '--version'
          ? ok('2.1.285 (Claude Code)')
          : status({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }),
      );
    };
    const r = await claudePreflight(byFile, sdk, 'claude', () => ({
      version: '2.1.285',
      path: '/sdk/claude',
    }));
    expect(r).toMatchObject({ ok: true, installed: true, version: '2.1.285', loggedIn: true });
    expect(r.problems).toEqual([
      expect.objectContaining({
        code: 'not_installed',
        severity: 'warning',
        message: expect.stringContaining('2.1.285'),
      }),
    ]);
    expect(calls).toEqual(['claude --version', '/sdk/claude --version', '/sdk/claude auth status']);
    // A bundled version without a binary to ask: installed, but the login is unknown.
    const noBinary = await claudePreflight(byFile, sdk, 'claude', () => ({ version: '2.1.285' }));
    expect(noBinary).toMatchObject({ ok: false, installed: true, version: '2.1.285' });
    expect(noBinary.problems.map((p) => [p.code, p.severity])).toEqual([
      ['not_installed', 'warning'],
      ['auth_unreadable', 'error'],
    ]);
  });

  it('runs the commands with the allow-listed environment only', async () => {
    const env = { PATH: '/bin', HOME: '/home/x', GALACTIC_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k' };
    expect(allowListedEnv(env)).toEqual({ PATH: '/bin', HOME: '/home/x' });
    process.env['GALACTIC_PREFLIGHT_PROBE'] = 'leaked';
    try {
      const r = await execCommand(process.execPath, [
        '-e',
        'process.stdout.write(String(process.env.GALACTIC_PREFLIGHT_PROBE))',
      ]);
      expect(r.stdout).toBe('undefined');
    } finally {
      delete process.env['GALACTIC_PREFLIGHT_PROBE'];
    }
  });
});
