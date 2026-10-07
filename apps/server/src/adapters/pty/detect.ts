/**
 * What a terminal agent's screen says it waits for (P8-08; TECHNOLOGY §3.3): best effort, from
 * the line the cursor sits on once the output went quiet. A CLI waiting for input leaves its
 * prompt there without a newline.
 *
 * **Fail closed** (decision 112): every question a terminal agent asks is a **permission** —
 * only the user answers it, never a brain and never the table (it carries no tool call) — unless
 * one of the owner's `pty.clarificationPatterns` matched it. GalacticAgents cannot tell what a
 * free-form question leads to, so it does not let a supervisor answer one on a guess.
 *
 * - **idle** — the CLI's own input prompt (`pty.idlePattern`): the turn is over, it waits for
 *   the next message.
 * - **permission, yes/no** — a confirmation (`[y/N]`, `(yes/no)`, aider's `(Y)es/(N)o [Yes]:`,
 *   `yes/no [no]:`, "Continue?", "Delete …?", or a configured `pty.questionPatterns` shape):
 *   "allow" types the prompt's yes token, anything else its no token.
 * - **permission, free-form** — any other question (a line ending in `?`): "allow" presses Enter
 *   (the CLI's default), anything else interrupts the turn (Ctrl-C). A worded answer is typed from
 *   the Mac's terminal input, or the prompt's shape goes into `pty.clarificationPatterns`.
 * - **clarification** — a line a configured `pty.clarificationPatterns` matched (and that is not a
 *   yes/no confirmation, which stays a permission): its supervisor may answer it; the answer is
 *   typed.
 */

import { TERMINAL_CONTROL_CHARS } from '@galactic/protocol';

export type QuestionKindDetected = 'permission' | 'clarification';

/** A configured permission shape (`pty.questionPatterns` in config.json). */
export interface QuestionPatternConfig {
  /** A JavaScript regular expression, matched against the prompt line. */
  pattern: string;
  /** Regular expression flags (default `i`). */
  flags?: string;
  /** Only `permission`: a shape a supervisor may answer goes in `pty.clarificationPatterns`. */
  kind?: 'permission';
  /** What is typed for "allow" / "refuse" (default: the prompt's own tokens, else `y` / `n`). */
  yes?: string;
  no?: string;
}

export interface QuestionPattern {
  re: RegExp;
  yes?: string;
  no?: string;
}

export type Detection =
  | { kind: 'idle' }
  /** `freeform`: no yes/no tokens — allow presses Enter, refuse interrupts. */
  | { kind: 'permission'; line: string; yes: string; no: string; freeform: boolean }
  | { kind: 'clarification'; line: string };

/** `[y/N]`, `(Y/n)`, `[yes/no]`, `(y/n):` at the end of the line. */
const YES_NO_BRACKETS = /[[(]\s*(y|yes)\s*\/\s*(n|no)\s*[\])]\s*[:?>]?\s*$/i;

/** aider's `(Y)es/(N)o [Yes]:` (also `(Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]:`). */
const AIDER_YES_NO = /\(Y\)es\s*\/\s*\(N\)o.*\[(Yes|No)\]\s*:?\s*$/i;

/** A spelled-out pair with a default in brackets: `yes/no [no]:`, `[Yes]/[No]`. */
const YES_NO_DEFAULT = /(\byes\s*\/\s*no\b.*\[(yes|no|y|n)\]|\[yes\]\s*\/\s*\[no\])\s*[:?>]?\s*$/i;

/** A question asking leave to act: "Continue?", "Are you sure …?", "Delete …?", "Allow …?" … */
const CONFIRMATION =
  /\b(continue|proceed|are you sure|do you want to|would you like to|shall i|should i|allow|approve|accept|overwrite|replace|delete|remove|discard|reset|install|run|execute|apply|commit|push|confirm|ok to)\b[^?]*\?\s*[:>]?\s*$/i;

/** Any other question: the line ends in a question mark. */
const QUESTION = /\?\s*[:>]?\s*$/;

/** The built-in yes/no shapes, tried after the configured ones. */
const YES_NO_SHAPES: readonly RegExp[] = [
  AIDER_YES_NO,
  YES_NO_DEFAULT,
  YES_NO_BRACKETS,
  CONFIRMATION,
];

