/**
 * Cloud Portal Page
 *
 * The single, self-contained page for all CrewlyAI Cloud management.
 * Handles login/logout (connect/disconnect), connection status with tier badge,
 * connected devices list, refresh, and team deployment.
 *
 * When disconnected: Shows "Connect to Cloud" with sign-in button.
 * When connected: Shows user info, tier, connected devices, disconnect button,
 * and (for paid tiers) the team deployment wizard.
 *
 * Uses the backend `/api/cloud/status` endpoint as the source of truth
 * for connection status and tier.
 *
 * @module pages/CloudPortal
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Cloud,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MessageSquare,
  Server,
  Globe,
  LogOut,
  RefreshCw,
  Check,
  ExternalLink,
  Zap,
  Monitor,
  Cpu,
  Wifi,
} from 'lucide-react';
import { Button } from '../components/UI';
import { Card } from '../components/UI/Card';
import { Alert } from '../components/UI/Alert';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import { formatRelativeTimeCompact } from '../utils/time';
import { getInstanceStatus, type BrowserInstanceStatus } from '../utils/browser-instance-status';
import { CLOUD_TOKEN_KEY, buildCloudAuthRedirectUrl } from '../constants/cloud.constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deployment status phases */
type DeployPhase =
  | 'idle'
  | 'configuring'
  | 'deploying'
  | 'ready'
  | 'error';

/** A single deployment record */
interface Deployment {
  deploymentId: string;
  currentPhase: string;
  success: boolean;
  ipAddress?: string;
  dropletId?: number;
  error?: string;
}

/** Subscription info from the payment API */
interface SubscriptionInfo {
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
}

