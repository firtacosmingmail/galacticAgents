import type {
  RemoteActionResponse,
  RemoteStatus,
  AddDeliverableBody,
  AgentCommandsResponse,
  AllowSimilarBody,
  AllowSimilarResponse,
  AnswerBody,
  AnswerResponse,
  AnswerSetBody,
  DismissSetBody,
  DraftBody,
  SetAnswer,
  DismissBody,
  DismissResponse,
  PermissionRuleScope,
  RemovePermissionRuleResponse,
  SimilarPreviewResponse,
  ControlBody,
  ControlResponse,
  ConversationQuery,
  ConversationResponse,
  DecideResponse,
  Deliverable,
  DeliverablesResponse,
  DeliverablesUsageResponse,
  DownloadTicketResponse,
  EditDeliverableBody,
  OpenDeliverableBody,
  HistoryQuestionsQuery,
  HistoryQuestionsResponse,
  HistoryEventsQuery,
  HistoryEventsResponse,
  HistoryWorkDetail,
  HistoryWorkQuery,
  HistoryWorkResponse,
  HistoryWorkState,
  HostKind,
  IdeResponse,
  MessagesResponse,
  PreflightResponse,
  ProposalDecisionBody,
  RestartHarmonizerResponse,
  RevealFolderBody,
  ReplyRef,
  RunOutputResponse,
  RunPreviewResponse,
  RunsResponse,
  RuntimesInfo,
  StartRunBody,
  StartRunResponse,
  SendBody,
  SendResponse,
  SettingsPatch,
  SettingsResponse,
  SpawnBody,
  SpawnResponse,
  StewardProcessesResponse,
  StopProcessesBody,
  StopProcessesResponse,
  TerminalInputBody,
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
    /** The whole error body (e.g. a 400's zod `issues`, P25-08). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function createApi(token: string, fetchImpl: typeof fetch = fetch) {
  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> => {
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
      throw new ApiError(res.status, message, data['error'] as string | undefined, data);
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
    /** `replyTo` (P8-17): the chat line or card this message replies to. */
    send: (agentId: string, text: string, interrupt: boolean, replyTo?: ReplyRef) =>
      call<SendResponse>('POST', `/api/agents/${agentId}/send`, {
        text,
        interrupt,
        ...(replyTo ? { replyTo } : {}),
      } satisfies SendBody),
    pause: (agentId: string) => call('POST', `/api/agents/${agentId}/pause`),
    resume: (agentId: string) => call('POST', `/api/agents/${agentId}/resume`),
    interrupt: (agentId: string) => call('POST', `/api/agents/${agentId}/interrupt`),
    stop: (agentId: string) => call('POST', `/api/agents/${agentId}/stop`),
    recover: (agentId: string) => call('POST', `/api/agents/${agentId}/recover`),
    /** The slash commands the agent's live session offers (P8-13); `[]` without one. */
    commands: (agentId: string) =>
      call<AgentCommandsResponse>('GET', `/api/agents/${encodeURIComponent(agentId)}/commands`),
    /** Types one line into a terminal agent's terminal (P8-08); the Mac's own browser only. */
    terminal: (agentId: string, text: string) =>
      call<{ messageId: string }>('POST', `/api/agents/${encodeURIComponent(agentId)}/terminal`, {
        text,
      } satisfies TerminalInputBody),
    /** Stops the Harmonizer and starts a fresh one on the same runtime (P5-06, decision 82). */
    restartHarmonizer: () => call<RestartHarmonizerResponse>('POST', '/api/harmonizer/restart'),
    /**
     * `version`: the question's version as the page saw it (a stale answer is refused);
     * `answerId`: the idempotency key of this answer, the same on every retry (P7-05).
     */
    answer: (questionId: string, answer: string, version?: number, answerId?: string) =>
      call<AnswerResponse>('POST', `/api/questions/${encodeURIComponent(questionId)}/answer`, {
        answer,
        ...(version !== undefined ? { version } : {}),
        ...(answerId !== undefined ? { answerId } : {}),
      } satisfies AnswerBody),
    /**
     * Dismisses a question without answering it (P9-14): a clarification is withdrawn, a
     * permission request denied. `version` as for an answer (a stale one is refused). Never queued.
     */
    dismiss: (questionId: string, version?: number) =>
      call<DismissResponse>('POST', `/api/questions/${encodeURIComponent(questionId)}/dismiss`, {
        ...(version !== undefined ? { version } : {}),
      } satisfies DismissBody),
    /**
     * Answers every row of a question set in one send (P8-19). `answerId`: the idempotency key,
     * the same on every retry; each answer's `version` may refuse a stale one.
     */
    answerSet: (setId: string, answers: AnswerSetBody['answers'], answerId?: string) =>
      call<AnswerResponse>('POST', `/api/question-sets/${encodeURIComponent(setId)}/answer`, {
        answers,
        ...(answerId !== undefined ? { answerId } : {}),
      } satisfies AnswerSetBody),
    /** Saves (or with `null` clears) the unsent draft of one set row (P8-19); wakes no one. */
    draftQuestion: (questionId: string, draft: SetAnswer | null) =>
      call<{ ok: true }>('POST', `/api/questions/${encodeURIComponent(questionId)}/draft`, {
        draft,
      } satisfies DraftBody),
    /** Dismisses every open row of a question set (P8-19). Never queued. */
    dismissSet: (setId: string) =>
      call<DismissResponse>(
        'POST',
        `/api/question-sets/${encodeURIComponent(setId)}/dismiss`,
        {} satisfies DismissSetBody,
      ),
    /**
     * "Allow similar" (P9-17): what the card's chooser offers for a permission request, each scope
     * with the server's preview of what it would match.
     */
    similarPreview: (questionId: string) =>
      call<SimilarPreviewResponse>(
        'POST',
        `/api/questions/${encodeURIComponent(questionId)}/similar-preview`,
        {},
      ),
    /**
     * Answers the request "allow" and stores the rule of `scope` on its project (P9-17), bound to
     * the preview by its `digest` (409 `stale` when the server would store another rule).
     */
    allowSimilar: (
      questionId: string,
      scope: PermissionRuleScope,
      digest: string,
      version?: number,
    ) =>
      call<AllowSimilarResponse>(
        'POST',
        `/api/questions/${encodeURIComponent(questionId)}/allow-similar`,
        {
          scope,
          digest,
          ...(version !== undefined ? { version } : {}),
        } satisfies AllowSimilarBody,
      ),
    /** Removes a project's "Allow similar" rule (P9-17). */
    removePermissionRule: (projectId: string, ruleId: string) =>
      call<RemovePermissionRuleResponse>(
        'DELETE',
        `/api/projects/${encodeURIComponent(projectId)}/permission-rules/${encodeURIComponent(ruleId)}`,
      ),
    decide: (proposalId: string, decision: ProposalDecisionBody) =>
      call<DecideResponse>('POST', `/api/proposals/${proposalId}/decide`, decision),
    control: (body: ControlBody) => call<ControlResponse>('POST', '/api/control', body),
    messages: (agentId: string) => call<MessagesResponse>('GET', `/api/agents/${agentId}/messages`),
    /** The panel's chat history (P25-01), paged by an opaque cursor (P25-03). */
    conversation: (agentId: string, query: ConversationQuery = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
      const qs = params.toString();
      return call<ConversationResponse>(
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/conversation${qs ? `?${qs}` : ''}`,
      );
    },
    /** A Steward's processes still running (P4-14). */
    processes: (agentId: string) =>
      call<StewardProcessesResponse>('GET', `/api/agents/${encodeURIComponent(agentId)}/processes`),
    /** Stops a Steward's processes: these pids, or all of them (P4-14). */
    stopProcesses: (agentId: string, pids?: number[]) =>
      call<StopProcessesResponse>(
        'POST',
        `/api/agents/${encodeURIComponent(agentId)}/processes/stop`,
        (pids ? { pids } : {}) satisfies StopProcessesBody,
      ),
    /** The settings page (P25-08; endpoints P25-01). */
    settings: () => call<SettingsResponse>('GET', '/api/settings'),
    patchSettings: (patch: SettingsPatch) =>
      call<SettingsResponse>('PATCH', '/api/settings', patch),
    /** The IDEs installed on the Mac and the IDE setting (P9-03). */
    ide: () => call<IdeResponse>('GET', '/api/ide'),
    /** The runtime preflight; `refresh` runs the checks again instead of the cached result. */
    preflight: (refresh = false) =>
      call<PreflightResponse>('GET', `/api/preflight${refresh ? '?refresh=1' : ''}`),
    /** The history view (P25-10): finished and archived work, newest first, paged by `before`. */
    historyWork: (query: HistoryWorkFilter = {}) =>
      call<HistoryWorkResponse>('GET', `/api/history/work${queryString(query)}`),
    /** One project or task inspected from the history view (P5-03), in any state. */
    historyDetail: (kind: HostKind, id: string) =>
      call<HistoryWorkDetail>('GET', `/api/history/work/${kind}/${encodeURIComponent(id)}`),
    /** The history view (P25-10): answered and cancelled questions, newest first. */
    historyQuestions: (query: HistoryQuestionsQuery = {}) =>
      call<HistoryQuestionsResponse>('GET', `/api/history/questions${queryString(query)}`),
    /** The timeline scrubber (P4-07): one project's events, oldest first, paged by `after`. */
    historyEvents: (query: HistoryEventsQuery) =>
      call<HistoryEventsResponse>('GET', `/api/history/events${queryString(query)}`),
    // -- deliverables (P9-09; TECHNOLOGY §9.6, §9.7) ------------------------------------------
    /** The rows of a project or a task, with their live file facts and the deliverables folder. */
    deliverables: (query: { projectId?: string; taskId?: string; removed?: boolean }) =>
      call<DeliverablesResponse>(
        'GET',
        `/api/deliverables${queryString({ ...query, removed: query.removed ? '1' : undefined })}`,
      ),
    /**
     * A file deliverable's bytes for the viewer, with the bearer token (never in an address): the
     * body, its content type and whether the server cut it at the preview limit (`X-Truncated`).
     */
    deliverableContent: async (id: string): Promise<DeliverableContent> => {
      const res = await fetchImpl(`/api/deliverables/${encodeURIComponent(id)}/content`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        let data: Record<string, unknown> = {};
        try {
          data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          // not JSON: the status says it
        }
        const message =
          (data['message'] as string | undefined) ??
          (data['error'] as string | undefined) ??
          `${res.status}`;
        throw new ApiError(res.status, message, data['error'] as string | undefined, data);
      }
      return {
        bytes: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') ?? '',
        truncated: res.headers.get('x-truncated') === '1',
      };
    },
    /** A one-time download link (`/files/<ticket>`, 60 s, decision 126). */
    downloadDeliverable: (id: string) =>
      call<DownloadTicketResponse>('POST', `/api/deliverables/${encodeURIComponent(id)}/download`),
    addDeliverable: (body: AddDeliverableBody) =>
      call<{ deliverable: Deliverable }>('POST', '/api/deliverables', body),
    editDeliverable: (id: string, body: EditDeliverableBody) =>
      call<{ deliverable: Deliverable }>(
        'PATCH',
        `/api/deliverables/${encodeURIComponent(id)}`,
        body,
      ),
    removeDeliverable: (id: string, reason?: string) =>
      call<{ deliverable: Deliverable }>(
        'POST',
        `/api/deliverables/${encodeURIComponent(id)}/remove`,
        reason ? { reason } : {},
      ),
    restoreDeliverable: (id: string) =>
      call<{ deliverable: Deliverable }>(
        'POST',
        `/api/deliverables/${encodeURIComponent(id)}/restore`,
      ),
    /** Opens on the Mac (decision 127); an application answers 409 `confirm` first (128). */
    openDeliverable: (id: string, body: OpenDeliverableBody) =>
      call<{ ok: true }>('POST', `/api/deliverables/${encodeURIComponent(id)}/open`, body),
    /** Reveal in Finder for the project's (or standalone task's) `deliverables/` folder. */
    revealDeliverablesFolder: (body: RevealFolderBody) =>
      call<{ ok: true }>('POST', '/api/deliverables/folder/reveal', body),
    /** Scans the project's folder for run scripts again (decision 119). */
    rescanDeliverables: (projectId: string) =>
      call<{ ok: true }>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/deliverables/rescan`,
      ),
    /** Each `deliverables/` folder's size on disk (decision 122). */
    deliverablesUsage: () => call<DeliverablesUsageResponse>('GET', '/api/deliverables/usage'),

    // -- phone access (P9-16; decision 137) ------------------------------------------------------
    /** Whether the phone can reach Mission Control (every client may read it). */
    remoteStatus: () => call<RemoteStatus>('GET', '/api/remote/status'),
    /** Turn phone access on / off (the Mac only; a refusal is 409 `remote_refused`). */
    remoteStart: () => call<RemoteActionResponse>('POST', '/api/remote/start'),
    remoteStop: () => call<RemoteActionResponse>('POST', '/api/remote/stop'),

    // -- managed runs (P9-08 routes, P9-10 panel; TECHNOLOGY §9.8) ------------------------------
    /**
     * What the Run dialog shows (decision 129): the stored line, or `line` as the user edited it
     * (its own warnings and its own `confirmation`). Read only; remote clients too.
     */
    runPreview: (id: string, line?: string) =>
      line === undefined
        ? call<RunPreviewResponse>('GET', `/api/deliverables/${encodeURIComponent(id)}/run-preview`)
        : call<RunPreviewResponse>(
            'POST',
            `/api/deliverables/${encodeURIComponent(id)}/run-preview`,
            { line },
          ),
    /** Run, after the confirmation (the Mac only, decision 131). */
    startRun: (id: string, body: StartRunBody) =>
      call<StartRunResponse>('POST', `/api/deliverables/${encodeURIComponent(id)}/runs`, body),
    /** Stop, after the panel's confirmation (the phone too, decision 131). */
    stopRun: (runId: string) =>
      call<StartRunResponse>('POST', `/api/runs/${encodeURIComponent(runId)}/stop`),
    /** Restart with a new confirmation (the Mac only). */
    restartRun: (runId: string, body: StartRunBody) =>
      call<StartRunResponse>('POST', `/api/runs/${encodeURIComponent(runId)}/restart`, body),
    /** A command's runs, newest first (at most 50). */
    runs: (id: string) =>
      call<RunsResponse>('GET', `/api/deliverables/${encodeURIComponent(id)}/runs`),
    /** A run's output after `after` (a `seq`), oldest first, `limit` chunks at most. */
    runOutput: (runId: string, query: { after?: number; limit?: number } = {}) =>
      call<RunOutputResponse>(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/output${queryString(query)}`,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;

/** A deliverable's bytes as the viewer receives them (`Api.deliverableContent`). */
export interface DeliverableContent {
  bytes: ArrayBuffer;
  contentType: string;
  truncated: boolean;
}

/** `GET /api/history/work`'s query as the client builds it (`state` as a list). */
export type HistoryWorkFilter = Omit<HistoryWorkQuery, 'state'> & { state?: HistoryWorkState[] };

/** `?k=v&…` of the defined values (a list joined by commas), or `''`. */
function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '') continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
