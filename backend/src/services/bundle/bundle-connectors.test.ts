/**
 * Tests for connector checks: Google products, boolean probes, unknown and
 * failing probes.
 */

import { createConnectorChecker, googleCovers } from './bundle-connectors.js';

describe('googleCovers', () => {
  it('needs a connection and every product', () => {
    expect(googleCovers({ connected: false, connections: [] }, [])).toBe(false);
    expect(googleCovers({ connected: true, connections: [{ products: ['gmail'] }] }, [])).toBe(true);
    expect(googleCovers({ connected: true, connections: [{ products: ['gmail'] }, { products: ['drive'] }] }, ['gmail', 'drive'])).toBe(true);
    expect(googleCovers({ connected: true, connections: [{ products: ['gmail'] }] }, ['calendar'])).toBe(false);
  });

  it('counts an older Cloud that reports no products as covering them', () => {
    expect(googleCovers({ connected: true, connections: [{ products: [] }] }, ['drive'])).toBe(true);
  });
});

describe('createConnectorChecker', () => {
  const checker = createConnectorChecker({
    'google-workspace': async () => ({ connected: true, connections: [{ products: ['gmail'] }] }),
    canva: async () => false,
    whatsapp: async () => true,
    slack: async () => {
      throw new Error('boom');
    },
  });

  it('maps probes to connected / not_connected', async () => {
    expect(await checker.check({ id: 'google-workspace', products: ['gmail'], required: true, why: 'x' })).toBe('connected');
    expect(await checker.check({ id: 'google-workspace', products: ['drive'], required: true, why: 'x' })).toBe('not_connected');
    expect(await checker.check({ id: 'canva', required: false, why: 'x' })).toBe('not_connected');
    expect(await checker.check({ id: 'whatsapp', required: false, why: 'x' })).toBe('connected');
  });

  it('reads unknown for a missing or failing probe', async () => {
    expect(await checker.check({ id: 'telegram', required: false, why: 'x' })).toBe('unknown');
    expect(await checker.check({ id: 'slack', required: true, why: 'x' })).toBe('unknown');
  });
});
