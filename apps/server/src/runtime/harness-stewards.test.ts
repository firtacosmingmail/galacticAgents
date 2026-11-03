import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@galactic/protocol';
import type { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import {
  DEV_PROVIDER_RUNTIMES,
  devProviderFakes,
  HarnessClock,
  installProviderFakes,
  replaceAdapters,
  stewardScript,
} from './harness-stewards.js';

/**
 * The dev harness's provider hooks (P11-10): the clock a test moves, the Steward scripts, and the
 * fakes that replace the Codex and Antigravity adapters (rulings R4, R25).
 */

describe('the harness clock', () => {
  it('starts at the real time and only moves forward when told', () => {
    const clock = new HarnessClock();
    const before = clock.now();
    expect(before).toBeGreaterThan(Date.now() - 1000);
    clock.advance(3_600_000);
    expect(clock.now() - Date.now()).toBeGreaterThanOrEqual(3_599_000);
    expect(Date.parse(clock.iso())).toBeGreaterThan(before + 3_000_000);
  });
});

describe('a Steward script', () => {
  const clock = new HarnessClock();
  it('a limit stops the Steward with the reset time on the harness clock', () => {
    clock.advance(0);
    const { steps } = stewardScript({ limit: { resetsInMs: 60_000 } }, clock);
    const fail = steps.find((s) => s.kind === 'fail');
    expect(fail).toMatchObject({ kind: 'fail', reason: 'limit' });
    const resets = Date.parse((fail as { resetsAt: string }).resetsAt);
    expect(resets).toBeGreaterThanOrEqual(clock.now() + 59_000 - 1000);
  });

  it('a publish asks request_publish, then waits for the answer', () => {
    const { steps } = stewardScript(
      { publish: { platform: 'Instagram', account: '@me', text: 'Hi' } },
      clock,
    );
    expect(steps.map((s) => s.kind)).toEqual(['script', 'idle']);
  });
});

describe('the dev provider fakes', () => {
  it('ChatGPT publishes and cannot make images; Gemini the reverse', async () => {
    const [codex, agy] = devProviderFakes(undefined);
    expect(codex).toMatchObject({ runtime: 'codex', canPublish: true });
    expect(agy).toMatchObject({ runtime: 'agy', canPublish: false });
    const images = async (a: FakeAdapter) =>
      (await a.models!()).filter((m) => m.capabilities.includes('image')).map((m) => m.id);
    expect(await images(codex!)).toEqual([]);
    expect(await images(agy!)).toEqual(['gemini-3.8-flash', 'claude-sonnet-5']);
    expect([codex!.runtime, agy!.runtime]).toEqual([...DEV_PROVIDER_RUNTIMES]);
  });

  it('replace a real adapter of the same runtime in place, with a log line, and add the rest', () => {
    const real = { runtime: 'codex' } as AgentAdapter;
    const claude = { runtime: 'claude-sdk' } as AgentAdapter;
    const adapters = [claude, real];
    const lines: string[] = [];
    const [codex, agy] = devProviderFakes(undefined);
    replaceAdapters(adapters, [codex!, agy!], (m) => lines.push(m));
    expect(adapters).toEqual([claude, codex, agy]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('replaces the codex runtime');
    expect(lines[1]).toContain('registers as the agy runtime');
  });

  it('are installed only with the fake-providers flag: development mode alone keeps the real ones', () => {
    const real = { runtime: 'codex' } as AgentAdapter;
    const adapters = [real];
    const lines: string[] = [];
    expect(
      installProviderFakes({ dev: true, fakeProviders: false }, adapters, undefined, (m) =>
        lines.push(m),
      ),
    ).toBe(false);
    expect(adapters).toEqual([real]);
    expect(lines).toEqual([]);
    expect(
      installProviderFakes({ dev: true, fakeProviders: true }, adapters, undefined, (m) =>
        lines.push(m),
      ),
    ).toBe(true);
    expect(adapters.map((a) => a.runtime)).toEqual(['codex', 'agy']);
    expect(adapters[0]).not.toBe(real);
  });
});
