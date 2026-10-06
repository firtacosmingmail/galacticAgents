import { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type {
  AgentRuntime,
  PermissionDecision,
  PermissionPolicy,
  QualityTier,
  SettingName,
  Settings,
  SettingsPatch,
} from '@galactic/protocol';
import { useSettingsData } from './SettingsData.js';
import {
  CAP_FIELDS,
  capsDraft,
  changedCaps,
  DECISIONS,
  ENV_VARIABLES,
  isSpecTable,
  parseCaps,
  parseTranscriptRetention,
  POLICY_ROWS,
  policyValue,
  refusalMessage,
  RESTART_FIELDS,
  specDefault,
  transcriptRetentionDraft,
  validateProjectsRoot,
  validateRetention,
  withPolicyValue,
  type CapsDraft,
  type TranscriptRetentionDraft,
} from './settings-model.js';

/**
 * The settings editors (P25-08; SPEC §4.6, decision 51). Each section edits one setting; the
 * settings page shows them all with a Save button each, and the first-run wizard walks them one
 * step at a time — the same editor, the same validation, the same refusal messages.
 */

export interface EditorProps<D> {
  id: string;
  draft: D;
  setDraft: (draft: D) => void;
  /** Locked by an environment variable, or a save in flight. */
  disabled: boolean;
  /** The saved settings (what the draft started from). */
  settings: Settings;
  /** Sends a patch other than the draft's (the policy's reset). */
  saveWith: (patch: SettingsPatch) => Promise<boolean>;
}

export interface SectionSpec<D> {
  field: SettingName;
  title: string;
  intro: ReactNode;
  fromSettings: (settings: Settings) => D;
  /** A client-side check of the draft (the server re-checks everything). */
  validate: (draft: D) => string | undefined;
  /** The patch a draft sends; `saved` is what it started from (to send only what changed). */
  toPatch: (draft: D, saved: Settings) => SettingsPatch;
  Editor: ComponentType<EditorProps<D>>;
}

/** A section's state: the draft over the saved value, its problems, and how to save it. */
export interface SectionState<D> {
  spec: SectionSpec<D>;
  settings: Settings | undefined;
  draft: D | undefined;
  setDraft: (draft: D) => void;
  dirty: boolean;
  clientError: string | undefined;
  serverError: string | undefined;
  notice: string | undefined;
  saving: boolean;
  locked: boolean;
  /** Saved, but the running server still uses the old value (decision 51). */
  restartPending: boolean;
  /** Saves the draft if it changed; resolves to whether the section is now saved. */
  save: () => Promise<boolean>;
  saveWith: (patch: SettingsPatch) => Promise<boolean>;
}

export function useSection<D>(spec: SectionSpec<D>): SectionState<D> {
  const data = useSettingsData();
  const settings = data.response?.settings;
  const base = useMemo(
    () => (settings ? spec.fromSettings(settings) : undefined),
    [spec, settings],
  );
  const [edited, setEdited] = useState<D | undefined>();
  const [serverError, setServerError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const draft = edited ?? base;
  const dirty = edited !== undefined && JSON.stringify(edited) !== JSON.stringify(base);
  const clientError = dirty && draft !== undefined ? spec.validate(draft) : undefined;
  const locked = data.response?.envOverrides.includes(spec.field) ?? false;

  const saveWith = async (patch: SettingsPatch) => {
    setSaving(true);
    try {
      const response = await data.patch(patch);
      setEdited(undefined);
      setServerError(undefined);
      setNotice(
        response.floored
          ? 'Saved, but held to the current default: from a remote client the table can only get stricter.'
          : 'Saved.',
      );
      return true;
    } catch (error) {
      setServerError(refusalMessage(error));
      setNotice(undefined);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    spec,
    settings,
    draft,
    setDraft: (d) => {
      setEdited(d);
      setNotice(undefined);
      setServerError(undefined);
    },
    dirty,
    clientError,
    serverError,
    notice,
    saving,
    locked,
    restartPending: data.response?.restartRequired.includes(spec.field) ?? false,
    save: async () => {
      if (!dirty || draft === undefined || settings === undefined) return true;
      if (clientError) return false;
      return saveWith(spec.toPatch(draft, settings));
    },
    saveWith,
  };
}

/** A section's frame: title, notes, the editor, its messages, and the given footer. */
export function SectionFrame<D>({
  state,
  footer,
  headingLevel = 2,
}: {
  state: SectionState<D>;
  footer: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const { spec, settings, draft } = state;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const restartField = RESTART_FIELDS.includes(spec.field);
  return (
    <section className="set-section" aria-label={spec.title}>
      <div className="set-head">
        <Heading className="set-title">{spec.title}</Heading>
        {restartField && <span className="set-tag">applies at the next start</span>}
        {state.locked && <span className="set-tag set-tag-locked">read-only</span>}
      </div>
      <p className="set-intro">{spec.intro}</p>
      {state.locked && (
        <p className="set-note" role="note">
          Fixed by the environment variable {ENV_VARIABLES[spec.field] ?? 'GALACTIC_*'}. Unset it
          and restart Mission Control to edit this here.
        </p>
      )}
      {settings && draft !== undefined ? (
        <spec.Editor
          id={id}
          draft={draft}
          setDraft={state.setDraft}
          disabled={state.locked || state.saving}
          settings={settings}
          saveWith={state.saveWith}
        />
      ) : null}
      {state.clientError && (
        <p className="set-error" role="alert">
          {state.clientError}
        </p>
      )}
      {state.serverError && (
        <p className="set-error" role="alert">
          {state.serverError}
        </p>
      )}
      {state.restartPending && (
        <p className="set-restart" role="status">
          Saved — restart Mission Control to apply (stop it, then run <code>galactic start</code>{' '}
          again).
        </p>
      )}
      {state.notice && !state.restartPending && (
        <p className="set-saved" role="status">
          {state.notice}
        </p>
      )}
      {footer}
    </section>
  );
}

/** The settings page's footer: one Save per section. */
export function SaveButton<D>({ state }: { state: SectionState<D> }) {
  return (
    <div className="set-actions">
      <button
        type="button"
        onClick={() => void state.save()}
        disabled={!state.dirty || state.saving || state.locked || state.clientError !== undefined}
      >
        {state.saving ? 'Saving…' : `Save ${state.spec.title.toLowerCase()}`}
      </button>
    </div>
  );
}

// --- the editors ------------------------------------------------------------------------------

function ProjectsRootEditor({ id, draft, setDraft, disabled }: EditorProps<string>) {
  return (
    <div className="set-field">
      <label htmlFor={id}>Projects root folder</label>
      <input
        id={id}
        className="set-input set-input-wide"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        placeholder="~/GalacticProjects"
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  );
}

function PolicyEditor({
  id,
  draft,
  setDraft,
  disabled,
  settings,
  saveWith,
}: EditorProps<PermissionPolicy>) {
  const atSpec = isSpecTable(draft) && isSpecTable(settings.defaultPermissionPolicy);
  return (
    <div className="set-field">
      <table className="set-policy">
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Decision</th>
            <th scope="col">
              <span className="set-visually-hidden">Default</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {POLICY_ROWS.map((row) => {
            const value = policyValue(draft, row.key);
            const changed = value !== specDefault(row.key);
            return (
              <tr key={row.key} className={changed ? 'is-changed' : undefined}>
                <th scope="row">
                  <label htmlFor={`${id}-${row.key}`}>{row.label}</label>
                </th>
                <td>
                  <select
                    id={`${id}-${row.key}`}
                    value={value}
                    disabled={disabled}
                    onChange={(e) =>
                      setDraft(
                        withPolicyValue(draft, row.key, e.target.value as PermissionDecision),
                      )
                    }
                  >
                    {DECISIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="set-muted">{changed ? `default: ${specDefault(row.key)}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="set-actions">
        <button
          type="button"
          className="set-secondary"
          disabled={disabled || atSpec}
          onClick={() => void saveWith({ defaultPermissionPolicy: null })}
        >
          Reset to the default table
        </button>
      </div>
    </div>
  );
}

function RetentionEditor({ id, draft, setDraft, disabled }: EditorProps<string>) {
  return (
    <div className="set-field set-inline">
      <label htmlFor={id}>Keep finished work for</label>
      <input
        id={id}
        className="set-input set-input-num"
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      <span className="set-muted">days</span>
    </div>
  );
}

function TranscriptRetentionEditor({
  id,
  draft,
  setDraft,
  disabled,
}: EditorProps<TranscriptRetentionDraft>) {
  return (
    <div className="set-field">
      <div className="set-inline">
        <label htmlFor={`${id}-age`}>Remove agent output older than</label>
        <input
          id={`${id}-age`}
          className="set-input set-input-num"
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          step={1}
          placeholder="keep"
          value={draft.maxAgeDays}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, maxAgeDays: e.target.value })}
        />
        <span className="set-muted">days</span>
      </div>
      <div className="set-inline">
        <label htmlFor={`${id}-archived`}>Remove archived work’s output</label>
        <input
          id={`${id}-archived`}
          className="set-input set-input-num"
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          step={1}
          placeholder="keep"
          value={draft.archivedDays}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, archivedDays: e.target.value })}
        />
        <span className="set-muted">days after it was archived</span>
      </div>
    </div>
  );
}

function CapsEditor({ id, draft, setDraft, disabled }: EditorProps<CapsDraft>) {
  const parsed = parseCaps(draft);
  return (
    <div className="set-field set-caps">
      {CAP_FIELDS.map((f) => {
        const error = parsed.errors?.[f.key];
        return (
          <div key={f.key} className="set-cap">
            <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
            <span className="set-inline">
              <input
                id={`${id}-${f.key}`}
                className="set-input set-input-num"
                type="number"
                inputMode={f.scale === 1 ? 'numeric' : 'decimal'}
                min={f.min}
                max={f.max}
                step={f.scale === 1 ? 1 : 'any'}
                value={draft[f.key]}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <span className="set-muted">{f.unit}</span>
            </span>
            {error && <span className="set-field-error">{error}</span>}
          </div>
        );
      })}
    </div>
  );
}

const TIERS: { value: QualityTier; label: string; hint: string }[] = [
  { value: 'high', label: 'High', hint: 'full detail, for a desktop GPU' },
  { value: 'balanced', label: 'Balanced', hint: 'fewer effects, for laptops on battery' },
  { value: 'mobile', label: 'Mobile', hint: 'the lightest scene, for phones and tablets' },
];

function TierEditor({ id, draft, setDraft, disabled }: EditorProps<QualityTier>) {
  return (
    <fieldset className="set-field set-radios" disabled={disabled}>
      <legend className="set-visually-hidden">Rendering quality</legend>
      {TIERS.map((t) => (
        <label key={t.value} className="set-radio">
          <input
            type="radio"
            name={id}
            value={t.value}
            checked={draft === t.value}
            onChange={() => setDraft(t.value)}
          />
          <span>
            <strong>{t.label}</strong> <span className="set-muted">— {t.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The Steward runtime choices (P8-07); `''` = the spawning brain's own runtime. */
const STEWARD_RUNTIMES: { value: AgentRuntime | ''; label: string; hint: string }[] = [
  { value: '', label: 'Same as its brain', hint: 'the runtime of the Waykeeper or Harmonizer that starts it' },
  { value: 'claude-sdk', label: 'Claude Code', hint: 'the Claude Agent SDK' },
  { value: 'acp', label: 'ACP agent', hint: 'the agent set as acp.command (Codex, Gemini CLI, claude-agent-acp …)' },
];

function StewardRuntimeEditor({ id, draft, setDraft, disabled }: EditorProps<AgentRuntime | ''>) {
  const choices = STEWARD_RUNTIMES.some((c) => c.value === draft)
    ? STEWARD_RUNTIMES
    : [...STEWARD_RUNTIMES, { value: draft, label: draft, hint: 'set outside the panel' }];
  return (
    <fieldset className="set-field set-radios" disabled={disabled}>
      <legend className="set-visually-hidden">Steward runtime</legend>
      {choices.map((c) => (
        <label key={c.value || 'brain'} className="set-radio">
          <input
            type="radio"
            name={id}
            value={c.value}
            checked={draft === c.value}
            onChange={() => setDraft(c.value)}
          />
          <span>
            <strong>{c.label}</strong> <span className="set-muted">— {c.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function StewardSourcesEditor({ id, draft, setDraft, disabled }: EditorProps<boolean>) {
  return (
    <div className="set-field">
      <label className="set-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.checked)}
        />
        Stewards also load my own Claude Code settings (<code>~/.claude</code>: my CLAUDE.md, hooks,
        MCP servers and permissions)
      </label>
    </div>
  );
}

function BudgetWarnEditor({ id, draft, setDraft, disabled }: EditorProps<string>) {
  return (
    <div className="set-field set-inline">
      <label htmlFor={id}>Warn when a budget is</label>
      <input
        id={id}
        className="set-input set-input-num"
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      <span className="set-muted">% spent</span>
    </div>
  );
}

/** The budget warning threshold's draft (P8-01): a whole percentage from 1 to 100. */
export function validateBudgetWarn(draft: string): string | undefined {
  const n = Number(draft.trim());
  return draft.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 100
    ? undefined
    : 'A whole percentage from 1 to 100.';
}

// --- the specs --------------------------------------------------------------------------------

export const PROJECTS_ROOT: SectionSpec<string> = {
  field: 'projectsRoot',
  title: 'Projects root',
  intro:
    'Where a new project gets its folder (<root>/<project name>) when you do not name one, and the Harmonizer’s working folder. It cannot be /, your home folder itself, or Mission Control’s data folder.',
  fromSettings: (s) => s.projectsRoot,
  validate: validateProjectsRoot,
  toPatch: (d) => ({ projectsRoot: d.trim() }),
  Editor: ProjectsRootEditor,
};

export const PERMISSION_POLICY: SectionSpec<PermissionPolicy> = {
  field: 'defaultPermissionPolicy',
  title: 'Default permission policy',
  intro:
    'What a Steward may do without asking, for every project without a table of its own: allow, ask you (a permission card), or deny. A project’s own table or trust level overrides it category by category. Changes apply to the next tool call; open cards stay as they are.',
  fromSettings: (s) => s.defaultPermissionPolicy,
  validate: () => undefined,
  toPatch: (d) => ({ defaultPermissionPolicy: d }),
  Editor: PolicyEditor,
};

export const RETENTION: SectionSpec<string> = {
  field: 'retentionDays',
  title: 'Retention period',
  intro:
    'How long finished work keeps its body before it is archived. Pinned work is never archived.',
  fromSettings: (s) => String(s.retentionDays),
  validate: validateRetention,
  toPatch: (d) => ({ retentionDays: Number(d) }),
  Editor: RetentionEditor,
};

export const CAPS: SectionSpec<CapsDraft> = {
  field: 'caps',
  title: 'Caps',
  intro:
    'Hard limits that keep agents from running away. New agents get the new per-agent caps; running agents keep theirs, and lowering a cap stops nobody. The wall-clock cap stops Stewards (and agents started from the ops console) only; the Harmonizer and Waykeepers are bounded by their tool calls and the hierarchy.',
  fromSettings: (s) => capsDraft(s.caps),
  validate: (d) => (parseCaps(d).errors ? 'Fix the caps marked above.' : undefined),
  toPatch: (d, saved) => ({ caps: changedCaps(parseCaps(d, saved.caps).caps!, saved.caps) }),
  Editor: CapsEditor,
};

export const QUALITY_TIER: SectionSpec<QualityTier> = {
  field: 'qualityTier',
  title: 'Rendering quality',
  intro:
    'How detailed the solar-system scene is drawn on every device without a choice of its own (phones start at Mobile; see “Rendering quality on this device” below). A change applies at once in this browser, on other devices after a reload.',
  fromSettings: (s) => s.qualityTier,
  validate: () => undefined,
  toPatch: (d) => ({ qualityTier: d }),
  Editor: TierEditor,
};

export const STEWARD_SOURCES: SectionSpec<boolean> = {
  field: 'stewardsLoadUserSettings',
  title: 'Stewards’ settings sources',
  intro:
    'Stewards always load the repository’s own Claude Code settings. They can also load yours; the Harmonizer and Waykeepers never do.',
  fromSettings: (s) => s.stewardsLoadUserSettings,
  validate: () => undefined,
  toPatch: (d) => ({ stewardsLoadUserSettings: d }),
  Editor: StewardSourcesEditor,
};

/**
 * Transcript retention (P8-02). On the settings page only, not in the first-run wizard: the
 * defaults suit a first run, and an older server without the setting leaves it out.
 */
export const TRANSCRIPT_RETENTION: SectionSpec<TranscriptRetentionDraft> = {
  field: 'transcriptRetention',
  title: 'Transcript retention',
  intro:
    'How long agents’ output (their replies, tool calls and thinking) is kept. Removed output is gone for good; the transcript and chat say where it was removed. Messages, questions, states and the replay history are always kept, and pinned work is never touched. Leave a field empty to keep that output forever. Changed only on this Mac.',
  fromSettings: transcriptRetentionDraft,
  validate: (d) => parseTranscriptRetention(d).error,
  toPatch: (d) => ({ transcriptRetention: parseTranscriptRetention(d).value! }),
  Editor: TranscriptRetentionEditor,
};

export const BUDGETS: SectionSpec<string> = {
  field: 'budgets',
  title: 'Budgets',
  intro:
    'A project or task may get a dollar budget on its card or its edit form. Spending is the cost the runtimes report (an estimate; notional under a subscription login); work whose cost is not reported is not held to its budget. At this share of a budget you are warned in the Harmonizer’s chat; at the budget, new agents for the work are refused and running ones go on.',
  fromSettings: (s) => String(s.budgets?.warnAtPercent ?? 80),
  validate: validateBudgetWarn,
  toPatch: (d) => ({ budgets: { warnAtPercent: Number(d.trim()) } }),
  Editor: BudgetWarnEditor,
};

/**
 * The runtime of new Stewards (P8-07). After the wizard's sections: a second runtime is set up
 * later, if ever. The server refuses a runtime it has no adapter for, with the reason.
 */
export const STEWARD_RUNTIME: SectionSpec<AgentRuntime | ''> = {
  field: 'stewardRuntime',
  title: 'Steward runtime',
  intro:
    'Which agent runtime new Stewards run on. The Harmonizer and Waykeepers always stay on their own runtime; running Stewards keep theirs. An ACP agent must be set up first (acp.command in config.json).',
  fromSettings: (s) => s.stewardRuntime ?? '',
  validate: () => undefined,
  toPatch: (d) => ({ stewardRuntime: d === '' ? null : d }),
  Editor: StewardRuntimeEditor,
};

/** A section of any draft type (the list below mixes them; each is used with its own). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySectionSpec = SectionSpec<any>;

/**
 * The settings page's sections after the wizard's (P8-01): set later, when a budget is in use,
 * so they are not first-run steps.
 */
export const LATER_SECTIONS: readonly AnySectionSpec[] = [BUDGETS, STEWARD_RUNTIME];

/** Every section, in the order the page and the wizard show them. */
export const SECTIONS: readonly AnySectionSpec[] = [
  PROJECTS_ROOT,
  PERMISSION_POLICY,
  RETENTION,
  CAPS,
  QUALITY_TIER,
  STEWARD_SOURCES,
];
