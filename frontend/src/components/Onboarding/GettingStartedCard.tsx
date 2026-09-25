/**
 * GettingStartedCard
 *
 * The dashboard's persistent "开始使用" checklist: harness → first team →
 * first task → Crewly Cloud → Slack, each read from the live system
 * (`GET /api/onboarding/checklist`). Shown until every step is done or the
 * owner hides it (stored on the backend, so the phone and the laptop agree).
 * Each open step links into `/setup?step=<id>`.
 *
 * @module components/Onboarding/GettingStartedCard
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Circle, X } from 'lucide-react';
import { Button, Card, IconButton } from '@crewly/ui';
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist';
import {
  CHECKLIST_STEP_HINTS,
  CHECKLIST_STEP_LABELS,
  setupStepPath,
} from '../../constants/onboarding-checklist.constants';
import { SETUP_ROUTE } from '../../constants/harness.constants';
import type { ChecklistStepId } from '../../types/onboarding-checklist.types';

/**
 * Where an open step is finished.
 *
 * @param id - Step id
 * @returns Route
 */
export function stepRoute(id: ChecklistStepId): string {
  return id === 'harness' ? SETUP_ROUTE : setupStepPath(id);
}

/**
 * Dashboard checklist card. Renders nothing while loading, on error, when
 * every step is done, or when hidden.
 *
 * @returns Card or null
 */
export const GettingStartedCard: React.FC = () => {
  const navigate = useNavigate();
  const { checklist, setDismissed } = useOnboardingChecklist();

  if (!checklist || checklist.allDone || checklist.dismissed) return null;
  const next = checklist.steps.find((s) => !s.done);

  return (
    <Card padding="none" className="p-4 sm:p-5" data-testid="getting-started-card">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary-dark">开始使用</h2>
          <p className="text-sm text-text-secondary-dark">
            已完成 {checklist.doneCount}/{checklist.total} 步
          </p>
        </div>
        <IconButton icon={X} aria-label="隐藏开始使用清单" title="隐藏" onClick={() => void setDismissed(true)} data-testid="getting-started-dismiss" />
      </div>
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-background-dark" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(checklist.doneCount / Math.max(1, checklist.total)) * 100}%` }} />
      </div>
      <ul className="divide-y divide-border-dark">
        {checklist.steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              disabled={step.done}
              onClick={() => navigate(stepRoute(step.id))}
              className="flex w-full items-center gap-3 py-3 text-left disabled:cursor-default"
              data-testid={`getting-started-step-${step.id}`}
            >
              {step.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" aria-label="已完成" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-text-secondary-dark" aria-label="未完成" />
              )}
              <span className="min-w-0 flex-1">
                <span className={step.done ? 'block text-sm text-text-secondary-dark line-through' : 'block text-sm font-medium text-text-primary-dark'}>
                  {CHECKLIST_STEP_LABELS[step.id]}
                </span>
                {!step.done && <span className="block text-xs text-text-secondary-dark">{CHECKLIST_STEP_HINTS[step.id]}</span>}
              </span>
              {!step.done && <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary-dark" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
      {next && (
        <Button type="button" fullWidth className="mt-3" onClick={() => navigate(stepRoute(next.id))} data-testid="getting-started-continue">
          继续：{CHECKLIST_STEP_LABELS[next.id]}
        </Button>
      )}
    </Card>
  );
};

export default GettingStartedCard;
