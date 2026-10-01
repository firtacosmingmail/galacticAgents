import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets } from './redact.js';

// Fake keys in the shapes real ones have; none of these is a real credential.
const CASES: [label: string, input: string, expected: string][] = [
  [
    'anthropic key',
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
    'export ANTHROPIC_API_KEY=[redacted:anthropic-key]',
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

// P1-31: shapes the first rule set missed (review R4).
const NEW_CASES: [label: string, input: string, expected: string][] = [
  ['lower-case password', 'password: hunter2', 'password: [redacted:value]'],
  ['api_key double-quoted', 'api_key = "abc123xyz"', 'api_key = "[redacted:value]"'],
  ['secret_key single-quoted', "secret_key = 'abcd'", "secret_key = '[redacted:value]'"],
  ['quoted value with spaces', 'password = "correct horse"', 'password = "[redacted:value]"'],
  ['short upper-case value', 'PASSWORD=short', 'PASSWORD=[redacted:value]'],
  ['DB_PASS', 'DB_PASS=s3cr', 'DB_PASS=[redacted:value]'],
  ['MYSQL_PWD', 'MYSQL_PWD=topsecret', 'MYSQL_PWD=[redacted:value]'],
  ['credentials', 'aws_credentials: abcd1234', 'aws_credentials: [redacted:value]'],
  ['camelCase', 'const dbPassword = "pa55word";', 'const dbPassword = "[redacted:value]";'],
  ['cli flag', 'mysql --password=hunter2 db', 'mysql --password=[redacted:value] db'],
  [
    'token name, key-length value',
    'GITLAB_TOKEN: abcdef0123456789',
    'GITLAB_TOKEN: [redacted:value]',
  ],
  ['header api key', 'x-api-key: 0123abcd', 'x-api-key: [redacted:value]'],
  ['json password, short', '{"password": "hunter2"}', '{"password": "[redacted:value]"}'],
  [
    'basic auth header',
    'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="',
    'curl -H "Authorization: Basic [redacted:basic-auth]"',
  ],
  [
    'basic auth header, lower case',
    'authorization: basic dXNlcjpwYXNz',
    'authorization: basic [redacted:basic-auth]',
  ],
  [
    'slack app token',
    'SLACK_APP=xapp-1-A0123456789-1234567890123-abcdef0123456789',
    'SLACK_APP=[redacted:slack-token]',
  ],
  [
    'slack refresh token (xoxe.)',
    'xoxe.xoxp-1-Mi0yLTEyMzQ1Njc4OTAtMTIzNDU2 ok',
    '[redacted:slack-token] ok',
  ],
  ['slack refresh token (xoxe-)', 'xoxe-1-My0xLTEyMzQ1Njc4OTAx', '[redacted:slack-token]'],
  [
    'gitlab pat',
    'git clone https://glpat-AbCdEfGh1234567890_xyz',
    'git clone https://[redacted:gitlab-token]',
  ],
  [
    'hugging face token',
    'HF says hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567 is set',
    'HF says [redacted:huggingface-token] is set',
  ],
  [
    'pgp private key block',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----',
    '[redacted:private-key]',
  ],
  [
    'openssh private key',
    'x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\ny',
    'x\n[redacted:private-key]\ny',
  ],
  [
    'encrypted private key',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHz\n-----END ENCRYPTED PRIVATE KEY-----',
    '[redacted:private-key]',
  ],
  [
    'private key without END (truncated) is masked to the end',
    'key:\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIrZ',
    'key:\n[redacted:private-key]',
  ],
];

describe('redactSecrets', () => {
  it.each([...CASES, ...NEW_CASES])('%s', (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(containsSecret(input)).toBe(true);
    expect(redactSecrets(expected)).toBe(expected); // idempotent
  });

  it('leaves ordinary text alone', () => {
    for (const s of [
      'Read README.md (42 lines)',
      'pnpm test → 12 passed',
      'const token = await getToken();',
      'const token = getTokenFromEnvironment();',
      'const password = process.env.DB_PASSWORD;',
      'sk-1', // too short to be a key
      'https://example.com/path?x=1',
      'git commit -m "add auth token refresh"',
      'passwordless login',
      'token count: 12',
      'max_tokens: 4096',
      'password: ',
      'password:',
      'password: ***',
      'password = "****"',
      'password: <your password>',
      'password = ${DB_PASSWORD}',
      'PASSWORD=%DB_PASSWORD%',
      'password: {{ vault.password }}',
      'password: string;',
      '  password?: string;',
      'if (password == "abcdefgh") {',
      'token => token.trim()',
      'PWD=/home/cosmin/projects',
      'OLDPWD=~/src',
      'password_file=/etc/app/pw',
      'TOKEN_EXPIRY=3600',
      'git config credential.helper osxkeychain',
      'credential.helper=osxkeychain',
      'author: someone@example.com',
      'compass = north',
      'bypass: enabled',
      'auth: required',
      'hf_short',
      'std::token value',
    ]) {
      expect(redactSecrets(s), s).toBe(s);
      expect(containsSecret(s), s).toBe(false);
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
