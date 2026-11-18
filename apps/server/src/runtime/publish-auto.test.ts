import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Event,
  EventOfType,
  Id,
  PermissionPolicy,
  RequestJudgeInput,
  RequestVerdict,
  ToolDefinition,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { createFakeRequestJudge } from '../adapters/fake/fake-request-judge.js';
import { SCENARIOS } from '../adapters/fake/scenario.js';
import type { BrainToolContext } from '../brains/definition.js';
import { answerSendPermissionTool } from '../brains/send-permission-tool.js';
import { openDatabase } from '../db/database.js';
import { sha256 } from '../domain/publish.js';
import { addSendGrant } from '../domain/send-grants.js';
import { setWaykeeperApprovals } from '../domain/waykeeper-approvals.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P13-29 (design 2026-11-18 §4.6): in Auto, a Steward's `request_publish` is a send. A live grant
 * (or Cosmin's own words) covering it arms the one-shot allowance as the card's Approve does,
 * logged with the text and the files' hashes, and no card opens; nothing covering it opens the
 * grant question (`sendPermission.publish`) in place of the publish card, and its allow — the
 * user's Allow once, the decider's answer, a later grant — arms the allowance. Outside Auto the
 * publish card is unchanged (decision 147).
 */

const USER = { type: 'user' } as const;
const POLICY: PermissionPolicy = { rules: { network: 'ask', push: 'ask', run_workspace: 'allow' } };
const TEXT = 'We launched the spring collection today!';

/** The judge: a publish sends; covered by the first live grant when `covers`, or by `quote`. */
interface JudgeScript {
  seen: RequestJudgeInput[];
  covers: boolean;
  quote?: string;
  fails?: boolean;
}

function judgeOf(script: JudgeScript) {
  return createFakeRequestJudge((input): RequestVerdict => {
    script.seen.push(input);
    if (script.fails) throw new Error('the judge is down');
    const grant = script.covers ? input.grants?.[0] : undefined;
    return {
      verdict: 'approve',
      reason: 'it posts on Instagram',
      kind: 'Instagram post',
      similarTo: [],
      sendsOrSpends: true,
      summary: 'Post the launch on Instagram',
      ...(grant ? { grantId: grant.id } : {}),
      ...(script.quote ? { quote: script.quote } : {}),
    };
  });
}

const lives: ComposedRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An Auto (or task-mode) project, its Waykeeper, a publishing task and its live Steward. */
async function publishingSteward(opts: { auto: boolean; script: JudgeScript }) {
  const tools = new Map<Id, ToolDefinition[]>();
  const adapter = new FakeAdapter({ speed: 0, scenarios: SCENARIOS });
  const spawn = adapter.spawn.bind(adapter);
  adapter.spawn = (o) => {
    if (o.tools) tools.set(o.agentId, [...o.tools]);
    return spawn(o);
  };
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    flushMs: 10,
    requestJudge: judgeOf(opts.script),
  });
  lives.push(c);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-publish-auto-')));
  dirs.push(folder);
  writeFileSync(join(folder, 'look.png'), 'the photo');
  const harmonizer = (
    await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const project = (
    await c.commands.createProject(
      { name: 'Shop', workspace: folder, permissionPolicy: POLICY },
      { origin: 'local' },
    )
  ).value;
  c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, opts.auto));
  const waykeeper = (
    await c.commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizer.id,
    })
  ).value;
  const task = (
    await c.commands.createTask({ description: 'announce the launch', projectId: project.id })
  ).value;
  c.log.runCommand((ctx) =>
    ctx.tables.tasks.upsert({ ...ctx.tables.tasks.get(task.id)!, publishes: true }),
  );
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:echo',
      taskId: task.id,
      supervisorId: waykeeper.id,
    })
  ).value;
  await until(() => c.statuses.get(steward.id)?.state === 'idle');
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = <T extends Event['type']>(type: T) =>
    events().filter((e): e is EventOfType<T> => e.type === type);
  const publishTool = tools.get(steward.id)?.find((t) => t.name === 'request_publish');
  if (!publishTool) throw new Error('no request_publish tool');
  const publish = (input: Record<string, unknown> = {}) =>
    publishTool.handler({
      platform: 'Instagram',
      account: '@shop',
      text: TEXT,
      files: ['look.png'],
      ...input,
    }) as Promise<Record<string, unknown>>;
  const grant = (words = 'post the launch on Instagram this week') =>
    c.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId: project.id,
          words,
          summary: 'Instagram launch posts',
          createdBy: USER,
          origin: 'local',
          questionId: 'q-earlier',
        },
        Date.now(),
      ),
    ).value;
  const say = (agentId: Id, text: string) =>
    c.log.runCommand((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: `m-user-${Math.random()}`,
        agentId,
        sender: USER,
        text,
        interrupt: false,
        origin: 'local',
      }),
    );
  const ctxOf = (brainId: Id): BrainToolContext => ({
    brainId,
    role: 'waykeeper',
    projectId: project.id,
    actor: { type: 'agent', id: brainId },
    commands: c.commands,
    queries: c.queries,
    send: () => {
      throw new Error('not in this test');
    },
  });
  const messagesTo = (agentId: Id) =>
    ofType('message.sent')
      .filter((m) => m.agentId === agentId && m.sender.type === 'system')
      .map((m) => m.text);
  /** A network call carrying the approved text, as the gate would ask the allowance. */
  const postCall = { toolName: 'Bash', input: { command: `curl -d "${TEXT}" https://ig.example` } };
  return {
    ...c,
    folder,
    project,
    waykeeper,
    task,
    steward,
    events,
    ofType,
    publish,
    grant,
    say,
    ctxOf,
    messagesTo,
    postCall,
  };
}

