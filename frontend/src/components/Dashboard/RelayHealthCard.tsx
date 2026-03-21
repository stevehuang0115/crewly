/**
 * RelayHealthCard Component
 *
 * Dashboard card showing live Cloud Relay connection health:
 * connected devices, real-time latency (ping), last-seen timestamps,
 * and E2EE encryption status.
 *
 * Self-contained — fetches its own data via useEffect polling.
 *
 * @module components/Dashboard/RelayHealthCard
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Monitor, Cpu, RefreshCw, Shield, Wifi, WifiOff, Activity } from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relay local status endpoint. */
const RELAY_STATUS_URL = '/api/relay/devices';

/** Cloud devices proxy endpoint. */
const CLOUD_DEVICES_URL = '/api/relay/cloud-devices';

/** Polling interval for latency pings (ms). */
const PING_INTERVAL_MS = 5000;

/** Polling interval for device list refresh (ms). */
const DEVICE_REFRESH_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A relay device returned by the Cloud devices API. */
interface CloudDevice {
  sessionId: string;
  role: 'orchestrator' | 'agent';
  state: 'waiting' | 'paired' | 'disconnected';
  pairedWith: string | null;
  registeredAt: string;
  lastHeartbeatAt: string;
  name?: string;
  isLocal?: boolean;
}

/** Local relay client status. */
interface RelayStatus {
  state: string;
  sessionId: string | null;
}

/** Overall card state. */
type CardState = 'loading' | 'disconnected' | 'connected' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp to a human-readable relative time string.
 *
 * @param iso - ISO timestamp string
 * @returns Relative time string (e.g., "2s ago", "5m ago")
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

/** Map device state to status dot color CSS class. */
const DEVICE_STATE_COLORS: Record<string, string> = {
  waiting: 'bg-yellow-400',
  paired: 'bg-emerald-400',
  disconnected: 'bg-gray-500',
};

/** Map device state to human-readable label. */
const DEVICE_STATE_LABELS: Record<string, string> = {
  waiting: 'Connecting',
  paired: 'Connected',
  disconnected: 'Offline',
};

