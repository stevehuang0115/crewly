/**
 * MicrosoftTodoTab Component
 *
 * Microsoft To Do connection card on the Connections page. Crewly Cloud
 * holds the owner's Microsoft grant (keyed `microsoft`, so Outlook can
 * share it later); this card shows the connected account, opens the Cloud
 * consent flow, and disconnects.
 *
 * @module components/Settings/MicrosoftTodoTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, ExternalLink } from 'lucide-react';
import { Alert, Button, Card, LoadingSpinner } from '@crewly/ui';

/** `GET /api/microsoft-todo/status` payload. */
interface MicrosoftTodoStatus {
  connected: boolean;
  cloudConnected: boolean;
  microsoftUserId?: string;
  displayName?: string;
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

const STATUS_URL = '/api/microsoft-todo/status';
const CONNECT_URL_ENDPOINT = '/api/microsoft-todo/connect-url';
const DISCONNECT_URL = '/api/microsoft-todo/disconnect';
/** Where Cloud sends the browser back after consent. */
const RETURN_PATH = '/connections?platform=microsoft-todo';
/** Query flag Cloud appends on return (`?microsoft=connected` / `?microsoft=error&reason=`). */
const RETURN_FLAG_PARAM = 'microsoft';
const RETURN_REASON_PARAM = 'reason';

/** Human labels for Microsoft Graph scopes (identity scopes are left out). */
const SCOPE_LABELS: Record<string, string> = {
  'tasks.read': 'Read tasks',
  'tasks.readwrite': 'Read and write tasks',
};

/**
 * Turn Microsoft scopes into short labels. Graph sometimes answers with the
 * full resource URI (`https://graph.microsoft.com/Tasks.ReadWrite`), and
 * casing varies, so both are normalised.
 *
 * @param scopes - Scope names
 * @returns Labels for the known ones
 */
export function describeMicrosoftScopes(scopes: string[] | undefined): string[] {
  const labels = (scopes ?? []).map((s) => SCOPE_LABELS[s.slice(s.lastIndexOf('/') + 1).toLowerCase()]).filter((s): s is string => !!s);
  return Array.from(new Set(labels));
}

/**
 * Explain a failed consent from the `reason` Cloud returned with.
 *
 * @param reason - `reason` query value (may be empty)
 * @returns A sentence for the owner
 */
export function describeConnectFailure(reason: string | null): string {
  switch (reason) {
    case 'access_denied':
      return 'Microsoft To Do was not connected: the consent was declined.';
    case 'consent_required':
    case 'interaction_required':
      return 'Your organisation requires an administrator to approve Crewly before you can connect. Ask your IT admin, or use a personal Microsoft account.';
    case 'invalid_state':
      return 'The connection link expired. Please try again.';
    default:
      return `Microsoft To Do connection failed${reason ? ` (${reason})` : ''}. Please try again.`;
  }
}

/**
 * MicrosoftTodoTab — connected account / Connect / Disconnect.
 *
 * @returns MicrosoftTodoTab component
 */
export const MicrosoftTodoTab: React.FC = () => {
  const [status, setStatus] = useState<MicrosoftTodoStatus>({ connected: false, cloudConnected: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(STATUS_URL);
      const data = await res.json();
      if (res.ok && data.success) {
        setStatus(data.data as MicrosoftTodoStatus);
      } else {
        setStatus({ connected: false, cloudConnected: false });
        setError(data.hint || data.message || data.error || 'Failed to fetch Microsoft To Do status');
      }
    } catch {
      setStatus({ connected: false, cloudConnected: false });
      setError('Failed to fetch Microsoft To Do status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus().then(() => {
      try {
        const params = new URLSearchParams(window.location.search);
        const flag = params.get(RETURN_FLAG_PARAM);
        if (flag === 'connected') setNotice('Microsoft To Do connected.');
        else if (flag === 'error') setError(describeConnectFailure(params.get(RETURN_REASON_PARAM)));
      } catch {
        // window may be unavailable in tests; ignore
      }
    });
  }, [fetchStatus]);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const returnUrl = `${window.location.origin}${RETURN_PATH}`;
      const res = await fetch(`${CONNECT_URL_ENDPOINT}?returnUrl=${encodeURIComponent(returnUrl)}`);
      const data = await res.json();
      if (!res.ok || !data.success || !data.data?.url) {
        throw new Error(data.hint || data.message || data.error || 'Could not start Microsoft sign-in');
      }
      window.location.href = data.data.url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Microsoft sign-in');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Microsoft To Do? Agents will no longer be able to read or change your tasks.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(DISCONNECT_URL, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.hint || data.message || data.error || 'Disconnect failed');
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
        <LoadingSpinner text="Loading Microsoft To Do status..." />
      </div>
    );
  }

  const scopeLabels = describeMicrosoftScopes(status.scopes);
  const accountName = status.displayName ?? status.email ?? status.microsoftUserId ?? 'your Microsoft account';

  return (
    <div className="space-y-6 max-w-3xl" data-testid="microsoft-todo-tab">
      <div>
        <h2 className="text-xl font-semibold">Microsoft To Do</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Let agents read your task lists, add tasks with due dates, and tick them off or tidy them up. Works with
          personal Microsoft accounts (Outlook.com, Hotmail) and work or school accounts. Crewly Cloud keeps the
          Microsoft sign-in; your tasks go straight from Microsoft to this instance.
        </p>
      </div>

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {status.connected ? (
        <div className="space-y-6">
          <Alert variant="success">Connected as {accountName}</Alert>
          <Card padding="lg">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">Connection Details</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-border-dark">
                <span className="text-sm text-text-secondary-dark">Account</span>
                <span className="text-sm font-medium text-right" data-testid="microsoft-todo-account">
                  {status.displayName ?? '—'}
                  {status.email && <span className="block text-xs text-text-secondary-dark">{status.email}</span>}
                </span>
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
            <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw} disabled={busy}>Refresh Status</Button>
            <Button variant="danger" onClick={handleDisconnect} icon={Unlink} loading={busy}>Disconnect</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {status.cloudConnected ? (
            <>
              <Alert variant="warning">Microsoft To Do is not connected</Alert>
              <Card padding="lg">
                <p className="text-sm text-text-secondary-dark mb-4">
                  You will be sent to Microsoft to pick an account and approve access to your tasks, then brought
                  back here.
                </p>
                <Button variant="primary" onClick={handleConnect} icon={ExternalLink} loading={busy}>Connect Microsoft To Do</Button>
              </Card>
            </>
          ) : (
            <Alert variant="info">Sign in to Crewly Cloud first (Settings → Cloud), then connect Microsoft To Do here.</Alert>
          )}
        </div>
      )}
    </div>
  );
};

export default MicrosoftTodoTab;
