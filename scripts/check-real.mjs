#!/usr/bin/env node
// The real-Claude checks of the dev machine, in one command (P1-08, P1-09, P1-12; decision 17).
//
//   pnpm check:real                 # all four checks
//   pnpm check:real smoke restart   # only some: spike smoke conformance restart
//
// Local only: they use the machine's Claude Code login (the subscription) and start real
// sessions, so they never run in CI. Each check passes only when it exits cleanly AND its output
// shows the success it is about (the spike and the smoke scripts print results rather than assert
// them). The full output goes to `.galactic/checks/real-<time>.log` (git-ignored); the summary is
// printed at the end and the exit code is non-zero when any check failed.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const MIN = 60_000;

const CHECKS = [
  {
    name: 'spike',
    what: 'SDK spike: the subscription login and custom tools (P1-08)',
    cmd: ['node', ['docs/tasks/notes/P1-08-sdk-spike.mjs', 'auth', 'tools']],
    timeoutMs: 5 * MIN,
    must: [/claude auth status:/],
    mustNot: [/claude auth status failed/i, /is_error=true/, /\bError:/],
  },
  {
    name: 'smoke',
    what: 'adapter smoke through the runtime: basic, ask, permission, pause, stop, resume (P1-09)',
    cmd: ['pnpm', ['--filter', '@galactic/server', 'exec', 'tsx', 'scripts/sdk-smoke.ts']],
    timeoutMs: 15 * MIN,
    must: [/live processes left: 0/],
    mustNot: [/\bError:/],
  },
  {
    name: 'conformance',
    what: 'conformance suite against the real adapter (P1-12)',
    cmd: [
      'pnpm',
      [
        '--filter',
        '@galactic/server',
        'exec',
        'vitest',
        'run',
        'src/adapters/claude-sdk/claude-sdk.conformance.test.ts',
        '--reporter=verbose',
      ],
    ],
    env: { GALACTIC_REAL_CLAUDE: '1' },
    timeoutMs: 15 * MIN,
    must: [/Tests\s+\d+ passed/],
    mustNot: [/\d+ failed/],
  },
  {
    name: 'restart',
    what: 'kill -9 mid-task, a second server life resumes the agent from its session (P1-12)',
    cmd: ['pnpm', ['--filter', '@galactic/server', 'exec', 'tsx', 'scripts/sdk-restart-smoke.ts']],
    timeoutMs: 10 * MIN,
    must: [/"resumed":\["a-/, /"needAttention":\[\]/, /remembered "starting": true/],
    mustNot: [],
  },
];

const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !CHECKS.some((c) => c.name === w));
if (unknown.length > 0) {
  console.error(
    `unknown check(s): ${unknown.join(', ')} — known: ${CHECKS.map((c) => c.name).join(' ')}`,
  );
  process.exit(2);
}
const selected = wanted.length > 0 ? CHECKS.filter((c) => wanted.includes(c.name)) : CHECKS;

mkdirSync(join(root, '.galactic', 'checks'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = join(root, '.galactic', 'checks', `real-${stamp}.log`);
const logFile = createWriteStream(logPath);
const say = (line) => {
  process.stdout.write(`${line}\n`);
  logFile.write(`${line}\n`);
};

// Prerequisite: a logged-in Claude Code. Without it every check would fail for the same reason.
try {
  const status = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8' }).trim();
  say(`claude auth status: ${status.replace(/\s+/g, ' ')}`);
} catch (error) {
  say(`claude auth status failed: ${error.message.split('\n')[0]}`);
  say('Log in first: run `claude` once and sign in with your subscription, then run this again.');
  logFile.end();
  process.exit(1);
}

function run(check) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    const [bin, args] = check.cmd;
    const child = spawn(bin, args, {
      cwd: root,
      env: { ...process.env, ...(check.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      logFile.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      output += `\n[check-real] timed out after ${check.timeoutMs / MIN} min\n`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, check.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const problems = [];
      if (code !== 0) problems.push(`exited with ${signal ?? code}`);
      for (const re of check.must) if (!re.test(output)) problems.push(`missing ${re}`);
      for (const re of check.mustNot) if (re.test(output)) problems.push(`found ${re}`);
      resolve({
        check,
        ok: problems.length === 0,
        problems,
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

const results = [];
for (const check of selected) {
  say(`\n===== ${check.name}: ${check.what} =====`);
  results.push(await run(check));
}

say('\n===== summary =====');
for (const r of results) {
  say(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.check.name.padEnd(12)} ${r.seconds.toFixed(0).padStart(4)} s` +
      (r.ok ? '' : `  — ${r.problems.join('; ')}`),
  );
}
const failed = results.filter((r) => !r.ok).length;
say(failed === 0 ? '\nAll real-Claude checks passed.' : `\n${failed} check(s) failed.`);
say(`Full log: ${logPath}`);
logFile.end();
process.exit(failed === 0 ? 0 : 1);
