/**
 * First-run Setup Page (`/setup`)
 *
 * Lets a non-technical user finish Crewly setup in the browser — on the
 * machine or from a phone:
 *   1. 编程助手 — see which harnesses are installed, install / update one
 *      (Claude Code pre-selected) with a live log.
 *   2. Orc — choose the harness the orchestrator runs on.
 *   3. 登录 — log in to that harness via the login broker or an API key.
 *   4. 团队 — first team from a starter: Personal Assistant (recommended),
 *      Marketing, or Blank (the orchestrator only).
 *   5. 第一件事 — one text box + three examples; sent to the orchestrator.
 *   6. Cloud — connect Crewly Cloud (Google sign-in that returns here, or
 *      paste the token from the portal's token page).
 *   7. Slack — one-click install through Crewly Cloud.
 *   8. 完成.
 *
 * Steps 4-7 are skippable. `?step=team|first_task|cloud|slack` opens the
 * page at that step (the dashboard "开始使用" card, the Cloud / Slack return
 * URLs, and `crewly onboard` use it). "稍后再说 / Skip for now" sets a
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
import { DEFAULT_ORC_HARNESS, LOGIN_STATE_BADGES, SETUP_DONE_ROUTE } from '../constants/harness.constants';
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
      上一步
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

  const harnesses = overview?.harnesses ?? [];
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

  /** "稍后再说": remember the choice and leave. */
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
          <p>无法读取设置清单。</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={onChecklistChanged}>
            重试
          </Button>
        </div>
      </Alert>
    );

  /** Harness steps need the harness overview. */
  const renderHarnessGate = (): React.ReactNode => {
    if (loading) return <LoadingSpinner centered text="正在检查编程助手…" />;
    return (
      <Alert variant="error" title="无法读取编程助手状态 / Couldn't load harness status">
        <div className="space-y-2">
          <p>{error}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
            重试 / Retry
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
              title="选择并安装编程助手"
              subtitle="Crewly 的 AI 员工通过编程助手工作。推荐 Claude Code。Pick and install a coding harness."
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
                下一步
              </Button>
            </div>
            {!anyInstalled && (
              <p className="mt-2 text-right text-xs text-text-secondary-dark">安装至少一个后才能继续。Install at least one to continue.</p>
            )}
          </>
        );

      case STEP.ORC:
        return (
          <>
            <StepHeading title="Orc 用哪个编程助手？" subtitle="The orchestrator (Orc) coordinates your team. Choose its harness." />
            <OrcHarnessPicker harnesses={harnesses} value={orcChoice} onChange={setOrcChoice} disabled={savingOrc} />
            {error && (
              <Alert variant="error" size="sm" className="mt-3">
                {error}
              </Alert>
            )}
            <div className="mt-6 flex justify-between gap-3">
              <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep(STEP.HARNESS)}>
                上一步
              </Button>
              <Button
                type="button"
                icon={ArrowRight}
                iconPosition="right"
                loading={savingOrc}
                disabled={!orcChoice}
                onClick={() => void confirmOrc()}
              >
                下一步
              </Button>
            </div>
          </>
        );

      case STEP.LOGIN: {
        const loggedIn = orcHarness?.loginState === 'logged_in';
        return (
          <>
            <StepHeading title="登录" subtitle="Sign in so the orchestrator can work." />
            {orcHarness ? (
              <HarnessLoginCard harness={orcHarness} onLoggedIn={() => void refresh()} onHarnessUpdated={replaceHarness} />
            ) : (
              <Alert variant="warning" size="sm">请先回到上一步选择 Orc 的编程助手。</Alert>
            )}
            <div className="mt-6 flex justify-between gap-3">
              <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep(STEP.ORC)}>
                上一步
              </Button>
              <Button
                type="button"
                variant={loggedIn ? 'primary' : 'secondary'}
                icon={ArrowRight}
                iconPosition="right"
                onClick={() => setStep(STEP.TEAM)}
              >
                {loggedIn ? '下一步' : '稍后登录'}
              </Button>
            </div>
          </>
        );
      }

      case STEP.TEAM: {
        const existing = findStep(checklist, 'team')?.detail.teams ?? [];
        return (
          <>
            <StepHeading title="建第一个团队" subtitle="Pick a starter team. You can add more later." />
            {existing.length > 0 && (
              <Alert variant="success" size="sm" className="mb-3">
                已有团队：{existing.map((t) => t.name).join('、')}。可以直接下一步，也可以再建一个。
              </Alert>
            )}
            <StarterTeamStep onDone={onTeamDone} />
            <StepNav onBack={() => setStep(STEP.LOGIN)} onNext={() => setStep(STEP.TASK)} nextLabel="跳过" primary={false} />
          </>
        );
      }

      case STEP.TASK:
        return (
          <>
            <StepHeading title="派第一件事" subtitle="Give your team its first task." />
            {taskTarget?.bundle && (
              <Alert variant="success" size="sm" className="mb-3" data-testid="setup-bundle-first-week">
                第一周的工作已经排好，团队会按天开始做。还想加一件事，也可以写在下面。
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
              nextLabel={taskSent ? '下一步' : '跳过'}
              primary={taskSent}
            />
          </>
        );

      case STEP.CLOUD: {
        const cloud = findStep(checklist, 'cloud');
        return (
          <>
            <StepHeading title="连接 Crewly Cloud" subtitle="Manage Crewly from your phone; needed for Slack." />
            {cloudError && !cloud?.done && (
              <Alert variant="warning" size="sm" className="mb-3">
                登录没有完成（{cloudError}），可以再试一次或改用复制粘贴。
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
              nextLabel={cloud?.done ? '下一步' : '跳过'}
              primary={!!cloud?.done}
            />
          </>
        );
      }

      case STEP.SLACK: {
        const slack = findStep(checklist, 'slack');
        return (
          <>
            <StepHeading title="连接 Slack" subtitle="Talk to your team from Slack." />
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
              nextLabel={slack?.done ? '下一步' : '跳过'}
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
              <StepHeading title="设置完成" subtitle="You're ready to use Crewly." />
            </div>
            {orcHarness && badge && (
              <p className="text-center text-sm text-text-secondary-dark">
                Orc 使用 <span className="font-semibold text-text-primary-dark">{orcHarness.displayName}</span>{' '}
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </p>
            )}
            {checklist && (
              <ul className="space-y-2" data-testid="setup-done-checklist">
                {checklist.steps.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    {s.done ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="已完成" />
                    ) : (
                      <Circle className="h-4 w-4 text-text-secondary-dark" aria-label="未完成" />
                    )}
                    <span className={s.done ? 'text-text-primary-dark' : 'text-text-secondary-dark'}>{CHECKLIST_STEP_LABELS[s.id]}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-center text-xs text-text-secondary-dark">没做完的步骤会留在首页的「开始使用」里；登录过期时，可在「设置 → Harness」里重新登录。</p>
            <div className="text-center">
              <Button type="button" size="default" onClick={() => navigate(SETUP_DONE_ROUTE, { replace: true })}>
                进入 Crewly
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
            <h1 className="text-2xl font-bold tracking-tight">Crewly 初始设置</h1>
            <p className="text-sm text-text-secondary-dark">First-run setup</p>
          </div>
          {step !== STEP.DONE && (
            <Button type="button" variant="link" onClick={handleSkip} data-testid="setup-skip">
              稍后再说 / Skip for now
            </Button>
          )}
        </header>
        {/* Phone: a compact counter; wider screens: the full indicator. */}
        <p className="mb-4 text-sm text-text-secondary-dark sm:hidden" data-testid="setup-step-counter">
          第 {step + 1}/{SETUP_FLOW_STEPS.length} 步 · {SETUP_FLOW_STEPS[step]}
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
