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
