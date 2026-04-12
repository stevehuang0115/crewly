// @vitest-environment jsdom
/**
 * RelayHealthCard Component Tests
 *
 * Unit tests for the Cloud Relay dashboard health card.
 *
 * @module components/Dashboard/RelayHealthCard.test
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RelayHealthCard } from './RelayHealthCard';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Mock relay status response (connected). */
const mockRelayStatusConnected = {
  success: true,
  data: {
    client: {
      state: 'paired',
      sessionId: 'local-session-123',
    },
  },
};

/** Mock relay status response (disconnected). */
const mockRelayStatusDisconnected = {
  success: true,
  data: {
    client: {
      state: 'disconnected',
      sessionId: null,
    },
  },
};

/** Mock cloud devices response with two devices. */
const mockDevicesResponse = {
  success: true,
  data: {
    devices: [
      {
        sessionId: 'local-session-123',
        role: 'orchestrator' as const,
        state: 'paired' as const,
        pairedWith: 'remote-session-456',
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        name: 'Office Desktop',
        isLocal: true,
      },
      {
        sessionId: 'remote-session-456',
        role: 'agent' as const,
        state: 'paired' as const,
        pairedWith: 'local-session-123',
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date(Date.now() - 30000).toISOString(),
        name: 'Home Laptop',
        isLocal: false,
      },
    ],
    localDeviceId: 'local-session-123',
  },
};

/** Mock empty devices response. */
const mockEmptyDevicesResponse = {
  success: true,
  data: {
    devices: [],
    localDeviceId: null,
  },
};

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch implementation based on URL patterns.
 *
 * @param relayStatus - Response for /api/relay/devices
 * @param devicesResp - Response for /api/relay/cloud-devices
 * @returns Mock fetch function
 */
function createMockFetch(
  relayStatus: object = mockRelayStatusConnected,
  devicesResp: object = mockDevicesResponse,
) {
  return vi.fn((url: string) => {
    if (url.includes('/api/cloud/devices')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(devicesResp),
      });
    }
    if (url.includes('/api/relay/cloud-devices')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(devicesResp),
      });
    }
    // Default: /api/relay/devices
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(relayStatus),
    });
  });
}

const renderRelayHealthCard = () => render(
  <MemoryRouter>
    <RelayHealthCard />
  </MemoryRouter>,
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayHealthCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Mock performance.now for latency measurement
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(42)
      .mockReturnValue(42);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the card with header and Cloud Relay title', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    expect(screen.getByTestId('relay-health-card')).toBeDefined();
    expect(screen.getByText('Cloud Relay')).toBeDefined();
  });

  it('shows disconnected state when relay is not connected', async () => {
    global.fetch = createMockFetch(mockRelayStatusDisconnected) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-disconnected')).toBeDefined();
    });

    expect(screen.getByText('Not Connected')).toBeDefined();
    expect(screen.getByText(/Enable Cloud Relay/)).toBeDefined();
  });

  it('shows connected devices with role icons and status dots', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-device-list')).toBeDefined();
    });

    // Both devices should render
    expect(screen.getByTestId('relay-device-local-session-123')).toBeDefined();
    expect(screen.getByTestId('relay-device-remote-session-456')).toBeDefined();

    // Device names
    expect(screen.getByText('Office Desktop')).toBeDefined();
    expect(screen.getByText('Home Laptop')).toBeDefined();

    // Local device tag
    expect(screen.getByText('You')).toBeDefined();

    // Device count
    expect(screen.getByText('2 devices')).toBeDefined();
  });

  it('displays latency value', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-latency')).toBeDefined();
    });

    // Should show ping value (42ms from mocked performance.now)
    expect(screen.getByText('42ms')).toBeDefined();
  });

  it('shows E2EE shield when devices are paired', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-e2ee')).toBeDefined();
    });

    expect(screen.getByText('E2EE')).toBeDefined();
  });

  it('shows standby security state when no devices are paired', async () => {
    const devicesNoPaired = {
      success: true,
      data: {
        devices: [
          {
            sessionId: 'local-session-123',
            role: 'orchestrator' as const,
            state: 'waiting' as const,
            pairedWith: null,
            registeredAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
            name: 'Office Desktop',
            isLocal: true,
          },
        ],
        localDeviceId: 'local-session-123',
      },
    };

    // Use 'registered' state instead of 'paired' for relay status
    const registeredStatus = {
      success: true,
      data: { client: { state: 'registered', sessionId: 'local-session-123' } },
    };

    global.fetch = createMockFetch(registeredStatus, devicesNoPaired) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByText('1 device')).toBeDefined();
    });

    expect(screen.getByTestId('relay-e2ee')).toBeDefined();
    expect(screen.getByText('Secure standby')).toBeDefined();
  });

  it('shows last-seen timestamps for devices', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-device-list')).toBeDefined();
    });

    // Local device should show "Last seen Just now", remote device "Last seen 30s ago"
    expect(screen.getByText('Last seen Just now')).toBeDefined();
    expect(screen.getByText('Last seen 30s ago')).toBeDefined();
  });

  it('shows error state when fetch fails', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('Network error'))) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-error')).toBeDefined();
    });

    expect(screen.getByText('Could not reach the server')).toBeDefined();
  });

  it('refresh button triggers data reload', async () => {
    const mockFetch = createMockFetch();
    global.fetch = mockFetch as unknown as typeof fetch;

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-device-list')).toBeDefined();
    });

    const initialCallCount = mockFetch.mock.calls.length;

    const refreshButton = screen.getByTestId('relay-refresh-button');
    await user.click(refreshButton);

    await waitFor(() => {
      // Should have made additional fetch calls
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('shows status badge matching relay state', async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      // 'paired' state should show 'Connected' badge (may appear multiple times for badge + device labels)
      const connectedElements = screen.getAllByText('Connected');
      expect(connectedElements.length).toBeGreaterThanOrEqual(1);
      // The first one should be the status badge
      expect(connectedElements[0].className).toContain('emerald');
    });
  });

  it('shows "Offline" badge when disconnected', async () => {
    global.fetch = createMockFetch(mockRelayStatusDisconnected) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByText('Offline')).toBeDefined();
    });
  });

  it('shows "No devices found" when connected but device list is empty', async () => {
    const connectedNoDevices = {
      success: true,
      data: { client: { state: 'registered', sessionId: 'session-123' } },
    };

    global.fetch = createMockFetch(connectedNoDevices, mockEmptyDevicesResponse) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-no-devices')).toBeDefined();
    });

    expect(screen.getByText('No devices found')).toBeDefined();
  });

  it('renders a CTA to open Cloud settings when disconnected', async () => {
    global.fetch = createMockFetch(mockRelayStatusDisconnected) as unknown as typeof fetch;

    await act(async () => {
      renderRelayHealthCard();
    });

    await waitFor(() => {
      expect(screen.getByTestId('relay-settings-cta')).toBeDefined();
    });

    expect(screen.getByText('Open Cloud Settings')).toBeDefined();
  });
});
