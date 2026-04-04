/**
 * Payment Type Definitions
 *
 * Type definitions and validators for Stripe payment endpoints.
 *
 * @module controllers/payment/payment.types
 */

/** Valid subscription plan identifiers */
export const PLAN_IDS = ['starter', 'pro', 'max'] as const;

/** Plan ID type */
export type PlanId = (typeof PLAN_IDS)[number];

/** Valid billing intervals */
export const BILLING_INTERVALS = ['month', 'year'] as const;

/** Billing interval type */
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/**
 * Check if a string is a valid plan ID.
 *
 * @param value - Value to check
 * @returns True if value is a valid PlanId
 */
export function isValidPlanId(value: string): value is PlanId {
  return PLAN_IDS.includes(value as PlanId);
}

/**
 * Check if a string is a valid billing interval.
 *
 * @param value - Value to check
 * @returns True if value is a valid BillingInterval
 */
export function isValidBillingInterval(value: string): value is BillingInterval {
  return BILLING_INTERVALS.includes(value as BillingInterval);
}
