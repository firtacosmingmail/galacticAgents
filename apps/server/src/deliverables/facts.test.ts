import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileFacts,
  isAppName,
  PREVIEW_IMAGE_BYTES,
  PREVIEW_TEXT_BYTES,
  SNIFF_BYTES,
  sniffText,
} from './facts.js';
import { deliverableRoots, type DeliverableRoots } from './paths.js';

let tmp: string;
let ws: string;
let roots: DeliverableRoots;

function put(rel: string, content: string | Uint8Array = 'hello\n', mode?: number): string {
  const path = join(ws, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-facts-')));
  ws = join(tmp, 'proj');
  mkdirSync(ws);
  roots = deliverableRoots({ workspace: ws }, { dataDir: join(tmp, 'data'), home: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sniffText', () => {
  it('tells text from binary', () => {
    expect(sniffText(new TextEncoder().encode('plain ✓ text'), true)).toBe('text');
    expect(sniffText(new Uint8Array([0x61, 0x00, 0x62]), true)).toBe('binary');
    expect(sniffText(new Uint8Array([0xff, 0xfe, 0x41]), true)).toBe('binary');
    expect(sniffText(new Uint8Array(), true)).toBe('text');
  });

  it('does not count a character cut at the end of an incomplete head', () => {
    const cut = new TextEncoder().encode('ab✓').subarray(0, 4); // 'a', 'b', half of ✓
    expect(sniffText(cut, false)).toBe('text');
    expect(sniffText(cut, true)).toBe('binary');
  });
});

describe('fileFacts', () => {
  it('classifies a text file (HTML and Markdown included) as text/plain', () => {
    for (const name of ['notes.txt', 'index.html', 'README.md', 'Makefile']) {
      const f = fileFacts(put(name, '<script>alert(1)</script>\n'), roots);
      expect(f).toMatchObject({
        exists: true,
        type: 'file',
        size: 26,
        kindGuess: 'text',
        contentType: 'text/plain; charset=utf-8',
        preview: 'text',
        runsCode: false,
      });
      expect(f.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('classifies a binary file', () => {
    const f = fileFacts(put('data.bin', new Uint8Array([1, 2, 0, 3])), roots);
    expect(f).toMatchObject({
      kindGuess: 'binary',
      contentType: 'application/octet-stream',
      preview: 'none',
      runsCode: false,
    });
  });

  it('reads text with a multi-byte character across the sniff boundary as text', () => {
    const body = `${'a'.repeat(SNIFF_BYTES - 1)}✓ and more`;
    expect(fileFacts(put('long.txt', body), roots)).toMatchObject({ kindGuess: 'text' });
  });

  it('marks text past the preview limit as truncated', () => {
    const path = put('big.log', 'y'.repeat(PREVIEW_TEXT_BYTES + 1));
    expect(fileFacts(path, roots)).toMatchObject({ kindGuess: 'text', truncated: true });
    expect(fileFacts(put('small.log'), roots).truncated).toBeUndefined();
  });

  it('classifies images by extension, SVG as image/svg+xml', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect(fileFacts(put('logo.svg', svg), roots)).toMatchObject({
      kindGuess: 'image',
      contentType: 'image/svg+xml',
      preview: 'image',
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(fileFacts(put('Shot.PNG', png), roots)).toMatchObject({
      kindGuess: 'image',
      contentType: 'image/png',
    });
    for (const [ext, type] of [
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['gif', 'image/gif'],
      ['webp', 'image/webp'],
      ['avif', 'image/avif'],
    ]) {
      expect(fileFacts(put(`a.${ext}`, png), roots).contentType).toBe(type);
    }
  });

  it('does not preview an image past the preview limit', () => {
    const path = put('huge.png', 'x');
    truncateSync(path, PREVIEW_IMAGE_BYTES + 1);
    expect(fileFacts(path, roots)).toMatchObject({ kindGuess: 'image', preview: 'none' });
  });

  it('classifies a PDF by extension or by its magic', () => {
    expect(fileFacts(put('report.pdf', '%PDF-1.7\n'), roots)).toMatchObject({
      kindGuess: 'pdf',
      contentType: 'application/pdf',
      preview: 'none',
    });
    expect(fileFacts(put('report', '%PDF-1.4\n\x00\x01'), roots)).toMatchObject({
      kindGuess: 'pdf',
    });
  });

  it('classifies a folder, and an .app bundle as an application', () => {
    mkdirSync(join(ws, 'dist'));
    expect(fileFacts(join(ws, 'dist'), roots)).toMatchObject({
      type: 'folder',
      kindGuess: 'folder',
      preview: 'none',
      runsCode: false,
    });
    mkdirSync(join(ws, 'build', 'Demo.app', 'Contents', 'MacOS'), { recursive: true });
    expect(fileFacts(join(ws, 'build', 'Demo.app'), roots)).toMatchObject({
      type: 'folder',
      runsCode: true,
      runsAs: 'app',
    });
  });

  it('classifies Finder-runnable files as applications (decision 128)', () => {
    for (const name of [
      'run.command',
      'x.tool',
      'shell.terminal',
      'a.scpt',
      'b.workflow',
      'setup.pkg',
      'tool.jar',
      'Home.fileloc',
      'Site.inetloc',
      'Site.webloc',
      'Site.url',
      'Profile.mobileconfig',
      'Do it.shortcut',
      'Installer.dmg',
      'Thing.action',
    ]) {
      expect(fileFacts(put(name, 'echo hi\n'), roots)).toMatchObject({
        runsCode: true,
        runsAs: 'app',
      });
    }
    expect(fileFacts(put('start.command', '#!/bin/sh\necho hi\n', 0o755), roots)).toMatchObject({
      kindGuess: 'text',
      runsAs: 'app',
    });
  });

  it('suggests a command for an executable script or Mach-O binary, not for a plain one', () => {
    expect(fileFacts(put('bin/serve', '#!/bin/sh\necho hi\n', 0o755), roots)).toMatchObject({
      kindGuess: 'text',
      runsCode: true,
      runsAs: 'command',
    });
    expect(fileFacts(put('bin/notes', '#!/bin/sh\necho hi\n', 0o644), roots)).toMatchObject({
      runsCode: false,
    });
    const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
    expect(fileFacts(put('bin/app', macho, 0o755), roots)).toMatchObject({
      kindGuess: 'binary',
      runsCode: true,
      runsAs: 'command',
    });
    expect(fileFacts(put('bin/lib.o', macho, 0o644), roots).runsCode).toBe(false);
  });

  it('suggests a command for an executable file without an extension, whatever its bytes', () => {
    // The Finder runs any executable file without an extension in Terminal.
    expect(fileFacts(put('bin/plain', 'echo hi\n', 0o755), roots)).toMatchObject({
      kindGuess: 'text',
      runsCode: true,
      runsAs: 'command',
    });
    expect(fileFacts(put('bin/plain-ro', 'echo hi\n', 0o644), roots).runsCode).toBe(false);
    // With an extension and no #! or Mach-O start, the default app opens it as a document.
    expect(fileFacts(put('notes.txt', 'echo hi\n', 0o755), roots).runsCode).toBe(false);
  });

  it('reports a missing or refused file as not existing, with the reason', () => {
    expect(fileFacts(join(ws, 'gone.txt'), roots)).toMatchObject({
      exists: false,
      missing: { code: 'missing' },
      runsCode: false,
    });
    writeFileSync(join(tmp, 'out.txt'), 'x');
    expect(fileFacts(join(tmp, 'out.txt'), roots)).toMatchObject({
      exists: false,
      missing: { code: 'outside' },
    });
  });
});

describe('isAppName', () => {
  it('matches bundles and Finder-runnable extensions in any case', () => {
    expect(isAppName('Demo.app')).toBe(true);
    expect(isAppName('Demo.APP/')).toBe(true);
    expect(isAppName('/x/run.Command')).toBe(true);
    expect(isAppName('apple.txt')).toBe(false);
    expect(isAppName('app')).toBe(false);
    for (const name of ['Pane.prefPane', 'Flurry.saver', 'X.osax', 'Y.service', 'Z.WEBLOC']) {
      expect(isAppName(name)).toBe(true);
    }
  });
});
