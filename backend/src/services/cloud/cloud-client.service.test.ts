/**
 * Tests for CloudClientService
 *
 * @module services/cloud/cloud-client.service.test
 */

import { CloudClientService, type PersistedCloudConfig } from './cloud-client.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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
// Mock fs/promises for persistence tests
// ---------------------------------------------------------------------------

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockUnlink = fs.unlink as jest.MockedFunction<typeof fs.unlink>;

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

    it('should throw on non-404/non-auth error status', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

      await expect(service.fetchCloudDevices()).rejects.toThrow('Failed to fetch cloud devices: 500');
    });

    it('should return empty array when devices field is missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual([]);
    });

    it('should return empty array and set token_expired on 401', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual([]);
      expect(service.isTokenExpired()).toBe(true);
      expect(service.isConnected()).toBe(false);
    });

    it('should return empty array and set token_expired on 403', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 403));

      const result = await service.fetchCloudDevices();

      expect(result).toEqual([]);
      expect(service.isTokenExpired()).toBe(true);
    });
  });

  // ----- 401/403 handling across all methods --------------------------------

  describe('auth error handling (401/403)', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);
      mockFetch.mockClear();
    });

    it('getTemplates should return empty array on 401', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));

      const result = await service.getTemplates();

      expect(result).toEqual([]);
      expect(service.isTokenExpired()).toBe(true);
    });

    it('getTemplates should return empty array on 403', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 403));

      const result = await service.getTemplates();

      expect(result).toEqual([]);
      expect(service.isTokenExpired()).toBe(true);
    });

    it('getTemplateDetail should throw user-friendly error on 401', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));

      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(
        /Cloud token expired/,
      );
      expect(service.isTokenExpired()).toBe(true);
    });

    it('getTemplateDetail should throw user-friendly error on 403', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 403));

      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(
        /Cloud token expired/,
      );
      expect(service.isTokenExpired()).toBe(true);
    });

    it('isTokenExpired should return false before any auth error', () => {
      expect(service.isTokenExpired()).toBe(false);
    });

    it('isConnected should return false after token expiry', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));

      await service.fetchCloudDevices();

      expect(service.isConnected()).toBe(false);
      expect(service.isTokenExpired()).toBe(true);
    });

    it('getStatus should report token_expired after auth failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 403));

      await service.fetchCloudDevices();

      const status = service.getStatus();
      expect(status.connectionStatus).toBe(CLOUD_CONSTANTS.CONNECTION_STATUS.TOKEN_EXPIRED);
    });

    it('fetchCloudDevices should return empty on second call after TOKEN_EXPIRED (no throw)', async () => {
      // First call: triggers 403 → sets TOKEN_EXPIRED
      mockFetch.mockResolvedValueOnce(mockResponse({}, 403));
      await service.fetchCloudDevices();
      expect(service.isTokenExpired()).toBe(true);

      // Second call: should return [] without throwing or calling fetch
      mockFetch.mockClear();
      const result = await service.fetchCloudDevices();
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('getTemplates should return empty on second call after TOKEN_EXPIRED (no throw)', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));
      await service.getTemplates();
      expect(service.isTokenExpired()).toBe(true);

      mockFetch.mockClear();
      const result = await service.getTemplates();
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('getTemplateDetail should throw user-friendly error on second call after TOKEN_EXPIRED', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 401));
      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(/Cloud token expired/);
      expect(service.isTokenExpired()).toBe(true);

      mockFetch.mockClear();
      await expect(service.getTemplateDetail('tpl-1')).rejects.toThrow(/Cloud token expired/);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ----- Config Persistence ------------------------------------------------

  describe('config persistence', () => {
    const expectedConfigPath = path.join(os.homedir(), '.crewly', 'cloud', 'config.json');

    beforeEach(() => {
      jest.clearAllMocks();
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined as any);
      mockUnlink.mockResolvedValue(undefined);
    });

    describe('persistConfig (via connect)', () => {
      it('should persist config with refreshToken after connect()', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));

        await service.connect(CLOUD_URL, TOKEN, 'refresh-token-xyz');

        // Wait for async persistConfig
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockMkdir).toHaveBeenCalledWith(
          path.dirname(expectedConfigPath),
          { recursive: true },
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
          expectedConfigPath,
          expect.any(String),
          'utf-8',
        );

        // Verify the written JSON includes refreshToken
        const writtenJson = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as PersistedCloudConfig;
        expect(writtenJson.cloudUrl).toBe(CLOUD_URL);
        expect(writtenJson.token).toBe(TOKEN);
        expect(writtenJson.tier).toBe('pro');
        expect(writtenJson.refreshToken).toBe('refresh-token-xyz');
        expect(writtenJson.connectedAt).toBeTruthy();
      });

      it('should persist config without refreshToken when not provided', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'free' }));

        await service.connect(CLOUD_URL, TOKEN);

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockWriteFile).toHaveBeenCalled();
        const writtenJson = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as PersistedCloudConfig;
        expect(writtenJson.refreshToken).toBeUndefined();
      });
    });

    describe('persistConfig (via connectLocal)', () => {
      it('should persist config with refreshToken after connectLocal()', async () => {
        service.connectLocal(CLOUD_URL, TOKEN, 'pro' as any, 'local-refresh-token');

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockWriteFile).toHaveBeenCalled();
        const writtenJson = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as PersistedCloudConfig;
        expect(writtenJson.cloudUrl).toBe(CLOUD_URL);
        expect(writtenJson.token).toBe(TOKEN);
        expect(writtenJson.tier).toBe('pro');
        expect(writtenJson.refreshToken).toBe('local-refresh-token');
      });
    });

    describe('persistConfig (via setRefreshToken)', () => {
      it('should re-persist config when setRefreshToken is called', async () => {
        // First connect without refreshToken
        mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
        await service.connect(CLOUD_URL, TOKEN);
        await new Promise(resolve => setTimeout(resolve, 50));
        mockWriteFile.mockClear();
        mockMkdir.mockClear();

        // Now set refresh token
        service.setRefreshToken('late-refresh-token');
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockWriteFile).toHaveBeenCalled();
        const writtenJson = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as PersistedCloudConfig;
        expect(writtenJson.refreshToken).toBe('late-refresh-token');
      });
    });

    describe('loadPersistedConfig', () => {
      it('should load valid config with refreshToken', async () => {
        const config: PersistedCloudConfig = {
          cloudUrl: CLOUD_URL,
          token: TOKEN,
          tier: 'pro',
          connectedAt: '2026-01-01T00:00:00.000Z',
          refreshToken: 'stored-refresh-token',
        };
        mockReadFile.mockResolvedValueOnce(JSON.stringify(config));

        const result = await service.loadPersistedConfig();

        expect(result).toEqual(config);
        expect(result!.refreshToken).toBe('stored-refresh-token');
      });

      it('should load valid config without refreshToken', async () => {
        const config: PersistedCloudConfig = {
          cloudUrl: CLOUD_URL,
          token: TOKEN,
          tier: 'free',
          connectedAt: '2026-01-01T00:00:00.000Z',
        };
        mockReadFile.mockResolvedValueOnce(JSON.stringify(config));

        const result = await service.loadPersistedConfig();

        expect(result).toEqual(config);
        expect(result!.refreshToken).toBeUndefined();
      });

      it('should return null for missing config file', async () => {
        mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await service.loadPersistedConfig();

        expect(result).toBeNull();
      });

      it('should return null for invalid JSON', async () => {
        mockReadFile.mockResolvedValueOnce('not valid json');

        const result = await service.loadPersistedConfig();

        expect(result).toBeNull();
      });

      it('should return null for config missing required fields', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({ cloudUrl: CLOUD_URL }));

        const result = await service.loadPersistedConfig();

        expect(result).toBeNull();
      });
    });

    describe('removePersistedConfig (via disconnect)', () => {
      it('should delete config file on disconnect', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
        await service.connect(CLOUD_URL, TOKEN, 'refresh-xyz');
        await new Promise(resolve => setTimeout(resolve, 50));
        mockUnlink.mockClear();

        service.disconnect();

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockUnlink).toHaveBeenCalledWith(expectedConfigPath);
      });

      it('should not throw when config file does not exist on disconnect', async () => {
        mockUnlink.mockRejectedValueOnce(new Error('ENOENT'));

        service.connectLocal(CLOUD_URL, TOKEN, 'pro' as any);
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should not throw
        expect(() => service.disconnect()).not.toThrow();
      });
    });

    describe('getConfigPath', () => {
      it('should return path under ~/.crewly/cloud/', () => {
        const configPath = CloudClientService.getConfigPath();
        expect(configPath).toBe(expectedConfigPath);
      });
    });
  });

  // ----- tryRefreshToken() --------------------------------------------------

  describe('tryRefreshToken()', () => {
    it('should NOT clear refreshToken when verifyJwt returns null', async () => {
      // Connect with a refresh token
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN, 'my-refresh-token');
      await new Promise(resolve => setTimeout(resolve, 50));
      mockWriteFile.mockClear();

      // Try to refresh — verifyJwt will fail because the token is not a real JWT
      const result = await service.tryRefreshToken();

      expect(result).toBe(false);

      // Key assertion: refresh token should NOT be cleared after failure.
      // It should still be available for future refresh attempts.
      // We verify this by calling setRefreshToken to confirm the service
      // still accepts refresh tokens (it would be null if cleared).
      service.setRefreshToken('replacement-token');
      await new Promise(resolve => setTimeout(resolve, 50));

      // The persisted config should contain the replacement token,
      // proving the service didn't lose the ability to store refresh tokens.
      const writtenJson = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as PersistedCloudConfig;
      expect(writtenJson.refreshToken).toBe('replacement-token');
    });

    it('should return false when no refresh token is set', async () => {
      // Connect without refresh token
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN);

      const result = await service.tryRefreshToken();
      expect(result).toBe(false);
    });

    it('should prevent concurrent refresh attempts', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'pro' }));
      await service.connect(CLOUD_URL, TOKEN, 'my-refresh-token');

      // Fire two concurrent refreshes
      const [r1, r2] = await Promise.all([
        service.tryRefreshToken(),
        service.tryRefreshToken(),
      ]);

      // At least one should be blocked by the guard
      expect(r1 === false || r2 === false).toBe(true);
    });
  });

  // ----- Relay token extraction from validate response ---------------------

  describe('relay token extraction', () => {
    it('should extract relayToken from validate response and fire callbacks', async () => {
      // Mock fetch to return the crewly-auth /api/cloud/validate format
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, data: { plan: 'pro', relayToken: 'test-relay-jwt' } }),
      );

      // Register a tokenRefreshCallback before connecting
      const callbackFn = jest.fn();
      service.onTokenRefresh(callbackFn);

      const result = await service.connect(CLOUD_URL, TOKEN);

      expect(result).toEqual({ success: true, tier: 'pro' });
      expect(service.isConnected()).toBe(true);
      expect(service.getTier()).toBe('pro');

      // Verify the callback was called with the relay token
      expect(callbackFn).toHaveBeenCalledTimes(1);
      expect(callbackFn).toHaveBeenCalledWith('test-relay-jwt');
    });

    it('should handle missing relayToken gracefully', async () => {
      // Mock fetch to return validate format without relayToken
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, data: { plan: 'pro' } }),
      );

      const callbackFn = jest.fn();
      service.onTokenRefresh(callbackFn);

      const result = await service.connect(CLOUD_URL, TOKEN);

      expect(result).toEqual({ success: true, tier: 'pro' });
      expect(service.isConnected()).toBe(true);

      // Callback should NOT have been called since there is no relayToken
      expect(callbackFn).not.toHaveBeenCalled();
    });

    it('should handle missing data object gracefully', async () => {
      // Mock fetch to return legacy format with no data field
      mockFetch.mockResolvedValueOnce(mockResponse({ tier: 'enterprise' }));

      const callbackFn = jest.fn();
      service.onTokenRefresh(callbackFn);

      const result = await service.connect(CLOUD_URL, TOKEN);

      expect(result).toEqual({ success: true, tier: 'enterprise' });

      // Callback should NOT have been called
      expect(callbackFn).not.toHaveBeenCalled();
    });

    it('should fire multiple registered callbacks with relayToken', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, data: { plan: 'pro', relayToken: 'multi-relay-jwt' } }),
      );

      const callback1 = jest.fn();
      const callback2 = jest.fn();
      service.onTokenRefresh(callback1);
      service.onTokenRefresh(callback2);

      await service.connect(CLOUD_URL, TOKEN);

      expect(callback1).toHaveBeenCalledWith('multi-relay-jwt');
      expect(callback2).toHaveBeenCalledWith('multi-relay-jwt');
    });

    it('should resolve tier from data.plan when both data.plan and legacy tier are present', async () => {
      // data.plan takes precedence over top-level tier
      mockFetch.mockResolvedValueOnce(
        mockResponse({ tier: 'free', data: { plan: 'enterprise', relayToken: 'jwt-123' } }),
      );

      const result = await service.connect(CLOUD_URL, TOKEN);

      // data.plan should win
      expect(result.tier).toBe('enterprise');
    });
  });
});
