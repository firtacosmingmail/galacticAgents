import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactLine, traceFromEnv } from './trace.js';

describe('ACP trace (GALACTIC_ACP_TRACE)', () => {
  it('is off unless the variable is set', () => {
    expect(traceFromEnv(undefined)).toBeUndefined();
    expect(traceFromEnv('')).toBeUndefined();
    expect(traceFromEnv('0')).toBeUndefined();
  });

  it('redacts credential-looking strings, keeps token counts and other values', () => {
    const line = JSON.stringify({
      params: { apiKey: 'sk-ant-abc', authorization: 'Bearer x', inputTokens: 12, name: 'ok' },
    });
    expect(JSON.parse(redactLine(line))).toEqual({
      params: { apiKey: '[redacted]', authorization: '[redacted]', inputTokens: 12, name: 'ok' },
    });
    expect(redactLine('not json sk-ant-api03-secretsecret')).toBe('not json sk-ant-api0[redacted]');
  });

  it('writes whole lines to the file it names, however the chunks split them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'galactic-acp-trace-')), 'trace.log');
    const trace = traceFromEnv(file)!;
    trace('a-1', '<-', '{"jsonrpc":"2.0",');
    trace('a-1', '<-', '"id":1}\n{"jsonrpc":"2.0","id":2}\n');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\S+ a-1 <- \{"jsonrpc":"2.0","id":1\}$/);
  });
});
