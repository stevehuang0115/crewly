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

  describe('getIntentTaskStatistics', () => {
    it('should return statistics from the API', async () => {
      const mockStats = {
        totalTasks: 5,
        byStatus: { classified: 3, completed: 2 },
        byLevel: { L0: 2, L1: 3 },
        totalTokens: 1500,
        totalCost: 0.05,
        llmCost: 0.04,
        skillCost: 0.01,
        totalMessages: 3,
      };

      const axios = await import('axios');
      vi.spyOn(axios.default, 'get').mockResolvedValue({
        data: { success: true, data: mockStats },
      });

      const result = await apiService.getIntentTaskStatistics();

      expect(result).toEqual(mockStats);
      expect(axios.default.get).toHaveBeenCalledWith('/api/intent-tasks/statistics');
    });

    it('should throw on failure response', async () => {
      const axios = await import('axios');
      vi.spyOn(axios.default, 'get').mockResolvedValue({
        data: { success: false, error: 'Service unavailable' },
      });

      await expect(apiService.getIntentTaskStatistics()).rejects.toThrow('Service unavailable');
    });
  });

  describe('getWorkItem', () => {
    // Regression: pre-fix, this called `/api/task-pool/${id}` which has no
    // backend handler (the route registry only mounts
    // `/api/task-pool/items/:id` for single-item lookup). Express returned
    // 404 HTML, axios rejected, and every WorkItem detail page rendered
    // empty — including from the WorkItems list and Request Detail timeline.
    it('hits /api/task-pool/items/:id (the registered single-item route), not /api/task-pool/:id', async () => {
      const wi = { id: 'wi-test-1', status: 'queued', title: 'Hello' };
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'get').mockResolvedValue({
        data: { success: true, data: wi },
      });

      const result = await apiService.getWorkItem('wi-test-1');

      expect(result).toEqual(wi);
      expect(spy).toHaveBeenCalledWith('/api/task-pool/items/wi-test-1');
    });

    it('throws when the response indicates failure', async () => {
      const axios = await import('axios');
      vi.spyOn(axios.default, 'get').mockResolvedValue({
        data: { success: false, error: 'WorkItem not found: wi-missing' },
      });

      await expect(apiService.getWorkItem('wi-missing')).rejects.toThrow('Work item not found');
    });
  });
  describe('mission OKR cascade endpoints', () => {
    it('getKeyResults hits /api/missions/:id/key-results and tolerates a non-array payload', async () => {
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'get').mockResolvedValue({ data: { success: true, data: [{ id: 'kr-1' }] } });
      expect(await apiService.getKeyResults('m-1')).toEqual([{ id: 'kr-1' }]);
      expect(spy).toHaveBeenCalledWith('/api/missions/m-1/key-results');

      spy.mockResolvedValue({ data: { success: true, data: null } });
      expect(await apiService.getKeyResults('m-1')).toEqual([]);
    });

    it('createKeyResult posts the body and unwraps the KR', async () => {
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'post').mockResolvedValue({ data: { success: true, data: { id: 'kr-1' } } });
      const input = { title: 'MRR', metricType: 'currency' as const, baseline: 0, target: 5000, unit: '$' };
      expect(await apiService.createKeyResult('m-1', input)).toEqual({ id: 'kr-1' });
      expect(spy).toHaveBeenCalledWith('/api/missions/m-1/key-results', input);
    });

    it('updateKeyResult / deleteKeyResult target /key-results/:krId', async () => {
      const axios = await import('axios');
      const put = vi.spyOn(axios.default, 'put').mockResolvedValue({ data: { success: true, data: { id: 'kr-1', target: 9 } } });
      const del = vi.spyOn(axios.default, 'delete').mockResolvedValue({ data: { success: true } });
      expect(await apiService.updateKeyResult('m-1', 'kr-1', { target: 9 })).toEqual({ id: 'kr-1', target: 9 });
      expect(put).toHaveBeenCalledWith('/api/missions/m-1/key-results/kr-1', { target: 9 });
      await apiService.deleteKeyResult('m-1', 'kr-1');
      expect(del).toHaveBeenCalledWith('/api/missions/m-1/key-results/kr-1');
    });

    it('measureKeyResult posts to /measure and surfaces the server error', async () => {
      const axios = await import('axios');
      const measurement = { value: 42, measuredAt: '2026-09-18T00:00:00.000Z', source: 'api', note: 'weekly' };
      const spy = vi.spyOn(axios.default, 'post').mockResolvedValue({ data: { success: true, data: measurement } });
      expect(await apiService.measureKeyResult('m-1', 'kr-1', { value: 42, note: 'weekly' })).toEqual(measurement);
      expect(spy).toHaveBeenCalledWith('/api/missions/m-1/key-results/kr-1/measure', { value: 42, note: 'weekly' });

      spy.mockResolvedValue({ data: { success: false, error: 'value must be a number' } });
      await expect(apiService.measureKeyResult('m-1', 'kr-1', { value: NaN })).rejects.toThrow('value must be a number');
    });

    it('getOkrSummary / getCascadeSummary / getMissionProgress hit their routes', async () => {
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'get').mockResolvedValue({ data: { success: true, data: { missionId: 'm-1' } } });
      await apiService.getOkrSummary('m-1');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/m-1/okr-summary');
      await apiService.getCascadeSummary('m-1');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/m-1/okr-summary/cascade');
      await apiService.getMissionProgress('m-1');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/m-1/progress');
    });

    it('getProposals lists pending children of a parent', async () => {
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'get').mockResolvedValue({ data: { success: true, data: [{ id: 'child' }], count: 1 } });
      expect(await apiService.getProposals('parent')).toEqual([{ id: 'child' }]);
      expect(spy).toHaveBeenCalledWith('/api/missions/parent/proposals');
    });

    it('approveMission / rejectMission post the decision (reject carries the reason)', async () => {
      const axios = await import('axios');
      const spy = vi.spyOn(axios.default, 'post').mockResolvedValue({ data: { success: true, data: { id: 'child' } } });
      await apiService.approveMission('child');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/child/approve', {});
      await apiService.approveMission('child', 'steve');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/child/approve', { decidedBy: 'steve' });
      await apiService.rejectMission('child', 'Too vague');
      expect(spy).toHaveBeenLastCalledWith('/api/missions/child/reject', { reason: 'Too vague' });

      spy.mockResolvedValue({ data: { success: false, error: 'Cannot approve a mission in state "approved"' } });
      await expect(apiService.approveMission('child')).rejects.toThrow('Cannot approve');
    });
  });

  describe('startTeam', () => {
    it('throws the server reason when no member could start (424), not the bare axios status text', async () => {
      const axios = await import('axios');
      const reason = 'No team member could start. Dev: Gemini CLI is not signed in: it is asking how to authenticate.';
      const failure = Object.assign(new Error('Request failed with status code 424'), {
        isAxiosError: true,
        response: { status: 424, data: { success: false, error: reason } },
      });
      vi.spyOn(axios.default, 'post').mockRejectedValue(failure);

      await expect(apiService.startTeam('t1')).rejects.toThrow(reason);
    });

    it('rethrows a failure without a server reason unchanged', async () => {
      const axios = await import('axios');
      const network = new Error('Network Error');
      vi.spyOn(axios.default, 'post').mockRejectedValue(network);

      await expect(apiService.startTeam('t1')).rejects.toBe(network);
    });
  });
});
