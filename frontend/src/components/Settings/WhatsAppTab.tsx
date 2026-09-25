/**
 * WhatsAppTab Component
 *
 * WhatsApp integration configuration panel.
 * Connects the owner's WhatsApp account via QR code pairing. Connecting uses
 * inbox mode: Crewly reads and drafts replies, never sends without the
 * owner's confirmation, and never auto-replies. Pending reply drafts are
 * listed here with 发送 / 丢弃 buttons (owner calls — no agent header).
 *
 * @module components/Settings/WhatsAppTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, QrCode, Send, Trash2 } from 'lucide-react';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Button } from '@crewly/ui/Button';
import { Alert } from '@crewly/ui/Alert';
import { DASHBOARD_CALLER_HEADERS } from '../../constants/caller.constants';
import {
  WHATSAPP_ENDPOINTS,
  WHATSAPP_MODES,
  WHATSAPP_DEFAULT_CONNECT_MODE,
  WHATSAPP_INBOX_COPY,
  type WhatsAppMode,
} from '../../constants/whatsapp.constants';

// =============================================================================
// Types
// =============================================================================

/**
 * WhatsApp connection status from the API
 */
interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  qrCode?: string | null;
  error?: string;
  messagesSent?: number;
  messagesReceived?: number;
  mode?: WhatsAppMode | null;
}

/**
 * A reply draft waiting for the owner (from GET /api/whatsapp/drafts?status=pending)
 */
interface PendingDraft {
  id: string;
  code: string;
  chatId: string;
  recipient: string;
  text: string;
  createdAt: number;
  createdBy: string | null;
  lastError?: string | null;
}

/**
 * Narrow an API payload to a list of pending drafts.
 *
 * @param value - `data` field of the drafts response
 * @returns The drafts, or an empty list when the payload is not a list
 */
function toPendingDrafts(value: unknown): PendingDraft[] {
  return Array.isArray(value)
    ? value.filter((d): d is PendingDraft => !!d && typeof d === 'object' && typeof (d as PendingDraft).id === 'string')
    : [];
}

/**
 * Explains inbox mode: read + draft, owner confirms every send, no auto-replies.
 *
 * @returns Explainer card
 */
