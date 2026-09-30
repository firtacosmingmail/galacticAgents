import { describe, expect, it } from 'vitest';
import {
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  isLoopback,
  tokenMatches,
} from './security.js';

const allowed = ['localhost', '127.0.0.1', '[::1]', '*.ts.net'];

describe('security helpers', () => {
  it('extracts host names', () => {
    expect(hostnameOf('localhost:4321')).toBe('localhost');
    expect(hostnameOf('[::1]:4321')).toBe('[::1]');
    expect(hostnameOf('MyMac.tail.ts.net')).toBe('mymac.tail.ts.net');
    expect(hostnameOf(undefined)).toBeUndefined();
  });

  it('checks the Host allow-list with wildcards', () => {
    expect(isAllowedHost('localhost:4321', allowed)).toBe(true);
    expect(isAllowedHost('127.0.0.1', allowed)).toBe(true);
    expect(isAllowedHost('mymac.tail1234.ts.net', allowed)).toBe(true);
    expect(isAllowedHost('evil.example.com', allowed)).toBe(false);
    expect(isAllowedHost('ts.net', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it('checks Origin: absent is fine, foreign is not', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
    expect(isAllowedOrigin('https://mymac.tail1234.ts.net', allowed)).toBe(true);
    expect(isAllowedOrigin('http://evil.example.com', allowed)).toBe(false);
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('file:///tmp/x.html', allowed)).toBe(false);
    expect(isAllowedOrigin('not a url', allowed)).toBe(false);
  });

  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('100.64.0.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it('compares tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });
});
