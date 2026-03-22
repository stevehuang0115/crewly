/**
 * Payment Wall — Trial Limit Upgrade Prompt
 *
 * A two-level upgrade prompt system that activates when free-tier users
 * exceed trial limits. Follows the UX spec at specs/tasks/phase2-ux/payment-wall-ui.md.
 *
 * Level 1 (Banner): Inline, dismissible, soft prompt (1st–3rd encounter)
 * Level 2 (Modal): Plan comparison with upgrade CTA (4th+ encounter)
 *
 * Design principles:
 * - Non-blocking — never prevents continuing current workflow
 * - Contextual — shows the specific limit that was exceeded
 * - Dismissible — always allows "Not now" with no penalty
 * - Honest — real usage numbers, no artificial urgency
 *
 * @module components/PaymentWall/PaymentWall
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Zap, X, Check, ArrowRight } from 'lucide-react';
import { Modal } from '../UI/Modal.js';
import { Button } from '../UI/Button.js';
import { Badge } from '../UI/Badge.js';
import type {
  TrialLimitEvent,
  LimitType,
  BillingInterval,
  EscalationLevel,
  PlanFeature,
} from '../../types/payment-wall.types.js';
import {
  LIMIT_COPY,
  PLAN_FEATURES,
  PRO_PRICING,
  PAYWALL_STORAGE_PREFIX,
  ESCALATION_THRESHOLD,
  getYearlySavingsPercent,
} from '../../types/payment-wall.types.js';

// ========================= Banner (Level 1) =========================

/**
 * Props for the PaymentWallBanner component
 */
export interface PaymentWallBannerProps {
  /** The limit event that triggered the banner */
  event: TrialLimitEvent;
  /** Called when user clicks "Upgrade" — opens the modal */
  onUpgrade: () => void;
  /** Called when user dismisses the banner */
  onDismiss: () => void;
}

/**
 * Inline soft banner shown on the first 3 encounters per limit type.
 *
 * Appears above the blocked action's container. Uses the same dark surface
 * palette as CloudBar with a primary-blue left border accent.
 *
 * @param event - The trial limit event from the backend 402 response
 * @param onUpgrade - Callback to escalate to the modal
 * @param onDismiss - Callback to dismiss the banner
 * @returns PaymentWallBanner component
 *
 * @example
 * ```tsx
 * <PaymentWallBanner
 *   event={{ limitType: 'limit:teams', current: 2, max: 2, plan: 'free' }}
 *   onUpgrade={() => setShowModal(true)}
 *   onDismiss={() => setShowBanner(false)}
 * />
 * ```
 */
export const PaymentWallBanner: React.FC<PaymentWallBannerProps> = ({
  event,
  onUpgrade,
  onDismiss,
}) => {
  const copy = LIMIT_COPY[event.limitType];
  const bannerText = copy.bannerCopy.replace('{max}', String(event.max));

  return (
    <div
      className="relative flex items-start gap-3 px-4 py-3 rounded-lg border-l-4 border-l-primary bg-surface-dark animate-slideDown"
      role="alert"
      aria-live="polite"
      data-testid="payment-wall-banner"
    >
      <Zap className="text-primary shrink-0 mt-0.5" size={18} />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary-dark">{bannerText}</p>
      </div>

      <Button
        variant="primary"
        size="sm"
        onClick={onUpgrade}
        data-testid="banner-upgrade-btn"
      >
        Upgrade
      </Button>

      <button
        onClick={onDismiss}
        className="text-text-secondary-dark hover:text-text-primary-dark transition-colors p-1"
        aria-label="Dismiss upgrade banner"
        data-testid="banner-dismiss-btn"
      >
        <X size={16} />
      </button>
    </div>
  );
};

PaymentWallBanner.displayName = 'PaymentWallBanner';

// ========================= Usage Progress Bar =========================

/**
 * Props for the UsageProgressBar component
 */
interface UsageProgressBarProps {
  /** Current usage count */
  current: number;
  /** Maximum allowed by plan */
  max: number;
  /** Accessible label */
  label: string;
}

/**
 * Mini progress bar showing current/max usage.
 *
 * Fills in primary blue when under limit, yellow when at 100%.
 *
 * @param current - Current usage count
 * @param max - Maximum allowed
 * @param label - Accessible label for screen readers
 * @returns UsageProgressBar component
 */
