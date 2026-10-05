import { cpSync, mkdirSync, rmSync } from 'node:fs';
// Start clean: a renamed or removed migration must not linger in dist (loadMigrations
// refuses a numbering gap or a duplicate number).
rmSync('dist/db/migrations', { recursive: true, force: true });
mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
