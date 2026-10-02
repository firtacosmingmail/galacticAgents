import type { AgentEvent } from '@galactic/protocol';

/**
 * Secret redaction (TECHNOLOGY §8, corner case 30; P1-06, P1-31). Known secret shapes are
 * replaced before a transcript chunk is persisted and before anything is sent to a client. The
 * list is deliberately shape-based (prefixes, well-known formats, secret-bearing names) rather
 * than entropy-based: a false positive hides a harmless string, a false negative leaks a key,
 * and the shapes below are what agents actually print (environment dumps, curl commands, config
 * files). User-authored text (messages, answers, prompts) is not redacted (TECHNOLOGY §8).
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /**
   * `$1`-style groups are kept; everything else in the match is replaced. Default: whole match.
   * Returning `match` unchanged means "not a secret after all" (the assignment rules use this to
   * skip placeholders and code).
   */
  replace?: (match: string, ...groups: string[]) => string;
}

export const mask = (name: string) => `[redacted:${name}]`;

/** The header lines of a PEM / PGP private-key block (`RSA`, `EC`, `OPENSSH`, `ENCRYPTED`, …). */
export const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
export const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;

// --- assignment rules: `name: value`, `name = "value"` -----------------------------------------

/** Name words that make even a short value (≥ 4 chars) a secret. */
const STRONG_WORDS = /password|passwd|passphrase|secret|credential|apikey|privatekey/;
const STRONG_EXACT = new Set(['pass', 'pwd']);
/** Name words that make a key-length value (≥ 8 chars) a secret. */
const WEAK_WORDS = /token|accesskey/;
const WEAK_EXACT = new Set(['auth']);
/** A last name word saying the value is about the secret, not the secret itself. */
const NON_SECRET_SUFFIX = new Set([
  'helper',
  'file',
  'path',
  'dir',
  'url',
  'uri',
  'id',
  'name',
  'type',
  'length',
  'len',
  'count',
  'policy',
  'expiry',
  'expires',
  'ttl',
  'size',
  'mode',
  'provider',
  'store',
  'manager',
  'prompt',
  'field',
  'hint',
  'env',
  'var',
  'endpoint',
  'header',
  'format',
  'version',
  'enabled',
  'required',
]);
/** Values that are obviously not a secret: placeholders, keywords, type names. */
const NON_SECRET_VALUE =
  /^(?:\*+|x{3,}|\.{3,}|-+|null|nil|none|undefined|true|false|yes|no|on|off|empty|redacted|changeme|example|secret|password|your[-_]?\w*|string|str|number|int|integer|bool|boolean|bytes|any|unknown|optional|required|enabled|disabled|await|new|this|self|function|async|require|import|return)$/i;

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How sure we are that a value assigned to `name` is a secret: 0 not, 1 when it is key-length
 * (`token`, `auth`), 2 even when short (`password`, `secret`, `api_key`, `DB_PASS`).
 */
export function secretTier(name: string): 0 | 1 | 2 {
  const words = nameWords(name);
  if (words.length === 0 || NON_SECRET_SUFFIX.has(words[words.length - 1]!)) return 0;
  let pair = false;
  for (let i = 0; i + 1 < words.length; i++) {
    const two = words[i]! + words[i + 1]!;
    if (two === 'apikey' || two === 'privatekey') pair = true;
  }
  if (pair || words.some((w) => STRONG_EXACT.has(w) || STRONG_WORDS.test(w))) return 2;
  if (words.some((w) => WEAK_EXACT.has(w) || WEAK_WORDS.test(w))) return 1;
  return 0;
}

/** Whether `value`, assigned to a name of `tier`, should be masked. */
function isSecretValue(value: string, tier: 0 | 1 | 2, quoted: boolean): boolean {
  if (tier === 0) return false;
  if (value.length < (tier === 2 ? 4 : 8)) return false;
  if (NON_SECRET_VALUE.test(value)) return false;
  if (/^[$%]/.test(value) || value.startsWith('[redacted:')) return false; // ${VAR}, %VAR%
  if (/^\{\{.*\}\}$/.test(value)) return false; // {{ template }}
  if (!quoted) {
    if (/^(?:~|\.{0,2})\/[\w./-]*$/.test(value)) return false; // a path (PWD=/home/me)
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // process.env.X
    if (tier === 1 && /^\d+$/.test(value)) return false; // max_tokens: 4096
  }
  return true;
}

const NAME = String.raw`[A-Za-z0-9_.-]*?(?:pass|pwd|secret|credential|token|api[_-]?key|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_.-]*`;
const SEP = String.raw`[ \t]*(?::=|=(?![=>])|:(?![:=]))[ \t]*`;
// Quoted: anything up to the closing quote on the same line. Unquoted: a run without quotes,
// brackets or separators, taken atomically (lookahead + backreference) and not followed by `(`,
// so a function call is never taken for a value.
const VALUE = String.raw`(?:(["'\x60])([^\r\n"'\x60]*)\3|(?=([^\s"'\x60,;(){}\[\]<>]+))\5(?!\())`;

