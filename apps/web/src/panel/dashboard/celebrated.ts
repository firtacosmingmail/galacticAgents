/**
 * Which run results already had their fireworks (P15-06): a very good tile celebrates once per
 * new result (the run's id, `verdict.resultId`), not again when the page is opened again. Per
 * browser, like the dock's choices: the last 200 ids in localStorage.
 */
export const CELEBRATED_KEY = 'galactic.dashboard.celebrated';
const KEPT = 200;

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CELEBRATED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function celebrated(resultId: string): boolean {
  return read().includes(resultId);
}

export function markCelebrated(resultId: string): void {
  try {
    const ids = read().filter((id) => id !== resultId);
    ids.push(resultId);
    localStorage.setItem(CELEBRATED_KEY, JSON.stringify(ids.slice(-KEPT)));
  } catch {
    // No storage (private mode): the fireworks may play again after a reload.
  }
}
