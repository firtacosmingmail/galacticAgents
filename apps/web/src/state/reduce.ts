/**
 * The web client's fold of the stream. The fold itself lives in `@galactic/protocol` (`world.ts`,
 * moved there with P8-03) so the server rebuilds its tables from an imported log with the very
 * same function; this module keeps the client's imports stable.
 */
export {
  applyEvent,
  applySnapshot,
  emptyWorld,
  summaryOf,
  type WorldState,
} from '@galactic/protocol';
