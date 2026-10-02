import type {
  AnswerBody,
  ControlBody,
  ControlResponse,
  DecideResponse,
  MessagesResponse,
  ProposalDecisionBody,
  RuntimesInfo,
  SendBody,
  SendResponse,
  SpawnBody,
  SpawnResponse,
  TranscriptResponse,
} from '@galactic/protocol';

/**
 * The ops console's calls to the server's `/api/*` routes (P1-11). Results arrive on the stream.
 * The bodies and replies are the protocol's (`packages/protocol/src/rest.ts`).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The refusal's code (`stale`, `rejected`, `not_found`, `invalid`, …). */
    readonly code?: string,
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
      throw new ApiError(res.status, message, data['error'] as string | undefined);
    }
    return data as T;
  };
  return {
    runtimes: () => call<RuntimesInfo>('GET', '/api/runtimes'),
    /** `GET /api/agents/:id/transcript` (P25-01), paged by `seq`; without a cursor the newest page. */
    transcript: (
      agentId: string,
      query: { before?: number; after?: number; limit?: number } = {},
    ) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
      const qs = params.toString();
      return call<TranscriptResponse>(
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/transcript${qs ? `?${qs}` : ''}`,
      );
    },
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
    /** `version`: the question's version as the page saw it (a stale answer is refused). */
    answer: (questionId: string, answer: string, version?: number) =>
      call('POST', `/api/questions/${questionId}/answer`, {
        answer,
        ...(version !== undefined ? { version } : {}),
      } satisfies AnswerBody),
    decide: (proposalId: string, decision: ProposalDecisionBody) =>
      call<DecideResponse>('POST', `/api/proposals/${proposalId}/decide`, decision),
    control: (body: ControlBody) => call<ControlResponse>('POST', '/api/control', body),
    messages: (agentId: string) => call<MessagesResponse>('GET', `/api/agents/${agentId}/messages`),
  };
}

export type Api = ReturnType<typeof createApi>;
