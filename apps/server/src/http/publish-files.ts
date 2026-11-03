import { extname } from 'node:path';
import type { Question } from '@galactic/protocol';
import { readFileInFolder, sha256, UnsafePublishFile } from '../domain/publish.js';

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
  // The same safe read as the request's hashes (`readFileInFolder`, final review I2).
  let bytes: Buffer;
  try {
    bytes = readFileInFolder(root, file.path, PUBLISH_IMAGE_MAX_BYTES).bytes;
  } catch (error) {
    if (error instanceof UnsafePublishFile && error.message === 'too_large') {
      return { status: 413, error: 'too_large' };
    }
    return notFound;
  }
  if (sha256(bytes) !== file.sha256) return { status: 409, error: 'changed' };
  return { status: 200, contentType, bytes };
}
