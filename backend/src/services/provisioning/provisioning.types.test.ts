/**
 * Tests for provisioning type guards and ProvisioningError.
 *
 * @module services/provisioning/provisioning.types.test
 */

import {
  ProvisioningError,
  isDropletStatus,
  isProvisioningErrorCode,
  isDoApiDroplet,
  isProvisioningError,
  DEFAULT_IMAGE_SLUG,
  DEFAULT_DROPLET_SIZE,
  DEFAULT_REGION,
  CREWLY_DROPLET_TAG,
  DO_API_BASE_URL,
  DEFAULT_READY_TIMEOUT_MS,
  POLLING_INTERVAL_MS,
  CREWLY_FIREWALL_PORTS,
} from './provisioning.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('provisioning constants', () => {
  it('should have correct default image slug', () => {
    expect(DEFAULT_IMAGE_SLUG).toBe('ubuntu-24-04-x64');
  });

  it('should have correct default droplet size', () => {
    expect(DEFAULT_DROPLET_SIZE).toBe('s-2vcpu-4gb');
  });

  it('should have correct default region', () => {
    expect(DEFAULT_REGION).toBe('nyc1');
  });

  it('should have correct crewly tag', () => {
    expect(CREWLY_DROPLET_TAG).toBe('crewly-pro');
  });

  it('should have correct DO API base URL', () => {
    expect(DO_API_BASE_URL).toBe('https://api.digitalocean.com/v2');
  });

  it('should have positive ready timeout', () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('should have positive polling interval', () => {
    expect(POLLING_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('should define firewall ports for SSH and web UI', () => {
    expect(CREWLY_FIREWALL_PORTS.SSH).toBe(22);
    expect(CREWLY_FIREWALL_PORTS.WEB_UI).toBe(8787);
  });
});

// ---------------------------------------------------------------------------
// ProvisioningError
// ---------------------------------------------------------------------------

describe('ProvisioningError', () => {
  it('should create an error with code and message', () => {
    const err = new ProvisioningError('AUTH_FAILURE', 'Invalid token');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.name).toBe('ProvisioningError');
    expect(err.code).toBe('AUTH_FAILURE');
    expect(err.message).toBe('Invalid token');
    expect(err.dropletId).toBeUndefined();
  });

  it('should create an error with dropletId', () => {
    const err = new ProvisioningError('NOT_FOUND', 'Droplet not found', 12345);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.dropletId).toBe(12345);
  });

  it('should have a proper stack trace', () => {
    const err = new ProvisioningError('UNKNOWN', 'test');
    expect(err.stack).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// isDropletStatus
// ---------------------------------------------------------------------------

describe('isDropletStatus', () => {
  it('should return true for valid statuses', () => {
    expect(isDropletStatus('new')).toBe(true);
    expect(isDropletStatus('active')).toBe(true);
    expect(isDropletStatus('off')).toBe(true);
    expect(isDropletStatus('archive')).toBe(true);
  });

  it('should return false for invalid strings', () => {
    expect(isDropletStatus('running')).toBe(false);
    expect(isDropletStatus('stopped')).toBe(false);
    expect(isDropletStatus('')).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isDropletStatus(42)).toBe(false);
    expect(isDropletStatus(null)).toBe(false);
    expect(isDropletStatus(undefined)).toBe(false);
    expect(isDropletStatus({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isProvisioningErrorCode
// ---------------------------------------------------------------------------

describe('isProvisioningErrorCode', () => {
  it('should return true for all valid error codes', () => {
    const validCodes = [
      'RATE_LIMITED',
      'AUTH_FAILURE',
      'NOT_FOUND',
      'SERVER_ERROR',
      'TIMEOUT',
      'NETWORK_ERROR',
      'UNKNOWN',
    ];
    for (const code of validCodes) {
      expect(isProvisioningErrorCode(code)).toBe(true);
    }
  });

  it('should return false for invalid codes', () => {
    expect(isProvisioningErrorCode('INVALID')).toBe(false);
    expect(isProvisioningErrorCode('')).toBe(false);
    expect(isProvisioningErrorCode(123)).toBe(false);
    expect(isProvisioningErrorCode(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDoApiDroplet
// ---------------------------------------------------------------------------

describe('isDoApiDroplet', () => {
  const validDroplet = {
    id: 1,
    name: 'test-droplet',
    status: 'active',
    region: { slug: 'nyc1' },
    size: { slug: 's-1vcpu-1gb' },
    image: { slug: 'ubuntu-24-04-x64' },
    tags: ['crewly-pro'],
    networks: { v4: [] },
    created_at: '2026-01-01T00:00:00Z',
  };

  it('should return true for a valid droplet shape', () => {
    expect(isDoApiDroplet(validDroplet)).toBe(true);
  });

  it('should return false when id is missing', () => {
    const { id: _, ...rest } = validDroplet;
    expect(isDoApiDroplet(rest)).toBe(false);
  });

  it('should return false when name is not a string', () => {
    expect(isDoApiDroplet({ ...validDroplet, name: 123 })).toBe(false);
  });

  it('should return false when region is null', () => {
    expect(isDoApiDroplet({ ...validDroplet, region: null })).toBe(false);
  });

  it('should return false for null and non-objects', () => {
    expect(isDoApiDroplet(null)).toBe(false);
    expect(isDoApiDroplet('string')).toBe(false);
    expect(isDoApiDroplet(42)).toBe(false);
    expect(isDoApiDroplet(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isProvisioningError
// ---------------------------------------------------------------------------

describe('isProvisioningError', () => {
  it('should return true for ProvisioningError instances', () => {
    const err = new ProvisioningError('TIMEOUT', 'timed out');
    expect(isProvisioningError(err)).toBe(true);
  });

  it('should return false for plain Error instances', () => {
    expect(isProvisioningError(new Error('plain'))).toBe(false);
  });

  it('should return false for non-error values', () => {
    expect(isProvisioningError(null)).toBe(false);
    expect(isProvisioningError('error')).toBe(false);
    expect(isProvisioningError({})).toBe(false);
  });
});
