import { describe, expect, it } from 'vitest';
import {
  compileClarifications,
  compileIdle,
  compilePatterns,
  detect,
  isConfirmation,
  oneLine,
} from './detect.js';

describe('detect', () => {
  const idle = compileIdle('^> $');

  it('the idle prompt first', () => {
    expect(detect('> ', { idle })).toEqual({ kind: 'idle' });
    expect(detect('> more', { idle })).toBeUndefined();
  });

  it('yes/no confirmations are permissions, with the tokens the prompt shows', () => {
    expect(detect('Delete the build folder? [y/N] ', { idle })).toEqual({
      kind: 'permission',
      line: 'Delete the build folder? [y/N]',
      yes: 'y',
      no: 'n',
      freeform: false,
    });
    expect(detect('Overwrite (yes/no): ', {})).toMatchObject({ yes: 'yes', no: 'no' });
    expect(detect('Continue?', {})).toMatchObject({ kind: 'permission', freeform: false });
    expect(detect('Do you want to run npm install? ', {})).toMatchObject({ kind: 'permission' });
  });

  it("aider-style and bracketed-default prompts are permissions with the style's tokens", () => {
    expect(detect('Add src/app.ts to the chat? (Y)es/(N)o [Yes]: ', {})).toEqual({
      kind: 'permission',
      line: 'Add src/app.ts to the chat? (Y)es/(N)o [Yes]:',
      yes: 'y',
      no: 'n',
      freeform: false,
    });
    expect(
      detect("Create new file? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [No]: ", {}),
    ).toMatchObject({ kind: 'permission', yes: 'y', no: 'n' });
    expect(detect('Apply the patch yes/no [no]: ', {})).toMatchObject({
      kind: 'permission',
      yes: 'yes',
      no: 'no',
    });
    expect(detect('Keep it [Yes]/[No] ', {})).toMatchObject({ kind: 'permission', yes: 'yes' });
  });

  it('fails closed: any other question is a free-form permission; plain output is nothing', () => {
    expect(detect('Which colour should the button be? ', {})).toEqual({
      kind: 'permission',
      line: 'Which colour should the button be?',
      yes: '',
      no: '',
      freeform: true,
    });
    expect(detect('compiling 3 files', {})).toBeUndefined();
    expect(detect('   ', {})).toBeUndefined();
  });

  it('only a configured clarification pattern makes a clarification, never over a yes/no', () => {
    const clarifications = compileClarifications(['colour should', 'Name:\\s*$', 'continue']);
    expect(detect('Which colour should the button be? ', { clarifications })).toEqual({
      kind: 'clarification',
      line: 'Which colour should the button be?',
    });
    expect(detect('Name: ', { clarifications })).toEqual({ kind: 'clarification', line: 'Name:' });
    expect(detect('Continue? [y/N]', { clarifications })).toMatchObject({
      kind: 'permission',
      yes: 'y',
    });
    expect(detect('Continue?', { clarifications })).toMatchObject({ kind: 'permission' });
  });

  it('configured permission shapes carry their own tokens', () => {
    const patterns = compilePatterns([
      { pattern: 'Proceed \\[a\\]ccept', yes: 'a', no: 'r' },
      { pattern: 'Ready\\s*$' },
    ]);
    expect(detect('Proceed [a]ccept / [r]eject', { patterns })).toMatchObject({
      kind: 'permission',
      yes: 'a',
      no: 'r',
      freeform: false,
    });
    expect(detect('Ready', { patterns })).toMatchObject({ kind: 'permission', yes: 'y', no: 'n' });
  });

  it('refuses patterns that do not parse', () => {
    expect(() => compilePatterns([{ pattern: '(' }])).toThrow(/pty.questionPatterns/);
    expect(() => compileClarifications(['('])).toThrow(/pty.clarificationPatterns/);
    expect(() => compileIdle('[')).toThrow(/pty.idlePattern/);
  });

  it('helpers', () => {
    expect(isConfirmation('Are you sure? ')).toBe(true);
    expect(isConfirmation('What next?')).toBe(false);
    expect(oneLine('a\nb\r\nc')).toBe('a b c');
  });

  it('oneLine drops every control character but TAB', () => {
    expect(oneLine('stop\x03 now')).toBe('stop now');
    expect(oneLine('\x15rm -rf')).toBe('rm -rf');
    expect(oneLine('\x1b[31mred\x1b[0m')).toBe('[31mred[0m');
    expect(oneLine('a\tb\x7f\x9b1m\x04')).toBe('a\tb1m');
    expect(oneLine('é ✓ 日本')).toBe('é ✓ 日本');
  });
});
