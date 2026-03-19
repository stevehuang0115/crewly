/**
 * Stripe Payment Service
 *
 * Singleton service for Stripe API interactions. Handles checkout sessions,
 * subscriptions, customer portal sessions, and webhook event processing.
 * Syncs subscription lifecycle events to the Supabase `subscriptions` table.
 *
 * Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET environment variables.
 * Requires CREWLY_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for webhook sync.
 * Returns { success: false, message: 'Stripe is not configured' } when keys
 * are missing, allowing the app to run without Stripe in development.
 *
 * @module services/payment/stripe
 */

import Stripe from 'stripe';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from '../core/logger.service.js';
import { getEnvConfig } from '../core/env.config.js';
import { formatError } from '../../utils/format-error.js';

const logger = LoggerService.getInstance().createComponentLogger('StripeService');

/** Result type for Stripe operations */
export interface StripeResult<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Subscription info returned to clients */
export interface SubscriptionInfo {
  subscriptionId: string;
  status: Stripe.Subscription.Status;
  planId: string;
  cancelAt: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Row shape for the Supabase subscriptions table */
export interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  plan_id: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

/** Default plan ID when metadata is missing */
const DEFAULT_PLAN_ID = 'pro' as const;

/** Supabase table name for subscription records */
const SUBSCRIPTIONS_TABLE = 'subscriptions' as const;

/**
 * Extract current period dates from a subscription's first item.
 * In Stripe API v2025+, period dates live on SubscriptionItem, not Subscription.
 *
 * @param subscription - Stripe subscription (or retrieved response)
 * @returns Object with ISO period strings, or nulls if no items
 */
function extractPeriodDates(subscription: { items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> } }): {
  current_period_start: string | null;
  current_period_end: string | null;
} {
  const item = subscription.items?.data?.[0];
  return {
    current_period_start: item?.current_period_start
      ? new Date(item.current_period_start * 1000).toISOString()
      : null,
    current_period_end: item?.current_period_end
      ? new Date(item.current_period_end * 1000).toISOString()
      : null,
  };
}

/**
 * Extract the subscription ID string from a Stripe Invoice.
 * In Stripe API v2025+, subscription is at invoice.parent.subscription_details.subscription.
 *
 * @param invoice - Stripe Invoice object
 * @returns Subscription ID string or null
 */
function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  return typeof sub === 'string' ? sub : sub?.id ?? null;
}

/** Maps plan+interval keys to environment variable names for Stripe Price IDs */
const PRICE_ENV_VAR_MAP: Readonly<Record<string, string>> = {
  'pro_month': 'STRIPE_PRICE_PRO_MONTHLY',
  'pro_year': 'STRIPE_PRICE_PRO_YEARLY',
  'enterprise_month': 'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'enterprise_year': 'STRIPE_PRICE_ENTERPRISE_YEARLY',
};

/**
 * Resolve a Stripe Price ID for a plan + interval combination.
 * Reads env vars at call time to support late-loaded configuration.
 *
 * @param planId - Plan identifier (pro, enterprise)
 * @param interval - Billing interval (month, year)
 * @returns Stripe Price ID or undefined
 */
function resolvePriceId(planId: string, interval: string): string | undefined {
  const envVar = PRICE_ENV_VAR_MAP[`${planId}_${interval}`];
  return envVar ? process.env[envVar] : undefined;
}

/**
 * Stripe payment service singleton.
 *
 * Wraps all Stripe API calls with error handling and returns
 * standardized result objects.
 */
export class StripeService {
  private static instance: StripeService | null = null;
  private stripe: Stripe | null = null;
  private webhookSecret: string | undefined;
  private supabaseAdmin: SupabaseClient | null = null;

