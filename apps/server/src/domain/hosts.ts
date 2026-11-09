/**
 * Which network hosts a command visibly reaches (P14-02). "Allow similar" for a network reason
 * is offered per site only when every destination can be read from the command's words and the
 * command sends nothing out; anything else (`npm install`, `git fetch origin`, `curl --config f`,
 * `curl -d @file https://x`) is not host-coverable. Every doubt resolves to `undefined`: an
 * option that is not understood shows up as a positional that is not a URL.
 */

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface HostsOptions {
  /** A `GH_HOST` assignment or export appears anywhere in the line: `gh` then talks to another host. */
  ghHostSet?: boolean;
}

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

/**
 * The host of a URL word as a command would use it, or `undefined` when it could mean something
 * else to the program: backslashes, whitespace, userinfo (`https://ok.com\@evil.com`), globbing
 * braces, or a raw authority that differs from the parsed host.
 */
function strictHostOfUrl(word: string): string | undefined {
  if (!/^https?:\/\//i.test(word) || /[\\\s]/.test(word)) return undefined;
  const rest = word.slice(word.indexOf('//') + 2);
  const authority = rest.split(/[/?#]/, 1)[0]!;
  if (authority.includes('@')) return undefined;
  const host = hostOfUrl(word);
  if (host === undefined || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  if (authority.replace(/:\d*$/, '').toLowerCase() !== host) return undefined;
  return host;
}

interface Parsed {
  /** Options as `[name, value]`; short options by their letter, long ones with the dashes. */
  options: [string, string | undefined][];
  positionals: string[];
}

/**
 * Splits words into options and positionals. `valued` lists the options that take a value (short
 * letters without a dash, long names with `--`); a short cluster ends at its first valued letter.
 */
function parseArgs(args: readonly string[], valued: ReadonlySet<string>): Parsed {
  const out: Parsed = { options: [], positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) out.options.push([name, a.slice(eq + 1)]);
      else if (valued.has(name)) out.options.push([name, args[++i]]);
      else out.options.push([name, undefined]);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const letter = a[c]!;
        if (valued.has(letter)) {
          const glued = a.slice(c + 1);
          out.options.push([letter, glued !== '' ? glued : args[++i]]);
          break;
        }
        out.options.push([letter, undefined]);
      }
    } else out.positionals.push(a);
  }
  return out;
}

const has = (p: Parsed, ...names: string[]) => p.options.some(([n]) => names.includes(n));
const valueOf = (p: Parsed, ...names: string[]) =>
  p.options.filter(([n]) => names.includes(n)).map(([, v]) => v);
const isReadMethod = (v: string | undefined) => v !== undefined && /^(?:get|head)$/i.test(v);

function sortedHosts(urls: readonly string[]): string[] | undefined {
  if (urls.length === 0) return undefined;
  const hosts = new Set<string>();
  for (const u of urls) {
    const h = strictHostOfUrl(u);
    if (h === undefined) return undefined;
    hosts.add(h);
  }
  return [...hosts].sort();
}

const CURL_VALUED = new Set([
  'd',
  'F',
  'T',
  'X',
  'x',
  'K',
  'H',
  'o',
  'u',
  'A',
  'e',
  'b',
  'c',
  'm',
  'w',
  'r',
  'E',
  'y',
  'Y',
  'z',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
  '--form',
  '--form-string',
  '--upload-file',
  '--request',
  '--proxy',
  '--preproxy',
  '--resolve',
  '--connect-to',
  '--config',
  '--header',
  '--output',
  '--user',
  '--user-agent',
  '--referer',
  '--cookie',
  '--cookie-jar',
  '--max-time',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '--write-out',
  '--range',
  '--cert',
  '--cacert',
  '--capath',
  '--key',
  '--limit-rate',
  '--interface',
  '--dns-servers',
  '--doh-url',
  '--unix-socket',
  '--url',
  '--proxy-user',
  '--noproxy',
  '--time-cond',
  '--max-redirs',
  '-m',
]);
const CURL_REJECT = [
  'd',
  'F',
  'T',
  'K',
  'x',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
  '--form',
  '--form-string',
  '--upload-file',
  '--config',
  '--proxy',
  '--preproxy',
  '--resolve',
  '--connect-to',
  '--doh-url',
  '--unix-socket',
  '--abstract-unix-socket',
  '--socks5',
  '--socks4',
];

function curlHosts(args: readonly string[]): string[] | undefined {
  const p = parseArgs(args, CURL_VALUED);
  if (has(p, ...CURL_REJECT)) return undefined;
  if (valueOf(p, 'X', '--request').some((v) => !isReadMethod(v))) return undefined;
  const urls = [...p.positionals, ...valueOf(p, '--url').filter((v): v is string => !!v)];
  return sortedHosts(urls);
}

const WGET_VALUED = new Set([
  'i',
  'e',
  'B',
  'O',
  'o',
  'a',
  'P',
  'U',
  'D',
  'A',
  'R',
  'I',
  'X',
  'Q',
  'l',
  't',
  'T',
  'w',
  'Y',
  '--input-file',
  '--execute',
  '--base',
  '--output-document',
  '--output-file',
  '--append-output',
  '--directory-prefix',
  '--user-agent',
  '--domains',
  '--accept',
  '--reject',
  '--include-directories',
  '--exclude-directories',
  '--quota',
  '--level',
  '--tries',
  '--timeout',
  '--wait',
  '--header',
  '--post-data',
  '--post-file',
  '--body-data',
  '--body-file',
  '--method',
  '--config',
  '--proxy',
  '--user',
  '--password',
  '--bind-address',
  '--limit-rate',
  '--read-timeout',
  '--dns-timeout',
  '--connect-timeout',
  '--waitretry',
  '--certificate',
  '--ca-certificate',
  '--private-key',
]);
const WGET_REJECT = [
  'i',
  'e',
  'B',
  'H',
  '--input-file',
  '--execute',
  '--base',
  '--config',
  '--post-data',
  '--post-file',
  '--body-data',
  '--body-file',
  '--span-hosts',
  '--proxy',
  '--force-html',
];

function wgetHosts(args: readonly string[]): string[] | undefined {
  const p = parseArgs(args, WGET_VALUED);
  if (has(p, ...WGET_REJECT)) return undefined;
  if (valueOf(p, '--method').some((v) => !isReadMethod(v))) return undefined;
  return sortedHosts(p.positionals);
}

const HTTPIE_VALUED = new Set([
  'a',
  'A',
  'o',
  's',
  'p',
  'P',
  '--auth',
  '--auth-type',
  '--session',
  '--session-read-only',
  '--proxy',
  '--verify',
  '--cert',
  '--cert-key',
  '--timeout',
  '--max-redirects',
  '--output',
  '--pretty',
  '--style',
  '--print',
  '--download-resume',
  '--default-scheme',
  '--response-charset',
  '--response-mime',
  '--ssl',
  '--ciphers',
  '--format-options',
  '--unsorted',
  '--sorted',
]);

function httpieHosts(args: readonly string[]): string[] | undefined {
  const p = parseArgs(args, HTTPIE_VALUED);
  if (has(p, '--proxy', '--offline', '--raw', '--default-scheme', 'f', '--form', '--multipart')) {
    return undefined;
  }
  const rest = [...p.positionals];
  if (rest[0] !== undefined && /^[A-Za-z]+$/.test(rest[0])) {
    if (!isReadMethod(rest[0])) return undefined;
    rest.shift();
  }
  const url = rest.shift();
  if (url === undefined) return undefined;
  // Request items: `key=value`, `key:=json`, `field@file` send data; `Header:value` does not.
  if (rest.some((item) => /[=@]/.test(item))) return undefined;
  return sortedHosts([url]);
}

const GIT_REMOTE_COMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull']);
const GIT_VALUED = new Set([
  'b',
  'o',
  'j',
  's',
  'X',
  '--branch',
  '--depth',
  '--origin',
  '--reference',
  '--separate-git-dir',
  '--jobs',
  '--filter',
  '--server-option',
  '--shallow-since',
  '--shallow-exclude',
  '--strategy',
  '--strategy-option',
  '--template',
  '--refmap',
  '--negotiation-tip',
  '--deepen',
  '--bundle-uri',
]);
const GIT_REJECT = [
  'c',
  'u',
  '--config',
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--recurse-submodules',
  '--recursive',
  '--multiple',
  '--all',
];

function gitHosts(args: readonly string[]): string[] | undefined {
  // Only quiet global options may precede the subcommand: `git -c k=v …` can rewrite remotes.
  let k = 0;
  while (k < args.length && (args[k] === '--no-pager' || args[k] === '-P')) k++;
  const sub = args[k];
  if (sub === undefined || !GIT_REMOTE_COMMANDS.has(sub)) return undefined;
  const p = parseArgs(args.slice(k + 1), GIT_VALUED);
  if (has(p, ...GIT_REJECT)) return undefined;
  const repo = p.positionals[0];
  return repo === undefined ? undefined : sortedHosts([repo]);
}

const GH_READ_ONLY: Record<string, ReadonlySet<string> | undefined> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list', 'watch']),
  release: new Set(['view', 'list']),
  auth: new Set(['status', 'token']),
};
const GH_VALUED = new Set([
  'R',
  'X',
  'f',
  'F',
  'H',
  '--repo',
  '--method',
  '--field',
  '--raw-field',
  '--header',
  '--input',
  '--hostname',
  '--jq',
  '-q',
  '--template',
  '--json',
  'q',
  't',
  'L',
  's',
  '--jq',
  '--limit',
  '--state',
]);

