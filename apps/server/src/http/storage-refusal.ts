import type { FastifyReply } from 'fastify';
import { STORAGE_ERROR, type StorageErrorCode } from '@galactic/protocol';
import { storageConditionOf } from '../db/database.js';

/**
 * An action the storage refused, as a REST reply (P8-09; SPEC decision 99): 507 `storage_full`
 * when the disk is full, 503 `storage_unavailable` for a passing storage failure, 503
 * `storage_unwritable` for a read-only or missing database. Nothing was done (the command rolled
 * back whole, or the runtime refused it while agent events wait to be written); the message says so
 * in the user's words and the panel shows it on the refused control. Undefined for an error that is
 * not a storage failure.
 */
export function storageRefusal(
  error: unknown,
): { status: number; body: { error: StorageErrorCode; message: string } } | undefined {
  const condition = storageConditionOf(error);
  if (!condition) return undefined;
  const { code, status, message } = STORAGE_ERROR[condition];
  return { status, body: { error: code, message } };
}

/** Sends `storageRefusal(error)` when it applies; returns whether it did. */
export function sendStorageRefusal(reply: FastifyReply, error: unknown): boolean {
  const refusal = storageRefusal(error);
  if (!refusal) return false;
  void reply.code(refusal.status).send(refusal.body);
  return true;
}
