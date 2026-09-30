import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';
import { openDatabase } from './db/database.js';
import { composeRuntime } from './runtime/compose.js';

const { config, tokenGenerated } = loadConfig();

// Adapters: the fake one always (dev mode without Claude); the claude-sdk adapter joins in P1-09.
const composed = composeRuntime(openDatabase(config.dbPath), {
  onError: (error, context) => console.error(`[runtime] ${context}:`, error),
});
const { log, statuses, transcripts } = composed;

const webDir = process.env['GALACTIC_WEB_DIR'];
const app = buildApp({
  config,
  log,
  statuses,
  transcripts,
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
      .dispose()
      .catch((error) => console.error('[runtime] dispose:', error))
      .then(() => app.close())
      .catch((error) => console.error('[server] close:', error))
      .then(() => process.exit(0));
  });
}