const InboxModeNotice: React.FC = () => (
  <div className="bg-background-dark border border-border-dark rounded-lg p-4 space-y-1" data-testid="whatsapp-inbox-notice">
    <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide">{WHATSAPP_INBOX_COPY.TITLE}</h3>
    <p className="text-sm">{WHATSAPP_INBOX_COPY.ZH}</p>
    <p className="text-sm text-text-secondary-dark">{WHATSAPP_INBOX_COPY.EN}</p>
    <p className="text-xs text-text-secondary-dark">{WHATSAPP_INBOX_COPY.TOS}</p>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * WhatsAppTab component for managing WhatsApp integration
 *
 * Features:
 * - QR code pairing flow
 * - Connection status display
 * - Message count statistics
 * - Connect/disconnect actions
 *
 * @returns WhatsAppTab component
 */
export const WhatsAppTab: React.FC = () => {
  const [status, setStatus] = useState<WhatsAppStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);

  /**
   * Fetch current WhatsApp connection status
   */
  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(WHATSAPP_ENDPOINTS.STATUS);
      const data = await res.json();

      if (data.success) {
        setStatus({
          connected: data.data?.isConfigured || data.data?.connected || false,
          phoneNumber: data.data?.phoneNumber,
          qrCode: data.data?.qrCode,
          messagesSent: data.data?.messagesSent,
          messagesReceived: data.data?.messagesReceived,
          mode: data.data?.mode ?? null,
        });
      } else {
        setStatus({ connected: false, error: data.error });
      }
    } catch {
      setStatus({ connected: false, error: 'Failed to fetch WhatsApp status' });
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch reply drafts waiting for the owner
   */
  const fetchDrafts = useCallback(async () => {
    try {
      const res = await fetch(WHATSAPP_ENDPOINTS.PENDING_DRAFTS);
      const data = await res.json();
      setDrafts(data?.success ? toPendingDrafts(data.data) : []);
    } catch {
      setDrafts([]);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchDrafts();
  }, [fetchStatus, fetchDrafts]);

  /**
   * Send or discard one draft as the owner. The request carries no
   * X-Agent-Session header, so the backend treats the click itself as the
   * owner's confirmation.
   *
   * @param draft - The draft
   * @param action - `send` or `discard`
   */
  const handleDraftAction = async (draft: PendingDraft, action: 'send' | 'discard') => {
    setBusyDraftId(draft.id);
    setError(null);
    try {
      const url = action === 'send' ? WHATSAPP_ENDPOINTS.draftSend(draft.id) : WHATSAPP_ENDPOINTS.draftDiscard(draft.id);
      const res = await fetch(url, { method: 'POST', headers: { ...DASHBOARD_CALLER_HEADERS } });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Could not ${action} draft ${draft.code}`);
      }
      await fetchDrafts();
      if (action === 'send') await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} draft ${draft.code}`);
      await fetchDrafts();
    } finally {
      setBusyDraftId(null);
    }
  };

  /**
   * Start WhatsApp connection (triggers QR code generation)
   */
  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      const res = await fetch(WHATSAPP_ENDPOINTS.CONNECT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...DASHBOARD_CALLER_HEADERS },
        body: JSON.stringify({ mode: WHATSAPP_DEFAULT_CONNECT_MODE }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Connection failed');
      }

      // Update status with QR code if returned
      if (data.data?.qrCode) {
        setStatus((prev) => ({ ...prev, qrCode: data.data.qrCode }));
      }

      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect WhatsApp');
    } finally {
      setConnecting(false);
    }
  };

  /**
   * Disconnect from WhatsApp
   */
  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect from WhatsApp?')) {
      return;
    }

    try {
      setError(null);
      const res = await fetch(WHATSAPP_ENDPOINTS.DISCONNECT, { method: 'POST', headers: { ...DASHBOARD_CALLER_HEADERS } });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Disconnect failed');
      }

      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner size="md" text="Loading WhatsApp status..." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Error Banner */}
      {error && (
        <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>
      )}

      {status.mode === WHATSAPP_MODES.ASSISTANT ? (
        <Alert variant="warning">{WHATSAPP_INBOX_COPY.ASSISTANT_WARNING}</Alert>
      ) : (
        <InboxModeNotice />
      )}

      {status.connected ? (
        /* Connected State */
        <div className="space-y-5">
          {/* Status Card */}
          <Alert variant="success">Connected to WhatsApp</Alert>

          {/* Connection Details */}
          <div className="bg-background-dark border border-border-dark rounded-lg p-5">
            <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide mb-3">
              Connection Details
            </h3>
            <div className="space-y-2">
              {status.mode && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Mode</span>
                  <span className="text-sm font-medium" data-testid="whatsapp-mode">{status.mode}</span>
                </div>
              )}
              {status.phoneNumber && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Phone Number</span>
                  <span className="text-sm font-medium">{status.phoneNumber}</span>
                </div>
              )}
              {status.messagesSent !== undefined && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Messages Sent</span>
                  <span className="text-sm font-medium">{status.messagesSent}</span>
                </div>
              )}
              {status.messagesReceived !== undefined && (
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-text-secondary-dark">Messages Received</span>
                  <span className="text-sm font-medium">{status.messagesReceived}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw}>
              Refresh Status
            </Button>
            <Button variant="danger" onClick={handleDisconnect} icon={Unlink}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        /* Setup State */
        <div className="space-y-5">
          {/* QR Code Display */}
          {status.qrCode ? (
            <div className="bg-background-dark border border-border-dark rounded-lg p-6 flex flex-col items-center gap-4">
              <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
                Scan QR Code
              </h3>
              <p className="text-xs text-text-secondary-dark text-center max-w-sm">
                Open WhatsApp on your phone, go to Settings &gt; Linked Devices &gt; Link a Device, then scan this QR code.
              </p>
              <div className="bg-white p-4 rounded-lg">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(status.qrCode)}`}
                  alt="WhatsApp QR Code"
                  className="w-48 h-48"
                  data-testid="whatsapp-qr-code"
                />
              </div>
              <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw}>
                Refresh QR Code
              </Button>
            </div>
          ) : (
            /* Not Connected, No QR */
            <div className="space-y-4">
              <Alert variant="warning">Not connected to WhatsApp</Alert>

              {/* Setup Instructions */}
              <div className="bg-background-dark border border-border-dark rounded-lg p-5">
                <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide mb-3">
                  How to Connect
                </h3>
                <ol className="list-decimal list-inside space-y-2 text-sm text-text-secondary-dark">
                  <li>Click "Connect WhatsApp" below to generate a QR code</li>
                  <li>Open WhatsApp on your phone</li>
                  <li>Go to <strong>Settings</strong> &gt; <strong>Linked Devices</strong> &gt; <strong>Link a Device</strong></li>
                  <li>Scan the QR code displayed here</li>
                </ol>
              </div>

              <Button
                onClick={handleConnect}
                disabled={connecting}
                loading={connecting}
                icon={QrCode}
                fullWidth
              >
                {connecting ? 'Initializing...' : 'Connect WhatsApp'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Pending reply drafts — the owner sends or discards each one */}
      <div className="bg-background-dark border border-border-dark rounded-lg p-5" data-testid="whatsapp-drafts">
        <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide mb-3">
          待发送草稿 · Pending drafts
        </h3>
        {drafts.length === 0 ? (
          <p className="text-sm text-text-secondary-dark">
            No pending drafts. Replies your agents draft appear here for you to send or discard.
          </p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="border border-border-dark rounded-lg p-3 space-y-2"
                data-testid={`whatsapp-draft-${draft.code}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    <span className="text-text-secondary-dark mr-2">{draft.code}</span>
                    → {draft.recipient}
                  </span>
                  {draft.createdBy && (
                    <span className="text-xs text-text-secondary-dark">by {draft.createdBy}</span>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{draft.text}</p>
                {draft.lastError && (
                  <p className="text-xs text-rose-400">Last attempt failed: {draft.lastError}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    icon={Send}
                    onClick={() => handleDraftAction(draft, 'send')}
                    disabled={busyDraftId !== null}
                    loading={busyDraftId === draft.id}
                    aria-label={`发送 ${draft.code}`}
                  >
                    发送
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Trash2}
                    onClick={() => handleDraftAction(draft, 'discard')}
                    disabled={busyDraftId !== null}
                    aria-label={`丢弃 ${draft.code}`}
                  >
                    丢弃
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default WhatsAppTab;
