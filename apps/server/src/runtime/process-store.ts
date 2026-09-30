import type { Database } from 'better-sqlite3';
import type { Id, Timestamp } from '@galactic/protocol';

/** One row of the persisted PID table (`agent_processes`, migration 0003). */
export interface ProcessRecord {
  agentId: Id;
  /** Absent when the runtime spawns its own process and never reports a pid. */
  pid?: number;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  /** `interrupted`: the server lost the process (crash, restart) rather than seeing it end. */
  status: 'running' | 'exited' | 'interrupted';
  exitCode?: number;
  signal?: string;
  meta?: Record<string, unknown>;
}

/** Where the supervisor keeps its PID table. SQLite in the server, memory in tests. */
export interface ProcessStore {
  upsert(record: ProcessRecord): void;
  get(agentId: Id): ProcessRecord | undefined;
  running(): ProcessRecord[];
  all(): ProcessRecord[];
}

export class MemoryProcessStore implements ProcessStore {
  private readonly rows = new Map<Id, ProcessRecord>();
  upsert(record: ProcessRecord): void {
    this.rows.set(record.agentId, { ...record });
  }
  get(agentId: Id): ProcessRecord | undefined {
    const r = this.rows.get(agentId);
    return r ? { ...r } : undefined;
  }
  running(): ProcessRecord[] {
    return this.all().filter((r) => r.status === 'running');
  }
  all(): ProcessRecord[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

type Row = {
  agent_id: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  status: ProcessRecord['status'];
  exit_code: number | null;
  signal: string | null;
  meta: string | null;
};

function fromRow(r: Row): ProcessRecord {
  const rec: ProcessRecord = { agentId: r.agent_id, startedAt: r.started_at, status: r.status };
  if (r.pid !== null) rec.pid = r.pid;
  if (r.ended_at !== null) rec.endedAt = r.ended_at;
  if (r.exit_code !== null) rec.exitCode = r.exit_code;
  if (r.signal !== null) rec.signal = r.signal;
  if (r.meta !== null) rec.meta = JSON.parse(r.meta) as Record<string, unknown>;
  return rec;
}

export class SqliteProcessStore implements ProcessStore {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly runningStmt;
  private readonly allStmt;

  constructor(db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_processes (agent_id, pid, started_at, ended_at, status, exit_code, signal, meta)
       VALUES (@agent_id, @pid, @started_at, @ended_at, @status, @exit_code, @signal, @meta)
       ON CONFLICT(agent_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at,
         ended_at = excluded.ended_at, status = excluded.status, exit_code = excluded.exit_code,
         signal = excluded.signal, meta = excluded.meta`,
    );
    this.getStmt = db.prepare('SELECT * FROM agent_processes WHERE agent_id = ?');
    this.runningStmt = db.prepare("SELECT * FROM agent_processes WHERE status = 'running'");
    this.allStmt = db.prepare('SELECT * FROM agent_processes ORDER BY started_at');
  }

  upsert(r: ProcessRecord): void {
    this.upsertStmt.run({
      agent_id: r.agentId,
      pid: r.pid ?? null,
      started_at: r.startedAt,
      ended_at: r.endedAt ?? null,
      status: r.status,
      exit_code: r.exitCode ?? null,
      signal: r.signal ?? null,
      meta: r.meta === undefined ? null : JSON.stringify(r.meta),
    });
  }
  get(agentId: Id): ProcessRecord | undefined {
    const row = this.getStmt.get(agentId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }
  running(): ProcessRecord[] {
    return (this.runningStmt.all() as Row[]).map(fromRow);
  }
  all(): ProcessRecord[] {
    return (this.allStmt.all() as Row[]).map(fromRow);
  }
}
