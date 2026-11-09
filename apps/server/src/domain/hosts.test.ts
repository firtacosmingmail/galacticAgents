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

describe('hostsOfCommand, conservative', () => {
  const none = (...w: string[]) => expect(hostsOfCommand(w)).toBeUndefined();
  it('rejects extra or hidden destinations', () => {
    none('curl', 'https://ok.com', 'evil.com');
    none('curl', '-x', 'evil.com:80', 'https://ok.com');
    none('curl', '--config', 'f', 'https://ok.com');
    none('wget', '-i', 'urls.txt', 'https://ok.com');
    none('curl', 'https://ok.com\\@evil.com/');
    none('curl', 'https://ok.com@evil.com/');
    none('curl', 'https://{ok.com,evil.com}/');
  });
  it('git counts only the repository argument', () => {
    none('git', 'fetch', 'evil', 'https://ok.com/x');
    none('git', 'clone', '--recurse-submodules', 'https://ok.com/x');
    none('git', '-c', 'url.x.insteadOf=y', 'clone', 'https://ok.com/x');
    expect(hostsOfCommand(['git', 'clone', '--depth', '1', 'https://ok.com/x'])).toEqual([
      'ok.com',
    ]);
  });
  it('gh is read-only and github.com only', () => {
    none('gh', 'pr', 'view', '-R', 'ghe.corp/o/r');
    none('gh', 'gist', 'create', 'f');
    none('gh', 'api', '-X', 'DELETE', 'repos/o/r');
    none('gh', 'api', 'repos/o/r', '-f', 'a=b');
    expect(hostsOfCommand(['gh', 'api', 'repos/o/r/pulls'])).toEqual(['github.com']);
    expect(hostsOfCommand(['gh', 'pr', 'view', '-R', 'o/r', '83'])).toEqual(['github.com']);
    expect(hostsOfCommand(['gh', 'pr', 'view', '83'], { ghHostSet: true })).toBeUndefined();
  });
  it('commands that send data are not host-coverable', () => {
    none('curl', '-d', '@secrets.json', 'https://ok.com');
    none('curl', '-X', 'POST', 'https://ok.com');
    none('wget', '--post-data=a=b', 'https://ok.com');
    none('http', 'POST', 'https://ok.com');
    none('http', 'https://ok.com', 'k=v');
    expect(hostsOfCommand(['curl', '-I', 'https://ok.com'])).toEqual(['ok.com']);
    expect(hostsOfCommand(['curl', '-sSL', '-H', 'A: b', 'https://ok.com'])).toEqual(['ok.com']);
    expect(hostsOfCommand(['http', 'GET', 'https://ok.com', 'X-A:b'])).toEqual(['ok.com']);
  });
});

describe('hostOfUrl', () => {
  it('lower-cases http(s) hosts and rejects the rest', () => {
    expect(hostOfUrl('https://Docs.RS/x')).toBe('docs.rs');
    expect(hostOfUrl('ftp://a.com')).toBeUndefined();
    expect(hostOfUrl('not a url')).toBeUndefined();
  });
});
