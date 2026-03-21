/**
 * CloudTab Component Tests
 *
 * Tests cover three connection scenarios:
 * 1. Fully disconnected (no backend connection, no localStorage token)
 * 2. Connected via localStorage token (browser-initiated OAuth)
 * 3. Connected via backend only (CLI/auto-reconnect, no localStorage token)
 *
 * @module components/Settings/CloudTab.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CloudTab } from './CloudTab';

// Mock localStorage
const mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => mockStorage.set(key, value),
  removeItem: (key: string) => mockStorage.delete(key),
});

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Default disconnected backend status response. */
const BACKEND_DISCONNECTED = {
  ok: true,
  json: async () => ({
    success: true,
    data: { connectionStatus: 'disconnected', cloudUrl: null, tier: 'free', lastSyncAt: null },
  }),
};

/** Connected backend status response with a given tier. */
function backendConnected(tier = 'pro') {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: { connectionStatus: 'connected', cloudUrl: 'https://api.crewlyai.com', tier, lastSyncAt: new Date().toISOString() },
    }),
  };
}

/**
 * Helper to set up an authenticated session with localStorage token.
 * Handles the full fetch sequence: backend status → validate → store token → fetch devices.
 *
 * @param devices - Devices to return from cloud-devices endpoint
 * @param tier - Backend tier to return (default: 'pro')
 */
function mockAuthenticatedWithDevices(devices: unknown[] = [], tier = 'pro', syncState?: string) {
  mockStorage.set('crewly_cloud_token', 'valid-token');

  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/cloud/status')) {
      return backendConnected(tier);
    }
    if (typeof url === 'string' && url.includes('/cloud/validate')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 'u1', email: 'test@test.com', plan: tier, name: 'Test User' },
        }),
      };
    }
    if (typeof url === 'string' && url.includes('/cloud/connect')) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    // New endpoint: /api/cloud/devices
    if (typeof url === 'string' && url.includes('/cloud/devices') && !url.includes('/relay/')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { devices, localSessionId: 'local-session-1', syncState: syncState || undefined },
        }),
      };
    }
    // Legacy endpoint fallback: /api/relay/cloud-devices
    if (typeof url === 'string' && url.includes('/relay/cloud-devices')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { devices, localSessionId: 'local-session-1' },
        }),
      };
    }
    return { ok: false, json: async () => ({ success: false }) };
  });
}

/**
 * Helper to mock backend-connected but NO localStorage token.
 * Simulates CLI or auto-reconnect connections.
 *
 * @param tier - Subscription tier
 * @param devices - Devices to return
 */
function mockBackendOnlyConnection(tier = 'pro', devices: unknown[] = []) {
  // No localStorage token set

  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/cloud/status')) {
      return backendConnected(tier);
    }
    // New endpoint: /api/cloud/devices
    if (typeof url === 'string' && url.includes('/cloud/devices') && !url.includes('/relay/')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { devices, localSessionId: 'local-session-1' },
        }),
      };
    }
    // Legacy fallback
    if (typeof url === 'string' && url.includes('/relay/cloud-devices')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { devices, localSessionId: 'local-session-1' },
        }),
      };
    }
    if (typeof url === 'string' && url.includes('/cloud/disconnect')) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: false, json: async () => ({ success: false }) };
  });
}

/**
 * Helper to mock fully disconnected state (backend + no localStorage).
 */
function mockFullyDisconnected() {
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/cloud/status')) {
      return BACKEND_DISCONNECTED;
    }
    return { ok: false, json: async () => ({ success: false }) };
  });
}

