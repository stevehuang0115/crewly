/**
 * PlanComparisonCard Component
 *
 * Side-by-side Free vs Pro plan comparison card.
 * Highlights the specific limit that was exceeded and includes
 * a billing interval toggle with upgrade CTA.
 *
 * @module components/PaymentWall/PlanComparisonCard
 */

import React from 'react';
import { Check } from 'lucide-react';
import { Button } from '../UI/Button';
import { Badge } from '../UI/Badge';
import type { LimitType, BillingInterval } from '../../types/payment-wall.types';
import {
  PLAN_FEATURES,
  PRO_PRICING,
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
  /** Called when the user clicks the upgrade button */
  onUpgrade: () => void;
}

/**
 * Shows Free vs Pro side-by-side plan comparison.
 *
 * On desktop (>= 768px) the two cards sit side by side; on mobile
 * they stack vertically. The row matching the exceeded limit is
 * highlighted in yellow.
 *
 * @param highlightedLimitType - Which limit row to highlight
 * @param billingInterval - Currently selected billing interval
 * @param onBillingToggle - Callback when billing toggle changes
 * @param onUpgrade - Callback when Upgrade Now is clicked
 * @returns Two plan cards (Free + Pro) with feature lists
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
}) => {
  const price = billingInterval === 'monthly' ? PRO_PRICING.monthly : PRO_PRICING.yearly;
  const savingsPercent = getYearlySavingsPercent();

  return (
    <div
      className="flex flex-col md:flex-row gap-3"
      data-testid="plan-comparison"
    >
      {/* Free Plan Card */}
      <div
        className="flex-1 bg-surface-dark border border-border-dark rounded-lg p-4"
        data-testid="plan-card-free"
      >
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-text-primary-dark">Free</h3>
          <Badge variant="default" size="sm">
            <span className="flex items-center gap-1">
              <Check size={12} />
              Current Plan
            </span>
          </Badge>
        </div>

        <ul className="space-y-2">
          {PLAN_FEATURES.map((feature) => {
            const isHighlighted = feature.limitType === highlightedLimitType;
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
                <Check size={14} className="text-text-secondary-dark shrink-0" />
                <span>
                  {feature.label}: {feature.freeValue}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Pro Plan Card */}
      <div
        className="flex-1 bg-surface-dark border border-primary rounded-lg p-4 ring-1 ring-primary/30"
        data-testid="plan-card-pro"
      >
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-text-primary-dark">Pro</h3>
          <Badge variant="primary" size="sm">
            Popular
          </Badge>
        </div>

        <ul className="space-y-2 mb-4">
          {PLAN_FEATURES.map((feature) => {
            const isHighlighted = feature.limitType === highlightedLimitType;
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
                <Check size={14} className="text-emerald-400 shrink-0" />
                <span>
                  {feature.label}: {feature.proValue}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Billing Toggle */}
        <div className="flex items-center gap-2 mb-3" data-testid="billing-toggle">
          <button
            className={`text-xs px-2 py-1 rounded ${
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
            className={`text-xs px-2 py-1 rounded ${
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

        {/* Price */}
        <div className="flex items-baseline gap-1 mb-3">
          <span
            className="text-lg font-bold text-text-primary-dark"
            data-testid="plan-price"
          >
            ${price}
          </span>
          <span className="text-xs text-text-secondary-dark">/mo</span>
        </div>

        {/* Upgrade CTA */}
        <Button
          variant="primary"
          fullWidth
          onClick={onUpgrade}
          data-testid="upgrade-now-btn"
        >
          Upgrade Now
        </Button>
      </div>

      {/* Enterprise Link */}
      <div className="basis-full text-center text-sm text-text-secondary-dark mt-2 md:col-span-2">
        Need Enterprise?{' '}
        <a
          href="mailto:team@crewlyai.com"
          className="text-primary hover:underline"
        >
          Contact us
        </a>
      </div>
    </div>
  );
};

PlanComparisonCard.displayName = 'PlanComparisonCard';
