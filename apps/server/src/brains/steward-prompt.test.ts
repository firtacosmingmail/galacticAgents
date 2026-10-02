import { describe, expect, it } from 'vitest';
import { RELATED_SHOWN, stewardPrompt } from './steward-prompt.js';

describe('Steward prompt template (P2-11)', () => {
  const task = { id: 't-1', description: 'add the CSV reader' };
  const project = { id: 'p-1', name: 'CSV tool' };

  it('leads with the supervisor’s words, then the task’s facts, then the etiquette', () => {
    const text = stewardPrompt({
      task: { ...task, priority: 'high' },
      project,
      supervisor: 'waykeeper',
      cwd: '/w/csv/.galactic/worktrees/t-1',
      branch: 'galactic/t-1-csv-reader',
      instructions: 'scenario:x\nParse with the stdlib only.',
      related: [
        { id: 't-1', description: 'add the CSV reader', state: 'in_progress' },
        { id: 't-0', description: 'scaffold', state: 'completed' },
        { id: 't-2', description: 'write Parquet', state: 'approved' },
        { id: 't-3', description: 'dropped', state: 'archived' },
      ],
    });
    expect(text.split('\n')[0]).toBe('scenario:x');
    expect(text).toContain('Your task (t-1), priority high: add the CSV reader');
    expect(text).toContain('Project: "CSV tool" (p-1). You report to your project\'s Waykeeper.');
    expect(text).toContain('You are on branch galactic/t-1-csv-reader in your own git worktree');
    expect(text).toContain('Commit your work on your branch before you report done');
    // Other tasks, open ones first; itself and archived ones left out.
    const others = text.slice(text.indexOf('Other tasks'));
    expect(others.indexOf('t-2 [approved]')).toBeLessThan(others.indexOf('t-0 [completed]'));
    expect(others).not.toContain('t-1 [');
    expect(others).not.toContain('t-3');
    for (const rule of [
      'AskUserQuestion',
      'Never ask for permission in prose',
      '"Done:"',
      '"Not done:"',
    ]) {
      expect(text).toContain(rule);
    }
  });

  it('a send-back leads before the instructions; a serialised workspace says so', () => {
    const text = stewardPrompt({
      task,
      project,
      supervisor: 'waykeeper',
      cwd: '/w/csv',
      serialised: true,
      lead: 'scenario:resolve\nMerge the base branch.',
      instructions: 'The original instructions.',
    });
    expect(text.indexOf('scenario:resolve')).toBe(0);
    expect(text.indexOf('Merge the base branch.')).toBeLessThan(
      text.indexOf('The original instructions.'),
    );
    expect(text).toContain('you are the only Steward working in it right now');
    expect(text).not.toContain('Commit your work on your branch');
  });

  it('an asteroid task reports to the Harmonizer and leaves the folder’s git alone', () => {
    const text = stewardPrompt({ task, supervisor: 'harmonizer', cwd: '/p/scratch/csv' });
    expect(text.startsWith('Your task (t-1): add the CSV reader')).toBe(true);
    expect(text).toContain(
      'A standalone task, not part of a project. You report to the Harmonizer.',
    );
    expect(text).toContain(
      'do not commit, push or switch branches unless your instructions say so',
    );
    expect(text).toContain('your report to the Harmonizer');
    expect(text).not.toContain('Other tasks');
  });

  it('lists at most a few related tasks', () => {
    const related = Array.from({ length: RELATED_SHOWN + 3 }, (_, i) => ({
      id: `t-${i + 10}`,
      description: `task ${i}`,
      state: 'approved' as const,
    }));
    const text = stewardPrompt({ task, project, supervisor: 'waykeeper', cwd: '/w', related });
    expect(text).toContain('… and 3 more');
  });
});
