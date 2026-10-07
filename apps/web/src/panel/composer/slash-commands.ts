import { useCallback, useEffect, useState } from 'react';
import { AgentCommandsResponse, type Id, type SlashCommand } from '@galactic/protocol';
import type { Api } from '../../console/api.js';

/**
 * The slash commands of the agent a composer talks to (P8-13): `GET /api/agents/:id/commands`,
 * read when the composer mounts and again when the user types `/` and the last read is old (the
 * runtime may have found new skills, or the session was renewed). Kept per agent for the page's
 * life, so switching between agents does not ask again. Read-only information: remote clients
 * read it too. A failed read is an empty list — the composer works as before.
 */

/** How long a read is fresh. Typing `/` after that reads again. */
export const COMMANDS_FRESH_MS = 30_000;
/** An empty answer (the runtime had not said yet) is asked again sooner. */
const EMPTY_FRESH_MS = 3_000;

interface Entry {
  at: number;
  commands: SlashCommand[];
  loading?: Promise<void> | undefined;
}

const cache = new Map<Id, Entry>();
const listeners = new Set<() => void>();
const NONE: SlashCommand[] = [];

/** Tests: forget every agent's commands. */
export function resetSlashCommands(): void {
  cache.clear();
}

function stale(entry: Entry | undefined, now: number): boolean {
  if (!entry) return true;
  if (entry.loading) return false;
  return now - entry.at > (entry.commands.length === 0 ? EMPTY_FRESH_MS : COMMANDS_FRESH_MS);
}

function load(api: Api, agentId: Id): void {
  // Test doubles of the API may not have the call: no commands then.
  if (typeof api.commands !== 'function') return;
  const previous = cache.get(agentId);
  const entry: Entry = { at: Date.now(), commands: previous?.commands ?? NONE };
  entry.loading = api
    .commands(agentId)
    .then(
      (res) => {
        const parsed = AgentCommandsResponse.safeParse(res);
        entry.commands = parsed.success ? parsed.data.commands : NONE;
      },
      () => {
        entry.commands = NONE;
      },
    )
    .finally(() => {
      entry.at = Date.now();
      entry.loading = undefined;
      for (const l of listeners) l();
    });
  cache.set(agentId, entry);
}

/**
 * The agent's commands (`[]` while unknown or when `enabled` is false), and `refresh()` — read
 * again if the last read is stale (the composer calls it when `/` is typed).
 */
export function useSlashCommands(
  api: Api,
  agentId: Id,
  enabled: boolean,
): { commands: SlashCommand[]; refresh: () => void } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (enabled && stale(cache.get(agentId), Date.now())) load(api, agentId);
  }, [api, agentId, enabled]);
  const refresh = useCallback(() => {
    if (enabled && stale(cache.get(agentId), Date.now())) load(api, agentId);
  }, [api, agentId, enabled]);
  return { commands: enabled ? (cache.get(agentId)?.commands ?? NONE) : NONE, refresh };
}
