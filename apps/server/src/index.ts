import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';
import { ClaudeSdkAdapter } from './adapters/claude-sdk/index.js';
import { FakeAdapter } from './adapters/fake/fake-adapter.js';
import { openDatabase } from './db/database.js';
import { composeRuntime } from './runtime/compose.js';
import { SqliteProcessStore } from './runtime/process-store.js';
import { ProcessSupervisor } from './runtime/supervisor.js';

const { config, tokenGenerated } = loadConfig();
const onError = (error: unknown, context: string) =>
  console.error(`[runtime] ${context}:`, error instanceof Error ? error.message : error);

const db = openDatabase(config.dbPath);
// The supervisor owns every agent child process; its PID table lives in the same database.
const supervisor = new ProcessSupervisor({ store: new SqliteProcessStore(db) });
const reconciled = supervisor.reconcile();
if (reconciled.dead.length + reconciled.orphans.length > 0) {
  console.log(
    `Reconciled the process table: ${reconciled.dead.length} dead, ${reconciled.orphans.length} orphaned (killed)`,
  );
}

// Adapters: the fake one always (dev mode without Claude), the real one for Claude Code.
const fake = new FakeAdapter();
const composed = composeRuntime(db, {
  adapters: [
    fake,
    new ClaudeSdkAdapter({
      supervisor,
      ...(process.env['GALACTIC_MODEL'] ? { model: process.env['GALACTIC_MODEL'] } : {}),
      onError,
    }),
  ],
  onError,
});
const { log, statuses, transcripts } = composed;

// Shutdown is wired before anything is resumed or listening (P1-32): a signal during recovery
// or a failed listen still interrupts the agents and saves their sessions.
const server: { app?: ReturnType<typeof buildApp> } = {};
let shuttingDown = false;
// Every agent is stopped in parallel, each within the supervisor's grace + term periods; the
// deadline leaves room for that plus the flushes around it.
const SHUTDOWN_DEADLINE_MS = 10_000 + 5_000 + 10_000;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    console.error('shutdown deadline reached: exiting');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  void composed
    .shutdown()
    .catch((error) => console.error('[runtime] shutdown:', error))
    .then(() => supervisor.dispose())
    .catch((error) => console.error('[supervisor] dispose:', error))
    .then(() => server.app?.close())
    .catch((error) => console.error('[server] close:', error))
    .then(() => process.exit(code));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      console.error('second signal: exiting now');
      process.exit(1);
    }
    shutdown(0);
  });
}

// Resume what the previous server life left running (SPEC decision 8).
const recovery = await composed.recover();
if (recovery.resumed.length + recovery.needAttention.length > 0) {
  console.log(
    `Recovered: ${recovery.resumed.length} agents resumed, ${recovery.needAttention.length} need attention`,
  );
}

const webDir = process.env['GALACTIC_WEB_DIR'];
const app = buildApp({
  config,
  log,
  statuses,
  transcripts,
  runtime: composed.runtime,
  commands: composed.commands,
  scenarios: () => fake.scenarioNames(),
  logger: process.env['GALACTIC_LOG'] !== 'silent',
  ...(webDir ? { webDir } : {}),
});

server.app = app;

if (tokenGenerated) {
  console.log(`Token generated and stored in ${config.configPath}`);
}
try {
  const port = await app.listen();
  // `galactic start` watches for this line to print its banner and open the browser.
  console.log(`GalacticAgents Mission Control listening on http://${config.host}:${port}`);
} catch (error) {
  console.error('[server] listen:', error instanceof Error ? error.message : error);
  shutdown(1);
}