// --- the rules -----------------------------------------------------------------------------------

export const REDACTION_RULES: RedactionRule[] = [
  {
    name: 'private-key',
    // A block without its END line (truncated, or the rest still streaming) is masked to the end.
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'aws-secret-key',
    pattern:
      /\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)(\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})\b/g,
    replace: (_m, k: string, sep: string) => `${k}${sep}${mask('aws-secret-key')}`,
  },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  {
    name: 'slack-token',
    pattern: /\b(?:xox[abprs]|xoxe|xapp)[.-][A-Za-z0-9.-]{9,}[A-Za-z0-9]/g,
  },
  { name: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'bearer',
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g,
    replace: (_m, prefix: string) => `${prefix}${mask('bearer')}`,
  },
  {
    name: 'basic-auth',
    pattern: /\b(Authorization:[ \t]*Basic[ \t]+)([A-Za-z0-9+/]{6,}={0,2})/gi,
    replace: (_m, prefix: string) => `${prefix}${mask('basic-auth')}`,
  },
  {
    name: 'basic-auth-url',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi,
    replace: (_m, prefix: string) => `${prefix}${mask('password')}@`,
  },
  {
    name: 'assignment',
    // `name: value` / `name = "value"` for secret-bearing names, any case; the name stays, the
    // value goes. Short values only for clearly secret names; placeholders and code are kept.
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(${NAME})(${SEP})${VALUE}`, 'gi'),
    replace: (m, name: string, sep: string, quote: string, quoted: string, bare: string) => {
      const value = quote ? quoted : bare;
      if (!isSecretValue(value, secretTier(name), Boolean(quote))) return m;
      return `${name}${sep}${quote}${mask('value')}${quote}`;
    },
  },
  {
    name: 'json-field',
    pattern:
      /("([a-zA-Z0-9_-]*(?:secret|token|pass|pwd|credential|api[_-]?key|private[_-]?key|access[_-]?key)[a-zA-Z0-9_-]*)"\s*:\s*")([^"]*)(")/gi,
    replace: (m, prefix: string, name: string, value: string, suffix: string) => {
      if (!isSecretValue(value, secretTier(name), true)) return m;
      return `${prefix}${mask('value')}${suffix}`;
    },
  },
];

/** The replacement for one match of `rule`; equal to the match when it is not a secret. */
export function replaceMatch(rule: RedactionRule, match: string, groups: unknown[]): string {
  if (!rule.replace) return mask(rule.name);
  return rule.replace(match, ...groups.map((g) => (typeof g === 'string' ? g : '')));
}

/** Replaces every known secret shape in `text`. Idempotent: a redacted string stays as it is. */
export function redactSecrets(text: string, rules: RedactionRule[] = REDACTION_RULES): string {
  let out = text;
  for (const rule of rules) {
    // `replace` passes [...groups, offset, input]; none of the rules use named groups.
    out = out.replace(rule.pattern, (m: string, ...rest: unknown[]) =>
      replaceMatch(rule, m, rest.slice(0, -2)),
    );
  }
  return out;
}

/** Whether `text` contains anything the rules would change. */
export function containsSecret(text: string, rules: RedactionRule[] = REDACTION_RULES): boolean {
  return redactSecrets(text, rules) !== text;
}

/** Every string an agent event carries can hold a printed secret; redact them like output. */
export function redactEvent<T extends AgentEvent>(event: T): T {
  switch (event.type) {
    case 'agent.output':
      return { ...event, text: redactSecrets(event.text) };
    case 'agent.tool_call':
      return {
        ...event,
        ...(event.input !== undefined ? { input: redactValue(event.input) } : {}),
      };
    case 'agent.needs_input':
      return {
        ...event,
        question: {
          ...event.question,
          text: redactSecrets(event.question.text),
          ...(event.question.options
            ? { options: event.question.options.map((o) => redactSecrets(o)) }
            : {}),
          ...(event.question.toolCall
            ? {
                toolCall: {
                  ...event.question.toolCall,
                  ...(event.question.toolCall.input !== undefined
                    ? { input: redactValue(event.question.toolCall.input) }
                    : {}),
                },
              }
            : {}),
        },
      };
    case 'agent.progress':
      return { ...event, summary: redactSecrets(event.summary) };
    case 'agent.finished':
      return {
        ...event,
        ...(event.result !== undefined ? { result: redactSecrets(event.result) } : {}),
      };
    case 'agent.failed':
      return { ...event, error: redactSecrets(event.error) };
    default:
      return event;
  }
}

/** Every string inside `value` redacted (tool inputs, P2-04's `permission.decided`). */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
  }
  return value;
}
