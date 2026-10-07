import { afterEach, describe, expect, it } from 'vitest';
import { DeliverablesUsageResponse } from '@galactic/protocol';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/** P9-06 — `GET /api/deliverables/usage`: bearer-guarded, the folders' sizes. */

const apps: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

describe('GET /api/deliverables/usage (P9-06)', () => {
  it("lists each project's deliverables folder with its size, behind the bearer token", async () => {
    const folders = [{ projectId: 'p-1', path: '/w/a/deliverables', bytes: 1234 }];
    const t = await startTestApp({
      deliverableCopies: {
        usage: async () => ({ folders }),
        copyIn: () => Promise.reject(new Error('not used')),
      },
    });
    apps.push(t);
    const res = await fetch(`${t.baseUrl}/api/deliverables/usage`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(DeliverablesUsageResponse.parse(await res.json())).toEqual({ folders });
    const anonymous = await fetch(`${t.baseUrl}/api/deliverables/usage`);
    expect(anonymous.status).toBe(401);
  });
});
