// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { INBOX_ID, REVEALED_CLASS, revealQuestion } from '../../panel/inbox-reveal.js';
import { usePickingStore } from '../picking/store.js';
import { useCameraStore } from '../camera/store.js';
import { PickingOverlay } from '../picking/PickingOverlay.js';
import { activateBeacon } from './activate.js';
import { BeaconHoverCard } from './BeaconHoverCard.js';
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

const realFlyTo = useCameraStore.getState().flyTo;
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
  useCameraStore.setState({ flyTo: realFlyTo, request: undefined, focusedId: undefined });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('clicking a beacon goes to its asker and opens its question in the inbox (P4-13)', () => {
  it('selects the asking agent, flies to its body, reveals that question, closes a popover', () => {
    vi.useFakeTimers();
    const section = inbox(['q-c', 'q-p']);
    const flyTo = vi.fn(() => true);
    useCameraStore.setState({ flyTo });
    usePickingStore.setState({
      popover: { kind: 'here', x: 0, y: 0, bodies: [], satellites: [] },
    });
    // The clarification, second in Jupiter's row: its own card, not the body's first.
    expect(activateBeacon('q-c')).toBe('q-c');
    const card = section.querySelector<HTMLElement>('[data-question-id="q-c"]')!;
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute('tabindex')).toBe('-1');
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(card.classList.contains(REVEALED_CLASS)).toBe(true);
    vi.runAllTimers();
    expect(card.classList.contains(REVEALED_CLASS)).toBe(false);
    expect(selectionKey(useAppStore.getState().selection)).toBe('steward:a-st-in');
    expect(flyTo).toHaveBeenCalledWith('b-jupiter');
    expect(usePickingStore.getState().popover).toBeUndefined();
  });

  it("the Harmonizer's own question selects the Harmonizer and flies to Earth", () => {
    inbox(['q-h']);
    const flyTo = vi.fn(() => true);
    useCameraStore.setState({ flyTo });
    useAppStore.setState({
      world: worldWith(question('q-h', 'a-h')),
      selection: { kind: 'waykeeper', id: 'a-wk-new' },
    });
    expect(activateBeacon('q-h')).toBe('q-h');
    expect(selectionKey(useAppStore.getState().selection)).toBe('harmonizer');
    expect(flyTo).toHaveBeenCalledWith('b-earth');
  });

  it('an asker not loaded: the selection stays, the camera still flies to the body', () => {
    inbox(['q-x']);
    const flyTo = vi.fn(() => true);
    useCameraStore.setState({ flyTo });
    const q = question('q-x', 'a-gone');
    q.context = { text: 'x', origin: { role: 'steward', taskId: 't-ast', recent: [] } };
    useAppStore.setState({ world: worldWith(q) });
    expect(activateBeacon('q-x')).toBe('q-x');
    expect(selectionKey(useAppStore.getState().selection)).toBe('harmonizer');
    expect(flyTo).toHaveBeenCalledWith('b-ast-7');
  });

  it('does nothing for a question that waits no more (or an unknown one)', () => {
    inbox(['q-c', 'q-p']);
    const flyTo = vi.fn(() => true);
    useCameraStore.setState({ flyTo });
    const world = useAppStore.getState().world;
    useAppStore.setState({
      world: {
        ...world,
        questions: {
          ...world.questions,
          'q-c': { ...world.questions['q-c']!, status: 'answered' },
        },
      },
    });
    expect(activateBeacon('q-c')).toBeUndefined();
    expect(activateBeacon('q-none')).toBeUndefined();
    expect(document.activeElement).toBe(document.body);
    expect(flyTo).not.toHaveBeenCalled();
    expect(selectionKey(useAppStore.getState().selection)).toBe('harmonizer');
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
  it('shows that beacon’s question and who asks, nothing about the others', () => {
    render(<PickingOverlay />);
    act(() =>
      usePickingStore
        .getState()
        .setHover({ kind: 'beacon', questionId: 'q-c', bodyId: 'b-jupiter' }),
    );
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Question:');
    expect(card.textContent).toContain('question q-c');
    expect(card.textContent).not.toContain('q-p');
    expect(card.textContent).toMatch(/Steward · /);
    expect(card.textContent).not.toContain('more on');
    expect(card.textContent).toContain('click to go there and open it in the inbox');
  });

  it('a status flush does not re-render the card', () => {
    let commits = 0;
    render(
      <Profiler id="card" onRender={() => void commits++}>
        <BeaconHoverCard questionId="q-p" />
      </Profiler>,
    );
    const card = screen.getByRole('tooltip');
    const before = commits;
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({ world: { ...world, statuses: { ...world.statuses } } });
    });
    expect(commits).toBe(before);
    expect(screen.getByRole('tooltip')).toBe(card);
  });

  it('follows the store: answering another question leaves it, answering its own removes it', () => {
    render(<PickingOverlay />);
    act(() =>
      usePickingStore
        .getState()
        .setHover({ kind: 'beacon', questionId: 'q-c', bodyId: 'b-jupiter' }),
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
