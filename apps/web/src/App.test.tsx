import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@galactic/protocol';

describe('web package', () => {
  it('imports the shared protocol', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
