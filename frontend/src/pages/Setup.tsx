/**
 * First-run Setup Page (`/setup`)
 *
 * Lets a non-technical user finish Crewly setup in the browser — on the
 * machine or from a phone:
 *   1. Harness — see which harnesses are installed, install / update one
 *      (Claude Code pre-selected) with a live log.
 *   2. Orc — choose the harness the orchestrator runs on.
 *   3. Sign in — log in to that harness via the login broker or an API key.
 *   4. Team — first team from a starter: Personal Assistant (recommended),
 *      Marketing, or Blank (the orchestrator only).
 *   5. First task — one text box + three examples; sent to the orchestrator.
 *   6. Cloud — connect Crewly Cloud (Google sign-in that returns here, or
 *      paste the token from the portal's token page).
 *   7. Slack — one-click install through Crewly Cloud.
 *   8. Done.
 *
 * Steps 4-7 are skippable. `?step=team|first_task|cloud|slack` opens the
 * page at that step (the dashboard "Get started" card, the Cloud / Slack return
 * URLs, and `crewly onboard` use it). "Skip for now" sets a
 * localStorage flag so the first-run redirect (SetupRedirectGuard) doesn't loop.
 *
 * @module pages/Setup
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, CrewlyRoot, LoadingSpinner } from '@crewly/ui';
import { StepIndicator } from '../components/Onboarding/StepIndicator';
import { StarterTeamStep, type StarterTeamDone } from '../components/Onboarding/StarterTeamStep';
import { FirstTaskStep } from '../components/Onboarding/FirstTaskStep';
import { CloudConnectStep } from '../components/Onboarding/CloudConnectStep';
import { SlackConnectStep } from '../components/Onboarding/SlackConnectStep';
import { HarnessList } from '../components/Harness/HarnessList';
import { OrcHarnessPicker, defaultOrcChoice } from '../components/Harness/OrcHarnessPicker';
import { HarnessLoginCard } from '../components/Harness/HarnessLoginCard';
import { useHarnessStatus } from '../hooks/useHarnessStatus';
import { useOnboardingChecklist } from '../hooks/useOnboardingChecklist';
import { onboardingChecklistService } from '../services/onboarding-checklist.service';
import type { HarnessId } from '../types/harness.types';
import {
  findStep,
  isChecklistStepId,
  type ChecklistStepId,
  type OnboardingChecklist,
  type OnboardingStarter,
} from '../types/onboarding-checklist.types';
import { DEFAULT_ORC_HARNESS, LOGIN_STATE_BADGES, SETUP_DONE_ROUTE, harnessDisplayName, visibleHarnesses } from '../constants/harness.constants';
import {
  CHECKLIST_STEP_LABELS,
  SETUP_FLOW_STEPS,
  SETUP_STEP_QUERY,
} from '../constants/onboarding-checklist.constants';
import { setSetupSkipped } from '../utils/setup-redirect';

/** Step indexes. */
export const STEP = { HARNESS: 0, ORC: 1, LOGIN: 2, TEAM: 3, TASK: 4, CLOUD: 5, SLACK: 6, DONE: 7 } as const;

/** Step index for each `?step=` value. */
const STEP_FOR_QUERY: Record<ChecklistStepId, number> = {
  harness: STEP.HARNESS,
  team: STEP.TEAM,
  first_task: STEP.TASK,
  cloud: STEP.CLOUD,
  slack: STEP.SLACK,
};

/**
 * The step to open, from `?step=`.
 *
 * @param value - Query value
 * @returns Step index
 */
export function initialStepFromQuery(value: string | null): number {
  return isChecklistStepId(value) ? STEP_FOR_QUERY[value] : STEP.HARNESS;
}

/** Where the first task goes and what to suggest. */
interface TaskTarget {
  teamId: string | null;
  teamName: string | null;
  suggestions: string[];
  /** A solution bundle was deployed: its first-week tasks are already queued */
  bundle?: boolean;
}

/**
 * The first task's target when the team step was not just completed here:
 * the first existing team, with its starter's examples (Blank's otherwise).
 *
 * @param checklist - Checklist (for existing teams)
 * @param starters - Starter teams
 * @returns Target
 */
export function resolveTaskTarget(checklist: OnboardingChecklist | null, starters: OnboardingStarter[]): TaskTarget {
  const team = findStep(checklist, 'team')?.detail.teams[0] ?? null;
  const starter =
    (team?.templateId ? starters.find((s) => s.id === team.templateId) : undefined) ??
    starters.find((s) => s.members.length === 0) ??
    starters[0];
  return { teamId: team?.id ?? null, teamName: team?.name ?? null, suggestions: starter?.suggestions ?? [] };
}

