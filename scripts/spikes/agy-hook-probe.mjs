#!/usr/bin/env node
// Spike hook for Antigravity (`agy`) PreToolUse probes (P11-01). Kept so the probes can be
// re-run after a CLI update. It never touches the network.
//
// Reads the hook payload from stdin, appends one JSON line to PROBE_LOG (default: ./hook-log.jsonl
// next to the cwd), then behaves according to PROBE_MODE:
//   allow        print {"decision":"allow"}                  (default)
//   auto_approve print {"decision":"auto_approve"}
//   deny         print {"decision":"deny","reason":"probe denies"}
//   sleep        sleep PROBE_SLEEP_S seconds (default 3600) and print nothing   -> timeout probe
//   crash        exit 1 without output                                           -> crash probe
//   garbage      print text that is not JSON, exit 0
//   delay-approve sleep PROBE_SLEEP_S seconds, then print auto_approve (long-wait probe)
//   exit2        print a reason to stderr and exit 2
//   by-tool      PROBE_RULES="tool=decision,tool=decision,*=decision" (first match wins)
// PROBE_TAG is copied into every log line so several runs can share one log.
import { appendFileSync, readFileSync } from 'node:fs';

const log = process.env.PROBE_LOG ?? 'hook-log.jsonl';
const mode = process.env.PROBE_MODE ?? 'allow';
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  /* keep {} */
}
const tool = payload?.toolCall?.name ?? null;
appendFileSync(
  log,
  JSON.stringify({
    tag: process.env.PROBE_TAG ?? null,
    at: new Date().toISOString(),
    mode,
    tool,
    args: payload?.toolCall?.args ?? null,
    keys: Object.keys(payload),
    payload,
  }) + '\n',
);

const say = (decision, reason) =>
  process.stdout.write(JSON.stringify({ decision, ...(reason ? { reason } : {}) }));

switch (mode) {
  case 'auto_approve':
    say('auto_approve');
    break;
  case 'deny':
    say('deny', 'probe denies');
    break;
  case 'sleep':
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SLEEP_S ?? 3600) * 1000));
    break;
  case 'delay-approve':
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SLEEP_S ?? 45) * 1000));
    say('auto_approve');
    break;
  case 'crash':
    process.exit(1);
    break;
  case 'garbage':
    process.stdout.write('this is not json');
    break;
  case 'exit2':
    process.stderr.write('probe exit 2');
    process.exit(2);
    break;
  case 'by-tool': {
    const rules = (process.env.PROBE_RULES ?? '*=allow').split(',').map((r) => r.split('='));
    const hit = rules.find(([t]) => t === tool) ?? rules.find(([t]) => t === '*');
    say(hit ? hit[1] : 'allow');
    break;
  }
  default:
    say('allow');
}
