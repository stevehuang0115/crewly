/**
 * StarterTeamStep
 *
 * First-run step "建第一个团队": pick a starter — Personal Assistant
 * (recommended, pre-selected), Marketing, or Blank (the orchestrator only) —
 * and create it through `POST /api/onboarding/starter-team`.
 *
 * Phone-width first: the choices stack as full-width tappable cards.
 *
 * @module components/Onboarding/StarterTeamStep
 */

import React, { useEffect, useState } from 'react';
import { Check, RefreshCw, Users } from 'lucide-react';
import { Alert, Badge, Button, Card, LoadingSpinner } from '@crewly/ui';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import type { OnboardingStarter, StarterTeamResult } from '../../types/onboarding-checklist.types';

/** What the parent learns once the team step is done. */
export interface StarterTeamDone {
  starterId: string;
  /** The created team (null for Blank) */
  teamId: string | null;
  teamName: string | null;
  /** Example first tasks for this starter */
  suggestions: string[];
}

export interface StarterTeamStepProps {
  /** Called after the team was created (or Blank recorded) */
  onDone: (done: StarterTeamDone) => void;
}

/**
 * Starter-team picker.
 *
 * @param props - {@link StarterTeamStepProps}
 * @returns Step body
 */
export const StarterTeamStep: React.FC<StarterTeamStepProps> = ({ onDone }) => {
  const [starters, setStarters] = useState<OnboardingStarter[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /** Load the starters and pre-select the recommended one. */
  const load = async (): Promise<void> => {
    setLoadError(null);
    try {
      const list = await onboardingChecklistService.getStarters();
      setStarters(list);
      setSelected((cur) => cur ?? (list.find((s) => s.recommended) ?? list[0])?.id ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Create the selected starter. */
  const create = async (): Promise<void> => {
    const starter = starters?.find((s) => s.id === selected);
    if (!starter) return;
    setCreating(true);
    setError(null);
    try {
      const result: StarterTeamResult = await onboardingChecklistService.createStarterTeam(starter.id);
      onDone({
        starterId: starter.id,
        teamId: result.team?.id ?? null,
        teamName: result.team?.name ?? null,
        suggestions: starter.suggestions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  if (loadError) {
    return (
      <Alert variant="error" title="无法读取团队模板">
        <div className="space-y-2">
          <p>{loadError}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void load()}>
            重试
          </Button>
        </div>
      </Alert>
    );
  }
  if (!starters) return <LoadingSpinner centered text="正在读取团队模板…" />;

  const chosen = starters.find((s) => s.id === selected) ?? null;

  return (
    <div className="space-y-3" data-testid="starter-team-step">
      <div role="radiogroup" aria-label="第一个团队" className="space-y-3">
        {starters.map((starter) => {
          const active = starter.id === selected;
          return (
            <Card
              key={starter.id}
              role="radio"
              aria-checked={active}
              tabIndex={0}
              interactive
              padding="md"
              data-testid={`starter-${starter.id}`}
              className={active ? 'border-primary ring-1 ring-primary cursor-pointer' : 'cursor-pointer'}
              onClick={() => setSelected(starter.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected(starter.id);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-text-primary-dark">{starter.label}</span>
                    <span className="text-xs text-text-secondary-dark">{starter.name}</span>
                    {starter.recommended && <Badge variant="primary">推荐</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary-dark">{starter.tagline}</p>
                  {starter.members.length > 0 && (
                    <p className="mt-2 flex items-center gap-1 text-xs text-text-secondary-dark">
                      <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {starter.members.map((m) => m.name).join('、')}
                    </p>
                  )}
                </div>
                {active && <Check className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
              </div>
            </Card>
          );
        })}
      </div>
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      <Button type="button" fullWidth loading={creating} disabled={!chosen} onClick={() => void create()} data-testid="starter-create">
        {chosen?.members.length === 0 ? '先只用 Orc' : `创建「${chosen?.label ?? ''}」`}
      </Button>
    </div>
  );
};

export default StarterTeamStep;