/** Compiles the configured permission shapes; throws with the offending pattern. */
export function compilePatterns(configs: readonly QuestionPatternConfig[] = []): QuestionPattern[] {
  return configs.map((c) => ({
    re: compileOne(c.pattern, c.flags, 'pty.questionPatterns'),
    ...(c.yes !== undefined ? { yes: c.yes } : {}),
    ...(c.no !== undefined ? { no: c.no } : {}),
  }));
}

/** Compiles `pty.clarificationPatterns` (flag `i`); throws with the offending pattern. */
export function compileClarifications(patterns: readonly string[] = []): RegExp[] {
  return patterns.map((p) => compileOne(p, 'i', 'pty.clarificationPatterns'));
}

function compileOne(pattern: string, flags: string | undefined, where: string): RegExp {
  try {
    return new RegExp(pattern, flags ?? 'i');
  } catch (error) {
    throw new Error(
      `${where}: "${pattern}" is not a regular expression (${(error as Error).message})`,
      { cause: error },
    );
  }
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

/** A yes/no prompt's tokens: `yes`/`no` when it spells them out (not aider's), else `y`/`n`. */
function tokensOf(line: string): { yes: string; no: string } {
  if (AIDER_YES_NO.test(line)) return { yes: 'y', no: 'n' };
  const m = YES_NO_BRACKETS.exec(line);
  if (m) {
    return /^yes$/i.test(m[1]!) && /^no$/i.test(m[2]!)
      ? { yes: 'yes', no: 'no' }
      : { yes: 'y', no: 'n' };
  }
  if (YES_NO_DEFAULT.test(line)) return { yes: 'yes', no: 'no' };
  return { yes: 'y', no: 'n' };
}

/** Whether the line is a yes/no confirmation (one of the built-in shapes). */
export function isConfirmation(line: string): boolean {
  return YES_NO_SHAPES.some((re) => re.test(line));
}

/**
 * What the prompt line says: idle first (the CLI's own prompt); a configured clarification
 * (unless the line is a yes/no confirmation); the configured permission shapes; the built-in
 * yes/no shapes; any other question is a free-form permission. `undefined` when it is none of
 * them (the CLI is busy, or its prompt is not recognised: the status store's silence threshold
 * then reports it stalled).
 */
export function detect(
  line: string,
  opts: {
    idle?: RegExp | undefined;
    patterns?: readonly QuestionPattern[];
    clarifications?: readonly RegExp[];
  },
): Detection | undefined {
  if (opts.idle?.test(line)) return { kind: 'idle' };
  const text = line.trim();
  if (!text) return undefined;
  const confirmation = isConfirmation(line);
  if (!confirmation && (opts.clarifications ?? []).some((re) => re.test(line))) {
    return { kind: 'clarification', line: text };
  }
  const tokens = tokensOf(line);
  for (const p of opts.patterns ?? []) {
    if (!p.re.test(line)) continue;
    return {
      kind: 'permission',
      line: text,
      yes: p.yes ?? tokens.yes,
      no: p.no ?? tokens.no,
      freeform: false,
    };
  }
  if (confirmation) return { kind: 'permission', line: text, ...tokens, freeform: false };
  if (QUESTION.test(line)) {
    return { kind: 'permission', line: text, yes: '', no: '', freeform: true };
  }
  return undefined;
}

/** An answer that allows a permission (the cards' "allow", or a typed yes). */
export const ALLOW = /^(allow|allowed|yes|y|ok|approve|approved)$/i;

/** Every control character a typed line may not carry (C0 but TAB, DEL, C1), all of them. */
const CONTROL_ALL = new RegExp(TERMINAL_CONTROL_CHARS.source, 'g');

/**
 * Text typed as one line: newlines (they would submit early) become spaces, then every other
 * control character — Ctrl-C, Ctrl-U, ESC (an escape sequence is left as harmless text), DEL,
 * C1 — is dropped, so nothing typed can act as a keystroke. TAB stays.
 */
export function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').replace(CONTROL_ALL, '');
}
