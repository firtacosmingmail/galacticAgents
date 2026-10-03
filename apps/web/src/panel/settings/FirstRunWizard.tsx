import { useState, type ReactNode } from 'react';
import type { PreflightResponse } from '@galactic/protocol';
import { PreflightCheck } from './PreflightCheck.js';
import { useSettingsData } from './SettingsData.js';
import { refusalMessage } from './settings-model.js';
import { SECTIONS, SectionFrame, useSection, type AnySectionSpec } from './sections.js';
import './settings.css';

type Step = { kind: 'preflight' } | { kind: 'section'; spec: AnySectionSpec } | { kind: 'done' };

const STEPS: Step[] = [
  { kind: 'preflight' },
  ...SECTIONS.map((spec): Step => ({ kind: 'section', spec })),
  { kind: 'done' },
];

const stepTitle = (s: Step) =>
  s.kind === 'preflight' ? 'Runtime check' : s.kind === 'done' ? 'Done' : s.spec.title;

/**
 * The first-run wizard (P25-08; SPEC §4.6): the runtime check, then each setting with its
 * defaults filled in, then the panel. A step saves its setting only if it was changed. Finishing
 * — or skipping — stamps `setupCompletedAt` on the server, so the wizard does not come back in
 * this or any other browser; the same editors are the settings page afterwards.
 */
export function FirstRunWizard({ onDone }: { onDone: () => void }) {
  const data = useSettingsData();
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string>();
  const step = STEPS[index]!;
  const back = index > 0 ? () => setIndex(index - 1) : undefined;
  const next = () => setIndex(Math.min(index + 1, STEPS.length - 1));

  const finish = async () => {
    setFinishing(true);
    try {
      await data.patch({ setupCompleted: true });
      onDone();
    } catch (error) {
      setFinishError(refusalMessage(error));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <main className="set-page set-wizard" aria-label="first-run setup">
      <div className="set-page-head">
        <div>
          <p className="pnl-eyebrow">
            Setup · step {index + 1} of {STEPS.length}
          </p>
          <h1 className="pnl-title">Welcome to GalacticAgents</h1>
        </div>
        {step.kind !== 'done' && (
          <div className="set-wizard-skip">
            <button
              type="button"
              className="set-secondary"
              disabled={finishing}
              onClick={() => void finish()}
            >
              Skip setup — keep the defaults
            </button>
            {finishError && (
              <>
                <p className="set-error" role="alert">
                  {finishError}
                </p>
                <button type="button" className="set-secondary" onClick={onDone}>
                  Continue without saving that setup is done
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <ol className="set-steps" aria-label="setup steps">
        {STEPS.map((s, i) => (
          <li
            key={stepTitle(s)}
            aria-current={i === index ? 'step' : undefined}
            className={i < index ? 'is-past' : undefined}
          >
            {stepTitle(s)}
          </li>
        ))}
      </ol>

      {step.kind === 'preflight' && <PreflightStep onNext={next} />}
      {step.kind === 'section' && (
        <SectionStep key={step.spec.field} spec={step.spec} onBack={back} onNext={next} />
      )}
      {step.kind === 'done' && (
        <section className="set-section" aria-label="Done">
          <div className="set-head">
            <h2 className="set-title">You are set</h2>
          </div>
          <p className="set-intro">
            Everything here can be changed later from <strong>Settings</strong> in the top bar. Talk
            to the Harmonizer to start your first project.
          </p>
          {finishError && (
            <p className="set-error" role="alert">
              {finishError}
            </p>
          )}
          <WizardNav onBack={back}>
            <button type="button" disabled={finishing} onClick={() => void finish()}>
              {finishing ? 'Opening…' : 'Open the panel'}
            </button>
            {finishError && (
              <button type="button" className="set-secondary" onClick={onDone}>
                Continue without saving that setup is done
              </button>
            )}
          </WizardNav>
        </section>
      )}
    </main>
  );
}

function WizardNav({
  onBack,
  children,
}: {
  onBack?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div className="set-actions set-wizard-nav">
      {onBack && (
        <button type="button" className="set-secondary" onClick={onBack}>
          Back
        </button>
      )}
      <span className="pnl-spacer" />
      {children}
    </div>
  );
}

function PreflightStep({ onNext }: { onNext: () => void }) {
  const [result, setResult] = useState<PreflightResponse | undefined>();
  const [checked, setChecked] = useState(false);
  return (
    <>
      <PreflightCheck
        onResult={(r) => {
          setResult(r);
          setChecked(true);
        }}
      />
      {checked && !result?.ok && (
        <p className="set-note" role="note">
          Agents cannot run until the problems above are fixed. You can fix them and press “Check
          again”, or continue the setup now and fix them later.
        </p>
      )}
      <WizardNav>
        <button type="button" className={result?.ok ? undefined : 'set-secondary'} onClick={onNext}>
          {!checked || result?.ok ? 'Next' : 'Continue anyway'}
        </button>
      </WizardNav>
    </>
  );
}

function SectionStep({
  spec,
  onBack,
  onNext,
}: {
  spec: AnySectionSpec;
  onBack: (() => void) | undefined;
  onNext: () => void;
}) {
  const state = useSection(spec);
  const go = async () => {
    if (await state.save()) onNext();
  };
  return (
    <SectionFrame
      state={state}
      footer={
        <WizardNav onBack={onBack}>
          <button
            type="button"
            disabled={state.saving || state.clientError !== undefined}
            onClick={() => void go()}
          >
            {state.saving ? 'Saving…' : state.dirty ? 'Save and continue' : 'Next'}
          </button>
        </WizardNav>
      }
    />
  );
}
