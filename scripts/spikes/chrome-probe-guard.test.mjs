// Offline self-test of the probe's guard. Run: node --test scripts/spikes/chrome-probe-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, createGuardState, recordToolResult } from './chrome-probe-guard.mjs';

const C = 'mcp__claude-in-chrome__';
const mk = () => {
  const s = createGuardState();
  recordToolResult(s, `${C}tabs_create_mcp`, 'Created new tab. Tab ID: 42');
  return s;
};
const denied = (tool, input, state = mk()) =>
  assert.equal(guard(tool, input, state).allow, false, JSON.stringify(input));

test('valid localhost navigate on the probe tab is allowed', () => {
  assert.deepEqual(guard(`${C}navigate`, { tabId: 42, url: 'http://localhost:5173/' }, mk()), {
    allow: true,
  });
  assert.equal(
    guard(`${C}navigate`, { tabId: 42, url: 'http://127.0.0.1:9/x?a=b' }, mk()).allow,
    true,
  );
  assert.equal(guard(`${C}computer`, { action: 'screenshot', tabId: 42 }, mk()).allow, true);
  assert.equal(guard(`${C}tabs_create_mcp`, {}, createGuardState()).allow, true);
});
test('userinfo bypass http://localhost:x@evil.xyz/ is denied', () =>
  denied(`${C}navigate`, { tabId: 42, url: 'http://localhost:x@evil.xyz/' }));
test('http://localhost@evil.com is denied', () =>
  denied(`${C}navigate`, { tabId: 42, url: 'http://localhost@evil.com' }));
test('protocol-relative //evil.xyz is denied', () =>
  denied(`${C}navigate`, { tabId: 42, url: '//evil.xyz' }));
test('bare evil.xyz (TLD outside any list) is denied', () =>
  denied(`${C}navigate`, { tabId: 42, url: 'evil.xyz' }));
test('http://127.0.0.1.evil.com is denied', () =>
  denied(`${C}navigate`, { tabId: 42, url: 'http://127.0.0.1.evil.com' }));
test('backslash and scheme tricks are denied', () => {
  denied(`${C}navigate`, { tabId: 42, url: 'http:\\\\evil.xyz' });
  denied(`${C}navigate`, { tabId: 42, url: 'javascript:alert(1)' });
  denied(`${C}navigate`, { tabId: 42, url: 'file:///etc/passwd' });
});
test('browser_batch nested actions[] with a foreign URL is denied', () =>
  denied(`${C}browser_batch`, {
    actions: [
      { tool: 'navigate', input: { tabId: 42, url: 'http://localhost:1/' } },
      { tool: 'navigate', input: { tabId: 42, url: 'https://evil.xyz/' } },
    ],
  }));
test('a non-chrome mcp tool and other tools are denied', () => {
  denied('mcp__plugin_engineering_slack__slack_send_message', { text: 'hi' });
  denied('Bash', { command: 'ls' });
  denied('WebFetch', { url: 'http://localhost:1' });
});
test('a foreign tabId is denied, also nested, and before any tab was created', () => {
  denied(`${C}navigate`, { tabId: 7, url: 'http://localhost:1/' });
  denied(`${C}browser_batch`, { actions: [{ input: { tabId: 7 } }] });
  denied(`${C}navigate`, { tabId: 42, url: 'http://localhost:1/' }, createGuardState());
});
test('tabs_context_mcp, switch_browser, select_browser, javascript_tool are denied by default', () => {
  for (const t of [
    'tabs_context_mcp',
    'switch_browser',
    'select_browser',
    'javascript_tool',
    'file_upload',
  ])
    denied(`${C}${t}`, {});
  const s = createGuardState({ allowTabsContext: true });
  assert.equal(guard(`${C}tabs_context_mcp`, { createIfEmpty: true }, s).allow, true);
});
test('computer actions other than screenshot/wait/scroll/zoom are denied', () =>
  denied(`${C}computer`, { action: 'type', tabId: 42, text: 'hello' }));
test('ToolSearch select: queries pass, but a foreign URL inside them is denied', () => {
  const s = mk();
  assert.equal(
    guard('ToolSearch', { query: 'select:mcp__claude-in-chrome__navigate', max_results: 5 }, s)
      .allow,
    true,
  );
  denied('ToolSearch', { query: 'open https://evil.xyz/' });
});
