import type { Locator, Page } from '@playwright/test';
import type { Event, JobRunsResponse } from '@galactic/protocol';
import { expect, test, type Api } from '../support/fixtures.js';
import {
  callBrainTool,
  harmonizerId,
  questionOnServer,
  runJobNow,
  sceneProbe,
  stamp,
  tickJobs,
} from '../support/world.js';

/**
 * Long-term projects and recurring jobs (P10-08, SPEC decisions 142–145), end to end: the
 * Harmonizer proposes a long-term project and the user approves it — it sits on a big planet; its
 * Waykeeper proposes a daily job on a new "Feedback" area and the user approves the card — the
 * area's moon shows the label; a run starts, its Steward reports a drafted reply and asks to spend
 * real money, and the run ends; the inbox shows the finding and the "$" card; the user edits the
 * reply and sends it — a follow-up run of the job carries it; the Jobs tab lists the job with its
 * last line and its run history. On a phone the Jobs view fits the screen and an area moon opens
 * it, filtered to that moon.
 *
 * The brains' tool calls come through the harness (`/dev/harness/brains/*`, as in 12), and so does
 * the run (`/dev/harness/jobs/*`): it starts now through the real scheduler, its Steward on the
 * fake runtime following the test's script.
 */
const BIG_PLANET = /^b-(jupiter|saturn|uranus)$/;
const hqChat = (page: Page) => page.getByRole('log', { name: 'conversation with Harmonizer' });
const nav = (page: Page) => page.getByRole('navigation', { name: 'navigation' });
const label = (page: Page, bodyId: string) => page.locator(`.scene-label[data-body="${bodyId}"]`);

async function eventsSince(api: Api, since: number): Promise<Event[]> {
  const { events } = await api.get<{ events: { event: Event }[] }>(`/dev/events?since=${since}`);
  return events.map((e) => e.event);
}

async function currentSeq(api: Api): Promise<number> {
  return (await api.get<{ seq: number }>('/dev/events?since=999999999')).seq;
}

/** The first event since `since` that `pick` maps to a value (polled until it exists). */
async function waitForEvent<T>(
  api: Api,
  since: number,
  pick: (e: Event) => T | undefined,
): Promise<T> {
  let found: T | undefined;
  await expect
    .poll(async () => {
      found = (await eventsSince(api, since)).map(pick).find((v) => v !== undefined);
      return found !== undefined;
    })
    .toBe(true);
  return found!;
}

const approvedProposal = (proposalId: string) => (e: Event) =>
  e.type === 'proposal.approved' && e.proposalId === proposalId ? true : undefined;

interface LongTermProject {
  projectId: string;
  name: string;
  bodyId: string;
  waykeeperId: string;
}

interface JobSetUp {
  jobId: string;
  jobName: string;
  moonId: string;
}

/**
 * The Harmonizer's long-term card, decided by `approve` (a click on the card, or the REST call),
 * then the project created and its Waykeeper started, as the Harmonizer does on the approval.
 */
async function longTermProject(
  api: Api,
  s: string,
  approve: (proposalId: string, requestText: string) => Promise<void>,
): Promise<LongTermProject> {
  const hq = await harmonizerId(api);
  const name = `Feedback app ${s}`;
  const requestText = `Look after my feedback app ${s} for months`;
  const since = await currentSeq(api);
  const proposed = (await callBrainTool(api, hq, 'propose', {
    type: 'new_project',
    requestText,
    name,
    kind: 'planet',
    rationale: 'an application looked after over months, with recurring work on its moons',
    longTerm: {
      purpose: 'Keep the feedback app useful: read what users say and act on it.',
      goals: ['Answer every message within a day', 'Ship one improvement a week'],
    },
  })) as { proposalId: string; longTerm?: boolean; proposedBody: { bodyId?: string } };
  expect(proposed.longTerm).toBe(true);
  expect(proposed.proposedBody.bodyId).toMatch(BIG_PLANET);
  await approve(proposed.proposalId, requestText);
  await waitForEvent(api, since, approvedProposal(proposed.proposalId));
  const project = (await callBrainTool(api, hq, 'create_project', {
    proposalId: proposed.proposalId,
  })) as { projectId: string; bodyId: string };
  expect(project.bodyId).toBe(proposed.proposedBody.bodyId);
  const waykeeper = (await callBrainTool(api, hq, 'spawn_waykeeper', {
    projectId: project.projectId,
  })) as { agentId: string };
  return {
    projectId: project.projectId,
    name,
    bodyId: project.bodyId,
    waykeeperId: waykeeper.agentId,
  };
}

