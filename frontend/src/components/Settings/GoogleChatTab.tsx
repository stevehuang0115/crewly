/**
 * GoogleChatTab Component
 *
 * Google Chat integration configuration panel.
 * Supports three connection modes:
 * 1. Webhook mode (simpler) — paste an incoming webhook URL (send-only)
 * 2. Service account mode — paste a service account JSON key (send-only)
 * 3. Pub/Sub mode — bidirectional: pull messages from Pub/Sub, reply via Chat API
 *
 * @module components/Settings/GoogleChatTab
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle, Download, RefreshCw, Send, Unlink, X } from 'lucide-react';
import { Button } from '../UI/Button';
import { FormInput, FormLabel } from '../UI/Form';

// =============================================================================
// Types
// =============================================================================

/**
 * Google Chat connection status from the messenger API
 */
interface GoogleChatStatus {
  connected: boolean;
  mode?: string;
  authMode?: string;
  serviceAccountEmail?: string;
  pullActive?: boolean;
  pullPaused?: boolean;
  subscriptionName?: string;
  projectId?: string;
  consecutiveFailures?: number;
  lastPullAt?: string | null;
  error?: string;
}

/**
 * Connection mode for Google Chat
 */
type ConnectionMode = 'webhook' | 'service-account' | 'pubsub';

/**
 * Authentication mode for service account / pubsub modes
 */
type AuthMode = 'service_account' | 'adc';

// =============================================================================
// Component
// =============================================================================

/**
 * GoogleChatTab component for managing Google Chat integration
 *
 * @returns GoogleChatTab component
 */
