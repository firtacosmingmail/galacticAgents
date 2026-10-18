// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { useAnswerQueue } from '../../client/answer-queue.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { QuestionSetCard } from './QuestionSetCard.js';
import {
  SET_ID,
  SET_TITLE,
  setRows,
  setWaykeeper,
  withSupervisorAnswer,
} from './question-set-fixtures.js';

/**
 * P8-21 (SPEC decision 141): the question-set card — one question per page with Back / Skip /
 * Next, a review page, one "Send N answers", drafts kept on the server, the supervisor's answers
 * read-only, × for the whole set, and the race where someone answers a row first.
 */

let api: {
  answerSet: ReturnType<typeof vi.fn>;
  draftQuestion: ReturnType<typeof vi.fn>;
  dismissSet: ReturnType<typeof vi.fn>;
};
let seq = 5;

function world(questions: Question[] = setRows) {
  seq = 5;
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq,
    agents: [fx.harmonizer, setWaykeeper],
    bodies: [fx.body, fx.moon],
    projects: [fx.project],
    tasks: [fx.task],
    questions,
    proposals: [],
    statuses: [],
  });
  useAppStore.setState({ status: 'live' });
}

async function stream(event: Event) {
  seq += 1;
  await act(async () => {
    useAppStore.getState().apply({ type: 'event', seq, at: fx.NOW, event });
  });
}

const show = () =>
  render(
    <ApiContext.Provider value={api as unknown as Api}>
      <QuestionSetCard setId={SET_ID} />
    </ApiContext.Provider>,
  );

