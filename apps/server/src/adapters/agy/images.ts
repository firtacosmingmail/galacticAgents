import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { lstatSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';

/**
 * Generated images (P11-05; P11-01 notes, agy 5): agy's image generator saves into the parent
 * conversation's artifact directory, `~/.gemini/antigravity-cli/brain/<conversationId>/`
 * (`<name>_<epoch-ms>.jpg`), not the workspace. The adapter notes the image files there when a
 * turn starts and, before it reports the turn's end, copies the new ones into the Steward's
 * worktree under `generated-images/` — so they are committed with the task's work. Only image
 * files directly in that directory are copied (not the conversation's logs or notes), and a file
 * already in `generated-images/` is never overwritten.
 */

export const IMAGE_FOLDER = 'generated-images';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function brainDir(home: string, conversationId: string): string {
  return join(home, '.gemini', 'antigravity-cli', 'brain', conversationId);
}

const isImage = (name: string) =>
  !name.startsWith('.') && IMAGE_EXTENSIONS.has(extname(name).toLowerCase());

/** The image files in `dir` now, with their modification times (an absent dir is empty). */
export function snapshotImages(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!isImage(name)) continue;
    try {
      const s = lstatSync(join(dir, name));
      if (s.isFile()) out.set(name, s.mtimeMs);
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/**
 * Copies the image files of `dir` that are new or changed since `before` into
 * `<cwd>/generated-images/`; returns the names copied. Never throws, and never follows a symlink:
 * a source entry must be a regular file (`lstat`), the target folder must be a real folder (not a
 * link) whose real path lies inside the worktree's, and an existing target name — a link
 * included — is never written.
 */
export async function copyNewImages(
  dir: string,
  before: ReadonlyMap<string, number>,
  cwd: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const target = join(cwd, IMAGE_FOLDER);
  const copied: string[] = [];
  let ready = false;
  for (const name of names.sort()) {
    if (!isImage(name)) continue;
    try {
      const s = await lstat(join(dir, name));
      if (!s.isFile() || before.get(name) === s.mtimeMs) continue;
      if (!ready) {
        if (!(await safeTarget(target, cwd))) return copied;
        ready = true;
      }
      // COPYFILE_EXCL: a name already in the folder (a file or a link) is never written.
      await copyFile(join(dir, name), join(target, name), constants.COPYFILE_EXCL);
      copied.push(name);
    } catch {
      /* an existing file, or one that went away: skipped */
    }
  }
  return copied;
}

/** Creates `generated-images/` if needed; false when it is a link or leaves the worktree. */
async function safeTarget(target: string, cwd: string): Promise<boolean> {
  try {
    const s = await lstat(target);
    if (s.isSymbolicLink() || !s.isDirectory()) return false;
  } catch {
    await mkdir(target);
  }
  const [real, root] = await Promise.all([realpath(target), realpath(cwd)]);
  const rel = relative(root, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
