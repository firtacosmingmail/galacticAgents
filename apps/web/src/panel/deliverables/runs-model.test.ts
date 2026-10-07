import { describe, expect, it } from 'vitest';
import type { Deliverable, RunSummary } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import {
  blockingRefusal,
  bodyLines,
  durationText,
  initialFocus,
  liveRunCount,
  portUrl,
  refusalText,
  runActions,
  stripAnsi,
} from './runs-model.js';

const NOW = '2026-10-08T10:00:00.000Z';
const cmd = { kind: 'command' as const, command: { line: 'pnpm dev', cwd: '/p' } };
const live: RunSummary = { runId: 'r', state: 'running', startedAt: NOW, ports: [] };
const ended: RunSummary = { ...live, state: 'ended', outcome: 'exited', exitCode: 0 };

describe('runs-model (P9-10)', () => {
  it('offers Run, Stop and Restart by state and client (decision 131)', () => {
    expect(runActions(cmd, undefined, { local: true })).toEqual({ actions: ['run'], macOnly: [] });
    expect(runActions(cmd, ended, { local: false })).toEqual({ actions: [], macOnly: ['run'] });
    expect(runActions(cmd, live, { local: true })).toEqual({
      actions: ['stop', 'restart'],
      macOnly: [],
    });
    expect(runActions(cmd, live, { local: false })).toEqual({
      actions: ['stop'],
      macOnly: ['restart'],
    });
    expect(runActions(cmd, { ...live, state: 'stopping' }, { local: true }).actions).toEqual([
      'restart',
    ]);
    expect(runActions({ ...cmd, removedAt: NOW }, live, { local: true }).actions).toEqual([]);
  });

  it('starts the focus on Cancel for warnings or a changed body, else on Run', () => {
    expect(initialFocus({ warnings: [] })).toBe('run');
    expect(initialFocus({ warnings: ['may push'] })).toBe('cancel');
    expect(initialFocus({ warnings: [], bodyChanged: true })).toBe('cancel');
  });

  it('lets a restart past its own run’s "running" and the cap, not past a folder refusal', () => {
    const running = { refusal: { code: 'running', message: 'm' } };
    expect(blockingRefusal(running, 'run')).toEqual(running.refusal);
    expect(blockingRefusal(running, 'restart')).toBeUndefined();
    expect(blockingRefusal({ refusal: { code: 'run_cap', message: 'm' } }, 'restart')).toBe(
      undefined,
    );
    expect(blockingRefusal({ refusal: { code: 'folder', message: 'm' } }, 'restart')?.code).toBe(
      'folder',
    );
  });

  it('words the refusals', () => {
    expect(refusalText(new ApiError(409, 'x', 'stale'))).toContain('changed since the dialog');
    expect(refusalText(new ApiError(409, 'At most 2 runs', 'run_cap'))).toBe('At most 2 runs');
    expect(refusalText(new ApiError(507, 'x', 'storage_full'))).toContain('disk is full');
    expect(refusalText(new ApiError(503, 'x'))).toContain('cannot write');
    expect(refusalText(new ApiError(400, 'bad line', 'invalid'))).toBe('bad line');
    expect(refusalText(new Error('offline'))).toBe('offline');
  });

  it('marks the body lines not in the last run’s body', () => {
    expect(bodyLines('a\nb', 'a')).toEqual([
      { text: 'a', changed: false },
      { text: 'b', changed: true },
    ]);
    expect(bodyLines('a', undefined)).toEqual([{ text: 'a', changed: false }]);
  });

  it('says durations and ports', () => {
    expect(durationText(NOW, '2026-10-08T10:00:04.400Z')).toBe('4 s');
    expect(durationText(NOW, '2026-10-08T11:05:00.000Z')).toBe('1 h 5 min');
    expect(durationText(NOW, undefined, Date.parse(NOW) + 120_000)).toBe('2 min');
    expect(portUrl(5173)).toBe('http://localhost:5173');
  });

  it('strips ANSI sequences and keeps the last state of a redrawn line', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m\n')).toBe('ok\n');
    expect(stripAnsi('10%\r50%\r100%\ndone\r\n')).toBe('100%\ndone\n');
    expect(stripAnsi('\x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('link');
  });

  it('counts the live runs of a project', () => {
    const d = (id: string, over: Partial<Deliverable>) =>
      ({
        id,
        projectId: 'p-1',
        kind: 'command',
        title: id,
        source: 'user',
        addedBy: { type: 'user' },
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      }) as Deliverable;
    const world = {
      deliverables: {
        a: d('a', { lastRun: live }),
        b: d('b', { lastRun: ended }),
        c: d('c', { lastRun: live, removedAt: NOW }),
        e: d('e', { lastRun: live, projectId: 'p-2' }),
        f: d('f', { lastRun: live, taskId: 't-1' }),
      },
    };
    expect(liveRunCount(world, 'p-1')).toBe(2);
  });
});
