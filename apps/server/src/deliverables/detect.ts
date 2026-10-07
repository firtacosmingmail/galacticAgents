import { parse as parseToml } from 'smol-toml';
import { redactSecrets } from '../runtime/redact.js';

/**
 * Run-script detection (P9-05; TECHNOLOGY §9.3, SPEC decision 119): pure parsers over the text of
 * the manifest files at the top of a project's folder. **Nothing is executed** — no `npm run`, no
 * `make -n`, no `just --list`: every file is read as text and parsed here. A file that does not
 * parse adds nothing (its problem is reported, and the scan keeps the rows it found before).
 *
 * Supported: `package.json` `scripts` (the package manager from the lockfile present), `Makefile`
 * / `makefile` / `GNUmakefile` rule targets, `justfile` / `.justfile` recipes, `pyproject.toml`
 * scripts (uv, poetry, pdm), `Cargo.toml` (`cargo run` per binary, `cargo test`), Compose files
 * (`docker compose up`) and `deno.json(c)` tasks. Keys are `<file>#<name>`; the important names
 * (`dev`, `start`, `serve`, `preview`, `build`, `test`) come first; at most
 * `MAX_DETECTED_COMMANDS` are listed and the rest counted.
 */

/** One command found in a manifest file. */
export interface DetectedCommand {
  /** `<file>#<name>` — the row's `detected_key`, unique per project. */
  key: string;
  /** The file it was found in, as named on disk (`package.json`, `GNUmakefile`, …). */
  file: string;
  /** The script, target, recipe or task name. */
  name: string;
  /** The row's title. */
  title: string;
  /** The command line, names shell-quoted when they need it. */
  line: string;
  /**
   * The script's own text where the file has one (`package.json`, `deno.json`, pdm), redacted
   * (`redactSecrets`) and capped: what the row shows.
   */
  description?: string;
  /**
   * What running the command executes, as the file says it (S4 of the wave-2 review): the
   * script's body (`package.json`, `deno.json`, pyproject), a Makefile rule's or a just recipe's
   * lines — redacted and capped at `MAX_BODY_LENGTH`. Stored as `meta.detected.body`, so the run
   * confirmation (P9-08, P9-10) shows it and flags it when it changed since the last run. Never
   * executed: a run executes `line` (`pnpm run dev`), which the tool resolves itself.
   */
  body?: string;
  /** Rank among `IMPORTANT_NAMES` (0 = `dev`); absent for the others. */
  important?: number;
}

/** A manifest file that was present but could not be read or parsed: it adds nothing. */
export interface DetectionProblem {
  file: string;
  reason: string;
}

/** What reading one top-level file gave. */
export type ReadResult = { ok: true; text: string } | { ok: false; reason: string };

export interface DetectInput {
  /** The names at the top of the folder, as on disk (only these are looked at). */
  entries: Iterable<string>;
  /** Reads a top-level file (size-capped, no symlink followed — the scan's job). */
  read(name: string): ReadResult;
}

export interface DetectResult {
  /** The commands listed, important ones first, at most `MAX_DETECTED_COMMANDS`. */
  commands: DetectedCommand[];
  /** Keys detected but past the cap (counted, not listed). */
  overflow: string[];
  /** Files present that could not be read or parsed. */
  problems: DetectionProblem[];
  /** Every manifest file looked at (parsed or not). */
  files: string[];
}

/** The names listed first, in this order (decision 119). */
export const IMPORTANT_NAMES = ['dev', 'start', 'serve', 'preview', 'build', 'test'] as const;

/** At most this many detected commands per project (TECHNOLOGY §9.3). */
export const MAX_DETECTED_COMMANDS = 50;

/** A name longer than this is not a script anyone runs by hand: skipped. */
const MAX_NAME_LENGTH = 200;

/** A script's own text kept as the row's description, at most this long. */
const MAX_DESCRIPTION_LENGTH = 500;

