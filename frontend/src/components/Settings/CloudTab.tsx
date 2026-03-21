/**
 * CloudTab Component
 *
 * CrewlyAI Cloud connection management in Settings.
 * Allows users to sign in to CrewlyAI Cloud via OAuth to access
 * Pro features like device sync and relay connections.
 * Shows connected devices when authenticated.
 *
 * Uses the backend `/api/cloud/status` endpoint as the source of truth
 * for connection state, and optionally enriches with user profile from
 * localStorage token validation.
 *
 * @module components/Settings/CloudTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, LogOut, RefreshCw, Check, ExternalLink, Zap, Monitor, Cpu, Wifi, UserPlus, Link2 } from 'lucide-react';
import { CLOUD_TOKEN_KEY, buildCloudAuthRedirectUrl } from '../../constants/cloud.constants';
import { InviteDeviceModal } from './InviteDeviceModal';
import { JoinRelayModal } from './JoinRelayModal';

/**
 * Cloud API validation endpoint — proxied through the local OSS backend
 * to avoid CORS issues when validating tokens against api.crewlyai.com.
 */
const CLOUD_VALIDATE_URL = '/api/cloud/validate';

/** Backend cloud status endpoint — source of truth for connection state. */
const CLOUD_STATUS_URL = '/api/cloud/status';

/** Cloud devices endpoint — reads from CloudSyncService or falls back to legacy proxy. */
const CLOUD_DEVICES_URL = '/api/cloud/devices';

/** Legacy cloud devices endpoint — used as fallback when new endpoint returns empty. */
const LEGACY_CLOUD_DEVICES_URL = '/api/relay/cloud-devices';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cloud user profile from validation response. */
interface CloudUser {
  id: string;
  email: string;
  plan: string;
  name?: string;
  avatar?: string;
}

