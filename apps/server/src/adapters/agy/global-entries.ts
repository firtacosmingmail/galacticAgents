import {
  chmodSync,
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Mission Control's entries in agy's global configuration (P11-05; P11-01 Ruling): agy loads
 * hooks only from `.agents/hooks.json` in the workspace (which an agent can write, so never
 * there), `~/.gemini/config/hooks.json` and plugins, and MCP servers only from the workspace's or
 * the global `~/.gemini/config/mcp_config.json` — `--settings` carries neither. So the adapter
 * adds one entry of its own to each global file, keyed `galactic` and tagged `"galactic": true`:
 *
 * - `hooks.json`: `{"galactic": {"galactic": true, "enabled": true, "PreToolUse": [{"matcher":
 *   "*", "hooks": [{"type": "command", "command": <hook>, "timeout": 86400}]}]}}`.
 * - `mcp_config.json`: `{"mcpServers": {"galactic": {"galactic": true, "command": <node>, "args":
 *   [<tool server>]}}}`.
 *
 * Both pass through for runs Mission Control did not start (the scripts see no session secret),
 * so the user's own `agy` use is unaffected. Every other entry and byte the user has is kept: a
 * write goes to a temporary file renamed over the original (atomic), and removal deletes only the
 * tagged entry. When the file is unchanged since Mission Control's write, removal puts back the
 * exact bytes that were there before (or removes a file that did not exist), so the user's file is
 * byte-identical afterwards; the original bytes are kept in a state file under Mission Control's
 * data directory, so a crash between install and removal does not lose them.
 *
 * Fail closed on doubt: a file that is not JSON, or a `galactic` key Mission Control did not tag,
 * is left untouched and the install throws (the adapter then refuses to spawn).
 */

export const ENTRY_KEY = 'galactic';
export const ENTRY_TAG = 'galactic';

export interface GlobalEntriesOptions {
  /** The user's home directory (production: `os.homedir()`; tests: a temp directory). */
  home: string;
  /** Where Mission Control keeps the original bytes (a file in its data directory). */
  stateFile: string;
  /** The hook's command line (agy runs it through a shell). */
  hookCommand: string;
  /** The hook's timeout in seconds. */
  hookTimeoutS: number;
  /** The tool server's command and arguments. */
  toolCommand: string;
  toolArgs: string[];
}

export function hooksFile(home: string): string {
  return join(home, '.gemini', 'config', 'hooks.json');
}

export function mcpConfigFile(home: string): string {
  return join(home, '.gemini', 'config', 'mcp_config.json');
}

interface FileRecord {
  /** The bytes before Mission Control's first write; `null`: there was no file. */
  original: string | null;
  /** What Mission Control wrote last. */
  written: string;
}
type State = Record<string, FileRecord>;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The file as an object: absent or blank is `{}`; anything else that is not an object throws. */
function parse(file: string, text: string | null): Json {
  if (text === null || text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON: GalacticAgents leaves it alone`);
  }
  if (!isObject(value)) throw new Error(`${file} does not hold a JSON object`);
  return value;
}

function writeAtomic(file: string, text: string): void {
  // Through a symlink (a dotfile manager's link stays a link) and with the file's own mode.
  let target = file;
  let mode = 0o644;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  } catch {
    /* a new file */
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${randomUUID()}.galactic.tmp`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

function readState(stateFile: string): State {
  const text = readText(stateFile);
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? (value as State) : {};
  } catch {
    return {};
  }
}

function writeState(stateFile: string, state: State): void {
  if (Object.keys(state).length === 0) {
    rmSync(stateFile, { force: true });
    return;
  }
  writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

const serialize = (obj: Json) => `${JSON.stringify(obj, null, 2)}\n`;

/** Whether `entry` is Mission Control's own (tagged). */
const ours = (entry: unknown) => isObject(entry) && entry[ENTRY_TAG] === true;

interface Place {
  /** The container that holds the `galactic` key (created when absent). */
  container(obj: Json, create: boolean): Json | undefined;
  /** Drops the container when it held only Mission Control's entry and was not there before. */
  tidy?(obj: Json): void;
}

const HOOKS: Place = { container: (obj) => obj };
const MCP: Place = {
  container(obj, create) {
    const servers = obj['mcpServers'];
    if (isObject(servers)) return servers;
    if (servers !== undefined) throw new Error('mcp_config.json: mcpServers is not an object');
    if (!create) return undefined;
    const fresh: Json = {};
    obj['mcpServers'] = fresh;
    return fresh;
  },
  tidy(obj) {
    const servers = obj['mcpServers'];
    if (isObject(servers) && Object.keys(servers).length === 0) delete obj['mcpServers'];
  },
};

function install(file: string, place: Place, entry: Json, state: State): void {
  const before = readText(file);
  const obj = parse(file, before);
  const box = place.container(obj, true)!;
  const existing = box[ENTRY_KEY];
  if (existing !== undefined && !ours(existing)) {
    throw new Error(
      `${file} already has a "${ENTRY_KEY}" entry that GalacticAgents did not add: rename it so GalacticAgents can add its own`,
    );
  }
  box[ENTRY_KEY] = entry;
  const text = serialize(obj);
  const record = state[file];
  if (text === before) {
    // Already in place (a second spawn): the record of the original bytes, if any, stands.
    // Without one (the state file was lost) removal deletes only the entry.
    return;
  }
  const original =
    record && record.written === before
      ? record.original
      : existing === undefined
        ? before
        : // Our entry was there but the file changed since: the bytes before are unknown.
          (record?.original ?? null);
  writeAtomic(file, text);
  state[file] = { original, written: text };
}

function remove(file: string, place: Place, state: State): void {
  const record = state[file];
  delete state[file];
  const before = readText(file);
  if (before === null) return;
  if (record && record.written === before) {
    // Nobody touched it since Mission Control's write: back to the exact bytes it had before.
    if (record.original === null) rmSync(file, { force: true });
    else writeAtomic(file, record.original);
    return;
  }
  let obj: Json;
  try {
    obj = parse(file, before);
  } catch {
    return; // not ours to repair
  }
  const box = place.container(obj, false);
  if (!box || !ours(box[ENTRY_KEY])) return;
  delete box[ENTRY_KEY];
  place.tidy?.(obj);
  writeAtomic(file, serialize(obj));
}

/** Adds (or refreshes) Mission Control's two entries. Throws when a file cannot take them. */
export function installGlobalEntries(opts: GlobalEntriesOptions): void {
  const state = readState(opts.stateFile);
  try {
    install(
      hooksFile(opts.home),
      HOOKS,
      {
        [ENTRY_TAG]: true,
        enabled: true,
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: opts.hookCommand, timeout: opts.hookTimeoutS }],
          },
        ],
      },
      state,
    );
    install(
      mcpConfigFile(opts.home),
      MCP,
      { [ENTRY_TAG]: true, command: opts.toolCommand, args: opts.toolArgs },
      state,
    );
  } finally {
    writeState(opts.stateFile, state);
  }
}

