import type { Agent, Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';

/**
 * Test fixtures for question sets (P8-21): the Waykeeper of "Auth refactor" asks three
 * clarifications about its plan as one set; they reached the user through the Harmonizer.
 */

export const SET_ID = 'qs-1';
export const SET_TITLE = 'Clarifications on the plan';

export const setWaykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};

const row = (
  index: number,
  text: string,
  options: string[],
  extra: Partial<Question['context']> = {},
): Question => ({
  id: `q-s${index + 1}`,
  kind: 'clarification',
  originAgentId: setWaykeeper.id,
  holder: { type: 'user' },
  status: 'open',
  context: {
    text,
    options,
    set: { id: SET_ID, index, total: 3, title: SET_TITLE },
    ...extra,
  },
  version: 1,
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
});

/** Single choice. */
export const routesRow = row(0, 'Keep the old REST routes?', ['Yes', 'No, remove them']);
/** Single choice. */
export const authRow = row(1, 'Which auth provider?', ['Clerk', 'Auth.js', 'Supabase Auth']);
/** Several choices allowed. */
export const browsersRow = row(2, 'Which browsers in v1?', ['Chrome', 'Firefox', 'Safari'], {
  multiSelect: true,
});

export const setRows: Question[] = [routesRow, authRow, browsersRow];

/** The set with its second row answered by the Harmonizer from context (decision 12). */
export function withSupervisorAnswer(): Question[] {
  return [
    routesRow,
    {
      ...authRow,
      holder: { type: 'agent', id: fx.harmonizer.id },
      status: 'answered',
      answer: 'Auth.js',
      answeredBy: { type: 'agent', id: fx.harmonizer.id },
      version: 2,
    },
    browsersRow,
  ];
}
