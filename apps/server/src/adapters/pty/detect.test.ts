import { describe, expect, it } from 'vitest';
import { compileIdle, compilePatterns, detect, isConfirmation, oneLine } from './detect.js';

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
    });
    expect(detect('Overwrite (yes/no): ', {})).toMatchObject({ yes: 'yes', no: 'no' });
    expect(detect('Continue?', {})).toMatchObject({ kind: 'permission' });
    expect(detect('Do you want to run npm install? ', {})).toMatchObject({ kind: 'permission' });
  });

  it('other questions are clarifications; plain output is nothing', () => {
    expect(detect('Which colour should the button be? ', {})).toEqual({
      kind: 'clarification',
      line: 'Which colour should the button be?',
    });
    expect(detect('compiling 3 files', {})).toBeUndefined();
    expect(detect('   ', {})).toBeUndefined();
  });

  it('configured patterns come first, but a yes/no confirmation stays a permission', () => {
    const patterns = compilePatterns([
      { pattern: 'Name:\\s*$', kind: 'clarification' },
      { pattern: 'Proceed \\[a\\]ccept', kind: 'permission', yes: 'a', no: 'r' },
      { pattern: 'continue', kind: 'clarification' },
    ]);
    expect(detect('Name: ', { patterns })).toEqual({ kind: 'clarification', line: 'Name:' });
    expect(detect('Proceed [a]ccept / [r]eject', { patterns })).toMatchObject({
      kind: 'permission',
      yes: 'a',
      no: 'r',
    });
    // Configured as a clarification, but it asks leave to act: the user decides.
    expect(detect('Continue? [y/N]', { patterns })).toMatchObject({ kind: 'permission', yes: 'y' });
  });

  it('refuses patterns that do not parse', () => {
    expect(() => compilePatterns([{ pattern: '(', kind: 'clarification' }])).toThrow(
      /pty.questionPatterns/,
    );
    expect(() => compileIdle('[')).toThrow(/pty.idlePattern/);
  });

  it('helpers', () => {
    expect(isConfirmation('Are you sure? ')).toBe(true);
    expect(isConfirmation('What next?')).toBe(false);
    expect(oneLine('a\nb\r\nc')).toBe('a b c');
  });
});
