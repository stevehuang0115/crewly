/**
 * Payment Wall Types
 *
 * Type definitions for the trial-limit payment wall system.
 * Covers limit events, plan features, and escalation state.
 *
 * @module types/payment-wall
 */

/** Identifiers for each free-tier limit that can be exceeded */
export type LimitType =
  | 'limit:teams'
  | 'limit:agents_per_team'
  | 'limit:projects'
  | 'limit:relay_sessions'
  | 'limit:marketplace'
  | 'limit:schedules';

/** Subscription plan tiers */
export type PlanTier = 'free' | 'pro' | 'enterprise';

/** Billing interval for paid plans */
export type BillingInterval = 'monthly' | 'yearly';

/** Escalation level determining which UI to show */
export type EscalationLevel = 'banner' | 'modal';

/**
 * Event payload returned by the backend when a trial limit is exceeded.
 * Matches the 402 LIMIT_EXCEEDED response shape.
 */
export interface TrialLimitEvent {
  /** Which limit was exceeded */
  limitType: LimitType;
  /** Current usage count */
  current: number;
  /** Plan maximum for this resource */
  max: number;
  /** User's current plan */
  plan: PlanTier;
}

/** Human-readable label and copy for each limit type */
export interface LimitCopy {
  /** Short resource label, e.g. "teams" */
  label: string;
  /** Banner copy template (use {max} placeholder) */
  bannerCopy: string;
}

/** Feature row in plan comparison card */
export interface PlanFeature {
  /** Feature label */
  label: string;
  /** Value shown on Free plan */
  freeValue: string;
  /** Value shown on Pro plan */
  proValue: string;
  /** Corresponding limit type, if any (for row highlighting) */
  limitType?: LimitType;
}

/** Pricing info for a plan */
export interface PlanPricing {
  /** Monthly price in dollars */
  monthly: number;
  /** Yearly price per month in dollars */
  yearly: number;
}

// ========================= Constants =========================

/** Copy templates for each limit type */
export const LIMIT_COPY: Record<LimitType, LimitCopy> = {
  'limit:teams': {
    label: 'teams',
    bannerCopy: "You've reached the free plan limit of {max} teams. Upgrade to Pro for unlimited teams.",
  },
  'limit:agents_per_team': {
    label: 'agents per team',
    bannerCopy: 'Free plan supports up to {max} agents per team. Upgrade for unlimited agents.',
  },
  'limit:projects': {
    label: 'projects',
    bannerCopy: "You've reached {max} projects on the free plan. Upgrade for unlimited projects.",
  },
  'limit:relay_sessions': {
    label: 'Cloud Relay sessions',
    bannerCopy: 'Free plan includes {max} Cloud Relay session. Upgrade for unlimited connections.',
  },
  'limit:marketplace': {
    label: 'marketplace templates',
    bannerCopy: "You've installed {max} templates on the free plan. Upgrade for unlimited access.",
  },
  'limit:schedules': {
    label: 'scheduled check-ins',
    bannerCopy: 'Free plan allows {max} scheduled check-ins. Upgrade for unlimited schedules.',
  },
};

/** Feature comparison list for Free vs Pro plans */
export const PLAN_FEATURES: PlanFeature[] = [
  { label: 'Teams', freeValue: '2 teams', proValue: 'Unlimited', limitType: 'limit:teams' },
  { label: 'Agents per team', freeValue: '3 agents', proValue: 'Unlimited', limitType: 'limit:agents_per_team' },
  { label: 'Projects', freeValue: '3 projects', proValue: 'Unlimited', limitType: 'limit:projects' },
  { label: 'Cloud Relay', freeValue: '1 session', proValue: 'Unlimited', limitType: 'limit:relay_sessions' },
  { label: 'Marketplace', freeValue: '5 templates', proValue: 'Full access', limitType: 'limit:marketplace' },
  { label: 'Schedules', freeValue: '10 check-ins', proValue: 'Unlimited', limitType: 'limit:schedules' },
];

/** Pro plan pricing */
export const PRO_PRICING: PlanPricing = {
  monthly: 29,
  yearly: 24,
};

/**
 * Calculate yearly savings percentage
 *
 * @returns Savings percentage as a whole number
 */
export function getYearlySavingsPercent(): number {
  return Math.round((1 - PRO_PRICING.yearly / PRO_PRICING.monthly) * 100);
}

/** localStorage key prefix for payment wall counters */
export const PAYWALL_STORAGE_PREFIX = 'crewly_paywall_';

/** Number of banner encounters before escalating to modal */
export const ESCALATION_THRESHOLD = 3;
