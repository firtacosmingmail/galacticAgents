import type {
  Agent,
  Body,
  PermissionPolicy,
  Project,
  Proposal,
  Question,
  StatusRecord,
  Task,
} from '../domain.js';
import type { Deliverable, DeliverableRun } from '../deliverables.js';

export const NOW = '2026-09-30T10:00:00.000Z';

export const body: Body = { id: 'b-kepler', kind: 'planet', name: 'Kepler' };
export const moon: Body = {
  id: 'b-luna',
  kind: 'moon',
  parentId: 'b-kepler',
  name: 'Luna',
  host: { kind: 'project', id: 'p-1' },
};
export const asteroid: Body = {
  id: 'b-ast-1',
  kind: 'asteroid',
  name: 'Ceres-1',
  host: { kind: 'task', id: 't-2' },
  meta: { seed: 42 },
};

export const project: Project = {
  id: 'p-1',
  name: 'Auth refactor',
  workspace: '/home/cosmin/work/auth',
  repoPath: '/home/cosmin/work/auth',
  bodyId: 'b-luna',
  state: 'in_progress',
  createdAt: NOW,
  updatedAt: NOW,
};

export const task: Task = {
  id: 't-1',
  projectId: 'p-1',
  bodyId: 'b-luna',
  description: 'Replace the session middleware',
  priority: 'normal',
  worktreePath: '/home/cosmin/work/auth/.worktrees/t-1',
  branch: 'task/t-1-session-middleware',
  blockedBy: [],
  state: 'in_progress',
  createdAt: NOW,
  updatedAt: NOW,
};

export const asteroidTask: Task = {
  id: 't-2',
  bodyId: 'b-ast-1',
  description: 'Fix the flaky date test',
  priority: 'high',
  blockedBy: ['t-1'],
  state: 'blocked_on_user',
  createdAt: NOW,
  updatedAt: NOW,
};

export const agent: Agent = {
  id: 'a-steward-1',
  role: 'steward',
  runtime: 'claude-sdk',
  sessionRef: 'sess_123',
  supervisorId: 'a-waykeeper-1',
  bodyId: 'b-luna',
  taskId: 't-1',
  caps: { maxWallClockMs: 3_600_000, maxToolCalls: 500 },
  createdAt: NOW,
  updatedAt: NOW,
};

export const harmonizer: Agent = {
  id: 'a-harmonizer',
  role: 'harmonizer',
  runtime: 'claude-sdk',
  bodyId: 'b-earth',
  caps: { maxWallClockMs: 86_400_000, maxToolCalls: 10_000 },
  createdAt: NOW,
  updatedAt: NOW,
};

export const proposal: Proposal = {
  id: 'pr-1',
  requestText: 'Add dark mode to the settings page',
  kind: 'moon',
  proposedBody: { kind: 'moon', parentId: 'b-kepler', name: 'Dark mode' },
  workspace: '/home/cosmin/work/auth',
  rationale: 'Touches a handful of files in one repository; a moon of the auth planet.',
  state: 'pending',
  createdAt: NOW,
  updatedAt: NOW,
};

export const question: Question = {
  id: 'q-1',
  kind: 'clarification',
  originAgentId: 'a-steward-1',
  holder: { type: 'agent', id: 'a-waykeeper-1' },
  status: 'open',
  context: {
    text: 'Keep the legacy cookie name?',
    options: ['yes', 'no'],
    origin: {
      role: 'steward',
      taskId: 't-1',
      projectId: 'p-1',
      bodyId: 'b-luna',
      recent: [{ seq: 41, at: NOW, type: 'agent.tool_call', summary: 'Read' }],
    },
  },
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

export const permissionQuestion: Question = {
  id: 'q-2',
  kind: 'permission',
  originAgentId: 'a-steward-1',
  holder: { type: 'user' },
  status: 'answered',
  context: {
    text: 'Run `git push origin task/t-1`?',
    toolCall: { toolName: 'Bash', input: { command: 'git push origin task/t-1' } },
    permissionAction: 'push',
  },
  answeredBy: { type: 'user' },
  answer: 'allow',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

export const status: StatusRecord = {
  agentId: 'a-steward-1',
  state: 'working',
  currentActivity: 'Editing src/session.ts',
  startedAt: NOW,
  lastEventAt: NOW,
  progress: { done: 2, total: 5 },
  costSoFar: { usd: 0.42, inputTokens: 12_000, outputTokens: 3_000 },
  caps: { wallClockMs: { used: 120_000, limit: 3_600_000 }, toolCalls: { used: 17, limit: 500 } },
};

export const policy: PermissionPolicy = { rules: { destructive: 'deny', network: 'allow' } };

/** A Steward's screenshot in its worktree (P9-01). */
export const deliverable: Deliverable = {
  id: 'd-1',
  projectId: 'p-1',
  taskId: 't-1',
  kind: 'image',
  title: 'Login screen',
  description: 'The new login page, light theme',
  source: 'agent',
  addedBy: { type: 'agent', id: 'a-steward-1' },
  location: {
    storage: 'worktree',
    path: '/home/cosmin/work/auth/.galactic/worktrees/t-1/screenshots/login.png',
  },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  meta: { size: 48_213 },
};

/** A detected `package.json` script of the project (P9-01), with a live run. */
export const commandDeliverable: Deliverable = {
  id: 'd-2',
  projectId: 'p-1',
  kind: 'command',
  title: 'dev',
  source: 'detected',
  addedBy: { type: 'system' },
  command: { line: 'pnpm run dev', cwd: '/home/cosmin/work/auth', detectedFrom: 'package.json' },
  detectedKey: 'package.json#dev',
  version: 2,
  lastRun: { runId: 'r-1', state: 'running', startedAt: NOW, ports: [5173] },
  createdAt: NOW,
  updatedAt: NOW,
  meta: { important: 0 },
};

export const run: DeliverableRun = {
  id: 'r-1',
  deliverableId: 'd-2',
  line: 'pnpm run dev',
  cwd: '/home/cosmin/work/auth',
  state: 'running',
  startedAt: NOW,
  ports: [],
  startedBy: { type: 'user' },
};
