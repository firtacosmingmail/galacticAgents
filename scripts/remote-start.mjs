#!/usr/bin/env node

// `pnpm remote` (P7-06; docs/REMOTE_ACCESS.md §1): builds, checks Tailscale, sets `remoteHost`,
// starts HTTP-mode Tailscale Serve on 443 → the server's port, then runs `galactic start --dev`.
// The Tailscale and Serve logic is the server's (`apps/server/src/remote/tailscale.ts`, P9-16),
// shared with Mission Control's `/api/remote/*` and the desktop app: this script loads its built
// copy, so it builds first (`--skip-build` uses the last build).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
for (const a of args) {
  if (a.startsWith('--') && !['--port', '--no-open', '--skip-build'].includes(a)) {
    fail(`unknown option ${a}\nusage: pnpm remote [--port <n>] [--no-open] [--skip-build]`);
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}
function step(message) {
  console.log(`\n▸ ${message}`);
}

if (!flag('--skip-build')) {
  step('pnpm build');
  const build = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('the build failed; nothing was started.');
}
const shared = join(root, 'apps/server/dist/remote/tailscale.js');
if (!existsSync(shared)) fail(`${shared} is missing: run "pnpm build" first.`);
const ts = await import(pathToFileURL(shared).href);
const exec = ts.defaultExecFile;

const dataDir = process.env.GALACTIC_HOME ?? join(homedir(), '.galactic');
const configPath = join(dataDir, 'config.json');
let config = {};
try {
  config = ts.readConfigFile(configPath);
} catch (e) {
  fail(`${configPath} is not valid JSON (${e.message}). Fix it, then run this again.`);
}
const portText = option('--port') ?? process.env.GALACTIC_PORT ?? String(config.port ?? 4321);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`not a port: ${portText}`);

// The Mac app's CLI first, then Homebrew's, the PATH last — each a trusted absolute path.
const tailscaleBin =
  (await ts.findTailscale({ exec, log: (line) => console.log(`  ${line}`) })) ??
  fail(
    'no usable tailscale command was found (the Mac app, /opt/homebrew/bin, /usr/local/bin, ' +
      'then the PATH; one writable by others is refused). Install Tailscale ' +
      '(https://tailscale.com/download), or in the Mac app enable Settings → "Install CLI".',
  );

step('Tailscale');
console.log(`  ${tailscaleBin}`);
const self = await ts.readTailscale(tailscaleBin, exec);
if (self.detail) {
  fail(`could not read "tailscale status" (${self.detail}). Is Tailscale running?`);
}
if (self.state !== 'running') {
  fail(
    `Tailscale is not connected (state: ${self.backendState ?? 'unknown'}). ` +
      'Open the Tailscale app and sign in (or run "tailscale up"), then run this again.',
  );
}
if (!self.name) {
  fail(
    'this Mac has no MagicDNS name. In the Tailscale admin console (DNS page) turn on MagicDNS ' +
      'and HTTPS certificates, then run this again.',
  );
}
const dnsName = self.name;
console.log(`  connected as ${dnsName}`);

step('remoteHost');
const envHost = process.env.GALACTIC_REMOTE_HOST;
const configured = envHost ?? (typeof config.remoteHost === 'string' ? config.remoteHost : '');
const hostState = ts.remoteHostState(configured, dnsName);
if (hostState === 'missing') {
  ts.addRemoteHost(configPath, dnsName);
  console.log(`  added "remoteHost": "${dnsName}" to ${configPath}`);
} else if (hostState === 'mismatch') {
  const where = envHost ? 'GALACTIC_REMOTE_HOST' : `"remoteHost" in ${configPath}`;
  fail(
    `${where} is "${configured.toLowerCase()}", but this Mac's Tailscale name is "${dnsName}". ` +
      'The server would refuse the phone. Correct it, then run this again.',
  );
} else {
  console.log(`  ${configured.toLowerCase()} (ok)`);
}

step(`port ${port}`);
const inUse = await new Promise((done) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});
if (inUse) {
  fail(
    `something already listens on 127.0.0.1:${port}. If it is "pnpm dev" or another Mission ` +
      'Control, stop it first (pnpm dev does not serve the web app to the phone), then run this again.',
  );
}
console.log('  free');

step('Tailscale Serve');
const target = ts.serveTarget(port);
let serve;
let funnel;
try {
  const json = await ts.readServe(tailscaleBin, exec);
  serve = ts.classifyServe(json, dnsName, port);
  funnel = ts.funnelOn(json);
} catch (e) {
  fail(`could not read "tailscale serve status" (${ts.errorText(e)}).`);
}
if (funnel) {
  fail(
    'Tailscale Funnel is on: it publishes this Mac to the whole internet. Turn it off ' +
      '("tailscale funnel reset"), then run this again. Mission Control must never be behind Funnel.',
  );
} else if (serve === 'forwarding_to_us') {
  console.log(`  already serving https://${dnsName} → ${target}`);
} else if (serve === 'taken_by_other') {
  fail(
    'port 443 is already served to something else:\n' +
      (await ts.serveStatusText(tailscaleBin, exec)) +
      `\nClear it with "tailscale serve reset" (or "tailscale serve --https=443 off"), then run this again.`,
  );
} else {
  try {
    await ts.startServe(tailscaleBin, exec, port);
  } catch (e) {
    fail(`"tailscale serve --bg --https=443 ${target}" failed: ${ts.errorText(e)}`);
  }
  console.log(`  started: https://${dnsName} → ${target}`);
}
console.log((await ts.serveStatusText(tailscaleBin, exec)).replace(/^/gm, '  '));

step('galactic start --dev');
console.log(
  `  On the phone open https://${dnsName}, or scan the QR code in Settings → Access ` +
    `(on the Mac: http://127.0.0.1:${port}). Ctrl-C stops Mission Control; Serve stays on ` +
    '("tailscale serve --https=443 off" stops it).\n',
);
const startArgs = ['start', '--dev', '--port', String(port)];
if (flag('--no-open')) startArgs.push('--no-open');
const child = spawn(process.execPath, [join(root, 'apps/server/bin/galactic.mjs'), ...startArgs], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
