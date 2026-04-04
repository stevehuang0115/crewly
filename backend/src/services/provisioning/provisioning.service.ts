/**
 * DigitalOcean Provisioning Service
 *
 * Wraps the DigitalOcean REST API v2 for automated Droplet lifecycle
 * management. Provides create, destroy, status, list, and wait-for-ready
 * operations with structured error handling.
 *
 * All API interactions use the native `fetch` API — no external HTTP
 * libraries required.
 *
 * @module services/provisioning/provisioning.service
 */

import {
  type ProvisioningServiceConfig,
  type CreateDropletConfig,
  type DropletInfo,
  type DropletStatus,
  type DropletNetwork,
  type DoApiDroplet,
  type DoApiDropletResponse,
  type DoApiDropletsListResponse,
  type DoApiErrorResponse,
  type ProvisioningErrorCode,
  ProvisioningError,
  isDropletStatus,
  DO_API_BASE_URL,
  DEFAULT_IMAGE_SLUG,
  DEFAULT_DROPLET_SIZE,
  DEFAULT_REGION,
  CREWLY_DROPLET_TAG,
  DEFAULT_READY_TIMEOUT_MS,
  POLLING_INTERVAL_MS,
} from './provisioning.types.js';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for managing DigitalOcean Droplets via the REST API v2.
 *
 * @example
 * ```typescript
 * const svc = new ProvisioningService({ apiToken: 'dop_v1_xxx' });
 * const droplet = await svc.createDroplet({ name: 'my-node' });
 * const ready = await svc.waitForDropletReady(droplet.id);
 * console.log(ready.networks); // [{ ipAddress: '...', type: 'public' }]
 * ```
 */
export class ProvisioningService {
  private readonly apiToken: string;
  private readonly defaultRegion: string;
  private readonly defaultSize: string;

  /**
   * Create a new ProvisioningService.
   *
   * @param config - Service configuration
   * @param config.apiToken - DigitalOcean personal access token
   * @param config.defaultRegion - Default region slug (defaults to nyc1)
   * @param config.defaultSize - Default size slug (defaults to s-2vcpu-4gb)
   */
  constructor(config: ProvisioningServiceConfig) {
    if (!config.apiToken) {
      throw new ProvisioningError('AUTH_FAILURE', 'API token is required');
    }
    this.apiToken = config.apiToken;
    this.defaultRegion = config.defaultRegion ?? DEFAULT_REGION;
    this.defaultSize = config.defaultSize ?? DEFAULT_DROPLET_SIZE;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Create a new DigitalOcean Droplet.
   *
   * The Droplet is always tagged with the `crewly-pro` tag. Additional tags
   * may be specified via `config.tags`.
   *
   * @param config - Droplet creation configuration
   * @returns Normalized Droplet info after creation (status will be 'new')
   * @throws {ProvisioningError} On API failure
   *
   * @example
   * ```typescript
   * const info = await svc.createDroplet({
   *   name: 'worker-1',
   *   region: 'sfo3',
   *   userData: '#!/bin/bash\napt-get update',
   * });
   * ```
   */
  async createDroplet(config: CreateDropletConfig): Promise<DropletInfo> {
    const tags = [CREWLY_DROPLET_TAG, ...(config.tags ?? [])];

    const body = {
      name: config.name,
      region: config.region ?? this.defaultRegion,
      size: config.size ?? this.defaultSize,
      image: config.image ?? DEFAULT_IMAGE_SLUG,
      tags,
      user_data: config.userData,
      ssh_keys: config.sshKeys,
    };

    const response = await this.doRequest<DoApiDropletResponse>(
      '/droplets',
      'POST',
      body,
    );
    return this.normalizeDroplet(response.droplet);
  }

  /**
   * Destroy (permanently delete) a Droplet by ID.
   *
   * @param dropletId - The Droplet ID to destroy
   * @throws {ProvisioningError} On API failure (e.g. NOT_FOUND)
   */
  async destroyDroplet(dropletId: number): Promise<void> {
    await this.doRequest(`/droplets/${dropletId}`, 'DELETE');
  }

  /**
   * Get the current status of a Droplet.
   *
   * @param dropletId - The Droplet ID to query
   * @returns The Droplet's current status
   * @throws {ProvisioningError} On API failure
   */
  async getDropletStatus(dropletId: number): Promise<DropletStatus> {
    const response = await this.doRequest<DoApiDropletResponse>(
      `/droplets/${dropletId}`,
      'GET',
    );
    const status = response.droplet.status;
    if (isDropletStatus(status)) {
      return status;
    }
    return 'new';
  }

  /**
   * List Droplets, optionally filtered by tag.
   *
   * @param tag - Tag to filter by (defaults to listing all Droplets)
   * @returns Array of normalized Droplet info objects
   * @throws {ProvisioningError} On API failure
   */
  async listDroplets(tag?: string): Promise<DropletInfo[]> {
    const queryParams = tag ? `?tag_name=${encodeURIComponent(tag)}` : '';
    const response = await this.doRequest<DoApiDropletsListResponse>(
      `/droplets${queryParams}`,
      'GET',
    );
    return response.droplets.map((d) => this.normalizeDroplet(d));
  }

  /**
   * Poll until a Droplet reaches the 'active' status.
   *
   * @param dropletId - The Droplet ID to watch
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 300s)
   * @returns Normalized Droplet info once active
   * @throws {ProvisioningError} With code 'TIMEOUT' if the Droplet does not
   *   become active within the timeout period
   *
   * @example
   * ```typescript
   * const ready = await svc.waitForDropletReady(droplet.id, 60_000);
   * ```
   */
  async waitForDropletReady(
    dropletId: number,
    timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
  ): Promise<DropletInfo> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const response = await this.doRequest<DoApiDropletResponse>(
        `/droplets/${dropletId}`,
        'GET',
      );
      const droplet = this.normalizeDroplet(response.droplet);
      if (droplet.status === 'active') {
        return droplet;
      }
      await this.sleep(POLLING_INTERVAL_MS);
    }

