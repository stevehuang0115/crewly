/**
 * Cloud account hooks
 *
 * The data behind Settings › Cloud & devices (and the former `/cloud`
 * CloudPortal page): the CrewlyAI Cloud sign-in and plan, the machines
 * signed in to the same account, and the Crewly in Chrome extensions
 * reached through the relay.
 *
 * - {@link useCloudAccount}: backend `/api/cloud/status` is the source of
 *   truth for the connection; a stored Cloud token is validated through
 *   `/api/cloud/validate` for the profile, then handed to the backend
 *   (`/api/cloud/connect`) so it can renew it.
 * - {@link useCloudDevices}: `/api/cloud/devices`, falling back to the legacy
 *   `/api/relay/cloud-devices` when sync is off and the list is empty.
 * - {@link useBrowserInstances}: `/api/browser/instances`, polled every 15 s.
 *
 * @module hooks/useCloudAccount
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import { CLOUD_TOKEN_KEY } from '../constants/cloud.constants';

/** Endpoints. */
export const CLOUD_ACCOUNT_API = {
  VALIDATE: '/api/cloud/validate',
  STATUS: '/api/cloud/status',
  CONNECT: '/api/cloud/connect',
  DISCONNECT: '/api/cloud/disconnect',
  DEVICES: '/api/cloud/devices',
  LEGACY_DEVICES: '/api/relay/cloud-devices',
  BROWSER_INSTANCES: '/api/browser/instances',
} as const;

/** How often the browser extension list is refreshed (ms). */
export const BROWSER_INSTANCES_POLL_MS = 15000;

/** Cloud user profile from token validation. */
export interface CloudUser {
  id: string;
  email: string;
  plan: string;
  name?: string;
  avatar?: string;
}

/** Subscription info from the payment API. */
export interface SubscriptionInfo {
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
}

/** A device returned by the Cloud devices API. */
export interface CloudDevice {
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

/** A Crewly in Chrome instance. */
export interface BrowserInstance {
  instanceId: string;
  instanceName: string;
  sessionId?: string;
  lastSeenAt?: string;
}

/**
 * Keep only entries that represent a real machine (they have a hostname).
 *
 * The relay's `/devices` endpoint returns every session registered for the
 * user, including Portal browser/mobile sessions, which are UI clients
 * rather than connected machines. `role` is self-declared and not
 * validated by the relay; `deviceName` is only set by clients that run on a
 * host (the Crewly OSS daemon), so it is the truthful signal.
 *
 * @param devices - Raw device list from `/api/cloud/devices`
 * @returns Only entries with a non-empty `deviceName`
 */
export function filterToOssDevices(devices: CloudDevice[]): CloudDevice[] {
  return devices.filter((d) => typeof d.deviceName === 'string' && d.deviceName.length > 0);
}

/**
 * Whether a device counts as online.
 *
 * @param d - Device
 * @returns True when online, paired or connecting
 */
export function isDeviceOnline(d: CloudDevice): boolean {
  return d.status === 'online' || d.state === 'paired' || d.state === 'waiting';
}

/**
 * Deduplicate devices by deviceId (or sessionId), keeping the entry with
 * the most recent heartbeat and preferring online ones.
 *
 * @param devices - Raw device list
 * @returns Deduplicated list
 */
export function deduplicateDevices(devices: CloudDevice[]): CloudDevice[] {
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
      if (newTime > existingTime || (isDeviceOnline(device) && !isDeviceOnline(existing))) {
        seen.set(key, device);
      }
    }
  }
  return Array.from(seen.values());
}