export const GoogleChatTab: React.FC = () => {
  const [status, setStatus] = useState<GoogleChatStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('pubsub');
  const [authMode, setAuthMode] = useState<AuthMode>('service_account');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [serviceAccountKey, setServiceAccountKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [subscriptionName, setSubscriptionName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string | null>(null);
  const [testSending, setTestSending] = useState(false);
  const [testSendResult, setTestSendResult] = useState<string | null>(null);
  const [testSendSpace, setTestSendSpace] = useState('');
  const [serviceAccountEmail, setServiceAccountEmail] = useState('');
  const autoRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Fetch Google Chat connection status via the messenger API
   */
  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/messengers/status');
      const data = await res.json();

      if (data.success && Array.isArray(data.data)) {
        const gchat = data.data.find(
          (p: { platform: string }) => p.platform === 'google-chat'
        );
        if (gchat) {
          // Also fetch live status for Pub/Sub details
          let liveDetails = gchat.details || {};
          if (gchat.connected && gchat.details?.mode === 'pubsub') {
            try {
              const liveRes = await fetch('/api/messengers/google-chat/status');
              const liveData = await liveRes.json();
              if (liveData.success) {
                liveDetails = { ...liveDetails, ...liveData.data };
              }
            } catch {
              // Non-fatal — fall back to adapter status
            }
          }
          setStatus({
            connected: gchat.connected,
            mode: liveDetails.mode,
            authMode: liveDetails.authMode,
            serviceAccountEmail: liveDetails.serviceAccountEmail,
            pullActive: liveDetails.pullActive,
            pullPaused: liveDetails.pullPaused,
            subscriptionName: liveDetails.subscriptionName,
            projectId: liveDetails.projectId,
            consecutiveFailures: liveDetails.consecutiveFailures,
            lastPullAt: liveDetails.lastPullAt,
          });
        }
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

  // Auto-refresh status every 10s when connected in Pub/Sub mode
  useEffect(() => {
    if (status.connected && status.mode === 'pubsub') {
      autoRefreshTimer.current = setInterval(() => {
        fetchStatus();
      }, 10000);
    }
    return () => {
      if (autoRefreshTimer.current) {
        clearInterval(autoRefreshTimer.current);
        autoRefreshTimer.current = null;
      }
    };
  }, [status.connected, status.mode, fetchStatus]);

  /**
   * Connect to Google Chat with provided credentials
   */
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setError(null);

    try {
      let body: Record<string, string>;

      if (connectionMode === 'webhook') {
        body = { webhookUrl };
      } else if (authMode === 'adc') {
        // ADC mode — no service account key needed
        body = { authMode: 'adc' };
        if (connectionMode === 'pubsub') {
          body.projectId = projectId;
          body.subscriptionName = subscriptionName;
        }
        if (serviceAccountEmail.trim()) {
          body.serviceAccountEmail = serviceAccountEmail.trim();
        }
      } else if (connectionMode === 'service-account') {
        body = { serviceAccountKey };
      } else {
        // pubsub mode with service account
        body = { serviceAccountKey, projectId, subscriptionName };
      }

      const res = await fetch('/api/messengers/google-chat/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Connection failed');
      }

      // Clear sensitive data
      setWebhookUrl('');
      setServiceAccountKey('');
      setProjectId('');
      setSubscriptionName('');
      setServiceAccountEmail('');
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  /**
   * Disconnect from Google Chat
   */
  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect from Google Chat?')) {
      return;
    }

    try {
      setError(null);
      const res = await fetch('/api/messengers/google-chat/disconnect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Disconnect failed');
      }

      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    }
  };

  /**
   * Manually trigger a Pub/Sub pull
   */
  const handlePullNow = async () => {
    setPulling(true);
    setPullResult(null);
    try {
      const res = await fetch('/api/messengers/google-chat/pull', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Pull failed');
      }
      const count = data.messagesReceived || 0;
      setPullResult(count > 0 ? `Pulled ${count} message${count !== 1 ? 's' : ''}` : 'No new messages');
      await fetchStatus();
    } catch (err) {
      setPullResult(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setPulling(false);
    }
  };

  /**
   * Send a test message to verify the connection
   */
  const handleTestSend = async () => {
    if (!testSendSpace.trim()) return;
    setTestSending(true);
    setTestSendResult(null);
    try {
      const res = await fetch('/api/messengers/google-chat/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ space: testSendSpace.trim(), text: 'Test message from Crewly' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Test send failed');
      }
      setTestSendResult('Message sent successfully');
    } catch (err) {
      setTestSendResult(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setTestSending(false);
    }
  };

  /**
   * Get human-readable mode label
   */
  const getModeLabel = (mode?: string): string => {
    switch (mode) {
      case 'webhook': return 'Webhook';
      case 'service-account': return 'Service Account';
      case 'pubsub': return 'Pub/Sub (Bidirectional)';
      default: return 'Unknown';
    }
  };

  /**
   * Get human-readable auth mode label
   */
  const getAuthModeLabel = (mode?: string): string => {
    return mode === 'adc' ? 'Application Default Credentials' : 'Service Account Key';
  };

  /**
   * Check if form is valid for the current mode
   */
  const isFormValid = (): boolean => {
    if (connectionMode === 'webhook') return Boolean(webhookUrl);
    if (authMode === 'adc') {
      if (connectionMode === 'pubsub') return Boolean(projectId && subscriptionName);
      return true; // ADC service-account mode needs no user input
    }
    if (connectionMode === 'service-account') return Boolean(serviceAccountKey);
    return Boolean(serviceAccountKey && projectId && subscriptionName);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="w-8 h-8 border-4 border-primary/20 border-t-primary rounded-full animate-spin mb-3" />
        <p className="text-sm text-text-secondary-dark">Loading Google Chat status...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Error Banner */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span className="text-sm">{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-300 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {status.connected ? (
        /* Connected State */
        <div className="space-y-5">
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <span className="text-emerald-400 font-medium text-sm">Connected to Google Chat</span>
          </div>

          <div className="bg-background-dark border border-border-dark rounded-lg p-5">
            <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide mb-3">
              Connection Details
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-text-secondary-dark">Mode</span>
                <span className="text-sm font-medium">{getModeLabel(status.mode)}</span>
              </div>
              {(status.mode === 'pubsub' || status.mode === 'service-account') && (
                <div className="flex items-center justify-between py-2 border-t border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Auth</span>
                  <span className="text-sm font-medium">{getAuthModeLabel(status.authMode)}</span>
                </div>
              )}
              {status.serviceAccountEmail && (
                <div className="flex items-center justify-between py-2 border-t border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Impersonating</span>
                  <span className="text-sm font-mono truncate max-w-[280px]" data-testid="sa-email-display">{status.serviceAccountEmail}</span>
                </div>
              )}
              {status.mode === 'pubsub' && (
                <>
                  <div className="flex items-center justify-between py-2 border-t border-border-dark">
                    <span className="text-sm text-text-secondary-dark">Project ID</span>
                    <span className="text-sm font-mono">{status.projectId}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-t border-border-dark">
                    <span className="text-sm text-text-secondary-dark">Subscription</span>
                    <span className="text-sm font-mono text-text-secondary-dark/80 truncate max-w-[240px]">{status.subscriptionName}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-t border-border-dark">
                    <span className="text-sm text-text-secondary-dark">Pull Loop</span>
                    <span className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${status.pullPaused ? 'bg-amber-400' : status.pullActive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
                      <span className={`text-sm font-medium ${status.pullPaused ? 'text-amber-400' : status.pullActive ? 'text-emerald-400' : 'text-text-secondary-dark'}`}>
                        {status.pullPaused ? 'Paused (errors)' : status.pullActive ? 'Running' : 'Stopped'}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-t border-border-dark">
                    <span className="text-sm text-text-secondary-dark">Last Pull</span>
                    <span className="text-sm font-mono" data-testid="last-pull-at">
                      {status.lastPullAt ? new Date(status.lastPullAt).toLocaleTimeString() : 'Never'}
                    </span>
                  </div>
                  {(status.consecutiveFailures ?? 0) > 0 && (
                    <div className="flex items-center justify-between py-2 border-t border-border-dark">
                      <span className="text-sm text-text-secondary-dark">Consecutive Failures</span>
                      <span className="text-sm font-medium text-amber-400" data-testid="consecutive-failures">{status.consecutiveFailures}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {status.mode === 'pubsub' && (
              <Button
                variant="primary"
                onClick={handlePullNow}
                disabled={pulling}
                loading={pulling}
                icon={Download}
                data-testid="pull-now-btn"
              >
                {pulling ? 'Pulling...' : 'Pull Now'}
              </Button>
            )}
            <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw}>
              Refresh Status
            </Button>
            <Button variant="danger" onClick={handleDisconnect} icon={Unlink}>
              Disconnect
            </Button>
          </div>

          {/* Pull result feedback */}
          {pullResult && (
            <div className={`text-sm px-3 py-2 rounded-lg ${
              pullResult.startsWith('Pulled') ? 'bg-emerald-500/10 text-emerald-400' :
              pullResult === 'No new messages' ? 'bg-blue-500/10 text-blue-400' :
              'bg-rose-500/10 text-rose-400'
            }`} data-testid="pull-result">
              {pullResult}
            </div>
          )}

          {/* Test Send (pubsub and service-account modes) */}
          {(status.mode === 'pubsub' || status.mode === 'service-account') && (
            <div className="bg-background-dark border border-border-dark rounded-lg p-4 space-y-3">
              <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide">Test Send</h3>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <FormLabel htmlFor="test-send-space">Space Name</FormLabel>
                  <FormInput
                    id="test-send-space"
                    name="testSendSpace"
                    type="text"
                    value={testSendSpace}
                    onChange={(e) => setTestSendSpace(e.target.value)}
                    placeholder="spaces/AAAA..."
                    autoComplete="off"
                    data-testid="test-send-space"
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={handleTestSend}
                  disabled={testSending || !testSendSpace.trim()}
                  loading={testSending}
                  icon={Send}
                  data-testid="test-send-btn"
                >
                  {testSending ? 'Sending...' : 'Test Send'}
                </Button>
              </div>
              {testSendResult && (
                <div className={`text-sm px-3 py-2 rounded-lg ${
                  testSendResult === 'Message sent successfully' ? 'bg-emerald-500/10 text-emerald-400' :
                  'bg-rose-500/10 text-rose-400'
                }`} data-testid="test-send-result">
                  {testSendResult}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Setup State */
        <div className="space-y-5">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span className="text-amber-400 font-medium text-sm">Not connected to Google Chat</span>
          </div>

          {/* Connection Mode Toggle */}
          <div className="flex gap-2">
            <button
              className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                connectionMode === 'pubsub'
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:text-text-primary-dark'
              }`}
              onClick={() => setConnectionMode('pubsub')}
              data-testid="mode-pubsub"
            >
              Pub/Sub (Recommended)
            </button>
            <button
              className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                connectionMode === 'webhook'
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:text-text-primary-dark'
              }`}
              onClick={() => setConnectionMode('webhook')}
              data-testid="mode-webhook"
            >
              Webhook
            </button>
            <button
              className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                connectionMode === 'service-account'
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:text-text-primary-dark'
              }`}
              onClick={() => setConnectionMode('service-account')}
              data-testid="mode-service-account"
            >
              Service Account
            </button>
          </div>

          {/* Setup Instructions */}
          <div className="bg-background-dark border border-border-dark rounded-lg p-5">
            <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide mb-3">
              {connectionMode === 'pubsub' ? 'Pub/Sub Setup (Bidirectional)' :
               connectionMode === 'webhook' ? 'Webhook Setup (Send-only)' :
               'Service Account Setup (Send-only)'}
            </h3>
            {connectionMode === 'pubsub' ? (
              <ol className="list-decimal list-inside space-y-2 text-sm text-text-secondary-dark">
                <li>Go to <strong>Google Cloud Console</strong> &gt; <strong>APIs & Services</strong></li>
                <li>Enable the <strong>Google Chat API</strong> and <strong>Cloud Pub/Sub API</strong></li>
                <li>Create a <strong>Service Account</strong> and download the JSON key</li>
                <li>In the Chat API settings, create a <strong>Chat App</strong> and select <strong>Cloud Pub/Sub</strong> as the connection type</li>
                <li>Enter a <strong>Pub/Sub topic name</strong> (e.g., <code className="bg-surface-dark px-1 rounded">projects/my-project/topics/google-chat-events</code>)</li>
                <li>Create a <strong>Pub/Sub subscription</strong> for that topic (pull mode)</li>
                <li>Grant the service account <strong>Pub/Sub Subscriber</strong> role on the subscription</li>
                <li>Fill in the details below</li>
              </ol>
            ) : connectionMode === 'webhook' ? (
              <ol className="list-decimal list-inside space-y-2 text-sm text-text-secondary-dark">
                <li>Open your Google Chat space</li>
                <li>Click the space name &gt; <strong>Apps & integrations</strong> &gt; <strong>Manage webhooks</strong></li>
                <li>Create a new webhook and copy the URL</li>
                <li>Paste the webhook URL below</li>
              </ol>
            ) : (
              <ol className="list-decimal list-inside space-y-2 text-sm text-text-secondary-dark">
                <li>Go to the <strong>Google Cloud Console</strong> &gt; <strong>APIs & Services</strong></li>
                <li>Enable the <strong>Google Chat API</strong></li>
                <li>Create a <strong>Service Account</strong> and download the JSON key</li>
                <li>Grant the service account access to your Chat space</li>
                <li>Paste the JSON key contents below</li>
              </ol>
            )}
          </div>

          {/* Connection Form */}
          <form onSubmit={handleConnect} className="space-y-4">
            {connectionMode === 'webhook' ? (
              <div>
                <FormLabel htmlFor="gchat-webhook" required>Webhook URL</FormLabel>
                <FormInput
                  id="gchat-webhook"
                  name="webhookUrl"
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://chat.googleapis.com/v1/spaces/..."
                  required
                  autoComplete="off"
                />
              </div>
            ) : (
              <>
                {/* Auth Mode Selector (for pubsub and service-account modes) */}
                <div>
                  <FormLabel>Authentication Method</FormLabel>
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        authMode === 'service_account'
                          ? 'bg-primary/10 border-primary text-primary'
                          : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:text-text-primary-dark'
                      }`}
                      onClick={() => setAuthMode('service_account')}
                      data-testid="auth-service-account"
                    >
                      Service Account Key
                    </button>
                    <button
                      type="button"
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        authMode === 'adc'
                          ? 'bg-primary/10 border-primary text-primary'
                          : 'bg-surface-dark border-border-dark text-text-secondary-dark hover:text-text-primary-dark'
                      }`}
                      onClick={() => setAuthMode('adc')}
                      data-testid="auth-adc"
                    >
                      Application Default Credentials
                    </button>
                  </div>
                </div>

                {connectionMode === 'pubsub' && (
                  <>
                    <div>
                      <FormLabel htmlFor="gchat-project-id" required>GCP Project ID</FormLabel>
                      <FormInput
                        id="gchat-project-id"
                        name="projectId"
                        type="text"
                        value={projectId}
                        onChange={(e) => setProjectId(e.target.value)}
                        placeholder="my-gcp-project-id"
                        required
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <FormLabel htmlFor="gchat-subscription" required>Pub/Sub Subscription Name</FormLabel>
                      <FormInput
                        id="gchat-subscription"
                        name="subscriptionName"
                        type="text"
                        value={subscriptionName}
                        onChange={(e) => setSubscriptionName(e.target.value)}
                        placeholder="google-chat-events-sub"
                        required
                        autoComplete="off"
                      />
                      <p className="mt-1 text-xs text-text-secondary-dark/70">
                        Just the subscription name, not the full resource path
                      </p>
                    </div>
                  </>
                )}

                {authMode === 'adc' ? (
                  <>
                    <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                      <p className="text-sm text-blue-300 mb-2">
                        Using Application Default Credentials from your local gcloud CLI.
                      </p>
                      <p className="text-xs text-text-secondary-dark mb-2">
                        Run this command if you haven&apos;t already:
                      </p>
                      <code className="block bg-background-dark px-3 py-2 rounded text-xs text-text-primary-dark font-mono break-all">
                        gcloud auth application-default login --scopes=https://www.googleapis.com/auth/chat.bot,https://www.googleapis.com/auth/pubsub,https://www.googleapis.com/auth/cloud-platform
                      </code>
                    </div>
                    <div>
                      <FormLabel htmlFor="gchat-sa-email">Service Account Email (for impersonation)</FormLabel>
                      <FormInput
                        id="gchat-sa-email"
                        name="serviceAccountEmail"
                        type="email"
                        value={serviceAccountEmail}
                        onChange={(e) => setServiceAccountEmail(e.target.value)}
                        placeholder="chatbot@project.iam.gserviceaccount.com"
                        autoComplete="off"
                        data-testid="sa-email-input"
                      />
                      <p className="mt-1 text-xs text-text-secondary-dark/70">
                        Required for sending messages. Your user needs the Service Account Token Creator IAM role.
                      </p>
                    </div>
                  </>
                ) : (
                  <div>
                    <FormLabel htmlFor="gchat-sa-key" required>Service Account Key (JSON)</FormLabel>
                    <textarea
                      id="gchat-sa-key"
                      name="serviceAccountKey"
                      value={serviceAccountKey}
                      onChange={(e) => setServiceAccountKey(e.target.value)}
                      placeholder='{"type": "service_account", "project_id": "...", ...}'
                      required
                      rows={6}
                      className="w-full px-3 py-2 bg-background-dark border border-border-dark rounded-lg text-sm text-text-primary-dark placeholder:text-text-secondary-dark/50 focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                    />
                  </div>
                )}
              </>
            )}

            <Button
              type="submit"
              disabled={connecting || !isFormValid()}
              loading={connecting}
              fullWidth
            >
              {connecting ? 'Connecting...' : 'Connect Google Chat'}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
};

export default GoogleChatTab;
