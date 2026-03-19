/**
 * Auth Status Indicator
 *
 * Compact indicator for the sidebar showing cloud auth status.
 * When authenticated, shows user email and plan badge.
 * When not authenticated, shows "Connect to Cloud" button.
 *
 * @module components/Auth/AuthStatusIndicator
 */

import React from 'react';
import { Cloud, LogOut, Loader2, ExternalLink } from 'lucide-react';
import { Badge } from '../UI';
import { useAuth } from '../../contexts/AuthContext';
import { buildCloudAuthRedirectUrl } from '../../constants/cloud.constants';
import type { UserPlan } from '../../types/auth.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps plan to badge variant. */
const PLAN_BADGE_VARIANTS: Record<UserPlan, 'default' | 'primary'> = {
  free: 'default',
  pro: 'primary',
  enterprise: 'primary',
};

/** Maps plan to display label. */
const PLAN_LABELS: Record<UserPlan, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for AuthStatusIndicator. */
export interface AuthStatusIndicatorProps {
  /** Whether the sidebar is collapsed (hides labels) */
  isCollapsed?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Sidebar indicator for cloud auth status.
 *
 * @param props - AuthStatusIndicator props
 * @returns AuthStatusIndicator component
 */
export const AuthStatusIndicator: React.FC<AuthStatusIndicatorProps> = ({
  isCollapsed = false,
}) => {
  const { isAuthenticated, user, isLoading, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center px-4 py-2 text-text-secondary-dark">
        <Loader2 className="h-5 w-5 animate-spin flex-shrink-0" />
        {!isCollapsed && <span className="ml-3 text-sm">Loading...</span>}
      </div>
    );
  }

  if (isAuthenticated && user) {
    return (
      <div className="px-2 py-1">
        <div className="flex items-center justify-between px-2 py-2 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2 min-w-0">
            <Cloud className="h-4 w-4 text-primary flex-shrink-0" />
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-primary-dark truncate">
                  {user.displayName}
                </p>
                <div className="flex items-center gap-1">
                  <Badge variant={PLAN_BADGE_VARIANTS[user.plan]} size="sm">
                    {PLAN_LABELS[user.plan]}
                  </Badge>
                </div>
              </div>
            )}
          </div>
          {!isCollapsed && (
            <button
              onClick={logout}
              className="text-text-secondary-dark hover:text-red-400 transition-colors p-1"
              title="Sign out"
              aria-label="Sign out of CrewlyAI Cloud"
            >
              <LogOut size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  const handleConnect = () => {
    window.location.href = buildCloudAuthRedirectUrl();
  };

  return (
    <div className="px-2 py-1">
      <button
        onClick={handleConnect}
        className="flex items-center gap-2 w-full px-2 py-2 rounded-lg text-sm text-text-secondary-dark hover:bg-primary/5 hover:text-primary transition-colors"
        title="Connect to CrewlyAI Cloud"
      >
        <Cloud className="h-4 w-4 flex-shrink-0" />
        {!isCollapsed && (
          <>
            <span className="flex-1 text-left">Connect to Cloud</span>
            <ExternalLink size={12} className="opacity-60 flex-shrink-0" />
          </>
        )}
      </button>
    </div>
  );
};

AuthStatusIndicator.displayName = 'AuthStatusIndicator';
