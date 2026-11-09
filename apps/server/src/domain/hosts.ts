/**
 * Which network hosts a command visibly reaches (P14-02). "Allow similar" for a network reason
 * is offered per site only when every destination can be read from the command's words and the
 * command sends nothing out. This is an allowlist that fails closed (ruling R-d): hosts come
 * back only when EVERY word is understood — exact option spellings (no prefixes, no glued
 * values), plain positionals — and anything else is `undefined`. git and httpie are never
 * host-coverable (`insteadOf` config, submodules, stdin bodies, request items).
 */

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface HostsOptions {
  /**
   * The line assigns or exports environment variables anywhere (`export`, `env`, `set`, an
   * assignment segment): proxy, config and host variables then make every host unknown.
   */
  lineSetsEnv?: boolean;
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

/** Allowed words of one program: exact flags, exact valued options, and short-cluster letters. */
interface Grammar {
  flags: ReadonlySet<string>;
  valued: ReadonlySet<string>;
  clusterLetters?: string;
}

/** Parses `args` against `g`; `undefined` as soon as a word is not understood. */
function parse(args: readonly string[], g: Grammar): string[] | undefined {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a);
    } else if (g.flags.has(a)) {
      continue;
    } else if (g.valued.has(a)) {
      if (args[++i] === undefined) return undefined;
    } else if (
      g.clusterLetters !== undefined &&
      /^-[A-Za-z]{2,}$/.test(a) &&
      [...a.slice(1)].every((c) => g.clusterLetters!.includes(c))
    ) {
      continue;
    } else return undefined;
  }
  return positionals;
}

const set = (...names: string[]) => new Set(names);

function sortedHosts(urls: readonly string[] | undefined): string[] | undefined {
  if (urls === undefined || urls.length === 0) return undefined;
  const hosts = new Set<string>();
  for (const u of urls) {
    const h = strictHostOfUrl(u);
    if (h === undefined) return undefined;
    hosts.add(h);
  }
  return [...hosts].sort();
}

const CURL: Grammar = {
  flags: set(
    '-s',
    '-S',
    '-L',
    '-f',
    '-i',
    '-I',
    '--silent',
    '--show-error',
    '--location',
    '--fail',
    '--fail-with-body',
    '--include',
    '--head',
    '--compressed',
  ),
  valued: set(
    '-H',
    '--header',
    '-o',
    '--output',
    '-w',
    '--write-out',
    '-m',
    '--max-time',
    '--connect-timeout',
    '-A',
    '--user-agent',
    '-r',
    '--range',
    '--retry',
  ),
  clusterLetters: 'sSLfiI',
};
const WGET: Grammar = {
  flags: set('-q', '--quiet', '-nv', '--no-verbose', '-S', '--server-response'),
  valued: set('-O', '--output-document', '-T', '--timeout', '--header', '-U', '--user-agent'),
};
const GH: Grammar = {
  flags: set('--comments', '--patch', '--name-only'),
  valued: set(
    '--json',
    '--jq',
    '-q',
    '--template',
    '-t',
    '--color',
    '-L',
    '--limit',
    '-s',
    '--state',
    '--author',
    '-l',
    '--label',
    '-B',
    '--base',
    '-H',
    '--head',
  ),
};
const GH_API: Grammar = {
  flags: set('--paginate'),
  valued: set('--jq', '-q', '-H', '--header'),
};
const GH_READ_ONLY: Record<string, ReadonlySet<string> | undefined> = {
  pr: set('view', 'list', 'diff', 'checks', 'status'),
  issue: set('view', 'list', 'status'),
  repo: set('view', 'list'),
  run: set('view', 'list', 'watch'),
  release: set('view', 'list'),
  search: undefined,
  auth: set('status', 'token'),
};

/**
 * `gh` reaches github.com for read-only subcommands with plain positionals (numbers, branch
 * names): a positional with `:` or `/` could be a URL or a HOST/OWNER/REPO spec. The current
 * repository's remote host is accepted as github.com (the projects live there); `GH_HOST` and
 * `GH_REPO` are caught by `lineSetsEnv`. `-R/--repo` is not understood, so it fails closed.
 */
function ghHosts(args: readonly string[]): string[] | undefined {
  const group = args[0];
  if (group === undefined) return undefined;
  if (group === 'api') {
    const positionals = parse(args.slice(1), GH_API);
    if (positionals === undefined || positionals.length !== 1) return undefined;
    const endpoint = positionals[0]!;
    if (endpoint.includes(':') || endpoint.includes('//') || /\s/.test(endpoint)) return undefined;
    return ['github.com'];
  }
  if (!Object.hasOwn(GH_READ_ONLY, group)) return undefined;
  const sub = args[1];
  if (group !== 'search' && (sub === undefined || !GH_READ_ONLY[group]?.has(sub))) {
    return undefined;
  }
  const positionals = parse(args.slice(group === 'search' ? 1 : 2), GH);
  if (positionals === undefined || positionals.some((x) => /[:/\\\s]/.test(x))) return undefined;
  return ['github.com'];
}

/**
 * The sorted, de-duplicated hosts one simple command reaches; `undefined` when its destinations
 * are not all visible, it sends data out, or the environment may redirect it.
 */
export function hostsOfCommand(
  words: readonly string[],
  options: HostsOptions = {},
): string[] | undefined {
  if (options.lineSetsEnv || words.length === 0 || ENV_ASSIGNMENT.test(words[0]!)) {
    return undefined;
  }
  const program = words[0]!.split('/').pop()!.toLowerCase();
  const args = words.slice(1);
  switch (program) {
    case 'curl':
      return sortedHosts(parse(args, CURL));
    case 'wget':
      return sortedHosts(parse(args, WGET));
    case 'gh':
      return ghHosts(args);
    default:
      return undefined;
  }
}
