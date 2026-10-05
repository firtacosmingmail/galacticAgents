// P7-05 "airplane mode" check: headless Chrome (CDP) against the real server with harness agents.
const BASE = 'http://127.0.0.1:47851';
const CDP = 'http://127.0.0.1:9547';
const TOKEN = 'p705-test-token';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** A CDP session on one page target. */
/** A raw CDP connection. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
}

/** A tab in its own browser context: its own storage, like another device. */
async function openIsolatedTab() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  const { browserContextId } = await browser('Target.createBrowserContext', {});
  const { targetId } = await browser('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return openTab(list.find((t) => t.id === targetId));
}

async function openTab(given) {
  const target = given ?? (await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const waitFor = async (expression, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {
        /* page navigating */
      }
      await sleep(150);
    }
    return undefined;
  };
  const offline = (on) =>
    send('Network.emulateNetworkConditions', {
      offline: on,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  return { send, evaluate, waitFor, offline, close: () => ws.close(), id: target.id };
}

/** Text of the card for a question (inbox), or ''. */
const cardText = (text) => `(() => {
  const a = [...document.querySelectorAll('[aria-label="question inbox"] article')]
    .find((x) => x.getAttribute('aria-label') === 'clarification question ${text}');
  return a ? a.textContent : '';
})()`;
const inboxText = `(document.querySelector('[aria-label="question inbox"]')?.textContent ?? '')`;
const live = `!!document.querySelector('.pnl-conn-live')`;
const status = `(document.querySelector('.pnl-conn')?.className ?? '')`;
const liveRegions = `[...document.querySelectorAll('[role="status"][aria-live="polite"]')].map((n) => n.textContent).join(' | ')`;
/** Answers a question by typing in its inbox card. */
const answerIn = (text, answer) => `(() => {
  const a = [...document.querySelectorAll('[aria-label="question inbox"] article')]
    .find((x) => x.getAttribute('aria-label') === 'clarification question ${text}');
  if (!a) return 'no card';
  const input = a.querySelector('input[aria-label="answer"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(answer)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const button = [...a.querySelectorAll('button')].find((b) => b.textContent === 'Answer');
  button.click();
  return 'clicked';
})()`;

async function answeredOnServer(questionText) {
  const { body } = await api('GET', `/api/history/questions?q=${encodeURIComponent(questionText)}`);
  return (body.items ?? []).map((i) => i.question).find((q) => q?.context?.text === questionText);
}

async function main() {
  // The world: one harness project with one Steward that asks three questions of the user.
  const scenario = await api('POST', '/dev/harness/scenario', { stewards: 1, asteroid: false });
  if (scenario.status !== 200) throw new Error(`scenario: ${JSON.stringify(scenario)}`);
  const steward = scenario.body.stewardIds[0];
  const stamp = Date.now().toString(36);
  const Q1 = `Offline one ${stamp}?`;
  const Q2 = `Offline two ${stamp}?`;
  const Q3 = `Offline three ${stamp}?`;
  for (const text of [Q1, Q2, Q3]) {
    const r = await api('POST', `/dev/harness/agents/${steward}/question`, {
      kind: 'clarification',
      text,
    });
    if (r.status !== 200) throw new Error(`question: ${JSON.stringify(r)}`);
  }

  // Leftover pages of earlier runs share storage and would send this run's queue: close them.
  for (const t of await (await fetch(`${CDP}/json/list`)).json()) {
    if (t.type === 'page') await fetch(`${CDP}/json/close/${t.id}`);
  }
  const a = await openIsolatedTab();
  await a.send('Page.navigate', { url: `${BASE}/` });
  await a.waitFor(`document.readyState === 'complete'`);
  await a.evaluate(`localStorage.setItem('galactic.token', '${TOKEN}'); true`);
  await a.send('Page.reload');
  check('tab A goes live', !!(await a.waitFor(live)));
  check('tab A shows Q1', !!(await a.waitFor(`${cardText(Q1)}.length > 0`)));

  // --- 1. Airplane mode: answer, reconnect, resolved -----------------------------------------
  await a.offline(true);
  const dropped = await a.waitFor(`!${live}`, 20000);
  check('offline: the stream drops (or the browser reports offline)', !!dropped || !(await a.evaluate('navigator.onLine')), await a.evaluate(status));
  check('navigator.onLine is false', (await a.evaluate('navigator.onLine')) === false);
  check('answer while offline', (await a.evaluate(answerIn(Q1, 'answered offline'))) === 'clicked');
  const queuedText = await a.waitFor(`(${cardText(Q1)}).includes('will send when reconnected') && ${cardText(Q1)}`);
  check('the card shows the queued state', !!queuedText, String(queuedText).slice(0, 120));
  check('the live region announced it', /Answer queued|No connection/.test(await a.evaluate(liveRegions)));
  check('nothing reached the server', !(await answeredOnServer(Q1)));
  const stored = await a.evaluate(`localStorage.getItem('galactic.answers.queue')`);
  check('the queue is in localStorage, without the token', !!stored && !stored.includes(TOKEN));
  await a.offline(false);
  const sent = await a.waitFor(`${inboxText}.includes('Sent: your answer “answered offline”')`, 30000);
  check('back online: "Sent" in the inbox', !!sent);
  const onServer = await answeredOnServer(Q1);
  check('the server has the answer', onServer?.answer === 'answered offline', JSON.stringify(onServer?.meta ?? {}));
  check('recorded with its answerId', typeof onServer?.meta?.answerId === 'string');
  check('the card left the waiting list', (await a.evaluate(cardText(Q1))) === '');

  // --- 2. Stale: answered from a second tab while the first is offline -----------------------
  const b = await openIsolatedTab();
  await b.send('Page.navigate', { url: `${BASE}/` });
  await b.waitFor(`document.readyState === 'complete'`);
  await b.evaluate(`localStorage.setItem('galactic.token', '${TOKEN}'); true`);
  await b.send('Page.reload');
  check('tab B (another browser context) goes live', !!(await b.waitFor(live)));
  await a.offline(true);
  await a.waitFor(`navigator.onLine === false`);
  check('tab A answers Q2 offline', (await a.evaluate(answerIn(Q2, 'from the phone'))) === 'clicked');
  check('Q2 queued in tab A', !!(await a.waitFor(`(${cardText(Q2)}).includes('will send when reconnected')`)));
  check('tab B shows Q2', !!(await b.waitFor(`${cardText(Q2)}.length > 0`)));
  // Tab B (its own storage: another device) answers Q2 through its own card.
  check('tab B answers Q2 first', (await b.evaluate(answerIn(Q2, 'from the laptop'))) === 'clicked');
  check('tab B sees it resolved', !!(await b.waitFor(`${cardText(Q2)} === ''`)));
  await a.offline(false);
  const notSent = await a.waitFor(
    `${inboxText}.includes('Not sent: your answer “from the phone”') && ${inboxText}`,
    30000,
  );
  check('tab A: "Not sent … already answered by you on another device"', !!notSent && /already answered by you on another device or tab: “from the laptop”/.test(notSent), String(notSent).slice(0, 300));
  check('the server kept the first answer', (await answeredOnServer(Q2))?.answer === 'from the laptop');

  // --- 3. A reload while offline keeps the queue --------------------------------------------
  await a.offline(true);
  await a.waitFor(`navigator.onLine === false`);
  check('tab A answers Q3 offline', (await a.evaluate(answerIn(Q3, 'before the reload'))) === 'clicked');
  await a.waitFor(`(${cardText(Q3)}).includes('will send when reconnected')`);
  await a.send('Page.reload');
  await sleep(1500);
  const afterReload = await a.waitFor(`${inboxText}.includes('before the reload') && ${inboxText}`, 15000);
  check('after an offline reload the queued answer is listed', !!afterReload, String(afterReload).slice(0, 200));
  await a.offline(false);
  const sent3 = await a.waitFor(`${inboxText}.includes('Sent: your answer “before the reload”')`, 30000);
  check('back online after the reload: sent', !!sent3);
  check('the server has Q3', (await answeredOnServer(Q3))?.answer === 'before the reload');

  await fetch(`${CDP}/json/close/${a.id}`);
  await fetch(`${CDP}/json/close/${b.id}`);
  a.close();
  b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
