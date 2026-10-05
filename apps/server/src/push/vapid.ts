import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';

/**
 * The server's VAPID key pair (P7-04; RFC 8292): it signs every push, and browsers bind a
 * subscription to its public key. Generated on first need — the first `GET /api/push` or send —
 * and kept in `<dataDir>/vapid.json` with file mode 0600, next to `config.json`: outside the
 * repository, never in a log, never sent anywhere but its public half. Losing the file means
 * every device subscribes again (their subscriptions are bound to the old key): the caller is told
 * through `onCreate` and clears the stored subscriptions, which can never work again.
 */

export const VAPID_FILE = 'vapid.json';

const VapidFile = z.object({
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/),
  createdAt: z.string(),
});

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidOptions {
  dataDir: string;
  /** Called when the file had to be repaired or replaced; never given the keys. */
  warn?: (message: string) => void;
  /**
   * Called after a new key pair was made — no file yet, or one that could not be read. Every
   * subscription made before is bound to the old public key and can never be delivered again.
   */
  onCreate?: () => void;
}

/** Reads the key pair, creating it (mode 0600) when there is none or the file is unreadable. */
export function loadOrCreateVapidKeys(opts: VapidOptions): VapidKeys {
  const path = join(opts.dataDir, VAPID_FILE);
  if (existsSync(path)) {
    // A copy restored with looser permissions is tightened before it is read.
    if ((statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      opts.warn?.(`${VAPID_FILE} was readable by others; its mode is now 0600`);
    }
    try {
      const parsed = VapidFile.parse(JSON.parse(readFileSync(path, 'utf8')));
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    } catch {
      opts.warn?.(
        `${VAPID_FILE} could not be read; new push keys were made (every device must turn push on again)`,
      );
    }
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2) + '\n',
    { mode: 0o600 },
  );
  // `mode` applies only when the file is created: an existing (unreadable) one is tightened too.
  chmodSync(path, 0o600);
  opts.onCreate?.();
  return keys;
}

/**
 * The VAPID `sub` claim: a contact for the push services. Apple refuses a localhost URL, so it is
 * the Serve name when remote access is set up, else a placeholder address that is never mailed.
 * `GALACTIC_PUSH_SUBJECT` (a `mailto:` or `https:` URL) overrides it.
 */
export function vapidSubject(env: NodeJS.ProcessEnv, remoteHost: string | undefined): string {
  const fromEnv = env['GALACTIC_PUSH_SUBJECT']?.trim();
  if (fromEnv && /^(mailto:|https:\/\/)\S+$/.test(fromEnv)) return fromEnv;
  if (remoteHost) return `https://${remoteHost}`;
  return 'mailto:mission-control@galactic-agents.invalid';
}
