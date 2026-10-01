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
  scenarios: () => fake.scenarioNames(),
  logger: process.env['GALACTIC_LOG'] !== 'silent',
  ...(webDir ? { webDir } : {}),
});

if (tokenGenerated) {
  console.log(`Token generated and stored in ${config.configPath}`);
}
const port = await app.listen();
// `galactic start` watches for this line to print its banner and open the browser.
console.log(`GalacticAgents Mission Control listening on http://${config.host}:${port}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      console.error('second signal: exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    // Graceful shutdown: agents are interrupted and their sessions saved (P1-14 completes this).
    // A hard deadline keeps one stuck stop from holding the process open.
    const deadline = setTimeout(() => {
      console.error('shutdown deadline reached: exiting');
      process.exit(1);
    }, 15_000);
    deadline.unref();
    void composed
      .shutdown()
      .catch((error) => console.error('[runtime] shutdown:', error))
      .then(() => supervisor.dispose())
      .catch((error) => console.error('[supervisor] dispose:', error))
      .then(() => app.close())
      .catch((error) => console.error('[server] close:', error))
      .then(() => process.exit(0));
  });
}
