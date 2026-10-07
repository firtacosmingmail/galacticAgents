import { z } from 'zod';

/**
 * Slash commands (P8-13; TECHNOLOGY §3): what an agent's runtime says can be typed as `/name` at
 * the start of a message — the Claude SDK's `supportedCommands()` (built-in commands, skills,
 * plugin and project commands), ACP's `available_commands_update`. Runtime state, not a domain
 * event: the server reads it from the live session (`GET /api/agents/:id/commands`) and never
 * logs it.
 *
 * Names, descriptions and hints are text the agent's runtime (and whoever wrote a skill or a
 * plugin) chose: clients render them as plain text only, never as markup or links.
 */

/** Longest name, description and hint kept; longer text is cut (with `…`). */
export const SLASH_NAME_MAX = 100;
export const SLASH_DESCRIPTION_MAX = 300;
export const SLASH_HINT_MAX = 100;
/** Most commands kept per session (a runtime with more is cut, in its own order). */
export const SLASH_COMMANDS_MAX = 500;

/** A name is one word without whitespace, control characters or `/`. */
const NAME = /^[^\s/\p{Cc}]+$/u;

export const SlashCommand = z.object({
  /** Without the leading slash: `review`, `plugin:command`. */
  name: z.string().min(1).max(SLASH_NAME_MAX).regex(NAME),
  description: z.string().max(SLASH_DESCRIPTION_MAX).optional(),
  /** What the command takes after its name, e.g. `<file>`. */
  argumentHint: z.string().max(SLASH_HINT_MAX).optional(),
  /**
   * The runtime's own command (Claude Code's `/compact`, `/context`…), as opposed to a skill, a
   * plugin's or the project's. Absent when the runtime does not say.
   */
  builtin: z.boolean().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

/**
 * `GET /api/agents/:id/commands`: the slash commands the agent's live session offers, in the
 * runtime's order. Empty for an agent without a live session or whose runtime has none (a
 * terminal agent), and while the runtime has not said yet.
 */
export const AgentCommandsResponse = z.object({ commands: z.array(SlashCommand) });
export type AgentCommandsResponse = z.infer<typeof AgentCommandsResponse>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** One line of display text: control characters (newlines too) become spaces; cut to `max`. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The commands a runtime reported, made safe to show and to match: names lose a leading `/`,
 * names that are not one word are dropped, text is one line and bounded, a name appears once
 * (the runtime's own row wins, as `/name` runs that one), at most `SLASH_COMMANDS_MAX`. Accepts
 * anything: an entry that is not an object with a string `name` is skipped.
 */
export function normalizeSlashCommands(raw: readonly unknown[] | undefined): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  for (const entry of raw ?? []) {
    if (out.size >= SLASH_COMMANDS_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r['name'] !== 'string') continue;
    const name = r['name'].trim().replace(/^\/+/, '');
    if (!name || name.length > SLASH_NAME_MAX || !NAME.test(name)) continue;
    const description = line(r['description'], SLASH_DESCRIPTION_MAX);
    const argumentHint = line(r['argumentHint'], SLASH_HINT_MAX);
    const command: SlashCommand = {
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...(typeof r['builtin'] === 'boolean' ? { builtin: r['builtin'] } : {}),
    };
    const seen = out.get(name);
    if (!seen || (command.builtin && !seen.builtin)) out.set(name, command);
  }
  return [...out.values()];
}

/**
 * The slash command a message starts with: `/name` as its first word (followed by a space, a
 * new line or the end), or `undefined`. `/tmp/x` and `//` are not commands.
 */
export function leadingSlashCommand(text: string): string | undefined {
  return /^\/([^\s/\p{Cc}]+)(?:\s|$)/u.exec(text)?.[1];
}
