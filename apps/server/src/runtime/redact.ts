/**
 * Secret redaction (TECHNOLOGY §8, corner case 30; P1-06). Known secret shapes are replaced
 * before a transcript chunk is persisted and before anything is sent to a client. The list is
 * deliberately shape-based (prefixes, well-known formats) rather than entropy-based: a false
 * positive hides a harmless string, a false negative leaks a key, and the shapes below are what
 * agents actually print (environment dumps, curl commands, config files).
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** `$1`-style groups are kept; everything else in the match is replaced. Default: whole match. */
  replace?: (match: string, ...groups: string[]) => string;
}

const mask = (name: string) => `[redacted:${name}]`;

export const REDACTION_RULES: RedactionRule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
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
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
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
    name: 'basic-auth-url',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi,
    replace: (_m, prefix: string) => `${prefix}${mask('password')}@`,
  },
  {
    name: 'assignment',
    // KEY=value shapes for the usual secret-bearing names; the name stays, the value goes.
    pattern:
      /\b((?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z0-9_]*)\s*[:=]\s*["']?)([^\s"']{8,})/g,
    replace: (_m, prefix: string) => `${prefix}${mask('value')}`,
  },
  {
    name: 'json-field',
    pattern:
      /("(?:[a-zA-Z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)[a-zA-Z0-9_-]*)"\s*:\s*")([^"]{8,})(")/gi,
    replace: (_m, prefix: string, _v: string, suffix: string) =>
      `${prefix}${mask('value')}${suffix}`,
  },
];

/** Replaces every known secret shape in `text`. Idempotent: a redacted string stays as it is. */
export function redactSecrets(text: string, rules: RedactionRule[] = REDACTION_RULES): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.pattern, (m: string, ...rest: unknown[]) => {
      if (!rule.replace) return mask(rule.name);
      // `replace` passes [...groups, offset, input]; none of the rules use named groups.
      const groups = rest.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''));
      return rule.replace(m, ...groups);
    });
  }
  return out;
}

/** Whether `text` contains anything the rules would change. */
export function containsSecret(text: string, rules: RedactionRule[] = REDACTION_RULES): boolean {
  return rules.some((r) => {
    r.pattern.lastIndex = 0;
    const hit = r.pattern.test(text);
    r.pattern.lastIndex = 0;
    return hit;
  });
}
