import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { AGENT_ID_ENV, type ProcEntry } from './process-attribution.js';

/**
 * The OS side of process attribution (P4-14): reading the process table, working directories and
 * listening ports, and signalling one process. macOS and Linux; injectable so tests (and other
 * platforms) can bring their own.
 *
 *   - table:  `ps -A -ww -o pid=,ppid=,pgid=,uid=,stat=,lstart=,command=` (both platforms, C locale)
 *   - cwd:    `/proc/<pid>/cwd` on Linux, `lsof -a -d cwd -Fn -p …` elsewhere
 *   - marker: `AGENT_ID_ENV` from `/proc/<pid>/environ` on Linux, `ps -E -ww -o pid=,command= -p …`
 *             elsewhere (macOS hides the environment of platform binaries: no marker)
 *   - ports:  `lsof -nP -a -iTCP -sTCP:LISTEN -Fn -p …`; on Linux without lsof, `/proc/net/tcp{,6}`
 *             listening sockets matched to `/proc/<pid>/fd` inodes
 *
 * Every read answers what it could: a process that exited in between is simply missing.
 */
export interface ProcessTable {
  /** The whole table, or `undefined` when this platform cannot be read (no `ps`). */
  list(): Promise<ProcEntry[] | undefined>;
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  /**
   * The value of `AGENT_ID_ENV` in each process's environment. A process whose environment cannot
   * be read (another user's, a macOS platform binary, gone) or that has none is missing — callers
   * treat that as "not an agent's" (fail closed). Optional: a table without it marks nothing.
   */
  markers?(procs: readonly Pick<ProcEntry, 'pid' | 'command'>[]): Promise<Map<number, string>>;
  /**
   * The values of the given variables in each process's environment (P8-11: the agent marker and
   * the launch id). Same rules as `markers`: an unreadable environment gives no entry, and a
   * variable that is missing (or appears twice with different values) is absent from the entry.
   */
  environment?(
    procs: readonly Pick<ProcEntry, 'pid' | 'command'>[],
    names: readonly string[],
  ): Promise<Map<number, Map<string, string>>>;
  ports(pids: readonly number[]): Promise<Map<number, number[]>>;
  /** Sends `sig` to one process (never a group); `false` when it is gone or not ours. */
  kill(pid: number, sig: NodeJS.Signals): boolean;
}

const C_LOCALE = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/** Runs a command; resolves its stdout even when it exits non-zero (lsof does for a gone pid). */
function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', env: C_LOCALE, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined);
        else resolve(typeof stdout === 'string' ? stdout : undefined);
      },
    );
  });
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/** `ps -o pid=,ppid=,pgid=,uid=,stat=,lstart=,command=` output → entries (unparsable lines skipped). */
export function parsePs(out: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const startedAt = Date.parse(m[6]!.replace(/\s+/g, ' '));
    if (Number.isNaN(startedAt)) continue;
    entries.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      startedAt,
      command: m[7]!.trim(),
      ...(m[5]!.startsWith('Z') ? { zombie: true } : {}),
    });
  }
  return entries;
}

/**
 * The value of `name` in an environment block: `/proc/<pid>/environ` (NUL-separated). Two
 * different values (a tampered block) are no value.
 */
export function parseEnviron(block: string, name: string): string | undefined {
  const values = new Set(
    block
      .split('\0')
      .filter((kv) => kv.startsWith(`${name}=`))
      .map((kv) => kv.slice(name.length + 1)),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * The value of `name` from macOS `ps -E -ww -o pid=,command=` output for one process: the command
 * line followed by the environment, space-separated. Only what follows the known command line
 * (from the plain table) is the environment, so an argument that looks like the variable never
 * counts; a line that does not start with that command line (it changed meanwhile, or `ps` hid
 * the environment) has no value, and neither has a block with two different values.
 */
export function parseEnvFromPs(line: string, command: string, name: string): string | undefined {
  const text = line.replace(/^\s*\d+\s+/, '');
  if (!text.startsWith(command)) return undefined;
  const env = ` ${text.slice(command.length)}`;
  const values = new Set<string>();
  const re = new RegExp(` ${name}=(\\S*)`, 'g');
  for (let m = re.exec(env); m; m = re.exec(env)) values.add(m[1]!);
  return values.size === 1 ? [...values][0] : undefined;
}

/** `lsof -F…n` output → the `n` field per `p` record (the last one wins). */
export function parseLsofNames(out: string): Map<number, string[]> {
  const names = new Map<number, string[]>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      if (!names.has(pid)) names.set(pid, []);
    } else if (line.startsWith('n') && pid !== undefined) {
      names.get(pid)!.push(line.slice(1));
    }
  }
  return names;
}

