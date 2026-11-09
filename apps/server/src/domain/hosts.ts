/**
 * Which network hosts a command visibly reaches (P14-02). "Allow similar" for a network reason
 * is offered per site only when every destination can be read from the command's words; anything
 * else (`npm install`, `git fetch origin`, `curl --config f`) is not host-coverable.
 */

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const URL_WORD = /^https?:\/\//i;
const GIT_REMOTE_COMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull']);

/** The lower-cased host of an http(s) URL; `undefined` for another scheme or an unparsable URL. */
export function hostOfUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function urlHosts(words: readonly string[]): string[] | undefined {
  const hosts = new Set<string>();
  for (const w of words) {
    const value = w.startsWith('--') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    if (!URL_WORD.test(value)) continue;
    const host = hostOfUrl(value);
    if (host === undefined) return undefined;
    hosts.add(host);
  }
  return hosts.size > 0 ? [...hosts].sort() : undefined;
}

/**
 * The sorted, de-duplicated hosts one simple command (its words, leading `NAME=value`
 * assignments allowed) reaches; `undefined` when its destinations are not all visible.
 */
export function hostsOfCommand(words: readonly string[]): string[] | undefined {
  let k = 0;
  const assigned: string[] = [];
  while (k < words.length && ENV_ASSIGNMENT.test(words[k]!)) assigned.push(words[k++]!);
  const program = words[k]?.split('/').pop()?.toLowerCase();
  if (program === undefined) return undefined;
  const args = words.slice(k + 1);
  switch (program) {
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
      return urlHosts(args);
    case 'gh':
      if (assigned.some((a) => a.startsWith('GH_HOST='))) return undefined;
      if (args.some((a) => a === '--hostname' || a.startsWith('--hostname='))) return undefined;
      return ['github.com'];
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === undefined || !GIT_REMOTE_COMMANDS.has(sub)) return undefined;
      return urlHosts(args);
    }
    default:
      return undefined;
  }
}
