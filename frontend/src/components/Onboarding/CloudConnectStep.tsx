/**
 * CloudConnectStep
 *
 * First-run step "Connect Crewly Cloud", built for an owner who is usually NOT
 * at the machine:
 *
 * 1. **Device pairing** (primary, starts by itself —
 *    {@link CloudDevicePairingPanel}). The page shows a QR code, a link to
 *    `crewlyai.com/cloud/pair?code=…` and the short code; the owner approves on
 *    their phone and this machine connects by itself. No token handling.
 * 2. **Sign in with Google** in this browser (secondary). Crewly Cloud's
 *    `/api/cloud/google/start?redirect=<this origin>/auth/callback?next=…`
 *    sends the browser back to *this* web app — whatever address the page
 *    was opened from (localhost, a LAN address on the phone, a tunnel) — with
 *    `?token=&refreshToken=`. The callback page posts them to
 *    `/api/cloud/connect` on this backend and returns to `/setup?step=cloud`.
 *    Nothing lands on a localhost port of the machine. For any address other
 *    than localhost, Crewly Cloud first asks the owner to confirm the host
 *    on crewlyai.com before the login is sent.
 * 3. **Paste** (last resort, for when the phone cannot be sent back to this
 *    address): sign in on the portal's token page
 *    (`crewlyai.com/cloud/cli-token`), copy the token and refresh token, and
 *    paste them here (`POST /api/cloud/connect`).
 *
 * @module components/Onboarding/CloudConnectStep
 */

import React, { useState } from 'react';
import { CheckCircle2, Cloud, ExternalLink } from 'lucide-react';
import { Alert, Button, FormInput, FormLabel } from '@crewly/ui';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import { buildCloudSignInUrl, setupStepPath } from '../../constants/onboarding-checklist.constants';
import { CloudDevicePairingPanel, PAIRING_LABELS_EN } from '../CloudDevicePairingPanel';

export interface CloudConnectStepProps {
  /** This machine is connected to Crewly Cloud */
  connected: boolean;
  /** Plan, when connected */
  tier: string | null;
  /** Sign-in that ends on the portal's token page (from the checklist) */
  tokenPageSignInUrl: string;
  /** Called once this machine is connected (pairing approved or pasted token accepted) */
  onConnected: () => void;
  /** Navigation (tests) */
  navigateTo?: (url: string) => void;
}

/**
 * Cloud connect step.
 *
 * @param props - {@link CloudConnectStepProps}
 * @returns Step body
 */
export const CloudConnectStep: React.FC<CloudConnectStepProps> = ({
  connected,
  tier,
  tokenPageSignInUrl,
  onConnected,
  navigateTo = (url) => window.location.assign(url),
}) => {
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (connected) {
    return (
      <Alert variant="success" icon={CheckCircle2} title="Connected to Crewly Cloud" data-testid="cloud-connected">
        {tier ? `Plan: ${tier}. ` : ''}You can use Crewly from your phone now.
      </Alert>
    );
  }

  /** Save the pasted tokens. */
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onboardingChecklistService.connectCloud(token.trim(), refreshToken.trim() || undefined);
      setToken('');
      setRefreshToken('');
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="cloud-connect-step">
      <ul className="space-y-1 text-sm text-text-secondary-dark">
        <li>· Check on and direct your team from your phone</li>
        <li>· Automatic backups you can restore on a new computer</li>
        <li>· Slack needs Cloud connected first</li>
      </ul>
      <CloudDevicePairingPanel autoStart labels={PAIRING_LABELS_EN} onConnected={() => onConnected()} />

      <div className="space-y-1 border-t border-border-dark pt-3">
        <Button
          type="button"
          variant="secondary"
          fullWidth
          icon={Cloud}
          onClick={() => navigateTo(buildCloudSignInUrl(window.location.origin, setupStepPath('cloud')))}
          data-testid="cloud-sign-in"
        >
          Or sign in with Google in this browser
        </Button>
        <p className="text-xs text-text-secondary-dark">You come back to this page after signing in.</p>
      </div>

      {!showPaste ? (
        <Button type="button" variant="link" onClick={() => setShowPaste(true)} data-testid="cloud-show-paste">
          Didn&apos;t come back? Use copy and paste instead
        </Button>
      ) : (
        <div className="space-y-3 rounded-2xl border border-border-dark p-3" data-testid="cloud-paste">
          <p className="text-sm text-text-secondary-dark">
            1. Open the{' '}
            <a href={tokenPageSignInUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">
              Crewly Cloud sign-in page <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            . After you sign in it shows two tokens.
          </p>
          <p className="text-sm text-text-secondary-dark">2. Copy each of them here:</p>
          <div className="space-y-1">
            <FormLabel htmlFor="cloud-token">Token</FormLabel>
            <FormInput id="cloud-token" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="space-y-1">
            <FormLabel htmlFor="cloud-refresh-token">Refresh token (keeps you signed in)</FormLabel>
            <FormInput
              id="cloud-refresh-token"
              autoComplete="off"
              spellCheck={false}
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
            />
          </div>
          {!refreshToken.trim() && token.trim() && (
            <p className="text-xs text-yellow-400">Without a refresh token you will need to sign in again in about an hour.</p>
          )}
          {error && (
            <Alert variant="error" size="sm">
              {error}
            </Alert>
          )}
          <Button type="button" fullWidth loading={saving} disabled={!token.trim()} onClick={() => void save()} data-testid="cloud-paste-save">
            Connect
          </Button>
        </div>
      )}
    </div>
  );
};

export default CloudConnectStep;
