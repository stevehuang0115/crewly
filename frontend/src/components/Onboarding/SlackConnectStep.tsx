/**
 * SlackConnectStep
 *
 * First-run step "Connect Slack". Reuses the existing one-click install through
 * Crewly Cloud (`GET /api/slack/cloud/install-url`, the same flow as
 * Connections → Slack): the Slack OAuth round-trip happens on Crewly Cloud,
 * so it works from a phone, and Slack returns to `/setup?step=slack`, where
 * this step asks the backend to pick the new workspace up
 * (`/api/slack/cloud/status?refresh=1`).
 *
 * @module components/Onboarding/SlackConnectStep
 */

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, MessageSquare } from 'lucide-react';
import { Alert, Button } from '@crewly/ui';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import { setupStepPath } from '../../constants/onboarding-checklist.constants';

/** The full Slack settings (channels, agent identities). */
export const SLACK_SETTINGS_PATH = '/connections?platform=slack';

export interface SlackConnectStepProps {
  /** Slack is connected */
  connected: boolean;
  /** Crewly Cloud is connected (the install goes through it) */
  cloudConnected: boolean;
  /** Go to the Cloud step */
  onGoToCloud: () => void;
  /** Called when Slack turned out to be connected */
  onConnected: () => void;
  /** Navigation (tests) */
  navigateTo?: (url: string) => void;
}

/**
 * Slack connect step.
 *
 * @param props - {@link SlackConnectStepProps}
 * @returns Step body
 */
export const SlackConnectStep: React.FC<SlackConnectStepProps> = ({
  connected,
  cloudConnected,
  onGoToCloud,
  onConnected,
  navigateTo = (url) => window.location.assign(url),
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);

  // Coming back from the Slack install (or opened later): let the backend
  // re-read Cloud's Slack config once, so a just-installed workspace connects.
  useEffect(() => {
    if (connected || !cloudConnected || checked.current) return;
    checked.current = true;
    onboardingChecklistService
      .refreshSlack()
      .then((status) => {
        if (status.connected) onConnected();
      })
      .catch(() => {
        // The install button below still works.
      });
  }, [connected, cloudConnected, onConnected]);

  if (connected) {
    return (
      <Alert variant="success" icon={CheckCircle2} title="Slack connected" data-testid="slack-connected">
        DM Crewly in Slack, or @ it in a team channel.
      </Alert>
    );
  }

  if (!cloudConnected) {
    return (
      <div className="space-y-3" data-testid="slack-needs-cloud">
        <Alert variant="info" size="sm">
          Slack is installed through Crewly Cloud. Connect Crewly Cloud first.
        </Alert>
        <Button type="button" variant="secondary" fullWidth onClick={onGoToCloud}>
          Connect Crewly Cloud
        </Button>
      </div>
    );
  }

  /** Open the one-click install. */
  const install = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const url = await onboardingChecklistService.getSlackInstallUrl(`${window.location.origin}${setupStepPath('slack')}`);
      navigateTo(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="slack-connect-step">
      <p className="text-sm text-text-secondary-dark">Add Crewly to your Slack workspace to hand out work and follow progress from Slack.</p>
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      <Button type="button" fullWidth icon={MessageSquare} loading={busy} onClick={() => void install()} data-testid="slack-install">
        Install Crewly in Slack
      </Button>
      <a href={SLACK_SETTINGS_PATH} className="inline-flex items-center gap-1 text-xs text-primary underline">
        More Slack settings <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
};

export default SlackConnectStep;
