import { useEffect, useMemo, useState } from 'react';
import { panelsOf, type Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { NeedsALook } from './NeedsALook.js';
import { PanelGrid } from './PanelGrid.js';
import { useDashboard } from './use-dashboard.js';
import './dashboard.css';

/**
 * The Dashboard tab (P15-06; SPEC decision 156): a long-term project's panels over its jobs'
 * runs, read from `GET /api/projects/:id/dashboard`. "Needs a look" lists the panels with a
 * verdict, then the grid. Hidden panels are left out here (and on the phone).
 */

/** "Now" for the ages, refreshed twice a minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function DashboardPane({ projectId }: { projectId: Id }) {
  const world = useAppStore((s) => s.world);
  const { data, loaded, error } = useDashboard(projectId);
  const now = useNow();
  const project = world.projects[projectId];
  const panels = useMemo(
    () => panelsOf(world, projectId).filter((p) => !p.layout.hidden),
    [world, projectId],
  );
  if (!project) return <p className="pnl-empty">This project is not in the current log.</p>;
  return (
    <section className="dash" aria-label={`dashboard of ${project.name}`}>
      {error && (
        <p className="error" role="alert">
          Could not read the dashboard: {error}
        </p>
      )}
      {panels.length === 0 ? (
        <p className="muted dash-empty">
          No panels yet. Ask the Waykeeper in the chat what you want to see here.
        </p>
      ) : (
        <>
          <NeedsALook panels={panels} data={data} />
          <PanelGrid panels={panels} data={loaded ? data : {}} now={now} />
        </>
      )}
    </section>
  );
}
