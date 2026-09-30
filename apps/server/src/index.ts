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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Graceful shutdown: agents are interrupted and their sessions saved (P1-14 completes this).
    void composed
      .dispose()
      .then(() => app.close())
      .then(() => process.exit(0));
  });
}
