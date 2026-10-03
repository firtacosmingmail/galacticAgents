// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { INBOX_ID, REVEALED_CLASS, revealQuestion } from '../../panel/inbox-reveal.js';
import { usePickingStore } from '../picking/store.js';
import { PickingOverlay } from '../picking/PickingOverlay.js';
import { activateBeacon } from './activate.js';
import { question, worldWith } from './fixtures.js';

/** The inbox as `Panel.tsx` renders it: the section and one card per question id. */
function inbox(ids: string[]): HTMLElement {
  const section = document.createElement('section');
  section.id = INBOX_ID;
  section.tabIndex = -1;
  for (const id of ids) {
    const card = document.createElement('article');
    card.dataset['questionId'] = id;
    section.append(card);
  }
  document.body.append(section);
  return section;
}

let rafs: FrameRequestCallback[] = [];
const flushRaf = () => {
  const due = rafs;
  rafs = [];
  due.forEach((cb) => cb(0));
};

beforeEach(() => {
  rafs = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafs.push(cb));
  Element.prototype.scrollIntoView = vi.fn();
  useAppStore.setState({
    world: worldWith(
      question('q-c', 'a-st-in', { createdAt: '2026-10-03T10:00:00.000Z' }),
      question('q-p', 'a-st-in', { kind: 'permission', createdAt: '2026-10-03T11:00:00.000Z' }),
    ),
    route: 'panel',
    selection: HARMONIZER,
  });
  usePickingStore.setState({ hover: undefined, popover: undefined });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('clicking a beacon opens its question in the inbox', () => {
  it("reveals the body's first question (permission first), selects nothing, closes a popover", () => {
    vi.useFakeTimers();
    const section = inbox(['q-c', 'q-p']);
    usePickingStore.setState({
      popover: { kind: 'here', x: 0, y: 0, bodies: [], satellites: [] },
    });
    expect(activateBeacon('b-jupiter')).toBe('q-p');
    const card = section.querySelector<HTMLElement>('[data-question-id="q-p"]')!;
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute('tabindex')).toBe('-1');
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(card.classList.contains(REVEALED_CLASS)).toBe(true);
    vi.runAllTimers();
    expect(card.classList.contains(REVEALED_CLASS)).toBe(false);
    expect(selectionKey(useAppStore.getState().selection)).toBe('harmonizer');
    expect(usePickingStore.getState().popover).toBeUndefined();
  });

  it('does nothing for a body without a beacon', () => {
    inbox(['q-c', 'q-p']);
    expect(activateBeacon('b-mars')).toBeUndefined();
    expect(document.activeElement).toBe(document.body);
  });

  it('waits for the inbox to mount, then reveals the inbox itself if the card never shows', () => {
    expect(revealQuestion('q-p', 2)).toBe(false);
    flushRaf();
    const section = inbox([]);
    expect(document.activeElement).not.toBe(section);
    flushRaf(); // retries exhausted: the inbox is revealed instead
    expect(document.activeElement).toBe(section);
    expect(section.scrollIntoView).toHaveBeenCalled();
  });

  it('a card mounted a frame later is still found', () => {
    expect(revealQuestion('q-p')).toBe(false);
    const section = inbox(['q-p']);
    flushRaf();
    expect(document.activeElement).toBe(section.querySelector('[data-question-id="q-p"]'));
  });
});

describe('the beacon hover card', () => {
  it('shows the first question, who asks, and how many more', () => {
    render(<PickingOverlay />);
    act(() =>
      usePickingStore.getState().setHover({ kind: 'beacon', bodyId: 'b-jupiter', others: 0 }),
    );
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Permission:');
    expect(card.textContent).toContain('question q-p');
    expect(card.textContent).toMatch(/Steward · /);
    expect(card.textContent).toContain('+1 more on Jupiter');
  });

  it('follows the store: answering the question elsewhere updates, then removes the card', () => {
    render(<PickingOverlay />);
    act(() =>
      usePickingStore.getState().setHover({ kind: 'beacon', bodyId: 'b-jupiter', others: 0 }),
    );
    const answer = (id: string) =>
      act(() => {
        const world = useAppStore.getState().world;
        useAppStore.setState({
          world: {
            ...world,
            questions: {
              ...world.questions,
              [id]: { ...world.questions[id]!, status: 'answered' },
            },
          },
        });
      });
    answer('q-p');
    expect(screen.getByRole('tooltip').textContent).toContain('Question:');
    answer('q-c');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
