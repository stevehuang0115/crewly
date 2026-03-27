/**
 * Pricing Page
 *
 * Displays subscription plans (Free, Solo, Team, Enterprise) with a
 * monthly/yearly billing toggle. The currently active plan is indicated
 * and upgrade buttons redirect to the payment checkout flow.
 *
 * @module pages/Pricing
 */

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import type { BillingInterval } from '../types/payment-wall.types';
import { getYearlySavingsPercent } from '../types/payment-wall.types';

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

/** Shape of a single pricing plan card */
interface PricingPlan {
  /** Unique plan identifier */
  id: string;
  /** Display name */
  name: string;
  /** Monthly price in USD */
  monthly: number;
  /** Yearly price per month in USD */
  yearly: number;
  /** Feature bullet points */
  features: string[];
  /** Call-to-action button label */
  cta: string;
  /** Whether this card gets the highlighted border */
  highlighted: boolean;
  /** Optional badge text (e.g. "Popular") */
  badge?: string;
}

/** Static plan data shown in the pricing grid */
const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    monthly: 0,
    yearly: 0,
    features: [
      '2 teams',
      '3 agents per team',
      '3 projects',
      '1 Cloud Relay session',
      '5 marketplace templates',
      '10 scheduled check-ins',
    ],
    cta: 'Current Plan',
    highlighted: false,
  },
  {
    id: 'solo',
    name: 'Solo',
    monthly: 29,
    yearly: 24,
    features: [
      'Unlimited teams',
      'Unlimited agents',
      'Unlimited projects',
      'Unlimited Cloud Relay',
      'Full marketplace access',
      'Unlimited schedules',
      'Priority support',
    ],
    cta: 'Upgrade to Solo',
    highlighted: true,
    badge: 'Popular',
  },
  {
    id: 'team',
    name: 'Team',
    monthly: 99,
    yearly: 82,
    features: [
      'Everything in Solo',
      '5 team seats',
      'Shared team memory',
      'Slack deep integration',
      'Priority queue',
      'Team analytics',
    ],
    cta: 'Upgrade to Team',
    highlighted: false,
  },
];

/** Map from license plan value to pricing plan id */
const LICENSE_TO_PLAN_ID: Record<string, string> = {
  free: 'free',
  pro: 'solo',
  enterprise: 'team',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Pricing page component.
 *
 * Renders the three main plan cards plus an Enterprise CTA section.
 * Reads the current user plan from AuthContext to mark the active plan.
 *
 * @returns The pricing page element
 */
export const Pricing: React.FC = () => {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const { license } = useAuth();

  const currentPlanId = license ? LICENSE_TO_PLAN_ID[license.plan] ?? 'free' : 'free';
  const savingsPercent = getYearlySavingsPercent();

  const [upgrading, setUpgrading] = useState<string | null>(null);

  /**
   * Handle upgrade button click for a given plan.
   * Creates a Stripe Checkout session and redirects to it.
   *
   * @param planId - The plan to upgrade to
   */
  const handleUpgrade = async (planId: string) => {
    try {
      setUpgrading(planId);
      const interval = billingInterval === 'monthly' ? 'month' : 'year';
      const result = await apiService.createCheckoutSession(
        planId,
        interval as 'month' | 'year',
        `${window.location.origin}/settings?tab=cloud&upgraded=true`,
        window.location.href
      );
      window.location.href = result.checkoutUrl;
    } catch {
      setUpgrading(null);
    }
  };

  /**
   * Return the displayed price for a plan based on the current billing interval.
   *
   * @param plan - The pricing plan
   * @returns Formatted price string
   */
  const getPrice = (plan: PricingPlan): string => {
    const amount = billingInterval === 'monthly' ? plan.monthly : plan.yearly;
    return amount === 0 ? '$0' : `$${amount}`;
  };

  /**
   * Determine if a plan is the user's current plan.
   *
   * @param planId - Plan identifier to check
   * @returns True when planId matches the user's active plan
   */
  const isCurrentPlan = (planId: string): boolean => planId === currentPlanId;

  return (
    <div className="min-h-screen bg-background-dark px-4 py-12 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mx-auto max-w-4xl text-center">
        <h1 className="text-3xl font-bold text-text-primary-dark sm:text-4xl">
          Choose Your Plan
        </h1>
        <p className="mt-3 text-lg text-text-secondary-dark">
          Start free, upgrade when you're ready.
        </p>
      </div>

      {/* Billing toggle */}
      <div className="mt-8 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setBillingInterval('monthly')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            billingInterval === 'monthly'
              ? 'bg-primary text-white'
              : 'bg-surface-dark text-text-secondary-dark hover:text-text-primary-dark'
          }`}
          aria-pressed={billingInterval === 'monthly'}
          data-testid="billing-monthly"
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setBillingInterval('yearly')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            billingInterval === 'yearly'
              ? 'bg-primary text-white'
              : 'bg-surface-dark text-text-secondary-dark hover:text-text-primary-dark'
          }`}
          aria-pressed={billingInterval === 'yearly'}
          data-testid="billing-yearly"
        >
          Yearly — Save {savingsPercent}%
        </button>
      </div>

      {/* Plan cards */}
      <div className="mx-auto mt-10 grid max-w-6xl grid-cols-1 gap-6 md:grid-cols-3">
        {PRICING_PLANS.map((plan) => {
          const isCurrent = isCurrentPlan(plan.id);
          return (
            <div
              key={plan.id}
              data-testid={`plan-card-${plan.id}`}
              className={`relative flex flex-col rounded-xl border bg-surface-dark p-6 ${
                plan.highlighted
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'border-border-dark'
              }`}
            >
              {/* Badge */}
              {plan.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-white">
                  {plan.badge}
                </span>
              )}

              {/* Plan name */}
              <h2 className="text-xl font-semibold text-text-primary-dark">{plan.name}</h2>

              {/* Price */}
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-bold text-text-primary-dark" data-testid={`price-${plan.id}`}>
                  {getPrice(plan)}
                </span>
                {plan.monthly > 0 && (
                  <span className="text-text-secondary-dark">/mo</span>
                )}
              </div>

              {billingInterval === 'yearly' && plan.yearly > 0 && (
                <p className="mt-1 text-xs text-text-secondary-dark">
                  Billed annually at ${plan.yearly * 12}/yr
                </p>
              )}

              {/* Features */}
              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary-dark">
                    <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <div className="mt-8">
                {isCurrent ? (
                  <Button variant="secondary" className="w-full" disabled data-testid={`cta-${plan.id}`}>
                    Current Plan
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => handleUpgrade(plan.id)}
                    loading={upgrading === plan.id}
                    data-testid={`cta-${plan.id}`}
                  >
                    {plan.cta}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Enterprise section */}
      <div
        className="mx-auto mt-10 max-w-6xl rounded-xl border border-border-dark bg-surface-dark p-8"
        data-testid="enterprise-section"
      >
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div>
            <h2 className="text-xl font-semibold text-text-primary-dark">Enterprise</h2>
            <p className="mt-1 text-text-secondary-dark">
              Custom pricing &middot; Unlimited seats &middot; VPC deploy &middot; SSO &middot; 24/7 support
            </p>
          </div>
          <a href="mailto:sales@crewlyai.com">
            <Button variant="ghost" data-testid="contact-sales-btn">
              Contact Sales
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
};

export default Pricing;
