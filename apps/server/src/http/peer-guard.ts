import { execFile } from 'node:child_process';
import type { FastifyRequest } from 'fastify';
import { AGENT_ID_ENV, RUN_ID_ENV, type ProcEntry } from '../runtime/process-attribution.js';
import { parseLsofNames, type ProcessTable } from '../runtime/process-table.js';
import { isLoopback } from './security.js';

/**
 * The agent speed bump on starting runs (P9-12 review S3; TECHNOLOGY §9.9; docs/REMOTE_ACCESS.md
 * §4). Anyone holding the bearer token can start any command through the runs routes — the
 * confirmation token is a staleness guard the same caller can mint. An agent's process that got
 * the token (it is a file and a `/health` answer away) is the likely one: so a start, a restart
 * or the preview of an edited line is refused when the TCP peer on this machine is an agent's or
 * a run's process.
 *
 * The peer is found by the connection: `lsof` names the process holding the other end (local port
 * = the request's remote port, remote port = the server's). It is an agent's or a run's when it
 * or any of its ancestors (up to the first reaper) carries `GALACTIC_AGENT_ID` or
 * `GALACTIC_RUN_ID` in its environment, or is below Mission Control itself (everything the server
 * starts is an agent, a run or a tool of its own; the panel's browser never is). The ancestors
 * count because macOS hides the environment of platform binaries (`/usr/bin/curl`): the Steward's
 * own process above it is readable.
 *
 * **Not a boundary**: a process that detaches (double fork, `setsid`, a launchd job) loses both
 * signs. When the peer cannot be identified (no `lsof`, a connection already gone, another
 * user's process) the request is **allowed and logged** — the conservative choice would refuse the
 * user's own panel whenever `lsof` is slow or missing; the real boundary is a §8 question (a
 * run-capability token held only by the panel and the desktop shell).
 */
export interface PeerVerdict {
  /** Why the request is refused (an agent's or a run's process), when it is. */
  refused?: string;
  /** The peer could not be identified (allowed; worth a log line). */
  unknown?: string;
}

export type PeerCheck = (req: Pick<FastifyRequest, 'raw'>) => Promise<PeerVerdict>;

export interface PeerGuardOptions {
  table: Pick<ProcessTable, 'list' | 'environment'>;
  /** The server's own pid (its descendants are agents, runs and its tools). */
  selfPid?: number;
  /** Runs `lsof` with these arguments (stdout, or `undefined` when it cannot run). */
  lsof?: (args: string[]) => Promise<string | undefined>;
  /** What a refusal says (default: the runs routes' words). */
  refusal?: string;
}

const REFUSAL =
  'Starting a run from an agent’s or a run’s process is refused: the user starts runs from the panel on the Mac.';

function systemLsof(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      args,
      { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined);
        else resolve(typeof stdout === 'string' ? stdout : undefined);
      },
    );
  });
}

/** The pid holding the client end of the connection `clientPort` → `serverPort`. */
export function peerPidOf(
  lsofOut: string,
  clientPort: number,
  serverPort: number,
  selfPid: number,
): number | undefined {
  for (const [pid, names] of parseLsofNames(lsofOut)) {
    if (pid === selfPid) continue;
    for (const name of names) {
      const m = /:(\d+)->.*:(\d+)$/.exec(name);
      if (m && Number(m[1]) === clientPort && Number(m[2]) === serverPort) return pid;
    }
  }
  return undefined;
}

export function agentPeerGuard(opts: PeerGuardOptions): PeerCheck {
  const selfPid = opts.selfPid ?? process.pid;
  const lsof = opts.lsof ?? systemLsof;
  const refusal = opts.refusal ?? REFUSAL;
  return async (req) => {
    const socket = req.raw.socket;
    const clientPort = socket?.remotePort;
    const serverPort = socket?.localPort;
    // Not over a loopback TCP connection (an injected test request, a remote client — which the
    // routes refuse anyway): nothing to look up.
    if (!socket || clientPort === undefined || serverPort === undefined) return {};
    if (!isLoopback(socket.remoteAddress)) return {};
    const out = await lsof(['-nP', '-a', `-iTCP:${clientPort}`, '-sTCP:ESTABLISHED', '-Fn']);
    if (out === undefined) return { unknown: 'lsof is not available' };
    const pid = peerPidOf(out, clientPort, serverPort, selfPid);
    if (pid === undefined)
      return { unknown: `no process holds the connection from :${clientPort}` };
    const procs = await opts.table.list();
    if (!procs) return { unknown: 'the process table cannot be read' };
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const chain: ProcEntry[] = [];
    for (let p = byPid.get(pid); p && p.pid > 1 && chain.length < 64; p = byPid.get(p.ppid)) {
      if (p.pid === selfPid) return { refused: refusal };
      chain.push(p);
    }
    if (chain.length === 0) return { unknown: `process ${pid} is gone` };
    if (!opts.table.environment) return { unknown: 'environments cannot be read here' };
    const env = await opts.table.environment(chain, [AGENT_ID_ENV, RUN_ID_ENV]);
    for (const vars of env.values()) {
      if (vars.has(AGENT_ID_ENV) || vars.has(RUN_ID_ENV)) return { refused: refusal };
    }
    return {};
  };
}
