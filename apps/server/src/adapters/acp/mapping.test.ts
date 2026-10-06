import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '../../domain/permissions.js';
import {
  chooseOption,
  CostMeter,
  findMode,
  formFields,
  gateCall,
  isPermissiveMode,
  mergeTool,
  modeState,
  planProgress,
  toolResultText,
} from './mapping.js';
import { resolveCommand } from './preflight.js';

const ctx = { workspace: '/w/proj', cwd: '/w/proj' };

describe('gateCall: ACP tool calls in the permission engine’s vocabulary', () => {
  it('an execute with a command is Bash; a shell argv wrapper keeps its script', () => {
    expect(
      gateCall({ toolCallId: '1', kind: 'execute', rawInput: { command: 'pnpm test' } }),
    ).toEqual({ toolName: 'Bash', input: { command: 'pnpm test', acp: { kind: 'execute' } } });
    expect(
      gateCall({
        toolCallId: '2',
        kind: 'execute',
        rawInput: { command: ['bash', '-lc', 'git push origin main'] },
      }).input,
    ).toMatchObject({ command: 'git push origin main' });
    expect(
      gateCall({ toolCallId: '3', kind: 'execute', rawInput: { command: ['rm', '-rf', 'my dir'] } })
        .input,
    ).toMatchObject({ command: "rm -rf 'my dir'" });
  });

  it('reads, edits, deletes and moves are placed by their paths', () => {
    expect(
      gateCall({ toolCallId: '1', kind: 'read', locations: [{ path: '/w/proj/a.ts' }] }),
    ).toMatchObject({ toolName: 'Read', input: { file_path: '/w/proj/a.ts' } });
    expect(
      gateCall({ toolCallId: '2', kind: 'edit', rawInput: { file_path: '/etc/hosts' } }),
    ).toMatchObject({ toolName: 'Edit', input: { file_path: '/etc/hosts' } });
    expect(
      gateCall({ toolCallId: '3', kind: 'delete', locations: [{ path: '/w/proj/b' }] }),
    ).toMatchObject({ toolName: 'Bash', input: { command: "rm -r -- '/w/proj/b'" } });
    expect(
      gateCall({ toolCallId: '4', kind: 'move', rawInput: { from: '/w/proj/a', to: '/tmp/a' } }),
    ).toMatchObject({ toolName: 'Edit', input: { file_path: '/w/proj/a', path: '/tmp/a' } });
  });

  it('the engine judges the translated calls as it judges Claude Code’s', () => {
    const judge = (t: Parameters<typeof gateCall>[0]) => classifyToolCall(gateCall(t), ctx).actions;
    expect(judge({ toolCallId: '1', kind: 'read', locations: [{ path: '/w/proj/a.ts' }] })).toEqual(
      ['read_workspace'],
    );
    expect(judge({ toolCallId: '2', kind: 'edit', locations: [{ path: '/etc/hosts' }] })).toEqual([
      'outside_workspace',
    ]);
    expect(
      judge({ toolCallId: '3', kind: 'move', rawInput: { from: '/w/proj/a', to: '/tmp/a' } }),
    ).toEqual(['outside_workspace']);
    expect(
      judge({ toolCallId: '4', kind: 'execute', rawInput: { command: 'rm -rf /' } }),
    ).toContain('destructive');
    expect(judge({ toolCallId: '5', kind: 'fetch', rawInput: { url: 'https://x.y' } })).toEqual([
      'network',
    ]);
  });

  const judge = (t: Parameters<typeof gateCall>[0]) => classifyToolCall(gateCall(t), ctx);

  it('a delete is the rm -r it amounts to: destructive, and outside the workspace when it is', () => {
    const inside = judge({ toolCallId: '1', kind: 'delete', locations: [{ path: '/w/proj/b' }] });
    expect(inside.actions).toEqual(['destructive']);
    const outside = judge({ toolCallId: '2', kind: 'delete', rawInput: { path: '/etc/x' } });
    expect(outside.actions).toEqual(expect.arrayContaining(['destructive', 'outside_workspace']));
    // A path with a quote or spaces stays one quoted word.
    expect(
      gateCall({ toolCallId: '3', kind: 'delete', rawInput: { path: "/w/proj/it's here" } }).input,
    ).toMatchObject({ command: `rm -r -- '/w/proj/it'\\''s here'` });
    expect(
      judge({ toolCallId: '4', kind: 'delete', rawInput: { path: "/w/proj/it's here" } }).actions,
    ).toEqual(['destructive']);
  });

  it('every distinct path is judged: further locations and a paths list', () => {
    expect(
      judge({
        toolCallId: '1',
        kind: 'read',
        locations: [{ path: '/w/proj/a.ts' }, { path: '/etc/passwd' }],
      }).actions,
    ).toEqual(['outside_workspace']);
    expect(
      judge({ toolCallId: '2', kind: 'edit', rawInput: { paths: ['/w/proj/a', '/tmp/b'] } })
        .actions,
    ).toEqual(['outside_workspace']);
    expect(
      judge({
        toolCallId: '3',
        kind: 'delete',
        rawInput: { file_path: '/w/proj/a' },
        locations: [{ path: '/tmp/b' }],
      }).actions,
    ).toEqual(expect.arrayContaining(['destructive', 'outside_workspace']));
    expect(
      judge({
        toolCallId: '4',
        kind: 'edit',
        locations: [{ path: '/w/proj/a' }, { path: '/w/proj/b' }],
      }).actions,
    ).toEqual(['edit_workspace']);
  });

  it('a file-name search is a Glob whose pattern is checked; a content search is a Grep', () => {
    expect(
      gateCall({ toolCallId: '1', kind: 'search', rawInput: { pattern: '../../**/*.env' } }),
    ).toMatchObject({ toolName: 'Glob', input: { pattern: '../../**/*.env' } });
    expect(
      judge({ toolCallId: '2', kind: 'search', rawInput: { pattern: '/etc/**/*.conf' } }).actions,
    ).toEqual(['outside_workspace']);
    expect(
      judge({ toolCallId: '3', kind: 'search', rawInput: { pattern: 'src/**/*.ts' } }).actions,
    ).toEqual(['read_workspace']);
    expect(
      gateCall({
        toolCallId: '4',
        kind: 'search',
        title: 'grep "TODO"',
        rawInput: { pattern: 'TODO.*', path: '/w/proj' },
      }),
    ).toMatchObject({ toolName: 'Grep', input: { pattern: 'TODO.*', path: '/w/proj' } });
    expect(
      judge({
        toolCallId: '5',
        kind: 'search',
        rawInput: { pattern: 'x', glob: '../../**', output_mode: 'content' },
      }).actions,
    ).toEqual(['outside_workspace']);
  });

  it('an execute with a working directory runs from it', () => {
    expect(
      gateCall({ toolCallId: '1', kind: 'execute', rawInput: { command: 'ls', cwd: '/w/proj/a' } })
        .input,
    ).toMatchObject({ command: "cd '/w/proj/a' && ls" });
    expect(
      judge({ toolCallId: '2', kind: 'execute', rawInput: { command: 'rm x', workdir: '/etc' } })
        .actions,
    ).toEqual(expect.arrayContaining(['destructive', 'outside_workspace']));
  });

  it('an unreadable execute that mentions a push still asks about the push', () => {
    const c = judge({
      toolCallId: '1',
      kind: 'execute',
      title: 'Publish the branch',
      rawInput: { script_ref: 'git push origin main' },
    });
    expect(c.unclassified).toBe(true);
    expect(c.actions).toEqual(['push']);
    expect(judge({ toolCallId: '2', kind: 'execute', title: 'git push' }).actions).toEqual([
      'push',
    ]);
    expect(judge({ toolCallId: '3', kind: 'execute', title: 'run tests' }).actions).toEqual([]);
  });

  it('what cannot be placed stays unclassified (never made to look safer)', () => {
    for (const t of [
      { toolCallId: '1', kind: 'execute' as const, title: 'run something' },
      { toolCallId: '2', kind: 'edit' as const },
      { toolCallId: '3', kind: 'other' as const, name: 'mcp_thing' },
      { toolCallId: '4', kind: 'read' as const },
    ]) {
      const call = gateCall(t);
      expect(call.toolName.startsWith('acp:')).toBe(true);
      expect(classifyToolCall(call, ctx).unclassified).toBe(true);
    }
  });
});