const card = () => screen.getByRole('article');
const button = (name: string | RegExp) => within(card()).getByRole('button', { name });
const pill = () => card().querySelector('.qset-pill')!.textContent;
const dots = () =>
  Array.from(card().querySelectorAll('.qset-dots li')).map((li) =>
    li.className.replace('qset-dot', '').trim(),
  );
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
}
async function type(text: string) {
  await act(async () => {
    fireEvent.change(within(card()).getByRole('textbox', { name: /write your own answer/i }), {
      target: { value: text },
    });
  });
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAnswerQueue.setState({ scope: undefined, entries: {}, announcement: undefined });
  localStorage.clear();
  api = {
    answerSet: vi.fn(async () => ({ ok: true })),
    draftQuestion: vi.fn(async () => ({ ok: true })),
    dismissSet: vi.fn(async () => ({ ok: true })),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the question-set card (P8-21)', () => {
  it('shows the asker, the route, the title and the first question', () => {
    world();
    show();
    expect(card().className).toContain('question-set');
    const header = card().querySelector('header')!;
    expect(header.textContent).toContain(`Waykeeper · Auth refactor · ${SET_TITLE}`);
    expect(header.textContent).toContain('via Harmonizer');
    expect(header.textContent).toContain('3 questions');
    expect(pill()).toBe('1 of 3');
    expect(within(card()).getByText('Keep the old REST routes?')).toBeTruthy();
    expect(dots()).toEqual(['is-current', '', '']);
  });

  it('steps through the questions; Back keeps the choice', async () => {
    world();
    show();
    await click(button('Yes'));
    expect(button('Yes').getAttribute('aria-pressed')).toBe('true');
    expect(button('No, remove them').getAttribute('aria-pressed')).toBe('false');
    await click(button(/Next/));
    expect(pill()).toBe('2 of 3');
    expect(within(card()).getByText('Which auth provider?')).toBeTruthy();
    expect(dots()).toEqual(['is-answered', 'is-current', '']);
    await click(button(/Back/));
    expect(pill()).toBe('1 of 3');
    expect(button('Yes').getAttribute('aria-pressed')).toBe('true');
  });

  it('skips a question, reviews the answers and sends them in one call', async () => {
    world();
    show();
    await click(button('No, remove them'));
    await click(button(/Next/));
    await click(button('Skip'));
    expect(pill()).toBe('3 of 3');
    expect(dots()).toEqual(['is-answered', 'is-skipped', 'is-current']);
    // Multi-select: two options toggle on, independently.
    await click(button('Chrome'));
    await click(button('Safari'));
    expect(button('Chrome').getAttribute('aria-pressed')).toBe('true');
    expect(button('Safari').getAttribute('aria-pressed')).toBe('true');
    await click(button(/Next/));
    expect(pill()).toBe('Review');
    const review = within(card()).getByRole('list', { name: 'your answers' });
    expect(review.textContent).toContain('Keep the old REST routes?');
    expect(review.textContent).toContain('No, remove them');
    expect(review.textContent).toMatch(/Which auth provider\?.*skipped/);
    expect(review.textContent).toContain('Chrome, Safari');
    await click(button('Send 2 answers'));
    expect(api.answerSet).toHaveBeenCalledTimes(1);
    const [setId, answers, answerId] = api.answerSet.mock.calls[0]!;
    expect(setId).toBe(SET_ID);
    expect(typeof answerId).toBe('string');
    expect(answers).toEqual([
      { questionId: 'q-s1', version: 1, answer: { choices: ['No, remove them'] } },
      { questionId: 'q-s2', version: 1, answer: { choices: [], skipped: true } },
      { questionId: 'q-s3', version: 1, answer: { choices: ['Chrome', 'Safari'] } },
    ]);
  });

  it('takes a written answer alone, and jumps back to a question from the review', async () => {
    world();
    show();
    await type('Keep them one more release');
    await click(button(/Next/));
    await click(button('Skip'));
    await click(button('Skip'));
    expect(pill()).toBe('Review');
    expect(button('Send 1 answer').hasAttribute('disabled')).toBe(false);
    await click(button(/Which auth provider\?/));
    expect(pill()).toBe('2 of 3');
  });

  it('does not let Next pass an unanswered question, and cannot send with one empty', async () => {
    world();
    show();
    expect(button(/Next/).hasAttribute('disabled')).toBe(true);
    await click(button('Yes'));
    expect(button(/Next/).hasAttribute('disabled')).toBe(false);
  });

  it('saves drafts on Next and resumes at the first unanswered question on remount', async () => {
    world();
    const first = show();
    await click(button('Yes'));
    await click(button(/Next/));
    expect(api.draftQuestion).toHaveBeenCalledWith('q-s1', { choices: ['Yes'] });
    // The server folds it into meta.draft; the stream brings it back.
    await stream({
      type: 'question.drafted',
      questionId: 'q-s1',
      draft: { choices: ['Yes'] },
      by: { type: 'user' },
    });
    first.unmount();
    show();
    expect(pill()).toBe('2 of 3');
    await click(button(/Back/));
    expect(button('Yes').getAttribute('aria-pressed')).toBe('true');
  });

  it('saves a written draft 600 ms after typing stops', async () => {
    vi.useFakeTimers();
    world();
    show();
    await type('maybe');
    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    expect(api.draftQuestion).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(api.draftQuestion).toHaveBeenCalledWith('q-s1', { choices: [], text: 'maybe' });
  });

  it('takes another device’s draft for a row, but not for the row being edited', async () => {
    world();
    show();
    await click(button('Yes'));
    // The phone saved other values for row 1 (being edited here) and row 2.
    await stream({
      type: 'question.drafted',
      questionId: 'q-s1',
      draft: { choices: ['No, remove them'] },
      by: { type: 'user' },
    });
    await stream({
      type: 'question.drafted',
      questionId: 'q-s2',
      draft: { choices: ['Clerk'] },
      by: { type: 'user' },
    });
    expect(button('Yes').getAttribute('aria-pressed')).toBe('true');
    await click(button(/Next/));
    expect(button('Clerk').getAttribute('aria-pressed')).toBe('true');
  });

  it('a saved row is no longer this device’s edit: another device’s later draft wins (final review)', async () => {
    vi.useFakeTimers();
    world();
    show();
    await type('maybe');
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(api.draftQuestion).toHaveBeenCalledTimes(1);
    // The server echoes this save, then the phone saves a newer draft of the same row.
    await stream({
      type: 'question.drafted',
      questionId: 'q-s1',
      draft: { choices: [], text: 'maybe' },
      by: { type: 'user' },
    });
    await stream({
      type: 'question.drafted',
      questionId: 'q-s1',
      draft: { choices: [], text: 'later' },
      by: { type: 'user' },
    });
    // Still on row 1, with no new edit here: the phone's draft shows and Next saves nothing.
    const box = within(card()).getByRole('textbox', { name: /write your own answer/i });
    expect((box as HTMLTextAreaElement).value).toBe('later');
    await click(button(/Next/));
    expect(api.draftQuestion).toHaveBeenCalledTimes(1);
  });

  it('shows a row a supervisor answered read-only on the review page', async () => {
    world(withSupervisorAnswer());
    show();
    expect(pill()).toBe('1 of 2');
    await click(button('Yes'));
    await click(button(/Next/));
    await click(button('Firefox'));
    await click(button(/Next/));
    expect(pill()).toBe('Review');
    const review = within(card()).getByRole('list', { name: 'your answers' });
    expect(review.textContent).toMatch(/Which auth provider\?.*answered by Harmonizer.*Auth\.js/);
    // Not a button: it was delivered already.
    expect(within(review).queryByRole('button', { name: /Which auth provider/ })).toBeNull();
    await click(button('Send 2 answers'));
    expect(api.answerSet.mock.calls[0]![1]).toHaveLength(2);
  });

  it('× asks once, then dismisses the whole set', async () => {
    world();
    show();
    await click(button(/Dismiss the question set/));
    expect(api.dismissSet).not.toHaveBeenCalled();
    const confirm = within(card()).getByRole('group', { name: 'confirm dismissal' });
    expect(confirm.textContent).toContain(
      'Dismiss these 3 questions? Your answers so far are discarded.',
    );
    await click(within(confirm).getByRole('button', { name: 'Keep them' }));
    expect(within(card()).queryByRole('group', { name: 'confirm dismissal' })).toBeNull();
    expect(api.dismissSet).not.toHaveBeenCalled();
    await click(button(/Dismiss the question set/));
    await click(button('Dismiss 3 questions'));
    expect(api.dismissSet).toHaveBeenCalledWith(SET_ID);
  });

  it('keeps answers given offline and saves them as drafts when the stream is back', async () => {
    world();
    useAppStore.setState({ status: 'disconnected' });
    show();
    await click(button('Yes'));
    await click(button(/Next/));
    await click(button('Clerk'));
    await click(button(/Next/));
    expect(api.draftQuestion).not.toHaveBeenCalled();
    await act(async () => {
      useAppStore.setState({ status: 'live' });
    });
    expect(api.draftQuestion.mock.calls).toEqual([
      ['q-s1', { choices: ['Yes'] }],
      ['q-s2', { choices: ['Clerk'] }],
    ]);
  });

  it('saves only a row edited here: viewing a row and pressing Next overwrites nothing', async () => {
    world(
      setRows.map((q) => (q.id === 'q-s1' ? { ...q, meta: { draft: { choices: ['Yes'] } } } : q)),
    );
    show();
    expect(pill()).toBe('2 of 3');
    await click(button(/Back/));
    // Another device changes row 1 while it is shown here, unedited: it is taken.
    await stream({
      type: 'question.drafted',
      questionId: 'q-s1',
      draft: { choices: ['No, remove them'] },
      by: { type: 'user' },
    });
    expect(button('No, remove them').getAttribute('aria-pressed')).toBe('true');
    await click(button(/Next/));
    await click(button('Skip'));
    expect(api.draftQuestion.mock.calls.map((c) => c[0])).toEqual(['q-s2']);
  });

  it('Skip keeps a typed answer in the draft, marked skipped; Back shows it again', async () => {
    world();
    show();
    await type('maybe later');
    await click(button('Skip'));
    expect(dots()[0]).toBe('is-skipped');
    expect(api.draftQuestion).toHaveBeenCalledWith('q-s1', {
      choices: [],
      text: 'maybe later',
      skipped: true,
    });
    await click(button(/Back/));
    expect(
      (within(card()).getByRole('textbox', { name: /write your own answer/i }) as HTMLInputElement)
        .value,
    ).toBe('maybe later');
    await click(button('Skip'));
    await click(button('Skip'));
    await click(button('Skip'));
    expect(within(card()).getByRole('list', { name: 'your answers' }).textContent).toMatch(
      /Keep the old REST routes\?.*skipped/,
    );
    await click(button('Send (every question skipped)'));
    expect(api.answerSet.mock.calls[0]![1][0]).toEqual({
      questionId: 'q-s1',
      version: 1,
      answer: { choices: [], skipped: true },
    });
  });

  it('says who answered first when the send is refused stale, and keeps the other drafts', async () => {
    world();
    show();
    await click(button('Yes'));
    await click(button(/Next/));
    await click(button('Clerk'));
    await click(button(/Next/));
    await type('all of them');
    await click(button(/Next/));
    api.answerSet.mockImplementationOnce(async () => {
      // The Harmonizer answered row 2 meanwhile; the stream says so with the refusal.
      await stream({
        type: 'question.answered',
        questionId: 'q-s2',
        answer: 'Auth.js',
        answeredBy: { type: 'agent', id: fx.harmonizer.id },
        version: 2,
      });
      throw new ApiError(409, 'question q-s2 was already answered by agent a-harmonizer', 'stale');
    });
    await click(button('Send 3 answers'));
    const alert = within(card()).getByRole('alert');
    expect(alert.textContent).toContain('Not sent: already answered by Harmonizer: "Auth.js"');
    const review = within(card()).getByRole('list', { name: 'your answers' });
    expect(review.textContent).toContain('Yes');
    expect(review.textContent).toContain('all of them');
    expect(review.textContent).toMatch(/Which auth provider\?.*answered by Harmonizer/);
    expect(within(review).queryByRole('button', { name: /Which auth provider/ })).toBeNull();
    expect(pill()).toBe('Review');
    await click(button('Send 2 answers'));
    expect(
      api.answerSet.mock.calls[1]![1].map((a: { questionId: string }) => a.questionId),
    ).toEqual(['q-s1', 'q-s3']);
  });

  it('turns into a read-only summary once every row is answered', async () => {
    world(
      setRows.map((q) => ({
        ...q,
        status: 'answered' as const,
        answer: 'Yes',
        answeredBy: { type: 'user' as const },
        version: 2,
      })),
    );
    show();
    expect(pill()).toBe('Answered');
    expect(within(card()).queryByRole('button', { name: /Send/ })).toBeNull();
    expect(card().textContent).toContain('answered by you');
  });

  it('has no serious accessibility findings on a page and on the review', async () => {
    world(withSupervisorAnswer());
    show();
    expect(blocking(await axeFindings(card()))).toEqual([]);
    await click(button('Yes'));
    await click(button(/Next/));
    await click(button('Skip'));
    expect(pill()).toBe('Review');
    expect(blocking(await axeFindings(card()))).toEqual([]);
  });
});
