import { describe, expect, it } from 'vitest';
import {
  AgentCommandsResponse,
  leadingSlashCommand,
  normalizeSlashCommands,
  SLASH_COMMANDS_MAX,
  SLASH_DESCRIPTION_MAX,
  SlashCommand,
} from './index.js';

describe('slash commands (P8-13)', () => {
  it('normalises what a runtime reports: names, one-line bounded text, duplicates', () => {
    const out = normalizeSlashCommands([
      { name: '/review', description: 'Review\nthe\tdiff ', argumentHint: '<pr>' },
      { name: 'compact', description: '', argumentHint: '' },
      { name: 'two words' },
      { name: 'a/b' },
      { name: '' },
      { description: 'no name' },
      null,
      'text',
      { name: 'dup', description: 'plugin' },
      { name: 'dup', description: 'own', builtin: true },
      { name: 'long', description: 'x'.repeat(1_000) },
    ]);
    expect(out.map((c) => c.name)).toEqual(['review', 'compact', 'dup', 'long']);
    expect(out[0]).toEqual({ name: 'review', description: 'Review the diff', argumentHint: '<pr>' });
    expect(out[1]).toEqual({ name: 'compact' });
    expect(out[2]).toEqual({ name: 'dup', description: 'own', builtin: true });
    expect(out[3]!.description).toHaveLength(SLASH_DESCRIPTION_MAX);
    expect(out[3]!.description!.endsWith('…')).toBe(true);
    for (const c of out) expect(SlashCommand.safeParse(c).success).toBe(true);
    expect(AgentCommandsResponse.safeParse({ commands: out }).success).toBe(true);
  });

  it('keeps at most SLASH_COMMANDS_MAX and accepts nothing', () => {
    const many = Array.from({ length: SLASH_COMMANDS_MAX + 20 }, (_, i) => ({ name: `c${i}` }));
    expect(normalizeSlashCommands(many)).toHaveLength(SLASH_COMMANDS_MAX);
    expect(normalizeSlashCommands(undefined)).toEqual([]);
  });

  it('finds the command a message starts with', () => {
    expect(leadingSlashCommand('/compact')).toBe('compact');
    expect(leadingSlashCommand('/review 12 please')).toBe('review');
    expect(leadingSlashCommand('/plugin:cmd\nmore')).toBe('plugin:cmd');
    expect(leadingSlashCommand('/tmp/x is full')).toBeUndefined();
    expect(leadingSlashCommand('//')).toBeUndefined();
    expect(leadingSlashCommand('/')).toBeUndefined();
    expect(leadingSlashCommand(' /compact')).toBeUndefined();
    expect(leadingSlashCommand('please /compact')).toBeUndefined();
  });

  it('refuses a name with whitespace or a slash in the schema', () => {
    expect(SlashCommand.safeParse({ name: 'a b' }).success).toBe(false);
    expect(SlashCommand.safeParse({ name: '/a' }).success).toBe(false);
  });
});
