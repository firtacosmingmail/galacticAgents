import type { AgentRole, AgentState, Id } from '@galactic/protocol';
import type { ActivityArchetype } from './machine.js';

/**
 * Steward activity archetypes (P4-03; SPEC §4.1, TECHNOLOGY §2.1, §4). No three.js, no React.
 *
 * A working Steward's satellite does one of three things, chosen from what the agent is doing
 * right now — `StatusRecord.currentActivity`, which the server writes (`status-store.ts`) as:
 * - a tool call, `"<Tool>: <detail>"` or `"<Tool>"` (`describeTool`: the detail is the input's
 *   `command`, `file_path`, `pattern`, `path` or `url`, ≤ 120 characters) — the structured part;
 * - a progress summary (`agent.progress`: the adapter's or a future summariser's one-liner, e.g.
 *   "Running tests", "Editing src/index.ts");
 * - `"Permission: …"` / `"Question: …"` while it waits (then it is not `working` anyway).
 *
 * The archetypes:
 * - **gathering** — reading and searching (drones carry material from the surface up);
 * - **transporting** — producing output: an edit or a new file, a commit, a push, a PR (a shuttle
 *   runs between the Steward and its Waykeeper);
 * - **building** — running builds, tests, linters, installs, or editing many files in a row
 *   (robots on a surface, an orbital platform around a gas giant);
 * - `undefined` — nothing clear (planning, a sub-agent, a question): the satellite just orbits and
 *   scans.
 *
 * Two layers:
 * 1. `classifyActivity(text)`: pure, table-driven (`TOOL_RULES` on the tool name, then `COMMAND_RULES`
 *    on a shell command, then `TEXT_RULES` on free text); the first match wins. `deriveArchetype`
 *    applies it to a Steward's status record — the hook in `satellite-model.ts`.
 * 2. `ArchetypeHold`: per agent, over time — escalates edits to `building` once several distinct
 *    files were edited within `EDIT_WINDOW`, and holds what is shown so it never flickers: a new
 *    archetype must stay the latest for `HOLD.confirm` (and the shown one must have been on screen
 *    for `HOLD.minDwell`); falling back to none waits `HOLD.release` (a TodoWrite between two
 *    edits does not drop the shuttle). An agent that stops working drops it at once.
 *
 * The raw activity text is untouched: the panel and the hover card keep showing it (corner case
 * 32: a summary or an animation can lie, the raw last event is always next to it).
 */

export interface ActivitySignal {
  archetype: ActivityArchetype | undefined;
  /** The rule that matched (for the notes, tests and the P4-06 harness). */
  rule: string;
  /** An edit: the file it touched (the hold counts distinct files to escalate to building). */
  edited?: string | undefined;
}

interface Rule {
  name: string;
  test: RegExp;
  archetype: ActivityArchetype | undefined;
  /** The match is an edit of the file in the detail (or in the text's first path-like word). */
  edit?: boolean;
}

/**
 * Tool names (the part before `": "`), Claude Code's built-in tools first, then MCP tools by the
 * verb in their name. Tools that say nothing about the archetype (TodoWrite, Task, ExitPlanMode)
 * map to `undefined`; `Bash` falls through to `COMMAND_RULES`.
 */
export const TOOL_RULES: readonly Rule[] = [
  {
    name: 'read tool',
    test: /^(read|grep|glob|ls|notebookread|webfetch|websearch|bashoutput|search|find|view)$/i,
    archetype: 'gathering',
  },
  {
    name: 'edit tool',
    test: /^(edit|multiedit|write|notebookedit|str_replace_based_edit_tool|create|apply_patch)$/i,
    archetype: 'transporting',
    edit: true,
  },
  {
    name: 'neutral tool',
    test: /^(todowrite|todoread|task|agent|exitplanmode|killshell|killbash|slashcommand|skill)$/i,
    archetype: undefined,
  },
  {
    name: 'mcp read',
    test: /^mcp__.*(read|get|list|search|fetch|query|find|view|describe|lookup)/i,
    archetype: 'gathering',
  },
  {
    name: 'mcp write',
    test: /^mcp__.*(create|update|write|post|send|push|publish|comment|upload|save|edit|report|notify|submit)/i,
    archetype: 'transporting',
  },
];

