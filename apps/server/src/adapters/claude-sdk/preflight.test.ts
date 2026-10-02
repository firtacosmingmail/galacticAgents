import { describe, expect, it } from 'vitest';
import { RuntimePreflight } from '@galactic/protocol';
import { claudePreflight, sdkVersion, type Exec } from './preflight.js';

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
    const r = await claudePreflight(exec({ stdout: '', stderr: '', error: missing }), sdk);
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

  it('finds the installed Agent SDK version', () => {
    expect(sdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
