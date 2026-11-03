import { realpathSync } from 'node:fs';
import type { ModelInfo, ToolCall } from '@galactic/protocol';

/**
 * Codex app-server traffic in the server's vocabulary (P11-04; shapes from the P11-01 notes): the
 * three approval requests become the `ToolCall`s the permission gate judges, finished thread items
 * become transcript lines, `request_user_input` questions become clarification questions, and
 * `model/list` becomes `ModelInfo`s.
 */

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Whether two paths are one directory (Codex may report the real path: `/private/var/…`). */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** A word quoted for the shell: always in single quotes. */
const shellQuote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

/**
 * The script a Codex command runs: Codex wraps it as `/bin/zsh -lc '<script>'` (the P11-01
 * fixtures); the policy engine judges the script, not the wrapper (a `rm` inside quotes would
 * otherwise read as one word).
 */
export function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+'((?:[^']|'\\'')*)'\s*$/.exec(command.trim());
  return m ? m[1]!.replace(/'\\''/g, "'") : command;
}

/**
 * `item/commandExecution/requestApproval` → `Bash {command}`: the unwrapped script, run from its
 * `cwd` (`cd '<dir>' && …`) when that is not the session's own directory.
 */
export function commandCall(params: unknown, sessionCwd: string): ToolCall {
  const p = asRecord(params);
  const raw = str(p['command']);
  const actions = Array.isArray(p['commandActions']) ? p['commandActions'] : [];
  const fromActions = actions
    .map((a) => str(asRecord(a)['command']))
    .filter((c): c is string => c !== undefined)
    .join(' && ');
  const script = raw !== undefined ? unwrapShell(raw) : fromActions;
  const cwd = str(p['cwd']);
  const command = cwd && !sameDir(cwd, sessionCwd) ? `cd ${shellQuote(cwd)} && ${script}` : script;
  return { toolName: 'Bash', input: { command } };
}

/** One change of a `fileChange` item (`item/started`). */
export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  movePath?: string;
}

/** The changes of a `fileChange` thread item; `[]` for anything else. */
export function fileChanges(item: unknown): FileChange[] {
  const it = asRecord(item);
  if (it['type'] !== 'fileChange' || !Array.isArray(it['changes'])) return [];
  const out: FileChange[] = [];
  for (const c of it['changes']) {
    const change = asRecord(c);
    const path = str(change['path']);
    if (!path) continue;
    const kind = asRecord(change['kind']);
    const type = kind['type'] === 'add' || kind['type'] === 'delete' ? kind['type'] : 'update';
    const movePath = str(kind['move_path']);
    out.push({ path, kind: type, ...(movePath ? { movePath } : {}) });
  }
  return out;
}

/**
 * The gate's view of one file change: `Edit {file_path}` for an add or an update (a move names
 * both paths), and the `rm -- '<path>'` a deletion amounts to (destructive, as the shell's).
 */
export function fileChangeCall(change: FileChange): ToolCall {
  if (change.kind === 'delete') {
    return { toolName: 'Bash', input: { command: `rm -- ${shellQuote(change.path)}` } };
  }
  return {
    toolName: 'Edit',
    input: {
      file_path: change.path,
      ...(change.movePath ? { paths: [change.path, change.movePath] } : {}),
    },
  };
}

/**
 * The one call a question about several changes carries: `Edit` on every path (the engine judges
 * every path field, the strictest winning), or the deletion itself when it is the only change.
 */
export function fileChangesCall(changes: FileChange[]): ToolCall {
  if (changes.length === 1) return fileChangeCall(changes[0]!);
  const paths = [...new Set(changes.flatMap((c) => [c.path, ...(c.movePath ? [c.movePath] : [])]))];
  const deletes = changes.filter((c) => c.kind === 'delete').map((c) => c.path);
  return {
    toolName: 'Edit',
    input: {
      file_path: paths[0],
      paths,
      ...(deletes.length > 0 ? { deletes } : {}),
    },
  };
}

/**
 * `item/permissions/requestApproval` (the agent asks for more file-system or network access):
 * network access alone → `codex:network`, which the policy engine places in the `network`
 * category; anything else → `codex:permissions`, a name it does not know, so the table's
 * `unclassified` entry decides it.
 */
export function permissionsCall(params: unknown): ToolCall {
  const p = asRecord(params);
  const wanted = asRecord(p['permissions']);
  const network = asRecord(wanted['network'])['enabled'] === true;
  const fileSystem = wanted['fileSystem'] !== null && wanted['fileSystem'] !== undefined;
  return {
    // Network access alone is the table's `network` category; anything else stays unclassified.
    toolName: network && !fileSystem ? 'codex:network' : 'codex:permissions',
    input: {
      permissions: p['permissions'] ?? null,
      ...(str(p['reason']) ? { reason: p['reason'] } : {}),
      ...(str(p['cwd']) ? { cwd: p['cwd'] } : {}),
    },
  };
}

/** A one-line description of a call for transcript lines and question texts. */
export function describeCall(call: ToolCall): string {
  const input = asRecord(call.input);
  const detail = str(input['command']) ?? str(input['file_path']);
  return detail ? `${call.toolName}: ${truncate(detail, 200)}` : call.toolName;
}

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;

/** A transcript line. */
export interface OutputLine {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
}