/** Removes Mission Control's two entries and nothing else. Never throws. */
export function removeGlobalEntries(opts: Pick<GlobalEntriesOptions, 'home' | 'stateFile'>): void {
  const state = readState(opts.stateFile);
  for (const [file, place] of [
    [hooksFile(opts.home), HOOKS],
    [mcpConfigFile(opts.home), MCP],
  ] as const) {
    try {
      remove(file, place, state);
    } catch {
      /* best effort: the entries pass through when no Mission Control session runs */
    }
  }
  try {
    writeState(opts.stateFile, state);
  } catch {
    /* ignore */
  }
}

/** Whether both entries are in place (tests, preflight). */
export function globalEntriesInstalled(home: string): boolean {
  try {
    const hooks = parse(hooksFile(home), readText(hooksFile(home)));
    const mcp = parse(mcpConfigFile(home), readText(mcpConfigFile(home)));
    return ours(hooks[ENTRY_KEY]) && ours(MCP.container(mcp, false)?.[ENTRY_KEY]);
  } catch {
    return false;
  }
}

/**
 * Why the entries could not be added now (a file that is not JSON, a `galactic` key Mission
 * Control did not tag), or `undefined`. Read only: for the preflight.
 */
export function globalEntriesProblem(home: string): string | undefined {
  try {
    const hooks = parse(hooksFile(home), readText(hooksFile(home)));
    const mcp = parse(mcpConfigFile(home), readText(mcpConfigFile(home)));
    const servers = MCP.container(mcp, false);
    for (const [file, entry] of [
      [hooksFile(home), hooks[ENTRY_KEY]],
      [mcpConfigFile(home), servers?.[ENTRY_KEY]],
    ] as const) {
      if (entry !== undefined && !ours(entry)) {
        return `${file} already has a "${ENTRY_KEY}" entry that GalacticAgents did not add`;
      }
    }
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
