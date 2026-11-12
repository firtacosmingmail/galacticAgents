import { taskTitle, type Task } from './domain.js';

/**
 * Stewards' names (P15-11, SPEC decision 157): every task's Steward is called by a star's name,
 * shown with a short name of its task ("Vega · Prospect list"). The name belongs to the task, so a
 * restarted or replaced Steward keeps it. Kept in `meta.stewardName`; picked when the task is
 * created, unused among the other tasks of its project (or among the standalone tasks).
 */
export const STEWARD_NAMES: readonly string[] = [
  'Vega',
  'Rigel',
  'Altair',
  'Sirius',
  'Deneb',
  'Capella',
  'Arcturus',
  'Spica',
  'Antares',
  'Polaris',
  'Procyon',
  'Castor',
  'Pollux',
  'Aldebaran',
  'Regulus',
  'Mira',
  'Electra',
  'Maia',
  'Alcyone',
  'Bellatrix',
  'Mintaka',
  'Alnilam',
  'Alnitak',
  'Saiph',
  'Achernar',
  'Canopus',
  'Hadar',
  'Acrux',
  'Mimosa',
  'Shaula',
  'Nunki',
  'Kaus',
  'Fomalhaut',
  'Diphda',
  'Hamal',
  'Mirach',
  'Alpheratz',
  'Algol',
  'Mirfak',
  'Menkar',
  'Alhena',
  'Wasat',
  'Adhara',
  'Wezen',
  'Aludra',
  'Alphard',
  'Denebola',
  'Zosma',
  'Algieba',
  'Dubhe',
  'Merak',
  'Phecda',
  'Megrez',
  'Alioth',
  'Mizar',
  'Alkaid',
  'Kochab',
  'Thuban',
  'Eltanin',
  'Rastaban',
  'Izar',
  'Alphecca',
  'Unukalhai',
  'Sabik',
  'Rasalhague',
  'Albireo',
  'Sadr',
  'Enif',
  'Markab',
  'Scheat',
  'Algenib',
  'Ankaa',
  'Peacock',
  'Alnair',
  'Avior',
  'Miaplacidus',
  'Suhail',
  'Naos',
  'Gienah',
  'Zubenelgenubi',
  'Atria',
  'Menkent',
  'Rigil',
  'Sargas',
  'Larawag',
  'Tarazed',
  'Sheratan',
  'Schedar',
  'Caph',
  'Ruchbah',
  'Elnath',
  'Menkalinan',
  'Tejat',
  'Mebsuta',
  'Propus',
  'Alterf',
  'Chertan',
  'Vindemiatrix',
  'Porrima',
  'Heze',
];

/** A stable number from a string (FNV-1a): the starting point of a pick, the same on every run. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A name none of `taken` uses, starting at a place `seed` decides; when every name is taken, the
 * first free numbered one ("Vega 2").
 */
export function pickStewardName(taken: ReadonlySet<string>, seed: string): string {
  const start = hash(seed) % STEWARD_NAMES.length;
  for (let i = 0; i < STEWARD_NAMES.length; i++) {
    const name = STEWARD_NAMES[(start + i) % STEWARD_NAMES.length]!;
    if (!taken.has(name)) return name;
  }
  const base = STEWARD_NAMES[start]!;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The task's Steward's name: the one stored with it, else (a task older than names) one its id picks. */
export function stewardName(task: Pick<Task, 'id' | 'meta'>): string {
  const stored = task.meta?.['stewardName'];
  if (typeof stored === 'string' && stored.trim()) return stored;
  return STEWARD_NAMES[hash(task.id) % STEWARD_NAMES.length]!;
}

/** The longest short name a list shows for a task with no title. */
export const TASK_SHORT_NAME_MAX = 48;

/**
 * A task's short name for lists: its title (given when it was created, or the user's rename), else
 * the first sentence or line of its description, cut to {@link TASK_SHORT_NAME_MAX} characters.
 */
export function taskShortName(task: Pick<Task, 'meta' | 'description'>): string {
  const title = taskTitle(task);
  if (title) return title;
  const text = task.description.trim();
  const first = (text.split(/\n|(?<=[.!?])\s/, 1)[0] ?? text).trim().replace(/[.!?]$/, '');
  return first.length > TASK_SHORT_NAME_MAX
    ? `${first.slice(0, TASK_SHORT_NAME_MAX - 1).trimEnd()}…`
    : first;
}
