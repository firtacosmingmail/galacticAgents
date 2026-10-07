#!/usr/bin/env node
// `pnpm desktop:install` (P8-06): build the desktop app and copy it into /Applications.
//
//   1. builds it (`pnpm desktop:build`: the web app, the server and the Tauri bundle);
//   2. refuses while GalacticAgents.app is running (quit it from its menu bar icon first);
//   3. replaces /Applications/GalacticAgents.app — only when the copy there is this app
//      (same bundle identifier), never another app of the same name;
//   4. copies the new bundle with `ditto` (keeps the bundle's attributes and signature).
//
// usage: pnpm desktop:install [--skip-build] [--to <folder>] [--open]
// The app runs the repository it was built from (docs/DESKTOP.md): after `git pull`, run this again.

import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
for (const a of args) {
  if (a.startsWith('--') && !['--skip-build', '--to', '--open'].includes(a)) {
    fail(
      `unknown option ${a}\nusage: pnpm desktop:install [--skip-build] [--to <folder>] [--open]`,
    );
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}
function step(message) {
  console.log(`\n▸ ${message}`);
}

if (process.platform !== 'darwin') fail('the desktop app is built for macOS only.');

const conf = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const appName = `${conf.productName}.app`;
const identifier = conf.identifier;
const built = join(root, 'apps/desktop/src-tauri/target/release/bundle/macos', appName);
const folder = resolve(option('--to') ?? '/Applications');
const target = join(folder, appName);

// --- build ----------------------------------------------------------------------------

if (!flag('--skip-build')) {
  if (!existsSync(join(homedir(), '.cargo/bin/cargo'))) {
    const onPath = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
    if (!onPath) {
      fail(
        'Rust is not installed (no cargo). Install it with rustup (https://rustup.rs), then run this again.',
      );
    }
  }
  step('pnpm desktop:build');
  const build = spawnSync('pnpm', ['desktop:build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('the build failed; nothing was copied.');
}
if (!existsSync(built)) {
  fail(`no built app at ${built}. Run without --skip-build first.`);
}

// --- the installed copy must not be running -----------------------------------------------

step(`install into ${folder}`);
const running = spawnSync('pgrep', ['-f', `${appName}/Contents/MacOS/`], { encoding: 'utf8' });
if (running.status === 0 && running.stdout.trim()) {
  fail(
    `${conf.productName} is running. Quit it from its menu bar icon (Quit), then run this again ` +
      '(add --skip-build to reuse the build you just made).',
  );
}

try {
  accessSync(folder, constants.W_OK);
} catch {
  fail(`cannot write to ${folder}. Use --to ~/Applications, or fix the folder's permissions.`);
}

// --- replace only our own copy ----------------------------------------------------------

function bundleId(app) {
  try {
    return execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return undefined;
  }
}

if (existsSync(target)) {
  const found = bundleId(target);
  if (found !== identifier) {
    fail(
      `${target} exists but is not this app (bundle id ${found ?? 'unreadable'}, expected ${identifier}). ` +
        'Move it away yourself, then run this again.',
    );
  }
  execFileSync('rm', ['-rf', target]);
  console.log(`  removed the previous ${appName}`);
}

execFileSync('ditto', [built, target]);
if (bundleId(target) !== identifier) fail(`the copy at ${target} looks wrong; check it.`);
console.log(`  installed ${target}`);
console.log(
  `\n✓ Done. Open it from Launchpad or Spotlight ("${conf.productName}"), or: open "${target}".\n` +
    '  It runs this repository (apps/server, apps/web/dist); after git pull, run pnpm desktop:install again.\n' +
    '  Unsigned build: the first time, macOS may ask you to confirm (right-click → Open).\n',
);

if (flag('--open')) execFileSync('open', [target]);
