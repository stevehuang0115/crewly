/**
 * WhatsAppTab Component
 *
 * WhatsApp integration configuration panel.
 * Allows users to connect their WhatsApp account via QR code pairing
 * for mobile communication with the orchestrator.
 *
 * @module components/Settings/WhatsAppTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, QrCode } from 'lucide-react';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Button } from '../UI/Button';
import { Alert } from '../UI/Alert';

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
}

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

  /**
   * Fetch current WhatsApp connection status
   */
  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/whatsapp/status');
      const data = await res.json();

      if (data.success) {
        setStatus({
          connected: data.data?.isConfigured || data.data?.connected || false,
          phoneNumber: data.data?.phoneNumber,
          qrCode: data.data?.qrCode,
          messagesSent: data.data?.messagesSent,
          messagesReceived: data.data?.messagesReceived,
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

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /**
   * Start WhatsApp connection (triggers QR code generation)
   */
  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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
      const res = await fetch('/api/whatsapp/disconnect', { method: 'POST' });
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
    </div>
  );
};

export default WhatsAppTab;
