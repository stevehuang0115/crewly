/**
 * CloudConnectStep
 *
 * First-run step "连接 Crewly Cloud", built for an owner who is usually NOT
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
import { CloudDevicePairingPanel, PAIRING_LABELS_ZH } from '../CloudDevicePairingPanel';

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
      <Alert variant="success" icon={CheckCircle2} title="已连接 Crewly Cloud" data-testid="cloud-connected">
        {tier ? `当前套餐：${tier}。` : ''}可以在手机上用 Crewly 了。
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
        <li>· 在手机上随时查看和指挥团队</li>
        <li>· 自动备份，换电脑也能恢复</li>
        <li>· 连接 Slack 需要先连 Cloud</li>
      </ul>
      <CloudDevicePairingPanel autoStart labels={PAIRING_LABELS_ZH} onConnected={() => onConnected()} />

      <div className="space-y-1 border-t border-border-dark pt-3">
        <Button
          type="button"
          variant="secondary"
          fullWidth
          icon={Cloud}
          onClick={() => navigateTo(buildCloudSignInUrl(window.location.origin, setupStepPath('cloud')))}
          data-testid="cloud-sign-in"
        >
          或者：在这个浏览器里用 Google 登录
        </Button>
        <p className="text-xs text-text-secondary-dark">登录后会自动回到这一页。</p>
      </div>

      {!showPaste ? (
        <Button type="button" variant="link" onClick={() => setShowPaste(true)} data-testid="cloud-show-paste">
          没有自动回来？改用复制粘贴
        </Button>
      ) : (
        <div className="space-y-3 rounded-2xl border border-border-dark p-3" data-testid="cloud-paste">
          <p className="text-sm text-text-secondary-dark">
            1. 打开{' '}
            <a href={tokenPageSignInUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">
              Crewly Cloud 登录页 <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            ，登录后会显示两段 token。
          </p>
          <p className="text-sm text-text-secondary-dark">2. 分别复制过来：</p>
          <div className="space-y-1">
            <FormLabel htmlFor="cloud-token">Token</FormLabel>
            <FormInput id="cloud-token" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="space-y-1">
            <FormLabel htmlFor="cloud-refresh-token">Refresh token（保持长期登录）</FormLabel>
            <FormInput
              id="cloud-refresh-token"
              autoComplete="off"
              spellCheck={false}
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
            />
          </div>
          {!refreshToken.trim() && token.trim() && (
            <p className="text-xs text-yellow-400">没有 refresh token 的话，大约一小时后需要重新登录。</p>
          )}
          {error && (
            <Alert variant="error" size="sm">
              {error}
            </Alert>
          )}
          <Button type="button" fullWidth loading={saving} disabled={!token.trim()} onClick={() => void save()} data-testid="cloud-paste-save">
            连接
          </Button>
        </div>
      )}
    </div>
  );
};

export default CloudConnectStep;