/**
 * `gh` reaches github.com for read-only subcommands. It also follows the current repository's
 * remote host; that is accepted here (the projects live on github.com) — a `GH_HOST` assignment
 * anywhere in the line, `--hostname`, or `-R HOST/OWNER/REPO` makes the host unknown.
 */
function ghHosts(args: readonly string[]): string[] | undefined {
  const group = args[0];
  const sub = args[1];
  if (group === undefined || group.startsWith('-')) return undefined;
  const p = parseArgs(args.slice(1), GH_VALUED);
  if (has(p, '--hostname')) return undefined;
  if (valueOf(p, 'R', '--repo').some((v) => v === undefined || v.split('/').length > 2)) {
    return undefined;
  }
  if (group === 'search') return ['github.com'];
  if (group === 'api') {
    if (has(p, 'f', 'F', '--field', '--raw-field', '--input')) return undefined;
    if (valueOf(p, 'X', '--method').some((v) => v?.toLowerCase() !== 'get')) {
      return undefined;
    }
    return ['github.com'];
  }
  if (sub === undefined || sub.startsWith('-')) return undefined;
  return GH_READ_ONLY[group]?.has(sub) ? ['github.com'] : undefined;
}

/**
 * The sorted, de-duplicated hosts one simple command (its words, leading `NAME=value`
 * assignments allowed) reaches; `undefined` when its destinations are not all visible or it
 * sends data out.
 */
export function hostsOfCommand(
  words: readonly string[],
  options: HostsOptions = {},
): string[] | undefined {
  let k = 0;
  const assigned: string[] = [];
  while (k < words.length && ENV_ASSIGNMENT.test(words[k]!)) assigned.push(words[k++]!);
  const program = words[k]?.split('/').pop()?.toLowerCase();
  if (program === undefined) return undefined;
  const args = words.slice(k + 1);
  switch (program) {
    case 'curl':
      return curlHosts(args);
    case 'wget':
      return wgetHosts(args);
    case 'http':
    case 'https':
      return httpieHosts(args);
    case 'git':
      return gitHosts(args);
    case 'gh':
      if (options.ghHostSet || assigned.some((a) => a.startsWith('GH_HOST='))) return undefined;
      return ghHosts(args);
    default:
      return undefined;
  }
}
