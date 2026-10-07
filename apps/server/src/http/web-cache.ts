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

/** A `Host` header that can be named in a policy (a name or IP, an optional port). */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The Content-Security-Policy of the app's own page (wave-3 review B1, defence in depth; TECHNOLOGY
 * §9.5, §9.9): scripts and workers from the server only (Vite's build has no inline script and no
 * `eval`; the scene's paint worker and the service worker are files of the build), no plugins, no
 * `<base>`, never framed, forms to the server only. Styles allow inline ones (React style props,
 * xterm.js's injected sheets); images `data:` and `blob:` (the viewer's pictures, a rasterised
 * SVG); the socket to this host (`ws:`/`wss:` named for older Safari, whose `'self'` missed them).
 * `host` is the request's `Host` header; without a usable one the socket falls back to `'self'`.
 */
export function webCsp(host?: string): string {
  const sockets = host !== undefined && HOST.test(host) ? ` ws://${host} wss://${host}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${sockets}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}
