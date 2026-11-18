import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEvent,
  applySnapshot,
  SEND_GRANT_MAX_DAYS,
  type ApprovalMarkMatch,
  type EventEnvelope,
  type Snapshot,
} from '@galactic/protocol';
import { loadConfig } from '../config/config.js';
import { SettingsError, SettingsService } from '../config/settings.js';
import { buildSnapshot } from '../ws/snapshot.js';
import { world } from '../test/world.js';
import { DomainError } from './errors.js';
import { closeProject, createProject } from './projects.js';
import {
  addSendGrant,
  endSendGrants,
  liveGrants,
  removeSendGrant,
  standaloneAutoOn,
} from './send-grants.js';
import { addApprovalMark, removeApprovalMark, standaloneOf } from './waykeeper-approvals.js';

/** P13-24: send grants and the standalone scope as rows, each change with its event. */

const USER = { type: 'user' } as const;
const BRAIN = { type: 'agent', id: 'a-1' } as const;
const NOW = Date.parse('2026-11-18T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();
const base = {
  words: 'push my branches this week',
  summary: 'push branches',
  createdBy: USER,
  origin: 'local' as const,
  questionId: 'q-1',
};
const match: ApprovalMarkMatch = { kind: 'prefix', words: ['git', 'push'] };
const made = { example: 'git push', fromSeq: 3, by: USER, origin: 'local' } as const;

function setup() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'App', workspace: '/w/app' })).value;
  return { ...w, project };
}

