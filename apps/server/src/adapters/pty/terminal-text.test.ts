import { describe, expect, it } from 'vitest';
import { stripTerminal, TerminalText } from './terminal-text.js';

describe('TerminalText', () => {
  it('strips colours, cursor moves, titles and charset switches', () => {
    expect(stripTerminal('\x1b[1;32mgreen\x1b[0m \x1b[2Kand\x1b[3A bold\n')).toBe('green and bold');
    expect(stripTerminal('\x1b]0;window title\x07text')).toBe('text');
    expect(stripTerminal('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    expect(stripTerminal('\x1b(Bplain\x1b=')).toBe('plain');
  });

  it('keeps an escape sequence split over two pieces', () => {
    const t = new TerminalText();
    expect(t.feed('red \x1b[3')).toEqual([]);
    expect(t.feed('1mtext\x1b')).toEqual([]);
    expect(t.feed('[0m done\r\n')).toEqual(['red text done']);
  });

  it('collapses carriage-return redraws and backspaces; drops other controls', () => {
    const t = new TerminalText();
    expect(t.feed('10%\r50%\r100%\n')).toEqual(['100%']);
    expect(t.feed('abc\b\bX\x07\n')).toEqual(['aX']);
    expect(t.feed('line\r\n')).toEqual(['line']);
  });

  it('keeps the cursor line (a prompt) apart until it ends', () => {
    const t = new TerminalText();
    expect(t.feed('first\nDelete it? [y/N] ')).toEqual(['first']);
    expect(t.current).toBe('Delete it? [y/N] ');
    expect(t.feed('y\r\n')).toEqual(['Delete it? [y/N] y']);
    expect(t.current).toBe('');
  });
});