/**
 * The transcript lines of a finished thread item (`item/completed`): the agent's message, its
 * reasoning summary, a command's output, the files a change touched, an MCP tool's result.
 * Message deltas are never transcript: one line per block (adapters README).
 */
export function itemOutput(item: unknown, maxToolChars: number): OutputLine[] {
  const it = asRecord(item);
  switch (it['type']) {
    case 'agentMessage': {
      const text = str(it['text']);
      return text && text.trim() ? [{ kind: 'text', text }] : [];
    }
    case 'reasoning': {
      const parts = [
        ...(Array.isArray(it['summary']) ? it['summary'] : []),
        ...(Array.isArray(it['content']) ? it['content'] : []),
      ]
        .map((p) => (typeof p === 'string' ? p : str(asRecord(p)['text'])))
        .filter((p): p is string => p !== undefined && p.trim().length > 0);
      return parts.length > 0 ? [{ kind: 'thinking', text: parts.join('\n') }] : [];
    }
    case 'commandExecution': {
      const command = unwrapShell(str(it['command']) ?? '');
      const status = str(it['status']) ?? 'completed';
      if (status === 'declined') return []; // the refusal has its own line
      const out = str(it['aggregatedOutput']);
      const exit = typeof it['exitCode'] === 'number' ? ` (exit ${it['exitCode']})` : '';
      const head = status === 'failed' ? 'tool failed' : 'tool result';
      return [
        {
          kind: 'tool',
          text: `${head} (Bash: ${truncate(command, 200)})${exit}${out ? `: ${truncate(out, maxToolChars)}` : ''}`,
        },
      ];
    }
    case 'fileChange': {
      const status = str(it['status']) ?? 'completed';
      if (status === 'declined') return [];
      const paths = fileChanges(it).map((c) => `${c.kind} ${c.path}`);
      const head = status === 'failed' ? 'tool failed' : 'tool result';
      return [{ kind: 'tool', text: `${head} (Edit): ${paths.join(', ') || 'no files'}` }];
    }
    case 'mcpToolCall': {
      const result = asRecord(it['result']);
      const content = Array.isArray(result['content']) ? result['content'] : [];
      const text = content
        .map((c) => str(asRecord(c)['text']))
        .filter((t): t is string => t !== undefined)
        .join('\n');
      const error = str(asRecord(it['error'])['message']);
      const name = `${str(it['server']) ?? 'mcp'}.${str(it['tool']) ?? 'tool'}`;
      return [
        {
          kind: 'tool',
          text: error
            ? `tool failed (${name}): ${truncate(error, maxToolChars)}`
            : `tool result (${name})${text ? `: ${truncate(text, maxToolChars)}` : ''}`,
        },
      ];
    }
    case 'webSearch':
      return [{ kind: 'text', text: `web search: ${str(it['query']) ?? ''}`.trim() }];
    default:
      return [];
  }
}

/** One `request_user_input` question. */
export interface UserQuestion {
  id: string;
  text: string;
  options?: string[];
}

/** The questions of `item/tool/requestUserInput`, worded for a question card. */
export function userQuestions(params: unknown): UserQuestion[] {
  const p = asRecord(params);
  const qs = Array.isArray(p['questions']) ? p['questions'] : [];
  const out: UserQuestion[] = [];
  for (const raw of qs) {
    const q = asRecord(raw);
    const id = str(q['id']);
    const question = str(q['question']) ?? str(q['header']);
    if (!id || !question) continue;
    const header = str(q['header']);
    const options = (Array.isArray(q['options']) ? q['options'] : [])
      .map((o) => str(asRecord(o)['label']))
      .filter((o): o is string => o !== undefined);
    out.push({
      id,
      text: header && header !== question ? `${header}: ${question}` : question,
      ...(options.length > 0 ? { options } : {}),
    });
  }
  return out;
}

/** `model/list` → the models a Steward may run: visible ones, text only (P11-04). */
export function modelInfos(result: unknown): ModelInfo[] {
  const data = asRecord(result)['data'];
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const raw of data) {
    const m = asRecord(raw);
    const id = str(m['model']) ?? str(m['id']);
    if (!id || m['hidden'] === true) continue;
    out.push({
      id,
      label: str(m['displayName']) ?? id,
      isDefault: m['isDefault'] === true,
      capabilities: ['text'],
      family: 'gpt',
    });
  }
  return out;
}

/** `turn/plan/updated` → the `agent.progress` of the step under way. */
export function planProgress(params: unknown): {
  summary: string;
  progress: { done: number; total: number; items: { label: string; done: boolean }[] };
} {
  const steps = (
    Array.isArray(asRecord(params)['plan']) ? (asRecord(params)['plan'] as unknown[]) : []
  )
    .map((s) => asRecord(s))
    .map((s) => ({ label: str(s['step']) ?? 'step', status: str(s['status']) ?? 'pending' }));
  const done = steps.filter((s) => s.status === 'completed').length;
  const current = steps.find((s) => s.status === 'inProgress' || s.status === 'in_progress');
  return {
    summary: current
      ? `${current.label} (${done}/${steps.length})`
      : `plan: ${done}/${steps.length} done`,
    progress: {
      done,
      total: steps.length,
      items: steps.map((s) => ({ label: s.label, done: s.status === 'completed' })),
    },
  };
}
