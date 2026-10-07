import { appendFileSync } from 'node:fs';

/**
 * A debug trace of the ACP JSON-RPC traffic (P8-07), off unless `GALACTIC_ACP_TRACE` is set:
 * `1` (or `true`) writes to stderr, anything else is a file the lines are appended to. Each line
 * is `<iso time> <agent id> <direction> <message>` (`->` to the agent, `<-` from it, `stderr` its
 * standard error), with the values of
 * anything that looks like a credential (`token`, `key`, `secret`, `password`, `authorization`,
 * `cookie`) replaced by `[redacted]`. For diagnosing a real agent, never on in production.
 */
export type AcpTrace = (agentId: string, direction: '->' | '<-' | 'stderr', line: string) => void;

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|^key$/i;

/** A JSON-RPC line with every credential-looking value redacted (a non-JSON line is kept whole). */
export function redactLine(line: string): string {
  try {
    return JSON.stringify(JSON.parse(line), (k, v: unknown) =>
      k && SECRET_KEY.test(k) && v !== null && typeof v !== 'object' ? '[redacted]' : v,
    );
  } catch {
    return line.replace(/(sk-ant-[\w-]{4})[\w-]+/g, '$1[redacted]');
  }
}

/** The trace the environment asks for, or `undefined` when tracing is off. */
export function traceFromEnv(value = process.env['GALACTIC_ACP_TRACE']): AcpTrace | undefined {
  const v = value?.trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return undefined;
  const toStderr = v === '1' || v.toLowerCase() === 'true';
  // Chunks split lines anywhere: a line is written once it is whole.
  const partial = new Map<string, string>();
  return (agentId, direction, chunk) => {
    const key = `${agentId} ${direction}`;
    const lines = ((partial.get(key) ?? '') + chunk).split('\n');
    partial.set(key, lines.pop()!);
    for (const line of lines) {
      if (!line.trim()) continue;
      const out = `${new Date().toISOString()} ${key} ${redactLine(line)}\n`;
      try {
        if (toStderr) process.stderr.write(out);
        else appendFileSync(v, out);
      } catch {
        // a trace never breaks a session
      }
    }
  };
}
