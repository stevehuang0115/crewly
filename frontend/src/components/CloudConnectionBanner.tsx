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
  pro: 'Pro',
  enterprise: 'Enterprise',
};

/** Maps tier values to badge variants */
const TIER_BADGE_VARIANTS: Record<CloudTier, 'default' | 'primary' | 'success' | 'warning' | 'info'> = {
  free: 'default',
  pro: 'primary',
  enterprise: 'success',
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

  // Connected state: show tier badge with disconnect option
  if (isConnected && tier) {
    return (
      <div className="flex items-center justify-between px-4 py-2 border-b bg-emerald-500/10 border-emerald-500/30">
        <div className="flex items-center gap-3">
          <Cloud className="shrink-0 text-emerald-400" size={18} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-emerald-300">Connected to CrewlyAI Cloud</span>
            <Badge variant={TIER_BADGE_VARIANTS[tier]} size="sm">
              {TIER_LABELS[tier]}
            </Badge>
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