describe('mapping helpers', () => {
  it('mergeTool keeps what an update does not carry', () => {
    const a = mergeTool(undefined, {
      toolCallId: 't',
      title: 'Read a',
      kind: 'read',
      status: 'pending',
    });
    const b = mergeTool(a, { toolCallId: 't', status: 'completed', title: null });
    expect(b).toEqual({ toolCallId: 't', title: 'Read a', kind: 'read', status: 'completed' });
  });

  it('chooseOption never picks an *_always option when a *_once exists', () => {
    const options = [
      { optionId: 'aa', name: 'Always', kind: 'allow_always' as const },
      { optionId: 'a', name: 'Once', kind: 'allow_once' as const },
      { optionId: 'r', name: 'No', kind: 'reject_once' as const },
    ];
    expect(chooseOption(options, true)?.optionId).toBe('a');
    expect(chooseOption(options, false)?.optionId).toBe('r');
    expect(chooseOption([options[0]!], true)?.optionId).toBe('aa');
    expect(chooseOption([options[0]!], false)).toBeUndefined();
  });

  it('CostMeter: dollars are the session total (USD only), tokens add up per turn', () => {
    const m = new CostMeter();
    expect(m.cost).toBeUndefined();
    m.sessionCost({ amount: 0.5, currency: 'EUR' });
    expect(m.cost).toBeUndefined();
    m.sessionCost({ amount: 0.01, currency: 'usd' });
    m.turn({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 5 });
    m.sessionCost({ amount: 0.03, currency: 'USD' });
    m.turn({ inputTokens: 1, outputTokens: 1, totalTokens: 2, thoughtTokens: 3 });
    expect(m.cost).toEqual({ usd: 0.03, inputTokens: 16, outputTokens: 6 });
  });

  it('formFields: enum options map back to values, multi-select splits commas', () => {
    const [choice] = formFields('Pick', {
      c: {
        type: 'string',
        oneOf: [
          { const: 'v1', title: 'First' },
          { const: 'v2', title: 'Second' },
        ],
      },
    });
    expect(choice).toMatchObject({ text: 'Pick', options: ['First', 'Second'] });
    expect(choice!.parse('second')).toBe('v2');
    expect(choice!.parse('something else')).toBe('something else');
    const fields = formFields(
      'Q',
      {
        tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
        name: { type: 'string', title: 'Name' },
      },
      ['name'],
    );
    expect(fields.map((f) => f.key)).toEqual(['name', 'tags']); // required first
    expect(fields[1]!.text).toBe('Q — Tags (one or more: separate them with commas)');
    expect(fields[1]!.parse('a, b')).toEqual(['a', 'b']);
  });

  it('planProgress and toolResultText', () => {
    expect(
      planProgress({
        entries: [
          { content: 'one', priority: 'high', status: 'completed' },
          { content: 'two', priority: 'low', status: 'in_progress' },
        ],
      }),
    ).toMatchObject({ summary: 'two (1/2)', progress: { done: 1, total: 2 } });
    expect(
      toolResultText(
        {
          toolCallId: 't',
          content: [
            { type: 'content', content: { type: 'text', text: 'hello' } },
            { type: 'diff', path: '/a', newText: 'x' },
          ],
        },
        100,
      ),
    ).toBe('hello\ndiff /a');
    expect(toolResultText({ toolCallId: 't', rawOutput: { ok: true } }, 5)).toBe('{"ok"');
  });

  it('modeState reads ACP modes or a mode config option; permissive modes by id or name', () => {
    const a = modeState({
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'x1', name: 'YOLO' },
        ],
      },
    })!;
    expect(a).toMatchObject({ current: 'default', via: { kind: 'mode' } });
    expect(isPermissiveMode(a, 'default')).toBe(false);
    expect(isPermissiveMode(a, 'x1')).toBe(true); // by its name
    expect(isPermissiveMode(undefined, 'bypassPermissions')).toBe(true);
    expect(isPermissiveMode(undefined, 'Full Access')).toBe(true);
    expect(isPermissiveMode(undefined, 'read-only')).toBe(false);
    const b = modeState({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'm',
          options: [{ value: 'm', name: 'M' }],
        },
        {
          id: 'approval',
          name: 'Approval',
          category: 'mode',
          type: 'select',
          currentValue: 'ask',
          options: [
            { group: 'g', name: 'G', options: [{ value: 'ask', name: 'Ask every time' }] },
            { group: 'h', name: 'H', options: [{ value: 'auto', name: 'Auto' }] },
          ],
        },
      ],
    })!;
    expect(b).toMatchObject({ current: 'ask', via: { kind: 'config', configId: 'approval' } });
    expect(findMode(b, 'ASK EVERY TIME')?.id).toBe('ask');
    expect(isPermissiveMode(b, 'auto')).toBe(true);
    expect(modeState({})).toBeUndefined();
  });

  it('resolveCommand finds an executable on the PATH, or a path as given', () => {
    expect(resolveCommand('node', process.env['PATH'] ?? '')).toBeTruthy();
    expect(resolveCommand(process.execPath, '')).toBe(process.execPath);
    expect(resolveCommand('no-such-acp-agent-here', process.env['PATH'] ?? '')).toBeUndefined();
  });
});
