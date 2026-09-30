import { describeAdapterConformance } from '../conformance.js';
import { FakeAdapter } from './fake-adapter.js';

// Progress survives an in-process "restart": every adapter of this file shares the map.
const sessionStore = new Map<string, number>();

describeAdapterConformance({
  name: 'fake',
  runtime: 'fake',
  cwd: '/tmp',
  create: async () => {
    const adapter = new FakeAdapter({ speed: 1, sessionStore });
    return { adapter, dispose: () => adapter.dispose() };
  },
  prompts: {
    finish: 'scenario:happy',
    ask: 'scenario:asks',
    permission: 'scenario:permission',
    long: 'scenario:long',
    echo: 'scenario:echo',
    stall: 'scenario:stalls',
  },
  metered: true,
  resumable: true,
  stallThresholdMs: 150,
  timeoutMs: 4_000,
});
