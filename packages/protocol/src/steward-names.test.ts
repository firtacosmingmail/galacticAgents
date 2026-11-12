import { describe, expect, it } from 'vitest';
import {
  pickStewardName,
  STEWARD_NAMES,
  stewardName,
  TASK_SHORT_NAME_MAX,
  taskShortName,
} from './steward-names.js';

describe('Steward names (P15-11)', () => {
  it('the names are unique', () => {
    expect(new Set(STEWARD_NAMES).size).toBe(STEWARD_NAMES.length);
  });

  it('picks a name nobody else uses, the same one for the same seed', () => {
    const first = pickStewardName(new Set(), 't-1');
    expect(STEWARD_NAMES).toContain(first);
    expect(pickStewardName(new Set(), 't-1')).toBe(first);
    expect(pickStewardName(new Set([first]), 't-1')).not.toBe(first);
  });

  it('numbers a name once every name is taken', () => {
    const all = new Set(STEWARD_NAMES);
    const name = pickStewardName(all, 't-1');
    expect(name).toMatch(/ 2$/);
    expect(pickStewardName(new Set([...all, name]), 't-1')).toMatch(/ 3$/);
  });

  it('a stored name wins; a task older than names gets a stable one from its id', () => {
    expect(stewardName({ id: 't-1', meta: { stewardName: 'Vega' } })).toBe('Vega');
    const derived = stewardName({ id: 't-old' });
    expect(STEWARD_NAMES).toContain(derived);
    expect(stewardName({ id: 't-old' })).toBe(derived);
  });
});

describe('taskShortName (P15-11)', () => {
  it('uses the title when there is one', () => {
    expect(taskShortName({ description: 'long brief', meta: { title: 'Prospect list' } })).toBe(
      'Prospect list',
    );
  });

  it('else the first sentence of the description, without its full stop', () => {
    expect(taskShortName({ description: 'Fix the login. Then add tests.' })).toBe('Fix the login');
    expect(taskShortName({ description: 'Ship v2\nwith notes' })).toBe('Ship v2');
  });

  it('cuts a long first sentence with an ellipsis', () => {
    const name = taskShortName({ description: 'x'.repeat(200) });
    expect(name.length).toBe(TASK_SHORT_NAME_MAX);
    expect(name.endsWith('…')).toBe(true);
  });
});