/** Cloud user profile from token validation. */
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
  status?: 'online' | 'offline';
  capabilities?: string[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cloud token validation endpoint (proxied through OSS backend). */
const CLOUD_VALIDATE_URL = '/api/cloud/validate';

/** Backend cloud status endpoint -- source of truth for connection state. */
const CLOUD_STATUS_URL = '/api/cloud/status';

/** Cloud devices endpoint. */
const CLOUD_DEVICES_URL = '/api/cloud/devices';

/** Legacy cloud devices endpoint -- fallback. */
const LEGACY_CLOUD_DEVICES_URL = '/api/relay/cloud-devices';

/** Default region for new deployments */
const DEFAULT_REGION = 'sfo3';

/** Default droplet size */
const DEFAULT_SIZE = 's-2vcpu-4gb';

/** Polling interval for deployment status (ms) */
const STATUS_POLL_INTERVAL = 5000;

/** Max polling duration before timeout (ms) */
const MAX_POLL_DURATION = 600000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map device state to status label. */
const DEVICE_STATE_LABELS: Record<string, string> = {
  waiting: 'Connecting',
  paired: 'Connected',
  disconnected: 'Offline',
  online: 'Online',
  offline: 'Offline',
};

/** Map device state to dot color CSS class. */
const DEVICE_STATE_COLORS: Record<string, string> = {
  waiting: 'bg-yellow-400',
  paired: 'bg-emerald-400',
  disconnected: 'bg-gray-500',
  online: 'bg-emerald-400',
  offline: 'bg-gray-500',
};

/**
 * Deduplicate devices by deviceId (or sessionId fallback).
 *
 * Keeps the entry with the most recent heartbeat and prefers online devices.
 *
 * @param devices - Raw device list from the API
 * @returns Deduplicated device list
 */
function deduplicateDevices(devices: CloudDevice[]): CloudDevice[] {
  const seen = new Map<string, CloudDevice>();
  for (const device of devices) {
    const key = device.deviceId || device.sessionId;
    if (!key) {
      seen.set(`__unkeyed_${seen.size}`, device);
      continue;
    }
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, device);
    } else {
      const existingTime = new Date(existing.lastHeartbeatAt || existing.registeredAt || '0').getTime();
      const newTime = new Date(device.lastHeartbeatAt || device.registeredAt || '0').getTime();
      const existingIsOnline = existing.status === 'online' || existing.state === 'paired' || existing.state === 'waiting';
      const newIsOnline = device.status === 'online' || device.state === 'paired' || device.state === 'waiting';
      if (newTime > existingTime || (newIsOnline && !existingIsOnline)) {
        seen.set(key, device);
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Get plan badge color class.
 *
 * @param plan - Plan name string
 * @returns Tailwind CSS class string for the badge
 */
const getPlanBadgeClass = (plan: string): string => {
  switch (plan) {
    case 'pro': return 'bg-primary/10 text-primary border-primary/30';
    case 'enterprise': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
    default: return 'bg-gray-500/10 text-gray-400 border-gray-500/30';
  }
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Individual device card in the device list.
 *
 * @param props.device - The cloud device to display
 * @returns DeviceCard component
 */
const DeviceCard: React.FC<{ device: CloudDevice }> = ({ device }) => {
  const Icon = device.role === 'orchestrator' ? Monitor : Cpu;
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
            {device.lastHeartbeatAt ? `Last seen: ${formatRelativeTimeCompact(device.lastHeartbeatAt)}` : `Registered: ${formatRelativeTimeCompact(device.registeredAt)}`}
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
 * Device list section shown when connected to Cloud.
 *
 * @returns DeviceListSection component
 */
const DeviceListSection: React.FC = () => {
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [syncState, setSyncState] = useState<string | null>(null);

  /** Fetch devices from CloudSync endpoint with legacy fallback. */
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

        // New endpoint returned empty and sync is not active -- try legacy
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
            // Legacy fallback failed
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

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const uniqueDevices = useMemo(() => deduplicateDevices(devices), [devices]);

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl p-6 space-y-3" data-testid="cloud-device-list-section">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Connected Devices</h3>
          <span className="text-xs text-text-secondary-dark">
            ({uniqueDevices.length})
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
        <Alert variant="error" className="text-xs">
          {error}
        </Alert>
      )}

      {tokenExpired && !error && (
        <Alert variant="warning" className="text-xs" data-testid="token-expired-warning">
          Cloud session expired. Please disconnect and sign in again to refresh your token.
        </Alert>
      )}

      {!loading && !error && !tokenExpired && uniqueDevices.length === 0 && (
        <div className="text-center py-6">
          <Monitor className="w-8 h-8 text-text-secondary-dark/30 mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark">No devices connected yet</p>
          <p className="text-[11px] text-text-secondary-dark/60 mt-0.5">
            Connect from another machine using <code className="text-primary/80">crewly cloud connect</code>
          </p>
        </div>
      )}

      {uniqueDevices.length > 0 && (
        <div className="space-y-2">
          {uniqueDevices.map((device) => (
            <DeviceCard key={device.deviceId || device.sessionId || device.name || device.deviceName} device={device} />
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
 * Cloud Portal page component.
 *
 * Self-contained Cloud management page that handles:
 * - Connection/disconnection (OAuth sign-in flow)
 * - Connection status with tier badge
 * - User profile display
 * - Connected devices list with refresh
 * - Team deployment wizard (for paid tiers)
 *
 * @returns The Cloud Portal page element
 */

// ---------------------------------------------------------------------------
// Browser Extensions Section — shows Crewly in Chrome instances via Cloud Relay
// ---------------------------------------------------------------------------

interface BrowserInstance {
  instanceId: string;
  instanceName: string;
  sessionId?: string;
  lastSeenAt?: string;
}

/**
 * Visual styling for each browser-instance status — co-located with the
 * status helper so adding a new status requires touching exactly one map.
 */
const BROWSER_INSTANCE_STATUS_STYLES: Record<
  BrowserInstanceStatus,
  { textClass: string; dotClass: string; label: string }
> = {
  online: {
    textClass: 'text-emerald-400',
    dotClass: 'bg-emerald-400',
    label: 'Online',
  },
  stale: {
    textClass: 'text-amber-400',
    dotClass: 'bg-amber-400',
    label: 'Stale',
  },
  offline: {
    textClass: 'text-text-secondary-dark',
    dotClass: 'bg-gray-500',
    label: 'Offline',
  },
};

/**
 * Render a small colored pill (dot + label) for a browser-extension instance
 * based on its threshold-derived status.
 *
 * @param status - One of `'online' | 'stale' | 'offline'`.
 * @returns A `<span>` with the appropriate color and label.
 */
const BrowserInstanceStatusBadge: React.FC<{ status: BrowserInstanceStatus }> = ({
  status,
}) => {
  const style = BROWSER_INSTANCE_STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${style.textClass}`}
      data-testid={`browser-instance-status-${status}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dotClass}`} />
      {style.label}
    </span>
  );
};

const BrowserExtensionsSection: React.FC = () => {
  const [instances, setInstances] = useState<BrowserInstance[]>([]);
  const [proxyConnected, setProxyConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchInstances = useCallback(async () => {
    try {
      const resp = await fetch('/api/browser/instances');
      if (resp.ok) {
        const data = await resp.json();
        setInstances(data.instances || []);
        setProxyConnected(data.proxyConnected || false);
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstances();
    const interval = setInterval(fetchInstances, 15000);
    return () => clearInterval(interval);
  }, [fetchInstances]);

  return (
    <div
      className="rounded-xl border border-border-dark bg-surface-dark p-5"
      data-testid="browser-extensions-section"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-text-secondary-dark" />
          <h3 className="text-sm font-semibold text-text-primary-dark">
            Browser Extensions
          </h3>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
            proxyConnected
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-amber-500/10 text-amber-400'
          }`}>
            {proxyConnected ? 'Relay Connected' : 'Relay Offline'}
          </span>
        </div>
        <button
          onClick={() => { setLoading(true); fetchInstances(); }}
          className="text-text-secondary-dark hover:text-text-primary-dark p-1 rounded hover:bg-background-dark transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-text-secondary-dark py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs">Loading...</span>
        </div>
      ) : instances.length === 0 ? (
        <div className="text-center py-6">
          <Monitor className="h-8 w-8 text-text-secondary-dark mx-auto mb-2 opacity-40" />
          <p className="text-xs text-text-secondary-dark">
            No browser extensions connected
          </p>
          <p className="text-[10px] text-text-secondary-dark mt-1 opacity-60">
            Install Crewly in Chrome and sign in to connect
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {instances.map((inst) => (
            <div
              key={inst.instanceId}
              className="flex items-center justify-between rounded-lg border border-border-dark bg-background-dark px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-indigo-500/10">
                  <Globe className="h-4 w-4 text-indigo-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary-dark">
                    {inst.instanceName}
                  </p>
                  <p className="text-[10px] text-text-secondary-dark font-mono">
                    {inst.instanceId.slice(0, 8)}...
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <BrowserInstanceStatusBadge status={getInstanceStatus(inst.lastSeenAt)} />
                {inst.lastSeenAt && (
                  <span className="text-[10px] text-text-secondary-dark">
                    Last seen: {formatRelativeTimeCompact(inst.lastSeenAt)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const CloudPortal: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { license, user } = useAuth();
  const justUpgraded = searchParams.get('upgraded') === 'true';

  // -- Cloud connection state (from backend -- source of truth) --
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendTier, setBackendTier] = useState<string | null>(null);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // -- Cloud user profile (from token validation) --
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);

  // -- Subscription --
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(true);

  // -- Deployments --
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(true);

  // -- Deploy wizard --
  const [deployPhase, setDeployPhase] = useState<DeployPhase>('idle');
  const [teamName, setTeamName] = useState('');
  const [deployError, setDeployError] = useState<string | null>(null);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Check backend cloud status -- authoritative source of truth
  // -----------------------------------------------------------------------

  const checkBackendStatus = useCallback(async () => {
    try {
      const res = await fetch(CLOUD_STATUS_URL);
      const data = await res.json();
      if (res.ok && data.success && data.data) {
        const status = data.data;
        const isConnected = status.connectionStatus === 'connected';
        setBackendConnected(isConnected);
        setCloudUrl(status.cloudUrl ?? null);
        if (isConnected) {
          setBackendTier(status.tier ?? null);
        } else {
          setBackendTier(null);
        }
        return isConnected;
      }
    } catch {
      // Backend unreachable
    }
    setBackendConnected(false);
    setBackendTier(null);
    setCloudUrl(null);
    return false;
  }, []);

  // -----------------------------------------------------------------------
  // Validate stored cloud token and fetch user profile
  // -----------------------------------------------------------------------

  const validateToken = useCallback(async () => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) return;

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
        setCloudUser({
          id: data.data.id,
          email: data.data.email,
          plan: data.data.plan,
          name: data.data.name,
          avatar: data.data.avatar,
        });
        setConnectionError(null);
      } else {
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        setCloudUser(null);
      }
    } catch {
      setConnectionError('Could not reach CrewlyAI Cloud. Check your internet connection.');
    }
  }, []);

  // -----------------------------------------------------------------------
  // Store token in OSS backend for auto-renewal
  // -----------------------------------------------------------------------

  const storeTokenInBackend = useCallback(async (token: string) => {
    try {
      const refreshToken = localStorage.getItem('crewly_refresh_token') || undefined;
      await fetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...(refreshToken && { refreshToken }) }),
      });
    } catch {
      // Best-effort
    }
  }, []);

  // -----------------------------------------------------------------------
  // Initialize: check backend status, validate token, load data
  // -----------------------------------------------------------------------

  useEffect(() => {
    const init = async () => {
      await checkBackendStatus();
      await validateToken();
      setConnectionLoading(false);
    };
    init();
  }, [checkBackendStatus, validateToken]);

  /** Store token in backend when user connects. */
  useEffect(() => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (token && cloudUser) {
      storeTokenInBackend(token);
    }
  }, [cloudUser, storeTokenInBackend]);

  /** Load subscription info. */
  useEffect(() => {
    const loadSubscription = async () => {
      try {
        const sub = await apiService.getSubscription();
        setSubscription(sub);
      } catch {
        setSubscription(null);
      } finally {
        setSubLoading(false);
      }
    };
    loadSubscription();
  }, []);

  /** Load deployments. */
  useEffect(() => {
    const loadDeployments = async () => {
      try {
        const result = await apiService.listDeployments({ customerId: user?.id });
        setDeployments(result.deployments as Deployment[]);
      } catch {
        setDeployments([]);
      } finally {
        setDeploymentsLoading(false);
      }
    };
    loadDeployments();
  }, [user?.id]);

  // -----------------------------------------------------------------------
  // Auth actions
  // -----------------------------------------------------------------------

  /**
   * Start the OAuth sign-in flow via the Cloud auth service's direct callback.
   * Uses the CLI-style flow: auth service exchanges code server-side and redirects
   * back with ?token=&refreshToken= (bypasses crewlyai.com web frontend caching issues).
   */
  const handleSignIn = () => {
    const callbackUrl = `${window.location.origin}/auth/callback`;
    // Direct flow: auth service GET /google/start?redirect=<callback>
    // Server-side code exchange ensures refreshToken is always included
    window.location.href = `https://api.crewlyai.com/api/cloud/google/start?redirect=${encodeURIComponent(callbackUrl)}`;
  };

  /**
   * Disconnect from CrewlyAI Cloud. Clears both localStorage and backend.
   */
  const handleDisconnect = async () => {
    localStorage.removeItem(CLOUD_TOKEN_KEY);
    setCloudUser(null);
    setBackendConnected(false);
    setBackendTier(null);
    setCloudUrl(null);
    setConnectionError(null);

    try {
      await fetch('/api/cloud/disconnect', { method: 'POST' });
    } catch {
      // Best-effort
    }
  };

  /**
   * Refresh connection status and user profile.
   */
  const handleRefresh = async () => {
    setConnectionLoading(true);
    setConnectionError(null);
    await checkBackendStatus();
    await validateToken();
    setConnectionLoading(false);
  };

  // -----------------------------------------------------------------------
  // Deployment polling
  // -----------------------------------------------------------------------

  const pollDeploymentStatus = useCallback(async (deploymentId: string) => {
    const startTime = Date.now();

    const poll = async () => {
      if (Date.now() - startTime > MAX_POLL_DURATION) {
        setDeployPhase('error');
        setDeployError('Deployment timed out after 10 minutes');
        return;
      }

      try {
        const status = await apiService.getDeploymentStatus(deploymentId);

        if (status.currentPhase === 'READY' && status.success) {
          setDeployPhase('ready');
          setDeployments((prev) => [
            ...prev.filter((d) => d.deploymentId !== deploymentId),
            { ...status, deploymentId },
          ]);
          return;
        }

        if (status.currentPhase === 'FAILED' || status.error) {
          setDeployPhase('error');
          setDeployError(status.error ?? 'Deployment failed');
          return;
        }

        setTimeout(poll, STATUS_POLL_INTERVAL);
      } catch (err) {
        setDeployPhase('error');
        setDeployError(err instanceof Error ? err.message : 'Failed to check deployment status');
      }
    };

    poll();
  }, []);

  // -----------------------------------------------------------------------
  // Deploy handler
  // -----------------------------------------------------------------------

  /**
   * Start a new team deployment.
   */
  const handleDeploy = async () => {
    if (!teamName.trim()) return;

    setDeployPhase('deploying');
    setDeployError(null);

    try {
      const result = await apiService.createDeployment({
        dropletName: `crewly-${teamName.trim().toLowerCase().replace(/\s+/g, '-')}`,
        region: DEFAULT_REGION,
        size: DEFAULT_SIZE,
        customerId: user?.id,
        installPro: true,
        registerCloud: true,
        apiKeys: {
          crewlyCloudApiKey: undefined,
        },
      });

      setActiveDeploymentId(result.deploymentId);
      pollDeploymentStatus(result.deploymentId);
    } catch (err) {
      setDeployPhase('error');
      setDeployError(err instanceof Error ? err.message : 'Failed to start deployment');
    }
  };

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  const isConnected = backendConnected || !!cloudUser;
  const resolvedPlan = cloudUser?.plan ?? backendTier ?? subscription?.plan ?? license?.plan ?? 'free';
  const isPaid = resolvedPlan !== 'free';
  const isLoading = connectionLoading || subLoading;
  const readyDeployments = deployments.filter((d) => d.success && d.currentPhase === 'READY');

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (connectionLoading) {
    return (
      <div className="p-6">
        <div className="mx-auto max-w-7xl flex justify-center py-12">
          <LoadingSpinner size="sm" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Cloud className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary-dark">
              Cloud Portal
            </h1>
            <p className="text-sm text-text-secondary-dark">
              Connect, manage, and deploy your Crewly teams in the cloud
            </p>
          </div>
        </div>

        {/* Upgrade Success Banner */}
        {justUpgraded && (
          <div
            className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center"
            data-testid="upgrade-success-banner"
          >
            <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-400 mb-2" />
            <h3 className="text-lg font-semibold text-emerald-400">
              Welcome to Crewly Pro!
            </h3>
            <p className="text-sm text-text-secondary-dark mt-1">
              Your subscription is active. Deploy your first AI team below to get started.
            </p>
          </div>
        )}

        {/* Connection error */}
        {connectionError && (
          <div className="mb-6">
            <Alert variant="error">{connectionError}</Alert>
          </div>
        )}

        {/* ================================================================= */}
        {/* DISCONNECTED STATE                                                */}
        {/* ================================================================= */}
        {!isConnected && (
          <Card padding="lg" className="text-center space-y-4 mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mx-auto">
              <Zap className="w-8 h-8 text-primary" />
            </div>

            <div>
              <h2 className="text-lg font-semibold text-text-primary-dark">
                Connect to CrewlyAI Cloud
              </h2>
              <p className="text-sm text-text-secondary-dark mt-1 max-w-md mx-auto">
                Sign in with your CrewlyAI account to enable device sync,
                remote team access, and Pro features.
              </p>
            </div>

            <button
              onClick={handleSignIn}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors"
              data-testid="cloud-sign-in-button"
            >
              <ExternalLink className="w-4 h-4" />
              Sign in with CrewlyAI
            </button>
          </Card>
        )}

        {/* ================================================================= */}
        {/* CONNECTED STATE                                                   */}
        {/* ================================================================= */}
        {isConnected && (
          <>
            {/* Connection Status + User Info Card */}
            <div
              className="mb-6 rounded-xl border border-border-dark bg-surface-dark p-6"
              data-testid="connection-card"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
                    {cloudUser?.avatar ? (
                      <img
                        src={cloudUser.avatar}
                        alt={cloudUser.name || cloudUser.email}
                        className="w-10 h-10 rounded-full"
                      />
                    ) : (
                      <Cloud className="w-5 h-5 text-primary" />
                    )}
                  </div>
                  {/* User info */}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary-dark">
                        {cloudUser ? (cloudUser.name || cloudUser.email) : 'CrewlyAI Cloud'}
                      </span>
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getPlanBadgeClass(resolvedPlan)} capitalize`}>
                        {resolvedPlan}
                      </span>
                    </div>
                    <span className="text-xs text-text-secondary-dark">
                      {cloudUser ? cloudUser.email : 'Connected via backend'}
                    </span>
                    {cloudUrl && (
                      <p className="text-xs text-text-secondary-dark mt-0.5">
                        {cloudUrl}
                      </p>
                    )}
                  </div>
                </div>

                {/* Upgrade button for free tier */}
                {!isPaid && (
                  <Button
                    variant="primary"
                    onClick={() => navigate('/pricing')}
                    data-testid="upgrade-btn"
                  >
                    Upgrade Now
                  </Button>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 pt-4 mt-4 border-t border-border-dark">
                <button
                  onClick={handleRefresh}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors disabled:opacity-50"
                  data-testid="refresh-connection-button"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  onClick={handleDisconnect}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-rose-400 rounded-md hover:bg-background-dark transition-colors"
                  data-testid="cloud-disconnect-button"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </div>
            </div>

            {/* Connected Devices */}
            <div className="mb-6">
              <DeviceListSection />
            </div>

            {/* Browser Extensions (Crewly in Chrome) */}
            <div className="mb-6">
              <BrowserExtensionsSection />
            </div>

            {/* Deploy section — disabled in OSS, available on crewlyai.com Cloud Portal */}
            {false && isPaid && (
              <div
                className="mb-6 rounded-xl border border-border-dark bg-surface-dark p-6"
                data-testid="deploy-section"
              >
                <div className="flex items-center gap-2 mb-4">
                  <Rocket className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold text-text-primary-dark">
                    Deploy a New Team
                  </h2>
                </div>

                {deployPhase === 'idle' || deployPhase === 'configuring' ? (
                  <div className="space-y-4">
                    <p className="text-sm text-text-secondary-dark">
                      Deploy a Crewly team to the cloud. We&apos;ll create a dedicated server,
                      install Crewly OSS with Pro features, and connect it to your Cloud account.
                    </p>

                    <div>
                      <label
                        htmlFor="team-name"
                        className="block text-sm font-medium text-text-primary-dark mb-1"
                      >
                        Team Name
                      </label>
                      <input
                        id="team-name"
                        type="text"
                        value={teamName}
                        onChange={(e) => setTeamName(e.target.value)}
                        placeholder="e.g. marketing-team"
                        className="w-full rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark placeholder:text-text-secondary-dark focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        data-testid="team-name-input"
                      />
                    </div>

                    <div className="flex items-center gap-4 text-xs text-text-secondary-dark">
                      <span className="flex items-center gap-1">
                        <Server className="h-3 w-3" /> 2 vCPU / 4 GB RAM
                      </span>
                      <span className="flex items-center gap-1">
                        <Globe className="h-3 w-3" /> San Francisco (SFO3)
                      </span>
                    </div>

                    <Button
                      variant="primary"
                      onClick={handleDeploy}
                      disabled={!teamName.trim()}
                      data-testid="deploy-btn"
                    >
                      <Rocket className="mr-2 h-4 w-4" />
                      Deploy Team
                    </Button>
                  </div>
                ) : deployPhase === 'deploying' ? (
                  <div className="flex flex-col items-center py-8" data-testid="deploying-state">
                    <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
                    <h3 className="text-lg font-semibold text-text-primary-dark">
                      Deploying your team...
                    </h3>
                    <p className="mt-2 text-sm text-text-secondary-dark text-center max-w-md">
                      Creating server, installing Crewly OSS, adding Pro features, and connecting
                      to Cloud. This usually takes 3-5 minutes.
                    </p>
                    {activeDeploymentId && (
                      <p className="mt-2 text-xs text-text-secondary-dark font-mono">
                        ID: {activeDeploymentId}
                      </p>
                    )}
                  </div>
                ) : deployPhase === 'ready' ? (
                  <div className="flex flex-col items-center py-8" data-testid="ready-state">
                    <CheckCircle2 className="h-10 w-10 text-emerald-400 mb-4" />
                    <h3 className="text-lg font-semibold text-text-primary-dark">
                      Team deployed successfully!
                    </h3>
                    <p className="mt-2 text-sm text-text-secondary-dark">
                      Your team is ready. Click below to start chatting with your AI team.
                    </p>
                    <Button
                      variant="primary"
                      className="mt-4"
                      onClick={() => navigate('/chat')}
                      data-testid="open-chat-btn"
                    >
                      <MessageSquare className="mr-2 h-4 w-4" />
                      Open Team Chat
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-8" data-testid="error-state">
                    <AlertCircle className="h-10 w-10 text-red-400 mb-4" />
                    <h3 className="text-lg font-semibold text-text-primary-dark">
                      Deployment failed
                    </h3>
                    <p className="mt-2 text-sm text-red-400">{deployError}</p>
                    <Button
                      variant="secondary"
                      className="mt-4"
                      onClick={() => {
                        setDeployPhase('idle');
                        setDeployError(null);
                      }}
                      data-testid="retry-btn"
                    >
                      Try Again
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Deployed Teams List — disabled in OSS, available on crewlyai.com Cloud Portal */}
            {false && <div
              className="rounded-xl border border-border-dark bg-surface-dark p-6"
              data-testid="deployments-list"
            >
              <h2 className="text-lg font-semibold text-text-primary-dark mb-4">
                Your Deployed Teams
              </h2>

              {deploymentsLoading ? (
                <div className="flex items-center gap-2 text-text-secondary-dark py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading deployments...
                </div>
              ) : readyDeployments.length === 0 ? (
                <p className="text-sm text-text-secondary-dark py-4">
                  No deployed teams yet. {isPaid ? 'Deploy your first team above!' : 'Upgrade to a paid plan to deploy teams.'}
                </p>
              ) : (
                <div className="space-y-3">
                  {readyDeployments.map((dep) => (
                    <div
                      key={dep.deploymentId}
                      className="flex items-center justify-between rounded-lg border border-border-dark bg-background-dark p-4"
                      data-testid={`deployment-${dep.deploymentId}`}
                    >
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        <div>
                          <p className="text-sm font-medium text-text-primary-dark">
                            {dep.ipAddress ?? dep.deploymentId}
                          </p>
                          <p className="text-xs text-text-secondary-dark">
                            Phase: {dep.currentPhase}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => navigate('/chat')}
                        data-testid={`chat-btn-${dep.deploymentId}`}
                      >
                        <MessageSquare className="mr-1 h-3 w-3" />
                        Chat
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>}
          </>
        )}
      </div>
    </div>
  );
};

export default CloudPortal;