  private constructor() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (secretKey) {
      this.stripe = new Stripe(secretKey);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceRoleKey) {
      const envConfig = getEnvConfig();
      this.supabaseAdmin = createClient(envConfig.supabase.url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
  }

  /**
   * Get or create the singleton instance.
   *
   * @returns The StripeService singleton
   */
  static getInstance(): StripeService {
    if (!StripeService.instance) {
      StripeService.instance = new StripeService();
    }
    return StripeService.instance;
  }

  /**
   * Check if Stripe is configured with required environment variables.
   *
   * @returns True if STRIPE_SECRET_KEY is set and Stripe client initialized
   */
  isConfigured(): boolean {
    return this.stripe !== null;
  }

  /**
   * Find a Stripe customer by userId stored in metadata.
   *
   * @param client - Stripe client (must be non-null)
   * @param userId - Internal user ID
   * @returns The first matching customer or null
   */
  private async findCustomerByUserId(client: Stripe, userId: string): Promise<Stripe.Customer | null> {
    const customers = await client.customers.search({
      query: `metadata['userId']:'${userId}'`,
      limit: 1,
    });
    return customers.data.length > 0 ? customers.data[0] : null;
  }

  /**
   * Create a Stripe Checkout Session for a subscription plan.
   *
   * @param userId - User ID attached as metadata for post-checkout correlation
   * @param planId - Plan identifier (pro, enterprise)
   * @param interval - Billing interval (month, year)
   * @param successUrl - Redirect URL after successful checkout
   * @param cancelUrl - Redirect URL if user cancels
   * @returns Result with checkoutUrl and sessionId
   */
  async createCheckoutSession(
    userId: string,
    planId: string,
    interval: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<StripeResult<{ checkoutUrl: string; sessionId: string }>> {
    const client = this.stripe;
    if (!client) {
      return { success: false, message: 'Stripe is not configured' };
    }

    const priceId = resolvePriceId(planId, interval);
    if (!priceId) {
      return { success: false, message: `No Stripe price configured for ${planId}/${interval}` };
    }

    try {
      const session = await client.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { userId, planId, interval },
        client_reference_id: userId,
      });

      if (!session.url) {
        return { success: false, message: 'Checkout session created without redirect URL' };
      }

      logger.info('Checkout session created', { sessionId: session.id, userId, planId });

      return {
        success: true,
        data: { checkoutUrl: session.url, sessionId: session.id },
      };
    } catch (error) {
      logger.error('Failed to create checkout session', { error: formatError(error), userId, planId });
      return { success: false, message: formatError(error) };
    }
  }