/**
 * Shell commands (`Bash: <command>`), on each part of a compound command (`classifyCommand`); the
 * first match wins for a part. Looking around is anchored at the start of the part, so
 * `cat test/x.ts` is gathering but `cd app && pnpm test` building.
 */
export const COMMAND_RULES: readonly Rule[] = [
  {
    name: 'commit / push / PR',
    test: /\b(git\s+(commit|push|merge|tag|am|cherry-pick)|gh\s+pr\s+(create|merge)|gh\s+release)\b/i,
    archetype: 'transporting',
  },
  {
    name: 'look around',
    test: /^\s*(cd\s+\S+\s*&&\s*)?(git\s+(status|diff|log|show|blame|branch|grep|ls-files)|ls|cat|head|tail|less|grep|rg|ag|find|fd|tree|wc|file|stat|du|pwd|which|sed\s+-n|jq|curl|wget|man)\b/i,
    archetype: 'gathering',
  },
  {
    name: 'build / test / lint',
    test: /\b(test|tests|vitest|jest|mocha|pytest|tox|build|compile|tsc|typecheck|lint|eslint|prettier|format(:check)?|make|cmake|ninja|gradlew?|mvn|cargo\s+(build|test|check|clippy|run)|go\s+(build|test|vet)|swift\s+(build|test)|xcodebuild|dotnet\s+(build|test)|install|ci|bundle|webpack|vite\s+build|rollup|esbuild)\b/i,
    archetype: 'building',
  },
];

/**
 * Free text (progress summaries and any tool the tables above do not know), on whole words.
 * Order matters: "Running tests on the edited files" is building, "Reading the test output"
 * gathering, "Editing 5 files" building, "Editing src/x.ts" an edit.
 */
export const TEXT_RULES: readonly Rule[] = [
  {
    name: 'waiting',
    test: /^(permission|question)\s*:/i,
    archetype: undefined,
  },
  {
    name: 'many edits',
    test: /\b(edit(ing|ed)?|chang(ing|ed)|updat(ing|ed)|modif(ying|ied)|touch(ing|ed))\s+(\d{2,}|[3-9]|several|many|multiple|all)\s+files?\b/i,
    archetype: 'building',
  },
  {
    name: 'running builds / tests',
    test: /\b(run(ning)?\s+(the\s+)?(\w+\s+)?(tests?|builds?|lint(ers?)?|checks?|gates|ci|suite|typecheck)|testing|building|compiling|linting|type-?checking|installing|bundling|refactoring|scaffolding|migrating|implementing|constructing)\b/i,
    archetype: 'building',
  },
  {
    name: 'committing / reporting',
    test: /\b(commit(ting)?|push(ing)?|merg(e|ing)|open(ing)?\s+(a\s+)?(pr|pull request)|deliver(ing)?|report(ing)?|send(ing)?|hand(ing)?\s+(off|over)|publish(ing)?|submit(ting)?|upload(ing)?|writ(e|ing)\s+(the\s+)?(summary|report|notes|result|changelog|docs?))\b/i,
    archetype: 'transporting',
  },
  {
    name: 'editing',
    test: /\b(edit(ing)?|writ(e|ing)|creat(e|ing)|add(ing)?|fix(ing)?|patch(ing)?|updat(e|ing)|chang(e|ing)|renam(e|ing))\b/i,
    archetype: 'transporting',
    edit: true,
  },
  {
    name: 'reading / searching',
    test: /\b(read(ing)?|search(ing)?|grep(ping)?|look(ing)?\s+(at|for|into|through)|explor(e|ing)|investigat(e|ing)|inspect(ing)?|analy[sz](e|ing)|review(ing)?|scan(ning)?|fetch(ing)?|research(ing)?|study(ing)?|brows(e|ing)|survey(ing)?|gather(ing)?|collect(ing)?|understand(ing)?|check(ing)?\s+(how|what|where|the\s+code))\b/i,
    archetype: 'gathering',
  },
];

const NONE: ActivitySignal = { archetype: undefined, rule: 'none' };

/** A path-like word in free text ("Editing src/index.ts" → "src/index.ts"). */
function pathIn(text: string): string | undefined {
  return /([\w.@~-]*[/\\][\w./\\@~-]+|[\w-]+\.[a-z0-9]{1,6})\b/i.exec(text)?.[1];
}