/**
 * Step title with Chinese heading and short English subtitle.
 *
 * @param props - Title and subtitle
 * @returns Heading block
 */
const StepHeading: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => (
  <div className="mb-4">
    <h2 className="text-xl font-semibold text-text-primary-dark">{title}</h2>
    <p className="text-sm text-text-secondary-dark mt-1">{subtitle}</p>
  </div>
);

/**
 * Back / skip / next row of the checklist steps.
 *
 * @param props - Handlers and the primary label
 * @returns Button row
 */
const StepNav: React.FC<{ onBack: () => void; onNext: () => void; nextLabel: string; primary: boolean }> = ({
  onBack,
  onNext,
  nextLabel,
  primary,
}) => (
  <div className="mt-6 flex justify-between gap-3">
    <Button type="button" variant="ghost" icon={ArrowLeft} onClick={onBack}>
      Back
    </Button>
    <Button type="button" variant={primary ? 'primary' : 'secondary'} icon={ArrowRight} iconPosition="right" onClick={onNext}>
      {nextLabel}
    </Button>
  </div>
);

/**
 * First-run setup flow.
 *
 * @returns Page element
 */
export const Setup: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { overview, loading, error, refresh, setOrcHarness, savingOrc, replaceHarness } = useHarnessStatus();
  const { checklist, loading: checklistLoading, refresh: refreshChecklist } = useOnboardingChecklist();
  const [step, setStep] = useState<number>(() => initialStepFromQuery(searchParams.get(SETUP_STEP_QUERY)));
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>(DEFAULT_ORC_HARNESS);
  const [orcChoice, setOrcChoice] = useState<HarnessId | null>(null);
  const [taskTarget, setTaskTarget] = useState<TaskTarget | null>(null);
  const [taskSent, setTaskSent] = useState(false);
  // Set by the Cloud callback page when the sign-in came back with an error.
  const cloudError = searchParams.get('error');

  // Gemini CLI is retired for new users: listed only when already in use here.
  const harnesses = visibleHarnesses(overview?.harnesses ?? [], overview?.orcHarness);
  const anyInstalled = harnesses.some((h) => h.installed);
  const orcHarness = harnesses.find((h) => h.id === overview?.orcHarness) ?? null;

  // Entering the first-task step without having just picked a team (e.g.
  // from the dashboard): address the existing team with its starter's examples.
  useEffect(() => {
    if (step !== STEP.TASK || taskTarget || checklistLoading) return;
    let cancelled = false;
    onboardingChecklistService
      .getStarters()
      .then((starters) => {
        if (!cancelled) setTaskTarget(resolveTaskTarget(checklist, starters));
      })
      .catch(() => {
        if (!cancelled) setTaskTarget(resolveTaskTarget(checklist, []));
      });
    return () => {
      cancelled = true;
    };
  }, [step, taskTarget, checklist, checklistLoading]);

  /** "Skip for now": remember the choice and leave. */
  const handleSkip = (): void => {
    setSetupSkipped(true);
    navigate(SETUP_DONE_ROUTE, { replace: true });
  };

  /** Step 1 → 2, preselecting the orc choice. */
  const goToOrcStep = (): void => {
    setOrcChoice(defaultOrcChoice(harnesses, overview?.orcHarness ?? null, selectedHarness));
    setStep(STEP.ORC);
  };

  /** Step 2 → 3, saving the orc choice when it changed. */
  const confirmOrc = async (): Promise<void> => {
    if (!orcChoice) return;
    if (orcChoice !== overview?.orcHarness) {
      const ok = await setOrcHarness(orcChoice);
      if (!ok) return;
    }
    setStep(STEP.LOGIN);
  };

  /** Team created (or Blank chosen) → first task. */
  const onTeamDone = (done: StarterTeamDone): void => {
    setTaskTarget({ teamId: done.teamId, teamName: done.teamName, suggestions: done.suggestions, bundle: done.bundle });
    void refreshChecklist();
    setStep(STEP.TASK);
  };

  const onChecklistChanged = useCallback((): void => {
    void refreshChecklist();
  }, [refreshChecklist]);

  /** Placeholder while the checklist loads, or its load error. */
  const checklistGate = (): React.ReactNode =>
    checklistLoading ? (
      <LoadingSpinner centered />
    ) : (
      <Alert variant="error" size="sm">
        <div className="space-y-2">
          <p>Couldn&apos;t load the setup checklist.</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={onChecklistChanged}>
            Retry
          </Button>
        </div>
      </Alert>
    );

  /** Harness steps need the harness overview. */
  const renderHarnessGate = (): React.ReactNode => {
    if (loading) return <LoadingSpinner centered text="Checking coding harnesses…" />;
    return (
      <Alert variant="error" title="Couldn't load harness status">
        <div className="space-y-2">
          <p>{error}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  };

  /** Step body. */
  const renderStep = (): React.ReactNode => {
    if (step <= STEP.LOGIN && !overview) return renderHarnessGate();

    switch (step) {
      case STEP.HARNESS:
        return (
          <>
            <StepHeading
              title="Pick and install a coding harness"
              subtitle="Crewly's AI teammates work through a coding harness. Claude Code is recommended."
            />
            <HarnessList
              harnesses={harnesses}
              systemTools={overview?.systemTools ?? []}
              selectedId={selectedHarness}
              onSelect={setSelectedHarness}
              onInstallFinished={() => void refresh()}
            />
            <div className="mt-6 flex justify-end">
              <Button type="button" icon={ArrowRight} iconPosition="right" disabled={!anyInstalled} onClick={goToOrcStep}>
                Next
              </Button>
            </div>
            {!anyInstalled && (
              <p className="mt-2 text-right text-xs text-text-secondary-dark">Install at least one to continue.</p>
            )}
          </>
        );

      case STEP.ORC:
        return (
          <>
            <StepHeading title="Which harness should the Orc use?" subtitle="The orchestrator (Orc) coordinates your team. Choose its harness." />
            <OrcHarnessPicker harnesses={harnesses} value={orcChoice} onChange={setOrcChoice} disabled={savingOrc} />
            {error && (
              <Alert variant="error" size="sm" className="mt-3">
                {error}
              </Alert>
            )}
            <div className="mt-6 flex justify-between gap-3">
              <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep(STEP.HARNESS)}>
                Back
              </Button>
              <Button
                type="button"
                icon={ArrowRight}
                iconPosition="right"
                loading={savingOrc}
                disabled={!orcChoice}
                onClick={() => void confirmOrc()}
              >
                Next
              </Button>
            </div>
          </>
        );

      case STEP.LOGIN: {
        const loggedIn = orcHarness?.loginState === 'logged_in';
        return (
          <>
            <StepHeading title="Sign in" subtitle="Sign in so the orchestrator can work." />
            {orcHarness ? (
              <HarnessLoginCard harness={orcHarness} onLoggedIn={() => void refresh()} onHarnessUpdated={replaceHarness} />
            ) : (
              <Alert variant="warning" size="sm">Go back one step and choose the Orc&apos;s harness first.</Alert>
            )}
            <div className="mt-6 flex justify-between gap-3">
              <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep(STEP.ORC)}>
                Back
              </Button>
              <Button
                type="button"
                variant={loggedIn ? 'primary' : 'secondary'}
                icon={ArrowRight}
                iconPosition="right"
                onClick={() => setStep(STEP.TEAM)}
              >
                {loggedIn ? 'Next' : 'Sign in later'}
              </Button>
            </div>
          </>
        );
      }

      case STEP.TEAM: {
        const existing = findStep(checklist, 'team')?.detail.teams ?? [];
        return (
          <>
            <StepHeading title="Create your first team" subtitle="Pick a starter team. You can add more later." />
            {existing.length > 0 && (
              <Alert variant="success" size="sm" className="mb-3">
                Existing teams: {existing.map((t) => t.name).join(', ')}. You can go straight to the next step or create another.
              </Alert>
            )}
            <StarterTeamStep onDone={onTeamDone} />
            <StepNav onBack={() => setStep(STEP.LOGIN)} onNext={() => setStep(STEP.TASK)} nextLabel="Skip" primary={false} />
          </>
        );
      }

      case STEP.TASK:
        return (
          <>
            <StepHeading title="Give your team its first task" subtitle="One sentence is enough." />
            {taskTarget?.bundle && (
              <Alert variant="success" size="sm" className="mb-3" data-testid="setup-bundle-first-week">
                The first week of work is already planned and the team will start day by day. Want to add something else? Write it below.
              </Alert>
            )}
            {taskTarget ? (
              <FirstTaskStep
                suggestions={taskTarget.suggestions}
                teamId={taskTarget.teamId}
                teamName={taskTarget.teamName}
                onSent={() => {
                  setTaskSent(true);
                  onChecklistChanged();
                }}
              />
            ) : (
              <LoadingSpinner centered />
            )}
            <StepNav
              onBack={() => setStep(STEP.TEAM)}
              onNext={() => setStep(STEP.CLOUD)}
              nextLabel={taskSent ? 'Next' : 'Skip'}
              primary={taskSent}
            />
          </>
        );

      case STEP.CLOUD: {
        const cloud = findStep(checklist, 'cloud');
        return (
          <>
            <StepHeading title="Connect Crewly Cloud" subtitle="Manage Crewly from your phone; needed for Slack." />
            {cloudError && !cloud?.done && (
              <Alert variant="warning" size="sm" className="mb-3">
                Sign-in didn&apos;t finish ({cloudError}). Try again, or use copy and paste instead.
              </Alert>
            )}
            {cloud ? (
              <CloudConnectStep
                connected={cloud.done}
                tier={cloud.detail.tier}
                tokenPageSignInUrl={cloud.detail.tokenPageSignInUrl}
                onConnected={onChecklistChanged}
              />
            ) : (
              checklistGate()
            )}
            <StepNav
              onBack={() => setStep(STEP.TASK)}
              onNext={() => setStep(STEP.SLACK)}
              nextLabel={cloud?.done ? 'Next' : 'Skip'}
              primary={!!cloud?.done}
            />
          </>
        );
      }

      case STEP.SLACK: {
        const slack = findStep(checklist, 'slack');
        return (
          <>
            <StepHeading title="Connect Slack" subtitle="Talk to your team from Slack." />
            {slack ? (
              <SlackConnectStep
                connected={slack.done}
                cloudConnected={slack.detail.cloudConnected}
                onGoToCloud={() => setStep(STEP.CLOUD)}
                onConnected={onChecklistChanged}
              />
            ) : (
              checklistGate()
            )}
            <StepNav
              onBack={() => setStep(STEP.CLOUD)}
              onNext={() => setStep(STEP.DONE)}
              nextLabel={slack?.done ? 'Next' : 'Skip'}
              primary={!!slack?.done}
            />
          </>
        );
      }

      default: {
        const badge = orcHarness ? LOGIN_STATE_BADGES[orcHarness.loginState] : null;
        return (
          <div className="space-y-4" data-testid="setup-done">
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" />
              <StepHeading title="Setup complete" subtitle="You're ready to use Crewly." />
            </div>
            {orcHarness && badge && (
              <p className="text-center text-sm text-text-secondary-dark">
                The Orc uses <span className="font-semibold text-text-primary-dark">{harnessDisplayName(orcHarness)}</span>{' '}
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </p>
            )}
            {checklist && (
              <ul className="space-y-2" data-testid="setup-done-checklist">
                {checklist.steps.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    {s.done ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="Done" />
                    ) : (
                      <Circle className="h-4 w-4 text-text-secondary-dark" aria-label="Not done" />
                    )}
                    <span className={s.done ? 'text-text-primary-dark' : 'text-text-secondary-dark'}>{CHECKLIST_STEP_LABELS[s.id]}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-center text-xs text-text-secondary-dark">Unfinished steps stay in the &quot;Get started&quot; card on the dashboard. If a login expires, sign in again under Settings → Harness.</p>
            <div className="text-center">
              <Button type="button" size="default" onClick={() => navigate(SETUP_DONE_ROUTE, { replace: true })}>
                Open Crewly
              </Button>
            </div>
          </div>
        );
      }
    }
  };

  return (
    <CrewlyRoot className="min-h-screen px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Crewly setup</h1>
            <p className="text-sm text-text-secondary-dark">First-run setup</p>
          </div>
          {step !== STEP.DONE && (
            <Button type="button" variant="link" onClick={handleSkip} data-testid="setup-skip">
              Skip for now
            </Button>
          )}
        </header>
        {/* Phone: a compact counter; wider screens: the full indicator. */}
        <p className="mb-4 text-sm text-text-secondary-dark sm:hidden" data-testid="setup-step-counter">
          Step {step + 1}/{SETUP_FLOW_STEPS.length} · {SETUP_FLOW_STEPS[step]}
        </p>
        <div className="mb-6 hidden overflow-x-auto sm:block">
          <StepIndicator steps={[...SETUP_FLOW_STEPS]} currentStep={step} />
        </div>
        <Card padding="none" className="p-4 sm:p-6">
          {renderStep()}
        </Card>
      </div>
    </CrewlyRoot>
  );
};

export default Setup;
