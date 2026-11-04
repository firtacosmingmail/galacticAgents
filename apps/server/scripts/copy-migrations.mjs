import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
// Copy first, then remove what is stale: a renamed or removed migration must not linger in dist
// (loadMigrations refuses a numbering gap or a duplicate number), and a server starting while
// the build runs never finds the folder empty.
mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
const sources = new Set(readdirSync('src/db/migrations'));
for (const file of readdirSync('dist/db/migrations')) {
  if (!sources.has(file)) rmSync(`dist/db/migrations/${file}`, { recursive: true, force: true });
}
// The scripts the Antigravity CLI runs for Mission Control (P11-05): its hook and tool server,
// copied from here into the data directory at the first Gemini Steward.
mkdirSync('dist/adapters/agy', { recursive: true });
for (const script of ['galactic-agy-hook.mjs', 'galactic-agy-tools.mjs']) {
  cpSync(`src/adapters/agy/${script}`, `dist/adapters/agy/${script}`);
}
