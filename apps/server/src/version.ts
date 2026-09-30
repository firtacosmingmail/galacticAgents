import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const SERVER_VERSION: string = pkg.version;
