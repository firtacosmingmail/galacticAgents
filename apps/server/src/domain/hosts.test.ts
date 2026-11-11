import { describe, expect, it } from 'vitest';
import { hostOfUrl, hostsOfCommand } from './hosts.js';

const none = (...w: string[]) => expect(hostsOfCommand(w)).toBeUndefined();

describe('hostsOfCommand, understood commands', () => {
  it('reads curl and wget URLs, lower-cased and sorted', () => {
    expect(hostsOfCommand(['curl', '-s', 'https://API.GitHub.com/x'])).toEqual(['api.github.com']);
    expect(hostsOfCommand(['curl', '-fsSL', 'https://api.github.com/repos/o/r'])).toEqual([
      'api.github.com',
    ]);
    expect(hostsOfCommand(['wget', 'http://example.org/a'])).toEqual(['example.org']);
    expect(hostsOfCommand(['wget', '-q', '-O', 'out.html', 'https://example.org/a'])).toEqual([
      'example.org',
    ]);
    expect(hostsOfCommand(['curl', 'https://b.com/1', 'https://a.com', 'https://b.com/2'])).toEqual(
      ['a.com', 'b.com'],
    );
    expect(hostsOfCommand(['curl', '-I', 'https://ok.com'])).toEqual(['ok.com']);
    expect(hostsOfCommand(['curl', '-sS', '-H', 'A:b', '-o', 'f', 'https://ok.com'])).toEqual([
      'ok.com',
    ]);
  });
  it('reads read-only gh subcommands as github.com', () => {
    expect(hostsOfCommand(['gh', 'pr', 'view', '83'])).toEqual(['github.com']);
    expect(hostsOfCommand(['gh', 'pr', 'diff', '83'])).toEqual(['github.com']);
    expect(
      hostsOfCommand(['gh', 'pr', 'view', '83', '--json', 'body,title', '--jq', '.title']),
    ).toEqual(['github.com']);
    expect(hostsOfCommand(['gh', 'api', 'repos/o/r/pulls', '--paginate'])).toEqual(['github.com']);
  });
});

describe('hostsOfCommand fails closed', () => {
  it('extra or hidden destinations', () => {
    none('curl', 'https://ok.com', 'evil.com');
    none('curl', '-x', 'evil.com:80', 'https://ok.com');
    none('curl', '--proxy=evil.com:80', 'https://ok.com');
    none('curl', '--config', 'f', 'https://ok.com');
    none('wget', '-i', 'urls.txt', 'https://ok.com');
    none('wget', '--input=urls.txt', 'https://ok.com');
    none('wget', '--post-d=a=b', 'https://ok.com');
    none('curl', 'https://ok.com\\@evil.com/');
    none('curl', 'https://ok.com@evil.com/');
    none('curl', 'https://{ok.com,evil.com}/');
    none('curl', '--', 'https://ok.com');
    none('curl');
  });
  it('commands that send data or use unknown options', () => {
    none('curl', '-d', '@secrets.json', 'https://ok.com');
    none('curl', '-X', 'POST', 'https://ok.com');
    none('curl', '-k', 'https://ok.com');
    none('curl', '--dat=x', 'https://ok.com');
    none('wget', '--post-data=a=b', 'https://ok.com');
    none('curl', '-H');
  });
  it('git and httpie are never host-coverable', () => {
    none('git', 'clone', 'https://gitlab.com/a/b');
    none('git', 'fetch', 'origin');
    none('git', 'clone', '-s', 'https://evil.com/x', 'https://ok.com/y');
    none('git', 'clone', '--recurse-sub', 'https://ok.com/x');
    none(
      'git',
      'clone',
      '--conf=url.https://evil.com/.insteadOf=https://ok.com/',
      'https://ok.com/x',
    );
    none('git', 'clone', '--bundle-uri=https://evil.com/b', 'https://ok.com/x');
    none('http', 'https://ok.com');
    none('http', '--sorted', 'https://evil.com', 'https://ok.com');
    none('http', 'GET', 'https://ok.com', 'X-A:b');
    none('npm', 'install');
  });
  it('gh: only plain read-only forms', () => {
    none('gh', 'pr', 'view', '-R', 'ghe.corp/o/r');
    none('gh', 'pr', 'view', '--repo', 'o/r', '83');
    none('gh', 'pr', 'view', '--hostname', 'ghe.corp');
    none('gh', 'pr', 'view', 'https://ghe.corp/o/r/pull/1');
    none('gh', 'repo', 'view', 'ghe.corp/o/r');
    none('gh', 'gist', 'create', 'f');
    none('gh', 'pr', 'create');
    none('gh', 'api', 'https://evil.com/x');
    none('gh', 'api', '-X', 'DELETE', 'repos/o/r');
    none('gh', 'api', 'repos/o/r', '-f', 'a=b');
    none('gh', 'api', 'repos/o/r', '--hostname', 'ghe.corp');
    none('gh');
  });
  it('any environment assignment or line-level environment', () => {
    none('GH_HOST=ghe.corp', 'gh', 'pr', 'view');
    none('GH_REPO=ghe.corp/o/r', 'gh', 'pr', 'view', '1');
    none('CURL_HOME=/w', 'curl', 'https://ok.com');
    none('HTTPS_PROXY=http://evil.com', 'curl', 'https://ok.com');
    none('GIT_CONFIG_PARAMETERS=x', 'git', 'clone', 'https://ok.com/x');
    expect(hostsOfCommand(['gh', 'pr', 'view', '83'], { lineSetsEnv: true })).toBeUndefined();
    expect(hostsOfCommand(['curl', 'https://ok.com'], { lineSetsEnv: true })).toBeUndefined();
  });
});

describe('hostsOfCommand, shell expansion and the program word', () => {
  it('any shell-special word is not understood', () => {
    none('curl', '-H', '{a,-xevil.com:80}', 'https://ok.com');
    none('curl', '-H', 'a${IFS}-xevil.com:80', 'https://ok.com');
    none('curl', '-H', '$_', 'https://ok.com');
    none('curl', '-H', '$(echo -x evil.com:80)', 'https://ok.com');
    none('curl', '-H', '$X', 'https://ok.com');
    none('curl', '-H', '*', 'https://ok.com');
    none('curl', 'https://github.com????????');
    none('curl', 'https://ok.com/a?b=1');
    none('curl', '-H', 'A: b', 'https://ok.com');
    none('wget', '-O', '{a,-ievil.txt}', 'https://ok.com');
    none('gh', 'pr', 'view', '83', '--jq', '{a,-Rghe.corp/o/r}');
    none('curl', '-o', '~/f', 'https://ok.com');
  });
  it('the program word is exactly curl, wget or gh', () => {
    none('./curl', 'https://ok.com');
    none('/usr/bin/curl', 'https://ok.com');
    none('./gh', 'pr', 'view', '1');
  });
  it('gh auth status checks every configured host; auth token stays', () => {
    none('gh', 'auth', 'status');
    expect(hostsOfCommand(['gh', 'auth', 'token'])).toEqual(['github.com']);
  });
  it('a redirect hides the hosts', () => {
    expect(hostsOfCommand(['curl', 'https://ok.com'], { hasRedirect: true })).toBeUndefined();
  });
});

describe('hostOfUrl', () => {
  it('lower-cases http(s) hosts and rejects the rest', () => {
    expect(hostOfUrl('https://Docs.RS/x')).toBe('docs.rs');
    expect(hostOfUrl('ftp://a.com')).toBeUndefined();
    expect(hostOfUrl('not a url')).toBeUndefined();
  });
});
