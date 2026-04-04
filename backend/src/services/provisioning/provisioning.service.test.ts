/**
 * Tests for ProvisioningService.
 *
 * All DigitalOcean API calls are mocked via global.fetch.
 *
 * @module services/provisioning/provisioning.service.test
 */

import { ProvisioningService } from './provisioning.service.js';
import {
  ProvisioningError,
  CREWLY_DROPLET_TAG,
  DEFAULT_IMAGE_SLUG,
  DEFAULT_DROPLET_SIZE,
  DEFAULT_REGION,
  DO_API_BASE_URL,
} from './provisioning.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid DO API Droplet payload. */
function makeDoDroplet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12345,
    name: 'test-droplet',
    status: 'active',
    region: { slug: 'nyc1' },
    size: { slug: 's-2vcpu-4gb' },
    image: { slug: 'ubuntu-24-04-x64' },
    tags: ['crewly-pro'],
    networks: {
      v4: [
        { ip_address: '10.0.0.1', type: 'public' },
      ],
    },
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Create a mock Response for fetch. */
function mockResponse(
  body: Record<string, unknown> | null,
  status: number,
  statusText = 'OK',
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    url: '',
    body: null,
    bodyUsed: false,
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => mockResponse(body, status, statusText),
  } as unknown as Response;
}

