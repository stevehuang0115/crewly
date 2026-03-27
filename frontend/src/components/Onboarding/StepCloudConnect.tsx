/**
 * Step 1: Cloud Connect
 *
 * Prompts the user to connect to Crewly Cloud via OAuth.
 * This step is optional — users can skip it.
 *
 * @module components/Onboarding/StepCloudConnect
 */

import React from 'react';
import { Cloud, CheckCircle, ArrowRight, SkipForward } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StepCloudConnectProps {
  /** Whether cloud is already connected */
  connected: boolean;
  /** Callback when connection succeeds */
  onConnected: () => void;
  /** Skip this step */
  onSkip: () => void;
  /** Proceed to next step */
  onNext: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Cloud connection step with OAuth redirect or skip option.
 *
 * If the user is already authenticated (via AuthContext), the step
 * auto-advances and shows a success state.
 *
 * @param props - {@link StepCloudConnectProps}
 * @returns Cloud connect step
 */
export const StepCloudConnect: React.FC<StepCloudConnectProps> = ({
  connected,
  onConnected,
  onSkip,
  onNext,
}) => {
  const { isAuthenticated, user } = useAuth();

  /** If already authenticated, sync the connected state */
  React.useEffect(() => {
    if (isAuthenticated && !connected) {
      onConnected();
    }
  }, [isAuthenticated, connected, onConnected]);

  const isReady = connected || isAuthenticated;

  /**
   * Initiate OAuth flow to connect cloud account.
   */
  /**
   * Navigate to Cloud OAuth login page.
   * After successful auth, the callback page applies tokens via AuthContext.
   */
  const handleConnect = () => {
    window.location.href = '/auth/login?redirect=/';
  };

  return (
    <div className="flex flex-col items-center text-center" data-testid="step-cloud-connect">
      {/* Icon */}
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
        {isReady ? (
          <CheckCircle className="w-8 h-8 text-emerald-400" />
        ) : (
          <Cloud className="w-8 h-8 text-primary" />
        )}
      </div>

      {/* Heading */}
      <h3 className="text-xl font-bold mb-2">
        {isReady ? 'Cloud Connected!' : 'Connect to Crewly Cloud'}
      </h3>

      {/* Description */}
      <p className="text-sm text-text-secondary-dark max-w-md mb-6">
        {isReady ? (
          <>
            Signed in as <span className="font-medium text-text-primary-dark">{user?.email ?? 'connected'}</span>.
            Your teams can sync across devices.
          </>
        ) : (
          'Connect to Crewly Cloud for cross-device sync, marketplace access, and team templates. This step is optional — you can always connect later in Settings.'
        )}
      </p>

      {/* Benefits list */}
      {!isReady && (
        <ul className="text-sm text-text-secondary-dark text-left mb-8 space-y-2 max-w-sm">
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">+</span>
            Cross-machine team sync via Cloud Relay
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">+</span>
            Access to Marketplace skills and templates
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">+</span>
            Automatic backups and team recovery
          </li>
        </ul>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {isReady ? (
          <button
            onClick={onNext}
            className="flex items-center gap-2 px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
            data-testid="cloud-next-btn"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <>
            <button
              onClick={handleConnect}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
              data-testid="cloud-connect-btn"
            >
              <Cloud className="w-4 h-4" />
              Connect Cloud
            </button>
            <button
              onClick={onSkip}
              className="flex items-center gap-2 px-4 py-2.5 text-text-secondary-dark hover:text-text-primary-dark transition-colors text-sm"
              data-testid="cloud-skip-btn"
            >
              Skip for now
              <SkipForward className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default StepCloudConnect;
