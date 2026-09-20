/**
 * GoogleWorkspaceTab Component
 *
 * The Google card on the Connections page. Crewly Cloud holds the grants;
 * this card shows which Google accounts are connected and what each one may
 * be used for, starts a consent for one product at a time, and disconnects.
 *
 * Two things shape it. Consent is **per product**: asking for Calendar must
 * not put "read all your mail" on the consent screen, and an install that
 * never touches mail or files stays out of Google's restricted scope tier.
 * And a Crewly account may connect **several Google accounts** — until
 * 2026-09-19 a second one silently overwrote the first.
 *
 * @module components/Settings/GoogleWorkspaceTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Unlink, ExternalLink, Plus, Star, ShieldAlert } from 'lucide-react';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Google product that can be connected on its own. */
export type GoogleProduct = 'gmail' | 'calendar' | 'drive';

/** One connected Google account. */
export interface GoogleConnection {
  email: string;
  products: GoogleProduct[];
  scopes: string[];
  grantedAt: string;
  isDefault: boolean;
}

/** `GET /api/google/status` payload. */
interface GoogleWorkspaceStatus {
  connected: boolean;
  cloudConnected: boolean;
  connections: GoogleConnection[];
  email?: string;
  scopes?: string[];
  grantedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_URL = '/api/google/status';
const CONNECT_URL_ENDPOINT = '/api/google/connect-url';
const DISCONNECT_URL = '/api/google/disconnect';
const DEFAULT_URL = '/api/google/default';

/** Where Cloud sends the browser back after consent. */
const RETURN_PATH = '/connections?platform=google-workspace';

/** Query flag Cloud appends on return (`?google=connected` / `?google=error`). */
const RETURN_FLAG_PARAM = 'google';

/** What each product is, in the order the card lists them. */
export const PRODUCT_META: { id: GoogleProduct; name: string; blurb: string; restricted: boolean }[] = [
  { id: 'gmail', name: 'Gmail', blurb: 'Read your mail and send on your behalf', restricted: true },
  { id: 'calendar', name: 'Calendar', blurb: 'Read your calendar and manage events', restricted: false },
  {
    id: 'drive',
    name: 'Drive, Docs, Sheets & Slides',
    blurb: 'Search and read your files, and create new ones',
    restricted: true,
  },
];

/** Human labels for the scope URLs Google grants. */
const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.readonly': 'Read mail',
  'https://www.googleapis.com/auth/gmail.send': 'Send mail',
  'https://www.googleapis.com/auth/calendar.readonly': 'Read calendar',
  'https://www.googleapis.com/auth/calendar.events': 'Manage events',
  'https://www.googleapis.com/auth/drive.readonly': 'Read Drive, Docs, Sheets, Slides',
  'https://www.googleapis.com/auth/drive.file': 'Create files (Docs, Sheets, Slides, uploads)',
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

/**
 * The products a connection has not got yet.
 *
 * @param connection - A connected Google account
 * @returns Products still available to add
 */
export function missingProducts(connection: GoogleConnection): typeof PRODUCT_META {
  return PRODUCT_META.filter((p) => !connection.products.includes(p.id));
}

/**
 * Build the connect-url request for one consent.
 *
 * @param origin - `window.location.origin`
 * @param options - Products to request and the Google account to sign in as
 * @returns The URL to fetch
 *
 * @example
 * buildConnectRequest('https://x', { products: ['calendar'], loginHint: 'a@b.com' })
 */
export function buildConnectRequest(
  origin: string,
  options: { products?: GoogleProduct[]; loginHint?: string; chooseAccount?: boolean } = {},
): string {
  const params = new URLSearchParams({ returnUrl: `${origin}${RETURN_PATH}` });
  if (options.products?.length) params.set('products', options.products.join(','));
  // A hint preselects an account; the chooser is how a *new* one gets added,
  // because Google otherwise reuses the session the browser is signed in to.
  if (options.loginHint) params.set('loginHint', options.loginHint);
  if (options.chooseAccount) params.set('chooseAccount', '1');
  return `${CONNECT_URL_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * GoogleWorkspaceTab — connected Google accounts, per-product consent.
 *
 * States: loading → not signed in to Cloud (explain) → nothing connected
 * (one button per product) → connected (per-account rows).
 *
 * @returns GoogleWorkspaceTab component
 */
export const GoogleWorkspaceTab: React.FC = () => {
  const [status, setStatus] = useState<GoogleWorkspaceStatus>({
    connected: false,
    cloudConnected: false,
    connections: [],
  });
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
        const payload = data.data as GoogleWorkspaceStatus;
        setStatus({ ...payload, connections: payload.connections ?? [] });
      } else {
        setStatus({ connected: false, cloudConnected: false, connections: [] });
        setError(data.hint || data.message || data.error || 'Failed to fetch Google status');
      }
    } catch {
      setStatus({ connected: false, cloudConnected: false, connections: [] });
      setError('Failed to fetch Google status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // Cloud lands back here with ?google=connected|error after consent.
    try {
      const flag = new URLSearchParams(window.location.search).get(RETURN_FLAG_PARAM);
      if (flag === 'connected') setNotice('Google account connected.');
      else if (flag === 'error') setError('Google connection failed. Please try again.');
    } catch {
      // window may be unavailable in tests; ignore
    }
  }, [fetchStatus]);

  /**
   * Start a consent for one product (and optionally one Google account).
   *
   * @param options - Products to ask for, and which account to sign in as
   */
  const startConnect = async (options: { products?: GoogleProduct[]; loginHint?: string; chooseAccount?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(buildConnectRequest(window.location.origin, options));
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
   * Revoke one Google account's grant.
   *
   * @param email - The account to disconnect
   */
  const handleDisconnect = async (email: string) => {
    if (!window.confirm(`Disconnect ${email}? Agents will lose every Google access granted by this account.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${DISCONNECT_URL}?account=${encodeURIComponent(email)}`, { method: 'DELETE' });
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

  /**
   * Choose which account answers a skill that names none.
   *
   * @param email - The account to make default
   */
  const handleMakeDefault = async (email: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(DEFAULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.hint || data.message || data.error || 'Could not change the default account');
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the default account');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner text="Loading Google status..." />
      </div>
    );
  }

  const { connections } = status;

  return (
    <div className="space-y-6 max-w-3xl" data-testid="google-workspace-tab">
      <div>
        <h2 className="text-xl font-semibold">Google</h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Connect each Google service separately, and as many Google accounts as you need. Crewly Cloud keeps
          the sign-in; content goes straight from Google to this instance.
        </p>
      </div>

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {!status.cloudConnected ? (
        <Alert variant="info">
          Sign in to Crewly Cloud first (Settings → Cloud), then connect Google here.
        </Alert>
      ) : connections.length === 0 ? (
        <Card padding="lg">
          <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-1">
            Choose what agents may use
          </h3>
          <p className="text-sm text-text-secondary-dark mb-4">
            Each one is a separate approval — connect only what you need, and add the others later.
          </p>
          <div className="space-y-3">
            {PRODUCT_META.map((product) => (
              <div
                key={product.id}
                className="flex items-center justify-between gap-4 py-3 border-b border-border-dark last:border-0"
              >
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    {product.name}
                    {product.restricted && (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-text-secondary-dark"
                        title="Google treats these as restricted scopes: outside users see an 'unverified app' notice until the app passes Google's review."
                      >
                        <ShieldAlert size={12} /> restricted
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-secondary-dark mt-0.5">{product.blurb}</div>
                </div>
                <Button
                  variant="primary"
                  icon={ExternalLink}
                  disabled={busy}
                  onClick={() => startConnect({ products: [product.id] })}
                  data-testid={`google-connect-${product.id}`}
                >
                  Connect
                </Button>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {connections.map((connection) => (
            <Card key={connection.email} padding="lg" data-testid={`google-account-${connection.email}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                    <span className="truncate">{connection.email}</span>
                    {connection.isDefault && (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-text-secondary-dark"
                        title="Used when a skill or agent does not name an account."
                      >
                        <Star size={12} /> default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-secondary-dark mt-1">
                    {connection.products.length > 0
                      ? PRODUCT_META.filter((p) => connection.products.includes(p.id))
                          .map((p) => p.name)
                          .join(' · ')
                      : 'Signed in, but no service connected yet'}
                  </div>
                  {connection.grantedAt && (
                    <div className="text-xs text-text-secondary-dark mt-1">
                      Connected {new Date(connection.grantedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!connection.isDefault && (
                    <Button variant="secondary" disabled={busy} onClick={() => handleMakeDefault(connection.email)}>
                      Make default
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    icon={Unlink}
                    disabled={busy}
                    onClick={() => handleDisconnect(connection.email)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>

              {missingProducts(connection).length > 0 && (
                <div className="mt-4 pt-3 border-t border-border-dark flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-text-secondary-dark">Add:</span>
                  {missingProducts(connection).map((product) => (
                    <Button
                      key={product.id}
                      variant="secondary"
                      icon={Plus}
                      disabled={busy}
                      onClick={() => startConnect({ products: [product.id], loginHint: connection.email })}
                      data-testid={`google-add-${product.id}-${connection.email}`}
                    >
                      {product.name}
                    </Button>
                  ))}
                </div>
              )}
            </Card>
          ))}

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              icon={Plus}
              disabled={busy}
              onClick={() => startConnect({ chooseAccount: true })}
              data-testid="google-add-account"
            >
              Add another Google account
            </Button>
            <Button variant="secondary" onClick={fetchStatus} icon={RefreshCw} disabled={busy}>
              Refresh
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GoogleWorkspaceTab;