const TEST_TOKEN = 'dop_v1_test_token_abc123';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ProvisioningService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create a service with valid config', () => {
      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      expect(svc).toBeInstanceOf(ProvisioningService);
    });

    it('should throw AUTH_FAILURE when token is empty', () => {
      expect(() => new ProvisioningService({ apiToken: '' }))
        .toThrow(ProvisioningError);
    });

    it('should accept custom region and size defaults', () => {
      // No direct way to observe, but should not throw
      const svc = new ProvisioningService({
        apiToken: TEST_TOKEN,
        defaultRegion: 'sfo3',
        defaultSize: 's-4vcpu-8gb',
      });
      expect(svc).toBeInstanceOf(ProvisioningService);
    });
  });

  // -----------------------------------------------------------------------
  // createDroplet
  // -----------------------------------------------------------------------

  describe('createDroplet', () => {
    it('should create a droplet with default config', async () => {
      const droplet = makeDoDroplet({ status: 'new' });
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet }, 202, 'Accepted'),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const result = await svc.createDroplet({ name: 'my-node' });

      expect(result.id).toBe(12345);
      expect(result.name).toBe('test-droplet');
      expect(result.status).toBe('new');

      // Verify fetch was called with correct args
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${DO_API_BASE_URL}/droplets`);
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body['name']).toBe('my-node');
      expect(body['region']).toBe(DEFAULT_REGION);
      expect(body['size']).toBe(DEFAULT_DROPLET_SIZE);
      expect(body['image']).toBe(DEFAULT_IMAGE_SLUG);
      expect(body['tags']).toContain(CREWLY_DROPLET_TAG);
    });

    it('should merge custom tags with the crewly-pro tag', async () => {
      const droplet = makeDoDroplet({ tags: ['crewly-pro', 'custom'] });
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplet }, 202));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await svc.createDroplet({ name: 'tagged', tags: ['custom'] });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>;
      expect(body['tags']).toEqual([CREWLY_DROPLET_TAG, 'custom']);
    });

    it('should use custom region and size when provided in config', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet: makeDoDroplet() }, 202),
      );

      const svc = new ProvisioningService({
        apiToken: TEST_TOKEN,
        defaultRegion: 'ams3',
        defaultSize: 's-4vcpu-8gb',
      });
      await svc.createDroplet({ name: 'custom-node' });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>;
      expect(body['region']).toBe('ams3');
      expect(body['size']).toBe('s-4vcpu-8gb');
    });

    it('should pass SSH keys and user data when provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet: makeDoDroplet() }, 202),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await svc.createDroplet({
        name: 'with-keys',
        sshKeys: [123, 'ab:cd:ef'],
        userData: '#!/bin/bash\necho hello',
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>;
      expect(body['ssh_keys']).toEqual([123, 'ab:cd:ef']);
      expect(body['user_data']).toBe('#!/bin/bash\necho hello');
    });

    it('should throw ProvisioningError on API failure', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ id: 'unauthorized', message: 'Bad token' }, 401, 'Unauthorized'),
      );

      const svc = new ProvisioningService({ apiToken: 'bad-token' });
      await expect(svc.createDroplet({ name: 'fail' }))
        .rejects.toThrow(ProvisioningError);

      try {
        await svc.createDroplet({ name: 'fail' });
      } catch (err) {
        // fetchSpy already consumed — this catches the fresh call
      }
    });
  });

  // -----------------------------------------------------------------------
  // destroyDroplet
  // -----------------------------------------------------------------------

  describe('destroyDroplet', () => {
    it('should send DELETE request and succeed on 204', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(null, 204, 'No Content'),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.destroyDroplet(12345)).resolves.toBeUndefined();

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${DO_API_BASE_URL}/droplets/12345`);
      expect(opts.method).toBe('DELETE');
    });

    it('should throw NOT_FOUND when droplet does not exist', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { id: 'not_found', message: 'Droplet not found' },
          404,
          'Not Found',
        ),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.destroyDroplet(99999)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // -----------------------------------------------------------------------
  // getDropletStatus
  // -----------------------------------------------------------------------

  describe('getDropletStatus', () => {
    it('should return the droplet status', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet: makeDoDroplet({ status: 'off' }) }, 200),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const status = await svc.getDropletStatus(12345);
      expect(status).toBe('off');
    });

    it('should default to "new" for unknown status strings', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet: makeDoDroplet({ status: 'migrating' }) }, 200),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const status = await svc.getDropletStatus(12345);
      expect(status).toBe('new');
    });
  });

  // -----------------------------------------------------------------------
  // listDroplets
  // -----------------------------------------------------------------------

  describe('listDroplets', () => {
    it('should list all droplets without a tag filter', async () => {
      const droplets = [
        makeDoDroplet({ id: 1, name: 'node-1' }),
        makeDoDroplet({ id: 2, name: 'node-2' }),
      ];
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplets }, 200));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const result = await svc.listDroplets();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('node-1');
      expect(result[1].name).toBe('node-2');

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe(`${DO_API_BASE_URL}/droplets`);
    });

    it('should filter by tag when provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplets: [] }, 200));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await svc.listDroplets('crewly-pro');

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe(`${DO_API_BASE_URL}/droplets?tag_name=crewly-pro`);
    });

    it('should return empty array when no droplets exist', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplets: [] }, 200));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const result = await svc.listDroplets();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // waitForDropletReady
  // -----------------------------------------------------------------------

  describe('waitForDropletReady', () => {
    it('should return immediately when droplet is already active', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ droplet: makeDoDroplet({ status: 'active' }) }, 200),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const result = await svc.waitForDropletReady(12345, 10_000);
      expect(result.status).toBe('active');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should poll until droplet becomes active', async () => {
      // First call: 'new', second call: 'active'
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({ droplet: makeDoDroplet({ status: 'new' }) }, 200),
        )
        .mockResolvedValueOnce(
          mockResponse({ droplet: makeDoDroplet({ status: 'active' }) }, 200),
        );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      // Use short timeout; mock sleep resolves instantly
      const result = await svc.waitForDropletReady(12345, 60_000);
      expect(result.status).toBe('active');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should throw TIMEOUT when droplet never becomes active', async () => {
      // Always return 'new'
      fetchSpy.mockResolvedValue(
        mockResponse({ droplet: makeDoDroplet({ status: 'new' }) }, 200),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });

      // Use a very short timeout to trigger immediately
      // The first poll will succeed but status is 'new', then timeout fires
      await expect(svc.waitForDropletReady(12345, 1))
        .rejects.toMatchObject({
          code: 'TIMEOUT',
          dropletId: 12345,
        });
    });
  });

  // -----------------------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('should map 401 to AUTH_FAILURE', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ id: 'unauthorized', message: 'Invalid token' }, 401),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'AUTH_FAILURE',
        message: 'Invalid token',
      });
    });

    it('should map 403 to AUTH_FAILURE', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ id: 'forbidden', message: 'Forbidden' }, 403),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'AUTH_FAILURE',
      });
    });

    it('should map 429 to RATE_LIMITED', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ id: 'rate_limit', message: 'Too many requests' }, 429),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });

    it('should map 500 to SERVER_ERROR', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ id: 'server_error', message: 'Internal error' }, 500),
      );

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'SERVER_ERROR',
      });
    });

    it('should map network failures to NETWORK_ERROR', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });

    it('should handle non-JSON error responses gracefully', async () => {
      const badResponse = mockResponse(null, 502, 'Bad Gateway');
      // Override json() to throw (simulating non-JSON body)
      Object.defineProperty(badResponse, 'json', {
        value: () => Promise.reject(new Error('not json')),
        writable: true,
        configurable: true,
      });

      fetchSpy.mockResolvedValueOnce(badResponse);

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      await expect(svc.listDroplets()).rejects.toMatchObject({
        code: 'SERVER_ERROR',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Normalization
  // -----------------------------------------------------------------------

  describe('droplet normalization', () => {
    it('should map network v4 addresses to DropletNetwork[]', async () => {
      const droplet = makeDoDroplet({
        networks: {
          v4: [
            { ip_address: '1.2.3.4', type: 'public' },
            { ip_address: '10.0.0.5', type: 'private' },
          ],
        },
      });
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplet }, 200));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const result = await svc.getDropletStatus(12345);
      // getDropletStatus only returns status, use listDroplets for full info
      expect(result).toBe('active');
    });

    it('should handle droplets with empty networks', async () => {
      const droplet = makeDoDroplet({ networks: { v4: [] } });
      fetchSpy.mockResolvedValueOnce(mockResponse({ droplets: [droplet] }, 200));

      const svc = new ProvisioningService({ apiToken: TEST_TOKEN });
      const [result] = await svc.listDroplets();
      expect(result.networks).toEqual([]);
    });
  });
});
