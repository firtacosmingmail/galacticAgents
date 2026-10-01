import { DomainError } from './errors.js';

/**
 * The changes an update really carries (P2-20; TECHNOLOGY §6.2): `undefined` values are dropped
 * (unchanged), and so is a `null` for a field that is already absent (clearing nothing is a
 * no-op, so it emits nothing). A `null` on a field that cannot be cleared is refused — a project
 * always has a name and a workspace, a task a description.
 */
export function effectiveChanges<C extends object>(
  current: object,
  changes: C,
  clearable: readonly string[],
  what: string,
): C {
  const row = current as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) {
      if (!clearable.includes(key)) {
        throw new DomainError('invalid', `a ${what}'s ${key} cannot be cleared`);
      }
      if (row[key] === undefined) continue;
    }
    out[key] = value;
  }
  return out as C;
}
