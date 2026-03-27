/**
 * PaymentWallBanner Component
 *
 * Inline soft banner shown when a free-tier limit is exceeded.
 * This is the first level of the payment wall escalation system
 * (shown on encounters 1-3 before escalating to the modal).
 *
 * @module components/PaymentWall/PaymentWallBanner
 */

import React from 'react';
import { Zap, X } from 'lucide-react';
import { Button, IconButton } from '../UI/Button';
import type { TrialLimitEvent } from '../../types/payment-wall.types';
import { LIMIT_COPY } from '../../types/payment-wall.types';

/**
 * Props for the PaymentWallBanner component
 */
export interface PaymentWallBannerProps {
  /** The limit event that triggered the banner */
  event: TrialLimitEvent;
  /** Called when user clicks the Upgrade button */
  onUpgrade: () => void;
  /** Called when user dismisses the banner */
  onDismiss: () => void;
}

/**
 * Inline soft banner displayed above the blocked action area.
 *
 * Uses the project dark surface palette with a primary-blue left
 * border accent. The banner copy is contextual, showing the specific
 * limit that was exceeded with the max number bolded.
 *
 * @param event - The trial limit event from the backend 402 response
 * @param onUpgrade - Callback fired when the Upgrade button is clicked
 * @param onDismiss - Callback fired when the dismiss (X) button is clicked
 * @returns An alert banner with contextual upgrade prompt
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
  const maxStr = String(event.max);

  /**
   * Split the banner copy around the {max} placeholder and render
   * the max number as a bold span for emphasis.
   */
  const parts = copy.bannerCopy.split('{max}');

  return (
    <div
      className="bg-surface-dark border-l-4 border-primary rounded-lg px-4 py-3 flex items-start gap-3"
      role="alert"
      aria-live="polite"
      data-testid="payment-wall-banner"
      style={{
        animation: 'slideDown 0.3s ease-out',
      }}
    >
      <Zap
        className="text-primary shrink-0 mt-0.5"
        style={{ width: 18, height: 18 }}
        data-testid="banner-zap-icon"
      />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary-dark" data-testid="banner-copy">
          {parts[0]}
          <strong>{maxStr}</strong>
          {parts[1] ?? ''}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="primary"
          size="sm"
          onClick={onUpgrade}
          data-testid="banner-upgrade-btn"
        >
          Upgrade
        </Button>
        <IconButton
          icon={X}
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="banner-dismiss-btn"
        />
      </div>
    </div>
  );
};

PaymentWallBanner.displayName = 'PaymentWallBanner';
