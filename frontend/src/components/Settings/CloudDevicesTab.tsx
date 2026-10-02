/**
 * Settings › Cloud & devices
 *
 * The former `/cloud` page (CloudPortal) as a Settings panel, at the
 * simplified density (specs/2026-10-02-ui-redesign.md): the Cloud account
 * as one row, then the machines and the Crewly in Chrome extensions signed
 * in to it (first 5, then "Show all"). Ids, the Cloud URL and the plan
 * details sit under "Connection details".
 *
 * @module components/Settings/CloudDevicesTab
 */

import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Cloud, Copy, Cpu, ExternalLink, Globe, LogOut, Monitor, RefreshCw } from 'lucide-react';
import { Alert, Button, CollapsibleSection, CompactRow, IconButton, LoadingSpinner, ShowAll, StatusLabel } from '@crewly/ui';
import type { StatusTone } from '@crewly/ui';
import {
  isDeviceOnline,
  useBrowserInstances,
  useCloudAccount,
  useCloudDevices,
  type CloudDevice,
} from '../../hooks/useCloudAccount';
import { formatRelativeTimeCompact } from '../../utils/time';
import { getInstanceStatus, type BrowserInstanceStatus } from '../../utils/browser-instance-status';

/** Status word per device state. */
const DEVICE_STATE_LABELS: Record<string, string> = {
  waiting: 'Connecting',
  paired: 'Connected',
  disconnected: 'Offline',
  online: 'Online',
  offline: 'Offline',
};

/** Status word and tone per extension status. */
const INSTANCE_STATUS: Record<BrowserInstanceStatus, { label: string; tone: StatusTone }> = {
  online: { label: 'Online', tone: 'success' },
  stale: { label: 'Stale', tone: 'attention' },
  offline: { label: 'Offline', tone: 'neutral' },
};

/**
 * Display name of a device.
 *
 * @param d - Device
 * @returns Name
 */
export function deviceDisplayName(d: CloudDevice): string {
  return d.name || d.deviceName || (d.sessionId ? `${d.role || 'device'} (${d.sessionId.slice(0, 8)}...)` : d.deviceId || 'Unknown');
}

/**
 * Quiet meta line of a device: kind, this machine, last seen.
 *
 * @param d - Device
 * @returns e.g. "Orchestrator · This machine · last seen 2m ago"
 */
export function deviceMeta(d: CloudDevice): string {
  const kind = d.role === 'orchestrator' ? 'Orchestrator' : d.role === 'agent' ? 'Agent relay' : null;
  const seen = d.lastHeartbeatAt
    ? `last seen ${formatRelativeTimeCompact(d.lastHeartbeatAt)}`
    : `registered ${formatRelativeTimeCompact(d.registeredAt ?? null)}`;
  return [kind, d.isLocal ? 'This machine' : null, seen].filter(Boolean).join(' · ');
}

/**
 * Section heading: title, one quiet line, and right-side controls.
 *
 * @param props - Title, optional subtitle and controls
 * @returns Heading row
 */
