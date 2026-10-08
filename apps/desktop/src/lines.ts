import type { StorageCondition } from '@galactic/protocol';
import type { TrayAnswer } from './answer.js';
import type { TrayMenu } from './tray-menu.js';

/**
 * The line protocol between the desktop shell's two halves (P8-06, docs/DESKTOP.md):
 *
 * - the **Rust shell** (`src-tauri`): the window, the menu bar icon, OS notifications, the login
 *   item; it starts this Node process and reads its stdout;
 * - the **Node side** (`main.ts`): the server's lifecycle (attach or start, stop on quit) and the
 *   status watcher (one WebSocket to Mission Control, folded like the page folds it).
 *
 * Node → Rust: one JSON object per stdout line (`ShellLine`). Nothing else is ever written to
 * stdout; logs go to stderr. Rust → Node: one line per command (`ShellCommand`): a word (`quit`,
 * `start`) or, for an answer from the menu (P9-15), a JSON object
 * `{"type":"answer","questionId":…,"version":…,"decision":"allow"|"deny"}`; stdin closing (the
 * shell died) counts as `quit`. Anything else is ignored.
 *
 * No line ever carries the token.
 */

/** Where the shell's Mission Control is and whether the shell started it. */
export interface ServerInfo {
  /** The page's origin: always `http://127.0.0.1:<port>` (the server binds loopback only). */
  url: string;
  port: number;
  /** True when this shell started it (and stops it on quit); false when attached. */
  owned: boolean;
  /** The server's pid as the data lock names it (attached), or the launcher's (owned). */
  pid?: number;
}

/**
 * The connection as the menu bar shows it:
 * - `starting`: the shell is starting Mission Control (or waiting for one that is starting);
 * - `live`: the status socket is live;
 * - `disconnected`: Mission Control should be running but the socket is down (it reconnects);
 * - `stopped`: no Mission Control runs and the shell will not start one by itself (the menu's
 *   "Start Mission Control" does);
 * - `error`: the shell cannot start or reach one (the detail says why).
 */
export type ConnectionState = 'starting' | 'live' | 'disconnected' | 'stopped' | 'error';

/** What the menu bar icon shows (computed here, rendered as is by Rust: `trayView`). */
export interface TrayView {
  /** The menu's first, disabled line: "Live", "3 waiting for you", "Disconnected"… */
  label: string;
  /** Text next to the icon (macOS menu bar title): the waiting count, "!" or "". */
  title: string;
  /** The icon's tooltip. */
  tooltip: string;
  /** The menu's second line: which Mission Control and who started it. */
  serverLabel: string;
  /** Whether "Start Mission Control" is offered. */
  canStart: boolean;
}

export type ShellLine =
  | { type: 'server'; server: ServerInfo }
  | {
      type: 'status';
      state: ConnectionState;
      waiting: number;
      storage: StorageCondition;
      view: TrayView;
      detail?: string;
    }
  | { type: 'notify'; id: string; title: string; body?: string }
  /**
   * The menu's question sections (P9-15, `tray-menu.ts`): sent when they change, empty while
   * the status socket is not live (nothing can be answered then).
   */
  | { type: 'menu'; menu: TrayMenu }
  | { type: 'exited' };

export type ShellCommand = 'quit' | 'start' | ({ type: 'answer' } & TrayAnswer);

/** The longest command line read (an answer is well under it). */
const MAX_COMMAND = 4096;

export function parseCommand(line: string): ShellCommand | undefined {
  const text = line.trim();
  if (text === 'quit' || text === 'start') return text;
  if (!text.startsWith('{') || text.length > MAX_COMMAND) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, questionId, version, decision } = data as Record<string, unknown>;
  if (
    type !== 'answer' ||
    typeof questionId !== 'string' ||
    questionId.length === 0 ||
    questionId.length > 200 ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    (decision !== 'allow' && decision !== 'deny')
  ) {
    return undefined;
  }
  return { type: 'answer', questionId, version, decision };
}
