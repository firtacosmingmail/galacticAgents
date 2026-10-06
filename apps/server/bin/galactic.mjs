#!/usr/bin/env node
// `galactic start` — starts Mission Control serving the built web app, prints the URL and the
// token, and opens the browser. Run `pnpm build` first (or use `pnpm dev` for hot reload).
// `--dev` enables the `/dev/*` demo routes the Phase 0 page's buttons use.
// `galactic export <file>` / `galactic import <file>` export and import the map, and
// `galactic restore <backup>` puts a backup back (P8-03, docs/BACKUP_RESTORE.md).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../dist/index.js');
const webDir = resolve(here, '../../web/dist');
const [command = 'start', ...flags] = process.argv.slice(2);

// export / import (P8-03): the map and its history as JSON; restore: a backup file put back.
if (command === 'export' || command === 'import' || command === 'restore') {
  const cliEntry = resolve(here, '../dist/cli.js');
  if (!existsSync(cliEntry)) {
    console.error(`The server is not built (${cliEntry} missing). Run \`pnpm build\` first.`);
    process.exit(1);
  }
  const { runCli } = await import(pathToFileURL(cliEntry).href);
  process.exit(
    await runCli([command, ...flags], {
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
}
if (command !== 'start') {
  console.error(`usage: galactic start [--no-open] [--port <n>] [--dev]`);
  console.error(`       galactic export <file> [--transcripts]`);
  console.error(`       galactic import <file> [--replace] [--prefer-rows]`);
  console.error(`       galactic restore <backup file>`);
  process.exit(2);
}
for (const [name, path] of [
  ['server', serverEntry],
  ['web app', join(webDir, 'index.html')],
]) {
  if (!existsSync(path)) {
    console.error(`The ${name} is not built (${path} missing). Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const env = { ...process.env, GALACTIC_WEB_DIR: webDir, GALACTIC_LOG: env_log() };
const portFlag = flags.indexOf('--port');
if (portFlag !== -1 && flags[portFlag + 1]) env.GALACTIC_PORT = flags[portFlag + 1];
const noOpen = flags.includes('--no-open');
if (flags.includes('--dev')) env.GALACTIC_DEV = '1'; // enables /dev/* (demo events, seed)

const child = spawn(process.execPath, [serverEntry], {
  env,
  stdio: ['inherit', 'pipe', 'inherit'],
});
let announced = false;
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const m = /listening on (http:\/\/[^\s]+)/.exec(text);
  if (m && !announced) {
    announced = true;
    announce(m[1]);
  }
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

function env_log() {
  return process.env.GALACTIC_LOG ?? 'silent';
}

function announce(url) {
  const dataDir = process.env.GALACTIC_HOME ?? join(homedir(), '.galactic');
  let token = process.env.GALACTIC_TOKEN;
  if (!token) {
    try {
      token = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).token;
    } catch {
      token = '(see ' + join(dataDir, 'config.json') + ')';
    }
  }
  console.log('');
  console.log('  GalacticAgents Mission Control');
  console.log(`  URL:    ${url}`);
  console.log(`  Token:  ${token}`);
  console.log('  The local page picks the token up by itself; paste it on other devices.');
  console.log('');
  if (!noOpen) openBrowser(url);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}
