/**
 * Payment REST Controller
 *
 * Handles Stripe payment endpoints: checkout session creation,
 * subscription queries, customer portal sessions, and webhook events.
 *
 * All endpoints except the webhook require authentication.
 * The webhook endpoint receives raw body for Stripe signature verification.
 *
 * @module controllers/payment/payment.controller
 */

import type { Request, Response } from 'express';
import { StripeService } from '../../services/payment/stripe.service.js';
import { isValidPlanId, isValidBillingInterval } from './payment.types.js';
import { asyncHandler } from '../../utils/async-handler.js';

/**
 * Shape of an authenticated request with user info attached by auth middleware.
 * Replaces the former SupabaseAuthenticatedRequest from the deleted cloud module.
 */
export interface AuthenticatedRequest extends Request {
	user: {
		userId: string;
		email: string;
		plan?: string;
	};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/payment/checkout
 *
 * Creates a Stripe Checkout Session for a subscription plan.
 * Requires auth. The authenticated user ID is attached
 * as session metadata for post-checkout correlation.
 *
 * @param req - Request with body: { planId, interval, successUrl, cancelUrl }
 * @param res - Response with { success, data: { checkoutUrl, sessionId } }
 */
export const handleCreateCheckout = asyncHandler(async (req: Request, res: Response): Promise<void> => {
	const { planId, interval, successUrl, cancelUrl } = req.body as {
		planId?: string;
		interval?: string;
		successUrl?: string;
		cancelUrl?: string;
	};

	if (!planId || !isValidPlanId(planId)) {
		res.status(400).json({ success: false, error: 'planId must be one of: starter, pro, max' });
		return;
	}

	if (!interval || !isValidBillingInterval(interval)) {
		res.status(400).json({ success: false, error: 'interval must be one of: month, year' });
		return;
	}

	if (!successUrl || !cancelUrl) {
		res.status(400).json({ success: false, error: 'successUrl and cancelUrl are required' });
		return;
	}

	// Validate URLs to prevent open redirects
	for (const url of [successUrl, cancelUrl]) {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				res.status(400).json({ success: false, error: 'URLs must use http or https protocol' });
				return;
			}
		} catch {
			res.status(400).json({ success: false, error: 'Invalid URL format' });
			return;
		}
	}

	const userId = (req as AuthenticatedRequest).user.userId;
	const stripe = StripeService.getInstance();
	const result = await stripe.createCheckoutSession(userId, planId, interval, successUrl, cancelUrl);

	if (!result.success) {
		res.status(result.message?.includes('not configured') ? 503 : 400).json(result);
		return;
	}

	res.json({ success: true, data: result.data });
});

/**
 * POST /api/payment/webhook
 *
 * Receives Stripe webhook events. Does NOT require auth —
 * authentication is done via Stripe signature verification.
 *
 * Expects raw body (application/json with raw Buffer) and the
 * Stripe-Signature header.
 *
 * @param req - Request with raw body and Stripe-Signature header
 * @param res - Response with 200 on success, 400 on failure
 */
export const handleWebhook = asyncHandler(async (req: Request, res: Response): Promise<void> => {
	const signature = req.headers['stripe-signature'] as string || '';
	const rawBody = req.body as Buffer;

	if (!Buffer.isBuffer(rawBody)) {
		res.status(400).json({ success: false, error: 'Webhook requires raw body' });
		return;
	}

	const stripe = StripeService.getInstance();
	const result = await stripe.handleWebhookEvent(rawBody, signature);

	if (!result.success) {
		res.status(400).json(result);
		return;
	}

	// Always return 200 to Stripe to acknowledge receipt
	res.json({ success: true, received: true });
});

/**
 * GET /api/payment/subscription
 *
 * Returns the current subscription status for the authenticated user.
 * Requires auth.
 *
 * @param req - Authenticated request
 * @param res - Response with { success, data: SubscriptionInfo }
 */
export const handleGetSubscription = asyncHandler(async (req: Request, res: Response): Promise<void> => {
	const userId = (req as AuthenticatedRequest).user.userId;
	const stripe = StripeService.getInstance();
	const result = await stripe.getSubscription(userId);

	if (!result.success) {
		res.status(503).json(result);
		return;
	}

	res.json({ success: true, data: result.data });
});

/**
 * POST /api/payment/portal
 *
 * Creates a Stripe Customer Portal session for subscription management.
 * Requires auth.
 *
 * @param req - Request with body: { returnUrl }
 * @param res - Response with { success, data: { portalUrl } }
 */
export const handleCreatePortal = asyncHandler(async (req: Request, res: Response): Promise<void> => {
	const { returnUrl } = req.body as { returnUrl?: string };

	if (!returnUrl) {
		res.status(400).json({ success: false, error: 'returnUrl is required' });
		return;
	}

	const userId = (req as AuthenticatedRequest).user.userId;
	const stripe = StripeService.getInstance();
	const result = await stripe.createPortalSession(userId, returnUrl);

	if (!result.success) {
		res.status(result.message?.includes('not configured') ? 503 : 400).json(result);
		return;
	}

	res.json({ success: true, data: result.data });
});
