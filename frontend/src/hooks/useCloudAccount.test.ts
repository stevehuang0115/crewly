/**
 * Tests for the Cloud account hooks.
 *
 * @module hooks/useCloudAccount.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { deduplicateDevices, filterToOssDevices, useCloudAccount, useCloudDevices, useBrowserInstances } from './useCloudAccount';

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ license: { plan: 'free' } }) }));
vi.mock('../services/api.service', () => ({ apiService: { getSubscription: vi.fn().mockResolvedValue({ plan: 'pro', status: 'active', currentPeriodEnd: null }) } }));

const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

describe('device helpers', () => {
  it('keeps only entries with a hostname', () => {
    expect(filterToOssDevices([{ deviceName: 'a' }, { role: 'orchestrator' }, { deviceName: '' }])).toEqual([{ deviceName: 'a' }]);
  });

  it('dedupes by id, preferring the newest or the online one', () => {
    const out = deduplicateDevices([
      { deviceId: 'x', deviceName: 'old', lastHeartbeatAt: '2026-01-01T00:00:00Z', status: 'offline' },
      { deviceId: 'x', deviceName: 'new', lastHeartbeatAt: '2026-01-02T00:00:00Z', status: 'offline' },
      { deviceId: 'y', deviceName: 'off', lastHeartbeatAt: '2026-01-03T00:00:00Z', status: 'offline' },
      { deviceId: 'y', deviceName: 'on', lastHeartbeatAt: '2026-01-01T00:00:00Z', status: 'online' },
    ]);
    expect(out.map((d) => d.deviceName)).toEqual(['new', 'on']);
  });
});

describe('useCloudAccount', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reads the connection from the backend and falls back to the subscription plan', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ success: true, data: { connectionStatus: 'connected', tier: null, cloudUrl: 'https://c' } })));
    const { result } = renderHook(() => useCloudAccount());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connected).toBe(true);
    expect(result.current.cloudUrl).toBe('https://c');
    await waitFor(() => expect(result.current.plan).toBe('pro'));
    expect(result.current.isPaid).toBe(true);
  });

  it('disconnect clears the token and tells the backend', async () => {
    localStorage.setItem('crewly_cloud_token', 't');
    const fetchMock = vi.fn((url: string) =>
      url === '/api/cloud/validate'
        ? json({ success: true, data: { id: '1', email: 'a@b.c', plan: 'free' } })
        : json({ success: true, data: { connectionStatus: 'connected' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCloudAccount());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.connected).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/cloud/disconnect', { method: 'POST' });
  });
});

describe('useCloudDevices', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the legacy endpoint when sync is off and the list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/cloud/devices'
          ? json({ success: true, data: { devices: [], syncState: 'stopped' } })
          : json({ success: true, data: { devices: [{ deviceId: 'a', deviceName: 'host' }] } }),
      ),
    );
    const { result } = renderHook(() => useCloudDevices());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.syncState).toBe('stopped');
  });

  it('reports a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ success: false, error: 'nope' }, false)));
    const { result } = renderHook(() => useCloudDevices());
    await waitFor(() => expect(result.current.error).toBe('nope'));
  });
});

describe('useBrowserInstances', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the instances and the relay state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ instances: [{ instanceId: 'i', instanceName: 'Chrome' }], proxyConnected: true })));
    const { result } = renderHook(() => useBrowserInstances(60000));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.instances).toHaveLength(1);
    expect(result.current.proxyConnected).toBe(true);
  });
});
