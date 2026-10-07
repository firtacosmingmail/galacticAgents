import { describe, expect, it } from 'vitest';
import { REPORT_BLOCK_MAX, parseReportBlock, reportBlockText } from './report-block.js';

/** P9-04 — the "Deliverables:" block a Steward without the tool writes in its "Done:" report. */

const CWD = '/w/app/.galactic/worktrees/t-1';

describe('parseReportBlock', () => {
  it('reads one deliverable per line, resolving paths against the working directory', () => {
    const report = [
      'Done: the page is built and tested.',
      '',
      'Deliverables:',
      '- image | screenshots/home.png | Home page screenshot',
      '- file | /w/app/.galactic/worktrees/t-1/REPORT.md | Test report',
      '- folder | `dist` | The built site',
      '- command | pnpm dev --port 5173 | Dev server',
      '- url | http://localhost:5173 | The app while the dev server runs',
      '',
      'Anything left: nothing.',
    ].join('\n');
    expect(parseReportBlock(report, CWD)).toEqual({
      items: [
        { kind: 'image', title: 'Home page screenshot', path: `${CWD}/screenshots/home.png` },
        { kind: 'file', title: 'Test report', path: `${CWD}/REPORT.md` },
        { kind: 'folder', title: 'The built site', path: `${CWD}/dist` },
        { kind: 'command', title: 'Dev server', command: 'pnpm dev --port 5173' },
        { kind: 'url', title: 'The app while the dev server runs', url: 'http://localhost:5173' },
      ],
      skipped: [],
      dropped: 0,
    });
  });

  it('accepts Markdown headings, emphasis, numbered items and a pipe inside a command', () => {
    const block = parseReportBlock(
      [
        'Done: ok',
        '**Deliverables:**',
        '1. command | cat log.txt | grep ERROR | Errors',
        '2) APP | Build/My.app | The app',
      ].join('\n'),
      CWD,
    );
    expect(block?.items).toEqual([
      { kind: 'command', title: 'Errors', command: 'cat log.txt | grep ERROR' },
      { kind: 'app', title: 'The app', path: `${CWD}/Build/My.app` },
    ]);
    expect(
      parseReportBlock('Done: ok\n## Deliverables:\n- url | https://x.dev | X', CWD)?.items,
    ).toHaveLength(1);
  });

  it('skips lines it cannot read and stops at the first non-item line', () => {
    const block = parseReportBlock(
      [
        'Deliverables:',
        '- a screenshot of the page',
        '- thing | x | y',
        '- url | ftp://x | not http',
        '- file | notes.txt | Notes',
        'That is all.',
        '- file | after.txt | Not in the block',
      ].join('\n'),
      CWD,
    );
    expect(block?.items).toEqual([{ kind: 'file', title: 'Notes', path: `${CWD}/notes.txt` }]);
    expect(block?.skipped).toEqual([
      '- a screenshot of the page',
      '- thing | x | y',
      '- url | ftp://x | not http',
    ]);
  });

  it('needs a working directory for relative paths, has no block without the header, and caps the list', () => {
    expect(parseReportBlock('Deliverables:\n- file | a.txt | A')?.items).toEqual([]);
    expect(parseReportBlock('Done: no deliverables here')).toBeUndefined();
    const many = [
      'Deliverables:',
      ...Array.from({ length: 25 }, (_, i) => `- url | https://x.dev/${i} | ${i}`),
    ];
    const block = parseReportBlock(many.join('\n'), CWD)!;
    expect(block.items).toHaveLength(REPORT_BLOCK_MAX);
    expect(block.dropped).toBe(5);
  });

  it('renders ready declare_deliverable inputs for the supervisor', () => {
    const block = parseReportBlock('Deliverables:\n- image | shot.png | Shot\n- nope', CWD)!;
    const text = reportBlockText(block, 't-1');
    expect(text).toContain('declare_deliverable, taskId t-1');
    expect(text).toContain(
      `1. ${JSON.stringify({ taskId: 't-1', kind: 'image', title: 'Shot', path: `${CWD}/shot.png` })}`,
    );
    expect(text).toContain('Lines that could not be read: "- nope"');
    expect(reportBlockText({ items: [], skipped: [], dropped: 0 }, 't-1')).toBe('');
  });
});
