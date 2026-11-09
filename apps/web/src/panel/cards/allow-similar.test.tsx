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
  call: 'cd /tmp/pr83; npm install zod; git push',
  asking: ['cd /tmp/pr83', 'npm install zod'],
  notRememberable: [{ part: 'git push', reason: 'a push always asks' }],
  callDigest: 'c-1',
  options: [
    {
      key: 'folder:/tmp/pr83',
      kind: 'folder',
      available: true,
      label: '/tmp/pr83/',
      preview: 'Reading and writing anywhere under /tmp/pr83/ …',
      digest: 'd-folder',
      covers: ['cd /tmp/pr83'],
      widen: [{ label: '/tmp/', preview: 'Anywhere under /tmp/ …', digest: 'd-folder-wide' }],
    },
    {
      key: 'site:registry.npmjs.org',
      kind: 'site',
      available: true,
      label: 'registry.npmjs.org',
      preview: 'Any address on registry.npmjs.org or its subdomains …',
      digest: 'd-site',
      covers: ['npm install zod'],
    },
    {
      key: 'prefix',
      kind: 'prefix',
      available: true,
      label: 'npm install … (and any further arguments)',
      preview: 'Any command line in which every command starts with `npm install` …',
      digest: 'd-prefix',
    },
    { key: 'category', kind: 'category', available: false, reason: 'not today' },
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
    allowSimilar: vi.fn(async () => ({ ok: true, rules: [RULE] })),
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
    // the call that asked, with the asking parts marked (and the part that cannot be a rule)
    const marks = [...chooser.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['cd /tmp/pr83', 'npm install zod', 'git push']);
    // one unticked checkbox per offered row; unavailable and not-rememberable ones are text only
    const boxes = within(chooser).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(within(chooser).queryByRole('radio')).toBeNull();
    expect(chooser.textContent).toMatch(/Not offered: not today/);
    expect(chooser.textContent).toMatch(/a push always asks/);
    expect(chooser.textContent).toMatch(/starts with `npm install`/);
    expect(chooser.textContent).toMatch(/covers: cd \/tmp\/pr83/);
    const go = within(chooser).getByRole('button', {
      name: 'Allow and remember ticked',
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(blocking(await axeFindings(card))).toEqual([]);

    // a folder row widens: the select chooses the level whose digest is sent
    const widen = within(chooser).getByRole('combobox', { name: /How wide/ });
    fireEvent.change(widen, { target: { value: '1' } });
    expect(chooser.textContent).toMatch(/Anywhere under \/tmp\//);
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!);
    expect(go.disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(api.allowSimilar).toHaveBeenCalledWith(
      'q-install',
      ['d-folder-wide', 'd-prefix'],
      'c-1',
      2,
    );
    expect(api.answer).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Allow from now on/ })).toBeNull();
  });

  it('says so when the request was allowed once but the rule was not stored (review S6)', async () => {
    world();
    api.allowSimilar.mockResolvedValueOnce({
      ok: true,
      ruleNotStored: 'allowed once; the rules were not stored: project app is completed',
    });
    show(<QuestionCard question={install} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Allow similar for/ })),
    );
    const chooser = await screen.findByRole('group', { name: /Allow from now on/ });
    fireEvent.click(within(chooser).getAllByRole('checkbox')[1]!);
    await act(async () =>
      fireEvent.click(within(chooser).getByRole('button', { name: 'Allow and remember ticked' })),
    );
    expect(api.allowSimilar).toHaveBeenCalledWith('q-install', ['d-site'], 'c-1', 2);
    expect(chooser.textContent).toMatch(/allowed once; the rules were not stored/);
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

  it('puts a space between the kind and the label of a row that is not offered', async () => {
    world();
    api.similarPreview.mockResolvedValueOnce({
      ...PREVIEW,
      options: [
        { key: 'site:x', kind: 'site', available: false, label: 'example.org', reason: 'no host' },
      ],
    });
    show(<QuestionCard question={install} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Allow similar for/ })),
    );
    const chooser = await screen.findByRole('group', { name: /Allow from now on/ });
    expect(chooser.textContent).toContain('Site example.org Not offered: no host.');
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
      (
        within(chooser).getByRole('button', {
          name: 'Allow and remember ticked',
        }) as HTMLButtonElement
      ).disabled,
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
    fireEvent.click(within(c2).getAllByRole('checkbox')[0]!);
    await act(async () =>
      fireEvent.click(within(c2).getByRole('button', { name: 'Allow and remember ticked' })),
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

  it('is not offered for a publishing run’s request, which makes no rule (P11-12)', () => {
    world();
    const publishing: Question = {
      ...install,
      context: {
        ...install.context,
        origin: { role: 'steward', taskId: fx.task.id, recent: [], publishingRun: true },
      },
    };
    show(<QuestionCard question={publishing} />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refuse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Allow similar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
    expect(api.similarPreview).not.toHaveBeenCalled();
  });
});

describe('the project’s rules (P9-17)', () => {
  it('labels a site rule and a folder rule', () => {
    const site: PermissionRule = {
      ...RULE,
      id: 'r-2',
      scope: 'site',
      match: { kind: 'host', host: 'github.com' },
      label: 'github.com',
    };
    const folder: PermissionRule = {
      ...RULE,
      id: 'r-3',
      scope: 'folder',
      match: { kind: 'folder', folder: '/tmp/pr83', access: 'any' },
      label: '/tmp/pr83/',
    };
    show(<PermissionRules project={{ ...fx.project, permissionRules: [site, folder] }} />);
    const list = screen.getByRole('list', { name: 'allowed similar actions' });
    expect(list.textContent).toMatch(/sitegithub\.com/);
    expect(list.textContent).toMatch(/folder · reading and writing\/tmp\/pr83\//);
  });

  it('labels a file-tool folder rule by what its tool does', () => {
    const rule = (id: string, tool: string): PermissionRule => ({
      ...RULE,
      id,
      scope: 'folder',
      tool,
      match: { kind: 'folder', folder: '/tmp/x' },
      label: `/tmp/x/ ${tool}`,
    });
    show(
      <PermissionRules
        project={{
          ...fx.project,
          permissionRules: [rule('r-a', 'Read'), rule('r-b', 'Edit'), rule('r-c', 'Other')],
        }}
      />,
    );
    const items = screen
      .getByRole('list', { name: 'allowed similar actions' })
      .querySelectorAll('li');
    expect(items[0]?.textContent).toMatch(/^folder · reading/);
    expect(items[1]?.textContent).toMatch(/^folder · writing/);
    expect(items[2]?.textContent).toMatch(/^folder · by file tools/);
  });

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
