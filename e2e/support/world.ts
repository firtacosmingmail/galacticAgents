import type {
  HarnessActionResponse,
  HarnessScenarioBody,
  HarnessScenarioResponse,
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
