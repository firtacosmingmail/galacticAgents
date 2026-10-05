// A stand-in for a Steward's CLI in the crash drills (P8-04). The fake adapter runs in-process,
// so the drills give a Steward real processes through the supervisor: this leader (in its own
// process group, like the real CLI) starts a child that stays in the group (an MCP server, the
// shell of a tool command) and, with `--escape`, one that leaves the group (`setsid`, a dev server
// started with `nohup … &` / `setsid`) in the leader's working directory — the Steward's worktree.
// Both inherit the agent marker the supervisor puts in the environment.
//
//   node stand-in-cli.mjs --pids <file> [--escape] [--exit-on-eof]
//
// `--exit-on-eof`: the leader exits when its stdin closes (the server died), as a CLI reading a
// stream-json conversation from the server does; its group child lives on.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const pidsFile = args[args.indexOf('--pids') + 1];
const idle = 'setInterval(() => {}, 1 << 30)';

const child = spawn(process.execPath, ['-e', idle], { stdio: 'ignore' });
const pids = { leader: process.pid, child: child.pid };
if (args.includes('--escape')) {
  const escaped = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', detached: true });
  escaped.unref();
  pids.escaped = escaped.pid;
}
writeFileSync(pidsFile, JSON.stringify(pids));

if (args.includes('--exit-on-eof')) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}
setInterval(() => {}, 1 << 30);