const UsageProgressBar: React.FC<UsageProgressBarProps> = ({ current, max, label }) => {
  const percent = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const isAtLimit = current >= max;

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-text-secondary-dark mb-1">
        <span>{current}/{max} {label}</span>
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-background-dark overflow-hidden"
        role="progressbar"
        aria-valuenow={current}
        aria-valuemax={max}
        aria-label={`${label} usage: ${current} of ${max}`}
      >
        <div
          className={`h-full rounded-full transition-all duration-400 ease-out ${
            isAtLimit ? 'bg-yellow-500' : 'bg-primary'
          }`}
          style={{ width: `${percent}%` }}
          data-testid="usage-bar-fill"
        />
      </div>
    </div>
  );
};

UsageProgressBar.displayName = 'UsageProgressBar';

// ========================= Plan Comparison Card =========================

/**
 * Props for the PlanComparisonCard component
 */
interface PlanComparisonCardProps {
  /** Plan tier name */
  planName: string;
  /** Whether this is the user's current plan */
  isCurrent: boolean;
  /** Whether this is the recommended (highlighted) plan */
  isRecommended: boolean;
  /** Feature values to display (use freeValue or proValue) */
  features: Array<{ label: string; value: string; isHighlighted: boolean }>;
  /** Footer content */
  footer: React.ReactNode;
}

/**
 * Reusable plan card for the comparison view in the modal.
 *
 * The recommended card (Pro) gets a primary border glow.
 *
 * @param planName - Display name of the plan
 * @param isCurrent - Whether user is on this plan
 * @param isRecommended - Whether to highlight with glow border
 * @param features - Feature rows to display
 * @param footer - Footer content (price, CTA, etc.)
 * @returns PlanComparisonCard component
 */
