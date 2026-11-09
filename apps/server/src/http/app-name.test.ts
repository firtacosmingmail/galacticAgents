import { describe, expect, it } from 'vitest';
import { customAppName, manifestWithAppName, pageWithAppName } from './app-name.js';

describe('the app name in the page and the manifest (P8-26)', () => {
  const page =
    '<head><title>GalacticAgents</title>\n' +
    '<meta name="apple-mobile-web-app-title" content="Galactic" /></head>';

  it('replaces the title and the home-screen title, escaped', () => {
    const out = pageWithAppName(page, `A&B <x> "q" 'y' $&`);
    expect(out).toContain('<title>A&amp;B &lt;x&gt; &quot;q&quot; &#39;y&#39; $&amp;</title>');
    expect(out).toContain('content="A&amp;B &lt;x&gt; &quot;q&quot; &#39;y&#39; $&amp;" />');
  });

  it('sets the name and short name and keeps the rest; a broken manifest is kept', () => {
    const out = JSON.parse(
      manifestWithAppName('{"name":"GalacticAgents","short_name":"Galactic","id":"/"}', 'Ops'),
    ) as unknown;
    expect(out).toEqual({ name: 'Ops', short_name: 'Ops', id: '/' });
    expect(manifestWithAppName('{oops', 'Ops')).toBe('{oops');
    expect(manifestWithAppName('[1]', 'Ops')).toBe('[1]');
  });

  it('treats an unset or default name as no custom name', () => {
    expect(customAppName(undefined)).toBeUndefined();
    expect(customAppName('')).toBeUndefined();
    expect(customAppName('Galactic')).toBeUndefined();
    expect(customAppName('Ops')).toBe('Ops');
  });
});
