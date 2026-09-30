import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';
import { openDatabase } from './db/database.js';
import { EventLog } from './domain/event-log.js';

const { config, tokenGenerated } = loadConfig();

const log = new EventLog(openDatabase(config.dbPath));

const webDir = process.env['GALACTIC_WEB_DIR'];
const app = buildApp({
  config,
  log,
  logger: process.env['GALACTIC_LOG'] !== 'silent',
  ...(webDir ? { webDir } : {}),
});

const port = await app.listen();
console.log(`GalacticAgents Mission Control listening on http://${config.host}:${port}`);
if (tokenGenerated) {
  console.log(`Token generated and stored in ${config.configPath}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
