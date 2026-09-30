import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index.js';

describe('protocol package', () => {
  it('exposes a protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
