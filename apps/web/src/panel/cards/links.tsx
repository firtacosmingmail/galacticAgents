import { createContext, useContext, type MouseEvent } from 'react';
import type { Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, pathFor, type Selection } from '../../state/selection.js';
import { agentLabel } from '../../console/hierarchy/shared.js';

/**
 * Whether the cards link agents to their view through the selection API (P25-06). The panel turns
 * it on; the ops console at `/debug` leaves it off, so its cards stay as P2-18 built them.
 */
export const CardLinksContext = createContext(false);

/** The selection that opens an agent's view: the Harmonizer, a Waykeeper's chat, a Steward's view. */
export function selectionFor(agent: { id: Id; role: 'harmonizer' | 'waykeeper' | 'steward' }) {
  return (
    agent.role === 'harmonizer' ? HARMONIZER : { kind: agent.role, id: agent.id }
  ) satisfies Selection;
}

/**
 * An agent named as the page names it; with links on, an "open agent" link next to the name that
 * selects it (the same selection the navigation and the scene use, SPEC decision 53).
 */
export function AgentRef({ agentId }: { agentId: Id | undefined }) {
  const links = useContext(CardLinksContext);
  const navigate = useAppStore((s) => s.navigate);
  const world = useAppStore((s) => s.world);
  const agent = agentId ? world.agents[agentId] : undefined;
  const label = agentLabel(agent, world);
  if (!links || !agent) return <>{label}</>;
  const to = { route: 'panel', selection: selectionFor(agent) } as const;
  return (
    <>
      {label}{' '}
      <a
        href={pathFor(to)}
        className="pnl-link card-open-agent"
        aria-label={`open ${label}`}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          // Like the navigation's links (P25-02): a real link, navigating in place on a plain click.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate(to);
        }}
      >
        open agent
      </a>
    </>
  );
}
