/**
 * Cloud Constants Tests
 *
 * Verifies that cloud constants are exported correctly and have expected values.
 *
 * @module constants/cloud.constants.test
 */

import { describe, it, expect } from 'vitest';
import { CLOUD_API_BASE, CLOUD_TOKEN_KEY } from './cloud.constants';

describe('cloud.constants', () => {
  it('should export CLOUD_API_BASE as a valid URL', () => {
    expect(CLOUD_API_BASE).toBe('https://api.crewlyai.com/api');
    expect(CLOUD_API_BASE).toMatch(/^https:\/\//);
  });

  it('should export CLOUD_TOKEN_KEY as a non-empty string', () => {
    expect(CLOUD_TOKEN_KEY).toBe('crewly_cloud_token');
    expect(CLOUD_TOKEN_KEY.length).toBeGreaterThan(0);
  });
});

describe('cloud device pairing constants', () => {
  it('point at the owner-only backend endpoints', async () => {
    const { CLOUD_DEVICE_PAIRING_API, CLOUD_DEVICE_PAIRING_POLL_MS, CLOUD_DEVICE_PAIRING_QR_SIZE } = await import('./cloud.constants');
    expect(CLOUD_DEVICE_PAIRING_API).toEqual({
      START: '/api/cloud/device/start',
      STATUS: '/api/cloud/device/status',
      CANCEL: '/api/cloud/device/cancel',
    });
    expect(CLOUD_DEVICE_PAIRING_POLL_MS).toBeGreaterThan(0);
    expect(CLOUD_DEVICE_PAIRING_QR_SIZE).toBeGreaterThan(0);
  });
});
