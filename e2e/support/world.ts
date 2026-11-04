import type {
  HarnessActionResponse,
  HarnessAdvanceResponse,
  HarnessBrainToolResponse,
  HarnessBrainWaykeeperResponse,
  HarnessHarmonizerResponse,
  HarnessJobRunBody,
  HarnessJobRunResponse,
  HarnessJobTickResponse,
  HarnessScenarioBody,
  HarnessScenarioResponse,
  HarnessStewardScriptBody,
  HistoryQuestionsResponse,
  Question,
} from '@galactic/protocol';
import type { Page } from '@playwright/test';
import type { Api } from './fixtures.js';

/**
 * The world the smoke tests drive, through the scene harness (decision 79; `/dev/harness/*`): fake
 * agents with no process, whose states and questions are ordinary events — the page shows them as
 * it shows real agents.
 */
export function seedScenario(
  api: Api,
  body: HarnessScenarioBody,
): Promise<HarnessScenarioResponse> {
  return api.post<HarnessScenarioResponse>('/dev/harness/scenario', body);
}

/** Stops the harness's fake agents and archives what it made (the bodies are freed). */
export async function clearHarness(api: Api): Promise<void> {
  await api.post('/dev/harness/clear');
}

export async function askUser(
  api: Api,
  agentId: string,
  kind: 'clarification' | 'permission',
  text: string,
): Promise<string> {
  const res = await api.post<HarnessActionResponse>(`/dev/harness/agents/${agentId}/question`, {
    kind,
    text,
  });
  if (!res.questionId) throw new Error(`no question id: ${JSON.stringify(res)}`);
  return res.questionId;
}

/** A new project with a real Waykeeper brain on the fake runtime, under the Harmonizer (P8-21). */
export function startBrainWaykeeper(
  api: Api,
  name: string,
): Promise<HarnessBrainWaykeeperResponse> {
  return api.post<HarnessBrainWaykeeperResponse>('/dev/harness/brains/waykeeper', { name });
}

/** A fake-runtime brain calls one of its tools as its model would; a refusal throws here. */
export async function callBrainTool(
  api: Api,
  agentId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { result } = await api.post<HarnessBrainToolResponse>(
    `/dev/harness/brains/${agentId}/tool`,
    { name, input },
  );
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`${name} refused: ${JSON.stringify(result)}`);
  }
  // A turn-ending tool's value comes wrapped (`{ result, turnEnded }`), as the model reads it.
  if (result && typeof result === 'object' && 'turnEnded' in result) {
    return (result as unknown as { result: unknown }).result;
  }
  return result;
}

/** The running Harmonizer (P10-08), to make it call its tools from the first card on. */
export async function harmonizerId(api: Api): Promise<string> {
  return (await api.get<HarnessHarmonizerResponse>('/dev/harness/brains/harmonizer')).harmonizerId;
}

/**
 * A recurring job's next run starts now (P10-08), its Steward on the fake runtime reporting what
 * `script` says (findings, a spend, then the run's report) before the run ends.
 */
export function runJobNow(
  api: Api,
  jobId: string,
  script: HarnessJobRunBody = {},
): Promise<HarnessJobRunResponse> {
  return api.post<HarnessJobRunResponse>(`/dev/harness/jobs/${jobId}/run`, script);
}

/** One job-scheduler tick now (a queued follow-up run starts on it). */
export function tickJobs(api: Api): Promise<HarnessJobTickResponse> {
  return api.post<HarnessJobTickResponse>('/dev/harness/jobs/tick');
}

/**
 * The next Steward spawned for the task follows `script` (P11-10): a publish request, or a stop at
 * its provider's usage limit. Set before the Waykeeper's `spawn_steward`.
 */
export async function scriptSteward(
  api: Api,
  taskId: string,
  script: HarnessStewardScriptBody,
): Promise<void> {
  await api.post(`/dev/harness/tasks/${taskId}/steward-script`, script);
}

/** Moves the clock usage-limit waits are checked against forward, then checks them once. */
export function advanceUsageLimits(api: Api, ms: number): Promise<HarnessAdvanceResponse> {
  return api.post<HarnessAdvanceResponse>('/dev/harness/usage-limits/advance', { ms });
}

/** The question as the server's history has it (the source of truth, not the page). */
export async function questionOnServer(api: Api, text: string): Promise<Question | undefined> {
  const page = await api.get<HistoryQuestionsResponse>(
    `/api/history/questions?q=${encodeURIComponent(text)}`,
  );
  return page.items.map((i) => i.question).find((q) => q?.context.text === text);
}

/** A run-unique suffix, so texts and titles never collide with an earlier test's. */
export const stamp = (): string => Date.now().toString(36);

/** The scene's test hook (`apps/web/src/scene/probe.tsx`). */
export const sceneProbe = (page: Page) => page.getByTestId('scene-probe');

/** The ids listed in one of the probe's attributes. */
export async function probeList(page: Page, attr: 'bodies' | 'satellites'): Promise<string[]> {
  const value = await sceneProbe(page).getAttribute(`data-${attr}`);
  return value ? value.split(' ') : [];
}
