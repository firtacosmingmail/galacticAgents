import { describe, expect, it } from 'vitest';
import { Project } from './domain.js';
import { project } from './fixtures/domain.js';
import {
  CommandPart,
  MAX_RECORDED_APPROVALS,
  needsUserQuote,
  quoteFound,
  RecordedApproval,
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
  it('ignores whitespace differences', () => {
    expect(quoteFound('review the PR and  push it', words)).toBe(true);
  });
  it('refuses a quote that is absent', () => {
    expect(quoteFound('delete everything now please', words)).toBe(false);
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
