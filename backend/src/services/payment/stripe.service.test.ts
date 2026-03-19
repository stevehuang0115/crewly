/**
 * Tests for Stripe Payment Service
 *
 * Covers singleton lifecycle, unconfigured guards, and webhook handlers
 * with Supabase subscription sync.
 *
 * @module services/payment/stripe.service.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { StripeService } from './stripe.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// Mock env.config — return supabase URL
jest.mock('../core/env.config.js', () => ({
  getEnvConfig: () => ({
    supabase: {
      url: 'https://test.supabase.co',
      anonKey: 'test-anon-key',
    },
  }),
}));

// Track Supabase calls
const mockUpsert = jest.fn<() => Promise<{ error: null | { message: string } }>>();
const mockFrom = jest.fn().mockReturnValue({ upsert: mockUpsert });
const mockCreateClient = jest.fn().mockReturnValue({ from: mockFrom });

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

describe('StripeService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    StripeService.resetInstance();
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const a = StripeService.getInstance();
      const b = StripeService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a new instance after reset', () => {
      const a = StripeService.getInstance();
      StripeService.resetInstance();
      const b = StripeService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // -----------------------------------------------------------------------
  // isConfigured
  // -----------------------------------------------------------------------

  describe('isConfigured', () => {
    it('should return false when STRIPE_SECRET_KEY is not set', () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = StripeService.getInstance();
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when STRIPE_SECRET_KEY is set', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_123';
      const service = StripeService.getInstance();
      expect(service.isConfigured()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Unconfigured guards
  // -----------------------------------------------------------------------

  describe('when Stripe is not configured', () => {
    beforeEach(() => {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    it('createCheckoutSession should return not configured', async () => {
      const service = StripeService.getInstance();
      const result = await service.createCheckoutSession('u1', 'pro', 'month', 'http://ok', 'http://cancel');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });

    it('handleWebhookEvent should return not configured', async () => {
      const service = StripeService.getInstance();
      const result = await service.handleWebhookEvent(Buffer.from('{}'), 'sig');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });

    it('getSubscription should return not configured', async () => {
      const service = StripeService.getInstance();
      const result = await service.getSubscription('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });

    it('createPortalSession should return not configured', async () => {
      const service = StripeService.getInstance();
      const result = await service.createPortalSession('u1', 'http://return');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });
  });

  // -----------------------------------------------------------------------
  // When Stripe is configured
  // -----------------------------------------------------------------------

  describe('when Stripe is configured', () => {
    let service: StripeService;

    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_123';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
      service = StripeService.getInstance();
    });

    describe('Supabase client initialization', () => {
      it('should create Supabase admin client when SUPABASE_SERVICE_ROLE_KEY is set', () => {
        expect(mockCreateClient).toHaveBeenCalledWith(
          'https://test.supabase.co',
          'test-service-role-key',
          expect.objectContaining({
            auth: { autoRefreshToken: false, persistSession: false },
          }),
        );
      });

      it('should not create Supabase client when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
        StripeService.resetInstance();
        mockCreateClient.mockClear();
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        StripeService.getInstance();
        expect(mockCreateClient).not.toHaveBeenCalled();
      });
    });

    describe('createCheckoutSession', () => {
      it('should return error when no price is configured for plan/interval', async () => {
        const result = await service.createCheckoutSession('u1', 'pro', 'month', 'http://ok', 'http://cancel');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No Stripe price configured');
      });

      it('should return error for free plan', async () => {
        const result = await service.createCheckoutSession('u1', 'free', 'month', 'http://ok', 'http://cancel');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No Stripe price configured');
      });
    });

    describe('handleWebhookEvent', () => {
      it('should fail signature verification with invalid data', async () => {
        const result = await service.handleWebhookEvent(
          Buffer.from('{"type":"test"}'),
          'invalid_signature',
        );
        expect(result.success).toBe(false);
        expect(result.message).toContain('Webhook signature verification failed');
      });

      it('should require webhook secret', async () => {
        delete process.env.STRIPE_WEBHOOK_SECRET;
        StripeService.resetInstance();
        process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_123';
        const svc = StripeService.getInstance();
        const result = await svc.handleWebhookEvent(Buffer.from('{}'), 'sig');
        expect(result.success).toBe(false);
        expect(result.message).toContain('not configured');
      });
    });

    describe('getSubscription', () => {
      it('should handle Stripe API errors gracefully', async () => {
        // With a fake key, the API call will fail with auth error
        const result = await service.getSubscription('user-123');
        expect(result.success).toBe(false);
        expect(result.message).toBeDefined();
      });
    });

    describe('createPortalSession', () => {
      it('should handle Stripe API errors gracefully', async () => {
        const result = await service.createPortalSession('user-123', 'http://return');
        expect(result.success).toBe(false);
        expect(result.message).toBeDefined();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Webhook handlers — Supabase sync
  // -----------------------------------------------------------------------

  describe('webhook handler Supabase sync', () => {
    let service: StripeService;

    // Access private methods via casting for direct unit testing
    const callHandler = (service: StripeService, method: string, ...args: unknown[]) =>
      (service as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[method](...args);

    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_123';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
      mockUpsert.mockResolvedValue({ error: null });
      service = StripeService.getInstance();
    });

    describe('handleSubscriptionUpdated', () => {
      const mockSubscription = {
        id: 'sub_123',
        customer: 'cus_456',
        status: 'active',
        metadata: { planId: 'pro' },
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
        cancel_at: null,
        cancel_at_period_end: false,
      };

      it('should upsert subscription to Supabase', async () => {
        await callHandler(service, 'handleSubscriptionUpdated', mockSubscription);

        expect(mockFrom).toHaveBeenCalledWith('subscriptions');
        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            stripe_customer_id: 'cus_456',
            stripe_subscription_id: 'sub_123',
            status: 'active',
            plan_id: 'pro',
            cancel_at: null,
            cancel_at_period_end: false,
            updated_at: expect.any(String),
          }),
          { onConflict: 'stripe_subscription_id' },
        );
      });

      it('should use default plan ID when metadata is missing', async () => {
        await callHandler(service, 'handleSubscriptionUpdated', {
          ...mockSubscription,
          metadata: {},
        });

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({ plan_id: 'pro' }),
          expect.any(Object),
        );
      });

      it('should handle subscription with no items gracefully', async () => {
        await callHandler(service, 'handleSubscriptionUpdated', {
          ...mockSubscription,
          items: { data: [] },
        });

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            current_period_start: null,
            current_period_end: null,
          }),
          expect.any(Object),
        );
      });

      it('should convert cancel_at timestamp to ISO string', async () => {
        const cancelAt = 1703000000;
        await callHandler(service, 'handleSubscriptionUpdated', {
          ...mockSubscription,
          cancel_at: cancelAt,
          cancel_at_period_end: true,
        });

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            cancel_at: new Date(cancelAt * 1000).toISOString(),
            cancel_at_period_end: true,
          }),
          expect.any(Object),
        );
      });

      it('should throw when Supabase upsert fails', async () => {
        mockUpsert.mockResolvedValueOnce({ error: { message: 'DB error' } });

        await expect(
          callHandler(service, 'handleSubscriptionUpdated', mockSubscription),
        ).rejects.toThrow('Supabase sync failed: DB error');
      });

      it('should handle non-string customer gracefully', async () => {
        await callHandler(service, 'handleSubscriptionUpdated', {
          ...mockSubscription,
          customer: { id: 'cus_789' },
        });

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({ stripe_customer_id: '' }),
          expect.any(Object),
        );
      });
    });

    describe('handleSubscriptionDeleted', () => {
      const mockSubscription = {
        id: 'sub_del_123',
        customer: 'cus_456',
        status: 'canceled',
        metadata: { planId: 'enterprise' },
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
        cancel_at: null,
        cancel_at_period_end: false,
      };

      it('should upsert with canceled status', async () => {
        await callHandler(service, 'handleSubscriptionDeleted', mockSubscription);

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            stripe_subscription_id: 'sub_del_123',
            status: 'canceled',
            plan_id: 'enterprise',
            cancel_at_period_end: false,
          }),
          { onConflict: 'stripe_subscription_id' },
        );
      });
    });

    describe('handlePaymentFailed', () => {
      it('should upsert past_due status when subscription exists', async () => {
        const mockInvoice = {
          id: 'inv_123',
          customer: 'cus_456',
          parent: {
            subscription_details: { subscription: 'sub_789' },
          },
          attempt_count: 2,
        };

        await callHandler(service, 'handlePaymentFailed', mockInvoice);

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            stripe_customer_id: 'cus_456',
            stripe_subscription_id: 'sub_789',
            status: 'past_due',
          }),
          { onConflict: 'stripe_subscription_id' },
        );
      });

      it('should skip upsert when invoice has no subscription', async () => {
        const mockInvoice = {
          id: 'inv_no_sub',
          customer: 'cus_456',
          parent: null,
          attempt_count: 1,
        };

        await callHandler(service, 'handlePaymentFailed', mockInvoice);

        expect(mockUpsert).not.toHaveBeenCalled();
      });

      it('should extract subscription ID from object', async () => {
        const mockInvoice = {
          id: 'inv_obj_sub',
          customer: 'cus_456',
          parent: {
            subscription_details: { subscription: { id: 'sub_obj' } },
          },
          attempt_count: 1,
        };

        await callHandler(service, 'handlePaymentFailed', mockInvoice);

        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            stripe_subscription_id: 'sub_obj',
            status: 'past_due',
          }),
          { onConflict: 'stripe_subscription_id' },
        );
      });

      it('should skip upsert when subscription_details is null', async () => {
        const mockInvoice = {
          id: 'inv_no_details',
          customer: 'cus_456',
          parent: { subscription_details: null },
          attempt_count: 1,
        };

        await callHandler(service, 'handlePaymentFailed', mockInvoice);

        expect(mockUpsert).not.toHaveBeenCalled();
      });
    });

    describe('handleCheckoutCompleted', () => {
      const mockRetrieve = jest.fn<() => Promise<unknown>>();
      const mockCustomerUpdate = jest.fn<() => Promise<unknown>>();
      const mockClient = {
        customers: { update: mockCustomerUpdate },
        subscriptions: { retrieve: mockRetrieve },
      };

      const mockSession = {
        id: 'cs_123',
        metadata: { userId: 'user-001', planId: 'pro' },
        client_reference_id: 'user-001',
        customer: 'cus_789',
        subscription: 'sub_new_456',
      };

      beforeEach(() => {
        mockCustomerUpdate.mockResolvedValue({});
        mockRetrieve.mockResolvedValue({
          id: 'sub_new_456',
          status: 'active',
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
          cancel_at: null,
          cancel_at_period_end: false,
        });
      });

      it('should update customer metadata and upsert subscription', async () => {
        await callHandler(service, 'handleCheckoutCompleted', mockClient, mockSession);

        expect(mockCustomerUpdate).toHaveBeenCalledWith('cus_789', {
          metadata: { userId: 'user-001', planId: 'pro' },
        });
        expect(mockRetrieve).toHaveBeenCalledWith('sub_new_456');
        expect(mockUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            user_id: 'user-001',
            stripe_customer_id: 'cus_789',
            stripe_subscription_id: 'sub_new_456',
            status: 'active',
            plan_id: 'pro',
          }),
          { onConflict: 'stripe_subscription_id' },
        );
      });

      it('should skip when userId is missing', async () => {
        await callHandler(service, 'handleCheckoutCompleted', mockClient, {
          ...mockSession,
          metadata: {},
          client_reference_id: null,
        });

        expect(mockCustomerUpdate).not.toHaveBeenCalled();
        expect(mockUpsert).not.toHaveBeenCalled();
      });

      it('should fallback to client_reference_id when metadata userId is missing', async () => {
        await callHandler(service, 'handleCheckoutCompleted', mockClient, {
          ...mockSession,
          metadata: {},
          client_reference_id: 'user-fallback',
        });

        expect(mockCustomerUpdate).toHaveBeenCalledWith('cus_789', {
          metadata: { userId: 'user-fallback', planId: 'pro' },
        });
      });

      it('should skip subscription upsert when no subscription ID', async () => {
        await callHandler(service, 'handleCheckoutCompleted', mockClient, {
          ...mockSession,
          subscription: null,
        });

        expect(mockCustomerUpdate).toHaveBeenCalled();
        expect(mockRetrieve).not.toHaveBeenCalled();
        expect(mockUpsert).not.toHaveBeenCalled();
      });

      it('should handle non-string customer gracefully', async () => {
        await callHandler(service, 'handleCheckoutCompleted', mockClient, {
          ...mockSession,
          customer: { id: 'cus_obj' },
        });

        expect(mockCustomerUpdate).not.toHaveBeenCalled();
        // Should still retrieve and upsert subscription with empty customerId
        expect(mockRetrieve).toHaveBeenCalled();
      });
    });

    describe('upsertSubscription without Supabase', () => {
      it('should log warning and skip when Supabase is not configured', async () => {
        StripeService.resetInstance();
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_123';
        const svc = StripeService.getInstance();

        // Should not throw — just warn
        await callHandler(svc, 'handleSubscriptionUpdated', {
          id: 'sub_no_supa',
          customer: 'cus_456',
          status: 'active',
          metadata: {},
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
          cancel_at: null,
          cancel_at_period_end: false,
        });

        expect(mockUpsert).not.toHaveBeenCalled();
      });
    });
  });

  // -----------------------------------------------------------------------
  // resetInstance
  // -----------------------------------------------------------------------

  describe('resetInstance', () => {
    it('should allow reconfiguration', () => {
      delete process.env.STRIPE_SECRET_KEY;
      const unconfigured = StripeService.getInstance();
      expect(unconfigured.isConfigured()).toBe(false);

      StripeService.resetInstance();
      process.env.STRIPE_SECRET_KEY = 'sk_test_new_key';
      const configured = StripeService.getInstance();
      expect(configured.isConfigured()).toBe(true);
    });
  });
});
