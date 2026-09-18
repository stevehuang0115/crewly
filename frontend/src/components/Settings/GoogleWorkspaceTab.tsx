/**
 * GoogleWorkspaceTab Component
 *
 * Gmail + Calendar connection card in Settings → Integrations. Crewly
 * Cloud holds the owner's Google grant; this card shows which account is
 * connected, opens the Cloud consent flow, and disconnects.
 *
 * @module components/Settings/GoogleWorkspaceTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, ExternalLink } from 'lucide-react';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `GET /api/google/status` payload. */
interface GoogleWorkspaceStatus {
  connected: boolean;
  cloudConnected: boolean;
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status endpoint. */
const STATUS_URL = '/api/google/status';

/** Connect-URL endpoint (Cloud consent start). */
const CONNECT_URL_ENDPOINT = '/api/google/connect-url';

/** Disconnect endpoint. */
const DISCONNECT_URL = '/api/google/disconnect';

/** Where Cloud sends the browser back after consent. */
const RETURN_PATH = '/settings?tab=integrations';

/** Query flag Cloud appends on return (`?google=connected` / `?google=error`). */
const RETURN_FLAG_PARAM = 'google';

/** Human labels for the scope URLs Google grants. */
const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.readonly': 'Read mail',
  'https://www.googleapis.com/auth/gmail.send': 'Send mail',
  'https://www.googleapis.com/auth/calendar.readonly': 'Read calendar',
  'https://www.googleapis.com/auth/calendar.events': 'Manage events',
  'https://www.googleapis.com/auth/drive.readonly': 'Read Drive',
  'https://www.googleapis.com/auth/drive.file': 'Drive files',
  'https://www.googleapis.com/auth/documents.readonly': 'Read Docs',
};

/**
 * Turn Google scope URLs into short labels, dropping identity scopes.
 *
 * @param scopes - Scope URLs
 * @returns Labels to show
 */
export function describeScopes(scopes: string[] | undefined): string[] {
  return (scopes ?? []).map((s) => SCOPE_LABELS[s]).filter((s): s is string => !!s);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * GoogleWorkspaceTab — connected email / Connect / Disconnect.
 *
 * States: loading → not signed in to Cloud (explain) → not connected
 * (Connect button) → connected (email, scopes, Disconnect).
 *
 * @returns GoogleWorkspaceTab component
 */
export const GoogleWorkspaceTab: React.FC = () => {
  const [status, setStatus] = useState<GoogleWorkspaceStatus>({ connected: false, cloudConnected: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Fetch the grant status from the backend.
   */
  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(STATUS_URL);
      const data = await res.json();
      if (res.ok && data.success) {
        setStatus(data.data as GoogleWorkspaceStatus);
      } else {
        setStatus({ connected: false, cloudConnected: false });
        setError(data.hint || data.message || data.error || 'Failed to fetch Google Workspace status');
      }
    } catch {
      setStatus({ connected: false, cloudConnected: false });
      setError('Failed to fetch Google Workspace status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // Cloud lands back here with ?google=connected|error after consent.
    try {
      const flag = new URLSearchParams(window.location.search).get(RETURN_FLAG_PARAM);
      if (flag === 'connected') setNotice('Google Workspace connected.');
      else if (flag === 'error') setError('Google Workspace connection failed. Please try again.');
    } catch {
      // window may be unavailable in tests; ignore
    }
  }, [fetchStatus]);

  /**
   * Ask the backend for the Cloud consent URL and navigate there.
   */
  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const returnUrl = `${window.location.origin}${RETURN_PATH}`;
      const res = await fetch(`${CONNECT_URL_ENDPOINT}?returnUrl=${encodeURIComponent(returnUrl)}`);
      const data = await res.json();
      if (!res.ok || !data.success || !data.data?.url) {
        throw new Error(data.hint || data.message || data.error || 'Could not start Google sign-in');
      }
      window.location.href = data.data.url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in');
      setBusy(false);
    }
  };

  /**
   * Revoke the grant on Cloud.
   */
  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Google Workspace? Agents will no longer be able to read mail or the calendar.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(DISCONNECT_URL, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.hint || data.message || data.error || 'Disconnect failed');
      }
      setNotice(null);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner text="Loading Google Workspace status..." />
      </div>
    );
  }

  const scopeLabels = describeScopes(status.scopes);

  return (
    <div className="space-y-6 max-w-3xl" data-testid="google-workspace-tab">
      <div>
        <h2 className="text-xl font-semibold">Google Workspace</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Let agents read your Gmail, send mail on your behalf and manage your calendar. Crewly Cloud keeps
          the Google sign-in; mail content goes straight from Google to this instance.
        </p>
      </div>

      {error && (
        <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>
      )}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>
      )}

      {status.connected ? (
        <div className="space-y-6">
          <Alert variant="success">Connected as {status.email ?? 'your Google account'}</Alert>

          <Card padding="lg">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">
              Connection Details
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-border-dark">
                <span className="text-sm text-text-secondary-dark">Account</span>
                <span className="text-sm font-medium" data-testid="google-workspace-email">{status.email ?? '—'}</span>
              </div>
              {scopeLabels.length > 0 && (
                <div className="flex items-center justify-between py-2 border-b border-border-dark">
                  <span className="text-sm text-text-secondary-dark">Access</span>
                  <span className="text-sm font-medium">{scopeLabels.join(', ')}</span>
                </div>
              )}
              {status.grantedAt && (
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-text-secondary-dark">Connected</span>
                  <span className="text-sm font-medium">{new Date(status.grantedAt).toLocaleString()}</span>
                </div>
              )}
            </div>
          </Card>

          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw} disabled={busy}>
              Refresh Status
            </Button>
            <Button variant="danger" onClick={handleDisconnect} icon={Unlink} loading={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {status.cloudConnected ? (
            <>
              <Alert variant="warning">Google Workspace is not connected</Alert>
              <Card padding="lg">
                <p className="text-sm text-text-secondary-dark mb-4">
                  You will be sent to Google to approve access for the account you use with Crewly Cloud, then
                  brought back here.
                </p>
                <Button variant="primary" onClick={handleConnect} icon={ExternalLink} loading={busy}>
                  Connect Google Workspace
                </Button>
              </Card>
            </>
          ) : (
            <Alert variant="info">
              Sign in to Crewly Cloud first (Settings → Cloud), then connect Google Workspace here.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
};

export default GoogleWorkspaceTab;
