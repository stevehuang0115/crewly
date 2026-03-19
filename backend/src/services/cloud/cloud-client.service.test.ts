/**
 * Tests for CloudClientService
 *
 * @module services/cloud/cloud-client.service.test
 */

import { CloudClientService } from './cloud-client.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Mock LoggerService
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn() as jest.MockedFunction<typeof global.fetch>;
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLOUD_URL = 'https://api.crewlyai.com';
const TOKEN = 'test-token-abc';

/** Create a mock Response object. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudClientService', () => {
  let service: CloudClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    CloudClientService.resetInstance();
    service = CloudClientService.getInstance();
  });

  // ----- Singleton --------------------------------------------------------

  describe('singleton', () => {
    it('should return the same instance on subsequent calls', () => {
      const a = CloudClientService.getInstance();
      const b = CloudClientService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a new instance after resetInstance()', () => {
      const a = CloudClientService.getInstance();
      CloudClientService.resetInstance();
      const b = CloudClientService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ----- connect() --------------------------------------------------------

  describe('connect()', () => {
    it('should authenticate and set connected state', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));

      const result = await service.connect(CLOUD_URL, TOKEN);

      expect(result).toEqual({ success: true, tier: 'pro' });
      expect(service.isConnected()).toBe(true);
      expect(service.getTier()).toBe('pro');

      // Verify fetch was called with correct URL and headers
      expect(mockFetch).toHaveBeenCalledWith(
        `${CLOUD_URL}${CLOUD_CONSTANTS.ENDPOINTS.AUTH_TOKEN}`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
          }),
        }),
      );
    });

    it('should default to free tier when cloud does not specify tier', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      const result = await service.connect(CLOUD_URL, TOKEN);

      expect(result.tier).toBe('free');
    });

    it('should throw and set error status on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401));

      await expect(service.connect(CLOUD_URL, TOKEN)).rejects.toThrow(
        /Cloud authentication failed: 401/,
      );
      expect(service.isConnected()).toBe(false);

      const status = service.getStatus();
      expect(status.connectionStatus).toBe(CLOUD_CONSTANTS.CONNECTION_STATUS.ERROR);
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

      await expect(service.connect(CLOUD_URL, TOKEN)).rejects.toThrow('Network unreachable');
    });
  });

  // ----- disconnect() -----------------------------------------------------

  describe('disconnect()', () => {
    it('should clear connection state', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);

      service.disconnect();

      expect(service.isConnected()).toBe(false);
      expect(service.getTier()).toBe('free');

      const status = service.getStatus();
      expect(status.connectionStatus).toBe(CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED);
      expect(status.cloudUrl).toBeNull();
      expect(status.lastSyncAt).toBeNull();
    });
  });

  // ----- getTemplates() ---------------------------------------------------

  describe('getTemplates()', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);
    });

    it('should return template list from cloud', async () => {
      const templates = [
        { id: '1', name: 'TikTok Ops', description: 'desc', requiredTier: 'pro', category: 'social' },
        { id: '2', name: 'DevOps Team', description: 'desc2', requiredTier: 'enterprise', category: 'dev' },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ templates }));

      const result = await service.getTemplates();

      expect(result).toEqual(templates);
      expect(mockFetch).toHaveBeenLastCalledWith(
        `${CLOUD_URL}${CLOUD_CONSTANTS.ENDPOINTS.TEMPLATES}`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
          }),
        }),
      );
    });

    it('should return empty array when cloud returns no templates field', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      const result = await service.getTemplates();
      expect(result).toEqual([]);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Server Error', 500));

      await expect(service.getTemplates()).rejects.toThrow(/Failed to fetch templates: 500/);
    });

    it('should throw when not connected', async () => {
      service.disconnect();

      await expect(service.getTemplates()).rejects.toThrow(/Not connected to CrewlyAI Cloud/);
    });
  });

  // ----- getTemplateDetail() ----------------------------------------------

  describe('getTemplateDetail()', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);
    });

    it('should return template detail', async () => {
      const detail = {
        id: 'tpl-1',
        name: 'TikTok Ops',
        description: 'Full desc',
        requiredTier: 'pro',
        category: 'social',
        roles: [{ role: 'content-writer', prompt: 'Write content' }],
        orchestration: { strategy: 'sequential' },
      };
      mockFetch.mockResolvedValueOnce(mockResponse(detail));

      const result = await service.getTemplateDetail('tpl-1');

      expect(result).toEqual(detail);
      expect(mockFetch).toHaveBeenLastCalledWith(
        `${CLOUD_URL}/v1/templates/premium/tpl-1`,
        expect.anything(),
      );
    });

    it('should throw with descriptive message on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404));

      await expect(service.getTemplateDetail('nonexistent')).rejects.toThrow(
        /Template not found: nonexistent/,
      );
    });

    it('should throw on server error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Error', 500));

      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(
        /Failed to fetch template detail: 500/,
      );
    });

    it('should throw when not connected', async () => {
      service.disconnect();

      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(
        /Not connected to CrewlyAI Cloud/,
      );
    });
  });

  // ----- getStatus() ------------------------------------------------------

  describe('getStatus()', () => {
    it('should return disconnected status initially', () => {
      const status = service.getStatus();

      expect(status).toEqual({
        connectionStatus: CLOUD_CONSTANTS.CONNECTION_STATUS.DISCONNECTED,
        cloudUrl: null,
        tier: 'free',
        lastSyncAt: null,
      });
    });

    it('should return connected status after connect', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'enterprise' }));
      await service.connect(CLOUD_URL, TOKEN);

      const status = service.getStatus();

      expect(status.connectionStatus).toBe(CLOUD_CONSTANTS.CONNECTION_STATUS.CONNECTED);
      expect(status.cloudUrl).toBe(CLOUD_URL);
      expect(status.tier).toBe('enterprise');
      expect(status.lastSyncAt).toBeTruthy();
    });
  });

  // ----- isConnected() / getTier() ----------------------------------------

  describe('isConnected()', () => {
    it('should return false initially', () => {
      expect(service.isConnected()).toBe(false);
    });

    it('should return true after successful connect', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);
      expect(service.isConnected()).toBe(true);
    });
  });

  describe('getTier()', () => {
    it('should return free initially', () => {
      expect(service.getTier()).toBe('free');
    });
  });

  // ----- fetchCloudDevices() -----------------------------------------------

  describe('fetchCloudDevices()', () => {
    beforeEach(async () => {
      // Connect first so ensureConnected() passes
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);
      mockFetch.mockClear();
    });

    it('should return devices on success', async () => {
      const devices = [{ sessionId: 's1', name: 'Device 1', connectedAt: '2026-01-01' }];
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true, devices }));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual(devices);
      expect(mockFetch).toHaveBeenCalledWith(
        `${CLOUD_URL}${CLOUD_CONSTANTS.RELAY_ENDPOINTS.DEVICES}`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return empty array when cloud returns 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 404));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual([]);
    });

    it('should throw on non-404 error status', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

      await expect(service.fetchCloudDevices()).rejects.toThrow('Failed to fetch cloud devices: 500');
    });

    it('should return empty array when devices field is missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual([]);
    });
  });
});
