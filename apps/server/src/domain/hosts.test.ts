import { describe, expect, it } from 'vitest';
import { hostOfUrl, hostsOfCommand } from './hosts.js';

describe('hostsOfCommand', () => {
  it('reads the host of a curl or wget URL, lower-cased', () => {
    expect(hostsOfCommand(['curl', '-s', 'https://API.GitHub.com/x'])).toEqual(['api.github.com']);
    expect(hostsOfCommand(['wget', 'http://example.org/a'])).toEqual(['example.org']);
  });
  it('knows gh talks to github.com unless told otherwise', () => {
    expect(hostsOfCommand(['gh', 'pr', 'view', '83'])).toEqual(['github.com']);
    expect(hostsOfCommand(['gh', 'pr', 'view', '--hostname', 'ghe.corp'])).toBeUndefined();
    expect(hostsOfCommand(['GH_HOST=ghe.corp', 'gh', 'pr', 'view'])).toBeUndefined();
  });
  it('git network commands need a URL argument', () => {
    expect(hostsOfCommand(['git', 'clone', 'https://gitlab.com/a/b'])).toEqual(['gitlab.com']);
    expect(hostsOfCommand(['git', 'fetch', 'origin'])).toBeUndefined();
    expect(hostsOfCommand(['git', 'status'])).toBeUndefined();
  });
  it('is undefined when destinations are not visible', () => {
    expect(hostsOfCommand(['npm', 'install'])).toBeUndefined();
    expect(hostsOfCommand(['curl', '--config', 'f'])).toBeUndefined();
    expect(hostsOfCommand([])).toBeUndefined();
  });
  it('skips leading assignments and de-duplicates', () => {
    expect(
      hostsOfCommand(['A=1', 'curl', 'https://b.com/1', 'https://a.com', 'https://b.com/2']),
    ).toEqual(['a.com', 'b.com']);
  });
});

describe('hostOfUrl', () => {
  it('lower-cases http(s) hosts and rejects the rest', () => {
    expect(hostOfUrl('https://Docs.RS/x')).toBe('docs.rs');
    expect(hostOfUrl('ftp://a.com')).toBeUndefined();
    expect(hostOfUrl('not a url')).toBeUndefined();
  });
});
