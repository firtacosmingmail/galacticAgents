import type { StorageCondition } from '@galactic/protocol';
import type { ConnectionState, ServerInfo, TrayView } from './lines.js';

const STORAGE_TEXT: Record<Exclude<StorageCondition, 'ok'>, string> = {
  full: 'Storage problem: the disk is full',
  unavailable: 'Storage problem: the database cannot be written just now',
  unwritable: 'Storage problem: the database cannot be written',
};

export interface TrayInput {
  state: ConnectionState;
  waiting: number;
  storage: StorageCondition;
  server?: ServerInfo | undefined;
  detail?: string | undefined;
}

/**
 * What the menu bar shows (P8-06). One state wins, loudest first: not connected (starting,
 * disconnected, stopped, error), then a storage problem (decision 104: shown, never notified),
 * then what waits for the user, then plain "Live". The title next to the icon is the waiting
 * count, "!" for a storage problem or an error, "…" while starting or disconnected, and empty
 * when live with nothing waiting.
 */
export function trayView(input: TrayInput): TrayView {
  const { state, waiting, storage, server, detail } = input;
  const serverLabel = !server
    ? 'Mission Control: not running'
    : server.owned
      ? `Mission Control started by this app (port ${server.port})`
      : `Attached to Mission Control on port ${server.port}`;
  const canStart = state === 'stopped' || state === 'error';
  const withDetail = (text: string) => (detail ? `${text}: ${detail}` : text);
  const view = (label: string, title: string, tooltip = label): TrayView => ({
    label,
    title,
    tooltip: `GalacticAgents — ${tooltip}`,
    serverLabel,
    canStart,
  });
  switch (state) {
    case 'starting':
      return view('Starting Mission Control…', '…', withDetail('starting Mission Control'));
    case 'disconnected':
      return view('Disconnected', '…', withDetail('disconnected'));
    case 'stopped':
      return view(
        'Mission Control is not running',
        '',
        withDetail('Mission Control is not running'),
      );
    case 'error':
      return view(withDetail('Cannot reach Mission Control'), '!');
    case 'live':
      break;
  }
  if (storage !== 'ok') return view(STORAGE_TEXT[storage], '!');
  if (waiting > 0) return view(`${waiting} waiting for you`, String(waiting));
  return view('Live', '');
}