/** The Waykeeper's job card for a daily job on a new "Feedback" area, decided by `approve`. */
async function feedbackJob(
  api: Api,
  project: LongTermProject,
  s: string,
  approve: (proposalId: string, requestText: string) => Promise<void>,
): Promise<JobSetUp> {
  const jobName = `Read the feedback ${s}`;
  const since = await currentSeq(api);
  const card = (await callBrainTool(api, project.waykeeperId, 'propose_job', {
    area: 'Feedback',
    name: jobName,
    instructions:
      'Read the new messages in the app’s feedback inbox. Suggest features worth building and ' +
      'draft a reply to each message that needs one. Never send anything yourself.',
    schedule: { kind: 'daily', at: '09:00' },
    rationale: 'Cosmin asked for a daily look at the feedback.',
  })) as { proposalId: string };
  await approve(card.proposalId, `New recurring job: ${jobName}`);
  await waitForEvent(api, since, approvedProposal(card.proposalId));
  const area = await waitForEvent(api, since, (e) =>
    e.type === 'area.created' && e.area.projectId === project.projectId ? e.area : undefined,
  );
  const job = await waitForEvent(api, since, (e) =>
    e.type === 'job.created' && e.job.areaId === area.id ? e.job : undefined,
  );
  expect(area.name).toBe('Feedback');
  return { jobId: job.id, jobName, moonId: area.bodyId };
}

const approveByRest = (api: Api) => async (proposalId: string) => {
  await api.post(`/api/proposals/${proposalId}/decide`, { decision: 'approve' });
};

async function runs(api: Api, jobId: string): Promise<JobRunsResponse['runs']> {
  return (await api.get<JobRunsResponse>(`/api/jobs/${jobId}/runs?limit=20`)).runs;
}

/** No horizontal scroll: neither the element nor the page is wider than what shows. */
async function expectNoHorizontalScroll(page: Page, element: Locator): Promise<void> {
  const widths = await element.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.scroll, 'element scrollWidth').toBeLessThanOrEqual(widths.client);
  expect(widths.page, 'page scrollWidth').toBeLessThanOrEqual(widths.viewport);
}

/**
 * Turns the camera around the body it rests on (a drag on the scene, OrbitControls' business)
 * until `target` shows: on a narrow screen a moon may start behind its planet or out of view.
 */
async function orbitUntilVisible(page: Page, target: Locator): Promise<void> {
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  const y = canvas.y + canvas.height * 0.85;
  for (let i = 0; i < 12 && !(await target.isVisible()); i++) {
    await page.mouse.move(canvas.x + canvas.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.45, y, { steps: 5 });
    await page.mouse.up();
    // The labels follow the camera at the projector's rate: give this turn a moment to show it.
    await target.waitFor({ state: 'visible', timeout: 500 }).catch(() => undefined);
  }
  await expect(target).toBeVisible();
}