/** Map overall relay state to status badge styling. */
const RELAY_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  paired: { label: 'Connected', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  registered: { label: 'Registered', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
  connecting: { label: 'Connecting', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
  disconnected: { label: 'Offline', className: 'bg-gray-500/10 text-gray-400 border-gray-500/30' },
  error: { label: 'Error', className: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
};

/**
 * Measure round-trip latency to the relay status endpoint.
 *
 * @returns Latency in milliseconds, or null if unreachable
 */
async function measureLatency(): Promise<number | null> {
  try {
    const start = performance.now();
    const res = await fetch(RELAY_STATUS_URL);
    const end = performance.now();
    if (!res.ok) return null;
    return Math.round(end - start);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Individual device row within the relay health card.
 *
 * @param props - Device data
 * @returns DeviceRow component
 */
const DeviceRow: React.FC<{ device: CloudDevice }> = ({ device }) => {
  const Icon = device.role === 'orchestrator' ? Monitor : Cpu;
  const stateColor = DEVICE_STATE_COLORS[device.state] ?? 'bg-gray-500';
  const stateLabel = DEVICE_STATE_LABELS[device.state] ?? device.state;
  const displayName = device.name ?? `${device.role} (${device.sessionId.slice(0, 8)}…)`;

  return (
    <div
      data-testid={`relay-device-${device.sessionId}`}
      className={`flex items-center justify-between py-2 px-3 rounded-md transition-colors ${
        device.isLocal
          ? 'bg-primary/5 border border-primary/20'
          : 'hover:bg-background-dark'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${device.isLocal ? 'text-primary' : 'text-text-secondary-dark'}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-text-primary-dark truncate">
              {displayName}
            </span>
            {device.isLocal && (
              <span className="text-[9px] font-medium px-1 py-px rounded bg-primary/10 text-primary whitespace-nowrap">
                You
              </span>
            )}
          </div>
          <span className="text-[10px] text-text-secondary-dark">
            {formatRelativeTime(device.lastHeartbeatAt)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
        <span className={`h-1.5 w-1.5 rounded-full ${stateColor}`} />
        <span className="text-[10px] text-text-secondary-dark">{stateLabel}</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * RelayHealthCard — Dashboard card for Cloud Relay status.
 *
 * Features:
 * - Live device list with role icons and status indicators
 * - Real-time latency (ping) updated every 5 seconds
 * - Last-seen timestamps per device
 * - E2EE shield icon when encryption is active
 * - Graceful "Not Connected" state when relay is inactive
 *
 * @returns RelayHealthCard component
 */
export const RelayHealthCard: React.FC = () => {
  const [cardState, setCardState] = useState<CardState>('loading');
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /** Track intervals for cleanup. */
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Fetch relay status and cloud devices.
   * Determines overall card state from the relay client state.
   */
  const fetchData = useCallback(async () => {
    try {
      setError(null);

      // Fetch local relay status
      const statusRes = await fetch(RELAY_STATUS_URL);
      const statusData = await statusRes.json();

      if (!statusRes.ok || !statusData.success) {
        setCardState('error');
        setError(statusData.error || 'Failed to fetch relay status');
        return;
      }

      const client: RelayStatus = statusData.data.client;
      setRelayStatus(client);

      // If relay is disconnected, show disconnected state
      if (client.state === 'disconnected' || !client.sessionId) {
        setCardState('disconnected');
        setDevices([]);
        return;
      }

      // Fetch cloud devices
      const devicesRes = await fetch(CLOUD_DEVICES_URL);
      const devicesData = await devicesRes.json();

      if (devicesRes.ok && devicesData.success && devicesData.data?.devices) {
        setDevices(devicesData.data.devices);
      }

      setCardState('connected');
    } catch {
      setCardState('error');
      setError('Could not reach the server');
    }
  }, []);

  /**
   * Ping for latency measurement.
   */
  const pingLatency = useCallback(async () => {
    const ms = await measureLatency();
    setLatencyMs(ms);
  }, []);

  /**
   * Manual refresh handler — fetches data and measures latency.
   */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchData(), pingLatency()]);
    setRefreshing(false);
  }, [fetchData, pingLatency]);

  /**
   * Initial data load and polling setup.
   */
  useEffect(() => {
    // Initial fetch
    fetchData();
    pingLatency();

    // Set up polling intervals
    pingIntervalRef.current = setInterval(pingLatency, PING_INTERVAL_MS);
    deviceIntervalRef.current = setInterval(fetchData, DEVICE_REFRESH_INTERVAL_MS);

    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (deviceIntervalRef.current) clearInterval(deviceIntervalRef.current);
    };
  }, [fetchData, pingLatency]);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const relayState = relayStatus?.state ?? 'disconnected';
  const statusBadge = RELAY_STATUS_BADGES[relayState] ?? RELAY_STATUS_BADGES.disconnected;
  const pairedDevices = devices.filter((d) => d.state === 'paired');
  const isEncrypted = pairedDevices.length > 0; // E2EE is always active when paired

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      data-testid="relay-health-card"
      className="bg-surface-dark border border-border-dark rounded-lg p-5 transition-all hover:shadow-lg hover:border-primary/50"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-text-secondary-dark" />
          <h3 className="text-sm font-semibold text-text-primary-dark">Cloud Relay</h3>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors disabled:opacity-50"
          aria-label="Refresh relay status"
          data-testid="relay-refresh-button"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Loading state */}
      {cardState === 'loading' && (
        <div className="flex items-center justify-center py-8" data-testid="relay-loading">
          <div className="w-5 h-5 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        </div>
      )}

      {/* Error state */}
      {cardState === 'error' && error && (
        <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2" data-testid="relay-error">
          {error}
        </div>
      )}

      {/* Disconnected state */}
      {cardState === 'disconnected' && (
        <div className="text-center py-6" data-testid="relay-disconnected">
          <WifiOff className="w-8 h-8 text-text-secondary-dark/30 mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark font-medium">Not Connected</p>
          <p className="text-[11px] text-text-secondary-dark/60 mt-0.5">
            Enable Cloud Relay in Settings → Cloud
          </p>
        </div>
      )}

      {/* Connected state */}
      {cardState === 'connected' && (
        <div className="space-y-3">
          {/* Stats row: Latency + Encryption + Device count */}
          <div className="flex items-center gap-4 text-xs text-text-secondary-dark">
            {/* Latency */}
            <div className="flex items-center gap-1.5" data-testid="relay-latency">
              <Activity className="w-3 h-3" />
              <span>
                Ping:{' '}
                <span className={`font-medium ${
                  latencyMs === null
                    ? 'text-gray-400'
                    : latencyMs < 100
                      ? 'text-emerald-400'
                      : latencyMs < 300
                        ? 'text-yellow-400'
                        : 'text-rose-400'
                }`}>
                  {latencyMs !== null ? `${latencyMs}ms` : '—'}
                </span>
              </span>
            </div>

            {/* E2EE indicator */}
            {isEncrypted && (
              <div className="flex items-center gap-1" data-testid="relay-e2ee">
                <Shield className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400 font-medium">E2EE</span>
              </div>
            )}

            {/* Device count */}
            <div className="ml-auto flex items-center gap-1">
              <span>{devices.length} device{devices.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {/* Device list */}
          {devices.length === 0 ? (
            <div className="text-center py-4" data-testid="relay-no-devices">
              <Monitor className="w-6 h-6 text-text-secondary-dark/30 mx-auto mb-1" />
              <p className="text-[11px] text-text-secondary-dark">No devices found</p>
            </div>
          ) : (
            <div className="space-y-1" data-testid="relay-device-list">
              {devices.map((device) => (
                <DeviceRow key={device.sessionId} device={device} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RelayHealthCard;
