import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isStorageErrorCode,
  STORAGE_ERROR,
  STORAGE_OK,
  StorageErrorCode,
  StorageHealth,
} from './storage.js';
import { ServerMessage, StatusMessage } from './ws.js';
import { StatusRecord } from './domain.js';
import * as d from './fixtures/domain.js';

const full: StorageHealth = {
  condition: 'full',
  held: 42,
  dropped: 0,
  since: d.NOW,
  error: 'database or disk is full',
};

describe('storage health (P8-09)', () => {
  it('parses every condition and refuses a bad count', () => {
    expect(StorageHealth.parse(STORAGE_OK)).toEqual(STORAGE_OK);
    expect(StorageHealth.parse(full)).toEqual(full);
    for (const condition of ['ok', 'full', 'unavailable', 'unwritable'] as const) {
      expect(StorageHealth.parse({ ...STORAGE_OK, condition }).condition).toBe(condition);
    }
    expect(StorageHealth.safeParse({ ...full, held: -1 }).success).toBe(false);
    expect(StorageHealth.safeParse({ ...full, condition: 'melted' }).success).toBe(false);
  });

  it('rides on the snapshot and on status messages, alone or with a replacing set', () => {
    const snapshot = {
      type: 'snapshot',
      logId: 'log-1',
      seq: 3,
      agents: [],
      bodies: [],
      projects: [],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [],
      storage: full,
    };
    expect(ServerMessage.parse(snapshot)).toEqual(snapshot);
    const { storage: _s, ...older } = snapshot;
    expect(ServerMessage.parse(older)).toEqual(older);

    const replacing = { type: 'status', statuses: [d.status], replace: true, storage: full };
    expect(ServerMessage.parse(replacing)).toEqual(replacing);
    // This build accepts the storage alone; an empty diff without it is still refused.
    expect(ServerMessage.parse({ type: 'status', statuses: [], storage: STORAGE_OK })).toEqual({
      type: 'status',
      statuses: [],
      storage: STORAGE_OK,
    });
    expect(StatusMessage.safeParse({ type: 'status', statuses: [] }).success).toBe(false);
  });

  it('what the server sends reads as an ordinary replacing set on a page built before the field', () => {
    // The status message as it was before P8-09 (zod strips the unknown `storage`).
    const OldStatusMessage = z
      .object({
        type: z.literal('status'),
        statuses: z.array(StatusRecord),
        removed: z.array(z.string()).optional(),
        replace: z.boolean().optional(),
      })
      .refine((m) => m.replace === true || m.statuses.length > 0 || (m.removed?.length ?? 0) > 0);
    expect(
      OldStatusMessage.parse({ type: 'status', statuses: [], replace: true, storage: full }),
    ).toEqual({ type: 'status', statuses: [], replace: true });
  });

  it('maps each refusing condition to its REST code and status', () => {
    expect(STORAGE_ERROR.full).toMatchObject({ code: 'storage_full', status: 507 });
    expect(STORAGE_ERROR.unavailable).toMatchObject({ code: 'storage_unavailable', status: 503 });
    expect(STORAGE_ERROR.unwritable).toMatchObject({ code: 'storage_unwritable', status: 503 });
    expect(STORAGE_ERROR.full.message).toMatch(/^The disk is full/);
    for (const code of StorageErrorCode.options) expect(isStorageErrorCode(code)).toBe(true);
    expect(isStorageErrorCode('stale')).toBe(false);
    expect(isStorageErrorCode(undefined)).toBe(false);
  });
});
