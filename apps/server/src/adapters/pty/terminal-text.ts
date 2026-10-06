/**
 * The text form of a terminal stream (P8-08): what a reader of the output would call its lines,
 * with the escape sequences (colours, cursor movement, window titles) taken out. Fed the raw
 * output in whatever pieces it arrives; an escape sequence split over two pieces is still
 * recognised.
 *
 * Line-oriented, not a terminal emulator: `\n` ends a line, `\r` not followed by `\n` starts the
 * line again (a spinner or a progress bar redrawing itself leaves its last state), backspace
 * removes a character, other control characters are dropped. A full-screen program (one that
 * positions the cursor) comes out as its text in arrival order — readable, not laid out.
 */

/** Longest line kept; the rest of a longer one is cut (a binary dump must not grow memory). */
export const MAX_LINE = 8_192;

type State = 'normal' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'charset';

export class TerminalText {
  private state: State = 'normal';
  private line = '';
  /** A `\r` was seen: the next printable character starts the line again. */
  private carriage = false;

  /** Feeds raw output; returns the lines it completed, in order. */
  feed(raw: string): string[] {
    const done: string[] = [];
    for (const ch of raw) {
      switch (this.state) {
        case 'esc':
          if (ch === '[') this.state = 'csi';
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_')
            this.state = 'osc'; // a string up to BEL or ST
          else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#')
            this.state = 'charset'; // one more character
          else this.state = 'normal'; // a two-character sequence
          continue;
        case 'csi': {
          const c = ch.charCodeAt(0);
          if (c >= 0x40 && c <= 0x7e) this.state = 'normal';
          continue;
        }
        case 'osc':
          if (ch === '\x07') this.state = 'normal';
          else if (ch === '\x1b') this.state = 'osc-esc';
          continue;
        case 'osc-esc':
          this.state = ch === '\\' ? 'normal' : 'osc';
          continue;
        case 'charset':
          this.state = 'normal';
          continue;
        case 'normal':
          break;
      }
      if (ch === '\x1b') {
        this.state = 'esc';
        continue;
      }
      if (ch === '\n') {
        done.push(this.line);
        this.line = '';
        this.carriage = false;
        continue;
      }
      if (ch === '\r') {
        this.carriage = true;
        continue;
      }
      if (ch === '\b') {
        this.line = this.line.slice(0, -1);
        continue;
      }
      const code = ch.charCodeAt(0);
      if ((code < 0x20 && ch !== '\t') || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
        continue; // other control characters (bell, shift in/out, C1)
      }
      if (this.carriage) {
        this.line = '';
        this.carriage = false;
      }
      if (this.line.length < MAX_LINE) this.line += ch;
    }
    return done;
  }

  /** The line being written (no `\n` yet): where a prompt waiting for input sits. */
  get current(): string {
    return this.line;
  }
}

/** The text of `raw` with the escape sequences and control characters removed (one-shot). */
export function stripTerminal(raw: string): string {
  const t = new TerminalText();
  const lines = t.feed(raw);
  return [...lines, ...(t.current ? [t.current] : [])].join('\n');
}