/** A listening address (`*:5173`, `127.0.0.1:4321`, `[::1]:5173`) → its port. */
export function portOf(address: string): number | undefined {
  const m = /:(\d+)$/.exec(address.trim());
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** `/proc/net/tcp{,6}` rows in state LISTEN (`0A`) → socket inode → port. */
export function parseProcNetTcp(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue;
    const port = parseInt(cols[1]!.split(':')[1] ?? '', 16);
    if (Number.isInteger(port) && port > 0) out.set(cols[9]!, port);
  }
  return out;
}

const HAS_PROC = process.platform === 'linux' && existsSync('/proc/self/cwd');

export function osProcessTable(): ProcessTable {
  let lsofMissing = false;
  const lsof = async (args: string[]) => {
    if (lsofMissing) return undefined;
    const out = await run('lsof', args);
    if (out === undefined) lsofMissing = true;
    return out;
  };
  const environment: NonNullable<ProcessTable['environment']> = async (procs, names) => {
    const out = new Map<number, Map<string, string>>();
    if (procs.length === 0 || names.length === 0 || process.platform === 'win32') return out;
    const pick = (read: (name: string) => string | undefined): Map<string, string> => {
      const vars = new Map<string, string>();
      for (const name of names) {
        const value = read(name);
        if (value !== undefined) vars.set(name, value);
      }
      return vars;
    };
    if (HAS_PROC) {
      for (const { pid } of procs) {
        try {
          const block = readFileSync(`/proc/${pid}/environ`, 'latin1');
          out.set(
            pid,
            pick((name) => parseEnviron(block, name)),
          );
        } catch {
          // gone, or not ours: no environment
        }
      }
      return out;
    }
    // macOS (and other BSDs): `ps -E` appends the environment to the command line.
    const text = await run('ps', [
      '-E',
      '-ww',
      '-o',
      'pid=,command=',
      '-p',
      procs.map((p) => p.pid).join(','),
    ]);
    const commandOf = new Map(procs.map((p) => [p.pid, p.command]));
    for (const line of (text ?? '').split('\n')) {
      const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
      const command = commandOf.get(pid);
      if (command === undefined) continue;
      const vars = pick((name) => parseEnvFromPs(line, command, name));
      // A line whose environment `ps` hid (a platform binary) carries none of the variables.
      if (vars.size > 0) out.set(pid, vars);
    }
    return out;
  };

  return {
    async list() {
      if (process.platform === 'win32') return undefined;
      const out = await run('ps', [
        '-A',
        '-ww',
        '-o',
        'pid=,ppid=,pgid=,uid=,stat=,lstart=,command=',
      ]);
      return out === undefined ? undefined : parsePs(out);
    },
    async cwds(pids) {
      const out = new Map<number, string>();
      if (pids.length === 0) return out;
      if (HAS_PROC) {
        for (const pid of pids) {
          try {
            out.set(pid, readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''));
          } catch {
            // gone, or not ours
          }
        }
        return out;
      }
      const text = await lsof(['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
      for (const [pid, names] of parseLsofNames(text ?? '')) {
        if (names[0] !== undefined) out.set(pid, names[0]);
      }
      return out;
    },
    async markers(procs) {
      const out = new Map<number, string>();
      for (const [pid, vars] of await environment(procs, [AGENT_ID_ENV])) {
        const value = vars.get(AGENT_ID_ENV);
        if (value !== undefined) out.set(pid, value);
      }
      return out;
    },
    environment,
    async ports(pids) {
      const out = new Map<number, number[]>();
      if (pids.length === 0) return out;
      const text = await lsof(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fn', '-p', pids.join(',')]);
      if (text !== undefined) {
        for (const [pid, names] of parseLsofNames(text)) {
          const ports = [...new Set(names.map(portOf).filter((p): p is number => p !== undefined))];
          if (ports.length > 0)
            out.set(
              pid,
              ports.sort((a, b) => a - b),
            );
        }
        return out;
      }
      if (!HAS_PROC) return out;
      // Linux without lsof: listening sockets by inode, then each process's descriptors.
      const listening = new Map<string, number>();
      for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          for (const [inode, port] of parseProcNetTcp(readFileSync(file, 'utf8'))) {
            listening.set(inode, port);
          }
        } catch {
          // no IPv6, say
        }
      }
      for (const pid of pids) {
        const ports = new Set<number>();
        try {
          for (const fd of readdirSync(`/proc/${pid}/fd`)) {
            try {
              const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
              const port = m ? listening.get(m[1]!) : undefined;
              if (port !== undefined) ports.add(port);
            } catch {
              // closed meanwhile
            }
          }
        } catch {
          continue;
        }
        if (ports.size > 0)
          out.set(
            pid,
            [...ports].sort((a, b) => a - b),
          );
      }
      return out;
    },
    kill(pid, sig) {
      if (pid <= 1) return false;
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
  };
}
