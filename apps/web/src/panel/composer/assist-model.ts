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
 * The commands matching `query`, best first: names that start with it, then names that contain
 * it, then those whose description does; alphabetical within each group; case-insensitive. An
 * empty query lists every command alphabetically. At most `SLASH_LIST_MAX`.
 */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);
  const prefix: SlashCommand[] = [];
  const inName: SlashCommand[] = [];
  const inDescription: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) inName.push(c);
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
 * The user's earlier messages for ↑, oldest first, without a message repeated right after itself
 * (pressing ↑ never shows the same text twice in a row) and without blank ones.
 */
export function recallList(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t.trim()) continue;
    if (out[out.length - 1] !== t) out.push(t);
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
 * Where ↑/↓ are in the history: `index` counts back from the newest message (0 is the newest);
 * `shown` is the text it put in the composer. Anything the user types forgets the position, so a
 * draft — typed or an edited recalled message — is never replaced.
 */
export interface HistoryPosition {
  index: number;
  shown: string;
}

/**
 * The next history step for ↑ (`older`) or ↓ (`newer`), or `undefined` when the key is not the
 * history's: the composer holds a draft (not empty and not the recalled text, unedited), the
 * caret is not on the first line (↑) or the last line (↓) of a recalled message, or there is
 * nothing older. `↓` past the newest message gives back an empty composer (`at: undefined`).
 */
export function historyStep(
  history: readonly string[],
  at: HistoryPosition | undefined,
  text: string,
  caret: number,
  direction: 'older' | 'newer',
): { at: HistoryPosition | undefined; text: string } | undefined {
  const recalled = at !== undefined && text === at.shown;
  if (!recalled && text !== '') return undefined; // a draft: never replaced
  if (direction === 'older') {
    if (recalled && !onFirstLine(text, caret)) return undefined; // move up inside the message
    const index = (recalled ? at.index : -1) + 1;
    if (index >= history.length) return undefined;
    const shown = history[history.length - 1 - index]!;
    return { at: { index, shown }, text: shown };
  }
  if (!recalled) return undefined; // ↓ in an empty composer: nothing newer than now
  if (!onLastLine(text, caret)) return undefined;
  const index = at.index - 1;
  if (index < 0) return { at: undefined, text: '' };
  const shown = history[history.length - 1 - index]!;
  return { at: { index, shown }, text: shown };
}
