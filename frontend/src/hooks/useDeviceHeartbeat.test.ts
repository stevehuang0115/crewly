/**
 * useDeviceHeartbeat Hook Tests
 *
 * @module hooks/useDeviceHeartbeat.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeviceHeartbeat } from './useDeviceHeartbeat';

/**
 * Helper: create a fetch mock that responds to device-id, heartbeat, and device-list requests.
 *
 * @param overrides - Optional per-URL response overrides
 * @returns The mock function installed as global.fetch
 */
function setupFetchMock(overrides?: {
  deviceId?: { deviceId: string; deviceName: string } | null;
  heartbeat?: boolean;
  devices?: unknown[];
}): ReturnType<typeof vi.fn> {
  const deviceIdResponse = overrides?.deviceId !== undefined
    ? overrides.deviceId
    : { deviceId: 'test-device-uuid', deviceName: 'TestHost' };
  const heartbeatOk = overrides?.heartbeat ?? true;
  const devicesData = overrides?.devices ?? [];

  const mockFn = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/cloud/device-id')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: deviceIdResponse !== null,
          data: deviceIdResponse,
        }),
      });
    }
    if (typeof url === 'string' && url.includes('/devices/heartbeat')) {
      return Promise.resolve({ ok: heartbeatOk, json: async () => ({ success: heartbeatOk }) });
    }
    if (typeof url === 'string' && url.includes('/devices')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: devicesData }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
  });

  global.fetch = mockFn as unknown as typeof fetch;
  return mockFn;
}

describe('useDeviceHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not fetch when disabled', () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    renderHook(() => useDeviceHeartbeat(null, false, [], 'Test'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should return empty devices initially when enabled', async () => {
    setupFetchMock();

    const { result } = renderHook(() =>
      useDeviceHeartbeat('token', true, [], 'Test'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.devices).toEqual([]);
  });

  it('should return devices from API', async () => {
    const mockDevices = [
      { deviceId: 'd1', deviceName: 'Remote', email: 'a@b.com', teams: [], lastSeenAt: '2026-01-01' },
    ];

    setupFetchMock({ devices: mockDevices });

    const { result } = renderHook(() =>
      useDeviceHeartbeat('token', true, [], 'Test'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.devices).toEqual(mockDevices);
  });

  it('should fetch device-id from local backend before first heartbeat', async () => {
    const mockFn = setupFetchMock();

    renderHook(() => useDeviceHeartbeat('token', true, [], 'TestDevice'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const calls = mockFn.mock.calls;
    // First call should be to local backend for device-id
    const deviceIdCall = calls.find((c: unknown[]) => (c[0] as string).includes('/api/cloud/device-id'));
    expect(deviceIdCall).toBeDefined();
  });

  it('should include deviceId in heartbeat body', async () => {
    const mockFn = setupFetchMock({
      deviceId: { deviceId: 'my-uuid-123', deviceName: 'MyHost' },
    });

    renderHook(() => useDeviceHeartbeat('token', true, [], 'TestDevice'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Find the heartbeat call
    const heartbeatCall = mockFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/devices/heartbeat'),
    );
    expect(heartbeatCall).toBeDefined();

    const body = JSON.parse(heartbeatCall![1].body);
    expect(body.deviceId).toBe('my-uuid-123');
    expect(body.deviceName).toBe('TestDevice');
  });

  it('should still send heartbeat when device-id fetch fails', async () => {
    const mockFn = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/cloud/device-id')) {
        return Promise.reject(new Error('network error'));
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
    });
    global.fetch = mockFn as unknown as typeof fetch;

    renderHook(() => useDeviceHeartbeat('token', true, [], 'TestDevice'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Heartbeat should still be called even without deviceId
    const heartbeatCall = mockFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/devices/heartbeat'),
    );
    expect(heartbeatCall).toBeDefined();

    const body = JSON.parse(heartbeatCall![1].body);
    expect(body.deviceId).toBeUndefined();
  });

  it('should call Cloud API base URL for heartbeat', async () => {
    const mockFn = setupFetchMock();

    renderHook(() => useDeviceHeartbeat('token', true, [], 'TestDevice'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const heartbeatCall = mockFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/devices/heartbeat'),
    );
    expect(heartbeatCall).toBeDefined();
    expect(heartbeatCall![0]).toContain('api.crewlyai.com');
  });
});
