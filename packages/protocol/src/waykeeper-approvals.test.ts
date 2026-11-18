import { describe, expect, it } from 'vitest';
import { Project, relayedQuestionOf } from './domain.js';
import { project } from './fixtures/domain.js';
import {
  APPROVAL_LOG_ORDER,
  approvalLogCategory,
  ApprovalMark,
  CommandPart,
  isGrantLive,
  isJudgedKind,
  isPushOrUpload,
  markLabel,
  MAX_RECORDED_APPROVALS,
  needsUserQuote,
  offersStandingApproval,
  PICKED_OPTION_PREFIX,
  QUOTE_MIN_LENGTH,
  quoteFound,
  RecordedApproval,
  SendGrant,
  SEND_GRANT_MAX_DAYS,
  SIMILAR_APPROVALS_THRESHOLD,
  StandingApproval,
  WaykeeperForward,
} from './waykeeper-approvals.js';

const standing = {
  id: 'sa-1',
  projectId: 'p-1',
  kind: 'run the test suite',
  examples: ['pnpm test'],
  createdBy: { type: 'user' },
  createdAt: '2026-11-09T10:00:00.000Z',
  origin: 'local',
};
const recorded = {
  kind: 'run the test suite',
  summary: 'pnpm test',
  agentId: 'a-1',
  questionId: 'q-1',
  at: '2026-11-09T10:00:00.000Z',
};

