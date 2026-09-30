import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';
import { send } from './ws/gateway.js';
import { openDatabase } from './db/database.js';
import { EventLog } from './domain/event-log.js';

// Entry point. P0-08 replaces the placeholder session handler with the snapshot/stream protocol.
const { config, tokenGenerated } = loadConfig();

const log = new EventLog(openDatabase(config.dbPath));

const app = buildApp({
  config,
  logger: true,
  currentSeq: () => log.currentSeq(),
  onSession(socket) {
    send(socket, { type: 'error', code: 'internal', message: 'stream not implemented yet' });
    socket.close(1011);
  },
});

const port = await app.listen();
console.log(`GalacticAgents Mission Control listening on http://${config.host}:${port}`);
if (tokenGenerated) {
  console.log(`Token (generated, stored in ${config.configPath}): ${config.token}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