const PlanComparisonCard: React.FC<PlanComparisonCardProps> = ({
  planName,
  isCurrent,
  isRecommended,
  features,
  footer,
}) => {
  const borderClass = isRecommended
    ? 'border-primary ring-1 ring-primary/30'
    : 'border-border-dark';

  return (
    <div
      className={`flex flex-col rounded-lg border bg-surface-dark p-4 ${borderClass}`}
      data-testid={`plan-card-${planName.toLowerCase()}`}
    >
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-text-primary-dark">{planName}</h3>
        {isRecommended && (
          <Badge variant="primary" size="sm">Popular</Badge>
        )}
        {isCurrent && (
          <Badge variant="default" size="sm">Current</Badge>
        )}
      </div>

      <ul className="flex-1 space-y-2 mb-4">
        {features.map((feature) => (
          <li
            key={feature.label}
            className={`flex items-center gap-2 text-sm rounded px-2 py-1 ${
              feature.isHighlighted
                ? 'bg-yellow-500/10 text-yellow-400'
                : 'text-text-secondary-dark'
            }`}
          >
            <Check
              size={14}
              className={isRecommended ? 'text-emerald-500 shrink-0' : 'text-text-secondary-dark shrink-0'}
            />
            <span>{feature.value}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto">{footer}</div>
    </div>
  );
};

PlanComparisonCard.displayName = 'PlanComparisonCard';

// ========================= Modal (Level 2) =========================

/**
 * Props for the PaymentWallModal component
 */
export interface PaymentWallModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The limit event that triggered the modal */
  event: TrialLimitEvent;
  /** Called when user closes the modal */
  onClose: () => void;
  /** Called when user clicks "Upgrade Now" with selected billing interval */
  onUpgrade: (interval: BillingInterval) => void;
}

/**
 * Escalated modal with full plan comparison, shown on 4th+ encounter
 * or when user clicks "Upgrade" on the banner.
 *
 * Features:
 * - Side-by-side Free vs Pro plan comparison
 * - Highlighted row for the exceeded limit
 * - Monthly/yearly billing toggle
 * - Usage progress bar
 * - Enterprise contact link
 * - "Maybe Later" dismiss
 *
 * @param isOpen - Controls modal visibility
 * @param event - The trial limit event from the backend
 * @param onClose - Called when modal is dismissed
 * @param onUpgrade - Called with selected billing interval on upgrade click
 * @returns PaymentWallModal component
 *
 * @example
 * ```tsx
 * <PaymentWallModal
 *   isOpen={showModal}
 *   event={{ limitType: 'limit:teams', current: 2, max: 2, plan: 'free' }}
 *   onClose={() => setShowModal(false)}
 *   onUpgrade={(interval) => api.createCheckout('pro', interval)}
 * />
 * ```
 */
export const PaymentWallModal: React.FC<PaymentWallModalProps> = ({
  isOpen,
  event,
  onClose,
  onUpgrade,
}) => {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');

  const limitCopy = LIMIT_COPY[event.limitType];
  const price = billingInterval === 'monthly' ? PRO_PRICING.monthly : PRO_PRICING.yearly;
  const savingsPercent = getYearlySavingsPercent();

  /** Build feature rows with highlighting for the exceeded limit */
  const freeFeatures = useMemo(
    () =>
      PLAN_FEATURES.map((f: PlanFeature) => ({
        label: f.label,
        value: f.freeValue,
        isHighlighted: f.limitType === event.limitType,
      })),
    [event.limitType],
  );

  const proFeatures = useMemo(
    () =>
      PLAN_FEATURES.map((f: PlanFeature) => ({
        label: f.label,
        value: f.proValue,
        isHighlighted: f.limitType === event.limitType,
      })),
    [event.limitType],
  );

  const handleUpgrade = useCallback(() => {
    onUpgrade(billingInterval);
  }, [onUpgrade, billingInterval]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      className="payment-wall-modal"
    >
      {/* Header */}
      <div className="text-center mb-6" data-testid="paywall-header">
        <Zap className="text-primary mx-auto mb-3" size={32} />
        <h2
          id="paywall-title"
          className="text-xl font-bold text-text-primary-dark mb-2"
        >
          Unlock the Full Crewly
        </h2>
        <p className="text-sm text-text-secondary-dark">
          You've hit the free plan limit for {limitCopy.label}.
        </p>

        {/* Usage progress */}
        <div className="mt-3 max-w-[200px] mx-auto">
          <UsageProgressBar
            current={event.current}
            max={event.max}
            label={limitCopy.label}
          />
        </div>
      </div>

      {/* Plan comparison — side by side on desktop, stacked on mobile */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4"
        data-testid="plan-comparison"
      >
        {/* Free plan card */}
        <PlanComparisonCard
          planName="Free"
          isCurrent={event.plan === 'free'}
          isRecommended={false}
          features={freeFeatures}
          footer={
            <div className="flex items-center gap-1 text-sm text-text-secondary-dark">
              <Check size={14} />
              <span>Current Plan</span>
            </div>
          }
        />

        {/* Pro plan card */}
        <PlanComparisonCard
          planName="Pro"
          isCurrent={event.plan === 'pro'}
          isRecommended={true}
          features={proFeatures}
          footer={
            <div>
              {/* Billing toggle */}
              <div className="flex items-center gap-2 mb-3" data-testid="billing-toggle">
                <button
                  className={`text-xs px-2 py-1 rounded ${
                    billingInterval === 'monthly'
                      ? 'bg-primary/20 text-primary'
                      : 'text-text-secondary-dark hover:text-text-primary-dark'
                  }`}
                  onClick={() => setBillingInterval('monthly')}
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
                  onClick={() => setBillingInterval('yearly')}
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

              <div className="flex items-baseline gap-1 mb-3">
                <span className="text-lg font-bold text-text-primary-dark">
                  ${price}
                </span>
                <span className="text-xs text-text-secondary-dark">/mo</span>
              </div>

              <Button
                variant="primary"
                fullWidth
                icon={ArrowRight}
                iconPosition="right"
                onClick={handleUpgrade}
                data-testid="upgrade-now-btn"
              >
                Upgrade Now
              </Button>
            </div>
          }
        />
      </div>

      {/* Enterprise link */}
      <p className="text-center text-sm text-text-secondary-dark mb-4">
        Need Enterprise?{' '}
        <a
          href="mailto:team@crewlyai.com"
          className="text-primary hover:underline"
        >
          Contact us <ArrowRight size={12} className="inline" />
        </a>
      </p>

      {/* Maybe Later */}
      <div className="text-center">
        <Button
          variant="ghost"
          onClick={onClose}
          data-testid="maybe-later-btn"
        >
          Maybe Later
        </Button>
      </div>
    </Modal>
  );
};

PaymentWallModal.displayName = 'PaymentWallModal';

// ========================= Escalation Logic =========================

/**
 * Read the encounter count for a given limit type from localStorage.
 *
 * Includes monthly reset logic — if the stored timestamp is older than
 * 30 days, the counter resets to 0.
 *
 * @param limitType - The limit identifier to look up
 * @returns Current encounter count (0 if never seen or reset)
 */
export function getEncounterCount(limitType: LimitType): number {
  const key = `${PAYWALL_STORAGE_PREFIX}hits_${limitType}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { count: number; timestamp: number };
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - parsed.timestamp > thirtyDays) {
      localStorage.removeItem(key);
      return 0;
    }
    return parsed.count;
  } catch {
    return 0;
  }
}

/**
 * Increment the encounter count for a given limit type in localStorage.
 *
 * @param limitType - The limit identifier to increment
 * @returns The new count after incrementing
 */
export function incrementEncounterCount(limitType: LimitType): number {
  const key = `${PAYWALL_STORAGE_PREFIX}hits_${limitType}`;
  const current = getEncounterCount(limitType);
  const newCount = current + 1;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ count: newCount, timestamp: Date.now() }),
    );
  } catch {
    // localStorage full or unavailable — degrade gracefully
  }
  return newCount;
}

/**
 * Determine the escalation level based on encounter count.
 *
 * Returns 'banner' for 1–3 encounters, 'modal' for 4+.
 *
 * @param limitType - The limit type to check
 * @returns The escalation level ('banner' or 'modal')
 */
export function getEscalationLevel(limitType: LimitType): EscalationLevel {
  const count = getEncounterCount(limitType);
  return count > ESCALATION_THRESHOLD ? 'modal' : 'banner';
}

/**
 * Check if a banner has been dismissed in the current session.
 *
 * @param limitType - The limit type to check
 * @returns Whether the banner was dismissed this session
 */
export function isBannerDismissedThisSession(limitType: LimitType): boolean {
  const key = `${PAYWALL_STORAGE_PREFIX}dismissed_${limitType}`;
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Mark a banner as dismissed for the current session.
 *
 * @param limitType - The limit type to mark as dismissed
 */
export function dismissBannerForSession(limitType: LimitType): void {
  const key = `${PAYWALL_STORAGE_PREFIX}dismissed_${limitType}`;
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // sessionStorage unavailable — degrade gracefully
  }
}

// ========================= Composite Component =========================

/**
 * Props for the main PaymentWall component
 */
export interface PaymentWallProps {
  /** The trial limit event from a 402 backend response, or null to hide */
  event: TrialLimitEvent | null;
  /** Called when user clicks "Upgrade Now" with selected billing interval */
  onUpgrade: (interval: BillingInterval) => void;
  /** Called when the payment wall is fully dismissed */
  onDismiss: () => void;
}

/**
 * Composite Payment Wall component that auto-selects between banner and modal
 * based on the user's encounter history.
 *
 * This is the primary entry point — drop it into any page where a limit can
 * be exceeded. It handles escalation, dismissal, and localStorage tracking.
 *
 * @param event - The limit event (pass null to hide)
 * @param onUpgrade - Callback when user chooses to upgrade
 * @param onDismiss - Callback when user dismisses the wall
 * @returns PaymentWall component (banner, modal, or null)
 *
 * @example
 * ```tsx
 * const { activeLimitEvent, dismiss } = useTrialLimits();
 * <PaymentWall
 *   event={activeLimitEvent}
 *   onUpgrade={(interval) => api.createCheckout('pro', interval)}
 *   onDismiss={dismiss}
 * />
 * ```
 */
export const PaymentWall: React.FC<PaymentWallProps> = ({
  event,
  onUpgrade,
  onDismiss,
}) => {
  const [showModal, setShowModal] = useState(false);

  if (!event) return null;

  const escalation = getEscalationLevel(event.limitType);
  const dismissed = isBannerDismissedThisSession(event.limitType);

  // If banner was dismissed this session, don't show banner (modal still possible)
  if (escalation === 'banner' && dismissed && !showModal) return null;

  const handleBannerDismiss = () => {
    dismissBannerForSession(event.limitType);
    onDismiss();
  };

  const handleBannerUpgrade = () => {
    setShowModal(true);
  };

  const handleModalClose = () => {
    setShowModal(false);
    onDismiss();
  };

  // Show modal if escalation level is modal OR user clicked "Upgrade" on banner
  if (escalation === 'modal' || showModal) {
    return (
      <PaymentWallModal
        isOpen={true}
        event={event}
        onClose={handleModalClose}
        onUpgrade={onUpgrade}
      />
    );
  }

  // Show banner (level 1)
  return (
    <PaymentWallBanner
      event={event}
      onUpgrade={handleBannerUpgrade}
      onDismiss={handleBannerDismiss}
    />
  );
};

PaymentWall.displayName = 'PaymentWall';
