import type {
  HarnessActionResponse,
  HarnessActivityBody,
  HarnessAgentBody,
  HarnessAgentResponse,
  HarnessClearResponse,
  HarnessListResponse,
  HarnessQuestionBody,
  HarnessScenarioBody,
  HarnessScenarioResponse,
  HarnessStateBody,
} from '@galactic/protocol';
import { ApiError } from './api.js';

/**
 * The scene harness's calls (P4-06): the server's development-only `/dev/harness/*` routes (bodies
 * and replies in `packages/protocol/src/dev.ts`). Their effects arrive on the stream like any
 * other event. A 404 means the server runs without `GALACTIC_DEV`; a 403, that this page is not on
 * the server's machine.
 */
export function createHarnessApi(token: string, fetchImpl: typeof fetch = fetch) {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const message =
        res.status === 404 && data['error'] === undefined
          ? 'the dev routes are off: start the server with `pnpm dev` or `galactic start --dev`'
          : ((data['message'] as string | undefined) ??
            (data['error'] as string | undefined) ??
            `${res.status}`);
      throw new ApiError(res.status, message, data['error'] as string | undefined, data);
    }
    return data as T;
  };
  const id = encodeURIComponent;
  return {
    list: () => call<HarnessListResponse>('GET', '/dev/harness'),
    scenario: (body: HarnessScenarioBody) =>
      call<HarnessScenarioResponse>('POST', '/dev/harness/scenario', body),
    clear: () => call<HarnessClearResponse>('POST', '/dev/harness/clear'),
    createAgent: (body: HarnessAgentBody) =>
      call<HarnessAgentResponse>('POST', '/dev/harness/agents', body),
    setState: (agentId: string, body: HarnessStateBody) =>
      call<HarnessActionResponse>('POST', `/dev/harness/agents/${id(agentId)}/state`, body),
    setActivity: (agentId: string, body: HarnessActivityBody) =>
      call<HarnessActionResponse>('POST', `/dev/harness/agents/${id(agentId)}/activity`, body),
    ask: (agentId: string, body: HarnessQuestionBody) =>
      call<HarnessActionResponse>('POST', `/dev/harness/agents/${id(agentId)}/question`, body),
    answer: (questionId: string, answer?: string) =>
      call<HarnessActionResponse>(
        'POST',
        `/dev/harness/questions/${id(questionId)}/answer`,
        answer !== undefined ? { answer } : {},
      ),
    move: (taskId: string, projectId: string) =>
      call<HarnessActionResponse>('POST', `/dev/harness/tasks/${id(taskId)}/move`, { projectId }),
    complete: (taskId: string) =>
      call<HarnessActionResponse>('POST', `/dev/harness/tasks/${id(taskId)}/complete`),
    closeProject: (projectId: string) =>
      call<HarnessActionResponse>('POST', `/dev/harness/projects/${id(projectId)}/close`),
  };
}

export type HarnessApi = ReturnType<typeof createHarnessApi>;
