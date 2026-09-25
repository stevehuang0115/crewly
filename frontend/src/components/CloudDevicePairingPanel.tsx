/**
 * CloudDevicePairingPanel
 *
 * Connects this machine to Crewly Cloud by device-code pairing — the way
 * that works when the owner is not at the machine:
 *
 * 1. The backend asks Crewly Cloud for a pairing; the panel shows a QR code,
 *    the link (`crewlyai.com/cloud/pair?code=…`) and the short code.
 * 2. The owner scans / opens it on their phone and taps Approve.
 * 3. The backend, polling in the background, receives the tokens and
 *    connects by itself; the panel sees `connected` and calls `onConnected`.
 *
 * No token ever passes through this page. Used by `/setup`'s Cloud step
 * (Chinese copy, starts on its own) and Settings → Cloud (English copy,
 * starts on a click).
 *
 * @module components/CloudDevicePairingPanel
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, ExternalLink, Smartphone } from 'lucide-react';
import { Alert, Button } from '@crewly/ui';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { cloudDevicePairingService, type CloudDevicePairingStatus } from '../services/cloud-device-pairing.service';
import { CLOUD_DEVICE_PAIRING_POLL_MS, CLOUD_DEVICE_PAIRING_QR_SIZE } from '../constants/cloud.constants';

/** Copy for one language. */
export interface CloudDevicePairingLabels {
  start: string;
  intro: string;
  scan: string;
  code: string;
  waiting: string;
  cancel: string;
  connected: (tier?: string) => string;
  expired: string;
  denied: string;
  cancelled: string;
  retry: string;
}

/** Chinese copy (first-run setup). */
export const PAIRING_LABELS_ZH: CloudDevicePairingLabels = {
  start: '用手机连接 Crewly Cloud',
  intro: '不用在这台电脑前：用手机扫码或打开链接，登录后点「批准」，这台电脑会自己连上。',
  scan: '用手机扫码，或打开：',
  code: '核对这个代码',
  waiting: '等待你在手机上批准…',
  cancel: '取消',
  connected: (tier) => `已连接 Crewly Cloud${tier ? `（${tier}）` : ''}`,
  expired: '链接已过期，重新生成一个。',
  denied: '在 crewlyai.com 上被拒绝了。',
  cancelled: '已取消。',
  retry: '重新生成',
};

/** English copy (Settings). */
export const PAIRING_LABELS_EN: CloudDevicePairingLabels = {
  start: 'Connect with your phone',
  intro: 'No need to be at this machine: scan the code or open the link on your phone, sign in and tap Approve. This machine connects by itself.',
  scan: 'Scan with your phone, or open:',
  code: 'Check the code matches',
  waiting: 'Waiting for you to approve on your phone…',
  cancel: 'Cancel',
  connected: (tier) => `Connected to Crewly Cloud${tier ? ` (${tier})` : ''}`,
  expired: 'The link expired. Get a new one.',
  denied: 'The request was denied on crewlyai.com.',
  cancelled: 'Cancelled.',
  retry: 'Get a new link',
};

export interface CloudDevicePairingPanelProps {
  /** Copy to use */
  labels?: CloudDevicePairingLabels;
  /** Start a pairing as soon as the panel mounts (the setup step) */
  autoStart?: boolean;
  /** Called once the backend reports `connected` */
  onConnected?: (tier?: string) => void;
}

/**
 * Device-code pairing panel.
 *
 * @param props - {@link CloudDevicePairingPanelProps}
 * @returns Panel element
 */
export const CloudDevicePairingPanel: React.FC<CloudDevicePairingPanelProps> = ({
  labels = PAIRING_LABELS_EN,
  autoStart = false,
  onConnected,
}) => {
  const [status, setStatus] = useState<CloudDevicePairingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const notified = useRef(false);

  /** Ask the backend for a pairing (or the pending one). */
  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      setStatus(await cloudDevicePairingService.start());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    if (autoStart) void start();
  }, [autoStart, start]);

  // While pending, follow the backend until it connects (or the pairing ends).
  const pending = status?.state === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => {
      cloudDevicePairingService
        .status()
        .then(setStatus)
        .catch(() => {
          // Transient (backend restarting, phone off Wi-Fi): keep waiting.
        });
    }, CLOUD_DEVICE_PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    if (status?.state === 'connected' && !notified.current) {
      notified.current = true;
      onConnected?.(status.tier);
    }
  }, [status, onConnected]);

  /** Stop waiting. */
  const cancel = async (): Promise<void> => {
    try {
      setStatus(await cloudDevicePairingService.cancel());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (status?.state === 'connected') {
    return (
      <Alert variant="success" icon={CheckCircle2} title={labels.connected(status.tier)} data-testid="cloud-pairing-connected">
        {status.email ?? ''}
      </Alert>
    );
  }

  if (status?.state === 'pending' && status.verificationUrl) {
    return (
      <div className="space-y-4" data-testid="cloud-pairing-pending">
        <p className="text-sm text-text-secondary-dark">{labels.intro}</p>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border-dark p-4">
          <div className="rounded-xl bg-white p-2" data-testid="cloud-pairing-qr">
            <QRCodeSVG value={status.verificationUrl} size={CLOUD_DEVICE_PAIRING_QR_SIZE} level="M" />
          </div>
          <p className="text-xs text-text-secondary-dark">{labels.scan}</p>
          <a
            href={status.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 break-all text-sm text-primary underline"
            data-testid="cloud-pairing-link"
          >
            {status.verificationUrl} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
          <p className="text-xs text-text-secondary-dark">{labels.code}</p>
          <p className="font-mono text-2xl font-bold tracking-widest text-text-primary-dark" data-testid="cloud-pairing-code">
            {status.userCode}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm text-text-secondary-dark" data-testid="cloud-pairing-waiting">
            <LoadingSpinner size="xs" centered={false} />
            {labels.waiting}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void cancel()} data-testid="cloud-pairing-cancel">
            {labels.cancel}
          </Button>
        </div>
      </div>
    );
  }

  const ended: Partial<Record<CloudDevicePairingStatus['state'], string>> = {
    expired: labels.expired,
    denied: labels.denied,
    cancelled: labels.cancelled,
  };
  const endedMessage = status ? ended[status.state] ?? (status.state === 'error' ? status.error : undefined) : undefined;

  return (
    <div className="space-y-3" data-testid="cloud-pairing-idle">
      {(error || endedMessage) && (
        <Alert variant={error || status?.state === 'error' || status?.state === 'denied' ? 'error' : 'warning'} size="sm">
          {error ?? endedMessage}
        </Alert>
      )}
      <Button
        type="button"
        fullWidth
        icon={Smartphone}
        loading={starting}
        onClick={() => void start()}
        data-testid="cloud-pairing-start"
      >
        {status || error ? labels.retry : labels.start}
      </Button>
    </div>
  );
};

export default CloudDevicePairingPanel;
