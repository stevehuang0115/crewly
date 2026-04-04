/**
 * PaymentWallModal Component
 *
 * Escalated modal with full plan comparison, shown when the user
 * has encountered the payment wall banner more than 3 times or
 * when the user clicks "Upgrade" on the banner.
 *
 * @module components/PaymentWall/PaymentWallModal
 */

import React, { useState, useCallback } from 'react';
import { Zap } from 'lucide-react';
import axios from 'axios';
import { Modal } from '../UI/Modal';
import { Button } from '../UI/Button';
import { UsageProgressBar } from './UsageProgressBar';
import { PlanComparisonCard } from './PlanComparisonCard';
import type { TrialLimitEvent, BillingInterval } from '../../types/payment-wall.types';
import { LIMIT_COPY } from '../../types/payment-wall.types';

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
}

/**
 * Response shape from the checkout API endpoint.
 */
interface CheckoutResponse {
  /** URL to redirect the user to for payment */
  checkoutUrl: string;
}

/**
 * Escalated modal with side-by-side plan comparison and checkout flow.
 *
 * Features:
 * - Header with Zap icon, title, context text, and usage bar
 * - PlanComparisonCard with billing toggle and upgrade CTA
 * - Calls POST /api/payment/checkout on upgrade
 * - Redirects to Stripe checkout URL on success
 * - "Maybe Later" dismiss button
 *
 * @param isOpen - Controls modal visibility
 * @param event - The trial limit event from the backend 402 response
 * @param onClose - Called when the modal is dismissed
 * @returns A modal dialog with plan comparison and upgrade flow
 *
 * @example
 * ```tsx
 * <PaymentWallModal
 *   isOpen={showModal}
 *   event={{ limitType: 'limit:teams', current: 2, max: 2, plan: 'free' }}
 *   onClose={() => setShowModal(false)}
 * />
 * ```
 */
export const PaymentWallModal: React.FC<PaymentWallModalProps> = ({
  isOpen,
  event,
  onClose,
}) => {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const limitCopy = LIMIT_COPY[event.limitType];

  /**
   * Handle billing interval toggle between monthly and yearly.
   *
   * @param interval - The new billing interval
   */
  const handleBillingToggle = useCallback((interval: BillingInterval) => {
    setBillingInterval(interval);
  }, []);

  /**
   * Handle the upgrade flow by calling the checkout API and
   * redirecting the user to the Stripe checkout page.
   */
  const handleUpgrade = useCallback(async (planId: string = 'pro') => {
    try {
      const response = await axios.post<CheckoutResponse>('/api/payment/checkout', {
        planId,
        interval: billingInterval === 'monthly' ? 'month' : 'year',
        successUrl: window.location.origin + '/settings?tab=cloud&upgraded=true',
        cancelUrl: window.location.href,
      });

      if (response.data.checkoutUrl) {
        window.location.href = response.data.checkoutUrl;
      }
    } catch {
      // Checkout error handled by global error handler
    }
  }, [billingInterval]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      {/* Header Section */}
      <div className="text-center mb-6" data-testid="paywall-header">
        <Zap
          className="text-primary mx-auto mb-3"
          style={{ width: 32, height: 32 }}
          data-testid="modal-zap-icon"
        />
        <h2
          id="paywall-title"
          className="text-xl font-bold text-text-primary-dark mb-2"
        >
          Unlock the Full Crewly
        </h2>
        <p className="text-sm text-text-secondary-dark" data-testid="paywall-context">
          You've hit the free plan limit for {limitCopy.label}.
        </p>

        <div className="mt-3 max-w-[200px] mx-auto">
          <UsageProgressBar current={event.current} max={event.max} />
        </div>
      </div>

      {/* Plan Comparison */}
      <div className="mb-4">
        <PlanComparisonCard
          highlightedLimitType={event.limitType}
          billingInterval={billingInterval}
          onBillingToggle={handleBillingToggle}
          onUpgrade={handleUpgrade}
        />
      </div>

      {/* Footer */}
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