/** A command's body (`DetectedCommand.body`) kept at most this long (longer: cut, with `…`). */
export const MAX_BODY_LENGTH = 4000;

/** Characters a command-line word may hold without quoting. */
const PLAIN_WORD = /^[A-Za-z0-9_.:@/+=,%^-]+$/;

/**
 * A name as one shell word: as is when it is plain, else single-quoted (`'` as `'\''`), so a
 * script named `x; rm -rf ~` in a cloned repository shows (and would run) as one argument. The
 * user still confirms the exact line before any run (decision 129).
 */
export function shellWord(name: string): string {
  return PLAIN_WORD.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a name may become a command: not empty, not too long, no control character (a newline
 * would make two commands), no format or separator character (`\p{Cf}`: bidi overrides and
 * zero-width characters that make a name read as another; `\p{Zl}`, `\p{Zp}`: line and
 * paragraph separators), not starting with `-` (it would read as an option).
 */
export function usableName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    !name.startsWith('-') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(name) &&
    !/[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
  );
}

function importance(name: string): number | undefined {
  const i = (IMPORTANT_NAMES as readonly string[]).indexOf(name);
  return i === -1 ? undefined : i;
}

/** Trimmed, redacted (a token in a script is never stored or shown), cut at `max`. */
function shown(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = redactSecrets(text.trim());
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function command(
  file: string,
  name: string,
  line: string,
  extra: { key?: string; description?: unknown; body?: unknown; title?: string } = {},
): DetectedCommand {
  const important = importance(name);
  const description = shown(extra.description, MAX_DESCRIPTION_LENGTH);
  const body = shown(extra.body, MAX_BODY_LENGTH);
  return {
    key: extra.key ?? `${file}#${name}`,
    file,
    name,
    title: extra.title ?? name,
    line,
    ...(description !== undefined ? { description } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(important !== undefined ? { important } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A parse that throws is reported as this file's problem. */
class Malformed extends Error {}

// -- package.json --------------------------------------------------------------------------------

/** npm's lifecycle scripts: they run around install and publish, never by hand. */
const LIFECYCLE = new Set([
  'install',
  'preinstall',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
  'prepack',
  'postpack',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'preversion',
  'version',
  'postversion',
  'dependencies',
]);

/** The package manager the lockfile present names (TECHNOLOGY §9.3). */
export function packageRunner(entries: ReadonlySet<string>): (script: string) => string {
  if (entries.has('pnpm-lock.yaml')) return (s) => `pnpm run ${s}`;
  // `yarn run <s>`, never `yarn <s>`: a Yarn built-in (`yarn add`, `yarn exec`) never shadows
  // a script of the same name.
  if (entries.has('yarn.lock')) return (s) => `yarn run ${s}`;
  if (entries.has('bun.lock') || entries.has('bun.lockb')) return (s) => `bun run ${s}`;
  return (s) => `npm run ${s}`;
}

export function parsePackageJson(
  text: string,
  entries: ReadonlySet<string>,
  file = 'package.json',
): DetectedCommand[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Malformed(`not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(json)) throw new Malformed('not a JSON object');
  const scripts = json['scripts'];
  if (scripts === undefined) return [];
  if (!isRecord(scripts)) throw new Malformed('"scripts" is not an object');
  const run = packageRunner(entries);
  const names = Object.keys(scripts);
  const all = new Set(names);
  const out: DetectedCommand[] = [];
  for (const name of names) {
    const body = scripts[name];
    if (typeof body !== 'string' || !usableName(name) || LIFECYCLE.has(name)) continue;
    // `predev` / `postdev` run around `dev` by themselves.
    const hook = /^(pre|post)(.+)$/.exec(name);
    if (hook && all.has(hook[2]!)) continue;
    out.push(command(file, name, run(shellWord(name)), { description: body, body }));
  }
  return out;
}

// -- Makefile ------------------------------------------------------------------------------------

const MAKE_TARGET = /^([A-Za-z0-9_][A-Za-z0-9_./+-]*)[ \t]*(::?)(.*)$/;

/**
 * Rule targets: `name:` lines at the start of a line — not recipe lines (a tab), not special
 * targets (`.PHONY`), not patterns (`%`) or variables (`$`), not assignments (`:=`, `::=`), not
 * inside `define … endef`. Several targets on one line are skipped (rarely run by hand). A
 * target's recipe lines (tab-indented, with their continuations) are its `body`.
 */
export function parseMakefile(text: string, file = 'Makefile'): DetectedCommand[] {
  const seen = new Set<string>();
  const found: { name: string; body: string[] }[] = [];
  /** The recipe being read: the last target's lines, while tab-indented lines follow it. */
  let recipe: string[] | undefined;
  let inRecipeLine = false;
  let inDefine = 0;
  let continued = false;
  for (const raw of text.split(/\r?\n/)) {
    const wasContinued = continued;
    continued = raw.endsWith('\\');
    if (wasContinued) {
      if (recipe && inRecipeLine) recipe.push(raw);
      continue;
    }
    inRecipeLine = false;
    if (recipe && raw.startsWith('\t') && inDefine === 0) {
      recipe.push(raw.slice(1));
      inRecipeLine = true;
      continue;
    }
    if (recipe && raw.trim() !== '') recipe = undefined;
    const trimmed = raw.trim();
    if (/^define\b/.test(trimmed)) {
      inDefine++;
      continue;
    }
    if (inDefine > 0) {
      if (/^endef\b/.test(trimmed)) inDefine--;
      continue;
    }
    if (raw.startsWith('\t') || raw.startsWith(' ')) continue;
    const match = MAKE_TARGET.exec(raw);
    if (!match) continue;
    const [, name, , rest] = match as unknown as [string, string, string, string];
    if (rest.startsWith('=') || rest.startsWith(':')) continue;
    if (name.includes('%') || seen.has(name) || !usableName(name)) continue;
    seen.add(name);
    const entry = { name, body: [] as string[] };
    found.push(entry);
    recipe = entry.body;
  }
  return found.map(({ name, body }) =>
    command(file, name, `make ${shellWord(name)}`, { body: body.join('\n') }),
  );
}

// -- justfile ------------------------------------------------------------------------------------

const JUST_RECIPE = /^@?([A-Za-z_][A-Za-z0-9_-]*)((?:[ \t][^:]*)?):(.*)$/;
const JUST_KEYWORDS = new Set(['set', 'alias', 'export', 'import', 'mod', 'unexport']);

/**
 * Recipes: `name params…:` at the start of a line. Not assignments (`name := …`), settings,
 * aliases, imports, private recipes (`_name`, `[private]`) or indented lines. A recipe's
 * indented lines are its `body`.
 */
export function parseJustfile(text: string, file = 'justfile'): DetectedCommand[] {
  const seen = new Set<string>();
  const found: { name: string; body: string[] }[] = [];
  let recipe: string[] | undefined;
  let privateNext = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      recipe?.push(raw.trim());
      continue;
    }
    if (!raw.trim()) continue;
    recipe = undefined;
    if (raw.startsWith('#')) continue;
    if (raw.startsWith('[')) {
      if (/\bprivate\b/.test(raw)) privateNext = true;
      continue;
    }
    const wasPrivate = privateNext;
    privateNext = false;
    const firstWord = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(raw)?.[0];
    if (firstWord && JUST_KEYWORDS.has(firstWord) && /\s/.test(raw[firstWord.length] ?? '')) {
      continue;
    }
    const match = JUST_RECIPE.exec(raw);
    if (!match) continue;
    const [, name, , rest] = match as unknown as [string, string, string, string];
    if (rest.startsWith('=')) continue;
    if (wasPrivate || name.startsWith('_') || seen.has(name) || !usableName(name)) continue;
    seen.add(name);
    const entry = { name, body: [] as string[] };
    found.push(entry);
    recipe = entry.body;
  }
  return found.map(({ name, body }) =>
    command(file, name, `just ${shellWord(name)}`, { body: body.join('\n') }),
  );
}

// -- TOML: pyproject.toml, Cargo.toml -------------------------------------------------------------

function toml(text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const first = ((error as Error).message ?? 'invalid').split('\n')[0];
    throw new Malformed(`not valid TOML (${first})`);
  }
}

function table(
  root: Record<string, unknown>,
  ...path: string[]
): Record<string, unknown> | undefined {
  let at: unknown = root;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return isRecord(at) ? at : undefined;
}

/**
 * `[project.scripts]` and `[tool.poetry.scripts]` → `uv run <s>` with `uv.lock`, `poetry run <s>`
 * with `poetry.lock`, `pdm run <s>` with `pdm.lock`, else the script name (an installed entry
 * point); `[tool.pdm.scripts]` → `pdm run <s>` (its `_` key is pdm's settings).
 */
export function parsePyproject(
  text: string,
  entries: ReadonlySet<string>,
  file = 'pyproject.toml',
): DetectedCommand[] {
  const doc = toml(text);
  const runner = entries.has('uv.lock')
    ? 'uv run '
    : entries.has('poetry.lock')
      ? 'poetry run '
      : entries.has('pdm.lock')
        ? 'pdm run '
        : '';
  const out: DetectedCommand[] = [];
  const seen = new Set<string>();
  const add = (name: string, line: string, description?: unknown) => {
    if (!usableName(name) || seen.has(name)) return;
    seen.add(name);
    out.push(command(file, name, line, { description, body: description }));
  };
  for (const scripts of [
    table(doc, 'project', 'scripts'),
    table(doc, 'tool', 'poetry', 'scripts'),
  ]) {
    for (const [name, target] of Object.entries(scripts ?? {})) {
      add(name, `${runner}${shellWord(name)}`, typeof target === 'string' ? target : undefined);
    }
  }
  for (const [name, target] of Object.entries(table(doc, 'tool', 'pdm', 'scripts') ?? {})) {
    if (name === '_') continue;
    const body = isRecord(target)
      ? (target['cmd'] ?? target['shell'] ?? target['call'] ?? target['help'])
      : target;
    add(name, `pdm run ${shellWord(name)}`, typeof body === 'string' ? body : undefined);
  }
  return out;
}

/** `cargo run --bin <b>` per named `[[bin]]` (or `cargo run` for a single package) and `cargo test`. */
export function parseCargo(text: string, file = 'Cargo.toml'): DetectedCommand[] {
  const doc = toml(text);
  const pkg = table(doc, 'package');
  const workspace = table(doc, 'workspace');
  const out: DetectedCommand[] = [];
  const bins = Array.isArray(doc['bin']) ? doc['bin'] : [];
  const names = bins
    .map((b) => (isRecord(b) && typeof b['name'] === 'string' ? b['name'] : undefined))
    .filter((n): n is string => n !== undefined && usableName(n));
  if (names.length > 0) {
    for (const name of [...new Set(names)]) {
      out.push(
        command(file, name, `cargo run --bin ${shellWord(name)}`, {
          key: `${file}#run:${name}`,
          title: `run ${name}`,
        }),
      );
    }
  } else if (pkg) {
    out.push(command(file, 'run', 'cargo run'));
  }
  if (pkg || workspace) out.push(command(file, 'test', 'cargo test'));
  return out;
}

// -- deno.json(c) --------------------------------------------------------------------------------

/** JSONC → JSON: comments and trailing commas dropped, strings left alone. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** `tasks` → `deno task <t>` (a task is a string or `{command, description}`). */
export function parseDeno(text: string, file = 'deno.json'): DetectedCommand[] {
  let json: unknown;
  try {
    json = JSON.parse(file.endsWith('c') ? stripJsonc(text) : text);
  } catch (error) {
    throw new Malformed(`not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(json)) throw new Malformed('not a JSON object');
  const tasks = json['tasks'];
  if (tasks === undefined) return [];
  if (!isRecord(tasks)) throw new Malformed('"tasks" is not an object');
  const out: DetectedCommand[] = [];
  for (const [name, task] of Object.entries(tasks)) {
    if (!usableName(name)) continue;
    const description = isRecord(task) ? (task['description'] ?? task['command']) : task;
    const body = isRecord(task) ? task['command'] : task;
    if (typeof task !== 'string' && !isRecord(task)) continue;
    out.push(command(file, name, `deno task ${shellWord(name)}`, { description, body }));
  }
  return out;
}

// -- the folder ----------------------------------------------------------------------------------

/** The first of these present is the one each tool reads (their own precedence). */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const JUSTFILES = ['justfile', '.justfile', 'Justfile'];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const DENO_FILES = ['deno.json', 'deno.jsonc'];

/** Every manifest file name detection reads (the scan reads only these). */
export const MANIFEST_FILES: readonly string[] = [
  'package.json',
  ...MAKEFILES,
  ...JUSTFILES,
  'pyproject.toml',
  'Cargo.toml',
  ...COMPOSE_FILES,
  ...DENO_FILES,
];

/**
 * The commands a folder's top level declares (pure over `input`). Files are looked at in a fixed
 * order (package.json, Makefile, justfile, pyproject.toml, Cargo.toml, Compose, deno.json); the
 * important names come first (by `IMPORTANT_NAMES`, then that order), then the rest in that
 * order; past `MAX_DETECTED_COMMANDS` they are counted in `overflow`.
 */
export function detectCommands(input: DetectInput, max = MAX_DETECTED_COMMANDS): DetectResult {
  const entries = new Set(input.entries);
  const first = (names: string[]) => names.find((n) => entries.has(n));
  const plan: [string | undefined, (text: string, file: string) => DetectedCommand[]][] = [
    [
      entries.has('package.json') ? 'package.json' : undefined,
      (t, f) => parsePackageJson(t, entries, f),
    ],
    [first(MAKEFILES), parseMakefile],
    [first(JUSTFILES), parseJustfile],
    [
      entries.has('pyproject.toml') ? 'pyproject.toml' : undefined,
      (t, f) => parsePyproject(t, entries, f),
    ],
    [entries.has('Cargo.toml') ? 'Cargo.toml' : undefined, parseCargo],
    [
      first(COMPOSE_FILES),
      (t, f) => (t.trim() ? [command(f, 'up', 'docker compose up', { title: 'compose up' })] : []),
    ],
    [first(DENO_FILES), parseDeno],
  ];
  const found: DetectedCommand[] = [];
  const problems: DetectionProblem[] = [];
  const files: string[] = [];
  const keys = new Set<string>();
  for (const [file, parse] of plan) {
    if (!file) continue;
    files.push(file);
    const read = input.read(file);
    if (!read.ok) {
      problems.push({ file, reason: read.reason });
      continue;
    }
    let commands: DetectedCommand[];
    try {
      commands = parse(read.text, file);
    } catch (error) {
      problems.push({
        file,
        reason: error instanceof Malformed ? error.message : `could not be read (${String(error)})`,
      });
      continue;
    }
    for (const c of commands) {
      if (keys.has(c.key)) continue;
      keys.add(c.key);
      found.push(c);
    }
  }
  const ordered = [
    ...found.filter((c) => c.important !== undefined).sort((a, b) => a.important! - b.important!),
    ...found.filter((c) => c.important === undefined),
  ];
  return {
    commands: ordered.slice(0, max),
    overflow: ordered.slice(max).map((c) => c.key),
    problems,
    files,
  };
}
