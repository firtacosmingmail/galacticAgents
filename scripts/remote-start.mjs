#!/usr/bin/env node
// `pnpm remote` (P7-06): start Mission Control for the phone over Tailscale Serve.
//
//   1. checks that Tailscale is connected and has a MagicDNS name;
//   2. checks `remoteHost` in ~/.galactic/config.json (adds it when missing);
//   3. starts HTTP-mode Serve on 443 → http://127.0.0.1:<port> unless it already serves that,
//      and refuses when 443 serves something else or Funnel is on;
//   4. prints `tailscale serve status`;
//   5. builds the project (`pnpm build`) and runs `galactic start --dev`, which serves the built
//      web app on the port Serve forwards to (`pnpm dev` does not: only Vite serves the page).
//
// usage: pnpm remote [--port <n>] [--no-open] [--skip-build]
// See docs/REMOTE_ACCESS.md.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
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

// --- config -----------------------------------------------------------------------------

const dataDir = process.env.GALACTIC_HOME ?? join(homedir(), '.galactic');
const configPath = join(dataDir, 'config.json');
let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`${configPath} is not valid JSON (${e.message}). Fix it, then run this again.`);
  }
}
const portText = option('--port') ?? process.env.GALACTIC_PORT ?? String(config.port ?? 4321);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`not a port: ${portText}`);

// --- Tailscale ----------------------------------------------------------------------------

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const tailscaleBin =
  spawnSync('tailscale', ['version'], { stdio: 'ignore' }).status === 0
    ? 'tailscale'
    : existsSync(APP_CLI)
      ? APP_CLI
      : fail(
          'the tailscale command was not found. Install Tailscale (https://tailscale.com/download), ' +
            'or in the Mac app enable Settings → "Install CLI".',
        );

function tailscale(...cmd) {
  return execFileSync(tailscaleBin, cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tailscaleJson(...cmd) {
  const out = tailscale(...cmd, '--json').trim();
  return out ? JSON.parse(out) : {};
}

step('Tailscale');
let status;
try {
  status = tailscaleJson('status');
} catch (e) {
  fail(
    `could not read "tailscale status" (${String(e.stderr ?? e.message).trim()}). Is Tailscale running?`,
  );
}
if (status.BackendState !== 'Running') {
  fail(
    `Tailscale is not connected (state: ${status.BackendState ?? 'unknown'}). ` +
      'Open the Tailscale app and sign in (or run "tailscale up"), then run this again.',
  );
}
const dnsName = String(status.Self?.DNSName ?? '')
  .replace(/\.$/, '')
  .toLowerCase();
if (!dnsName.endsWith('.ts.net')) {
  fail(
    'this Mac has no MagicDNS name. In the Tailscale admin console (DNS page) turn on MagicDNS ' +
      'and HTTPS certificates, then run this again.',
  );
}
console.log(`  connected as ${dnsName}`);

// --- remoteHost ---------------------------------------------------------------------------

step('remoteHost');
const envHost = process.env.GALACTIC_REMOTE_HOST;
const configured = (envHost ?? config.remoteHost ?? '').toLowerCase();
if (!configured) {
  config.remoteHost = dnsName;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`  added "remoteHost": "${dnsName}" to ${configPath}`);
} else if (configured !== dnsName) {
  const where = envHost ? 'GALACTIC_REMOTE_HOST' : `"remoteHost" in ${configPath}`;
  fail(
    `${where} is "${configured}", but this Mac's Tailscale name is "${dnsName}". ` +
      'The server would refuse the phone. Correct it, then run this again.',
  );
} else {
  console.log(`  ${configured} (ok)`);
}

// --- the port must be free: the server we start listens there ---------------------------

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

// --- Serve --------------------------------------------------------------------------------

step('Tailscale Serve');
const target = `http://127.0.0.1:${port}`;
let serve;
try {
  serve = tailscaleJson('serve', 'status');
} catch (e) {
  fail(`could not read "tailscale serve status" (${String(e.stderr ?? e.message).trim()}).`);
}
if (serve.AllowFunnel && Object.values(serve.AllowFunnel).some(Boolean)) {
  fail(
    'Tailscale Funnel is on: it publishes this Mac to the whole internet. Turn it off ' +
      '("tailscale funnel reset"), then run this again. Mission Control must never be behind Funnel.',
  );
}
const handlers = serve.Web?.[`${dnsName}:443`]?.Handlers ?? {};
const current = handlers['/']?.Proxy;
const tcp443 = serve.TCP?.['443'];
if (current === target && Object.keys(handlers).length === 1) {
  console.log(`  already serving https://${dnsName} → ${target}`);
} else if (current || Object.keys(handlers).length > 0 || (tcp443 && !tcp443.HTTPS)) {
  fail(
    'port 443 is already served to something else:\n' +
      tailscale('serve', 'status') +
      `\nClear it with "tailscale serve reset" (or "tailscale serve --https=443 off"), then run this again.`,
  );
} else {
  try {
    tailscale('serve', '--bg', '--https=443', target);
  } catch (e) {
    fail(
      `"tailscale serve --bg --https=443 ${target}" failed: ${String(e.stderr ?? e.message).trim()}`,
    );
  }
  console.log(`  started: https://${dnsName} → ${target}`);
}
console.log(tailscale('serve', 'status').replace(/^/gm, '  '));

// --- build and start ----------------------------------------------------------------------

if (!flag('--skip-build')) {
  step('pnpm build');
  const build = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('the build failed; nothing was started.');
}

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
