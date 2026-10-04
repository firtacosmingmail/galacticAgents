import { useMemo, useState } from 'react';
import { ENDED_STATES, isHarnessMeta, type Agent, type Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { createApi, type Api } from '../api.js';
import { ChatBox } from './ChatBox.js';
import { ProposalCards } from './ProposalCards.js';
import { QuestionInbox } from './QuestionInbox.js';
import { StewardView } from './StewardView.js';
import { SummaryBar, WorkTree } from './WorkTree.js';
import { ApiContext, agentLabel } from './shared.js';

/**
 * The hierarchy ops console (P2-18): the whole Steward → Waykeeper → Harmonizer → user loop on one
 * plain page — the Harmonizer's chat, the cards waiting for a decision, the question inbox, the
 * project/task tree with its controls, and the selected Waykeeper's chat or Steward's view. State
 * comes from the stream (the store, TECHNOLOGY §6.3); actions go through `/api`. Functional over
 * pretty: the real panel is Phase 2.5's.
 */
export function HierarchyConsole({ token, api: given }: { token: string; api?: Api }) {
  const api = useMemo(() => given ?? createApi(token), [given, token]);
  const world = useAppStore((s) => s.world);
  const [selected, setSelected] = useState<Id | undefined>();
  const harmonizer = currentHarmonizer(world);
  const agent = selected ? world.agents[selected] : undefined;

  return (
    <ApiContext.Provider value={api}>
      <section className="hierarchy">
        <h2>Mission Control</h2>
        <SummaryBar />
        <div className="hierarchy-grid">
          <div className="column">
            {harmonizer ? (
              <ChatBox agentId={harmonizer.id} title="Harmonizer" />
            ) : (
              <p className="muted">No Harmonizer is running.</p>
            )}
            <ProposalCards />
            <QuestionInbox />
          </div>
          <div className="column">
            <WorkTree onSelectAgent={setSelected} />
            {agent && (
              <div className="selected" aria-label="selected agent">
                <p className="muted">
                  {agentLabel(agent, world)}{' '}
                  <button className="secondary" onClick={() => setSelected(undefined)}>
                    close
                  </button>
                </p>
                {agent.role === 'steward' ? (
                  <StewardView agentId={agent.id} />
                ) : (
                  <ChatBox agentId={agent.id} />
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </ApiContext.Provider>
  );
}

/**
 * The Harmonizer the user talks to: the newest one still running, else the newest one. Never the
 * scene harness's dormant Harmonizer (P4-06): with no real Harmonizer there is none to talk to.
 */
export function currentHarmonizer(
  world: Pick<WorldState, 'agents' | 'statuses'>,
): Agent | undefined {
  const all = Object.values(world.agents)
    .filter((a) => a.role === 'harmonizer' && !isHarnessMeta(a.meta))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return (
    all.find((a) => {
      const s = world.statuses[a.id]?.state;
      return s !== undefined && !ENDED_STATES.has(s);
    }) ?? all[0]
  );
}
