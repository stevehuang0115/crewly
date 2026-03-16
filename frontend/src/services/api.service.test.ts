/**
 * Tests for API Service — setupOrchestrator deduplication
 *
 * @module services/api.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiService } from './api.service';

describe('ApiService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setupOrchestrator', () => {
    it('should call fetch and return success result', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Orchestrator created' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await apiService.setupOrchestrator();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Orchestrator created');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/orchestrator/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('should return error result on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Session creation failed' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await apiService.setupOrchestrator();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session creation failed');
    });

    it('should return error result on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await apiService.setupOrchestrator();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should deduplicate concurrent calls — fetch called only once', async () => {
      let resolveFetch!: (value: any) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

      const mockFetch = vi.fn().mockReturnValue(fetchPromise);
      vi.stubGlobal('fetch', mockFetch);

      // Fire 5 concurrent calls (simulating 5 page load triggers)
      const calls = [
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
      ];

      // Resolve the single fetch
      resolveFetch({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Orchestrator created' }),
      });

      const results = await Promise.all(calls);

      // fetch must be called exactly once
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // All 5 callers get the same success result
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.message).toBe('Orchestrator created');
      }
    });

    it('should allow a new call after the previous one completes', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, message: `Call ${callCount}` }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      // First call
      const result1 = await apiService.setupOrchestrator();
      expect(result1.message).toBe('Call 1');

      // Second call after first completes — should trigger a new fetch
      const result2 = await apiService.setupOrchestrator();
      expect(result2.message).toBe('Call 2');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should propagate failure to all concurrent callers', async () => {
      let resolveFetch!: (value: any) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

      const mockFetch = vi.fn().mockReturnValue(fetchPromise);
      vi.stubGlobal('fetch', mockFetch);

      const calls = [
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
        apiService.setupOrchestrator(),
      ];

      resolveFetch({
        ok: false,
        json: () => Promise.resolve({ success: false, error: 'Setup failed' }),
      });

      const results = await Promise.all(calls);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result.success).toBe(false);
        expect(result.error).toBe('Setup failed');
      }
    });
  });
});
