// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  PermissionRule,
  Project,
  Question,
  SimilarPreviewResponse,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import type { ClientRules } from '../deliverables/deliverables-model.js';
import { PermissionRules } from '../status/PermissionRules.js';
import { QuestionCard } from './QuestionCard.js';

/**
 * P9-17 (SPEC decision 138): the permission card's "Allow similar" — offered beside "Allow once"
 * for a project agent's request on a client that may write settings, a chooser with the server's
 * previews, "Allow and remember" posting the chosen scope with the card's version — and the
 * project's list of rules with Remove.
 */

const install: Question = {
  id: 'q-install',
  kind: 'permission',
  originAgentId: fx.agent.id, // a Steward of task t-1, in project p-1
  holder: { type: 'user' },
  status: 'open',
  context: {
    text: 'May I run Bash? package install: npm install zod',
    toolCall: { toolName: 'Bash', input: { command: 'npm install zod' } },
    permissionAction: 'network',
  },
  version: 2,
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
};
const PREVIEW: SimilarPreviewResponse = {
  questionId: install.id,
  projectId: fx.project.id,
  projectName: fx.project.name,
  allowed: true,
  options: [
    {
      scope: 'exact',
      available: true,
      label: 'npm install zod',
      preview: 'Exactly the command `npm install zod` (the table asks about it as network access).',
    },
    {
      scope: 'prefix',
      available: true,
      label: 'npm install …',
      preview: 'Any command line whose every command starts with `npm install` …',
    },
    { scope: 'category', available: false, reason: 'not today' },
  ],
};
const RULE: PermissionRule = {
  id: 'r-1',
  projectId: fx.project.id,
  scope: 'prefix',
  tool: 'Bash',
  match: { kind: 'words', words: ['npm', 'install'] },
  categories: ['network'],
  label: 'npm install …',
  createdBy: { type: 'user' },
  createdAt: fx.NOW,
  origin: 'local',
};

const MAC: ClientRules = { local: true, download: true, edit: true, addOutside: true };
const PHONE: ClientRules = { local: false, download: true, edit: false, addOutside: false };

let api: {
  answer: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
  similarPreview: ReturnType<typeof vi.fn>;
  allowSimilar: ReturnType<typeof vi.fn>;
  removePermissionRule: ReturnType<typeof vi.fn>;
};

function world(project: Project = fx.project, agents: Agent[] = [fx.agent]) {
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, ...agents],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [project],
    tasks: [fx.task, fx.asteroidTask],
    questions: [install],
    proposals: [],
    statuses: [],
  });
  useAppStore.setState({ status: 'live' });
}

function show(node: React.ReactNode, rules: ClientRules = MAC) {
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <RulesContext.Provider value={rules}>{node}</RulesContext.Provider>
    </ApiContext.Provider>,
  );
}

beforeEach(() => {
  useAppStore.getState().reset();
  api = {
    answer: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
    similarPreview: vi.fn(async () => PREVIEW),
    allowSimilar: vi.fn(async () => ({ ok: true, rule: RULE })),
    removePermissionRule: vi.fn(async () => ({ ok: true })),
  };
});
afterEach(() => cleanup());

