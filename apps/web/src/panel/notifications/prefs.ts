import { create } from 'zustand';
import { NotificationKind } from '@galactic/protocol';

/**
 * Desktop notification preferences (P25-07, SPEC §4.5). Notifications are per device, so these
 * live in this browser's `localStorage` only, never on the server: the user's opt-in, and one
 * switch per notification kind (all on by default).
 */

export const PREFS_KEY = 'galactic.notifications.prefs';

export type NotificationKinds = Record<NotificationKind, boolean>;

/** What the browser allows: `unsupported` when there is no Notification API at all. */
export type BrowserPermission = NotificationPermission | 'unsupported';

/** The kinds in the order the settings list them, with their labels. */
export const KIND_LABELS: readonly { kind: NotificationKind; label: string }[] = [
  { kind: 'permission', label: 'A permission request waits for you' },
  { kind: 'question', label: 'A question is asked of you' },
  { kind: 'task_completed', label: 'A task finished' },
  { kind: 'task_failed', label: 'A task failed' },
  { kind: 'project_completed', label: 'A project finished' },
  { kind: 'project_failed', label: 'A project failed' },
  { kind: 'interrupted', label: 'Work interrupted by a restart needs you' },
  { kind: 'no_space', label: 'A request is waiting for a free planet or moon' },
];

export const allKindsOn = (): NotificationKinds =>
  Object.fromEntries(NotificationKind.options.map((k) => [k, true])) as NotificationKinds;

interface StoredPrefs {
  enabled: boolean;
  kinds: NotificationKinds;
}

/**
 * Set once a write to storage fails (quota, private mode): from then on this page's own copy is
 * the truth, since what storage holds is stale.
 */
let storageBroken = false;

/** The preferences in storage, or undefined when there are none (or storage cannot be read). */
function readStoredPrefs(): StoredPrefs | undefined {
  if (storageBroken) return undefined;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    const kinds = allKindsOn();
    for (const k of NotificationKind.options) {
      const v = parsed.kinds?.[k];
      if (typeof v === 'boolean') kinds[k] = v;
    }
    return { enabled: parsed.enabled === true, kinds };
  } catch {
    return undefined;
  }
}

function readPrefs(): StoredPrefs {
  return readStoredPrefs() ?? { enabled: false, kinds: allKindsOn() };
}

function writePrefs(prefs: StoredPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: the preference lasts for this page only.
    storageBroken = true;
  }
}

/** The browser's Notification constructor, if it has one. */
export function notificationApi(): typeof Notification | undefined {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined;
}

export function browserPermission(): BrowserPermission {
  const api = notificationApi();
  if (!api) return 'unsupported';
  try {
    return api.permission;
  } catch {
    return 'unsupported';
  }
}

export interface NotificationPrefsState {
  /** The user turned desktop notifications on in this browser. */
  enabled: boolean;
  kinds: NotificationKinds;
  permission: BrowserPermission;
  /**
   * Turns notifications on. Asks the browser for permission when it has not been granted yet, so
   * call it only from a user gesture (a click): browsers ignore or penalise prompts without one.
   */
  enable: () => Promise<void>;
  disable: () => void;
  setKind: (kind: NotificationKind, on: boolean) => void;
  /** Reads the browser's permission again (the user may have changed it in the site settings). */
  refreshPermission: () => void;
  /** Reads the stored preferences again (tests; another tab's change). */
  reload: () => void;
}

const samePrefs = (a: StoredPrefs, b: StoredPrefs) =>
  a.enabled === b.enabled && NotificationKind.options.every((k) => a.kinds[k] === b.kinds[k]);

export const useNotificationPrefs = create<NotificationPrefsState>((set, get) => ({
  ...readPrefs(),
  permission: browserPermission(),
  enable: async () => {
    const api = notificationApi();
    if (!api) {
      set({ permission: 'unsupported' });
      return;
    }
    let permission = browserPermission();
    if (permission === 'default') {
      try {
        permission = await api.requestPermission();
      } catch {
        permission = browserPermission();
      }
    }
    const enabled = permission === 'granted';
    set({ permission, enabled });
    writePrefs({ enabled, kinds: get().kinds });
  },
  disable: () => {
    set({ enabled: false });
    writePrefs({ enabled: false, kinds: get().kinds });
  },
  setKind: (kind, on) => {
    const kinds = { ...get().kinds, [kind]: on };
    set({ kinds });
    writePrefs({ enabled: get().enabled, kinds });
  },
  refreshPermission: () => set({ permission: browserPermission() }),
  reload: () => {
    if (storageBroken) set({ permission: browserPermission() });
    else set({ ...readPrefs(), permission: browserPermission() });
  },
}));

// Another tab changed the preferences (the user turned notifications on there): follow it, so
// this tab decides as the user just chose.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === PREFS_KEY || e.key === null) useNotificationPrefs.getState().reload();
  });
}

/**
 * The preferences as they stand now: what storage holds (another tab may have changed them, and
 * its `storage` event may not have arrived yet), else this page's copy. The store is brought up
 * to date when they differ.
 */
export function currentPrefs(): StoredPrefs {
  const state = useNotificationPrefs.getState();
  const stored = readStoredPrefs();
  if (!stored) return { enabled: state.enabled, kinds: state.kinds };
  if (!samePrefs(stored, state)) useNotificationPrefs.setState(stored);
  return stored;
}

/** Whether a notification of this kind should be shown now (decided on the current prefs). */
export function shouldShow(kind: NotificationKind): boolean {
  const { enabled, kinds } = currentPrefs();
  return enabled && kinds[kind] && browserPermission() === 'granted';
}

/** Whether notifications are on at all (opted in and allowed by the browser). */
export function notificationsActive(): boolean {
  return currentPrefs().enabled && browserPermission() === 'granted';
}

/** Forgets that storage refused a write (tests). */
export function resetPrefsStorage(): void {
  storageBroken = false;
}
