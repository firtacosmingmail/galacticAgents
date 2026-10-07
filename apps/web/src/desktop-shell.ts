/**
 * Whether the page runs inside the desktop shell (P8-06, docs/DESKTOP.md). The shell sets
 * `window.__GALACTIC_DESKTOP__` before the page's scripts run; it is a flag only (no bridge, no
 * capability). Inside the shell the menu bar app posts the OS notifications itself, so the page's
 * own desktop notifications stay off: one notification per event, never two.
 */
export interface DesktopShellFlag {
  shell: 'tauri';
  notifications: 'shell';
}

export function desktopShell(): DesktopShellFlag | undefined {
  const flag = (globalThis as { __GALACTIC_DESKTOP__?: unknown }).__GALACTIC_DESKTOP__;
  if (typeof flag !== 'object' || flag === null) return undefined;
  return (flag as Partial<DesktopShellFlag>).notifications === 'shell'
    ? (flag as DesktopShellFlag)
    : undefined;
}

/** True when the shell, not the page, posts the notifications. */
export const shellPostsNotifications = () => desktopShell() !== undefined;