    throw new ProvisioningError(
      'TIMEOUT',
      `Droplet ${dropletId} did not become active within ${timeoutMs}ms`,
      dropletId,
    );
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  /**
   * Make an authenticated request to the DigitalOcean API.
   *
   * @param path - API path (e.g. '/droplets')
   * @param method - HTTP method
   * @param body - Optional request body (will be JSON-serialized)
   * @returns Parsed JSON response body
   * @throws {ProvisioningError} On HTTP errors or network failures
   */
  private async doRequest<T>(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${DO_API_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProvisioningError('NETWORK_ERROR', `Network request failed: ${message}`);
    }

    // DELETE returns 204 No Content on success
    if (method === 'DELETE' && response.status === 204) {
      return undefined as unknown as T;
    }

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const data: unknown = await response.json();
    return data as T;
  }

  /**
   * Map an HTTP error response to a structured ProvisioningError.
   *
   * @param response - The failed fetch Response
   * @throws {ProvisioningError} Always throws
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `DigitalOcean API error: ${response.status} ${response.statusText}`;

    try {
      const errorBody = (await response.json()) as DoApiErrorResponse;
      if (errorBody.message) {
        errorMessage = errorBody.message;
      }
    } catch {
      // Ignore JSON parse errors — use default message
    }

    const code = this.mapHttpStatusToErrorCode(response.status);
    throw new ProvisioningError(code, errorMessage);
  }

  /**
   * Map an HTTP status code to a ProvisioningErrorCode.
   *
   * @param status - HTTP status code
   * @returns Corresponding error code
   */
  private mapHttpStatusToErrorCode(status: number): ProvisioningErrorCode {
    if (status === 401 || status === 403) {
      return 'AUTH_FAILURE';
    }
    if (status === 404) {
      return 'NOT_FOUND';
    }
    if (status === 429) {
      return 'RATE_LIMITED';
    }
    if (status >= 500) {
      return 'SERVER_ERROR';
    }
    return 'UNKNOWN';
  }

  /**
   * Normalize a raw DO API Droplet object into our DropletInfo shape.
   *
   * @param raw - Raw Droplet from the DO API
   * @returns Normalized DropletInfo
   */
  private normalizeDroplet(raw: DoApiDroplet): DropletInfo {
    const networks: DropletNetwork[] = (raw.networks?.v4 ?? []).map((n) => ({
      ipAddress: n.ip_address,
      type: n.type === 'private' ? 'private' as const : 'public' as const,
    }));

    const status: DropletStatus = isDropletStatus(raw.status) ? raw.status : 'new';

    return {
      id: raw.id,
      name: raw.name,
      status,
      region: raw.region?.slug ?? '',
      size: raw.size?.slug ?? '',
      image: raw.image?.slug ?? '',
      tags: raw.tags ?? [],
      networks,
      createdAt: raw.created_at,
    };
  }

  /**
   * Sleep for a given number of milliseconds.
   *
   * @param ms - Duration in milliseconds
   * @returns Promise that resolves after the delay
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
