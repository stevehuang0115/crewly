/**
 * Cloud Bar — Persistent Relay Status Indicator
 *
 * A compact status indicator for the app header that shows the current
 * Cloud Relay connection state. Implements the "Cloud Bar" from the UX
 * spec (docs/okr/relay-ux-design.md section 3.1).
 *
 * States:
 * - Connected (green, static)  — Registered with server, looking for peer
 * - Paired (green, pulse)      — Successfully linked to another machine
 * - Connecting (yellow, spin)  — Handshake or reconnecting
 * - Error (red, static)        — Auth failure or max retries reached
 * - Offline (grey, static)     — Relay disabled or disconnected
 *
 * @module components/CloudBar
 */

import React from 'react';
import { Cloud, Loader2, AlertCircle, WifiOff, Link2 } from 'lucide-react';
import { useRelayStatus, type CloudBarState } from '../hooks/useRelayStatus';

// ========================= Style Config =========================

/** Visual configuration for each Cloud Bar state */
const STATE_STYLES: Record<CloudBarState, {
  bg: string;
  text: string;
  icon: string;
  dot: string;
}> = {
  connected: {
    bg: 'bg-emerald-500/10 border-emerald-500/30',
    text: 'text-emerald-300',
    icon: 'text-emerald-400',
    dot: 'bg-emerald-400',
  },
  paired: {
    bg: 'bg-emerald-500/10 border-emerald-500/30',
    text: 'text-emerald-300',
    icon: 'text-emerald-400',
    dot: 'bg-emerald-400 animate-pulse',
  },
  connecting: {
    bg: 'bg-yellow-500/10 border-yellow-500/30',
    text: 'text-yellow-300',
    icon: 'text-yellow-400',
    dot: 'bg-yellow-400',
  },
  error: {
    bg: 'bg-red-500/10 border-red-500/30',
    text: 'text-red-300',
    icon: 'text-red-400',
    dot: 'bg-red-400',
  },
  offline: {
    bg: 'bg-zinc-500/10 border-zinc-500/30',
    text: 'text-zinc-400',
    icon: 'text-zinc-500',
    dot: 'bg-zinc-500',
  },
};

/** Returns the appropriate icon for each state */
function StateIcon({ state, className }: { state: CloudBarState; className?: string }) {
  switch (state) {
    case 'connecting':
      return <Loader2 className={`animate-spin ${className ?? ''}`} size={14} />;
    case 'error':
      return <AlertCircle className={className} size={14} />;
    case 'offline':
      return <WifiOff className={className} size={14} />;
    case 'paired':
      return <Link2 className={className} size={14} />;
    case 'connected':
    default:
      return <Cloud className={className} size={14} />;
  }
}

// ========================= Component =========================

/**
 * Persistent Cloud Bar status indicator for the app header.
 *
 * Renders a compact, colour-coded bar showing the current relay
 * connection state. Hidden while the initial status check is loading.
 *
 * @returns CloudBar component or null while loading
 */
export const CloudBar: React.FC = () => {
  const { state, label, isLoading } = useRelayStatus();

  if (isLoading) {
    return null;
  }

  const styles = STATE_STYLES[state];

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 border-b text-xs ${styles.bg}`}
      role="status"
      aria-label={`Cloud relay status: ${label}`}
      data-testid="cloud-bar"
    >
      <div className={`w-2 h-2 rounded-full shrink-0 ${styles.dot}`} />
      <StateIcon state={state} className={styles.icon} />
      <span className={styles.text}>{label}</span>
    </div>
  );
};

CloudBar.displayName = 'CloudBar';
