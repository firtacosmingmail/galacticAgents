/**
 * What a terminal agent's screen says it waits for (P8-08; TECHNOLOGY §3.3): best effort, from
 * the line the cursor sits on once the output went quiet. A CLI waiting for input leaves its
 * prompt there without a newline.
 *
 * - **idle** — the CLI's own input prompt (`pty.idlePattern`): the turn is over, it waits for
 *   the next message.
 * - **permission** — a yes/no confirmation (`[y/N]`, `(yes/no)`, "Continue?", "Delete …?", …):
 *   the CLI asks before doing something, and GalacticAgents cannot see what. Always a
 *   permission-kind question, so no brain ever answers it, and it carries no tool call, so the
 *   permission table cannot judge it either: the user decides (decision 112). A pattern
 *   configured as `clarification` that matches a yes/no confirmation is still a permission.
 * - **clarification** — any other question (a line ending in `?`, or a configured pattern); the
 *   answer is typed into the terminal.
 */

export type QuestionKindDetected = 'permission' | 'clarification';

/** A configured question pattern (`pty.questionPatterns` in config.json). */
export interface QuestionPatternConfig {
  /** A JavaScript regular expression, matched against the prompt line. */
  pattern: string;
  /** Regular expression flags (default `i`). */
  flags?: string;
  kind: QuestionKindDetected;
  /** What is typed for "allow" / "refuse" on a permission (default `y` / `n`). */
  yes?: string;
  no?: string;
}

export interface QuestionPattern {
  re: RegExp;
  kind: QuestionKindDetected;
  yes?: string;
  no?: string;
}

export type Detection =
  | { kind: 'idle' }
  | { kind: 'permission'; line: string; yes: string; no: string }
  | { kind: 'clarification'; line: string };

/** `[y/N]`, `(Y/n)`, `[yes/no]`, `(y/n):` at the end of the line. */
const YES_NO_BRACKETS = /[[(]\s*(y|yes)\s*\/\s*(n|no)\s*[\])]\s*[:?>]?\s*$/i;

/** A question asking leave to act: "Continue?", "Are you sure …?", "Delete …?", "Allow …?" … */
const CONFIRMATION =
  /\b(continue|proceed|are you sure|do you want to|would you like to|shall i|should i|allow|approve|accept|overwrite|replace|delete|remove|discard|reset|install|run|execute|apply|commit|push|confirm|ok to)\b[^?]*\?\s*[:>]?\s*$/i;

/** Any other question: the line ends in a question mark. */
const QUESTION = /\?\s*[:>]?\s*$/;

/** The built-in patterns, after the configured ones. */
export const DEFAULT_QUESTION_PATTERNS: readonly QuestionPattern[] = [
  { re: YES_NO_BRACKETS, kind: 'permission' },
  { re: CONFIRMATION, kind: 'permission' },
  { re: QUESTION, kind: 'clarification' },
];

/** Compiles the configured patterns; throws with the offending pattern when one does not parse. */
export function compilePatterns(configs: readonly QuestionPatternConfig[] = []): QuestionPattern[] {
  return configs.map((c) => {
    let re: RegExp;
    try {
      re = new RegExp(c.pattern, c.flags ?? 'i');
    } catch (error) {
      throw new Error(
        `pty.questionPatterns: "${c.pattern}" is not a regular expression (${(error as Error).message})`,
        { cause: error },
      );
    }
    return {
      re,
      kind: c.kind,
      ...(c.yes !== undefined ? { yes: c.yes } : {}),
      ...(c.no !== undefined ? { no: c.no } : {}),
    };
  });
}

/** Compiles `pty.idlePattern`; throws when it does not parse. */
export function compileIdle(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `pty.idlePattern: "${pattern}" is not a regular expression (${(error as Error).message})`,
      { cause: error },
    );
  }
}

/** `y`/`n`, or `yes`/`no` when the prompt spells them out. */
function tokensOf(line: string): { yes: string; no: string } {
  const m = YES_NO_BRACKETS.exec(line);
  if (m && /^yes$/i.test(m[1]!) && /^no$/i.test(m[2]!)) return { yes: 'yes', no: 'no' };
  return { yes: 'y', no: 'n' };
}

/** Whether the line is a yes/no confirmation, whatever a configured pattern called it. */
export function isConfirmation(line: string): boolean {
  return YES_NO_BRACKETS.test(line) || CONFIRMATION.test(line);
}

/**
 * What the prompt line says: idle first (the CLI's own prompt), then the configured question
 * patterns, then the built-in ones; `undefined` when it is none of them (the CLI is busy, or its
 * prompt is not recognised: the status store's silence threshold then reports it stalled).
 */
export function detect(
  line: string,
  opts: { idle?: RegExp | undefined; patterns?: readonly QuestionPattern[] },
): Detection | undefined {
  if (opts.idle?.test(line)) return { kind: 'idle' };
  const text = line.trim();
  if (!text) return undefined;
  for (const p of [...(opts.patterns ?? []), ...DEFAULT_QUESTION_PATTERNS]) {
    if (!p.re.test(line)) continue;
    if (p.kind === 'permission' || isConfirmation(line)) {
      const tokens = tokensOf(line);
      return {
        kind: 'permission',
        line: text,
        yes: p.kind === 'permission' && p.yes !== undefined ? p.yes : tokens.yes,
        no: p.kind === 'permission' && p.no !== undefined ? p.no : tokens.no,
      };
    }
    return { kind: 'clarification', line: text };
  }
  return undefined;
}

/** An answer that allows a permission (the cards' "allow", or a typed yes). */
export const ALLOW = /^(allow|allowed|yes|y|ok|approve|approved)$/i;

/** Text typed as one line: newlines would submit early, so they become spaces. */
export function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}
