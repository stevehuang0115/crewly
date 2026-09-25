/**
 * BundleDeployStep
 *
 * The `/setup` team step for a solution bundle: what the team does for the
 * owner, the deploy-time questions, then the one-step deploy with live
 * progress (`POST /api/bundles/apply` + `GET /api/bundles/apply/:jobId`).
 * Steps that wait for something (Slack not connected yet, services to
 * connect) are shown with what to do and a link; they finish by themselves.
 *
 * @module components/Onboarding/BundleDeployStep
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Alert, Badge, Button, LoadingSpinner } from '@crewly/ui';
import { BundleQuestionsForm } from './BundleQuestionsForm';
import { bundleService, BundleRequestError } from '../../services/bundle.service';
import {
  BUNDLE_POLL_INTERVAL_MS,
  BUNDLE_RUNTIME_LABELS,
  BUNDLE_SERVER_TIER_LABELS,
  BUNDLE_STEP_STATUS_LABELS,
} from '../../constants/bundle.constants';
import { isDeploymentFinished, type BundleAnswers, type BundleDeployment, type BundleDetail, type BundleStep } from '../../types/bundle.types';

/** What the parent learns when the bundle is deployed. */
export interface BundleDeployDone {
  starterId: string;
  /** The bundle's main team */
  teamId: string | null;
  teamName: string | null;
  /** Bundles send their own first-week tasks */
  suggestions: string[];
  /** Always true (tells the parent the first week is already planned) */
  bundle: true;
}

export interface BundleDeployStepProps {
  /** Bundle template id */
  templateId: string;
  /** Back to the starter list */
  onBack: () => void;
  onDone: (done: BundleDeployDone) => void;
  /** Progress polling interval (tests) */
  pollIntervalMs?: number;
}

/** Icon for a step state. */
const StepIcon: React.FC<{ status: BundleStep['status'] }> = ({ status }) => {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />;
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />;
  if (status === 'pending') return <Clock className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />;
  return <Circle className="h-4 w-4 shrink-0 text-text-secondary-dark" aria-hidden />;
};

/**
 * Deploy a solution bundle from `/setup`.
 *
 * @param props - {@link BundleDeployStepProps}
 * @returns Step body
 */
export const BundleDeployStep: React.FC<BundleDeployStepProps> = ({ templateId, onBack, onDone, pollIntervalMs = BUNDLE_POLL_INTERVAL_MS }) => {
  const [bundle, setBundle] = useState<BundleDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<BundleDeployment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Load the bundle and any earlier deployment on this machine. */
  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const data = await bundleService.getBundle(templateId);
      setBundle(data.bundle);
      if (data.deployment) setDeployment(data.deployment);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow a running deploy.
  useEffect(() => {
    if (!deployment || isDeploymentFinished(deployment)) return undefined;
    timer.current = setTimeout(() => {
      bundleService
        .getJob(deployment.jobId)
        .then(setDeployment)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, pollIntervalMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [deployment, pollIntervalMs]);

  /** Deploy with the owner's answers. */
  const deploy = async (answers: BundleAnswers): Promise<void> => {
    setSubmitting(true);
    setError(null);
    setProblems([]);
    try {
      setDeployment(await bundleService.apply(templateId, answers));
    } catch (err) {
      if (err instanceof BundleRequestError) setProblems([...err.missing, ...err.invalid].map((p) => p.id));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  /** Retry the steps that failed or waited (finished steps are kept). */
  const retry = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      setDeployment(await bundleService.apply(templateId, {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  /** Hand the main team to the parent. */
  const finish = (): void => {
    const main = deployment?.teams[0] ?? null;
    onDone({ starterId: templateId, teamId: main?.teamId ?? null, teamName: main?.name ?? null, suggestions: [], bundle: true });
  };

  if (loadError) {
    return (
      <Alert variant="error" title="无法读取这个方案">
        <div className="space-y-2">
          <p>{loadError}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void load()}>
              重试
            </Button>
            <Button type="button" size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>
              换一个
            </Button>
          </div>
        </div>
      </Alert>
    );
  }
  if (!bundle) return <LoadingSpinner centered text="正在读取方案…" />;

  if (deployment) {
    const finished = isDeploymentFinished(deployment);
    const hasFailures = deployment.steps.some((s) => s.status === 'failed');
    const toConnect = deployment.connectors.filter((c) => c.status !== 'connected');
    return (
      <div className="space-y-4" data-testid="bundle-progress">
        <p className="text-sm text-text-secondary-dark">
          {finished ? `「${bundle.label}」已部署。` : `正在部署「${bundle.label}」…`}
        </p>
        <ul className="space-y-2">
          {deployment.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2 text-sm" data-testid={`bundle-step-${step.id}`}>
              <StepIcon status={step.status} />
              <div className="min-w-0">
                <span className="text-text-primary-dark">{step.label}</span>{' '}
                <span className="text-xs text-text-secondary-dark">· {BUNDLE_STEP_STATUS_LABELS[step.status]}</span>
                {(step.error ?? step.message) && <p className="text-xs text-text-secondary-dark">{step.error ?? step.message}</p>}
              </div>
            </li>
          ))}
        </ul>
        {toConnect.length > 0 && (
          <Alert variant="info" size="sm" title="还要连上这些服务（手机上也能点）">
            <ul className="space-y-1" data-testid="bundle-connect-list">
              {toConnect.map((c) => (
                <li key={c.id}>
                  <a className="text-primary underline" href={c.connectPath}>
                    {c.id}
                    {c.products.length > 0 ? `（${c.products.join('、')}）` : ''}
                  </a>
                  {c.required ? '' : '（可选）'}：{c.why}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {error && (
          <Alert variant="error" size="sm">
            {error}
          </Alert>
        )}
        {finished && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {hasFailures && (
              <Button type="button" variant="secondary" icon={RefreshCw} loading={submitting} onClick={() => void retry()} data-testid="bundle-retry">
                重试出错的步骤
              </Button>
            )}
            <Button type="button" fullWidth onClick={finish} data-testid="bundle-finish">
              下一步
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="bundle-deploy-step">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-text-primary-dark">{bundle.label}</h3>
          <Badge variant="primary">{BUNDLE_RUNTIME_LABELS[bundle.recommendedRuntime] ?? bundle.recommendedRuntime}</Badge>
          <Badge>{BUNDLE_SERVER_TIER_LABELS[bundle.serverTier] ?? bundle.serverTier}</Badge>
        </div>
        <p className="mt-2 whitespace-pre-line text-sm text-text-secondary-dark">{bundle.ownerSummary}</p>
        {bundle.ownerDoes.length > 0 && (
          <div className="mt-2 text-sm text-text-secondary-dark">
            <p className="font-medium text-text-primary-dark">你需要做的：</p>
            <ul className="list-disc pl-5">
              {bundle.ownerDoes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-2 text-xs text-text-secondary-dark">
          成员：{bundle.teams.flatMap((t) => t.members.map((m) => `${m.name}（${m.title}）`)).join('、')}
        </p>
      </div>
      <BundleQuestionsForm
        questions={bundle.questions}
        submitLabel={`部署「${bundle.label}」`}
        submitting={submitting}
        error={error}
        serverProblems={problems}
        onSubmit={(answers) => void deploy(answers)}
      />
      <Button type="button" variant="ghost" icon={ArrowLeft} onClick={onBack}>
        换一个
      </Button>
    </div>
  );
};

export default BundleDeployStep;