/** Result of {@link useCloudAccount}. */
export interface UseCloudAccountResult {
  /** First status check still running */
  loading: boolean;
  /** A refresh is running */
  refreshing: boolean;
  connected: boolean;
  /** Resolved plan: Cloud profile, backend tier, subscription, license, else `free` */
  plan: string;
  isPaid: boolean;
  cloudUser: CloudUser | null;
  cloudUrl: string | null;
  subscription: SubscriptionInfo | null;
  error: string | null;
  /** Start the Google sign-in through the Cloud auth service */
  signIn: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * The CrewlyAI Cloud connection, profile and plan.
 *
 * @returns {@link UseCloudAccountResult}
 */
export function useCloudAccount(): UseCloudAccountResult {
  const { license } = useAuth();
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendTier, setBackendTier] = useState<string | null>(null);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);

  const checkBackendStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(CLOUD_ACCOUNT_API.STATUS);
      const data = await res.json();
      if (res.ok && data.success && data.data) {
        const isConnected = data.data.connectionStatus === 'connected';
        setBackendConnected(isConnected);
        setCloudUrl(data.data.cloudUrl ?? null);
        setBackendTier(isConnected ? data.data.tier ?? null : null);
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

  const validateToken = useCallback(async (): Promise<void> => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) return;
    try {
      const res = await fetch(CLOUD_ACCOUNT_API.VALIDATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.success && data.data) {
        setCloudUser({ id: data.data.id, email: data.data.email, plan: data.data.plan, name: data.data.name, avatar: data.data.avatar });
        setError(null);
      } else {
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        setCloudUser(null);
      }
    } catch {
      setError('Could not reach CrewlyAI Cloud. Check your internet connection.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await checkBackendStatus();
      await validateToken();
      if (!cancelled) setLoading(false);
    })();
    apiService
      .getSubscription()
      .then((sub) => !cancelled && setSubscription(sub))
      .catch(() => !cancelled && setSubscription(null));
    return () => {
      cancelled = true;
    };
  }, [checkBackendStatus, validateToken]);

  // Hand the token to the backend so it can renew it (best-effort).
  useEffect(() => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token || !cloudUser) return;
    const refreshToken = localStorage.getItem('crewly_refresh_token') || undefined;
    fetch(CLOUD_ACCOUNT_API.CONNECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...(refreshToken && { refreshToken }) }),
    }).catch(() => undefined);
  }, [cloudUser]);

  const signIn = useCallback((): void => {
    const callbackUrl = `${window.location.origin}/auth/callback`;
    // Direct flow: the auth service exchanges the code server-side, so a refreshToken always comes back.
    window.location.href = `https://api.crewlyai.com/api/cloud/google/start?redirect=${encodeURIComponent(callbackUrl)}`;
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    localStorage.removeItem(CLOUD_TOKEN_KEY);
    setCloudUser(null);
    setBackendConnected(false);
    setBackendTier(null);
    setCloudUrl(null);
    setError(null);
    try {
      await fetch(CLOUD_ACCOUNT_API.DISCONNECT, { method: 'POST' });
    } catch {
      // Best-effort
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    await checkBackendStatus();
    await validateToken();
    setRefreshing(false);
  }, [checkBackendStatus, validateToken]);

  const plan = cloudUser?.plan ?? backendTier ?? subscription?.plan ?? license?.plan ?? 'free';
  return {
    loading,
    refreshing,
    connected: backendConnected || !!cloudUser,
    plan,
    isPaid: plan !== 'free',
    cloudUser,
    cloudUrl,
    subscription,
    error,
    signIn,
    disconnect,
    refresh,
  };
}

/** Result of {@link useCloudDevices}. */
export interface UseCloudDevicesResult {
  /** Deduplicated machines (entries with a hostname) */
  devices: CloudDevice[];
  loading: boolean;
  error: string | null;
  tokenExpired: boolean;
  /** `syncing` | `error` | `stopped` | … or null when unknown */
  syncState: string | null;
  refresh: () => Promise<void>;
}

/**
 * Machines signed in to the same Cloud account.
 *
 * @returns {@link UseCloudDevicesResult}
 */
export function useCloudDevices(): UseCloudDevicesResult {
  const [raw, setRaw] = useState<CloudDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [syncState, setSyncState] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setTokenExpired(false);
    setSyncState(null);
    try {
      const res = await fetch(CLOUD_ACCOUNT_API.DEVICES);
      const data = await res.json();
      if (!(res.ok && data.success && data.data)) {
        setError(data.error || 'Failed to load devices');
        return;
      }
      if (data.data.syncState) setSyncState(data.data.syncState);
      if (data.data.devices && data.data.devices.length > 0) {
        setRaw(data.data.devices);
        if (data.data.tokenExpired) setTokenExpired(true);
        return;
      }
      // Empty and sync not active: try the legacy endpoint.
      if (!data.data.syncState || data.data.syncState === 'stopped') {
        try {
          const legacyRes = await fetch(CLOUD_ACCOUNT_API.LEGACY_DEVICES);
          const legacy = await legacyRes.json();
          if (legacyRes.ok && legacy.success && legacy.data?.devices) {
            setRaw(legacy.data.devices);
            if (legacy.data.tokenExpired) setTokenExpired(true);
            return;
          }
        } catch {
          // Legacy fallback failed
        }
      }
      setRaw(data.data.devices || []);
      if (data.data.tokenExpired) setTokenExpired(true);
    } catch {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const devices = useMemo(() => filterToOssDevices(deduplicateDevices(raw)), [raw]);
  return { devices, loading, error, tokenExpired, syncState, refresh };
}

/** Result of {@link useBrowserInstances}. */
export interface UseBrowserInstancesResult {
  instances: BrowserInstance[];
  /** The relay to the extensions is connected */
  proxyConnected: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Crewly in Chrome instances reached through the relay.
 *
 * @param pollMs - Refresh interval
 * @returns {@link UseBrowserInstancesResult}
 */
export function useBrowserInstances(pollMs: number = BROWSER_INSTANCES_POLL_MS): UseBrowserInstancesResult {
  const [instances, setInstances] = useState<BrowserInstance[]>([]);
  const [proxyConnected, setProxyConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchInstances = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch(CLOUD_ACCOUNT_API.BROWSER_INSTANCES);
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
    void fetchInstances();
    const interval = setInterval(() => void fetchInstances(), pollMs);
    return () => clearInterval(interval);
  }, [fetchInstances, pollMs]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    await fetchInstances();
  }, [fetchInstances]);

  return { instances, proxyConnected, loading, refresh };
}
