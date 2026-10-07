import type { SlashCommand } from '@galactic/protocol';

/**
 * The composer's pure helpers (P8-13, P8-14): which slash commands match what is typed, and
 * which of the user's earlier messages ↑ recalls. No React here, so the rules are tested alone.
 */

/** Most commands the list shows at once (the rest are reached by typing more). */
export const SLASH_LIST_MAX = 50;

/**
 * What the slash list filters on: the text after a leading `/` while the message is still that
 * one word (no space, no new line, no second `/`). `undefined` when the list has nothing to do:
 * the text does not start with `/`, or the command's name is finished (a space follows it).
 */
export function slashQuery(text: string): string | undefined {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * The commands matching `query`, best first: names (or aliases: `/cost` finds `/usage`) that
 * start with it, then names that contain it, then those whose description does; alphabetical
 * within each group; case-insensitive. An empty query lists every command alphabetically. At most
 * `SLASH_LIST_MAX`.
 */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);
  const prefix: SlashCommand[] = [];
  const inName: SlashCommand[] = [];
  const inDescription: SlashCommand[] = [];
  for (const c of commands) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) prefix.push(c);
    else if (names.some((n) => n.includes(q))) inName.push(c);
    else if (q && c.description?.toLowerCase().includes(q)) inDescription.push(c);
  }
  return [...prefix.sort(byName), ...inName.sort(byName), ...inDescription.sort(byName)].slice(
    0,
    SLASH_LIST_MAX,
  );
}

/** What choosing a command puts in the composer: `/name ` (the arguments follow the space). */
export const insertion = (command: SlashCommand): string => `/${command.name} `;

/**
 * Whether `query` (the text after the `/`) is already a whole command name or alias, exactly as
 * typed: Enter then sends the message instead of inserting (as Claude Code does, P8-13 review N9).
 */
export const isWholeCommand = (commands: readonly SlashCommand[], query: string): boolean =>
  query !== '' && commands.some((c) => c.name === query || (c.aliases?.includes(query) ?? false));

/**
 * A key event that belongs to an input method's composition (P8-13 review S5): `isComposing`,
 * or the `keyCode` 229 that WebKit (Safari, the desktop app's WKWebView) gives the Enter that
 * commits a composition — after `compositionend`, with `isComposing` already false.
 */
export const composing = (e: { nativeEvent: { isComposing?: boolean }; keyCode?: number }) =>
  e.nativeEvent.isComposing === true || e.keyCode === 229;

/** One of the user's earlier messages: its id (stable while the list grows) and its text. */
export interface HistoryEntry {
  id: string;
  text: string;
}

/**
 * The user's earlier messages for ↑, oldest first, without a message repeated right after itself
 * (pressing ↑ never shows the same text twice in a row; the first of a run keeps its id) and
 * without blank ones.
 */
export function recallList(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    if (!e.text.trim()) continue;
    if (out[out.length - 1]?.text !== e.text) out.push(e);
  }
  return out;
}

/** The caret is on the text's first line (nothing but the line's own text before it). */
export const onFirstLine = (text: string, caret: number): boolean =>
  !text.slice(0, caret).includes('\n');

/** The caret is on the text's last line. */
export const onLastLine = (text: string, caret: number): boolean =>
  !text.slice(caret).includes('\n');

/**
 * Where ↑/↓ are in the history: `id` is the recalled message's (P8-13 review N8: a message that
 * arrives meanwhile does not shift the position, as an index from the newest would); `shown` is
 * the text it put in the composer. Anything the user types forgets the position, so a draft —
 * typed or an edited recalled message — is never replaced.
 */
export interface HistoryPosition {
  id: string;
  shown: string;
}

/**
 * The next history step for ↑ (`older`) or ↓ (`newer`), or `undefined` when the key is not the
 * history's: the composer holds a draft (not empty and not the recalled text, unedited), the
 * caret is not on the first line (↑) or the last line (↓) of a recalled message, or there is
 * nothing older. `↓` past the newest message gives back an empty composer (`at: undefined`).
 */
export function historyStep(
  history: readonly HistoryEntry[],
  at: HistoryPosition | undefined,
  text: string,
  caret: number,
  direction: 'older' | 'newer',
): { at: HistoryPosition | undefined; text: string } | undefined {
  const recalled = at !== undefined && text === at.shown;
  if (!recalled && text !== '') return undefined; // a draft: never replaced
  // Where the recalled message is now (oldest first); one no longer listed counts as "now".
  const found = recalled ? history.findIndex((h) => h.id === at.id) : -1;
  const here = found < 0 ? history.length : found;
  const step = (i: number) => {
    const entry = history[i]!;
    return { at: { id: entry.id, shown: entry.text }, text: entry.text };
  };
  if (direction === 'older') {
    if (recalled && !onFirstLine(text, caret)) return undefined; // move up inside the message
    return here - 1 >= 0 ? step(here - 1) : undefined;
  }
  if (!recalled) return undefined; // ↓ in an empty composer: nothing newer than now
  if (!onLastLine(text, caret)) return undefined;
  return here + 1 < history.length ? step(here + 1) : { at: undefined, text: '' };
}
