import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Question } from '@galactic/protocol';
import { sha256 } from '../domain/publish.js';

/**
 * The image of a publish approval (P11-09, ruling R24): `GET /api/questions/:id/publish-files/:index`
 * serves ONLY a file listed in that `publish` question's `context.publish.files`, from the asking
 * Steward's folder — never a path from the request. The path is resolved inside that folder, a
 * symlink (the file or any folder on the way) is refused, only image types are served, and a file
 * whose bytes no longer hash to the approved sha256 is refused (409): the card never shows
 * something other than what the approval covers.
 */

export const PUBLISH_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The most bytes a preview serves. */
export const PUBLISH_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export type PublishFileResult =
  { status: 200; contentType: string; bytes: Buffer } | { status: 404 | 409 | 413; error: string };

const notFound: PublishFileResult = { status: 404, error: 'not_found' };

/** Whether any folder from `root` down to `abs` (or `abs` itself) is a symbolic link. */
function hasSymlink(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = resolve(cur, part);
    if (lstatSync(cur).isSymbolicLink()) return true;
  }
  return false;
}

export function readPublishFile(
  question: Question | undefined,
  indexText: string,
  root: string | undefined,
): PublishFileResult {
  const publish = question?.context.publish;
  if (!question || question.kind !== 'publish' || !publish || root === undefined) return notFound;
  if (!/^\d{1,2}$/.test(indexText)) return notFound;
  const file = publish.files[Number(indexText)];
  if (!file) return notFound;
  const contentType = PUBLISH_IMAGE_TYPES[extname(file.path).toLowerCase()];
  if (!contentType) return notFound;
  try {
    const base = realpathSync(resolve(root));
    const abs = resolve(base, file.path);
    const rel = relative(base, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return notFound;
    }
    if (hasSymlink(base, abs)) return notFound;
    const stat = lstatSync(abs);
    if (!stat.isFile()) return notFound;
    if (stat.size > PUBLISH_IMAGE_MAX_BYTES) return { status: 413, error: 'too_large' };
    const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      if (!fstatSync(fd).isFile()) return notFound;
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (sha256(bytes) !== file.sha256) return { status: 409, error: 'changed' };
    return { status: 200, contentType, bytes };
  } catch {
    return notFound;
  }
}