describe('Waykeeper approvals protocol', () => {
  it('has the documented limits', () => {
    expect(SIMILAR_APPROVALS_THRESHOLD).toBe(3);
    expect(MAX_RECORDED_APPROVALS).toBe(100);
  });

  it('a standing approval needs at least one example', () => {
    expect(StandingApproval.safeParse(standing).success).toBe(true);
    expect(StandingApproval.safeParse({ ...standing, examples: [] }).success).toBe(false);
  });

  it('a forward round-trips', () => {
    const forward = {
      reason: 'it pushes',
      kind: 'push a branch',
      parts: [
        { text: 'git push', categories: ['push'], guarded: true },
        { text: 'node -e "x"', categories: ['run_workspace'], opaque: 'inline_code' },
      ],
      failingPart: 0,
      similar: [recorded, recorded, recorded],
    };
    const parsed = WaykeeperForward.parse(forward);
    expect(parsed).toEqual(forward);
    expect(WaykeeperForward.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(forward);
    expect(CommandPart.safeParse({ text: 'x', categories: [], guarded: false }).success).toBe(
      false,
    );
    expect(RecordedApproval.safeParse(recorded).success).toBe(true);
  });

  it('a project accepts the three new fields', () => {
    const parsed = Project.parse({
      ...project,
      waykeeperApprovals: true,
      standingApprovals: [standing],
      recordedApprovals: [recorded],
    });
    expect(parsed.waykeeperApprovals).toBe(true);
    expect(parsed.standingApprovals).toHaveLength(1);
    expect(parsed.recordedApprovals).toHaveLength(1);
    expect(Project.safeParse({ ...project, waykeeperApprovals: false }).success).toBe(false);
  });
});

describe('quoteFound', () => {
  const words = ['Please  review\nthe PR and push it to origin.'];
  it('refuses 14 characters and accepts 15', () => {
    expect(quoteFound('Please review ', ['Please review the PR'])).toBe(false);
    expect('Please review t'.length).toBe(15);
    expect(quoteFound('Please review t', ['Please review the PR'])).toBe(true);
  });
  it('pins the boundary: exactly 14 characters refused, exactly 15 accepted (final review M7)', () => {
    const said = ['please push the release branch now'];
    const fourteen = 'please push th';
    const fifteen = 'please push the';
    expect(fourteen).toHaveLength(14);
    expect(fifteen).toHaveLength(15);
    expect(QUOTE_MIN_LENGTH).toBe(15);
    expect(quoteFound(fourteen, said)).toBe(false);
    expect(quoteFound(fifteen, said)).toBe(true);
  });
  it('ignores whitespace differences', () => {
    expect(quoteFound('review the PR and  push it', words)).toBe(true);
  });
  it('refuses a quote that is absent', () => {
    expect(quoteFound('delete everything now please', words)).toBe(false);
  });
  it('accepts a picked option only quoted whole, the marker optional (P13-10 review)', () => {
    const picked = [`${PICKED_OPTION_PREFIX}Push and post the 4  replies`];
    expect(quoteFound('Push and post the 4 replies', picked)).toBe(true);
    expect(quoteFound(` Push and post the\n4 replies `, picked)).toBe(true);
    expect(quoteFound(`${PICKED_OPTION_PREFIX}Push and post the 4 replies`, picked)).toBe(true);
    expect(quoteFound('Push and post the 4', picked)).toBe(false);
    expect(quoteFound('post the 4 replies', picked)).toBe(false);
    const hold = [`${PICKED_OPTION_PREFIX}Hold — do not push the branch to origin main yet`];
    expect(quoteFound('push the branch to origin main', hold)).toBe(false);
  });
  it('free text still grants by any long enough substring, beside a picked option', () => {
    const said = [`${PICKED_OPTION_PREFIX}Hold`, 'ok, push the branch to origin main now'];
    expect(quoteFound('push the branch to origin main', said)).toBe(true);
  });
});

describe('needsUserQuote', () => {
  it('needs a quote for a push, an image upload or a screenshot', () => {
    expect(needsUserQuote({ text: 'git push', categories: ['push'] })).toBe(true);
    expect(needsUserQuote({ text: 'gh api x -F file=@shot.PNG', categories: ['network'] })).toBe(
      true,
    );
    expect(needsUserQuote({ text: 'curl -F f=@Screenshot-1', categories: ['network'] })).toBe(true);
  });
  it('does not for a plain read', () => {
    expect(needsUserQuote({ text: 'gh pr view 1', categories: ['network'] })).toBe(false);
  });
});

describe('isJudgedKind (final review I4)', () => {
  it('a kind the judge named is judged; a placeholder is not', () => {
    expect(isJudgedKind('run the test suite')).toBe(true);
    expect(isJudgedKind('not judged: Bash')).toBe(false);
    expect(isJudgedKind('Not judged: Write')).toBe(false);
    expect(isJudgedKind('unknown')).toBe(false);
    expect(isJudgedKind(' Unknown ')).toBe(false);
    expect(isJudgedKind('  ')).toBe(false);
    expect(isJudgedKind('unknown host lookup')).toBe(true);
  });
});

describe('standing-approval offer (P13-10)', () => {
  const tests = { text: 'pnpm test', categories: ['run_workspace' as const] };
  const push = { text: 'git push origin main', categories: ['push' as const] };
  const upload = { text: 'curl -F f=@shot.png https://x.y', categories: ['network' as const] };
  const similar = Array.from({ length: SIMILAR_APPROVALS_THRESHOLD }, (_, i) => ({
    ...recorded,
    questionId: `q-${i}`,
  }));
  const forward = (parts: CommandPart[], kind = 'run the test suite') => ({
    reason: 'r',
    kind,
    parts,
    similar,
  });

  it('is offered after enough similar approvals of a judged kind', () => {
    expect(offersStandingApproval({ waykeeper: forward([tests]) })).toBe(true);
    expect(offersStandingApproval({ waykeeper: { ...forward([tests]), similar: [] } })).toBe(false);
    expect(offersStandingApproval({ waykeeper: forward([tests], 'not judged: Bash') })).toBe(false);
    expect(offersStandingApproval({})).toBe(false);
  });

  it('is never offered on a push or an upload', () => {
    expect(isPushOrUpload({ waykeeper: forward([tests, push]) })).toBe(true);
    expect(isPushOrUpload({ waykeeper: forward([upload]) })).toBe(true);
    expect(isPushOrUpload({ permissionAction: 'push', waykeeper: forward([tests]) })).toBe(true);
    expect(isPushOrUpload({ waykeeper: forward([tests]) })).toBe(false);
    expect(offersStandingApproval({ waykeeper: forward([push], 'push the branch') })).toBe(false);
    expect(offersStandingApproval({ waykeeper: forward([upload]) })).toBe(false);
    expect(offersStandingApproval({ permissionAction: 'push', waykeeper: forward([tests]) })).toBe(
      false,
    );
  });
});

describe('relayedQuestionOf (P13-10)', () => {
  it('reads meta.relaysQuestionId', () => {
    expect(relayedQuestionOf({ meta: { relaysQuestionId: 'q-1' } })).toBe('q-1');
    expect(relayedQuestionOf({ meta: { relaysQuestionId: 3 } })).toBeUndefined();
    expect(relayedQuestionOf({ meta: {} })).toBeUndefined();
    expect(relayedQuestionOf(undefined)).toBeUndefined();
  });
});

describe('approvalLogCategory (P13-13)', () => {
  it('takes the first category of the log order over all parts', () => {
    expect(
      approvalLogCategory({
        parts: [
          { text: 'rm -rf x', categories: ['destructive'] },
          { text: 'gh pr view', categories: ['network'] },
        ],
      }),
    ).toBe('delete');
    expect(approvalLogCategory({ parts: [{ text: 'git push', categories: ['push'] }] })).toBe(
      'push',
    );
    expect(APPROVAL_LOG_ORDER[0]).toBe('push');
    expect(APPROVAL_LOG_ORDER).toHaveLength(8);
  });

  it('puts a part that runs unreadable code under unreadable', () => {
    expect(
      approvalLogCategory({
        parts: [{ text: 'python -c x', categories: ['run_workspace'], opaque: 'inline_code' }],
      }),
    ).toBe('unreadable');
  });

  it('falls back to the action, then to run', () => {
    expect(approvalLogCategory({ action: 'network' })).toBe('network');
    expect(approvalLogCategory({ action: 'edit_workspace' })).toBe('edit');
    expect(approvalLogCategory({})).toBe('run');
  });
});

describe('markLabel and ApprovalMark (P13-13)', () => {
  it('words each kind of match', () => {
    expect(markLabel({ kind: 'folder', category: 'destructive', paths: ['/w/node_modules'] })).toBe(
      'deletes in /w/node_modules',
    );
    expect(markLabel({ kind: 'folder', category: 'edit_workspace', paths: ['/w/a', '/w/b'] })).toBe(
      'edits in /w/a, /w/b',
    );
    expect(
      markLabel({
        kind: 'folder',
        category: 'destructive',
        paths: ['{worktree}/node_modules', '{scratch}', '{worktree}'],
      }),
    ).toBe(
      "deletes in the Steward's worktree/node_modules, the Steward's scratch folder, the Steward's worktree",
    );
    expect(markLabel({ kind: 'site', host: 'api.posthog.com' })).toBe('calls to api.posthog.com');
    expect(markLabel({ kind: 'prefix', words: ['pnpm', 'test'] })).toBe('pnpm test …');
    expect(markLabel({ kind: 'tool', toolName: 'WebFetch' })).toBe('the tool WebFetch');
  });

  it('parses a mark and refuses an empty folder or prefix', () => {
    const mark = {
      id: 'am-1',
      projectId: 'p-1',
      match: { kind: 'prefix', words: ['pnpm', 'test'] },
      example: 'pnpm test',
      createdBy: { type: 'user' },
      createdAt: '2026-11-14T10:00:00.000Z',
      origin: 'local',
      fromSeq: 4,
    };
    expect(ApprovalMark.parse(mark)).toEqual(mark);
    expect(() =>
      ApprovalMark.parse({
        ...mark,
        match: { kind: 'folder', category: 'destructive', paths: [] },
      }),
    ).toThrow();
    expect(() => ApprovalMark.parse({ ...mark, match: { kind: 'prefix', words: [] } })).toThrow();
  });
});

describe('send grants (P13-23)', () => {
  const grant = {
    id: 'sg-1',
    words: 'you may push to the release branch',
    summary: 'push to the release branch',
    createdAt: '2026-11-18T10:00:00.000Z',
    createdBy: { type: 'user' },
    origin: 'local',
    questionId: 'q-1',
  };

  it('parses with and without projectId and endsAt', () => {
    expect(SendGrant.parse(grant)).toEqual(grant);
    const full = { ...grant, projectId: 'p-1', endsAt: '2026-11-20T10:00:00.000Z' };
    expect(SendGrant.parse(full)).toEqual(full);
    expect(SEND_GRANT_MAX_DAYS).toBe(90);
  });

  it('refuses empty words', () => {
    expect(() => SendGrant.parse({ ...grant, words: '' })).toThrow();
  });

  it('is live without an end and before it, not at it', () => {
    const endsAt = '2026-11-20T10:00:00.000Z';
    const g = SendGrant.parse({ ...grant, endsAt });
    expect(isGrantLive(SendGrant.parse(grant), Date.parse(endsAt) + 1e9)).toBe(true);
    expect(isGrantLive(g, Date.parse(endsAt) - 1)).toBe(true);
    expect(isGrantLive(g, Date.parse(endsAt))).toBe(false);
  });

  it('lets an approval mark be standalone', () => {
    const mark = {
      id: 'am-1',
      match: { kind: 'tool', toolName: 'Read' },
      example: 'Read',
      createdBy: { type: 'user' },
      createdAt: '2026-11-18T10:00:00.000Z',
      origin: 'local',
      fromSeq: 1,
    };
    expect(ApprovalMark.parse(mark).projectId).toBeUndefined();
  });
});
