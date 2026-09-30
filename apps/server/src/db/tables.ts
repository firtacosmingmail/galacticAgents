import type { Database, Statement } from 'better-sqlite3';
import { Agent, Body, Project, Proposal, Question, Task, type Id } from '@galactic/protocol';
import type { ZodType } from 'zod';

type Row = Record<string, unknown>;

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined =>
  typeof v === 'string' ? (JSON.parse(v) as T) : undefined;
const opt = <T>(v: unknown): T | undefined => (v === null ? undefined : (v as T));

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

/** A thin typed accessor for one domain table. Validates on the way in and on the way out. */
export class Table<T extends { id: Id }> {
  private readonly insertStmt: Statement;
  private readonly upsertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly allStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(
    db: Database,
    private readonly mapper: Mapper<T>,
    columns: string[],
  ) {
    const cols = columns.join(', ');
    const params = columns.map((c) => `@${c}`).join(', ');
    const updates = columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    this.insertStmt = db.prepare(`INSERT INTO ${mapper.table} (${cols}) VALUES (${params})`);
    this.upsertStmt = db.prepare(
      `INSERT INTO ${mapper.table} (${cols}) VALUES (${params}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
    this.getStmt = db.prepare(`SELECT * FROM ${mapper.table} WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT * FROM ${mapper.table} ORDER BY rowid`);
    this.deleteStmt = db.prepare(`DELETE FROM ${mapper.table} WHERE id = ?`);
  }

  insert(value: T): T {
    const v = this.mapper.schema.parse(value);
    this.insertStmt.run(this.mapper.toRow(v));
    return v;
  }

  upsert(value: T): T {
    const v = this.mapper.schema.parse(value);
    this.upsertStmt.run(this.mapper.toRow(v));
    return v;
  }

  get(id: Id): T | undefined {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? this.mapper.schema.parse(compact(this.mapper.fromRow(row))) : undefined;
  }

  all(): T[] {
    return (this.allStmt.all() as Row[]).map((r) =>
      this.mapper.schema.parse(compact(this.mapper.fromRow(r))),
    );
  }

  delete(id: Id): boolean {
    return this.deleteStmt.run(id).changes > 0;
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
}

export function tables(db: Database): Tables {
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  return {
    bodies: new Table(db, bodies, [
      'id',
      'kind',
      'parent_id',
      'name',
      'host_kind',
      'host_id',
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
