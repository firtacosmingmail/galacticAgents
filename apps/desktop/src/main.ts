#!/usr/bin/env node
// The desktop shell's Node side (P8-06; docs/DESKTOP.md). Started by the Rust shell with stdin and
// stdout piped: JSON lines out (`lines.ts`), commands in. Can be run by hand to watch what it
// would tell the shell:  GALACTIC_HOME=/tmp/x GALACTIC_PORT=4400 node apps/desktop/dist/main.js
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { dataPaths, readToken } from './lifecycle.js';
import { parseCommand, type ShellLine } from './lines.js';
import { Supervisor } from './supervisor.js';
import { desktopSettingsPath, PhoneAccess } from './phone.js';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = resolve(here, '../../server/bin/galactic.mjs');
const env = process.env;
const paths = dataPaths(env);

const log = (line: string) => process.stderr.write(`[desktop] ${line}\n`);
const emit = (line: ShellLine) => process.stdout.write(JSON.stringify(line) + '\n');

if (!existsSync(launcher)) {
  log(`missing ${launcher}`);
  process.exit(1);
}
const portEnv = env['GALACTIC_PORT'];
const port = portEnv !== undefined && /^\d+$/.test(portEnv) ? Number(portEnv) : undefined;

// Phone access (P9-16): through Mission Control's own routes; the switch is the app's setting.
const phone = new PhoneAccess({
  settingsPath: desktopSettingsPath(env),
  token: () => readToken(env, paths),
  emit,
  log,
});

const supervisor = new Supervisor({
  paths,
  token: () => readToken(env, paths),
  emit,
  log,
  phone,
  server: { launcher, env: { ...env }, ...(port !== undefined ? { port } : {}) },
});

let quitting = false;
const quit = () => {
  if (quitting) return;
  quitting = true;
  void supervisor.quit().finally(() => process.exit(0));
};

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const command = parseCommand(line);
  if (command === 'quit') quit();
  else if (command === 'start') supervisor.requestStart();
  else if (command === 'phone:on' || command === 'phone:off') void phone.setOn(command === 'phone:on');
  else if (command?.type === 'answer') {
    const { type: _type, ...answer } = command;
    void supervisor.answer(answer);
  }
});
// The shell closed our stdin (it quit or died): stop what we started.
input.on('close', quit);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, quit);

log(`data in ${paths.dataDir}`);
phone.setServer(undefined); // the switch's state, for the menu
supervisor.run();
