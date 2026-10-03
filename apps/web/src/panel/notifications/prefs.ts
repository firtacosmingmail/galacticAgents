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

function readPrefs(): StoredPrefs {
  const fallback: StoredPrefs = { enabled: false, kinds: allKindsOn() };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    const kinds = allKindsOn();
    for (const k of NotificationKind.options) {
      const v = parsed.kinds?.[k];
      if (typeof v === 'boolean') kinds[k] = v;
    }
    return { enabled: parsed.enabled === true, kinds };
  } catch {
    return fallback;
  }
}

function writePrefs(prefs: StoredPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: the preference lasts for this page only.
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
  reload: () => set({ ...readPrefs(), permission: browserPermission() }),
}));

/** Whether a notification of this kind should be shown now. */
export function shouldShow(kind: NotificationKind): boolean {
  const { enabled, kinds } = useNotificationPrefs.getState();
  return enabled && kinds[kind] && browserPermission() === 'granted';
}

/** Whether notifications are on at all (opted in and allowed by the browser). */
export function notificationsActive(): boolean {
  return useNotificationPrefs.getState().enabled && browserPermission() === 'granted';
}
