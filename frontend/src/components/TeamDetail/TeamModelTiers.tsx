/**
 * TeamModelTiers — the team's "Optimize usage" switch and each member's
 * model tier (strong / mid / weak), crewly#1173.
 *
 * While "Optimize usage" is on, the team lead reviews the team's token usage
 * weekly and proposes tier changes; the owner approves each proposal on a
 * card. Here the owner flips the switch, sets a member's tier directly, or
 * asks for a review now.
 *
 * @module components/TeamDetail/TeamModelTiers
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, FormSelect, Toggle } from '@crewly/ui';
import { apiService } from '../../services/api.service';
import type { ModelTier, TeamModelTierSettings } from '../../types';

export interface TeamModelTiersProps {
  /** Team id */
  teamId: string;
}

/** Tier options of the dropdown. */
const TIER_OPTIONS: ReadonlyArray<{ value: ModelTier | ''; label: string }> = [
  { value: '', label: 'No tier (default)' },
  { value: 'strong', label: 'Strong' },
  { value: 'mid', label: 'Mid' },
  { value: 'weak', label: 'Weak' },
];

/**
 * A date as a short local day ("Oct 15").
 *
 * @param iso - ISO time or null
 * @returns Text, or "–"
 */
export function shortDay(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Model tiers panel for the team page.
 *
 * @param props.teamId - Team id
 * @returns The panel, or null while loading / unavailable
 */
export function TeamModelTiers({ teamId }: TeamModelTiersProps): JSX.Element | null {
  const [data, setData] = useState<TeamModelTierSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await apiService.getTeamModelTiers(teamId);
        if (!cancelled) setData(d);
      } catch {
        // Non-fatal (older backend): the panel stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const save = useCallback(
    async (patch: { optimizeUsage?: boolean; memberTiers?: Record<string, ModelTier | ''> }) => {
      setSaving(true);
      setMessage(null);
      try {
        setData(await apiService.updateTeamModelTiers(teamId, patch));
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setSaving(false);
      }
    },
    [teamId],
  );

  const reviewNow = useCallback(async () => {
    setMessage(null);
    try {
      const r = await apiService.startTeamModelTierReview(teamId);
      setMessage(`Review sent to ${r.lead}. Their proposal comes to you as one card.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not start the review');
    }
  }, [teamId]);

  if (!data) return null;
  const { review } = data;
  return (
    <section aria-labelledby="team-model-tiers-h" data-testid="team-model-tiers">
      <h3 id="team-model-tiers-h" className="mb-2 text-[13px] font-semibold text-text-2">
        Model tiers
      </h3>
      <Toggle
        label="Optimize usage"
        description="The team lead reviews token usage weekly and proposes which members move to a cheaper or stronger model. You approve every change."
        checked={data.optimizeUsage}
        disabled={saving}
        onChange={(e) => void save({ optimizeUsage: e.target.checked })}
        data-testid="optimize-usage-toggle"
      />
      <ul className="mt-3 flex flex-col gap-2">
        {data.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 text-[13px]" data-testid={`tier-row-${m.id}`}>
            <span className="w-28 truncate text-text">
              {m.name}
              {m.isLead ? ' (lead)' : ''}
            </span>
            <div className="w-40">
              <FormSelect
                aria-label={`Tier of ${m.name}`}
                value={m.tier ?? ''}
                disabled={saving}
                onChange={(e) => void save({ memberTiers: { [m.id]: e.target.value as ModelTier | '' } })}
              >
                {TIER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </FormSelect>
            </div>
            <span className="text-text-3">
              runs {m.model}
              {m.modelId ? ' (fixed model; it wins over the tier)' : ''}
            </span>
          </li>
        ))}
      </ul>
      {data.optimizeUsage && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-text-3">
          <span data-testid="tier-review-state">
            {review.openDecisionId
              ? `Proposal ${review.openDecisionId} waits for your answer`
              : review.drafting
                ? 'The lead is reviewing now'
                : `Last review ${shortDay(review.lastReviewAt)} · next ${shortDay(review.nextReviewAt)}`}
          </span>
          <Button variant="link" size="xs" onClick={() => void reviewNow()} disabled={!!review.openDecisionId || review.drafting}>
            Review now
          </Button>
        </div>
      )}
      {data.routingRules.length > 0 && (
        <div className="mt-2 text-[13px] text-text-3">
          Routing: {data.routingRules.join('; ')}
        </div>
      )}
      {message && (
        <p className="mt-2 text-[13px] text-text-2" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
