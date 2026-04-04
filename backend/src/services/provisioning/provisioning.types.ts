/**
 * Provisioning Types
 *
 * TypeScript type definitions for the DigitalOcean provisioning service.
 * Includes configuration, Droplet models, error types, and type guards.
 *
 * @module services/provisioning/provisioning.types
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Ubuntu 24.04 LTS image slug for DigitalOcean. */
export const DEFAULT_IMAGE_SLUG = 'ubuntu-24-04-x64';

/** Default Droplet size (2 vCPUs, 4 GB RAM). */
export const DEFAULT_DROPLET_SIZE = 's-2vcpu-4gb';

/** Default region for new Droplets. */
export const DEFAULT_REGION = 'nyc1';

/** Tag applied to all Crewly-managed Droplets. */
export const CREWLY_DROPLET_TAG = 'crewly-pro';

/** DigitalOcean API v2 base URL. */
export const DO_API_BASE_URL = 'https://api.digitalocean.com/v2';

/** Default timeout (in ms) for waitForDropletReady polling. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Polling interval (in ms) for waitForDropletReady. */
export const POLLING_INTERVAL_MS = 5_000;

/** Firewall ports opened on Crewly Droplets. */
export const CREWLY_FIREWALL_PORTS = {
  SSH: 22,
  WEB_UI: 8787,
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the ProvisioningService constructor.
 *
 * @param apiToken - DigitalOcean personal access token
 * @param defaultRegion - Region slug for new Droplets (default: nyc1)
 * @param defaultSize - Size slug for new Droplets (default: s-2vcpu-4gb)
 */
export interface ProvisioningServiceConfig {
  /** DigitalOcean personal access token. */
  apiToken: string;
  /** Region slug override (e.g. 'sfo3', 'ams3'). */
  defaultRegion?: string;
  /** Size slug override (e.g. 's-4vcpu-8gb'). */
  defaultSize?: string;
}

// ---------------------------------------------------------------------------
// Droplet Models
// ---------------------------------------------------------------------------

/** Valid Droplet status values as reported by the DO API. */
export type DropletStatus = 'new' | 'active' | 'off' | 'archive';

/**
 * Networking information for a Droplet.
 */
export interface DropletNetwork {
  /** IPv4 address. */
  ipAddress: string;
  /** Network type (public or private). */
  type: 'public' | 'private';
}

/**
 * Normalized information about a DigitalOcean Droplet.
 */
export interface DropletInfo {
  /** Unique Droplet identifier. */
  id: number;
  /** Human-readable name. */
  name: string;
  /** Current status. */
  status: DropletStatus;
  /** Region slug where the Droplet is deployed. */
  region: string;
  /** Size slug describing the Droplet's resources. */
  size: string;
  /** Image slug or ID used to create the Droplet. */
  image: string;
  /** Tags applied to the Droplet. */
  tags: string[];
  /** Network interfaces. */
  networks: DropletNetwork[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Configuration for creating a new Droplet.
 */
export interface CreateDropletConfig {
  /** Human-readable name for the Droplet. */
  name: string;
  /** Region slug (overrides service default). */
  region?: string;
  /** Size slug (overrides service default). */
  size?: string;
  /** Image slug (defaults to Ubuntu 24.04 LTS). */
  image?: string;
  /** Tags to apply in addition to the default crewly-pro tag. */
  tags?: string[];
  /** Cloud-init user data script for initial setup. */
  userData?: string;
  /** SSH key IDs or fingerprints to include. */
  sshKeys?: (number | string)[];
}

// ---------------------------------------------------------------------------
// DO API Response Shapes (internal, not exported as public API)
// ---------------------------------------------------------------------------

/**
 * Shape of a Droplet object in the DigitalOcean API response.
 * Only includes the fields we actually consume.
 */
export interface DoApiDroplet {
  id: number;
  name: string;
  status: string;
  region: { slug: string };
  size: { slug: string };
  image: { slug: string };
  tags: string[];
  networks: {
    v4: Array<{
      ip_address: string;
      type: string;
    }>;
  };
  created_at: string;
}

/** Shape of the DO API response for creating/getting a single Droplet. */
export interface DoApiDropletResponse {
  droplet: DoApiDroplet;
}

/** Shape of the DO API response for listing Droplets. */
export interface DoApiDropletsListResponse {
  droplets: DoApiDroplet[];
}

/** Shape of a DigitalOcean API error response body. */
export interface DoApiErrorResponse {
  id: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

/** Error codes specific to provisioning operations. */
export type ProvisioningErrorCode =
  | 'RATE_LIMITED'
  | 'AUTH_FAILURE'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

/**
 * Custom error class for provisioning failures.
 * Wraps DigitalOcean API errors with structured metadata.
 */
export class ProvisioningError extends Error {
  /** Structured error code for programmatic handling. */
  readonly code: ProvisioningErrorCode;
  /** Associated Droplet ID, if applicable. */
  readonly dropletId?: number;

  /**
   * Create a new ProvisioningError.
   *
   * @param code - Structured error code
   * @param message - Human-readable error description
   * @param dropletId - Associated Droplet ID (optional)
   */
  constructor(code: ProvisioningErrorCode, message: string, dropletId?: number) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
    this.dropletId = dropletId;
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** Valid Droplet status strings. */
const VALID_DROPLET_STATUSES: ReadonlySet<string> = new Set([
  'new',
  'active',
  'off',
  'archive',
]);

/**
 * Check whether a string is a valid DropletStatus.
 *
 * @param value - Value to check
 * @returns True if value is a valid DropletStatus
 */
export function isDropletStatus(value: unknown): value is DropletStatus {
  return typeof value === 'string' && VALID_DROPLET_STATUSES.has(value);
}

/**
 * Check whether a value is a valid ProvisioningErrorCode.
 *
 * @param value - Value to check
 * @returns True if value is a valid ProvisioningErrorCode
 */
export function isProvisioningErrorCode(value: unknown): value is ProvisioningErrorCode {
  const codes: ReadonlySet<string> = new Set([
    'RATE_LIMITED',
    'AUTH_FAILURE',
    'NOT_FOUND',
    'SERVER_ERROR',
    'TIMEOUT',
    'NETWORK_ERROR',
    'UNKNOWN',
  ]);
  return typeof value === 'string' && codes.has(value);
}

/**
 * Check whether a value looks like a DoApiDroplet (duck-type check).
 * Validates the minimum fields required for normalization.
 *
 * @param value - Value to check
 * @returns True if value has the expected shape
 */
export function isDoApiDroplet(value: unknown): value is DoApiDroplet {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'number' &&
    typeof obj['name'] === 'string' &&
    typeof obj['status'] === 'string' &&
    typeof obj['region'] === 'object' &&
    obj['region'] !== null &&
    typeof obj['created_at'] === 'string'
  );
}

/**
 * Check whether a value is a ProvisioningError instance.
 *
 * @param value - Value to check
 * @returns True if value is a ProvisioningError
 */
export function isProvisioningError(value: unknown): value is ProvisioningError {
  return value instanceof ProvisioningError;
}
