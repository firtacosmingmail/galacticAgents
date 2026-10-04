import { mkdirSync } from 'node:fs';
import { loadConfig } from './config/config.js';
import { SettingsService } from './config/settings.js';
import { setGlobalDefaultPolicy } from './domain/permissions.js';
import { buildApp } from './app.js';
import {
  harmonizerBrain,
  harmonizerRuntime,
  startHarmonizer,
  type HarmonizerDeps,
} from './brains/harmonizer/index.js';
import { harmonizerRestarter } from './brains/harmonizer/restart.js';
import { PromotionFlow } from './brains/promotion.js';
import { waykeeperDefinition } from './brains/waykeeper/index.js';
import { ClaudeSdkAdapter } from './adapters/claude-sdk/index.js';
import { FakeAdapter } from './adapters/fake/fake-adapter.js';
import { openDatabase } from './db/database.js';
import { ARCHIVAL_INTERVAL_MS } from './runtime/archival.js';
import { composeRuntime } from './runtime/compose.js';
import { SqliteProcessStore } from './runtime/process-store.js';
import { ProcessSupervisor } from './runtime/supervisor.js';
import { Workspaces } from './workspace/workspaces.js';

const { config, tokenGenerated } = loadConfig();
// The global default permission table from the settings (P25-01), before any agent runs.
setGlobalDefaultPolicy(config.defaultPermissionPolicy);
const onError = (error: unknown, context: string) =>
  console.error(`[runtime] ${context}:`, error instanceof Error ? error.message : error);

const db = openDatabase(config.dbPath);
// The supervisor owns every agent child process; its PID table lives in the same database.
const supervisor = new ProcessSupervisor({ store: new SqliteProcessStore(db) });
const reconciled = supervisor.reconcile();
if (reconciled.dead.length + reconciled.orphans.length > 0) {
  console.log(
    `Reconciled the process table: ${reconciled.dead.length} dead, ${reconciled.orphans.length} orphaned (killed)`,
  );
}

// Adapters: the fake one always (dev mode without Claude), the real one for Claude Code.
const fake = new FakeAdapter();
const composed = composeRuntime(db, {
  adapters: [
    fake,
    new ClaudeSdkAdapter({
      supervisor,
      ...(process.env['GALACTIC_MODEL'] ? { model: process.env['GALACTIC_MODEL'] } : {}),
      // SPEC §8 open question: Stewards load `~/.claude` unless the settings say not (P25-01).
      ...(config.stewardsLoadUserSettings === false
        ? { stewardSettingSources: ['project', 'local'] as ('project' | 'local')[] }
        : {}),
      onError,
    }),
  ],
  // Brain tools create worktrees and merge through this service (P2-05, P2-10).
  workspaces: { projectsRoot: config.projectsRoot, dataDir: config.dataDir },
  onError,
  autoApproveRemote: config.autoApproveRemote,
  // Spawn caps (decision 18, P2-17): concurrency, Stewards per Waykeeper, spawns per hour.
  caps: config.caps,
  // Finished work past decision 4's retention period is archived hourly (P2-13).
  archival: { retentionMs: config.retentionMs, intervalMs: ARCHIVAL_INTERVAL_MS },
  // Stewards' leftover processes (P4-14): attributed from the supervisor's process groups.
  processes: { groups: supervisor },
});
const { log, statuses, transcripts } = composed;
// The settings page (P25-01): caps and retention apply live through the runtime and the job.
const settings = new SettingsService({
  config,
  caps: composed.runtime.caps,
  archival: composed.archival,
});

// Shutdown is wired before anything is resumed or listening (P1-32): a signal during recovery
// or a failed listen still interrupts the agents and saves their sessions.
const server: { app?: ReturnType<typeof buildApp> } = {};
let promotions: PromotionFlow | undefined;
let shuttingDown = false;
// Every agent is stopped in parallel, each within the supervisor's grace + term periods; the
// deadline leaves room for that plus the flushes around it.
const SHUTDOWN_DEADLINE_MS = 10_000 + 5_000 + 10_000;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    console.error('shutdown deadline reached: exiting');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  // The promotion flow stops with the runtime: no card is carried out while agents are stopping.
  promotions?.stop();
  void composed
    .shutdown()
    .catch((error) => console.error('[runtime] shutdown:', error))
    .then(() => supervisor.dispose())
    .catch((error) => console.error('[supervisor] dispose:', error))
    .then(() => server.app?.close())
    .catch((error) => console.error('[server] close:', error))
    .then(() => process.exit(code));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      console.error('second signal: exiting now');
      process.exit(1);
    }
    shutdown(0);
  });
}

// Promotion cards are carried out by the server once the user approves them (P2-12): the move,
// the new project's Waykeeper and the Steward hand-over. The flow starts after the Harmonizer
// (below), so cards approved before a restart find their supervisor running.
const startWaykeeper = async (input: {
  projectId: string;
  supervisorId: string;
  runtime: Parameters<typeof composed.startBrain>[1]['runtime'];
}) => {
  const runner = await composed.startBrain(waykeeperDefinition(), input);
  return { agentId: runner.agentId };
};

