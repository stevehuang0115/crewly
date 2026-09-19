/**
 * CanvaTab Component
 *
 * Canva connection card in Settings → Integrations. Crewly Cloud holds
 * the owner's Canva grant; this card shows the connected account, opens
 * the Cloud consent flow, and disconnects.
 *
 * @module components/Settings/CanvaTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, ExternalLink } from 'lucide-react';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';

/** `GET /api/canva/status` payload. */
interface CanvaStatus {
  connected: boolean;
  cloudConnected: boolean;
  canvaUserId?: string;
  canvaTeamId?: string;
  displayName?: string;
  scopes?: string[];
  grantedAt?: string;
}

const STATUS_URL = '/api/canva/status';
const CONNECT_URL_ENDPOINT = '/api/canva/connect-url';
const DISCONNECT_URL = '/api/canva/disconnect';
/** Where Cloud sends the browser back after consent. */
const RETURN_PATH = '/connections?platform=canva';
/** Query flag Cloud appends on return (`?canva=connected` / `?canva=error`). */
const RETURN_FLAG_PARAM = 'canva';

/** Human labels for Canva scopes. */
const SCOPE_LABELS: Record<string, string> = {
  'design:meta:read': 'List designs',
  'design:content:read': 'Export designs',
  'design:content:write': 'Create designs',
  'asset:read': 'Read assets',
  'asset:write': 'Upload assets',
  'folder:read': 'Browse folders',
};

/**
 * Turn Canva scopes into short labels, dropping identity scopes.
 *
 * @param scopes - Scope names
 * @returns Labels for the known ones
 */
export function describeCanvaScopes(scopes: string[] | undefined): string[] {
  return (scopes ?? []).map((s) => SCOPE_LABELS[s]).filter((s): s is string => !!s);
}

/**
 * CanvaTab — connected account / Connect / Disconnect.
 *
 * @returns CanvaTab component
 */
export const CanvaTab: React.FC = () => {
  const [status, setStatus] = useState<CanvaStatus>({ connected: false, cloudConnected: false });
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
        setStatus(data.data as CanvaStatus);
      } else {
        setStatus({ connected: false, cloudConnected: false });
        setError(data.hint || data.message || data.error || 'Failed to fetch Canva status');
      }
    } catch {
      setStatus({ connected: false, cloudConnected: false });
      setError('Failed to fetch Canva status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    try {
      const flag = new URLSearchParams(window.location.search).get(RETURN_FLAG_PARAM);
      if (flag === 'connected') setNotice('Canva connected.');
      else if (flag === 'error') setError('Canva connection failed. Please try again.');
    } catch {
      // window may be unavailable in tests; ignore
    }
  }, [fetchStatus]);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const returnUrl = `${window.location.origin}${RETURN_PATH}`;
      const res = await fetch(`${CONNECT_URL_ENDPOINT}?returnUrl=${encodeURIComponent(returnUrl)}`);
      const data = await res.json();
      if (!res.ok || !data.success || !data.data?.url) {
        throw new Error(data.hint || data.message || data.error || 'Could not start Canva sign-in');
      }
      window.location.href = data.data.url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Canva sign-in');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Canva? Agents will no longer be able to list, create or export designs.')) return;
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
        <LoadingSpinner text="Loading Canva status..." />
      </div>
    );
  }

  const scopeLabels = describeCanvaScopes(status.scopes);

  return (
    <div className="space-y-6 max-w-3xl" data-testid="canva-tab">
      <div>
        <h2 className="text-xl font-semibold">Canva</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Let agents find your Canva designs, create new ones (posters, stories, decks), upload images and
          videos, and export finished designs to PDF, PNG or MP4. Crewly Cloud keeps the Canva sign-in;
          design files go straight from Canva to this instance.
        </p>
      </div>

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {status.connected ? (
        <div className="space-y-6">
          <Alert variant="success">Connected as {status.displayName ?? status.canvaUserId ?? 'your Canva account'}</Alert>
          <Card padding="lg">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-4">Connection Details</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-border-dark">
                <span className="text-sm text-text-secondary-dark">Account</span>
                <span className="text-sm font-medium" data-testid="canva-account">{status.displayName ?? status.canvaUserId ?? '—'}</span>
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
              <Alert variant="warning">Canva is not connected</Alert>
              <Card padding="lg">
                <p className="text-sm text-text-secondary-dark mb-4">
                  You will be sent to Canva to approve access for your account, then brought back here.
                </p>
                <Button variant="primary" onClick={handleConnect} icon={ExternalLink} loading={busy}>Connect Canva</Button>
              </Card>
            </>
          ) : (
            <Alert variant="info">Sign in to Crewly Cloud first (Settings → Cloud), then connect Canva here.</Alert>
          )}
        </div>
      )}
    </div>
  );
};

export default CanvaTab;
