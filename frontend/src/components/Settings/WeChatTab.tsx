/**
 * WeChat Integration Tab
 *
 * Settings panel for connecting/disconnecting WeChat via the iLink Bot API.
 * Shows QR code for login, connection status, and disconnect button.
 *
 * @module components/Settings/WeChatTab
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

/** WeChat connection state returned by the API. */
type WeChatState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * WeChat integration settings tab.
 *
 * Allows users to:
 * - Connect WeChat by scanning a QR code
 * - View current connection status
 * - Disconnect WeChat
 *
 * @returns WeChat settings component
 */
export function WeChatTab() {
  const [state, setState] = useState<WeChatState>('disconnected');
  const [botName, setBotName] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Fetch current WeChat status from backend.
   */
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/wechat/status');
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data) {
          setState(data.data.state);
          setBotName(data.data.botName);
          if (data.data.state === 'connected') {
            setQrCodeUrl(null);
            stopStatusPoll();
          }
        }
      }
    } catch {
      // Silent — status fetch is non-critical
    }
  }, []);

  /**
   * Start polling for connection status (while waiting for QR scan).
   */
  const startStatusPoll = useCallback(() => {
    stopStatusPoll();
    statusPollRef.current = setInterval(fetchStatus, 3000);
  }, [fetchStatus]);

  /**
   * Stop status polling.
   */
  const stopStatusPoll = () => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
  };

  /** Fetch initial status on mount. */
  useEffect(() => {
    fetchStatus();
    return stopStatusPoll;
  }, [fetchStatus]);

  /**
   * Request a QR code and start the login flow.
   */
  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    setQrCodeUrl(null);

    try {
      const response = await fetch('/api/wechat/qrcode', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Failed to get QR code: ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.data?.qrcodeUrl) {
        setQrCodeUrl(data.data.qrcodeUrl);
        setState('connecting');
        startStatusPoll();
      } else {
        throw new Error(data.error || 'Failed to generate QR code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setState('error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Disconnect WeChat.
   */
  const handleDisconnect = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/wechat/disconnect', { method: 'POST' });
      if (response.ok) {
        setState('disconnected');
        setBotName(null);
        setQrCodeUrl(null);
        stopStatusPoll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="wechat-tab">
      <div>
        <h3 className="text-lg font-semibold text-gray-200">WeChat Integration</h3>
        <p className="text-sm text-gray-400 mt-1">
          Connect your WeChat account to receive and respond to messages through Crewly.
        </p>
      </div>

      {/* Status */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`h-3 w-3 rounded-full ${
              state === 'connected' ? 'bg-green-400' :
              state === 'connecting' ? 'bg-yellow-400 animate-pulse' :
              state === 'error' ? 'bg-red-400' :
              'bg-gray-500'
            }`} />
            <div>
              <span className="text-sm font-medium text-gray-200">
                {state === 'connected' ? 'Connected' :
                 state === 'connecting' ? 'Waiting for scan...' :
                 state === 'error' ? 'Error' :
                 'Not connected'}
              </span>
              {botName && (
                <p className="text-xs text-gray-400">{botName}</p>
              )}
            </div>
          </div>

          {state === 'connected' ? (
            <button
              onClick={handleDisconnect}
              disabled={loading}
              className="px-4 py-2 text-sm text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 rounded-lg transition-colors disabled:opacity-50"
              data-testid="wechat-disconnect"
            >
              Disconnect
            </button>
          ) : state !== 'connecting' ? (
            <button
              onClick={handleConnect}
              disabled={loading}
              className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-50"
              data-testid="wechat-connect"
            >
              {loading ? 'Loading...' : 'Connect WeChat'}
            </button>
          ) : null}
        </div>
      </div>

      {/* QR Code */}
      {qrCodeUrl && state === 'connecting' && (
        <div className="bg-gray-800 rounded-lg p-6 text-center" data-testid="wechat-qr">
          <p className="text-sm text-gray-300 mb-4">
            Scan this QR code with your WeChat app to connect:
          </p>
          <div className="inline-block bg-white p-4 rounded-lg">
            <img
              src={qrCodeUrl}
              alt="WeChat Login QR Code"
              className="w-48 h-48"
              data-testid="wechat-qr-image"
            />
          </div>
          <p className="text-xs text-gray-500 mt-4">
            QR code expires in 5 minutes. Click &quot;Connect WeChat&quot; to refresh.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3" data-testid="wechat-error">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-500 space-y-1">
        <p>WeChat integration uses the Tencent iLink Bot API.</p>
        <p>Messages sent to your WeChat bot will be routed to the orchestrator.</p>
      </div>
    </div>
  );
}
