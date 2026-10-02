import { useState, type FormEvent } from 'react';
import {
  PERMISSION_POLICY_PRESETS,
  TaskPriority,
  trustLevelOf,
  type ControlBody,
  type Id,
  type PermissionPolicyPreset,
  type Project,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { summaryOf } from '../../state/reduce.js';
import { agentLabel, agentsFor, ErrorLine, StatePill, useAction, useApi } from './shared.js';

/**
 * The project/task tree (P2-18): every project with its sub-projects, tasks and agents, and the
 * standalone tasks, each with its derived state (P2-15) and the panel's control actions (decision
 * 11b, P2-14: `POST /api/control`). Clicking an agent opens its chat (a Waykeeper) or its
 * read-only view (a Steward).
 */

const FINISHED: ReadonlySet<WorkState> = new Set(['completed', 'archived', 'failed', 'moved']);
const RUNNING: ReadonlySet<WorkState> = new Set([
  'approved',
  'in_progress',
  'blocked_on_user',
  'awaiting_closure',
  'interrupted',
]);

export function SummaryBar() {
  const world = useAppStore((s) => s.world);
  const summary = summaryOf(world);
  return (
    <p className="summary" aria-label="summary">
      <span>
        open questions <strong>{summary.openQuestions}</strong>
      </span>
      <span>
        waiting for you <strong>{summary.userQuestions}</strong>
      </span>
      <span>
        blocked <strong>{summary.blockedItems}</strong>
      </span>
    </p>
  );
}

export function WorkTree({ onSelectAgent }: { onSelectAgent: (agentId: Id) => void }) {
  const world = useAppStore((s) => s.world);
  const [showArchived, setShowArchived] = useState(false);
  const visible = (state: WorkState) => showArchived || state !== 'archived';
  const projects = Object.values(world.projects)
    .filter((p) => visible(p.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const top = projects.filter((p) => !p.parentProjectId || !world.projects[p.parentProjectId]);
  const standalone = Object.values(world.tasks)
    .filter((t) => !t.projectId && visible(t.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section className="work-tree" aria-label="projects and tasks">
      <h3>Projects and tasks</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        show archived
      </label>
      {top.length === 0 && standalone.length === 0 && (
        <p className="muted">No work yet — ask the Harmonizer.</p>
      )}
      <ul className="tree">
        {top.map((p) => (
          <ProjectNode
            key={p.id}
            project={p}
            projects={projects}
            visible={visible}
            onSelectAgent={onSelectAgent}
          />
        ))}
      </ul>
      {standalone.length > 0 && (
        <>
          <h4>Standalone tasks</h4>
          <ul className="tree">
            {standalone.map((t) => (
              <TaskNode key={t.id} task={t} onSelectAgent={onSelectAgent} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ProjectNode({
  project,
  projects,
  visible,
  onSelectAgent,
}: {
  project: Project;
  projects: Project[];
  visible: (state: WorkState) => boolean;
  onSelectAgent: (agentId: Id) => void;
}) {
  const world = useAppStore((s) => s.world);
  const body = world.bodies[project.bodyId];
  const tasks = Object.values(world.tasks)
    .filter((t) => t.projectId === project.id && visible(t.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const subs = projects.filter((p) => p.parentProjectId === project.id);
  return (
    <li className="node project" aria-label={`project ${project.name}`}>
      <div className="node-head">
        <StatePill state={project.state} />
        <strong>{project.name}</strong>
        <span className="muted">
          {body ? `${body.kind} ${body.name}` : project.bodyId}
          {project.pinned ? ' · pinned' : ''}
        </span>
        <span className="muted" aria-label="trust level">
          trust: {trustLevelOf(project.permissionPolicy)}
        </span>
        <code className="muted">{project.workspace}</code>
      </div>
      <AgentButtons
        agentIds={agentsFor(world, { projectId: project.id })}
        onSelect={onSelectAgent}
      />
      <Controls target={{ kind: 'project', id: project.id }} item={project} />
      {(tasks.length > 0 || subs.length > 0) && (
        <ul className="tree">
          {subs.map((p) => (
            <ProjectNode
              key={p.id}
              project={p}
              projects={projects}
              visible={visible}
              onSelectAgent={onSelectAgent}
            />
          ))}
          {tasks.map((t) => (
            <TaskNode key={t.id} task={t} onSelectAgent={onSelectAgent} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskNode({ task, onSelectAgent }: { task: Task; onSelectAgent: (agentId: Id) => void }) {
  const world = useAppStore((s) => s.world);
  const body = task.projectId ? undefined : world.bodies[task.bodyId];
  return (
    <li className="node task" aria-label={`task ${task.description}`}>
      <div className="node-head">
        <StatePill state={task.state} />
        <span>{task.description}</span>
        <span className="muted">
          {task.priority !== 'normal' ? `${task.priority} · ` : ''}
          {body ? `asteroid ${body.name}` : ''}
          {task.branch ? ` ${task.branch}` : ''}
          {task.blockedBy.length > 0 ? ` · after ${task.blockedBy.length}` : ''}
          {task.pinned ? ' · pinned' : ''}
        </span>
      </div>
      <AgentButtons agentIds={agentsFor(world, { taskId: task.id })} onSelect={onSelectAgent} />
      <Controls target={{ kind: 'task', id: task.id }} item={task} />
    </li>
  );
}

function AgentButtons({
  agentIds,
  onSelect,
}: {
  agentIds: { id: Id }[];
  onSelect: (agentId: Id) => void;
}) {
  const world = useAppStore((s) => s.world);
  if (agentIds.length === 0) return null;
  return (
    <div className="agent-buttons">
      {agentIds.map(({ id }) => (
        <button key={id} className="secondary" onClick={() => onSelect(id)}>
          <StatePill state={world.statuses[id]?.state} /> {agentLabel(world.agents[id], world)}
        </button>
      ))}
    </div>
  );
}

/**
 * The control actions of one task or project (decision 11b): what its state allows is offered,
 * the server decides (a refusal is shown under the buttons).
 */
export function Controls({
  target,
  item,
}: {
  target: ControlBody['target'] & { kind: 'task' | 'project' };
  item: Task | Project;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const act = (action: ControlBody['action']) => run(() => api.control({ target, action }));
  const finished = FINISHED.has(item.state);
  const label = target.kind === 'task' ? (item as Task).description : (item as Project).name;
  return (
    <div className="controls" aria-label={`controls of ${label}`}>
      {item.state === 'paused' ? (
        <button disabled={busy} onClick={() => act({ action: 'resume' })}>
          Resume
        </button>
      ) : (
        RUNNING.has(item.state) && (
          <button disabled={busy} onClick={() => act({ action: 'pause' })}>
            Pause
          </button>
        )
      )}
      {!finished && item.state !== 'proposed' && (
        <button disabled={busy} onClick={() => act({ action: 'stop' })}>
          Stop
        </button>
      )}
      {!finished && (
        <button disabled={busy} className="danger" onClick={() => act({ action: 'cancel' })}>
          Cancel
        </button>
      )}
      {!finished && item.state !== 'proposed' && (
        <button disabled={busy} onClick={() => act({ action: 'close' })}>
          Close
        </button>
      )}
      {(item.state === 'completed' || item.state === 'failed') && (
        <button disabled={busy} onClick={() => act({ action: 'archive' })}>
          Archive now
        </button>
      )}
      <button disabled={busy} onClick={() => act({ action: 'pin', pinned: !item.pinned })}>
        {item.pinned ? 'Unpin' : 'Pin'}
      </button>
      {(finished || item.state === 'archived') && item.state !== 'moved' && (
        <button disabled={busy} onClick={() => act({ action: 'reopen' })}>
          Reopen
        </button>
      )}
      {!finished && (
        <button disabled={busy} className="secondary" onClick={() => setEditing((e) => !e)}>
          Edit
        </button>
      )}
      {editing && (
        <EditForm
          target={target}
          item={item}
          busy={busy}
          onSave={async (changes) => {
            if (await act({ action: 'edit', changes })) setEditing(false);
          }}
        />
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export type EditChanges = Extract<ControlBody['action'], { action: 'edit' }>['changes'];

export function EditForm({
  target,
  item,
  busy,
  onSave,
}: {
  target: { kind: 'task' | 'project' };
  item: Task | Project;
  busy: boolean;
  onSave: (changes: EditChanges) => void;
}) {
  const isTask = target.kind === 'task';
  const task = item as Task;
  const project = item as Project;
  const [text, setText] = useState(isTask ? task.description : project.name);
  const [priority, setPriority] = useState(isTask ? task.priority : 'normal');
  const [policy, setPolicy] = useState<'' | 'clear' | PermissionPolicyPreset>('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const changes: EditChanges = {};
    if (isTask) {
      if (text.trim() && text.trim() !== task.description) changes.description = text.trim();
      if (priority !== task.priority) changes.priority = priority;
    } else {
      if (text.trim() && text.trim() !== project.name) changes.name = text.trim();
      if (policy === 'clear') changes.permissionPolicy = null;
      else if (policy) changes.permissionPolicy = PERMISSION_POLICY_PRESETS[policy];
    }
    onSave(changes);
  };
  return (
    <form className="edit" onSubmit={submit}>
      <label className="grow">
        {isTask ? 'description' : 'name'}
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {isTask ? (
        <label>
          priority
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Task['priority'])}
          >
            {TaskPriority.options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          trust level
          <select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
            <option value="">unchanged ({trustLevelOf(project.permissionPolicy)})</option>
            <option value="clear">global default</option>
            {(Object.keys(PERMISSION_POLICY_PRESETS) as PermissionPolicyPreset[]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={busy}>
        Save
      </button>
    </form>
  );
}
