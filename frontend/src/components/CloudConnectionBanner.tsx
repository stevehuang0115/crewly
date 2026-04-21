/**
 * Cloud Connection Banner
 *
 * Displays a banner for CrewlyAI Cloud connection status.
 * When disconnected, shows a single "Connect to Cloud" button that
 * redirects to crewlyai.com for OAuth authentication.
 * When connected, shows the subscription tier badge with disconnect option.
 *
 * @module components/CloudConnectionBanner
 */

import React, { useState } from 'react';
import { Cloud, X, Loader2, LogOut } from 'lucide-react';
import { IconButton, Badge, Button } from './UI';
import { useCloudConnection } from '../hooks/useCloudConnection';
import { buildCloudAuthRedirectUrl } from '../constants/cloud.constants';
import type { CloudTier } from '../types';

// ========================= Constants =========================

/** Maps tier values to display labels */
const TIER_LABELS: Record<CloudTier, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  max: 'Max',
};

/** Maps tier values to badge variants */
const TIER_BADGE_VARIANTS: Record<CloudTier, 'default' | 'primary' | 'success' | 'warning' | 'info'> = {
  free: 'default',
  starter: 'primary',
  pro: 'primary',
  max: 'success',
};

// ========================= Component =========================

/**
 * Banner for managing CrewlyAI Cloud connection.
 *
 * Shows different states:
 * - Loading: nothing rendered
 * - Disconnected: "Connect to CrewlyAI Cloud" banner with redirect button
 * - Connected: tier badge with disconnect option
 * - Dismissed: nothing rendered (until page refresh)
 *
 * @returns CloudConnectionBanner component or null
 */
export const CloudConnectionBanner: React.FC = () => {
  const { isConnected, tier, isLoading, isActioning, disconnect } = useCloudConnection();
  const [dismissed, setDismissed] = useState(false);

  if (isLoading || dismissed) {
    return null;
  }

  const handleConnect = () => {
    window.location.href = buildCloudAuthRedirectUrl();
  };

  const handleDisconnect = async () => {
    await disconnect();
  };

  // Connected state: show tier badge with disconnect option.
  //
  // Free tier callout: Cloud Relay / device-sync is gated server-side on Pro,
  // so free users need to know why their node never shows up on the Cloud
  // Console and what to do about it. Surface an inline Upgrade → link.
  if (isConnected && tier) {
    const isFree = tier === 'free';
    const bannerClass = isFree
      ? 'bg-amber-500/10 border-amber-500/30'
      : 'bg-emerald-500/10 border-emerald-500/30';
    const iconClass = isFree ? 'text-amber-400' : 'text-emerald-400';
    const labelClass = isFree ? 'text-amber-200' : 'text-emerald-300';

    return (
      <div className={`flex items-center justify-between px-4 py-2 border-b ${bannerClass}`}>
        <div className="flex items-center gap-3">
          <Cloud className={`shrink-0 ${iconClass}`} size={18} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={labelClass}>Connected to CrewlyAI Cloud</span>
            <Badge variant={TIER_BADGE_VARIANTS[tier]} size="sm">
              {TIER_LABELS[tier]}
            </Badge>
            {isFree && (
              <>
                <span className="text-amber-200/70">·</span>
                <span className="text-amber-200/80">
                  Device sync & Relay require Pro.
                </span>
                <a
                  href="https://crewlyai.com/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-amber-100 hover:text-white font-medium"
                >
                  Upgrade →
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            disabled={isActioning}
          >
            {isActioning ? (
              <Loader2 className="animate-spin mr-1" size={14} />
            ) : (
              <LogOut className="mr-1" size={14} />
            )}
            Disconnect
          </Button>
          <IconButton
            icon={X}
            onClick={() => setDismissed(true)}
            variant="ghost"
            size="sm"
            aria-label="Dismiss cloud banner"
          />
        </div>
      </div>
    );
  }

  // Disconnected state: show connect prompt with redirect button
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b bg-primary/10 border-primary/30">
      <div className="flex items-center gap-3">
        <Cloud className="shrink-0 text-primary" size={18} />
        <span className="text-sm text-gray-200/80">
          Connect to <span className="font-semibold text-primary">CrewlyAI Cloud</span> for premium templates and features.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleConnect}
        >
          Connect
        </Button>
        <IconButton
          icon={X}
          onClick={() => setDismissed(true)}
          variant="ghost"
          size="sm"
          aria-label="Dismiss cloud banner"
        />
      </div>
    </div>
  );
};

CloudConnectionBanner.displayName = 'CloudConnectionBanner';
