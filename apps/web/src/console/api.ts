import type {
  AnswerBody,
  RuntimesInfo,
  SendBody,
  SendResponse,
  SpawnBody,
  SpawnResponse,
} from '@galactic/protocol';

/**
 * The ops console's calls to the server's `/api/*` routes (P1-11). Results arrive on the stream.
 * The bodies and replies are the protocol's (`packages/protocol/src/rest.ts`).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(token: string, fetchImpl: typeof fetch = fetch) {
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
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const message =
        (data['message'] as string | undefined) ??
        (data['error'] as string | undefined) ??
        `${res.status}`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  };
  return {
    runtimes: () => call<RuntimesInfo>('GET', '/api/runtimes'),
    spawn: (input: SpawnBody) => call<SpawnResponse>('POST', '/api/agents', input),
    send: (agentId: string, text: string, interrupt: boolean) =>
      call<SendResponse>('POST', `/api/agents/${agentId}/send`, {
        text,
        interrupt,
      } satisfies SendBody),
    pause: (agentId: string) => call('POST', `/api/agents/${agentId}/pause`),
    resume: (agentId: string) => call('POST', `/api/agents/${agentId}/resume`),
    interrupt: (agentId: string) => call('POST', `/api/agents/${agentId}/interrupt`),
    stop: (agentId: string) => call('POST', `/api/agents/${agentId}/stop`),
    recover: (agentId: string) => call('POST', `/api/agents/${agentId}/recover`),
    answer: (questionId: string, answer: string) =>
      call('POST', `/api/questions/${questionId}/answer`, { answer } satisfies AnswerBody),
  };
}

export type Api = ReturnType<typeof createApi>;
