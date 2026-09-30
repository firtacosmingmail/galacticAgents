import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets } from './redact.js';

// Fake keys in the shapes real ones have; none of these is a real credential.
const CASES: [label: string, input: string, expected: string][] = [
  [
    'anthropic key',
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
    'export ANTHROPIC_API_KEY=[redacted:value]',
  ],
  [
    'anthropic key in prose',
    'the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked',
    'the key [redacted:anthropic-key] leaked',
  ],
  [
    'openai key',
    'Authorization: sk-proj-abcdefghijklmnopqrstuvwxyz0123',
    'Authorization: [redacted:openai-key]',
  ],
  [
    'aws access key',
    'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
    'aws_access_key_id = [redacted:aws-access-key]',
  ],
  [
    'aws secret key',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'aws_secret_access_key = [redacted:aws-secret-key]',
  ],
  [
    'github token',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    'token [redacted:github-token]',
  ],
  ['github pat', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', '[redacted:github-pat]'],
  ['slack token', 'xoxb-1234567890-abcdefghijklmnop', '[redacted:slack-token]'],
  ['stripe key', 'sk_live_abcdefghijklmnopqrstuvwx', '[redacted:stripe-key]'],
  ['google key', 'key=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234', 'key=[redacted:google-api-key]'],
  ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', '[redacted:npm-token]'],
  [
    'jwt',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    '[redacted:jwt]',
  ],
  [
    'bearer',
    'curl -H "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz"',
    'curl -H "Authorization: Bearer [redacted:bearer]"',
  ],
  [
    'url password',
    'postgres://user:s3cretpass@db.example.com:5432/x',
    'postgres://user:[redacted:password]@db.example.com:5432/x',
  ],
  ['env assignment', 'DATABASE_PASSWORD=hunter2hunter2', 'DATABASE_PASSWORD=[redacted:value]'],
  [
    'json field',
    '{"apiKey": "0123456789abcdef", "name": "x"}',
    '{"apiKey": "[redacted:value]", "name": "x"}',
  ],
  [
    'private key block',
    'cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\ndone',
    'cat id_rsa\n[redacted:private-key]\ndone',
  ],
];

describe('redactSecrets', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(containsSecret(input)).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    for (const s of [
      'Read README.md (42 lines)',
      'pnpm test → 12 passed',
      'const token = await getToken();',
      'sk-1', // too short to be a key
      'PASSWORD=short',
      'https://example.com/path?x=1',
      'git commit -m "add auth token refresh"',
    ]) {
      expect(redactSecrets(s)).toBe(s);
      expect(containsSecret(s)).toBe(false);
    }
  });

  it('is idempotent and handles several secrets in one chunk', () => {
    const text =
      'A=sk-ant-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const once = redactSecrets(text);
    expect(once).toBe('A=[redacted:anthropic-key] and [redacted:github-token]');
    expect(redactSecrets(once)).toBe(once);
  });
});
