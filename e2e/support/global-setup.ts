import { startServer } from './server.js';

/**
 * Starts one real server for the whole run (the tests run one at a time against it, each in a
 * fresh browser context) and hands its address and token to the tests through the environment.
 * The returned function is Playwright's teardown: it stops that server by its PID and removes its
 * temp directory.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startServer();
  process.env['E2E_BASE_URL'] = server.baseURL;
  process.env['E2E_TOKEN'] = server.token;
  console.log(`[e2e] server ${server.pid} on ${server.baseURL} (data in ${server.home})`);
  return server.stop;
}