/** A device returned by the Cloud devices API. */
interface CloudDevice {
  sessionId?: string;
  role?: 'orchestrator' | 'agent';
  state?: 'waiting' | 'paired' | 'disconnected';
  pairedWith?: string | null;
  registeredAt?: string;
  lastHeartbeatAt?: string;
  name?: string;
  deviceName?: string;
  deviceId?: string;
  isLocal?: boolean;
  /** Cloud Sync fields */
  status?: 'online' | 'offline';
  capabilities?: string[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp to a human-readable relative time string.
 *
 * @param iso - ISO timestamp string
 * @returns Relative time string (e.g., "2 分钟前")
 */
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/** Map device state to status label (supports both legacy relay and cloud sync). */
const DEVICE_STATE_LABELS: Record<string, string> = {
  waiting: 'Connecting',
  paired: 'Connected',
  disconnected: 'Offline',
  online: 'Online',
  offline: 'Offline',
};

/** Map device state to dot color CSS class (supports both legacy relay and cloud sync). */
const DEVICE_STATE_COLORS: Record<string, string> = {
  waiting: 'bg-yellow-400',
  paired: 'bg-emerald-400',
  disconnected: 'bg-gray-500',
  online: 'bg-emerald-400',
  offline: 'bg-gray-500',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Individual device card in the device list.
 *
 * @param props - Device and isLocal flag
 * @returns DeviceCard component
 */
const DeviceCard: React.FC<{ device: CloudDevice }> = ({ device }) => {
  const Icon = device.role === 'orchestrator' ? Monitor : Cpu;
  // Prefer cloud sync 'status' over legacy 'state'
  const deviceStatus = device.status || device.state || 'disconnected';
  const stateColor = DEVICE_STATE_COLORS[deviceStatus] ?? 'bg-gray-500';
  const stateLabel = DEVICE_STATE_LABELS[deviceStatus] ?? deviceStatus;
  const displayName = device.name || device.deviceName || (device.sessionId ? `${device.role || 'device'} (${device.sessionId.slice(0, 8)}...)` : device.deviceId || 'Unknown');

  return (
    <div
      data-testid={`cloud-device-${device.sessionId || device.deviceId}`}
      className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
        device.isLocal
          ? 'border-primary/30 bg-primary/5'
          : 'border-border-dark bg-background-dark hover:border-border-dark/80'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={`p-1.5 rounded-md ${device.isLocal ? 'bg-primary/10' : 'bg-surface-dark'}`}>
          <Icon className={`w-4 h-4 ${device.isLocal ? 'text-primary' : 'text-text-secondary-dark'}`} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary-dark truncate">
              {displayName}
            </span>
            {device.isLocal && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">
                This machine
              </span>
            )}
          </div>
          <span className="text-xs text-text-secondary-dark">
            {device.lastHeartbeatAt ? `Last seen: ${formatRelativeTime(device.lastHeartbeatAt)}` : `Registered: ${formatRelativeTime(device.registeredAt)}`}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 ml-3 whitespace-nowrap">
        <span className={`h-2 w-2 rounded-full ${stateColor}`} />
        <span className="text-xs text-text-secondary-dark">{stateLabel}</span>
      </div>
    </div>
  );
};

/**
 * Device list section shown when the user is connected to Cloud.
 *
 * @param props - Component props
 * @returns DeviceListSection component
 */
const DeviceListSection: React.FC = () => {
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [syncState, setSyncState] = useState<string | null>(null);

  /** Fetch devices from the new CloudSync endpoint, with fallback to legacy. */
  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setTokenExpired(false);
      setSyncState(null);

      const res = await fetch(CLOUD_DEVICES_URL);
      const data = await res.json();

      if (res.ok && data.success && data.data) {
        if (data.data.syncState) {
          setSyncState(data.data.syncState);
        }

        if (data.data.devices && data.data.devices.length > 0) {
          setDevices(data.data.devices);
          if (data.data.tokenExpired) {
            setTokenExpired(true);
          }
          return;
        }

        // New endpoint returned empty and sync is not active — try legacy endpoint
        if (!data.data.syncState || data.data.syncState === 'stopped') {
          try {
            const legacyRes = await fetch(LEGACY_CLOUD_DEVICES_URL);
            const legacyData = await legacyRes.json();
            if (legacyRes.ok && legacyData.success && legacyData.data?.devices) {
              setDevices(legacyData.data.devices);
              if (legacyData.data.tokenExpired) {
                setTokenExpired(true);
              }
              return;
            }
          } catch {
            // Legacy fallback failed — use whatever the new endpoint returned
          }
        }

        setDevices(data.data.devices || []);
        if (data.data.tokenExpired) {
          setTokenExpired(true);
        }
      } else {
        setError(data.error || 'Failed to load devices');
      }
    } catch {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Fetch on mount. */
  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  return (
    <div className="bg-surface-dark border border-border-dark rounded-lg p-5 space-y-3" data-testid="cloud-device-list-section">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-text-secondary-dark" />
          <h3 className="text-sm font-semibold text-text-primary-dark">Connected Devices</h3>
          <span className="text-xs text-text-secondary-dark">
            ({devices.length})
          </span>
          {syncState && (
            <span
              data-testid="sync-state-badge"
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                syncState === 'syncing'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : syncState === 'error'
                  ? 'bg-rose-500/10 text-rose-400'
                  : 'bg-gray-500/10 text-gray-400'
              }`}
            >
              {syncState === 'syncing' ? 'Sync Active' : syncState === 'error' ? 'Sync Error' : 'Sync Off'}
            </span>
          )}
        </div>
        <button
          onClick={fetchDevices}
          disabled={loading}
          className="p-1.5 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors disabled:opacity-50"
          aria-label="Refresh devices"
          data-testid="refresh-devices-button"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {tokenExpired && !error && (
        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2" data-testid="token-expired-warning">
          Cloud session expired. Please disconnect and sign in again to refresh your token.
        </div>
      )}

      {!loading && !error && !tokenExpired && devices.length === 0 && (
        <div className="text-center py-6">
          <Monitor className="w-8 h-8 text-text-secondary-dark/30 mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark">No devices connected yet</p>
          <p className="text-[11px] text-text-secondary-dark/60 mt-0.5">
            Connect from another machine using <code className="text-primary/80">crewly cloud connect</code>
          </p>
        </div>
      )}

      {devices.length > 0 && (
        <div className="space-y-2">
          {devices.map((device) => (
            <DeviceCard key={device.sessionId || device.deviceId || Math.random().toString()} device={device} />
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Cloud connection tab for Settings page.
 *
 * Shows "Sign in with CrewlyAI" when disconnected, or connection
 * status with user info and device list when connected.
 *
 * @returns CloudTab component
 */
export const CloudTab: React.FC = () => {
  const [user, setUser] = useState<CloudUser | null>(null);
  /** Whether the backend reports a cloud connection (source of truth). */
  const [backendConnected, setBackendConnected] = useState(false);
  /** Subscription tier from the backend status. */
  const [backendTier, setBackendTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

  /**
   * Check backend cloud status — the authoritative source of truth.
   *
   * The backend CloudClientService tracks the actual connection state.
   * Cloud connections made via CLI or auto-reconnect are reflected here
   * even when the browser localStorage has no token.
   *
   * @returns Whether the backend reports an active connection
   */
  const checkBackendStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(CLOUD_STATUS_URL);
      const data = await res.json();
      if (res.ok && data.success && data.data) {
        const status = data.data;
        const isConnected = status.connectionStatus === 'connected';
        setBackendConnected(isConnected);
        if (isConnected) {
          setBackendTier(status.tier ?? null);
        }
        return isConnected;
      }
    } catch {
      // Backend unreachable — fall through to localStorage check
    }
    setBackendConnected(false);
    setBackendTier(null);
    return false;
  }, []);

  /**
   * Validate the stored cloud token and fetch user info.
   *
   * If the backend reports connected but localStorage has no token,
   * the component still shows the connected state (from backend).
   * The user profile is only populated when a localStorage token
   * can be validated.
   */
  const validateToken = useCallback(async () => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(CLOUD_VALIDATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (res.ok && data.success && data.data) {
        setUser({
          id: data.data.id,
          email: data.data.email,
          plan: data.data.plan,
          name: data.data.name,
          avatar: data.data.avatar,
        });
        setError(null);
      } else {
        // Invalid token — clear it
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        setUser(null);
      }
    } catch {
      // Connection failed — keep token but show error
      setError('Could not reach CrewlyAI Cloud. Check your internet connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Initialize connection state: check backend first, then validate token.
   */
  useEffect(() => {
    const init = async () => {
      await checkBackendStatus();
      await validateToken();
    };
    init();
  }, [checkBackendStatus, validateToken]);

  /**
   * Start the OAuth sign-in flow via crewlyai.com/cloud/auth.
   * After login, the user is redirected back to this OSS instance with a JWT token.
   */
  const handleSignIn = () => {
    const callbackUrl = `${window.location.origin}/auth/callback`;
    window.location.href = buildCloudAuthRedirectUrl(callbackUrl);
  };

  /**
   * Store token via the OSS backend connect endpoint.
   * Includes the refresh token from localStorage so the backend can
   * persist it for auto-renewal after access token expiry.
   */
  const handleStoreToken = useCallback(async (token: string) => {
    try {
      const refreshToken = localStorage.getItem('crewly_refresh_token') || undefined;
      await fetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...(refreshToken && { refreshToken }) }),
      });
    } catch {
      // Best-effort — the token is already stored in localStorage
    }
  }, []);

  /** Store token in OSS backend when user connects. */
  useEffect(() => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (token && user) {
      handleStoreToken(token);
    }
  }, [user, handleStoreToken]);

  /**
   * Disconnect from CrewlyAI Cloud.
   * Clears both the localStorage token and the backend connection.
   */
  const handleDisconnect = async () => {
    localStorage.removeItem(CLOUD_TOKEN_KEY);
    setUser(null);
    setBackendConnected(false);
    setBackendTier(null);
    setError(null);

    // Also disconnect on the backend
    try {
      await fetch('/api/cloud/disconnect', { method: 'POST' });
    } catch {
      // Best-effort — local state is already cleared
    }
  };

  /**
   * Get plan badge color class.
   */
  const getPlanBadgeClass = (plan: string): string => {
    switch (plan) {
      case 'pro': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
      case 'enterprise': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/30';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary-dark flex items-center gap-2">
          <Cloud className="w-5 h-5" />
          CrewlyAI Cloud
        </h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Connect to CrewlyAI Cloud for device sync, remote access, and Pro features.
        </p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Connected State — show when backend reports connected OR user profile is validated */}
      {(user || backendConnected) ? (
        <>
          <div className="bg-surface-dark border border-border-dark rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
                  {user?.avatar ? (
                    <img
                      src={user.avatar}
                      alt={user.name || user.email}
                      className="w-10 h-10 rounded-full"
                    />
                  ) : (
                    <Cloud className="w-5 h-5 text-primary" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary-dark">
                      {user ? (user.name || user.email) : 'CrewlyAI Cloud'}
                    </span>
                    <Check className="w-4 h-4 text-emerald-400" />
                  </div>
                  <span className="text-xs text-text-secondary-dark">
                    {user ? user.email : 'Connected via backend'}
                  </span>
                </div>
              </div>

              <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getPlanBadgeClass(user?.plan ?? backendTier ?? 'free')}`}>
                {(user?.plan ?? backendTier ?? 'free').charAt(0).toUpperCase() + (user?.plan ?? backendTier ?? 'free').slice(1)}
              </span>
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-border-dark">
              <button
                onClick={async () => { await checkBackendStatus(); await validateToken(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-rose-400 rounded-md hover:bg-background-dark transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Disconnect
              </button>
            </div>
          </div>

          {/* Relay Pairing Buttons */}
          <div className="flex items-center gap-2" data-testid="relay-pairing-buttons">
            <button
              onClick={() => setShowInviteModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-primary-dark bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
              data-testid="invite-device-button"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Invite Device
            </button>
            <button
              onClick={() => setShowJoinModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-primary-dark bg-surface-dark border border-border-dark rounded-lg hover:bg-background-dark transition-colors"
              data-testid="join-relay-button"
            >
              <Link2 className="w-3.5 h-3.5" />
              Join Relay
            </button>
          </div>

          {/* Device Discovery List */}
          <DeviceListSection />

          {/* Modals */}
          <InviteDeviceModal isOpen={showInviteModal} onClose={() => setShowInviteModal(false)} />
          <JoinRelayModal isOpen={showJoinModal} onClose={() => setShowJoinModal(false)} />
        </>
      ) : (
        /* Disconnected State */
        <div className="bg-surface-dark border border-border-dark rounded-lg p-6 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-text-primary-dark">
              Connect to CrewlyAI Cloud
            </h3>
            <p className="text-xs text-text-secondary-dark mt-1 max-w-sm mx-auto">
              Sign in with your CrewlyAI account to enable device sync,
              remote team access, and Pro features.
            </p>
          </div>

          <button
            onClick={handleSignIn}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors"
            data-testid="cloud-sign-in-button"
          >
            <ExternalLink className="w-4 h-4" />
            Sign in with CrewlyAI
          </button>
        </div>
      )}
    </div>
  );
};

export default CloudTab;
