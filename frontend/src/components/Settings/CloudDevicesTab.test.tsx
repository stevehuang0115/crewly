/**
 * Tests for Settings › Cloud & devices.
 *
 * @module components/Settings/CloudDevicesTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CloudDevicesTab, deviceDisplayName, deviceMeta } from './CloudDevicesTab';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ license: { plan: 'free' }, user: { id: 'u1' } }),
}));

vi.mock('../CloudDevicePairingPanel', () => ({
  PAIRING_LABELS_EN: {},
  CloudDevicePairingPanel: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="pairing-panel" onClick={() => onConnected?.()}>
      Pair
    </button>
  ),
}));

vi.mock('../../services/api.service', () => ({
  apiService: { getSubscription: vi.fn().mockRejectedValue(new Error('none')) },
}));

/** Response helper. */
const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

interface Fixture {
  connected?: boolean;
  tier?: string;
  devices?: unknown[];
  syncState?: string;
  tokenExpired?: boolean;
  instances?: unknown[];
  proxyConnected?: boolean;
}

/**
 * Route fetch by URL.
 *
 * @param f - Fixture
 * @returns The mock
 */
function mockFetch(f: Fixture) {
  const fn = vi.fn((url: string) => {
    if (url === '/api/cloud/status') {
      return json({ success: true, data: { connectionStatus: f.connected ? 'connected' : 'disconnected', tier: f.tier ?? 'free', cloudUrl: 'https://api.crewlyai.com' } });
    }
    if (url === '/api/cloud/devices') {
      return json({ success: true, data: { devices: f.devices ?? [], syncState: f.syncState ?? 'syncing', tokenExpired: f.tokenExpired } });
    }
    if (url === '/api/browser/instances') return json({ instances: f.instances ?? [], proxyConnected: f.proxyConnected ?? true });
    return json({ success: true });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Shows the current path for navigation assertions. */
const Where: React.FC = () => <div data-testid="where">{useLocation().pathname}</div>;

/**
 * Render the tab at a URL.
 *
 * @param url - Initial URL
 */
function renderTab(url = '/settings?tab=cloud') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/settings" element={<CloudDevicesTab />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const device = (i: number, extra: Record<string, unknown> = {}) => ({
  deviceId: `dev-${i}`,
  deviceName: `host-${i}.lan`,
  role: 'orchestrator',
  status: 'online',
  lastHeartbeatAt: new Date().toISOString(),
  ...extra,
});

describe('CloudDevicesTab', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers sign-in when not connected', async () => {
    mockFetch({ connected: false });
    renderTab();
    expect(await screen.findByTestId('cloud-sign-in-button')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-device-list-section')).not.toBeInTheDocument();
  });

  it('shows the account row with plan and an Upgrade action for free plans', async () => {
    mockFetch({ connected: true, tier: 'free' });
    renderTab();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Free plan/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('upgrade-btn'));
    expect(screen.getByTestId('where')).toHaveTextContent('/pricing');
  });

  it('hides Upgrade on a paid plan', async () => {
    mockFetch({ connected: true, tier: 'pro' });
    renderTab();
    expect(await screen.findByText(/Pro plan/)).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-btn')).not.toBeInTheDocument();
  });

  it('disconnects from the overflow menu', async () => {
    const fetchMock = mockFetch({ connected: true });
    renderTab();
    fireEvent.click(await screen.findByLabelText('More for CrewlyAI Cloud'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Disconnect/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/cloud/disconnect', { method: 'POST' }));
    expect(await screen.findByTestId('cloud-sign-in-button')).toBeInTheDocument();
  });

  it('lists machines, five at a time, without browser sessions', async () => {
    mockFetch({
      connected: true,
      devices: [device(1, { isLocal: true }), device(2), device(3), device(4), device(5), device(6), { sessionId: 'portal-1', role: 'orchestrator' }],
    });
    renderTab();
    expect(await screen.findByText('host-1.lan')).toBeInTheDocument();
    expect(screen.getByText('Devices (6)')).toBeInTheDocument();
    expect(screen.getByText(/This machine/)).toBeInTheDocument();
    expect(screen.queryByText('host-6.lan')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show all 6'));
    expect(screen.getByText('host-6.lan')).toBeInTheDocument();
  });

  it('warns when the Cloud session expired and flags sync errors', async () => {
    mockFetch({ connected: true, devices: [device(1)], tokenExpired: true, syncState: 'error' });
    renderTab();
    expect(await screen.findByTestId('token-expired-warning')).toBeInTheDocument();
    expect(screen.getByTestId('sync-state-badge')).toHaveTextContent('Sync error');
  });

  it('shows browser extensions and the relay state, with the id behind the menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockFetch({
      connected: true,
      proxyConnected: false,
      instances: [{ instanceId: 'fd41df2b-aaaa', instanceName: 'Chrome (macOS)', lastSeenAt: new Date().toISOString() }],
    });
    renderTab();
    expect(await screen.findByText('Chrome (macOS)')).toBeInTheDocument();
    expect(screen.getByTestId('relay-status')).toHaveTextContent('Relay offline');
    expect(screen.queryByText(/fd41df2b/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('More for Chrome (macOS)'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy extension ID/ }));
    expect(writeText).toHaveBeenCalledWith('fd41df2b-aaaa');
  });

  it('keeps the Cloud address under Connection details', async () => {
    mockFetch({ connected: true });
    renderTab();
    fireEvent.click(await screen.findByText('Connection details'));
    expect(screen.getByTestId('cloud-url')).toHaveTextContent('https://api.crewlyai.com');
  });

  it('signed out: "Add a device" is open with device-code pairing of this machine', async () => {
    const fetchMock = mockFetch({ connected: false });
    renderTab();
    const section = await screen.findByTestId('cloud-add-device');
    expect(section.querySelector('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
    const statusCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/cloud/status').length;
    fireEvent.click(screen.getByTestId('pairing-panel'));
    // Connected by pairing: the account is checked again.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/api/cloud/status').length).toBeGreaterThan(statusCalls));
  });

  it('signed in: no "Add a device" (this machine is already connected; relay invite / join codes are gone)', async () => {
    mockFetch({ connected: true });
    renderTab();
    await screen.findByTestId('cloud-account-row');
    expect(screen.queryByTestId('cloud-add-device')).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite another machine|Join with a code/)).not.toBeInTheDocument();
  });

  it('shows the welcome note after an upgrade', async () => {
    mockFetch({ connected: true, tier: 'pro' });
    renderTab('/settings?tab=cloud&upgraded=true');
    expect(await screen.findByTestId('upgrade-success-banner')).toBeInTheDocument();
  });
});

describe('device helpers', () => {
  it('names a device by name, hostname, then role and short session', () => {
    expect(deviceDisplayName({ name: 'A', deviceName: 'b' })).toBe('A');
    expect(deviceDisplayName({ deviceName: 'b' })).toBe('b');
    expect(deviceDisplayName({ role: 'agent', sessionId: '1234567890' })).toBe('agent (12345678...)');
  });

  it('builds a meta line with kind, this machine and last seen', () => {
    const meta = deviceMeta({ role: 'agent', isLocal: true, lastHeartbeatAt: new Date().toISOString() });
    expect(meta).toMatch(/^Agent relay · This machine · last seen/);
  });
});
