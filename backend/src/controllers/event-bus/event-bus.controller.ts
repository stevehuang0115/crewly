/**
 * Event Bus Controller
 *
 * HTTP request handlers for event subscription management.
 * Provides endpoints for creating, listing, and deleting event subscriptions.
 *
 * @module controllers/event-bus/event-bus.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { EventBusService } from '../../services/event-bus/event-bus.service.js';

/** Module-level reference to the event bus service */
let eventBusService: EventBusService | null = null;

/**
 * Set the EventBusService instance.
 * Called during server initialization.
 *
 * @param service - The EventBusService instance
 */
export function setEventBusService(service: EventBusService): void {
  eventBusService = service;
}

/**
 * Get the module-level EventBusService instance, or null when boot hasn't
 * wired it yet. Used by services that initialise lazily (e.g. the
 * autonomy_v1.f1 cross-machine event bridges started after Cloud
 * connects). Mirrors `getEventBusServiceForTaskCleanup` in
 * task-management.controller.
 *
 * @returns The configured EventBusService or null when not yet set.
 */
export function getEventBusService(): EventBusService | null {
  return eventBusService;
}

/**
 * POST /api/events/subscribe
 *
 * Create a new event subscription.
 *
 * @param req - Request with CreateSubscriptionInput body
 * @param res - Response with the created subscription
 */
export async function createSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!eventBusService) {
      res.status(503).json({ success: false, error: 'Event bus not initialized' });
      return;
    }

    const subscription = eventBusService.subscribe(req.body);
    res.status(201).json({ success: true, data: subscription });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid subscription input')) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('limit reached')) {
      res.status(429).json({ success: false, error: error.message });
      return;
    }
    next(error);
  }
}

/**
 * DELETE /api/events/subscribe/:subscriptionId
 *
 * Delete an existing subscription.
 *
 * @param req - Request with subscriptionId param
 * @param res - Response indicating success or not found
 */
export async function deleteSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!eventBusService) {
      res.status(503).json({ success: false, error: 'Event bus not initialized' });
      return;
    }

    const { subscriptionId } = req.params;
    const removed = eventBusService.unsubscribe(subscriptionId);

    if (!removed) {
      res.status(404).json({ success: false, error: 'Subscription not found' });
      return;
    }

    res.json({ success: true, data: { subscriptionId } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/events/subscriptions
 *
 * List all subscriptions, optionally filtered by subscriberSession query param.
 *
 * @param req - Request with optional ?subscriberSession= query
 * @param res - Response with array of subscriptions
 */
export async function listSubscriptions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!eventBusService) {
      res.status(503).json({ success: false, error: 'Event bus not initialized' });
      return;
    }

    const subscriberSession = req.query.subscriberSession as string | undefined;
    const subscriptions = eventBusService.listSubscriptions(subscriberSession);
    res.json({ success: true, data: subscriptions });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/events/subscriptions/:subscriptionId
 *
 * Get a single subscription by ID.
 *
 * @param req - Request with subscriptionId param
 * @param res - Response with the subscription or 404
 */
export async function getSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!eventBusService) {
      res.status(503).json({ success: false, error: 'Event bus not initialized' });
      return;
    }

    const { subscriptionId } = req.params;
    const subscription = eventBusService.getSubscription(subscriptionId);

    if (!subscription) {
      res.status(404).json({ success: false, error: 'Subscription not found' });
      return;
    }

    res.json({ success: true, data: subscription });
  } catch (error) {
    next(error);
  }
}
