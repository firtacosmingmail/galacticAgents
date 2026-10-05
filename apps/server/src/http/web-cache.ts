import { basename, relative, sep } from 'node:path';

/**
 * HTTP caching of the built web app (P7-01, TECHNOLOGY §2.4). The service worker, the page and the
 * manifest are revalidated on every load (`no-cache`), so a new deploy is seen at once and the
 * browser finds a new `sw.js` (a long-cached worker would pin an old shell for up to a day);
 * content-hashed build files (`/assets/*`) never change under their name and are cached for a
 * year; everything else (icons) for an hour.
 */
export function webCacheControl(root: string, file: string): string {
  const path = relative(root, file);
  const name = basename(path);
  if (name === 'sw.js' || name === 'index.html' || name.endsWith('.webmanifest')) {
    return 'no-cache';
  }
  if (path.split(sep)[0] === 'assets') return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/** Paths that name a file of the build: a miss is a 404, never the single-page fallback. */
export function isWebFile(url: string): boolean {
  const path = url.split('?')[0]!;
  return (
    path.startsWith('/assets/') ||
    path.startsWith('/icons/') ||
    path === '/sw.js' ||
    path === '/manifest.webmanifest'
  );
}
