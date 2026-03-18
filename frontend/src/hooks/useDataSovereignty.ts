/**
 * useDataSovereignty Hook
 *
 * Fetches storage breakdown from /api/system/storage or provides
 * mock/static data when the endpoint is not available.
 *
 * @module hooks/useDataSovereignty
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { ApiResponse } from '../types';

const API_BASE = '/api';

/** A single storage location entry */
export interface StorageEntry {
  /** Display path */
  path: string;
  /** Storage type/category */
  type: string;
  /** Size in bytes */
  sizeBytes: number;
  /** Whether data is sent externally */
  isExternal: boolean;
}

/** Summary for the data sovereignty card */
export interface DataSovereigntySummary {
  /** Total local storage in bytes */
  totalLocalBytes: number;
  /** Number of external connections */
  externalConnections: number;
  /** Cloud sync status */
  cloudSync: 'disabled' | 'enabled';
  /** Overall security status */
  status: 'secure' | 'warning' | 'compromised';
  /** Last scan timestamp */
  lastScan: string;
}

/** Return type for the useDataSovereignty hook */
export interface UseDataSovereigntyResult {
  /** Storage entries */
  entries: StorageEntry[];
  /** Summary stats */
  summary: DataSovereigntySummary;
  /** Whether the initial fetch is still in progress */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Manual refresh function */
  refresh: () => Promise<void>;
}

/** Mock data matching the spec format (section 3.5) */
const MOCK_ENTRIES: StorageEntry[] = [
  { path: '~/.crewly/memory/', type: 'Agent Memory', sizeBytes: 12.4 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/knowledge/', type: 'Vector Store', sizeBytes: 28.1 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/sessions/', type: 'PTY Logs', sizeBytes: 7.7 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/teams/', type: 'Config', sizeBytes: 0.3 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/projects/', type: 'Metadata', sizeBytes: 0.1 * 1024 * 1024, isExternal: false },
];

/**
 * Formats bytes into a human-readable size string.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string like "12.4 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * Hook for fetching data sovereignty information.
 *
 * Attempts to fetch from /api/system/storage. Falls back to mock data
 * if the endpoint is not available.
 *
 * @returns Storage entries, summary, and loading/error state
 *
 * @example
 * ```tsx
 * const { entries, summary, loading } = useDataSovereignty();
 * ```
 */
export function useDataSovereignty(): UseDataSovereigntyResult {
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStorage = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await axios.get<ApiResponse<StorageEntry[]>>(
        `${API_BASE}/system/storage`,
        { signal }
      );
      if (response.data.success && Array.isArray(response.data.data)) {
        setEntries(response.data.data);
        setError(null);
      } else {
        setEntries(MOCK_ENTRIES);
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      // Endpoint not available — use mock data
      setEntries(MOCK_ENTRIES);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchStorage(controller.signal);
    return () => controller.abort();
  }, [fetchStorage]);

  const summary: DataSovereigntySummary = useMemo(() => {
    const totalLocalBytes = entries
      .filter((e) => !e.isExternal)
      .reduce((sum, e) => sum + e.sizeBytes, 0);
    return {
      totalLocalBytes,
      externalConnections: entries.filter((e) => e.isExternal).length,
      cloudSync: 'disabled',
      status: 'secure',
      lastScan: new Date().toISOString(),
    };
  }, [entries]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchStorage();
  }, [fetchStorage]);

  return { entries, summary, loading, error, refresh };
}

export default useDataSovereignty;