  /**
   * Process a Stripe webhook event.
   *
   * Verifies the signature, then dispatches the event to the appropriate handler.
   * Currently handles: checkout.session.completed, customer.subscription.updated,
   * customer.subscription.deleted, invoice.payment_failed.
   *
   * @param rawBody - Raw request body for signature verification
   * @param signature - Stripe-Signature header value
   * @returns Result indicating success or failure
   */
  async handleWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): Promise<StripeResult<{ eventType: string }>> {
    const client = this.stripe;
    if (!client || !this.webhookSecret) {
      return { success: false, message: 'Stripe webhook is not configured' };
    }

    let event: Stripe.Event;
    try {
      event = client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (error) {
      const msg = formatError(error);
      logger.warn('Webhook signature verification failed', { error: msg });
      return { success: false, message: `Webhook signature verification failed: ${msg}` };
    }

    logger.info('Webhook event received', { type: event.type, id: event.id });

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(client, event.data.object as Stripe.Checkout.Session);
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        default:
          logger.info('Unhandled webhook event type', { type: event.type });
      }

      return { success: true, data: { eventType: event.type } };
    } catch (error) {
      logger.error('Webhook handler failed', { type: event.type, error: formatError(error) });
      return { success: false, message: formatError(error) };
    }
  }

  /**
   * Get the current subscription for a user by their Stripe customer ID.
   *
   * @param userId - The user to look up (used as client_reference_id or metadata)
   * @returns Result with subscription data or null if no active subscription
   */
  async getSubscription(userId: string): Promise<StripeResult<SubscriptionInfo | null>> {
    const client = this.stripe;
    if (!client) {
      return { success: false, message: 'Stripe is not configured' };
    }

    try {
      const customer = await this.findCustomerByUserId(client, userId);
      if (!customer) {
        return { success: true, data: null };
      }

      // Only returns 'active' subscriptions — past_due and trialing
      // are handled separately by webhook events.
      const subscriptions = await client.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1,
      });

      if (subscriptions.data.length === 0) {
        return { success: true, data: null };
      }

      const sub = subscriptions.data[0];
      return {
        success: true,
        data: {
          subscriptionId: sub.id,
          status: sub.status,
          planId: sub.metadata?.planId ?? DEFAULT_PLAN_ID,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
      };
    } catch (error) {
      logger.error('Failed to get subscription', { error: formatError(error), userId });
      return { success: false, message: formatError(error) };
    }
  }

  /**
   * Create a Stripe Customer Portal session for subscription management.
   *
   * @param userId - The user requesting access
   * @param returnUrl - URL to redirect after portal session
   * @returns Result with portalUrl
   */
  async createPortalSession(
    userId: string,
    returnUrl: string,
  ): Promise<StripeResult<{ portalUrl: string }>> {
    const client = this.stripe;
    if (!client) {
      return { success: false, message: 'Stripe is not configured' };
    }

    try {
      const customer = await this.findCustomerByUserId(client, userId);
      if (!customer) {
        return { success: false, message: 'No Stripe customer found for this user' };
      }

      const session = await client.billingPortal.sessions.create({
        customer: customer.id,
        return_url: returnUrl,
      });

      return { success: true, data: { portalUrl: session.url } };
    } catch (error) {
      logger.error('Failed to create portal session', { error: formatError(error), userId });
      return { success: false, message: formatError(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // Supabase Sync
  // ---------------------------------------------------------------------------

  /**
   * Upsert a subscription row in the Supabase subscriptions table.
   * Uses stripe_subscription_id as the conflict key.
   * Logs a warning and continues if Supabase is not configured.
   *
   * @param row - Partial subscription row (stripe_subscription_id required)
   */
  private async upsertSubscription(row: Partial<SubscriptionRow> & Pick<SubscriptionRow, 'stripe_subscription_id'>): Promise<void> {
    if (!this.supabaseAdmin) {
      logger.warn('Supabase not configured — skipping subscription sync', {
        subscriptionId: row.stripe_subscription_id,
      });
      return;
    }

    const { error } = await this.supabaseAdmin
      .from(SUBSCRIPTIONS_TABLE)
      .upsert(
        { ...row, updated_at: new Date().toISOString() },
        { onConflict: 'stripe_subscription_id' },
      );

    if (error) {
      logger.error('Failed to sync subscription to Supabase', {
        subscriptionId: row.stripe_subscription_id,
        error: error.message,
      });
      throw new Error(`Supabase sync failed: ${error.message}`);
    }

    logger.info('Subscription synced to Supabase', {
      subscriptionId: row.stripe_subscription_id,
      status: row.status,
    });
  }

  // ---------------------------------------------------------------------------
  // Webhook Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle checkout.session.completed — new subscription created.
   * Links the Stripe customer to the internal userId via metadata,
   * then upserts the subscription into Supabase.
   *
   * @param client - Stripe client instance
   * @param session - The completed checkout session
   */
  private async handleCheckoutCompleted(client: Stripe, session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.metadata?.userId ?? session.client_reference_id;
    const planId = session.metadata?.planId ?? DEFAULT_PLAN_ID;
    const customerId = typeof session.customer === 'string' ? session.customer : null;

    if (!userId) {
      logger.warn('Checkout completed without userId', { sessionId: session.id });
      return;
    }

    // Tag the Stripe customer with userId for future lookups
    if (customerId) {
      await client.customers.update(customerId, {
        metadata: { userId, planId },
      });
    }

    // Retrieve the subscription created by the checkout to get period dates
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
    if (subscriptionId) {
      const sub = await client.subscriptions.retrieve(subscriptionId);
      const periods = extractPeriodDates(sub);
      await this.upsertSubscription({
        user_id: userId,
        stripe_customer_id: customerId ?? '',
        stripe_subscription_id: subscriptionId,
        status: sub.status,
        plan_id: planId,
        current_period_start: periods.current_period_start,
        current_period_end: periods.current_period_end,
        cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
        cancel_at_period_end: sub.cancel_at_period_end,
      });
    }

    logger.info('Checkout completed', { userId, planId, customerId, subscriptionId });
  }

  /**
   * Handle customer.subscription.updated — plan changes, renewals, cancellations.
   * Syncs the current subscription state to Supabase.
   *
   * @param subscription - The updated subscription
   */
  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : '';
    const planId = subscription.metadata?.planId ?? DEFAULT_PLAN_ID;
    const periods = extractPeriodDates(subscription);

    await this.upsertSubscription({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      plan_id: planId,
      current_period_start: periods.current_period_start,
      current_period_end: periods.current_period_end,
      cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    });

    logger.info('Subscription updated', {
      subscriptionId: subscription.id,
      status: subscription.status,
      customerId,
    });
  }

  /**
   * Handle customer.subscription.deleted — subscription cancelled/expired.
   * Updates the Supabase record with canceled status.
   *
   * @param subscription - The deleted subscription
   */
  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : '';
    const periods = extractPeriodDates(subscription);

    await this.upsertSubscription({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      status: 'canceled',
      plan_id: subscription.metadata?.planId ?? DEFAULT_PLAN_ID,
      current_period_start: periods.current_period_start,
      current_period_end: periods.current_period_end,
      cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      cancel_at_period_end: false,
    });

    logger.info('Subscription deleted', {
      subscriptionId: subscription.id,
      customerId,
    });
  }

  /**
   * Handle invoice.payment_failed — payment attempt failed.
   * Updates the subscription status to past_due in Supabase when possible.
   *
   * @param invoice - The failed invoice
   */
  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = extractInvoiceSubscriptionId(invoice);
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : '';

    if (subscriptionId) {
      await this.upsertSubscription({
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: 'past_due',
      });
    }

    logger.warn('Payment failed', {
      invoiceId: invoice.id,
      customerId,
      subscriptionId,
      attemptCount: invoice.attempt_count,
    });
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static resetInstance(): void {
    StripeService.instance = null;
  }
}