describe('CloudTab', () => {
  beforeEach(() => {
    mockStorage.clear();
    mockFetch.mockReset();
    vi.stubGlobal('location', { ...window.location, href: 'http://localhost:5173/settings', origin: 'http://localhost:5173', search: '' });
    vi.stubGlobal('history', { replaceState: vi.fn() });
  });

  // -----------------------------------------------------------------------
  // Auth States
  // -----------------------------------------------------------------------

  it('should render sign-in button when fully disconnected', async () => {
    mockFullyDisconnected();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });
  });

  it('should show user info when token is valid', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeDefined();
      expect(screen.getByText('test@test.com')).toBeDefined();
      expect(screen.getByText('Pro')).toBeDefined();
    });
  });

  it('should clear token when validation fails but backend disconnected', async () => {
    mockStorage.set('crewly_cloud_token', 'invalid-token');
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/cloud/status')) {
        return BACKEND_DISCONNECTED;
      }
      if (typeof url === 'string' && url.includes('/cloud/validate')) {
        return {
          ok: false,
          json: async () => ({ success: false, error: 'Invalid token' }),
        };
      }
      return { ok: false, json: async () => ({ success: false }) };
    });

    render(<CloudTab />);

    await waitFor(() => {
      expect(mockStorage.has('crewly_cloud_token')).toBe(false);
    });
  });

  it('should disconnect when disconnect button clicked', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('Disconnect')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockStorage.has('crewly_cloud_token')).toBe(false);
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Backend-Only Connection (the bug scenario)
  // -----------------------------------------------------------------------

  it('should show connected state when backend is connected but no localStorage token', async () => {
    mockBackendOnlyConnection('pro');
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('Connected via backend')).toBeDefined();
      expect(screen.getByText('Pro')).toBeDefined();
    });

    // Should NOT show sign-in button
    expect(screen.queryByTestId('cloud-sign-in-button')).toBeNull();
    // The connected state card should show "CrewlyAI Cloud" as the display name
    const nameElements = screen.getAllByText('CrewlyAI Cloud');
    expect(nameElements.length).toBeGreaterThanOrEqual(2); // header h2 + connected state span
  });

  it('should show device list when backend is connected without token', async () => {
    mockBackendOnlyConnection('enterprise');
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-device-list-section')).toBeDefined();
      expect(screen.getByText('Enterprise')).toBeDefined();
    });
  });

  it('should disconnect backend-only connection when disconnect clicked', async () => {
    mockBackendOnlyConnection('pro');
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('Disconnect')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Device List
  // -----------------------------------------------------------------------

  it('should show device list section when connected', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-device-list-section')).toBeDefined();
    });
  });

  it('should display connected devices with status', async () => {
    const devices = [
      {
        sessionId: 'dev-orc-1',
        role: 'orchestrator',
        state: 'paired',
        pairedWith: 'dev-agent-1',
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        name: 'MacBook Pro',
        isLocal: true,
      },
      {
        sessionId: 'dev-agent-1',
        role: 'agent',
        state: 'paired',
        pairedWith: 'dev-orc-1',
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        name: 'ESTestNode',
        isLocal: false,
      },
    ];

    mockAuthenticatedWithDevices(devices);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('MacBook Pro')).toBeDefined();
      expect(screen.getByText('ESTestNode')).toBeDefined();
      expect(screen.getByText('This machine')).toBeDefined();
    });

    const connectedLabels = screen.getAllByText('Connected');
    expect(connectedLabels.length).toBe(2);
  });

  it('should show empty state when no devices', async () => {
    mockAuthenticatedWithDevices([]);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('No devices connected yet')).toBeDefined();
    });
  });

  it('should show device count', async () => {
    const devices = [
      {
        sessionId: 'dev-1',
        role: 'agent',
        state: 'waiting',
        pairedWith: null,
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        name: 'Test Device',
        isLocal: false,
      },
    ];

    mockAuthenticatedWithDevices(devices);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('(1)')).toBeDefined();
    });
  });

  it('should have a refresh button for device list', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('refresh-devices-button')).toBeDefined();
    });
  });

  it('should show error when device fetch fails', async () => {
    mockStorage.set('crewly_cloud_token', 'valid-token');

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/cloud/status')) {
        return backendConnected('free');
      }
      if (typeof url === 'string' && url.includes('/cloud/validate')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { id: 'u1', email: 'test@test.com', plan: 'free' },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('/cloud/connect')) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (typeof url === 'string' && url.includes('/cloud/devices') && !url.includes('/relay/')) {
        return {
          ok: false,
          json: async () => ({ success: false, error: 'Cloud connection required' }),
        };
      }
      return { ok: false, json: async () => ({ success: false }) };
    });

    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByText('Cloud connection required')).toBeDefined();
    });
  });

  it('should not show device list when not connected', async () => {
    mockFullyDisconnected();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });

    expect(screen.queryByTestId('cloud-device-list-section')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Relay Pairing Buttons
  // -----------------------------------------------------------------------

  it('should show Invite Device and Join Relay buttons when connected', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-device-button')).toBeDefined();
      expect(screen.getByTestId('join-relay-button')).toBeDefined();
    });
  });

  it('should not show relay buttons when disconnected', async () => {
    mockFullyDisconnected();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });

    expect(screen.queryByTestId('invite-device-button')).toBeNull();
    expect(screen.queryByTestId('join-relay-button')).toBeNull();
  });

  it('should open Invite Device modal when button clicked', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-device-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('invite-device-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-device-modal')).toBeDefined();
    });
  });

  it('should open Join Relay modal when button clicked', async () => {
    mockAuthenticatedWithDevices();
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('join-relay-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('join-relay-button'));

    await waitFor(() => {
      expect(screen.getByTestId('join-relay-modal')).toBeDefined();
    });
  });

  it('should show relay buttons for backend-only connection', async () => {
    mockBackendOnlyConnection('pro');
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-device-button')).toBeDefined();
      expect(screen.getByTestId('join-relay-button')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Token Expired Warning
  // -----------------------------------------------------------------------

  it('should show amber token-expired warning when cloud-devices returns tokenExpired', async () => {
    mockStorage.set('crewly_cloud_token', 'valid-token');

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/cloud/status')) {
        return backendConnected('pro');
      }
      if (typeof url === 'string' && url.includes('/cloud/validate')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { id: 'u1', email: 'test@test.com', plan: 'pro', name: 'Test User' },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('/cloud/connect')) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (typeof url === 'string' && url.includes('/cloud/devices') && !url.includes('/relay/')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { devices: [], localSessionId: null, tokenExpired: true },
          }),
        };
      }
      return { ok: false, json: async () => ({ success: false }) };
    });

    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('token-expired-warning')).toBeDefined();
    });
    expect(screen.getByText(/Cloud session expired/)).toBeDefined();
  });

  it('should not show amber warning when tokenExpired is absent', async () => {
    mockAuthenticatedWithDevices([]);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-device-list-section')).toBeDefined();
    });

    expect(screen.queryByTestId('token-expired-warning')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Cloud Sync Integration
  // -----------------------------------------------------------------------

  it('should fetch from /api/cloud/devices instead of /api/relay/cloud-devices', async () => {
    mockAuthenticatedWithDevices([]);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-device-list-section')).toBeDefined();
    });

    // Verify the new endpoint was called
    const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((url: string) => url.includes('/cloud/devices'))).toBe(true);
  });

  it('should show sync state badge when syncState is returned', async () => {
    mockAuthenticatedWithDevices(
      [{ sessionId: 'dev-1', role: 'agent', state: 'paired', pairedWith: null, registeredAt: new Date().toISOString(), name: 'Test' }],
      'pro',
      'syncing',
    );
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('sync-state-badge')).toBeDefined();
      expect(screen.getByText('Sync Active')).toBeDefined();
    });
  });

  it('should not show sync badge when syncState is absent', async () => {
    mockAuthenticatedWithDevices([]);
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-device-list-section')).toBeDefined();
    });

    expect(screen.queryByTestId('sync-state-badge')).toBeNull();
  });
});
