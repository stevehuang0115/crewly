/**
 * TelegramTab Component
 *
 * Telegram bot integration configuration in Settings.
 * Allows users to connect a Telegram bot for communication
 * with the orchestrator via the unified messenger API.
 *
 * @module components/Settings/TelegramTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle, RefreshCw, Unlink, ExternalLink, X } from 'lucide-react';
import { Button } from '../UI/Button';
import { FormInput, FormLabel } from '../UI/Form';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Telegram connection status from the unified messenger API
 */
interface TelegramStatus {
  connected: boolean;
  botName?: string;
  botId?: string;
  messagesSent?: number;
  messagesReceived?: number;
  error?: string;
}

/**
 * Form state for Telegram configuration
 */
interface TelegramConfigForm {
  botToken: string;
  allowedChats: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unified messenger status endpoint. */
const MESSENGER_STATUS_URL = '/api/messengers/status';

/** Telegram connect endpoint. */
const TELEGRAM_CONNECT_URL = '/api/messengers/telegram/connect';

/** Telegram disconnect endpoint. */
const TELEGRAM_DISCONNECT_URL = '/api/messengers/telegram/disconnect';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * TelegramTab component for managing Telegram bot integration.
 *
 * Follows the same state flow and UI structure as SlackTab:
 * - Loading → Disconnected (setup form) or Connected (status display)
 * - Error banner for failures
 * - Refresh / Disconnect actions when connected
 *
 * @returns TelegramTab component
 */
export const TelegramTab: React.FC = () => {
  const [status, setStatus] = useState<TelegramStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState<TelegramConfigForm>({
    botToken: '',
    allowedChats: '',
  });

  /**
   * Fetch current Telegram connection status from the unified messenger API.
   * Filters the status array for the 'telegram' platform entry.
   */
  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(MESSENGER_STATUS_URL);
      const data = await res.json();

      if (data.success && Array.isArray(data.data)) {
        const tg = data.data.find((p: { platform: string }) => p.platform === 'telegram');
        if (tg) {
          setStatus({
            connected: tg.connected,
            botName: tg.details?.botName,
            botId: tg.details?.botId,
            messagesSent: tg.details?.messagesSent,
            messagesReceived: tg.details?.messagesReceived,
          });
        } else {
          setStatus({ connected: false });
        }
      } else {
        setStatus({ connected: false, error: data.error || 'Failed to fetch status' });
      }
    } catch {
      setStatus({ connected: false, error: 'Failed to fetch status' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /**
   * Handle form input changes.
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  /**
   * Connect to Telegram with the provided bot token.
   */
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfiguring(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { token: formData.botToken };
      if (formData.allowedChats.trim()) {
        body.allowedChats = formData.allowedChats.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const res = await fetch(TELEGRAM_CONNECT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Connection failed');
      }

      setFormData({ botToken: '', allowedChats: '' });
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to Telegram');
    } finally {
      setConfiguring(false);
    }
  };

  /**
   * Disconnect from Telegram.
   */
  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect from Telegram?')) {
      return;
    }

    try {
      setError(null);
      const res = await fetch(TELEGRAM_DISCONNECT_URL, { method: 'POST' });
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
      <div className="flex flex-col items-center justify-center py-16">
        <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin mb-4" />
        <p className="text-text-secondary-dark">Loading Telegram status...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Telegram Integration</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Connect a Telegram bot to communicate with the orchestrator via Telegram.
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-300 p-1" aria-label="×">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {status.connected ? (
        /* Connected State */
        <div className="space-y-6">
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <span className="text-emerald-400 font-medium">Connected to Telegram</span>
          </div>

          <div className="bg-surface-dark border border-border-dark rounded-lg p-6">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">
              Connection Details
            </h3>
            <div className="space-y-3">
              {status.botName && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Bot Name</span>
                  <span className="text-sm font-medium">{status.botName}</span>
                </div>
              )}
              {status.botId && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Bot ID</span>
                  <span className="text-sm font-medium">{status.botId}</span>
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
        <div className="space-y-6">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span className="text-amber-400 font-medium">Not connected to Telegram</span>
          </div>

          <div className="bg-surface-dark border border-border-dark rounded-lg p-6">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">
              Setup Instructions
            </h3>
            <ol className="list-decimal list-inside space-y-3 text-sm text-text-secondary-dark">
              <li>
                Open Telegram and search for{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  @BotFather
                  <ExternalLink className="w-3 h-3" />
                </a>
              </li>
              <li>
                Send <code className="text-xs bg-background-dark px-1.5 py-0.5 rounded">/newbot</code> and follow the prompts to create a bot
              </li>
              <li>Copy the HTTP API token provided by BotFather</li>
              <li>Paste the token below and click Connect</li>
            </ol>
          </div>

          <form onSubmit={handleConnect} className="bg-surface-dark border border-border-dark rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">
              Connect to Telegram
            </h3>

            <div>
              <FormLabel htmlFor="botToken" required>Bot Token</FormLabel>
              <FormInput
                id="botToken"
                name="botToken"
                type="password"
                value={formData.botToken}
                onChange={handleInputChange}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                required
                autoComplete="off"
              />
              <p className="text-xs text-text-secondary-dark mt-1">
                The HTTP API token from @BotFather
              </p>
            </div>

            <div>
              <FormLabel htmlFor="allowedChats">Allowed Chats (optional)</FormLabel>
              <FormInput
                id="allowedChats"
                name="allowedChats"
                type="text"
                value={formData.allowedChats}
                onChange={handleInputChange}
                placeholder="-1001234567890, -1009876543210"
              />
              <p className="text-xs text-text-secondary-dark mt-1">
                Comma-separated chat IDs to restrict the bot to specific groups
              </p>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                disabled={configuring || !formData.botToken}
                loading={configuring}
                fullWidth
              >
                {configuring ? 'Connecting...' : 'Connect to Telegram'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default TelegramTab;
