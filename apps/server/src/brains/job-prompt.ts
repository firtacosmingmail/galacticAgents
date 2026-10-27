import type { Area, FollowUp, Job, JobRun, Project } from '@galactic/protocol';

/**
 * The first prompt of a job run's Steward (P10-04, plan Task 8; SPEC decision 144). The scheduler
 * spawns one Steward per run on the job's hidden task, in the project's workspace; the prompt
 * carries the project's purpose and goals, the job's instructions, what the run covers, the job's
 * memory (the last runs, `jobMemory`), the approved follow-up or the user's retry note, and the
 * rules of an unattended run: read and draft only, findings through `report_finding`, money only
 * after `request_spend`, and the run's end through `report_run`.
 *
 * Pure text: no SDK, no database.
 */

export interface JobPromptBrief {
  project: Project;
  job: Job;
  area: Area;
  run: JobRun;
  /** The job's memory lines, newest first. */
  memory: string[];
  /** The approved send or spend this run carries out (a `follow_up` run). */
  followUp?: FollowUp;
  /** What the user wrote when answering the failure question (a retry run). */
  note?: string;
  /** The Steward's runtime serves the server's tools (`report_finding`, `report_run`, …). */
  declares: boolean;
}

const PURPOSE_TEXT: Record<JobRun['purpose'], string> = {
  scheduled: 'a scheduled run',
  catch_up: 'a catch-up run (Mission Control missed the scheduled time)',
  retry: 'a retry after a failed run',
  follow_up: 'a follow-up run, to carry out what Cosmin approved',
};

function money(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return 'the approved amount';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
    }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

function followUpText(followUp: FollowUp): string {
  if (followUp.kind === 'send') {
    return `Send exactly this reply: ${followUp.text ?? ''}`;
  }
  return (
    `Cosmin approved spending ${money(followUp.amount, followUp.currency)} for ` +
    `${followUp.purpose ?? 'the purpose you asked for'}: do it now`
  );
}

export function jobRunPrompt(brief: JobPromptBrief): string {
  const { project, job, area, run, memory, followUp, note, declares } = brief;
  const lines: string[] = [];
  lines.push(
    `You are running the recurring job "${job.name}" of the long-term project "${project.name}", ` +
      `in its area "${area.name}". This is ${PURPOSE_TEXT[run.purpose]}.`,
  );
  if (project.purpose) lines.push('', `The project's purpose: ${project.purpose}`);
  if (project.goals && project.goals.length > 0) {
    lines.push('', "The project's goals:", ...project.goals.map((g) => `- ${g}`));
  }
  lines.push('', "The job's instructions:", job.instructions);
  if (run.purpose === 'catch_up' && run.coversFrom) {
    lines.push('', `This run covers ${run.coversFrom} to now.`);
  }
  lines.push('', 'What the last runs did (newest first):');
  lines.push(...(memory.length > 0 ? memory.map((m) => `- ${m}`) : ['- (this is the first run)']));
  if (followUp) lines.push('', followUpText(followUp));
  else if (note) lines.push('', `Cosmin fixed what made the last run fail. His note: ${note}`);

  lines.push('', 'Rules of this run (nobody watches it while it works):');
  lines.push(
    followUp?.kind === 'send'
      ? '- Read and draft only, except the approved reply above: send exactly that, nothing else.'
      : followUp?.kind === 'spend'
        ? '- Read and draft only, except the approved spending above: do exactly that, nothing else.'
        : '- Read and draft only: never send, post or spend anything.',
  );
  if (declares) {
    lines.push(
      '- Report each finding (a feature worth building, a reply worth sending) with `report_finding`; Cosmin decides what happens to it.',
      '- Before anything that costs real money, call `request_spend` and stop: a later run does it once Cosmin approves.',
      '- End the run with `report_run`: its outcome, a short summary, and any numbers worth keeping.',
    );
  } else {
    lines.push(
      '- List each finding (a feature worth building, a reply worth sending) in your final message, one per line, starting with "Finding:".',
      '- Never do anything that costs real money: say in your final message what you would spend and why.',
      '- End the run with a final message: a short summary of what you found.',
    );
  }
  return lines.join('\n');
}
