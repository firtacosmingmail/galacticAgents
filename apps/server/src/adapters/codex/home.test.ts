import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_CONFIG_TOML, prepareCodexHome } from './home.js';

/**
 * The managed Codex home (P11-04, ruling R7) and ruling R27 (final review I5, replacing R9): when
 * Codex has replaced the `auth.json` link with a regular file (a token refresh written by
 * write-and-rename), that file may hold the only valid refresh token, so it is never deleted: it
 * is renamed over the user's own login file (neither file opened or read), then linked again.
 */

let base: string;
let home: string;
let userDir: string;
let authSource: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'galactic-codex-home-'));
  home = join(base, 'galactic', 'codex-home');
  userDir = join(base, 'user-codex');
  authSource = join(userDir, 'auth.json');
  mkdirSync(userDir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('prepareCodexHome', () => {
  it('writes the config and links auth.json to the user’s file', () => {
    writeFileSync(authSource, 'old token');
    expect(prepareCodexHome(home, authSource)).toEqual({ authPresent: true, replacedLink: false });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(MANAGED_CONFIG_TOML);
    expect(readlinkSync(join(home, 'auth.json'))).toBe(authSource);
    // Again: nothing changes.
    expect(prepareCodexHome(home, authSource).replacedLink).toBe(false);
    expect(readFileSync(authSource, 'utf8')).toBe('old token');
  });

  it('moves a regular auth.json Codex left over the user’s file, then links again (R27)', () => {
    writeFileSync(authSource, 'old token');
    prepareCodexHome(home, authSource);
    // Codex refreshed the login: a new file where the link was.
    rmSync(join(home, 'auth.json'));
    writeFileSync(join(home, 'auth.json'), 'rotated token', { mode: 0o600 });
    expect(prepareCodexHome(home, authSource)).toEqual({ authPresent: true, replacedLink: true });
    // The newest login is the user's now, and the managed home links to it again.
    expect(readFileSync(authSource, 'utf8')).toBe('rotated token');
    expect(lstatSync(authSource).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, 'auth.json'))).toBe(authSource);
  });

  it('a regular auth.json is moved even when the user has no login file yet', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), 'fresh login');
    expect(prepareCodexHome(home, authSource).replacedLink).toBe(true);
    expect(readFileSync(authSource, 'utf8')).toBe('fresh login');
    expect(readlinkSync(join(home, 'auth.json'))).toBe(authSource);
  });

  it('a link pointing elsewhere is replaced; its target is left alone', () => {
    const other = join(base, 'other.json');
    writeFileSync(other, 'someone else');
    writeFileSync(authSource, 'old token');
    mkdirSync(home, { recursive: true });
    symlinkSync(other, join(home, 'auth.json'));
    expect(prepareCodexHome(home, authSource).replacedLink).toBe(false);
    expect(readlinkSync(join(home, 'auth.json'))).toBe(authSource);
    expect(readFileSync(other, 'utf8')).toBe('someone else');
    expect(readFileSync(authSource, 'utf8')).toBe('old token');
  });

  it('refuses to start when the file cannot be moved back, and deletes nothing', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), 'rotated token');
    // The user's Codex folder is gone: the move fails.
    rmSync(userDir, { recursive: true });
    expect(() => prepareCodexHome(home, authSource)).toThrow(/auth\.json/);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('rotated token');
  });
});