const SectionHead: React.FC<{ id: string; title: React.ReactNode; subtitle?: string; children?: React.ReactNode }> = ({ id, title, subtitle, children }) => (
  <div className="mb-2 flex items-end justify-between gap-3">
    <div className="min-w-0">
      <h2 id={id} className="text-[15px] font-semibold text-text">
        {title}
      </h2>
      {subtitle && <p className="text-[13px] text-text-2">{subtitle}</p>}
    </div>
    {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
  </div>
);

/**
 * Copy text to the clipboard (best-effort).
 *
 * @param text - Text to copy
 */
function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * Machines signed in to the account.
 *
 * @returns Section
 */
const DevicesSection: React.FC = () => {
  const { devices, loading, error, tokenExpired, syncState, refresh } = useCloudDevices();
  const syncLabel = syncState === 'syncing' ? 'Sync active' : syncState === 'error' ? 'Sync error' : syncState ? 'Sync off' : null;
  return (
    <section aria-labelledby="cloud-devices-h" data-testid="cloud-device-list-section">
      <SectionHead id="cloud-devices-h" title={`Devices (${devices.length})`} subtitle="Machines signed in to this Cloud account">
        {syncLabel && (
          <StatusLabel tone={syncState === 'syncing' ? 'neutral' : syncState === 'error' ? 'danger' : 'attention'} data-testid="sync-state-badge">
            {syncLabel}
          </StatusLabel>
        )}
        <IconButton icon={RefreshCw} size="xs" onClick={() => void refresh()} loading={loading} aria-label="Refresh devices" data-testid="refresh-devices-button" />
      </SectionHead>
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      {tokenExpired && !error && (
        <Alert variant="warning" size="sm" data-testid="token-expired-warning">
          Cloud session expired. Disconnect and sign in again to refresh it.
        </Alert>
      )}
      {!loading && !error && !tokenExpired && devices.length === 0 && (
        <p className="py-3 text-[13px] text-text-2">
          No devices connected yet. Connect another machine with <code className="font-mono text-text">crewly cloud connect</code>.
        </p>
      )}
      {devices.length > 0 && (
        <ShowAll limit={5} className="border-y border-border-soft" data-testid="cloud-devices">
          {devices.map((d) => {
            const state = d.status || d.state || 'disconnected';
            const Icon = d.role === 'orchestrator' ? Monitor : Cpu;
            return (
              <CompactRow
                key={d.deviceId || d.sessionId || d.name || d.deviceName}
                data-testid={`cloud-device-${d.sessionId || d.deviceId}`}
                leading={<Icon className={`h-4 w-4 ${d.isLocal ? 'text-primary-text' : 'text-text-2'}`} aria-hidden="true" />}
                primary={deviceDisplayName(d)}
                meta={deviceMeta(d)}
                trailing={
                  <StatusLabel tone={isDeviceOnline(d) ? 'success' : 'neutral'} size="sm">
                    {DEVICE_STATE_LABELS[state] ?? state}
                  </StatusLabel>
                }
              />
            );
          })}
        </ShowAll>
      )}
    </section>
  );
};

/**
 * Crewly in Chrome instances.
 *
 * @returns Section
 */
const ExtensionsSection: React.FC = () => {
  const { instances, proxyConnected, loading, refresh } = useBrowserInstances();
  return (
    <section aria-labelledby="cloud-ext-h" data-testid="browser-extensions-section">
      <SectionHead id="cloud-ext-h" title="Browser extensions" subtitle="Crewly in Chrome, reached through the relay">
        <StatusLabel tone={proxyConnected ? 'neutral' : 'attention'} data-testid="relay-status">
          {proxyConnected ? 'Relay connected' : 'Relay offline'}
        </StatusLabel>
        <IconButton icon={RefreshCw} size="xs" onClick={() => void refresh()} loading={loading} aria-label="Refresh extensions" />
      </SectionHead>
      {loading && instances.length === 0 ? (
        <LoadingSpinner size="xs" text="Loading…" centered={false} className="py-3" />
      ) : instances.length === 0 ? (
        <p className="py-3 text-[13px] text-text-2">No browser extensions connected. Install Crewly in Chrome and sign in to connect.</p>
      ) : (
        <ShowAll limit={5} className="border-y border-border-soft" data-testid="browser-instances">
          {instances.map((inst) => {
            const status = INSTANCE_STATUS[getInstanceStatus(inst.lastSeenAt)];
            return (
              <CompactRow
                key={inst.instanceId}
                data-testid={`browser-instance-${inst.instanceId}`}
                leading={<Globe className="h-4 w-4 text-text-2" aria-hidden="true" />}
                primary={inst.instanceName}
                meta={inst.lastSeenAt ? `Last seen ${formatRelativeTimeCompact(inst.lastSeenAt)}` : undefined}
                trailing={
                  <StatusLabel tone={status.tone} size="sm" data-testid={`browser-instance-status-${getInstanceStatus(inst.lastSeenAt)}`}>
                    {status.label}
                  </StatusLabel>
                }
                overflowLabel={`More for ${inst.instanceName}`}
                overflow={[{ label: 'Copy extension ID', icon: Copy, onClick: () => copy(inst.instanceId) }]}
              />
            );
          })}
        </ShowAll>
      )}
    </section>
  );
};

/**
 * Settings › Cloud & devices panel.
 *
 * @returns Panel
 */
export const CloudDevicesTab: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const justUpgraded = searchParams.get('upgraded') === 'true';
  const account = useCloudAccount();
  const { cloudUser } = account;

  if (account.loading) {
    return <LoadingSpinner size="sm" centered text="Checking the Cloud connection…" data-testid="cloud-tab-loading" />;
  }

  return (
    <div className="max-w-3xl space-y-8" data-testid="cloud-devices-tab">
      {justUpgraded && (
        <Alert variant="success" size="sm" title="Welcome to Crewly Pro!" data-testid="upgrade-success-banner">
          Your subscription is active.
        </Alert>
      )}
      {account.error && (
        <Alert variant="error" size="sm">
          {account.error}
        </Alert>
      )}

      {!account.connected ? (
        <section aria-label="CrewlyAI Cloud" className="border-y border-border-soft">
          <CompactRow
            data-testid="cloud-account-row"
            leading={<Cloud className="h-5 w-5 text-text-2" aria-hidden="true" />}
            primary="CrewlyAI Cloud"
            meta="Sign in to sync devices, reach your team remotely and use Pro features."
            trailing={<StatusLabel tone="neutral">Not connected</StatusLabel>}
            actions={[
              <Button key="sign-in" size="sm" icon={ExternalLink} onClick={account.signIn} data-testid="cloud-sign-in-button">
                Sign in with CrewlyAI
              </Button>,
            ]}
          />
        </section>
      ) : (
        <>
          <section aria-label="CrewlyAI Cloud" className="border-y border-border-soft" data-testid="connection-card">
            <CompactRow
              data-testid="cloud-account-row"
              leading={
                cloudUser?.avatar ? (
                  <img src={cloudUser.avatar} alt={cloudUser.name || cloudUser.email} className="h-8 w-8 rounded-full" />
                ) : (
                  <Cloud className="h-5 w-5 text-primary-text" aria-hidden="true" />
                )
              }
              primary={cloudUser ? cloudUser.name || cloudUser.email : 'CrewlyAI Cloud'}
              meta={`${cloudUser ? cloudUser.email : 'Connected via backend'} · ${account.plan.charAt(0).toUpperCase()}${account.plan.slice(1)} plan`}
              trailing={<StatusLabel tone="success">Connected</StatusLabel>}
              actions={
                account.isPaid
                  ? undefined
                  : [
                      <Button key="upgrade" size="sm" onClick={() => navigate('/pricing')} data-testid="upgrade-btn">
                        Upgrade
                      </Button>,
                    ]
              }
              overflowLabel="More for CrewlyAI Cloud"
              overflow={[
                { label: account.refreshing ? 'Refreshing…' : 'Refresh', icon: RefreshCw, disabled: account.refreshing, onClick: () => void account.refresh() },
                { label: 'Disconnect', icon: LogOut, danger: true, separator: true, onClick: () => void account.disconnect() },
              ]}
            />
          </section>

          <DevicesSection />
          <ExtensionsSection />

          <CollapsibleSection title="Connection details" summary="Plan, Cloud address, account" data-testid="cloud-details">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
              <dt className="text-text-2">Plan</dt>
              <dd className="capitalize text-text" data-testid="cloud-plan">
                {account.plan}
                {account.subscription?.status ? ` · ${account.subscription.status}` : ''}
              </dd>
              {account.subscription?.currentPeriodEnd && (
                <>
                  <dt className="text-text-2">Renews</dt>
                  <dd className="text-text">{new Date(account.subscription.currentPeriodEnd).toLocaleDateString()}</dd>
                </>
              )}
              <dt className="text-text-2">Cloud</dt>
              <dd className="break-all font-mono text-text" data-testid="cloud-url">
                {account.cloudUrl ?? '—'}
              </dd>
              <dt className="text-text-2">Account</dt>
              <dd className="break-all text-text">{cloudUser ? cloudUser.email : 'Connected via backend (no profile)'}</dd>
            </dl>
          </CollapsibleSection>
        </>
      )}
    </div>
  );
};

export default CloudDevicesTab;