describe('addSendGrant / removeSendGrant', () => {
  it('round-trips a project grant with its events and row', () => {
    const { run, tables, project } = setup();
    const added = run((ctx) =>
      addSendGrant(ctx, { ...base, projectId: project.id, endsAt: at(NOW + DAY) }, NOW),
    );
    const grant = added.value;
    expect(grant.id).toMatch(/^sg-/);
    expect(added.events).toEqual([{ type: 'send_grant.added', grant }]);
    expect(tables.projects.get(project.id)!.sendGrants).toEqual([grant]);
    const removed = run((ctx) => removeSendGrant(ctx, grant.id, USER, 'removed by the user'));
    expect(removed.events).toEqual([
      {
        type: 'send_grant.removed',
        grantId: grant.id,
        projectId: project.id,
        by: USER,
        reason: 'removed by the user',
      },
    ]);
    expect('sendGrants' in tables.projects.get(project.id)!).toBe(false);
  });

  it('round-trips a standalone grant on the standalone row', () => {
    const { run, tables } = setup();
    const grant = run((ctx) => addSendGrant(ctx, base, NOW)).value;
    expect(grant.projectId).toBeUndefined();
    expect(tables.standalone.get('standalone')!.sendGrants).toEqual([grant]);
    const removed = run((ctx) => removeSendGrant(ctx, grant.id, USER, 'gone'));
    expect(removed.events).toEqual([
      { type: 'send_grant.removed', grantId: grant.id, by: USER, reason: 'gone' },
    ]);
    expect(standaloneOf(tables).sendGrants).toEqual([]);
  });

  it('rejects an end in the past or beyond 90 days, accepts 90 days', () => {
    const { run, tables } = setup();
    for (const endsAt of [at(NOW), at(NOW - 1000), at(NOW + SEND_GRANT_MAX_DAYS * DAY + 1)]) {
      expect(() => run((ctx) => addSendGrant(ctx, { ...base, endsAt }, NOW))).toThrow(
        expect.objectContaining({ code: 'invalid' }),
      );
    }
    expect(tables.standalone.get('standalone')).toBeUndefined();
    const ok = run((ctx) =>
      addSendGrant(ctx, { ...base, endsAt: at(NOW + SEND_GRANT_MAX_DAYS * DAY) }, NOW),
    );
    expect(ok.value.endsAt).toBe(at(NOW + SEND_GRANT_MAX_DAYS * DAY));
    expect(() => run((ctx) => addSendGrant(ctx, { ...base, projectId: 'nope' }, NOW))).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('a brain cannot remove a grant: forbidden, nothing written', () => {
    const { run, tables } = setup();
    const grant = run((ctx) => addSendGrant(ctx, base, NOW)).value;
    expect(() => run((ctx) => removeSendGrant(ctx, grant.id, BRAIN, 'no'))).toThrow(DomainError);
    expect(() => run((ctx) => removeSendGrant(ctx, grant.id, BRAIN, 'no'))).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(standaloneOf(tables).sendGrants).toHaveLength(1);
    expect(() => run((ctx) => removeSendGrant(ctx, 'sg-none', USER, 'x'))).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('refuses a grant for a project that ended', () => {
    const { run, project } = setup();
    run((ctx) => closeProject(ctx, project.id, USER));
    expect(() => run((ctx) => addSendGrant(ctx, { ...base, projectId: project.id }, NOW))).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
  });
});

describe('liveGrants', () => {
  it('drops expired and removed grants, per scope', () => {
    const { run, tables, project } = setup();
    const forever = run((ctx) => addSendGrant(ctx, { ...base, projectId: project.id }, NOW)).value;
    const soon = run((ctx) =>
      addSendGrant(ctx, { ...base, projectId: project.id, endsAt: at(NOW + DAY) }, NOW),
    ).value;
    const gone = run((ctx) => addSendGrant(ctx, { ...base, projectId: project.id }, NOW)).value;
    const standalone = run((ctx) => addSendGrant(ctx, base, NOW)).value;
    run((ctx) => removeSendGrant(ctx, gone.id, USER, 'x'));
    const scope = { projectId: project.id };
    expect(liveGrants(tables, scope, NOW).map((g) => g.id)).toEqual([forever.id, soon.id]);
    expect(liveGrants(tables, scope, NOW + DAY).map((g) => g.id)).toEqual([forever.id]);
    expect(liveGrants(tables, {}, NOW)).toEqual([standalone]);
    expect(liveGrants(tables, { projectId: 'none' }, NOW)).toEqual([]);
  });
});

describe('grants end with the project', () => {
  it('closing a project removes its grants as the system: project closed', () => {
    const { run, tables, project } = setup();
    const g = run((ctx) => addSendGrant(ctx, { ...base, projectId: project.id }, NOW)).value;
    const standalone = run((ctx) => addSendGrant(ctx, base, NOW)).value;
    const closed = run((ctx) => closeProject(ctx, project.id, USER));
    expect(closed.events).toContainEqual({
      type: 'send_grant.removed',
      grantId: g.id,
      projectId: project.id,
      by: { type: 'system' },
      reason: 'project closed',
    });
    expect(tables.projects.get(project.id)!.sendGrants).toBeUndefined();
    expect(standaloneOf(tables).sendGrants).toEqual([standalone]);
  });

  it('endSendGrants on a project without grants does nothing', () => {
    const { run, project } = setup();
    expect(run((ctx) => endSendGrants(ctx, project.id, 'project closed')).events).toEqual([]);
  });
});

describe('standalone approval marks', () => {
  it('are stored on the standalone row, deduplicated, and removed by id', () => {
    const { run, tables } = setup();
    const mark = run((ctx) => addApprovalMark(ctx, undefined, match, made));
    expect(mark.events).toEqual([{ type: 'approval_mark.added', mark: mark.value }]);
    expect(mark.value.projectId).toBeUndefined();
    expect(standaloneOf(tables).approvalMarks).toEqual([mark.value]);
    expect(run((ctx) => addApprovalMark(ctx, undefined, match, made)).events).toEqual([]);
    const removed = run((ctx) => removeApprovalMark(ctx, undefined, mark.value.id, USER, 'x'));
    expect(removed.events).toEqual([
      { type: 'approval_mark.removed', markId: mark.value.id, by: USER, reason: 'x' },
    ]);
    expect(standaloneOf(tables).approvalMarks).toEqual([]);
    expect(() => run((ctx) => removeApprovalMark(ctx, undefined, 'am-x', USER, 'x'))).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('the fold and the rows agree', () => {
  it('a client folding the events holds the standalone state the snapshot reports', () => {
    const { run, log, seen } = setup();
    const grant = run((ctx) => addSendGrant(ctx, base, NOW)).value;
    run((ctx) => addApprovalMark(ctx, undefined, match, made));
    const gone = run((ctx) => addSendGrant(ctx, { ...base, questionId: 'q-2' }, NOW)).value;
    run((ctx) => removeSendGrant(ctx, gone.id, USER, 'x'));
    const snapshot = buildSnapshot(log) as Snapshot;
    expect(snapshot.standalone?.sendGrants).toEqual([grant]);
    let folded = applySnapshot({ ...snapshot, standalone: undefined } as Snapshot);
    for (const e of seen as EventEnvelope[]) folded = applyEvent(folded, e) as typeof folded;
    expect(folded.standalone).toEqual(snapshot.standalone);
  });
});

describe('standaloneAuto setting', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function settingsSetup() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-home-')));
    dirs.push(home);
    const { config } = loadConfig({ GALACTIC_HOME: join(home, '.galactic') } as NodeJS.ProcessEnv);
    const settings = new SettingsService({ config, home });
    const file = () =>
      JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, unknown>;
    return { config, settings, file, env: { GALACTIC_HOME: config.dataDir } as NodeJS.ProcessEnv };
  }
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof SettingsError) return e.code;
      throw e;
    }
    return undefined;
  };

  it('persists from this machine and survives a restart', () => {
    const { settings, file, env } = settingsSetup();
    expect(standaloneAutoOn(settings.current())).toBe(false);
    const on = settings.update({ standaloneAuto: true }, { origin: 'local' });
    expect(on.settings.standaloneAuto).toBe(true);
    expect(file()['standaloneAuto']).toBe(true);
    const again = new SettingsService({ config: loadConfig(env).config });
    expect(standaloneAutoOn(again.current())).toBe(true);
    settings.update({ standaloneAuto: false }, { origin: 'local' });
    expect('standaloneAuto' in file()).toBe(false);
    expect(standaloneAutoOn(settings.current())).toBe(false);
  });

  it('turning it on from a remote or unknown origin is refused unless autoApproveRemote', () => {
    const { settings, file } = settingsSetup();
    for (const write of [{ origin: 'remote' as const }, {}]) {
      expect(code(() => settings.update({ standaloneAuto: true }, write))).toBe('remote_settings');
    }
    expect('standaloneAuto' in file()).toBe(false);
    const ok = settings.update(
      { standaloneAuto: true },
      { origin: 'remote', autoApproveRemote: true },
    );
    expect(ok.settings.standaloneAuto).toBe(true);
  });

  it('turning it off works from anywhere', () => {
    const { settings } = settingsSetup();
    settings.update({ standaloneAuto: true }, { origin: 'local' });
    for (const write of [{ origin: 'remote' as const }, {}]) {
      settings.update({ standaloneAuto: true }, { origin: 'local' });
      const off = settings.update({ standaloneAuto: false }, write);
      expect(standaloneAutoOn(off.settings)).toBe(false);
    }
  });
});
