/**
 * PlanComparisonCard Component
 *
 * Side-by-side Starter / Pro / Max plan comparison card.
 * Highlights the specific limit that was exceeded and includes
 * a billing interval toggle with upgrade CTA.
 *
 * @module components/PaymentWall/PlanComparisonCard
 */

import React from 'react';
import { Check, Star, Zap } from 'lucide-react';
import { Button } from '../UI/Button';
import { Badge } from '../UI/Badge';
import type { LimitType, BillingInterval, PlanTier } from '../../types/payment-wall.types';
import {
  PLAN_FEATURES,
  PLAN_PRICING,
  getYearlySavingsPercent,
} from '../../types/payment-wall.types';

/**
 * Props for the PlanComparisonCard component
 */
export interface PlanComparisonCardProps {
  /** Limit type to highlight in feature rows */
  highlightedLimitType?: LimitType;
  /** Current billing interval selection */
  billingInterval: BillingInterval;
  /** Called when the user toggles between monthly/yearly */
  onBillingToggle: (interval: BillingInterval) => void;
  /** Called when the user clicks an upgrade button */
  onUpgrade: (planId: PlanTier) => void;
  /** User's current plan tier */
  currentPlan?: PlanTier;
}

/** Plan metadata for rendering cards */
const PLAN_CARDS: Array<{
  id: PlanTier;
  label: string;
  badge: string | null;
  badgeVariant: 'default' | 'primary' | 'success';
  icon: typeof Star;
  featureKey: 'freeValue' | 'proValue';
  highlighted: boolean;
}> = [
  { id: 'starter', label: 'Starter', badge: null, badgeVariant: 'default', icon: Star, featureKey: 'freeValue', highlighted: false },
  { id: 'pro', label: 'Pro', badge: 'Popular', badgeVariant: 'primary', icon: Zap, featureKey: 'proValue', highlighted: true },
  { id: 'max', label: 'Max', badge: 'Best Value', badgeVariant: 'success', icon: Zap, featureKey: 'proValue', highlighted: false },
];

/**
 * Shows Starter / Pro / Max side-by-side plan comparison.
 *
 * On desktop (>= 768px) the cards sit side by side; on mobile
 * they stack vertically. The row matching the exceeded limit is
 * highlighted in yellow.
 *
 * @param props - Component props
 * @returns Three plan cards with feature lists and upgrade CTAs
 *
 * @example
 * ```tsx
 * <PlanComparisonCard
 *   highlightedLimitType="limit:teams"
 *   billingInterval="monthly"
 *   onBillingToggle={setInterval}
 *   onUpgrade={handleUpgrade}
 * />
 * ```
 */
export const PlanComparisonCard: React.FC<PlanComparisonCardProps> = ({
  highlightedLimitType,
  billingInterval,
  onBillingToggle,
  onUpgrade,
  currentPlan,
}) => {
  const savingsPercent = getYearlySavingsPercent('pro');

  return (
    <div className="space-y-3">
      {/* Billing Toggle */}
      <div className="flex items-center justify-center gap-2" data-testid="billing-toggle">
        <button
          className={`text-xs px-3 py-1.5 rounded ${
            billingInterval === 'monthly'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary-dark hover:text-text-primary-dark'
          }`}
          onClick={() => onBillingToggle('monthly')}
          data-testid="billing-monthly"
        >
          Monthly
        </button>
        <button
          className={`text-xs px-3 py-1.5 rounded ${
            billingInterval === 'yearly'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary-dark hover:text-text-primary-dark'
          }`}
          onClick={() => onBillingToggle('yearly')}
          data-testid="billing-yearly"
        >
          Yearly
        </button>
        {billingInterval === 'yearly' && (
          <Badge variant="success" size="sm">
            Save {savingsPercent}%
          </Badge>
        )}
      </div>

      {/* Plan Cards */}
      <div
        className="flex flex-col md:flex-row gap-3"
        data-testid="plan-comparison"
      >
        {PLAN_CARDS.map((card) => {
          const pricing = PLAN_PRICING[card.id];
          const price = billingInterval === 'monthly' ? pricing.monthly : pricing.yearly;
          const isCurrent = currentPlan === card.id;
          const borderClass = card.highlighted
            ? 'border-primary ring-1 ring-primary/30'
            : 'border-border-dark';

          return (
            <div
              key={card.id}
              className={`flex-1 bg-surface-dark border rounded-lg p-4 ${borderClass}`}
              data-testid={`plan-card-${card.id}`}
            >
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-lg font-semibold text-text-primary-dark">
                  {card.label}
                </h3>
                {isCurrent && (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <Check size={12} />
                      Current
                    </span>
                  </Badge>
                )}
                {card.badge && !isCurrent && (
                  <Badge variant={card.badgeVariant} size="sm">
                    {card.badge}
                  </Badge>
                )}
              </div>

              {/* Price */}
              <div className="flex items-baseline gap-1 mb-3">
                <span
                  className="text-2xl font-bold text-text-primary-dark"
                  data-testid={`plan-price-${card.id}`}
                >
                  ${price}
                </span>
                <span className="text-xs text-text-secondary-dark">/mo</span>
              </div>

              {/* Features */}
              <ul className="space-y-2 mb-4">
                {PLAN_FEATURES.map((feature) => {
                  const isHighlighted = feature.limitType === highlightedLimitType;
                  const value = card.id === 'max' ? 'Unlimited' : feature[card.featureKey];
                  return (
                    <li
                      key={feature.label}
                      className={`flex items-center gap-2 text-sm px-2 py-1 rounded ${
                        isHighlighted
                          ? 'bg-yellow-500/10 text-yellow-500'
                          : 'text-text-secondary-dark'
                      }`}
                      data-testid={isHighlighted ? 'highlighted-row' : undefined}
                    >
                      <Check size={14} className={card.highlighted ? 'text-emerald-400 shrink-0' : 'text-text-secondary-dark shrink-0'} />
                      <span>
                        {feature.label}: {value}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* CTA */}
              {!isCurrent && (
                <Button
                  variant={card.highlighted ? 'primary' : 'secondary'}
                  fullWidth
                  onClick={() => onUpgrade(card.id)}
                  data-testid={`upgrade-${card.id}-btn`}
                >
                  {card.highlighted ? 'Upgrade Now' : `Choose ${card.label}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

PlanComparisonCard.displayName = 'PlanComparisonCard';