/** The element's box once it stops moving (the camera may still glide after a drag or a flight). */
async function restingBox(
  target: Locator,
): Promise<{ x: number; y: number; w: number; h: number }> {
  let last = '';
  let box: { x: number; y: number; w: number; h: number } | undefined;
  await expect
    .poll(
      async () => {
        const b = (await target.boundingBox())!;
        box = {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
        const now = JSON.stringify(box);
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [150] },
    )
    .toBe(true);
  return box!;
}

/**
 * Taps a scene label (labels are pick targets, not DOM targets) at its corners, then its centre,
 * until `opened` shows: the planet or a satellite near the label may take a tap on part of it.
 */
async function tapLabelUntil(page: Page, target: Locator, opened: Locator): Promise<void> {
  const inset = 4;
  const points = [
    (b: { x: number; y: number; w: number; h: number }) => [b.x + inset, b.y + inset],
    (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w - inset, b.y + inset],
    (b: { x: number; y: number; w: number; h: number }) => [b.x + inset, b.y + b.h - inset],
    (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w - inset, b.y + b.h - inset],
    (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w / 2, b.y + b.h / 2],
  ];
  for (const point of points) {
    await expect(target).toBeVisible();
    const [x, y] = point(await restingBox(target)) as [number, number];
    await page.touchscreen.tap(x, y);
    try {
      await expect(opened).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      // That part of the label was under the planet or a satellite: the next one.
    }
  }
  await expect(opened).toBeVisible();
}

test('a long-term project, a daily job, a run with a finding and a spend, a sent reply', async ({
  page,
  api,
  openApp,
}) => {
  const s = stamp();
  await openApp();

  // The Harmonizer's long-term card in its chat: purpose and goals; approved with a click.
  const project = await longTermProject(api, s, async (_, requestText) => {
    const card = hqChat(page).getByRole('article', { name: `proposal ${requestText}` });
    await expect(card).toContainText('Keep the feedback app useful');
    await expect(card.getByRole('list', { name: 'goals' })).toContainText(
      'Ship one improvement a week',
    );
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
  });
  // It sits on a big planet (Jupiter when it is free), labelled with the project.
  await expect(label(page, project.bodyId).locator('.scene-label-title')).toHaveText(project.name);

  // The Waykeeper's job card, in its chat: approved with a click.
  await nav(page).getByText(project.name, { exact: true }).click();
  await expect(page.getByRole('main')).toHaveAttribute(
    'aria-label',
    `Conversation with Waykeeper · ${project.name}`,
  );
  const job = await feedbackJob(api, project, s, async (_, requestText) => {
    const card = page
      .getByRole('region', { name: /^chat with Waykeeper/ })
      .getByRole('article', { name: `job card ${requestText}` });
    await expect(card).toContainText('Feedback moon · new area');
    await expect(card).toContainText('every day 9:00');
    await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
  });
  // The area's moon carries the area's label.
  await expect(label(page, job.moonId).locator('.scene-label-title')).toHaveText('Feedback');

  // A run: its Steward drafts one reply and asks to spend real money, then reports and ends.
  const findingText = `A user asks when dark mode ships (${s}).`;
  const draft = 'Thanks for asking! Dark mode is planned for next month.';
  const spendPurpose = `Promote the dark-mode post for a week (${s})`;
  const { runId } = await runJobNow(api, job.jobId, {
    findings: [{ kind: 'reply', title: 'Reply about dark mode', text: findingText, draft }],
    spend: { amount: 20, currency: 'USD', purpose: spendPurpose },
    summary: `Read 3 new messages; drafted 1 reply (${s}).`,
  });
  await expect
    .poll(async () => (await runs(api, job.jobId)).find((r) => r.id === runId)?.outcome)
    .toBe('findings');

  // The inbox: the finding with its draft, and the spend approval marked apart.
  const inbox = page.locator('#pnl-inbox');
  const finding = inbox.getByRole('article', { name: `clarification question ${findingText}` });
  await expect(finding).toContainText('Reply about dark mode');
  await expect(finding).toContainText(`reply drafted by ${job.jobName} · Feedback`);
  const spend = inbox.getByRole('article', {
    name: `spend question Spend $20.00: ${spendPurpose}`,
  });
  await expect(spend).toHaveClass(/question-spend/);
  await expect(spend.locator('.spend-badge')).toHaveText('$');
  await expect(spend.locator('.spend-amount')).toContainText('20.00');
  await expect(spend).toContainText(spendPurpose);
  await expect(spend.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await expect(spend.getByRole('button', { name: /Allow similar/ })).toHaveCount(0);

  // The reply, edited, then sent: the answer carries the edited text and a follow-up is queued.
  const edited = `${draft} We will let you know the day it ships.`;
  const reply = finding.getByRole('textbox', { name: 'reply' });
  await expect(reply).toHaveValue(draft);
  await reply.fill(edited);
  await finding.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await questionOnServer(api, findingText))?.answer).toBe('Send');
  await expect(finding).toHaveCount(0);

  // The next tick starts the follow-up run with the approved text; it ends on its own.
  const tick = await tickJobs(api);
  expect(tick.started).toHaveLength(1);
  const followUpId = tick.started[0]!;
  await expect
    .poll(async () => {
      const run = (await runs(api, job.jobId)).find((r) => r.id === followUpId);
      return run && { purpose: run.purpose, text: run.followUp?.text, ended: !!run.endedAt };
    })
    .toEqual({ purpose: 'follow_up', text: edited, ended: true });

  // The Jobs tab: the area, the job with its last line, and the run history (newest first).
  await page.getByRole('button', { name: /^Jobs/ }).click();
  const pane = page.getByRole('region', { name: `jobs of ${project.name}` });
  await expect(pane).toBeVisible();
  const area = pane.getByRole('region', { name: /^Feedback · / });
  await expect(area.locator('.jobs-pill')).toHaveText('every day 9:00');
  await expect(area.locator('.jobs-last')).toContainText('(follow-up)');
  await area.getByRole('button', { name: job.jobName }).click();
  const history = pane.getByRole('list', { name: `runs of ${job.jobName}` });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText('(follow-up)');
  await expect(history.getByRole('listitem').last()).toContainText(
    `Read 3 new messages; drafted 1 reply (${s}).`,
  );

  // The spend is still the user's to decide; refused here, nothing is spent.
  await spend.getByRole('button', { name: 'Refuse', exact: true }).click();
  await expect
    .poll(async () => (await questionOnServer(api, `Spend $20.00: ${spendPurpose}`))?.answer)
    .toBe('Refuse');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the Jobs view fits the screen, and an area moon opens it filtered', async ({
    page,
    api,
    openApp,
  }) => {
    const s = stamp();
    const project = await longTermProject(api, s, approveByRest(api));
    const job = await feedbackJob(api, project, s, approveByRest(api));
    await openApp();

    // The project's Waykeeper, from the navigation sheet.
    await page.getByRole('button', { name: /^Agents/ }).tap();
    await nav(page).getByText(project.name, { exact: true }).tap();
    await expect(page.getByRole('main')).toHaveAttribute(
      'aria-label',
      `Conversation with Waykeeper · ${project.name}`,
    );

    // The four-option toggle fits, without a horizontal scroll.
    const toggle = page.getByRole('group', {
      name: 'show the chat, the status, the deliverables or the jobs',
    });
    await expect(toggle.getByRole('button')).toHaveCount(4);
    await expectNoHorizontalScroll(page, toggle);
    for (const button of await toggle.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    // The Jobs pane: no horizontal scroll either.
    await toggle.getByRole('button', { name: /^Jobs/ }).tap();
    const pane = page.getByRole('region', { name: `jobs of ${project.name}` });
    await expect(pane.getByRole('button', { name: job.jobName })).toBeVisible();
    await expectNoHorizontalScroll(page, pane);
    await toggle.getByRole('button', { name: 'Chat', exact: true }).tap();
    await expect(pane).toBeHidden();

    // A tap on the area moon's label opens the Jobs view, filtered to that moon. The camera rests
    // on the planet (the selection flew it there); the label is tapped where the planet is not —
    // a body under the pointer wins over a label, and a ringed planet reaches far.
    await expect(sceneProbe(page)).toHaveAttribute('data-camera', project.bodyId);
    const moon = label(page, job.moonId);
    await expect(moon.locator('.scene-label-title')).toHaveText('Feedback');
    await orbitUntilVisible(page, moon);
    await tapLabelUntil(page, moon, pane);
    await expect(pane.locator('.jobs-filter-title')).toHaveText(/^Feedback · \S+/);
    await expect(pane.getByRole('button', { name: 'Show all jobs' })).toBeVisible();
    await expectNoHorizontalScroll(page, pane);
  });
});
