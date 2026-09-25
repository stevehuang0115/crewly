/**
 * First-run Setup Page (`/setup`)
 *
 * Lets a non-technical user finish Crewly setup in the browser:
 *   1. 编程助手 — see which harnesses are installed, install / update one
 *      (Claude Code pre-selected) with a live log.
 *   2. Orc — choose the harness the orchestrator runs on.
 *   3. 登录 — log in to that harness via the login broker or an API key.
 *   4. 完成 — enter Crewly.
 *
 * "稍后再说 / Skip for now" sets a localStorage flag so the first-run
 * redirect (SetupRedirectGuard) doesn't loop.
 *
 * @module pages/Setup
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, CrewlyRoot, LoadingSpinner } from '@crewly/ui';
import { StepIndicator } from '../components/Onboarding/StepIndicator';
import { HarnessList } from '../components/Harness/HarnessList';
import { OrcHarnessPicker, defaultOrcChoice } from '../components/Harness/OrcHarnessPicker';
import { HarnessLoginCard } from '../components/Harness/HarnessLoginCard';
import { useHarnessStatus } from '../hooks/useHarnessStatus';
import type { HarnessId } from '../types/harness.types';
import {
  DEFAULT_ORC_HARNESS,
  LOGIN_STATE_BADGES,
  SETUP_DONE_ROUTE,
  SETUP_STEPS,
} from '../constants/harness.constants';
import { setSetupSkipped } from '../utils/setup-redirect';

/** Step indexes. */
const STEP = { HARNESS: 0, ORC: 1, LOGIN: 2, DONE: 3 } as const;

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
 * First-run setup flow.
 *
 * @returns Page element
 */
export const Setup: React.FC = () => {
  const navigate = useNavigate();
  const { overview, loading, error, refresh, setOrcHarness, savingOrc, replaceHarness } = useHarnessStatus();
  const [step, setStep] = useState<number>(STEP.HARNESS);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>(DEFAULT_ORC_HARNESS);
  const [orcChoice, setOrcChoice] = useState<HarnessId | null>(null);

  const harnesses = overview?.harnesses ?? [];
  const anyInstalled = harnesses.some((h) => h.installed);
  const orcHarness = harnesses.find((h) => h.id === overview?.orcHarness) ?? null;

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

  /** Step body. */
  const renderStep = (): React.ReactNode => {
    if (loading) return <LoadingSpinner centered text="正在检查编程助手…" />;
    if (!overview) {
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
    }

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
              systemTools={overview.systemTools}
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
                onClick={() => setStep(STEP.DONE)}
              >
                {loggedIn ? '下一步' : '稍后登录'}
              </Button>
            </div>
          </>
        );
      }

      default: {
        const badge = orcHarness ? LOGIN_STATE_BADGES[orcHarness.loginState] : null;
        return (
          <div className="text-center space-y-4" data-testid="setup-done">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" />
            <StepHeading title="设置完成" subtitle="You're ready to use Crewly." />
            {orcHarness && badge && (
              <p className="text-sm text-text-secondary-dark">
                Orc 使用 <span className="font-semibold text-text-primary-dark">{orcHarness.displayName}</span>{' '}
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </p>
            )}
            <p className="text-xs text-text-secondary-dark">登录过期时，可在「设置 → Harness」里重新登录。</p>
            <Button type="button" size="default" onClick={() => navigate(SETUP_DONE_ROUTE, { replace: true })}>
              进入 Crewly
            </Button>
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
        <div className="mb-6 overflow-x-auto">
          <StepIndicator steps={[...SETUP_STEPS]} currentStep={step} />
        </div>
        <Card padding="none" className="p-4 sm:p-6">
          {renderStep()}
        </Card>
      </div>
    </CrewlyRoot>
  );
};

export default Setup;
