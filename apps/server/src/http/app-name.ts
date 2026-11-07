import { DEFAULT_APP_NAME } from '@galactic/protocol';

/**
 * The installed app's name (P8-26, SPEC decision 153). The build ships the default name
 * ("Galactic") in the manifest and the page; when `config.json` sets `appName`, the server writes
 * it into both as it serves them, so a rename needs no rebuild:
 *
 * - the manifest's `short_name` (the label under the icon on Android) and `name` (the install
 *   prompt, the app switcher);
 * - the page's `apple-mobile-web-app-title` (the label an iPhone's Add to Home Screen proposes) and
 *   its `<title>` (the browser tab, and the iPhone's fallback).
 *
 * A phone reads the name when the app is installed: an iPhone keeps the old label until the app
 * is added again; Chrome on Android may update an installed app's name on its own, later.
 */

/** The page with `name` as its title and its home-screen title. */
export function pageWithAppName(html: string, name: string): string {
  const text = escapeHtml(name);
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${text}</title>`)
    .replace(
      /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
      (_, open: string, close: string) => `${open}${text}${close}`,
    );
}

/** The manifest with `name` as its name and short name; an unreadable manifest is kept as is. */
export function manifestWithAppName(json: string, name: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(json);
  } catch {
    return json;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return json;
  return JSON.stringify({ ...manifest, name, short_name: name }, null, 2) + '\n';
}

/** The name set in the settings, or `undefined` when the build's default applies. */
export function customAppName(appName: string | undefined): string | undefined {
  return appName && appName !== DEFAULT_APP_NAME ? appName : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
