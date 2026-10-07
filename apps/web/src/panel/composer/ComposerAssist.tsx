import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Id, SlashCommand } from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';
import {
  composing,
  historyStep,
  insertion,
  isWholeCommand,
  matchCommands,
  recallList,
  slashQuery,
  type HistoryEntry,
  type HistoryPosition,
} from './assist-model.js';
import { useSlashCommands } from './slash-commands.js';
import './composer.css';

/**
 * What every composer gets from P8-13 and P8-14, over its own `<textarea>`:
 *
 * - **Slash commands.** A `/` as the first character opens a list of the commands the agent's
 *   runtime offers (`GET /api/agents/:id/commands`), filtered as the user types the name. ↑/↓
 *   move, Tab or Enter put `/name ` in the composer, Escape closes, a click or tap chooses; Enter
 *   on a name typed out in full sends it (`send`), as Claude Code does. The
 *   textarea keeps the focus throughout (an editable text box with a list: `aria-autocomplete`,
 *   `aria-controls`, `aria-activedescendant`; a `<textarea>` may not take the combobox role), and
 *   a polite status line says how many commands match. Names, hints and descriptions are the
 *   agent's text: rendered as text only. No list when the agent offers none.
 * - **History.** In an empty composer ↑ recalls the user's earlier messages to this agent, newest
 *   first, ↓ walks back to the empty composer. Only an empty composer or an unedited recalled
 *   message reacts, and a recalled message of several lines first moves the caret through its
 *   lines, so a draft is never lost and multi-line editing still works. While the slash list is
 *   open, ↑/↓ belong to the list.
 *
 * The composer passes its key events through `onKeyDown` first (`true`: handled, do nothing
 * more), its changes through `onChange`, spreads `inputProps` on the textarea and renders
 * `popup` next to it inside a `.cmp-field`.
 */
export interface ComposerAssistOptions {
  agentId: Id;
  text: string;
  setText: (text: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** The user's earlier messages in this conversation, oldest first, by id (P8-13 review N8). */
  history: readonly HistoryEntry[];
  /** Whether to offer the agent's slash commands at all (false: it has no live session). */
  commands: boolean;
  /** Which of the agent's commands this composer offers (default: all). */
  commandFilter?: (command: SlashCommand) => boolean;
  /**
   * How Enter sends this composer's message: with the list open, Enter on a command name typed
   * out in full (`/compact`) sends instead of inserting. Absent: Enter always inserts.
   */
  send?: () => void;
}

export interface ComposerAssist {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onChange: (text: string) => void;
  /** After a send: the history starts again from the newest message. */
  reset: () => void;
  inputProps: {
    'aria-autocomplete': 'list';
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-describedby': string;
  };
  popup: ReactNode;
}

export function useComposerAssist(opts: ComposerAssistOptions): ComposerAssist {
  const { agentId, text, setText, textarea, commandFilter } = opts;
  const api = useApi();
  const { commands: offered, refresh } = useSlashCommands(api, agentId, opts.commands);
  const commands = useMemo(
    () => (commandFilter ? offered.filter(commandFilter) : offered),
    [offered, commandFilter],
  );
  const history = useMemo(() => recallList(opts.history), [opts.history]);
  const baseId = useId();
  const listId = `${baseId}-commands`;
  const hintId = `${baseId}-hint`;

  // --- slash list ---------------------------------------------------------------------------
  const query = slashQuery(text);
  const matches = useMemo(
    () => (query === undefined ? [] : matchCommands(commands, query)),
    [commands, query],
  );
  /** Escape closed the list for this text; typing opens it again. */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const open = query !== undefined && matches.length > 0 && dismissed !== text;
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const optionId = (i: number) => `${baseId}-cmd-${i}`;

  // --- history ------------------------------------------------------------------------------
  const position = useRef<HistoryPosition | undefined>(undefined);
  /** Where to put the caret after the text changed under it (a recall, an insertion). */
  const caret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (caret.current === undefined || !el) return;
    el.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  }, [text, textarea]);

  const replace = (next: string) => {
    caret.current = next.length;
    setText(next);
  };

  const choose = (command: SlashCommand) => {
    position.current = undefined;
    replace(insertion(command));
    setActive(0);
    textarea.current?.focus();
  };

  const onChange = (next: string) => {
    position.current = undefined; // typed: a draft from now on
    if (next !== text) setDismissed(undefined);
    // The first `/` of a message: make sure the list is current.
    if (next.startsWith('/') && !text.startsWith('/')) refresh();
    if (slashQuery(next) !== slashQuery(text)) setActive(0);
    setText(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // An input method's Enter commits its text, never a command or the message (review S5).
    if (composing(e) || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (open) {
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setActive((current + step + matches.length) % matches.length);
          return true;
        }
        case 'Tab':
          if (e.shiftKey) return false;
          e.preventDefault();
          choose(matches[current]!);
          return true;
        case 'Enter':
          if (e.shiftKey) return false;
          e.preventDefault();
          if (opts.send && query !== undefined && isWholeCommand(commands, query)) opts.send();
          else choose(matches[current]!);
          return true;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation(); // the list, not the dock or a dialog around it
          setDismissed(text);
          return true;
        default:
          return false;
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
      const el = e.currentTarget;
      const step = historyStep(
        history,
        position.current,
        text,
        el.selectionStart ?? text.length,
        e.key === 'ArrowUp' ? 'older' : 'newer',
      );
      if (!step) return false;
      e.preventDefault();
      position.current = step.at;
      // A recalled `/command …` is history, not a new query: keep the list shut for it.
      setDismissed(step.text);
      replace(step.text);
      return true;
    }
    return false;
  };

  const reset = () => {
    position.current = undefined;
    setDismissed(undefined);
    setActive(0);
  };

  const popup = (
    <>
      {open && (
        <ul className="cmp-slash" id={listId} role="listbox" aria-label="slash commands">
          {matches.map((c, i) => (
            <li
              key={c.name}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={i === current ? 'is-active' : undefined}
              // The textarea keeps the focus (and the caret) while the pointer chooses.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="cmp-slash-name">/{c.name}</span>
              {c.argumentHint && <span className="cmp-slash-hint"> {c.argumentHint}</span>}
              {c.aliases?.length ? (
                <span className="cmp-slash-hint">
                  {' '}
                  (also {c.aliases.map((a) => `/${a}`).join(', ')})
                </span>
              ) : null}
              {c.description && <span className="cmp-slash-desc">{c.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <span id={hintId} className="pnl-visually-hidden" aria-live="polite">
        {open
          ? `${matches.length} slash ${matches.length === 1 ? 'command' : 'commands'}: up and down arrows to choose, Tab or Enter to insert, Escape to close.`
          : ''}
      </span>
    </>
  );

  return {
    onKeyDown,
    onChange,
    reset,
    inputProps: {
      'aria-autocomplete': 'list',
      ...(open ? { 'aria-controls': listId, 'aria-activedescendant': optionId(current) } : {}),
      'aria-describedby': hintId,
    },
    popup,
  };
}
