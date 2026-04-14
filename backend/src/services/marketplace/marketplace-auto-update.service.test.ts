/**
 * Marketplace Auto-Update Service Tests
 *
 * @module services/marketplace/marketplace-auto-update.service.test
 */

import { checkAndApplyUpdates, startAutoUpdate, stopAutoUpdate } from './marketplace-auto-update.service.js';

describe('MarketplaceAutoUpdate', () => {
  afterEach(() => {
    stopAutoUpdate();
  });

  it('should export checkAndApplyUpdates function', () => {
    expect(typeof checkAndApplyUpdates).toBe('function');
  });

  it('should export startAutoUpdate function', () => {
    expect(typeof startAutoUpdate).toBe('function');
  });

  it('should export stopAutoUpdate function', () => {
    expect(typeof stopAutoUpdate).toBe('function');
  });
});
