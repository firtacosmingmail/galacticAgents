import type { Agent, DomainCommands, Id } from '@galactic/protocol';

/**
 * The hierarchy a test needs above the agent it is about (P2-20): `spawnAgent` refuses a
 * Waykeeper or Steward without the supervisor SPEC §2 prescribes, so tests spawn the Harmonizer
 * (on Earth) and the project's Waykeeper first. Fake runtime; `scenario:*` prompts as usual.
 */

export async function spawnHarmonizer(
  commands: Pick<DomainCommands, 'spawnAgent'>,
  prompt = 'x',
): Promise<Agent> {
  return (await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt }))
    .value;
}

export async function spawnWaykeeper(
  commands: Pick<DomainCommands, 'spawnAgent'>,
  projectId: Id,
  supervisorId: Id,
  prompt = 'x',
): Promise<Agent> {
  return (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      projectId,
      supervisorId,
      prompt,
    })
  ).value;
}

/** The Harmonizer and the project's Waykeeper: what a project Steward needs above it. */
export async function projectHierarchy(
  commands: Pick<DomainCommands, 'spawnAgent'>,
  projectId: Id,
  prompts: { harmonizer?: string; waykeeper?: string } = {},
): Promise<{ harmonizer: Agent; waykeeper: Agent }> {
  const harmonizer = await spawnHarmonizer(commands, prompts.harmonizer);
  const waykeeper = await spawnWaykeeper(commands, projectId, harmonizer.id, prompts.waykeeper);
  return { harmonizer, waykeeper };
}
