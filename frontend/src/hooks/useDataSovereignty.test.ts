// @vitest-environment jsdom
/**
 * useDataSovereignty Hook Tests
 *
 * @module hooks/useDataSovereignty.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { useDataSovereignty, formatBytes } from './useDataSovereignty';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

(mockedAxios as any).isCancel = vi.fn(() => false);

describe('useDataSovereignty', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (mockedAxios as any).isCancel = vi.fn(() => false);
  });

  it('should initialize with loading state', () => {
    mockedAxios.get.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useDataSovereignty());
    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch storage entries from API', async () => {
    const mockEntries = [
      { path: '~/.crewly/memory/', type: 'Agent Memory', sizeBytes: 13000000, isExternal: false },
      { path: '~/.crewly/knowledge/', type: 'Vector Store', sizeBytes: 29000000, isExternal: false },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEntries },
    });

    const { result } = renderHook(() => useDataSovereignty());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entries).toEqual(mockEntries);
    expect(result.current.error).toBeNull();
  });

  it('should fall back to mock data when API fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('404'));

    const { result } = renderHook(() => useDataSovereignty());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should have mock data (5 entries)
    expect(result.current.entries.length).toBe(5);
    expect(result.current.error).toBeNull();
  });

  it('should compute summary correctly', async () => {
    const mockEntries = [
      { path: '/a', type: 'A', sizeBytes: 1000000, isExternal: false },
      { path: '/b', type: 'B', sizeBytes: 2000000, isExternal: false },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEntries },
    });

    const { result } = renderHook(() => useDataSovereignty());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.summary.totalLocalBytes).toBe(3000000);
    expect(result.current.summary.externalConnections).toBe(0);
    expect(result.current.summary.cloudSync).toBe('disabled');
    expect(result.current.summary.status).toBe('secure');
  });

  it('should detect external connections in summary', async () => {
    const mockEntries = [
      { path: '/local', type: 'Local', sizeBytes: 1000, isExternal: false },
      { path: 'cloud://remote', type: 'Cloud', sizeBytes: 5000, isExternal: true },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEntries },
    });

    const { result } = renderHook(() => useDataSovereignty());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.summary.externalConnections).toBe(1);
    expect(result.current.summary.totalLocalBytes).toBe(1000);
  });

  it('should support manual refresh', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { success: true, data: [] } })
      .mockResolvedValueOnce({
        data: { success: true, data: [{ path: '/new', type: 'New', sizeBytes: 100, isExternal: false }] },
      });

    const { result } = renderHook(() => useDataSovereignty());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entries).toEqual([]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.entries).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format bytes', () => {
    expect(formatBytes(512)).toBe('512.0 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
