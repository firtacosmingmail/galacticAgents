import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '@galactic/protocol';
import {
  historyStep,
  insertion,
  matchCommands,
  onFirstLine,
  onLastLine,
  recallList,
  SLASH_LIST_MAX,
  slashQuery,
} from './assist-model.js';

const commands: SlashCommand[] = [
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'compact', description: 'Keep a summary' },
  { name: 'pr-comments', description: 'Show the comments of a pull request' },
  { name: 'docs:review-plan', description: 'Check a plan' },
  { name: 'init' },
];

describe('slash list (P8-13)', () => {
  it('opens only for a leading / and the first word', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/rev')).toBe('rev');
    expect(slashQuery('/review ')).toBeUndefined();
    expect(slashQuery('/review\n')).toBeUndefined();
    expect(slashQuery('/tmp/x')).toBeUndefined();
    expect(slashQuery('hello /x')).toBeUndefined();
    expect(slashQuery(' /x')).toBeUndefined();
    expect(slashQuery('')).toBeUndefined();
  });

  it('ranks prefix matches, then names containing the text, then descriptions', () => {
    const names = (q: string) => matchCommands(commands, q).map((c) => c.name);
    expect(names('')).toEqual(['compact', 'docs:review-plan', 'init', 'pr-comments', 'review']);
    expect(names('re')).toEqual(['review', 'docs:review-plan', 'pr-comments']);
    expect(names('REV')).toEqual(['review', 'docs:review-plan']);
    expect(names('pull')).toEqual(['pr-comments', 'review']);
    expect(names('zzz')).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `c${i}` }));
    expect(matchCommands(many, 'c')).toHaveLength(SLASH_LIST_MAX);
  });

  it('inserts /name and a space', () => {
    expect(insertion(commands[0]!)).toBe('/review ');
  });
});

describe('history recall (P8-14)', () => {
  const history = recallList(['one', '', 'two', 'two', 'three\nlines']);

  it('keeps the user’s messages oldest first, without blanks or a repeat in a row', () => {
    expect(history).toEqual(['one', 'two', 'three\nlines']);
  });

  it('knows the caret’s line', () => {
    expect(onFirstLine('a\nb', 1)).toBe(true);
    expect(onFirstLine('a\nb', 2)).toBe(false);
    expect(onLastLine('a\nb', 1)).toBe(false);
    expect(onLastLine('a\nb', 3)).toBe(true);
  });

  it('walks back from an empty composer, newest first, and forward to empty again', () => {
    const s1 = historyStep(history, undefined, '', 0, 'older')!;
    expect(s1).toEqual({ at: { index: 0, shown: 'three\nlines' }, text: 'three\nlines' });
    // A recalled message of two lines: ↑ moves the caret up first (caret at its end).
    expect(historyStep(history, s1.at, s1.text, s1.text.length, 'older')).toBeUndefined();
    const s2 = historyStep(history, s1.at, s1.text, 0, 'older')!;
    expect(s2.text).toBe('two');
    const s3 = historyStep(history, s2.at, 'two', 3, 'older')!;
    expect(s3.text).toBe('one');
    expect(historyStep(history, s3.at, 'one', 3, 'older')).toBeUndefined(); // nothing older
    const d1 = historyStep(history, s3.at, 'one', 3, 'newer')!;
    expect(d1.text).toBe('two');
    const d2 = historyStep(history, d1.at, 'two', 3, 'newer')!;
    expect(d2.text).toBe('three\nlines');
    // On the first line of the recalled message ↓ moves the caret down first.
    expect(historyStep(history, d2.at, d2.text, 0, 'newer')).toBeUndefined();
    expect(historyStep(history, d2.at, d2.text, d2.text.length, 'newer')).toEqual({
      at: undefined,
      text: '',
    });
  });

  it('never replaces a draft: typed text or an edited recalled message', () => {
    expect(historyStep(history, undefined, 'my draft', 0, 'older')).toBeUndefined();
    const s1 = historyStep(history, undefined, '', 0, 'older')!;
    expect(historyStep(history, s1.at, 'three\nlines edited', 0, 'older')).toBeUndefined();
    expect(historyStep(history, s1.at, 'edited', 6, 'newer')).toBeUndefined();
    expect(historyStep(history, undefined, '', 0, 'newer')).toBeUndefined();
    expect(historyStep([], undefined, '', 0, 'older')).toBeUndefined();
  });
});
