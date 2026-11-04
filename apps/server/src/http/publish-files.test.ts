import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '@galactic/protocol';
import { sha256 } from '../domain/publish.js';
import { readPublishFile } from './publish-files.js';

/** P11-09 (ruling R24): only a listed, unchanged image inside the asker's folder is served. */

let root: string;
let outside: string;
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');

const questionOf = (
  files: { path: string; sha256: string }[],
  kind: Question['kind'] = 'publish',
) =>
  ({
    id: 'q-1',
    kind,
    status: 'open',
    context: {
      text: 'Publish',
      publish: {
        platform: 'X',
        account: 'me',
        text: 't',
        files,
        fingerprint: 'a'.repeat(64),
      },
    },
  }) as unknown as Question;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pub-root-'));
  outside = mkdtempSync(join(tmpdir(), 'pub-out-'));
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'out', 'a.png'), PNG);
  writeFileSync(join(root, 'notes.txt'), 'hello');
  writeFileSync(join(outside, 'secret.png'), PNG);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('readPublishFile', () => {
  it('serves a listed image with its type', () => {
    const q = questionOf([{ path: 'out/a.png', sha256: sha256(PNG) }]);
    const r = readPublishFile(q, '0', root);
    expect(r).toMatchObject({ status: 200, contentType: 'image/png' });
    expect((r as { bytes: Buffer }).bytes.equals(PNG)).toBe(true);
  });

  it('refuses an unlisted index, a non-number and a non-image', () => {
    const q = questionOf([
      { path: 'out/a.png', sha256: sha256(PNG) },
      { path: 'notes.txt', sha256: sha256('hello') },
    ]);
    expect(readPublishFile(q, '5', root).status).toBe(404);
    expect(readPublishFile(q, '../x', root).status).toBe(404);
    expect(readPublishFile(q, '1', root).status).toBe(404);
  });

  it('refuses a question that is not a publish, or one with no folder', () => {
    const files = [{ path: 'out/a.png', sha256: sha256(PNG) }];
    expect(readPublishFile(questionOf(files, 'spend'), '0', root).status).toBe(404);
    expect(readPublishFile(questionOf(files), '0', undefined).status).toBe(404);
    expect(readPublishFile(undefined, '0', root).status).toBe(404);
  });

  it('refuses a path that leaves the folder', () => {
    const rel = `../${outside.split('/').pop()}/secret.png`;
    const q = questionOf([{ path: rel, sha256: sha256(PNG) }]);
    expect(readPublishFile(q, '0', root).status).toBe(404);
    const abs = questionOf([{ path: join(outside, 'secret.png'), sha256: sha256(PNG) }]);
    expect(readPublishFile(abs, '0', root).status).toBe(404);
  });

  it('refuses a symlink, and a folder that is one', () => {
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
    symlinkSync(outside, join(root, 'dir'));
    for (const path of ['link.png', 'dir/secret.png']) {
      const q = questionOf([{ path, sha256: sha256(PNG) }]);
      expect(readPublishFile(q, '0', root).status).toBe(404);
    }
  });

  it('answers 409 when the file changed since it was listed', () => {
    const q = questionOf([{ path: 'out/a.png', sha256: sha256(PNG) }]);
    writeFileSync(join(root, 'out', 'a.png'), Buffer.from('changed'));
    expect(readPublishFile(q, '0', root)).toEqual({ status: 409, error: 'changed' });
  });
});
