import type { NotificationTarget } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { questionOwner } from '../../state/conversation.js';
import { agentsFor } from '../../console/hierarchy/shared.js';
import { primaryAgent } from '../nav-model.js';
import { selectionFor } from '../cards/links.js';
import { useAppStore } from '../../state/store.js';
import { phoneViewActive } from '../phone-view.js';
import { revealInbox } from '../inbox-reveal.js';

/** Where a notification's click lands: a selection, and whether to bring the inbox into view. */
export interface Focus {
  selection: Selection;
  inbox: boolean;
}

type World = Pick<WorldState, 'agents' | 'tasks' | 'projects' | 'questions' | 'statuses'>;

const projectWaykeeper = (world: World, projectId: string): Selection | undefined => {
  const agent = primaryAgent(world, agentsFor(world, { projectId }));
  return agent ? { kind: 'waykeeper', id: agent.id } : undefined;
};

/**
 * What a notification's click selects (P25-07; decisions 53 and 55):
 * - a question: the thread that shows its card (the project's current Waykeeper, else the
 *   Harmonizer); the inbox when that thread cannot be found;
 * - a task: its Steward — the newest live one, else the newest — else its project's Waykeeper;
 * - a project: its Waykeeper the same way;
 * - an interrupted agent: its own view;
 * - a request parked for lack of space: the Harmonizer's thread, with the inbox in view.
 */
export function focusFor(world: World, target: NotificationTarget): Focus {
  switch (target.kind) {
    case 'question': {
      const q = world.questions[target.id];
      const owner = q ? questionOwner(world, q) : undefined;
      if (owner?.role === 'harmonizer') return { selection: HARMONIZER, inbox: false };
      if (owner?.role === 'waykeeper') {
        const sel = projectWaykeeper(world, owner.projectId);
        if (sel) return { selection: sel, inbox: false };
      }
      return { selection: HARMONIZER, inbox: true };
    }
    case 'task': {
      const steward = primaryAgent(world, agentsFor(world, { taskId: target.id }));
      if (steward) return { selection: { kind: 'steward', id: steward.id }, inbox: false };
      const projectId = world.tasks[target.id]?.projectId;
      const sel = projectId ? projectWaykeeper(world, projectId) : undefined;
      return { selection: sel ?? HARMONIZER, inbox: false };
    }
    case 'project':
      return { selection: projectWaykeeper(world, target.id) ?? HARMONIZER, inbox: false };
    case 'agent': {
      const agent = world.agents[target.id];
      return { selection: agent ? selectionFor(agent) : HARMONIZER, inbox: false };
    }
    case 'proposal':
      return { selection: HARMONIZER, inbox: true };
  }
}

/** Focuses the window and selects what the notification is about. */
export function focusTarget(target: NotificationTarget | undefined): void {
  try {
    window.focus();
  } catch {
    // Some browsers refuse; the selection still changes.
  }
  const store = useAppStore.getState();
  const focus = target ? focusFor(store.world, target) : { selection: HARMONIZER, inbox: true };
  store.navigate({ route: 'panel', selection: focus.selection });
  // P8-18: on a phone a question or a card is answered in the inbox, which opens full screen.
  if (phoneViewActive() && (!target || target.kind === 'question' || target.kind === 'proposal'))
    revealInbox();
  else if (focus.inbox) scrollInboxIntoView();
}

const nextFrame = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

/**
 * Scrolls the inbox into view once the panel has rendered: after a navigation (from the settings
 * page, say) it is not in the document yet, so this waits a frame and retries a couple of times.
 */
export function scrollInboxIntoView(retries = 2): void {
  nextFrame(() => {
    const inbox = document.querySelector('[aria-label="inbox"]');
    if (inbox && typeof inbox.scrollIntoView === 'function') inbox.scrollIntoView();
    else if (retries > 0) scrollInboxIntoView(retries - 1);
  });
}
