// Allowlist guard for scripts/spikes/chrome-sdk-probe.mjs. Pure functions, no I/O.
//
// guard(toolName, input, state) -> { allow: boolean, reason?: string }
//   state = createGuardState(): the probe's own tab ids, learned from the tabs_create_mcp result.
//
// Rules (everything not allowed is denied):
//  - only these tools: ToolSearch and Skill (the CLI calls them before the first Chrome call),
//    and a short list of mcp__claude-in-chrome__ tools. Every other tool, including every other
//    mcp__ server, Bash, Write, Edit, WebFetch, is denied.
//  - tabs_context_mcp, switch_browser, select_browser, list_connected_browsers are denied by
//    default: tabs_context_mcp shows the model the titles and URLs of the user's own tabs.
//    `allowTabsContext` turns tabs_context_mcp on (the recorded runs show the model calls it
//    first; it may be needed for tabs_create_mcp to work).
//  - any tabId in an input (at any depth, so browser_batch actions[] too) must be a tab the
//    probe itself created.
//  - every string in the input is checked: URL-like strings are parsed with new URL() and must
//    have hostname exactly localhost or 127.0.0.1, http(s), and no user:password@; a bare dotted
//    hostname other than those two is denied.

export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const CHROME = 'mcp__claude-in-chrome__';
const PLAIN_TOOLS = new Set(['ToolSearch', 'Skill']);
const CHROME_TOOLS = new Set([
  'tabs_create_mcp',
  'tabs_close_mcp',
  'navigate',
  'computer',
  'browser_batch',
  'read_page',
  'get_page_text',
  'find',
]);
const COMPUTER_ACTIONS = new Set(['screenshot', 'wait', 'scroll', 'zoom']);

export function createGuardState({ allowTabsContext = false } = {}) {
  return { ownTabs: new Set(), allowTabsContext };
}

/** Learn the probe's own tab id from a tool result (text of tabs_create_mcp's result). */
export function recordToolResult(state, toolName, text) {
  if (toolName !== `${CHROME}tabs_create_mcp`) return;
  const m = /"?tab[\s_]?id"?\s*[:=]?\s*(\d+)/i.exec(String(text));
  if (m) state.ownTabs.add(Number(m[1]));
}

function* walk(v, key) {
  if (typeof v === 'string') yield { key, value: v };
  else if (Array.isArray(v)) for (const x of v) yield* walk(x, key);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) yield* walk(x, k);
  else yield { key, value: v };
}

/** Returns a reason string when the URL-ish text is not strictly local, else undefined. */
export function badUrl(raw, { loose = false } = {}) {
  const s = raw.trim();
  // The authority (up to the first / ? # or backslash) must not contain a userinfo '@'.
  for (const m of s.matchAll(/(?:^|[^a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}([^/\\?#\s]*)/gi)) {
    if (m[1].includes('@')) return `userinfo in URL authority: ${m[0].trim()}`;
  }
  const candidates = new Set();
  if (
    /^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}/i.test(s) ||
    (!loose && /^[a-z][a-z0-9+.-]*:[^\s]/i.test(s))
  )
    candidates.add(s);
  for (const m of s.matchAll(/(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}[^\s'"<>)]+/gi)) candidates.add(m[0]);
  for (const c of candidates) {
    let u;
    try {
      u = new URL(/^[/\\]{2}/.test(c) ? `http:${c}` : c);
    } catch {
      return `unparseable URL: ${c}`;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return `scheme ${u.protocol} not allowed`;
    if (u.username || u.password) return `credentials in URL: ${c}`;
    if (!LOCAL_HOSTS.has(u.hostname)) return `host ${u.hostname} is not local`;
  }
  // Bare dotted hostnames (evil.xyz, www.x.com, 127.0.0.1.evil.com).
  for (const m of s.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) {
    if (!LOCAL_HOSTS.has(m[0].toLowerCase())) return `host-like text ${m[0]} is not local`;
  }
  return undefined;
}

export function guard(toolName, input, state) {
  const deny = (reason) => ({ allow: false, reason });
  if (!PLAIN_TOOLS.has(toolName)) {
    if (!toolName.startsWith(CHROME))
      return deny(`tool ${toolName} is not on the probe's allowlist`);
    const short = toolName.slice(CHROME.length);
    const ok = CHROME_TOOLS.has(short) || (short === 'tabs_context_mcp' && state.allowTabsContext);
    if (!ok) return deny(`Chrome tool ${short} is not on the probe's allowlist`);
  }
  for (const { key, value } of walk(input, undefined)) {
    if (key === 'tabId' || key === 'tab_id' || key === 'tabIds') {
      if (typeof value !== 'number' || !state.ownTabs.has(value))
        return deny(`tabId ${JSON.stringify(value)} is not the probe's own tab`);
    } else if (
      key === 'action' &&
      toolName === `${CHROME}computer` &&
      !COMPUTER_ACTIONS.has(value)
    ) {
      return deny(`computer action ${JSON.stringify(value)} not allowed`);
    } else if (typeof value === 'string') {
      const why = badUrl(value, { loose: PLAIN_TOOLS.has(toolName) });
      if (why) return deny(why);
    }
  }
  if (toolName === `${CHROME}tabs_close_mcp` && !('tabId' in (input ?? {})))
    return deny('tabs_close_mcp without a tabId');
  return { allow: true };
}
