/**
 * CloudTab Component Tests
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

/**
 * Helper to set up an authenticated session.
 * Handles the full fetch sequence: validate → store token → fetch devices.
 *
 * @param devices - Devices to return from cloud-devices endpoint
 */
function mockAuthenticatedWithDevices(devices: unknown[] = []) {
  mockStorage.set('crewly_cloud_token', 'valid-token');

  mockFetch.mockImplementation(async (url: string) => {
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

  it('should render sign-in button when not connected', async () => {
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

  it('should clear token when validation fails', async () => {
    mockStorage.set('crewly_cloud_token', 'invalid-token');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false, error: 'Invalid token' }),
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
      if (typeof url === 'string' && url.includes('/relay/cloud-devices')) {
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
    render(<CloudTab />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud-sign-in-button')).toBeDefined();
    });

    expect(screen.queryByTestId('cloud-device-list-section')).toBeNull();
  });
});