describe('the permission card’s "Allow similar" (P9-17)', () => {
  it('opens a chooser with the previews and allows with the chosen scope', async () => {
    world();
    show(<QuestionCard question={install} />);
    const card = screen.getByRole('article');
    expect(within(card).getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Refuse' })).toBeTruthy();
    const opener = within(card).getByRole('button', { name: 'Allow similar for Auth refactor…' });
    expect(opener.getAttribute('aria-expanded')).toBe('false');

    await act(async () => fireEvent.click(opener));
    expect(api.similarPreview).toHaveBeenCalledWith('q-install');
    const chooser = await screen.findByRole('group', {
      name: /Allow from now on in Auth refactor/,
    });
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    const exact = within(chooser).getByRole('radio', { name: /Exactly this/ }) as HTMLInputElement;
    const prefix = within(chooser).getByRole('radio', {
      name: /prefix \/ folder/,
    }) as HTMLInputElement;
    const category = within(chooser).getByRole('radio', {
      name: /whole category/,
    }) as HTMLInputElement;
    expect(exact.checked).toBe(true); // the first offered scope
    expect(category.disabled).toBe(true);
    expect(chooser.textContent).toMatch(/Not offered: not today/);
    expect(chooser.textContent).toMatch(/starts with `npm install`/);
    expect(chooser.textContent).toMatch(/npm install …/);
    expect(blocking(await axeFindings(card))).toEqual([]);

    fireEvent.click(prefix);
    await act(async () =>
      fireEvent.click(within(chooser).getByRole('button', { name: 'Allow and remember' })),
    );
    expect(api.allowSimilar).toHaveBeenCalledWith('q-install', 'prefix', 2);
    expect(api.answer).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Allow from now on/ })).toBeNull();
  });

  it('Escape and Cancel close the chooser without answering', async () => {
    world();
    show(<QuestionCard question={install} />);
    const opener = screen.getByRole('button', { name: /^Allow similar for/ });
    await act(async () => fireEvent.click(opener));
    const chooser = await screen.findByRole('group', { name: /Allow from now on/ });
    fireEvent.keyDown(chooser, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /Allow from now on/ })).toBeNull();
    await act(async () => fireEvent.click(opener));
    const again = await screen.findByRole('group', { name: /Allow from now on/ });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Allow from now on/ })).toBeNull();
    expect(api.allowSimilar).not.toHaveBeenCalled();
  });

  it('says why when the server refuses every scope, and hands a stale refusal to the card', async () => {
    world();
    api.similarPreview.mockResolvedValueOnce({
      ...PREVIEW,
      refused: 'a push always asks (decision 49)',
      options: [],
      allowed: false,
    });
    show(<QuestionCard question={install} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Allow similar for/ })),
    );
    const chooser = await screen.findByRole('group', { name: /Allow from now on/ });
    expect(chooser.textContent).toMatch(/Not offered: a push always asks/);
    expect(
      (within(chooser).getByRole('button', { name: 'Allow and remember' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    cleanup();
    world();
    const onStale = vi.fn();
    api.allowSimilar.mockRejectedValueOnce(new ApiError(409, 'already answered', 'stale'));
    show(<QuestionCard question={install} onStale={onStale} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Allow similar for/ })),
    );
    const c2 = await screen.findByRole('group', { name: /Allow from now on/ });
    await act(async () =>
      fireEvent.click(within(c2).getByRole('button', { name: 'Allow and remember' })),
    );
    expect(onStale).toHaveBeenCalledWith('q-install', 'already answered');
  });

  it('is not offered for a push, a request outside any project, or on the phone', () => {
    world();
    const push = {
      ...install,
      context: { ...fx.permissionQuestion.context },
    };
    show(<QuestionCard question={push} />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Allow similar/ })).toBeNull();
    cleanup();

    // An asteroid's Steward: its task has no project.
    const asteroidSteward: Agent = { ...fx.agent, id: 'a-ast', taskId: fx.asteroidTask.id };
    world(fx.project, [fx.agent, asteroidSteward]);
    show(<QuestionCard question={{ ...install, originAgentId: asteroidSteward.id }} />);
    expect(screen.queryByRole('button', { name: /^Allow similar/ })).toBeNull();
    cleanup();

    world();
    show(<QuestionCard question={install} />, PHONE);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Allow similar/ })).toBeNull();
  });
});

describe('the project’s rules (P9-17)', () => {
  it('lists the rules with Remove on the Mac, read-only on the phone', async () => {
    const project: Project = { ...fx.project, permissionRules: [RULE] };
    show(<PermissionRules project={project} />);
    const list = screen.getByRole('list', { name: 'allowed similar actions' });
    expect(list.textContent).toMatch(/prefix \/ folder/);
    expect(list.textContent).toMatch(/npm install …/);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Remove the rule npm install …' })),
    );
    expect(api.removePermissionRule).toHaveBeenCalledWith('p-1', 'r-1');
    expect(blocking(await axeFindings(list))).toEqual([]);
    cleanup();

    show(<PermissionRules project={project} />, PHONE);
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    cleanup();

    show(<PermissionRules project={fx.project} />);
    expect(screen.getByText(/None\. “Allow similar” on a permission card adds one/)).toBeTruthy();
  });
});
