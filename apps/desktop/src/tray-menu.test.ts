import { describe, expect, it } from 'vitest';
import { emptyWorld, type Question, type WorldState } from '@galactic/protocol';
import { domain } from '@galactic/protocol/fixtures';
import {
  MENU_MAX_SHOWN,
  MENU_TITLE_MAX,
  cleanMenuText,
  inputSummary,
  redactForMenu,
  trayMenu,
} from './tray-menu.js';

const { agent, harmonizer, task, project, permissionQuestion, question } = domain;

function world(questions: Question[]): WorldState {
  return {
    ...emptyWorld(),
    projects: { [project.id]: project },
    tasks: { [task.id]: task },
    agents: { [agent.id]: agent, [harmonizer.id]: harmonizer },
    questions: Object.fromEntries(questions.map((q) => [q.id, q])),
  };
}

const { answeredBy: _by, answer: _answer, ...openPermission } = permissionQuestion;
const permission = (id: string, input: unknown, over: Partial<Question> = {}): Question => ({
  ...openPermission,
  status: 'open',
  id,
  originAgentId: agent.id,
  context: { ...permissionQuestion.context, toolCall: { toolName: 'Bash', input } },
  ...over,
});

describe('trayMenu', () => {
  it('lists the permission requests waiting for the user, oldest first, with their versions', () => {
    const w = world([
      permission('q-2', { command: 'npm publish' }, { createdAt: '2026-09-30T10:05:00.000Z' }),
      permission('q-1', { command: 'git push origin main' }, { version: 3 }),
      permission('q-done', { command: 'ls' }, { status: 'answered' }),
    ]);
    const menu = trayMenu(w);
    expect(menu.permissionCount).toBe(2);
    expect(menu.permissions.map((p) => [p.id, p.version])).toEqual([
      ['q-1', 3],
      ['q-2', permissionQuestion.version],
    ]);
    expect(menu.permissions[0]?.title).toMatch(/^Steward · .+: Bash git push origin main$/);
    expect(menu.questions).toEqual([]);
  });

  it('names the tool and the file of an edit, and the Harmonizer by its role', () => {
    const w = world([
      permission(
        'q-1',
        { file_path: '/Users/me/app/src/index.ts', content: 'x'.repeat(500) },
        { originAgentId: harmonizer.id },
      ),
    ]);
    w.questions['q-1']!.context.toolCall!.toolName = 'Edit';
    expect(trayMenu(w).permissions[0]?.title).toBe('Harmonizer: Edit /Users/me/app/src/index.ts');
  });

  it('lists clarification questions the user holds under their own section, not those an agent holds', () => {
    const mine = { ...question, id: 'c-1', holder: { type: 'user' } as const };
    const theirs = { ...question, id: 'c-2' }; // held by a Waykeeper
    const menu = trayMenu(world([mine, theirs]));
    expect(menu.questionCount).toBe(1);
    expect(menu.questions).toEqual([
      { id: 'c-1', title: expect.stringContaining(question.context.text) },
    ]);
    expect(menu.permissionCount).toBe(0);
  });

  it('caps each section and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      permission(`q-${String(i).padStart(2, '0')}`, { command: `echo ${i}` }),
    );
    const menu = trayMenu(world(many));
    expect(menu.permissions).toHaveLength(MENU_MAX_SHOWN);
    expect(menu.permissionCount).toBe(13);
  });

  it('marks a request whose answer is on its way', () => {
    const menu = trayMenu(world([permission('q-1', { command: 'ls' })]), {
      sending: new Set(['q-1']),
    });
    expect(menu.permissions[0]?.sending).toBe(true);
  });

  it('never puts the raw input in a title: one line, redacted, capped', () => {
    const input = {
      command:
        'curl -H "Authorization: Bearer abcdefghijklmnop" https://user:hunter2@example.com/x \\\n  && export API_KEY=sk-ant-0123456789abcdefghij && rm -rf ' +
        '/tmp/'.repeat(40),
    };
    const title = trayMenu(world([permission('q-1', input)])).permissions[0]!.title;
    expect(title).not.toMatch(/[\n\r]/);
    expect(title).not.toContain('abcdefghijklmnop');
    expect(title).not.toContain('hunter2');
    expect([...title].length).toBeLessThanOrEqual(MENU_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });

  it('removes control and bidirectional-override characters from agent text', () => {
    const sneaky = 'rm -rf / \u202Etxt.exe\u202C\u200B\u0007\u001b[31m';
    const title = trayMenu(world([permission('q-1', { command: sneaky })])).permissions[0]!.title;
    const unsafe = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2069, 0x200b, 0x07, 0x1b];
    expect([...title].filter((c) => unsafe.includes(c.codePointAt(0)!))).toEqual([]);
    expect(title).toContain('rm -rf / txt.exe[31m');
  });

  it('falls back to the action and the text when the request has no tool call', () => {
    const q = permission('q-1', undefined);
    q.context = {
      text: 'The agent switched to mode bypass; let it continue?',
      permissionAction: 'network',
    };
    expect(trayMenu(world([q])).permissions[0]?.title).toMatch(/: network: The agent switched/);
  });

  it('says "An agent" for an agent the world does not know', () => {
    const q = permission('q-1', { command: 'ls' }, { originAgentId: 'a-unknown' });
    expect(trayMenu(world([q])).permissions[0]?.title).toBe('An agent: Bash ls');
  });
});

describe('menu text', () => {
  it('cleans and caps on characters, with an ellipsis', () => {
    expect(cleanMenuText('  a\n\tb  ')).toBe('a b');
    expect(cleanMenuText('abcdef', 4)).toBe('abc…');
    expect(cleanMenuText('🚀🚀🚀🚀', 3)).toBe('🚀🚀…');
  });

  it('redacts secret shapes and keeps ordinary commands', () => {
    expect(redactForMenu('git push origin main')).toBe('git push origin main');
    expect(redactForMenu('ls /Users/firtacosmin/Documents/work/projects/GalacticAgents')).toBe(
      'ls /Users/firtacosmin/Documents/work/projects/GalacticAgents',
    );
    expect(redactForMenu('psql --password s3cret db')).toBe('psql --password [redacted] db');
    expect(redactForMenu('TOKEN=abc123xyz node x.js')).toBe('TOKEN=[redacted] node x.js');
    expect(redactForMenu('echo ghp_0123456789abcdefghijABCDEFGHIJ')).toBe('echo [redacted]');
    expect(redactForMenu('aws AKIAABCDEFGHIJKLMNOP')).toBe('aws [redacted]');
    expect(redactForMenu('git clone https://me:pw@github.com/x.git')).toBe(
      'git clone https://[redacted]@github.com/x.git',
    );
    expect(redactForMenu('cat -----BEGIN RSA PRIVATE KEY-----MIIE')).toBe('cat [redacted]');
  });

  it('summarises a tool input by its command, path or URL, else its JSON', () => {
    expect(inputSummary({ command: 'ls -la' })).toBe('ls -la');
    expect(inputSummary({ url: 'https://example.com', prompt: 'x' })).toBe('https://example.com');
    expect(inputSummary({ command: ['git', 'status'] })).toBe('git status');
    expect(inputSummary({ a: 1 })).toBe('{"a":1}');
    expect(inputSummary('raw')).toBe('raw');
    expect(inputSummary(undefined)).toBe('');
  });
});
