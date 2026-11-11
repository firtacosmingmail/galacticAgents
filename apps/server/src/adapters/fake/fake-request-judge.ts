import type { RequestJudge, RequestJudgeInput, RequestVerdict } from '@galactic/protocol';

/** A scripted request judge (tests and the fake harness). */
export function createFakeRequestJudge(
  script: (input: RequestJudgeInput) => RequestVerdict | Promise<RequestVerdict>,
): RequestJudge {
  return { judge: async (input) => script(input) };
}

/** The fake harness's default: forward everything to the user, as the real judge does when unsure. */
export const failClosedFakeRequestJudge = (): RequestJudge =>
  createFakeRequestJudge(() => ({
    verdict: 'forward',
    reason: 'fake judge: no script',
    kind: 'unknown',
    similarTo: [],
  }));
