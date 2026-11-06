import type { ScopeJudge, ScopeJudgeInput, ScopeVerdict } from '@galactic/protocol';

/** A scripted scope judge (tests and the fake harness). */
export function createFakeScopeJudge(
  script: (input: ScopeJudgeInput) => ScopeVerdict | Promise<ScopeVerdict>,
): ScopeJudge {
  return { judge: async (input) => script(input) };
}

/** The fake harness's default: fail closed, as the real judge does when unsure. */
export const failClosedFakeScopeJudge = (): ScopeJudge =>
  createFakeScopeJudge(() => ({ verdict: 'off_script', reason: 'fake judge: no script' }));
