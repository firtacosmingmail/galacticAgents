import { ENDED_STATES, type Id } from '@galactic/protocol';
import { DomainError } from '../../domain/errors.js';
import type { BrainQueries } from '../definition.js';

/**
 * Small input readers for the Harmonizer's tool handlers (P2-08). The model's input is untrusted
 * JSON: a missing or mistyped field is refused as `invalid`, which the runner hands back to the
 * model as a tool error.
 */

export type Input = Record<string, unknown>;

export function asInput(input: unknown): Input {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('invalid', 'the tool input must be an object');
  }
  return input as Input;
}

export function str(input: Input, key: string): string;
export function str(input: Input, key: string, optional: true): string | undefined;
export function str(input: Input, key: string, optional = false): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new DomainError('invalid', `${key} is required`);
  }
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  const trimmed = v.trim();
  if (!trimmed) {
    if (optional) return undefined;
    throw new DomainError('invalid', `${key} is required`);
  }
  return trimmed;
}

export function oneOf<T extends string>(
  input: Input,
  key: string,
  values: readonly T[],
  optional?: false,
): T;
export function oneOf<T extends string>(
  input: Input,
  key: string,
  values: readonly T[],
  optional: true,
): T | undefined;
export function oneOf<T extends string>(
  input: Input,
  key: string,
  values: readonly T[],
  optional = false,
): T | undefined {
  const v = optional ? str(input, key, true) : str(input, key);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) {
    throw new DomainError('invalid', `${key} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

export function strings(input: Input, key: string): string[] | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new DomainError('invalid', `${key} must be a list of strings`);
  }
  return v as string[];
}

export function int(input: Input, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new DomainError('invalid', `${key} must be a non-negative integer`);
  }
  return v;
}

/** The agent runs: it has a status record that is not ended. */
export function isLiving(queries: BrainQueries, agentId: Id): boolean {
  const state = queries.status(agentId)?.state;
  return state !== undefined && !ENDED_STATES.has(state);
}

/** JSON-schema helpers for the tool tables. */
export const S = {
  str: (description: string) => ({ type: 'string', description }),
  enum: (values: readonly string[], description: string) => ({
    type: 'string',
    enum: [...values],
    description,
  }),
  obj: (properties: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }),
};
