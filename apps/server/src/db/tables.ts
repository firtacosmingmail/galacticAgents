import type { Database, Statement } from 'better-sqlite3';
import {
  Agent,
  AgentSpend,
  Body,
  Project,
  Proposal,
  Question,
  Task,
  type BudgetTarget,
  type Id,
} from '@galactic/protocol';
import type { ZodType } from 'zod';

type Row = Record<string, unknown>;

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined =>
  typeof v === 'string' ? (JSON.parse(v) as T) : undefined;
const opt = <T>(v: unknown): T | undefined => (v === null ? undefined : (v as T));
const flag = (v: boolean | undefined): number | null => (v === undefined ? null : v ? 1 : 0);
const unflag = (v: unknown): boolean | undefined =>
  v === null || v === undefined ? undefined : v === 1;

/** Strips `undefined` values so parsed objects compare equal to their fixtures. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

interface Mapper<T extends { id: Id }> {
  table: string;
  schema: ZodType<T>;
  toRow(value: T): Row;
  fromRow(row: Row): T;
}

/**
 * A thin typed accessor for one domain table. Validates on the way in and on the way out. Its
 * statements are prepared on first use, so tables can be opened over an older schema (a
 * migration test) as long as only the columns that exist there are used.
 */
export class Table<T extends { id: Id }> {
  private readonly stmts = new Map<string, Statement>();

  constructor(
    private readonly db: Database,
    private readonly mapper: Mapper<T>,
    private readonly columns: string[],
  ) {}

  private stmt(name: 'insert' | 'upsert' | 'get' | 'all' | 'delete'): Statement {
    let s = this.stmts.get(name);
    if (!s) {
      s = this.db.prepare(this.sql(name));
      this.stmts.set(name, s);
    }
    return s;
  }