function matchText(text: string): ActivitySignal {
  for (const rule of TEXT_RULES) {
    if (!rule.test.test(text)) continue;
    return {
      archetype: rule.archetype,
      rule: rule.name,
      ...(rule.edit ? { edited: pathIn(text) ?? text } : {}),
    };
  }
  return { archetype: undefined, rule: 'unmatched' };
}

/**
 * An MCP tool (`mcp__<server>__<tool>`) as the rules see it: `mcp__<tool>`, the segment after the
 * last `__` — the server's name says nothing about what the call does (`mcp__x__report_status` is
 * a report, `mcp__reader__create_page` a write).
 */
function mcpSubject(name: string): string {
  if (!/^mcp__/i.test(name)) return name;
  return `mcp__${name.slice(name.lastIndexOf('__') + 2)}`;
}

/** Which archetype wins in a compound command: producing output, then building, then reading. */
const COMMAND_RANK: Record<ActivityArchetype, number> = {
  transporting: 3,
  building: 2,
  gathering: 1,
};

/**
 * A shell command: each part of a compound command (`&&`, `||`, `;` — not pipes) is classified on
 * its own by `COMMAND_RULES`, and the strongest part wins: `ls src && pnpm build` is building,
 * `cd app && grep x src` gathering, `git add -A && git commit` transporting.
 */
function classifyCommand(command: string): ActivitySignal {
  let best: Rule | undefined;
  for (const part of command.split(/\s*(?:&&|\|\||;)\s*/)) {
    if (!part) continue;
    const rule = COMMAND_RULES.find((r) => r.test.test(part));
    if (!rule?.archetype) continue;
    if (!best?.archetype || COMMAND_RANK[rule.archetype] > COMMAND_RANK[best.archetype])
      best = rule;
  }
  return best
    ? { archetype: best.archetype, rule: best.name }
    : { archetype: undefined, rule: 'other command' };
}

/**
 * What an activity line says about the archetype. Structured first — a tool name before `": "`
 * (`describeTool`'s format), a shell command after `Bash: ` — then keywords in free text.
 */
export function classifyActivity(activity: string | undefined): ActivitySignal {
  const text = activity?.trim();
  if (!text) return NONE;
  const tool = /^([A-Za-z][\w.-]*)(?::\s*(.*))?$/s.exec(text);
  if (tool) {
    const name = tool[1] ?? '';
    const detail = (tool[2] ?? '').trim();
    if (/^(bash|shell|terminal|run_command|exec)$/i.test(name)) return classifyCommand(detail);
    const subject = mcpSubject(name);
    for (const rule of TOOL_RULES) {
      if (!rule.test.test(subject)) continue;
      return {
        archetype: rule.archetype,
        rule: rule.name,
        ...(rule.edit ? { edited: detail || name } : {}),
      };
    }
    // A single word that is not a tool we know ("Finished", "wrapping up") reads as text.
  }
  return matchText(text);
}

/** Only working Stewards have an archetype (Waykeepers scan; SPEC §4.1). */
export function hasArchetypes(role: AgentRole, state: AgentState): boolean {
  return role === 'steward' && state === 'working';
}

/**
 * The archetype a status record asks for right now, without history (the `satellite-model.ts`
 * hook). An edit is `transporting` here; `ArchetypeHold` escalates a run of edits to `building`.
 */
export function deriveArchetype(
  role: AgentRole,
  status: { state: AgentState; currentActivity?: string | undefined },
): ActivityArchetype | undefined {
  if (!hasArchetypes(role, status.state)) return undefined;
  return classifyActivity(status.currentActivity).archetype;
}

/** Seconds. */
export const HOLD = {
  /** A new archetype must stay the latest this long before it shows. */
  confirm: 0.4,
  /**
   * A shown archetype stays at least this long before another replaces it. With `confirm` it
   * bounds the delay: a new activity that stays steady shows within `max(confirm, minDwell)` = 1 s
   * of becoming steady, and within `confirm` once the previous one has been on screen 1 s.
   */
  minDwell: 1,
  /** No archetype (an unclear activity) must last this long before the satellite drops it. */
  release: 1.5,
} as const;