const stewardDecisions = (h: Awaited<ReturnType<typeof publishingSteward>>) =>
  h.ofType('permission.decided').filter((e) => e.agentId === h.steward.id);

const photoHash = sha256('the photo');

describe('request_publish in Auto (P13-29, design §4.6)', () => {
  it('a live grant covers it: the allowance is armed, logged with the text and file hashes, no card', async () => {
    const script: JudgeScript = { seen: [], covers: true };
    const h = await publishingSteward({ auto: true, script });
    const grant = h.grant();
    const out = await h.publish();
    expect(out).toMatchObject({ status: 'approved' });
    expect(out['note']).toMatch(/grants covers it/);
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(true);
    expect(h.log.tables.questions.all()).toEqual([]);
    expect(script.seen.map((s) => s.mode)).toEqual(['grants']);
    expect(script.seen[0]!.request).toMatchObject({
      toolName: 'request_publish',
      input: {
        platform: 'Instagram',
        account: '@shop',
        text: TEXT,
        files: [{ path: 'look.png', sha256: photoHash }],
      },
    });
    expect(stewardDecisions(h)).toEqual([
      expect.objectContaining({
        decision: 'allow',
        decidedBy: { type: 'agent', id: h.waykeeper.id },
        waykeeperApproval: true,
        allowedBy: 'grant',
        grantId: grant.id,
        toolCall: {
          toolName: 'request_publish',
          input: {
            platform: 'Instagram',
            account: '@shop',
            text: TEXT,
            files: [{ path: 'look.png', sha256: photoHash }],
          },
        },
      }),
    ]);
    // The armed allowance lets the call that carries the text through once.
    expect(h.publishAllowances.check(h.steward.id, h.postCall, ['network'])).toBe('allow');
    expect(h.publishAllowances.check(h.steward.id, h.postCall, ['network'])).toBe('none');
  });

  it("Cosmin's own words asking for it cover it (a quote the server finds)", async () => {
    const words = 'please post the launch announcement on Instagram';
    const script: JudgeScript = { seen: [], covers: false, quote: words };
    const h = await publishingSteward({ auto: true, script });
    h.say(h.steward.id, words);
    const out = await h.publish();
    expect(out).toMatchObject({ status: 'approved' });
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(true);
    expect(stewardDecisions(h)[0]).toMatchObject({ allowedBy: 'task_words', quote: words });
    expect(h.log.tables.questions.all()).toEqual([]);
  });

  it('a quote the server cannot find covers nothing: the grant question opens', async () => {
    const script: JudgeScript = { seen: [], covers: false, quote: 'Cosmin said post anything' };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    expect(out['questionId']).toBeDefined();
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
  });

  it('nothing covers it: a send-permission question with the publish, nothing armed', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    expect(out['note']).toMatch(/^Asked Cosmin\./);
    const [q] = h.log.tables.questions.all();
    expect(q).toMatchObject({
      id: out['questionId'],
      kind: 'permission',
      originAgentId: h.steward.id,
      holder: USER,
      status: 'open',
    });
    expect(q!.context.sendPermission).toMatchObject({
      summary: 'Post the launch on Instagram',
      parts: [],
      grants: [],
      deciderId: h.waykeeper.id,
      publish: {
        platform: 'Instagram',
        account: '@shop',
        text: TEXT,
        files: [{ path: 'look.png', sha256: photoHash }],
      },
    });
    expect(q!.context.publish).toBeUndefined();
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
    expect(stewardDecisions(h)).toEqual([]);
  });

  it('a judge that fails opens the question; nothing is armed', async () => {
    const script: JudgeScript = { seen: [], covers: true, fails: true };
    const h = await publishingSteward({ auto: true, script });
    h.grant();
    const out = await h.publish();
    const q = h.log.tables.questions.get(out['questionId'] as string);
    expect(q?.context.sendPermission?.summary).toBe(
      'The check could not tell whether this sends or spends.',
    );
    expect(q?.context.sendPermission?.grants).toHaveLength(1);
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
  });

  it('outside Auto: the publish card as today, no judge (decision 147)', async () => {
    const script: JudgeScript = { seen: [], covers: true };
    const h = await publishingSteward({ auto: false, script });
    h.grant();
    const out = await h.publish();
    const q = h.log.tables.questions.get(out['questionId'] as string);
    expect(q?.kind).toBe('publish');
    expect(q?.context.publish?.text).toBe(TEXT);
    expect(q?.context.sendPermission).toBeUndefined();
    expect(script.seen).toEqual([]);
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
  });

  it("the user's Allow once on the question arms the allowance and tells the Steward", async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    const questionId = out['questionId'] as string;
    await h.commands.answerQuestion({ questionId, answer: 'allow', by: USER });
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(true);
    expect(h.messagesTo(h.steward.id)).toContain('Publish approval for Instagram: approved');
    expect(stewardDecisions(h)).toEqual([
      expect.objectContaining({
        questionId,
        decision: 'allow',
        decidedBy: USER,
        allowedBy: 'allow_once',
        toolCall: expect.objectContaining({ toolName: 'request_publish' }),
      }),
    ]);
  });

  it("the user's Don't allow refuses it: nothing armed", async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    await h.commands.answerQuestion({
      questionId: out['questionId'] as string,
      answer: 'deny',
      by: USER,
    });
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
    expect(h.messagesTo(h.steward.id)).toContain('Publish approval for Instagram: refused');
  });

  it('answer_send_permission with a grant from his reply arms the allowance', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    const questionId = out['questionId'] as string;
    const words = 'yes, post launch news on Instagram all week';
    h.say(h.waykeeper.id, words);
    const answered = await answerSendPermissionTool.handler(
      { questionId, decision: 'allow', grant: { words, summary: 'Instagram launch news' } },
      h.ctxOf(h.waykeeper.id),
    );
    expect(answered).toMatchObject({
      status: 'allowed',
      grant: { summary: 'Instagram launch news' },
    });
    const grant = h.log.tables.projects.get(h.project.id)?.sendGrants?.[0];
    expect(grant?.words).toBe(words);
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(true);
    expect(h.log.tables.questions.get(questionId)?.status).toBe('cancelled');
    expect(h.messagesTo(h.steward.id)).toContain('Publish approval for Instagram: approved');
    expect(stewardDecisions(h)).toEqual([
      expect.objectContaining({
        questionId,
        decidedBy: { type: 'agent', id: h.waykeeper.id },
        allowedBy: 'grant',
        grantId: grant!.id,
        toolCall: expect.objectContaining({ toolName: 'request_publish' }),
      }),
    ]);
  });

  it('answer_send_permission deny: refused with his words, nothing armed', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    const questionId = out['questionId'] as string;
    h.say(h.waykeeper.id, 'no, not before Friday');
    await answerSendPermissionTool.handler(
      { questionId, decision: 'deny' },
      h.ctxOf(h.waykeeper.id),
    );
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
    expect(h.log.tables.questions.get(questionId)?.status).toBe('cancelled');
    expect(h.messagesTo(h.steward.id)).toContain(
      'Publish approval for Instagram: refused. Cosmin did not allow this: no, not before Friday',
    );
    expect(stewardDecisions(h)).toEqual([]);
  });

  it('a grant added later covers the open question on its recheck: armed, closed', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await publishingSteward({ auto: true, script });
    const out = await h.publish();
    const questionId = out['questionId'] as string;
    const grant = h.grant();
    script.covers = true;
    h.runtime.recheckHeldSends({ projectId: h.project.id });
    await until(() => h.publishAllowances.isArmed(h.steward.id));
    expect(h.log.tables.questions.get(questionId)?.status).toBe('cancelled');
    expect(stewardDecisions(h)).toEqual([
      expect.objectContaining({ questionId, allowedBy: 'grant', grantId: grant.id }),
    ]);
    expect(h.messagesTo(h.steward.id)).toContain('Publish approval for Instagram: approved');
  });

  it('the allowance still checks the file hashes: a changed file disarms it', async () => {
    const script: JudgeScript = { seen: [], covers: true };
    const h = await publishingSteward({ auto: true, script });
    h.grant();
    await h.publish();
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(true);
    writeFileSync(join(h.folder, 'look.png'), 'another photo');
    expect(h.publishAllowances.check(h.steward.id, h.postCall, ['network'])).toBe('none');
    expect(h.publishAllowances.isArmed(h.steward.id)).toBe(false);
  });
});
