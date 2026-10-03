import { proposalPlan } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { carriedOutLine, OPEN_PROPOSAL_STATES, ProposalCard } from '../../panel/cards/index.js';

// The cards moved to `panel/cards` (P25-06); re-exported for the console's other pieces.
export { ProposalCard, TRUST_HINTS } from '../../panel/cards/index.js';

/**
 * The ops console's proposal list (P2-18; SPEC §3.3): open cards (`pending`/`edited`/`parked`),
 * then rejected drafts, then the last five approved cards with their `carriedOut` outcome.
 */
export function ProposalCards() {
  const proposals = useAppStore((s) => s.world.proposals);
  const all = Object.values(proposals).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = all.filter((p) => OPEN_PROPOSAL_STATES.has(p.state));
  const drafts = all.filter((p) => p.state === 'rejected');
  const decided = all.filter((p) => p.state === 'approved').slice(-5);
  return (
    <section className="proposals" aria-label="proposals">
      <h3>Cards waiting for you ({open.length})</h3>
      {open.length === 0 && <p className="muted">Nothing to decide.</p>}
      {open.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
      {drafts.length > 0 && (
        <details>
          <summary>Rejected drafts ({drafts.length})</summary>
          {drafts.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </details>
      )}
      {decided.length > 0 && (
        <details>
          <summary>Recently approved ({decided.length})</summary>
          <ul className="items">
            {decided.map((p) => (
              <li key={p.id}>
                {proposalPlan(p) ? 'plan' : p.kind} · {p.requestText}
                {carriedOutLine(p)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
