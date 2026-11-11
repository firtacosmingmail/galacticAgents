import { describe, expect, it } from 'vitest';
import type { UsedSource } from '@galactic/protocol';
import { RunSourceRecorder, usedSourceOf } from './run-sources.js';

const CWD = '/w/shop';

describe('usedSourceOf', () => {
  const cases: [string, string, unknown, UsedSource | undefined][] = [
    ['an MCP tool', 'mcp__posthog__query', {}, { kind: 'mcp', target: 'posthog' }],
    ['a server name with underscores', 'mcp__my_crm__list', {}, { kind: 'mcp', target: 'my_crm' }],
    ["Mission Control's own tools", 'mcp__galactic__report_run', {}, undefined],
    [
      'WebFetch',
      'WebFetch',
      { url: 'https://Docs.Example.com/a?b=1' },
      { kind: 'site', target: 'docs.example.com' },
    ],
    ['WebSearch', 'WebSearch', { query: 'x' }, { kind: 'site', target: 'web search' }],
    [
      'curl',
      'Bash',
      { command: 'curl -s https://api.posthog.com/x' },
      { kind: 'site', target: 'api.posthog.com' },
    ],
    [
      'wget',
      'Bash',
      { command: 'wget -q http://files.example.org/a.zip -O /tmp/a.zip' },
      { kind: 'site', target: 'files.example.org' },
    ],
    [
      'Read of a file',
      'Read',
      { file_path: '/data/reports/q3.csv' },
      { kind: 'files', target: '/data/reports' },
    ],
    ['Read of a relative file inside cwd', 'Read', { file_path: 'src/a.ts' }, undefined],
    ['Read of a file inside cwd', 'Read', { file_path: '/w/shop/a.ts' }, undefined],
    [
      'Read of a relative file escaping cwd',
      'Read',
      { file_path: '../other/a.ts' },
      { kind: 'files', target: '/w/other' },
    ],
    ['Grep with a path inside cwd', 'Grep', { pattern: 'x', path: 'src' }, undefined],
    ['Glob with a path inside cwd', 'Glob', { pattern: '*', path: '/w/shop/docs' }, undefined],
    [
      'Grep with a path',
      'Grep',
      { pattern: 'x', path: '/data/logs' },
      { kind: 'files', target: '/data/logs' },
    ],
    ['Grep without a path', 'Grep', { pattern: 'x' }, undefined],
    ['Glob without a path', 'Glob', { pattern: 'x' }, undefined],
    [
      'Glob with a path',
      'Glob',
      { pattern: '*.md', path: '/notes' },
      { kind: 'files', target: '/notes' },
    ],
    [
      'cat outside cwd',
      'Bash',
      { command: 'cat /data/reports/q3.csv' },
      { kind: 'files', target: '/data/reports' },
    ],
    [
      'ls outside cwd',
      'Bash',
      { command: 'ls -la /data/reports' },
      { kind: 'files', target: '/data/reports' },
    ],
    ['cat inside cwd', 'Bash', { command: 'cat /w/shop/a.txt' }, undefined],
    ['a Bash command with no source', 'Bash', { command: 'git status' }, undefined],
    ['a Bash command with a flag only', 'Bash', { command: 'ls -la' }, undefined],
    ['Edit', 'Edit', { file_path: '/data/a' }, undefined],
    ['curl without a URL', 'Bash', { command: 'curl --help' }, undefined],
    ['a missing input', 'Read', undefined, undefined],
  ];
  it.each(cases)('%s', (_name, tool, input, expected) => {
    expect(usedSourceOf(tool, input, CWD)).toEqual(expected);
  });
});

describe('RunSourceRecorder', () => {
  it('keeps each source once, per agent, and take() empties it', () => {
    const r = new RunSourceRecorder();
    r.note('a1', 'mcp__crm__list', {}, CWD);
    r.note('a1', 'mcp__crm__get', {}, CWD);
    r.note('a1', 'Bash', { command: 'git status' }, CWD);
    r.note('a2', 'WebFetch', { url: 'https://x.com' }, CWD);
    expect(r.take('a1')).toEqual([{ kind: 'mcp', target: 'crm' }]);
    expect(r.take('a1')).toEqual([]);
    expect(r.take('a2')).toEqual([{ kind: 'site', target: 'x.com' }]);
  });

  it('keeps at most 50 sources', () => {
    const r = new RunSourceRecorder();
    for (let i = 0; i < 60; i++) r.note('a', `mcp__s${i}__t`, {}, CWD);
    expect(r.take('a')).toHaveLength(50);
  });

  it('never throws on odd input', () => {
    const r = new RunSourceRecorder();
    expect(() => r.note('a', 'Bash', { command: 42 }, CWD)).not.toThrow();
    expect(() => r.note('a', 'Read', null, CWD)).not.toThrow();
  });
});