  private sql(name: 'insert' | 'upsert' | 'get' | 'all' | 'delete'): string {
    const { table } = this.mapper;
    const cols = this.columns.join(', ');
    const params = this.columns.map((c) => `@${c}`).join(', ');
    switch (name) {
      case 'insert':
        return `INSERT INTO ${table} (${cols}) VALUES (${params})`;
      case 'upsert': {
        const updates = this.columns
          .filter((c) => c !== 'id')
          .map((c) => `${c} = excluded.${c}`)
          .join(', ');
        return `INSERT INTO ${table} (${cols}) VALUES (${params}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
      }
      case 'get':
        return `SELECT * FROM ${table} WHERE id = ?`;
      case 'all':
        return `SELECT * FROM ${table} ORDER BY rowid`;
      case 'delete':
        return `DELETE FROM ${table} WHERE id = ?`;
    }
  }

  insert(value: T): T {
    const v = this.mapper.schema.parse(value);
    this.stmt('insert').run(this.mapper.toRow(v));
    return v;
  }

  upsert(value: T): T {
    const v = this.mapper.schema.parse(value);
    this.stmt('upsert').run(this.mapper.toRow(v));
    return v;
  }

  get(id: Id): T | undefined {
    const row = this.stmt('get').get(id) as Row | undefined;
    return row ? this.mapper.schema.parse(compact(this.mapper.fromRow(row))) : undefined;
  }

  all(): T[] {
    return (this.stmt('all').all() as Row[]).map((r) =>
      this.mapper.schema.parse(compact(this.mapper.fromRow(r))),
    );
  }

  delete(id: Id): boolean {
    return this.stmt('delete').run(id).changes > 0;
  }
}

const bodies: Mapper<Body> = {
  table: 'bodies',
  schema: Body,
  toRow: (b) => ({
    id: b.id,
    kind: b.kind,
    parent_id: b.parentId ?? null,
    name: b.name,
    host_kind: b.host?.kind ?? null,
    host_id: b.host?.id ?? null,
    moved_to: json(b.movedTo),
    meta: json(b.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    kind: r['kind'] as Body['kind'],
    parentId: opt<Id>(r['parent_id']),
    name: r['name'] as string,
    host: r['host_kind']
      ? { kind: r['host_kind'] as 'project' | 'task', id: r['host_id'] as Id }
      : undefined,
    movedTo: parse(r['moved_to']),
    meta: parse(r['meta']),
  }),
};

const projects: Mapper<Project> = {
  table: 'projects',
  schema: Project,
  toRow: (p) => ({
    id: p.id,
    name: p.name,
    workspace: p.workspace,
    repo_path: p.repoPath ?? null,
    parent_project_id: p.parentProjectId ?? null,
    body_id: p.bodyId,
    state: p.state,
    permission_policy: json(p.permissionPolicy),
    pinned: flag(p.pinned),
    budget_usd: p.budgetUsd ?? null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    meta: json(p.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    name: r['name'] as string,
    workspace: r['workspace'] as string,
    repoPath: opt<string>(r['repo_path']),
    parentProjectId: opt<Id>(r['parent_project_id']),
    bodyId: r['body_id'] as Id,
    state: r['state'] as Project['state'],
    permissionPolicy: parse<Project['permissionPolicy']>(r['permission_policy']),
    pinned: unflag(r['pinned']),
    budgetUsd: opt<number>(r['budget_usd']),
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    meta: parse(r['meta']),
  }),
};

const tasks: Mapper<Task> = {
  table: 'tasks',
  schema: Task,
  toRow: (t) => ({
    id: t.id,
    project_id: t.projectId ?? null,
    body_id: t.bodyId,
    description: t.description,
    priority: t.priority,
    worktree_path: t.worktreePath ?? null,
    branch: t.branch ?? null,
    blocked_by: JSON.stringify(t.blockedBy),
    state: t.state,
    pinned: flag(t.pinned),
    budget_usd: t.budgetUsd ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    meta: json(t.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    projectId: opt<Id>(r['project_id']),
    bodyId: r['body_id'] as Id,
    description: r['description'] as string,
    priority: r['priority'] as Task['priority'],
    worktreePath: opt<string>(r['worktree_path']),
    branch: opt<string>(r['branch']),
    blockedBy: parse<Id[]>(r['blocked_by']) ?? [],
    state: r['state'] as Task['state'],
    pinned: unflag(r['pinned']),
    budgetUsd: opt<number>(r['budget_usd']),
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    meta: parse(r['meta']),
  }),
};

const agents: Mapper<Agent> = {
  table: 'agents',
  schema: Agent,
  toRow: (a) => ({
    id: a.id,
    role: a.role,
    runtime: a.runtime,
    session_ref: a.sessionRef ?? null,
    supervisor_id: a.supervisorId ?? null,
    body_id: a.bodyId,
    task_id: a.taskId ?? null,
    project_id: a.projectId ?? null,
    caps: JSON.stringify(a.caps),
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    meta: json(a.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    role: r['role'] as Agent['role'],
    runtime: r['runtime'] as Agent['runtime'],
    sessionRef: opt<string>(r['session_ref']),
    supervisorId: opt<Id>(r['supervisor_id']),
    bodyId: r['body_id'] as Id,
    taskId: opt<Id>(r['task_id']),
    projectId: opt<Id>(r['project_id']),
    caps: parse<Agent['caps']>(r['caps'])!,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    meta: parse(r['meta']),
  }),
};

const proposals: Mapper<Proposal> = {
  table: 'proposals',
  schema: Proposal,
  toRow: (p) => ({
    id: p.id,
    request_text: p.requestText,
    kind: p.kind,
    proposed_body: JSON.stringify(p.proposedBody),
    workspace: p.workspace,
    rationale: p.rationale,
    state: p.state,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    meta: json(p.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    requestText: r['request_text'] as string,
    kind: r['kind'] as Proposal['kind'],
    proposedBody: parse<Proposal['proposedBody']>(r['proposed_body'])!,
    workspace: r['workspace'] as string,
    rationale: r['rationale'] as string,
    state: r['state'] as Proposal['state'],
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    meta: parse(r['meta']),
  }),
};

const questions: Mapper<Question> = {
  table: 'questions',
  schema: Question,
  toRow: (q) => ({
    id: q.id,
    kind: q.kind,
    origin_agent_id: q.originAgentId,
    holder: JSON.stringify(q.holder),
    status: q.status,
    context: JSON.stringify(q.context),
    answered_by: json(q.answeredBy),
    answer: q.answer ?? null,
    version: q.version,
    created_at: q.createdAt,
    updated_at: q.updatedAt,
    meta: json(q.meta),
  }),
  fromRow: (r) => ({
    id: r['id'] as Id,
    kind: r['kind'] as Question['kind'],
    originAgentId: r['origin_agent_id'] as Id,
    holder: parse<Question['holder']>(r['holder'])!,
    status: r['status'] as Question['status'],
    context: parse<Question['context']>(r['context'])!,
    answeredBy: parse<Question['holder']>(r['answered_by']),
    answer: opt<string>(r['answer']),
    version: r['version'] as number,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    meta: parse(r['meta']),
  }),
};

/** All domain tables of one database, ready to use. */
export interface Tables {
  bodies: Table<Body>;
  projects: Table<Project>;
  tasks: Table<Task>;
  agents: Table<Agent>;
  proposals: Table<Proposal>;
  questions: Table<Question>;
  settings: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  /** Each agent's reported cost (P8-01): the `foldSpend` projection, written with its event. */
  spend: {
    get(agentId: Id): AgentSpend | undefined;
    all(): AgentSpend[];
    put(spend: AgentSpend): void;
  };
  /** The highest budget notice logged for a target's current budget (P8-01). */
  budgetNotices: {
    get(target: BudgetTarget): { level: 'warning' | 'exceeded'; budgetUsd: number } | undefined;
    put(target: BudgetTarget, level: 'warning' | 'exceeded', budgetUsd: number): void;
    clear(target: BudgetTarget): void;
  };
}

type SpendRow = {
  agent_id: string;
  usd: number;
  reported: number;
  session: string;
  sessions: string;
};
const fromSpendRow = (r: SpendRow): AgentSpend =>
  AgentSpend.parse({
    agentId: r.agent_id,
    usd: r.usd,
    reported: r.reported === 1,
    session: r.session,
    sessions: JSON.parse(r.sessions) as unknown,
  });

export function tables(db: Database): Tables {
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  // Prepared on first use, like `Table`'s (migration 0011 adds these tables).
  const lazy = (sql: string) => {
    let s: Statement | undefined;
    return () => (s ??= db.prepare(sql));
  };
  const getSpend = lazy('SELECT * FROM agent_spend WHERE agent_id = ?');
  const allSpend = lazy('SELECT * FROM agent_spend ORDER BY rowid');
  const putSpend = lazy(
    `INSERT INTO agent_spend (agent_id, usd, reported, session, sessions)
     VALUES (@agent_id, @usd, @reported, @session, @sessions)
     ON CONFLICT(agent_id) DO UPDATE SET usd = excluded.usd, reported = excluded.reported,
       session = excluded.session, sessions = excluded.sessions`,
  );
  const getNotice = lazy(
    'SELECT level, budget_usd FROM budget_notices WHERE target_kind = ? AND target_id = ?',
  );
  const putNotice = lazy(
    `INSERT INTO budget_notices (target_kind, target_id, level, budget_usd) VALUES (?, ?, ?, ?)
     ON CONFLICT(target_kind, target_id) DO UPDATE SET level = excluded.level,
       budget_usd = excluded.budget_usd`,
  );
  const clearNotice = lazy('DELETE FROM budget_notices WHERE target_kind = ? AND target_id = ?');
  return {
    spend: {
      get: (agentId) => {
        const row = getSpend().get(agentId) as SpendRow | undefined;
        return row ? fromSpendRow(row) : undefined;
      },
      all: () => (allSpend().all() as SpendRow[]).map(fromSpendRow),
      put: (s) => {
        putSpend().run({
          agent_id: s.agentId,
          usd: s.usd,
          reported: s.reported ? 1 : 0,
          session: s.session,
          sessions: JSON.stringify(s.sessions),
        });
      },
    },
    budgetNotices: {
      get: (t) => {
        const row = getNotice().get(t.kind, t.id) as
          { level: 'warning' | 'exceeded'; budget_usd: number } | undefined;
        return row ? { level: row.level, budgetUsd: row.budget_usd } : undefined;
      },
      put: (t, level, budgetUsd) => {
        putNotice().run(t.kind, t.id, level, budgetUsd);
      },
      clear: (t) => {
        clearNotice().run(t.kind, t.id);
      },
    },
    bodies: new Table(db, bodies, [
      'id',
      'kind',
      'parent_id',
      'name',
      'host_kind',
      'host_id',
      'moved_to',
      'meta',
    ]),
    projects: new Table(db, projects, [
      'id',
      'name',
      'workspace',
      'repo_path',
      'parent_project_id',
      'body_id',
      'state',
      'permission_policy',
      'pinned',
      'budget_usd',
      'created_at',
      'updated_at',
      'meta',
    ]),
    tasks: new Table(db, tasks, [
      'id',
      'project_id',
      'body_id',
      'description',
      'priority',
      'worktree_path',
      'branch',
      'blocked_by',
      'state',
      'pinned',
      'budget_usd',
      'created_at',
      'updated_at',
      'meta',
    ]),
    agents: new Table(db, agents, [
      'id',
      'role',
      'runtime',
      'session_ref',
      'supervisor_id',
      'body_id',
      'task_id',
      'project_id',
      'caps',
      'created_at',
      'updated_at',
      'meta',
    ]),
    proposals: new Table(db, proposals, [
      'id',
      'request_text',
      'kind',
      'proposed_body',
      'workspace',
      'rationale',
      'state',
      'created_at',
      'updated_at',
      'meta',
    ]),
    questions: new Table(db, questions, [
      'id',
      'kind',
      'origin_agent_id',
      'holder',
      'status',
      'context',
      'answered_by',
      'answer',
      'version',
      'created_at',
      'updated_at',
      'meta',
    ]),
    settings: {
      get: <T>(key: string) =>
        parse<T>((getSetting.get(key) as { value: string } | undefined)?.value),
      set: (key, value) => {
        setSetting.run(key, JSON.stringify(value));
      },
    },
  };
}