/** Distinct files edited within `EDIT_WINDOW` seconds that make it "editing many files". */
export const MANY_EDITS = 3;
export const EDIT_WINDOW = 90;

interface AgentHold {
  shown: ActivityArchetype | undefined;
  shownSince: number;
  pending: { archetype: ActivityArchetype | undefined; since: number } | undefined;
  /** The last activity seen (an edit is counted once per activity change). */
  activity: string | undefined;
  /** Recent edits: file → when. */
  edits: Map<string, number>;
}

/** The minimum a hold needs from a satellite spec. */
export interface HoldInput {
  agentId: Id;
  role: AgentRole;
  state: AgentState;
  activity: string | undefined;
  archetype: ActivityArchetype | undefined;
}

/**
 * Per-agent hysteresis over the derived archetypes (pure apart from its own memory; the clock is
 * passed in). `apply(specs, now)` returns the specs with `archetype` replaced by what should show
 * (the same objects when nothing changed); `nextDue(now)` says when a pending switch is due, so
 * the caller can re-apply then even if the world does not change.
 */
export class ArchetypeHold {
  private agents = new Map<Id, AgentHold>();

  apply<T extends HoldInput>(specs: readonly T[], now: number): T[] {
    const seen = new Set<Id>();
    const out = specs.map((spec) => {
      seen.add(spec.agentId);
      const shown = this.step(spec, now);
      return shown === spec.archetype ? spec : { ...spec, archetype: shown };
    });
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id);
    return out;
  }

  /** When the earliest pending switch becomes due (`undefined` = nothing pending). */
  nextDue(): number | undefined {
    let due: number | undefined;
    for (const hold of this.agents.values()) {
      const at = dueAt(hold);
      if (at !== undefined && (due === undefined || at < due)) due = at;
    }
    return due;
  }

  /** What an agent shows now (tests, the P4-06 harness). */
  shown(agentId: Id): ActivityArchetype | undefined {
    return this.agents.get(agentId)?.shown;
  }

  reset(): void {
    this.agents.clear();
  }

  private step(spec: HoldInput, now: number): ActivityArchetype | undefined {
    let hold = this.agents.get(spec.agentId);
    if (!hold) {
      hold = {
        shown: undefined,
        shownSince: now,
        pending: undefined,
        activity: undefined,
        edits: new Map(),
      };
      this.agents.set(spec.agentId, hold);
    }
    if (!hasArchetypes(spec.role, spec.state)) {
      // Not working: nothing to show, at once (the machine already orbits a non-working agent).
      hold.shown = undefined;
      hold.shownSince = now;
      hold.pending = undefined;
      hold.activity = spec.activity;
      return undefined;
    }
    const wanted = this.escalate(hold, spec, now);
    if (wanted === hold.shown) {
      hold.pending = undefined;
      return hold.shown;
    }
    if (!hold.pending || hold.pending.archetype !== wanted)
      hold.pending = { archetype: wanted, since: now };
    const due = dueAt(hold);
    if (due !== undefined && now >= due - 1e-9) {
      hold.shown = wanted;
      hold.shownSince = now;
      hold.pending = undefined;
    }
    return hold.shown;
  }

  /** The spec's archetype, with a run of edits to several files turned into building. */
  private escalate(hold: AgentHold, spec: HoldInput, now: number): ActivityArchetype | undefined {
    for (const [file, at] of hold.edits) if (now - at > EDIT_WINDOW) hold.edits.delete(file);
    if (spec.activity !== hold.activity) {
      hold.activity = spec.activity;
      const signal = classifyActivity(spec.activity);
      if (signal.edited !== undefined) hold.edits.set(signal.edited, now);
    }
    const editing = classifyActivity(spec.activity).edited !== undefined;
    if (editing && spec.archetype === 'transporting' && hold.edits.size >= MANY_EDITS)
      return 'building';
    return spec.archetype;
  }
}

function dueAt(hold: AgentHold): number | undefined {
  const pending = hold.pending;
  if (!pending) return undefined;
  const wait = pending.archetype === undefined ? HOLD.release : HOLD.confirm;
  const dwell = hold.shown === undefined ? 0 : hold.shownSince + HOLD.minDwell;
  return Math.max(pending.since + wait, dwell);
}
