import { isAbsolute, resolve } from 'node:path';
import { DeliverableKind } from '@galactic/protocol';

/**
 * The "Deliverables:" block of a Steward's "Done:" report (P9-04; decision 120; TECHNOLOGY §9.3).
 * A Steward on a runtime that cannot serve the server's tools (ACP, a terminal agent) lists what
 * the user will want to open in its report, and its supervisor declares them. The format, which
 * `brains/steward-prompt.ts` asks for:
 *
 *     Deliverables:
 *     - image | screenshots/home.png | Home page screenshot
 *     - command | pnpm dev | Start the dev server
 *     - url | http://localhost:5173 | The app, while the dev server runs
 *
 * One line per deliverable: `- <kind> | <path, command or address> | <title>`, kind one of
 * `DeliverableKind`, a path absolute or relative to the Steward's working directory. The block
 * starts at a line that is "Deliverables:" (any case, Markdown emphasis or a heading allowed) and
 * ends at the first line that is not a list item (a blank line between items is allowed). Pure
 * text work: nothing is checked on disk here — the supervisor's `declare_deliverable` does that.
 */

export const REPORT_BLOCK_MAX = 20;

export interface ListedDeliverable {
  kind: DeliverableKind;
  title: string;
  /** For file, image, folder, app: absolute (resolved against the Steward's folder). */
  path?: string;
  /** For command. */
  command?: string;
  /** For url. */
  url?: string;
}

export interface ReportBlock {
  items: ListedDeliverable[];
  /** Lines that could not be read, as written (at most `REPORT_BLOCK_MAX`). */
  skipped: string[];
  /** Items past `REPORT_BLOCK_MAX`, not listed. */
  dropped: number;
}

const HEADER = /^\s*(?:#{1,6}\s*)?[*_]{0,2}\s*deliverables\s*[*_]{0,2}\s*:\s*[*_]{0,2}\s*$/i;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/** Finds and reads the block; `undefined` when the report has none. */
export function parseReportBlock(text: string, cwd?: string): ReportBlock | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start < 0) return undefined;
  const block: ReportBlock = { items: [], skipped: [], dropped: 0 };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const m = ITEM.exec(line);
    if (!m) break;
    const item = parseItem(m[1]!.trim(), cwd);
    if (!item) {
      if (block.skipped.length < REPORT_BLOCK_MAX) block.skipped.push(line.trim());
      continue;
    }
    if (block.items.length >= REPORT_BLOCK_MAX) block.dropped++;
    else block.items.push(item);
  }
  return block;
}

const unquote = (s: string) => s.trim().replace(/^`(.*)`$/, '$1').replace(/^"(.*)"$/, '$1').trim();

function parseItem(body: string, cwd: string | undefined): ListedDeliverable | undefined {
  const parts = body.split('|').map(unquote);
  if (parts.length < 3) return undefined;
  const kind = DeliverableKind.safeParse(parts[0]!.toLowerCase());
  if (!kind.success) return undefined;
  // A command line may hold a `|` itself: the title is the last part, the target the middle.
  const title = parts.at(-1)!;
  const target = unquote(body.split('|').slice(1, -1).join('|'));
  if (!title || !target || title.length > 500 || target.length > 4096) return undefined;
  switch (kind.data) {
    case 'command':
      return { kind: 'command', title, command: target };
    case 'url':
      return /^https?:\/\//i.test(target) ? { kind: 'url', title, url: target } : undefined;
    default: {
      if (target.includes('\0')) return undefined;
      const path = isAbsolute(target) ? target : cwd ? resolve(cwd, target) : undefined;
      return path ? { kind: kind.data, title, path } : undefined;
    }
  }
}

/**
 * The lines the supervisor reads under the report (`runtime/steward-reports.ts`): what to declare,
 * ready to pass to `declare_deliverable`.
 */
export function reportBlockText(block: ReportBlock, taskId: string | undefined): string {
  if (block.items.length === 0 && block.skipped.length === 0) return '';
  const lines = [
    `Deliverables it listed (its runtime cannot declare them; declare the ones the user will want with declare_deliverable${taskId ? `, taskId ${taskId}` : ''}, and leave out scratch):`,
    ...block.items.map(
      (item, i) =>
        `${i + 1}. ${JSON.stringify({ ...(taskId ? { taskId } : {}), ...item })}`,
    ),
    ...(block.dropped > 0 ? [`(${block.dropped} more not shown: ask it which matter)`] : []),
    ...(block.skipped.length > 0
      ? [`Lines that could not be read: ${block.skipped.map((s) => JSON.stringify(s)).join('; ')}`]
      : []),
  ];
  return lines.join('\n');
}