// The brains' definitions, before recovery (P2-16): an interrupted Harmonizer or Waykeeper comes
// back through its runner — tools, system prompt, mailbox — not as a bare session.
const hqRuntime = harmonizerRuntime(process.env['GALACTIC_HARMONIZER']);
mkdirSync(config.projectsRoot, { recursive: true });
const workspaces =
  composed.workspaces ??
  new Workspaces({ projectsRoot: config.projectsRoot, dataDir: config.dataDir });
const harmonizerDeps: HarmonizerDeps = {
  projectsRoot: workspaces.projectsRoot,
  checkPath: (path) => workspaces.checkPath(path),
  runtime: hqRuntime ?? (config.dev ? 'fake' : 'claude-sdk'),
  // `spawn_waykeeper` starts a Waykeeper brain (P2-10) for the approved project.
  startWaykeeper,
};
composed.defineBrains({
  harmonizer: () => harmonizerBrain(harmonizerDeps),
  waykeeper: () => waykeeperDefinition(),
});

// Resume what the previous server life left running (SPEC decision 8): supervisors first.
const recovery = await composed.recover();
if (recovery.resumed.length + recovery.needAttention.length > 0) {
  console.log(
    `Recovered: ${recovery.resumed.length} agents resumed, ${recovery.needAttention.length} need attention`,
  );
}
// The panel's "Restart Harmonizer" (P5-06): on the last Harmonizer's runtime, else the boot one.
const restartHarmonizer = harmonizerRestarter(composed, {
  ...(hqRuntime ? { defaultRuntime: hqRuntime } : {}),
  cwd: workspaces.projectsRoot,
  deps: harmonizerDeps,
  onError,
});
const webDir = process.env['GALACTIC_WEB_DIR'];
const app = buildApp({
  config,
  log,
  statuses,
  transcripts,
  runtime: composed.runtime,
  commands: composed.commands,
  ...(composed.processes ? { processes: composed.processes } : {}),
  settings,
  restartHarmonizer: async () => {
    const hq = await restartHarmonizer();
    console.log(
      `Harmonizer restarted by the user (${hq.agentId})` +
        (hq.replaced ? `, replacing ${hq.replaced}` : ''),
    );
    return hq;
  },
  scenarios: () => fake.scenarioNames(),
  logger: process.env['GALACTIC_LOG'] !== 'silent',
  ...(webDir ? { webDir } : {}),
});

server.app = app;

if (tokenGenerated) {
  console.log(`Token generated and stored in ${config.configPath}`);
}
try {
  const port = await app.listen();
  // `galactic start` watches for this line to print its banner and open the browser.
  console.log(`GalacticAgents Mission Control listening on http://${config.host}:${port}`);
} catch (error) {
  console.error('[server] listen:', error instanceof Error ? error.message : error);
  shutdown(1);
}

// The Harmonizer starts with the application and is idle otherwise (SPEC §2.1, P2-08). One at a
// time (decision 32): one that recovery resumed is left running.
if (hqRuntime && !shuttingDown) {
  try {
    const hq = await startHarmonizer(composed, {
      runtime: hqRuntime,
      cwd: workspaces.projectsRoot,
      deps: harmonizerDeps,
    });
    console.log(
      hq.status === 'started'
        ? `Harmonizer started on ${hqRuntime} (${hq.agentId})` +
            (hq.replaced ? `, replacing ${hq.replaced} (another runtime)` : '')
        : `Harmonizer resumed on ${hqRuntime} (${hq.agentId})`,
    );
  } catch (error) {
    console.error('[harmonizer] start:', error instanceof Error ? error.message : error);
  }
  // From now on a Harmonizer that ends (other than by the user's stop) is replaced (P2-16).
  if (!shuttingDown) {
    composed.keepHarmonizer(async () => {
      const hq = await startHarmonizer(composed, {
        runtime: hqRuntime,
        cwd: workspaces.projectsRoot,
        deps: harmonizerDeps,
      });
      if (hq.status === 'started') console.log(`Harmonizer restarted (${hq.agentId})`);
    });
  }
}
// The Harmonizer tells the user what the restart recovered (SPEC §5: "recovered: N resumed, M need
// attention"), in its chat.
if (!shuttingDown) composed.announceRecovery(recovery);

// After recovery and the Harmonizer: a resumed Waykeeper is found running instead of doubled, an
// approved card left unrecorded is carried out under a running Harmonizer, and the Stewards of
// cards still waiting for the user are paused again (a pause does not survive a restart).
if (!shuttingDown) {
  promotions = new PromotionFlow({
    log,
    commands: composed.commands,
    liveAgents: () => composed.runtime.liveAgents(),
    startWaykeeper,
    onError,
  }).start();
}
